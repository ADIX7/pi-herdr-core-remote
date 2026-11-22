import { spawn } from "node:child_process";
import path from "node:path";

export interface Remote { machine: string; cwd: string }
interface ExecResult { code: number; stdout: string; stderr: string; timed_out: boolean; truncated: boolean; signal: number | null }
const MAX_BYTES = 8 * 1024 * 1024;

export function remotePath(cwd: string, value: string): string {
  const input = value.trim();
  if (!input) throw new Error("Empty remote path");
  return path.posix.resolve(cwd, input);
}

/** Herdr Core emits JSON even on remote errors. Only a missing CLI can trigger a retry. */
interface CoreError { error?: { kind?: string; message: string }; code?: number }

export async function hc<T = Record<string, unknown>>(args: string[], input?: Buffer, signal?: AbortSignal): Promise<T> {
  for (const binary of ["hc", "herdr-core"]) {
    try {
      return await runCore<T>(binary, args, input, signal);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code !== "ENOENT" || failure.syscall !== `spawn ${binary}`) throw error;
    }
  }
  throw new Error("Herdr Core CLI not found on PATH (tried hc and herdr-core)");
}

function runCore<T>(binary: string, args: string[], input?: Buffer, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Operation aborted"));
    const child = spawn(binary, ["--json", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0;
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 24 * 1024 * 1024) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("Operation aborted"));
      if (size > 24 * 1024 * 1024) return reject(new Error("hc response exceeds 24 MiB"));
      const output = Buffer.concat(stdout).toString("utf8");
      let result: CoreError;
      try { result = JSON.parse(output); }
      catch { return reject(new Error(`${binary} exited ${code}: ${Buffer.concat(stderr).toString("utf8") || output}`)); }
      if (result?.error) return reject(new Error(`${binary} ${result.error.kind ?? "error"}: ${result.error.message}`));
      if (code !== 0 && result?.code === undefined) return reject(new Error(`${binary} exited ${code}: ${Buffer.concat(stderr).toString("utf8") || output}`));
      resolve(result as T);
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
  });
}

export async function exec(remote: Remote, argv: string[], options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  const timeout = options.timeout ?? 60;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new Error("hc timeout must be 1–600 seconds");
  const result = await hc<ExecResult>(["exec", "--on", remote.machine, "--cwd", options.cwd ?? remote.cwd, "--timeout", String(timeout), "--", ...argv], undefined, options.signal);
  if (result.timed_out) throw new Error(`Remote command timed out after ${timeout}s`);
  if (result.truncated) throw new Error("Remote command output exceeded Herdr Core's output limit");
  return { code: result.code ?? 1, stdout: Buffer.from(result.stdout ?? "", "base64"), stderr: Buffer.from(result.stderr ?? "", "base64") };
}

export async function checked(remote: Remote, argv: string[], options: Parameters<typeof exec>[2] = {}): Promise<Buffer> {
  const result = await exec(remote, argv, options);
  if (result.code !== 0) throw new Error(result.stderr.toString("utf8").trim() || `Remote command failed (${result.code}): ${argv[0]}`);
  return result.stdout;
}

export async function read(remote: Remote, filename: string, signal?: AbortSignal): Promise<Buffer> {
  // machine.exec returns bytes as base64. file.read is text-only and cannot return images.
  return checked(remote, ["cat", "--", filename], { signal });
}

export async function write(remote: Remote, filename: string, data: Buffer | string, signal?: AbortSignal): Promise<void> {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length > MAX_BYTES) throw new Error("hc file write is limited to 8 MiB");
  await hc(["file", "write", "--on", remote.machine, "--cwd", remote.cwd, filename], bytes, signal);
}

export async function exists(remote: Remote, filename: string, signal?: AbortSignal): Promise<boolean> {
  const result = await exec(remote, ["test", "-e", filename], { signal });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(result.stderr.toString() || `Cannot inspect remote path: ${filename}`);
}

export async function isDirectory(remote: Remote, filename: string, signal?: AbortSignal): Promise<boolean> {
  const result = await exec(remote, ["test", "-d", filename], { signal });
  if (result.code === 0) return true;
  if (result.code === 1) {
    if (await exists(remote, filename, signal)) return false;
    throw new Error(`Remote path not found: ${filename}`);
  }
  throw new Error(result.stderr.toString() || `Cannot inspect remote path: ${filename}`);
}

export async function validateDirectory(remote: Remote): Promise<string> {
  if (!path.posix.isAbsolute(remote.cwd)) throw new Error("Remote path must be absolute");
  if (!(await isDirectory(remote, remote.cwd))) throw new Error(`Not a remote directory: ${remote.cwd}`);
  return (await checked(remote, ["pwd", "-P"])).toString().trim();
}
