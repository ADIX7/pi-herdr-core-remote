import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createBashToolDefinition, createLsToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, truncateHead,
  type ReadOperations, type WriteOperations, type EditOperations,
  type BashOperations, type LsOperations, type FindOperations,
} from "@earendil-works/pi-coding-agent";
import { checked, exec, exists, hc, isDirectory, read, remotePath, validateDirectory, write, type Remote } from "./core.ts";

function readOps(remote: Remote, signal?: AbortSignal): ReadOperations {
  return {
    readFile: (filename) => read(remote, filename, signal),
    async *createReadStream(filename, options) {
      let offset = 1;
      for (;;) {
        const page = await hc<{ text: string; first: number; last: number; lines: number }>(["file", "read", "--on", remote.machine,
          "--offset", String(offset), "--limit", "200", filename], undefined, options.signal ?? signal);
        yield Buffer.from(page.text, "utf8");
        if (page.last >= page.lines || page.last < offset) break;
        offset = page.last + 1;
      }
    },
    access: async (filename) => { await checked(remote, ["test", "-r", filename], { signal }); },
    detectImageMimeType: async (filename) => {
      const extension = path.posix.extname(filename).toLowerCase();
      return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" } as Record<string, string>)[extension] ?? null;
    },
  };
}
function writeOps(remote: Remote, signal?: AbortSignal): WriteOperations {
  return {
    writeFile: (filename, content) => write(remote, filename, content, signal),
    mkdir: async (directory) => { await checked(remote, ["mkdir", "-p", "--", directory], { signal }); },
  };
}
function editOps(remote: Remote, signal?: AbortSignal): EditOperations {
  return {
    readFile: (filename) => read(remote, filename, signal),
    writeFile: (filename, content) => write(remote, filename, content, signal),
    access: async (filename) => { await checked(remote, ["test", "-r", filename], { signal });
      await checked(remote, ["test", "-w", filename], { signal }); },
  };
}
function bashOps(remote: Remote, localCwd: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const result = await exec(remote, ["bash", "-lc", command], { cwd: cwd === localCwd ? remote.cwd : cwd, signal, timeout });
      // hc exec returns bounded stdout/stderr together at completion, not live chunks.
      if (result.stdout.length) onData(result.stdout);
      if (result.stderr.length) onData(result.stderr);
      return { exitCode: result.code };
    },
  };
}
function lsOps(remote: Remote, signal?: AbortSignal): LsOperations {
  return {
    exists: (filename) => exists(remote, filename, signal),
    stat: async (filename) => {
      const directory = await isDirectory(remote, filename, signal);
      return { isDirectory: () => directory };
    },
    readdir: async (directory) => {
      const result = await checked(remote, ["ls", "-A1", "--", directory], { signal });
      return result.toString("utf8").split("\n").filter(Boolean);
    },
  };
}
function findOps(remote: Remote, signal?: AbortSignal): FindOperations {
  return {
    exists: (filename) => exists(remote, filename, signal),
    glob: async (pattern, cwd, options) => {
      const args = ["rg", "--files", "--hidden", "--no-config", "--glob", pattern,
        "--glob", "!.git", "--glob", "!node_modules", "--", "."];
      const result = await exec(remote, args, { cwd, signal });
      if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.toString() || "Remote rg failed");
      return result.stdout.toString("utf8").split("\n").filter(Boolean).slice(0, options.limit);
    },
  };
}

export default function (pi: ExtensionAPI): void {
  let active: Remote | undefined;
  const localCwd = process.cwd();
  const localRead = createReadToolDefinition(localCwd);
  const localWrite = createWriteToolDefinition(localCwd);
  const localEdit = createEditToolDefinition(localCwd);
  const localBash = createBashToolDefinition(localCwd);
  const localLs = createLsToolDefinition(localCwd);
  const localFind = createFindToolDefinition(localCwd);
  const localGrep = createGrepToolDefinition(localCwd);

  pi.events.emit("powerbar:register-segment", { id: "hc-remote", label: "Herdr Core Remote" });
  function display(ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }): void {
    const text = active ? `${active.machine}:${active.cwd}` : undefined;
    ctx.ui.setStatus("hc-remote", text);
    pi.events.emit("powerbar:update", { id: "hc-remote", text, icon: "󰣀", color: "accent" });
  }
  pi.on("session_start", (_event, ctx) => { active = undefined; display(ctx); });
  pi.on("session_shutdown", (_event, ctx) => { active = undefined; display(ctx); });

  pi.registerCommand("hc-remote", {
    description: "Switch Pi tools to a Herdr Core machine: /hc-remote <machine> [absolute-path] | local | status",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input || input === "status") {
        ctx.ui.notify(active ? `Herdr Core remote: ${active.machine}:${active.cwd}` : `Local: ${ctx.cwd}`, "info");
        return;
      }
      if (input === "local") {
        active = undefined; display(ctx); ctx.ui.notify(`Tools now local: ${ctx.cwd}`, "info"); return;
      }
      const [machine, ...remainder] = input.split(/\s+/);
      const requestedPath = remainder.join(" ");
      try {
        let cwd = requestedPath;
        if (!cwd) {
          const result = await hc<{ timed_out: boolean; truncated: boolean; code: number; stdout: string }>(["exec", "--on", machine, "--", "pwd"]);
          if (result.timed_out || result.truncated || result.code !== 0) throw new Error("Could not resolve remote home directory");
          cwd = Buffer.from(result.stdout, "base64").toString("utf8").trim();
        }
        const candidate = { machine, cwd };
        candidate.cwd = await validateDirectory(candidate);
        active = candidate;
        display(ctx);
        ctx.ui.notify(`Tools now remote: ${machine}:${candidate.cwd}`, "info");
      } catch (error) { ctx.ui.notify(`Remote not changed: ${String(error)}`, "error"); }
    },
  });
  pi.registerCommand("hc-remote-path", {
    description: "Change the current Herdr Core remote directory",
    handler: async (args, ctx) => {
      if (!active) { ctx.ui.notify("Connect with /hc-remote first", "error"); return; }
      if (!args.trim()) { ctx.ui.notify(active.cwd, "info"); return; }
      try {
        const candidate = { ...active, cwd: remotePath(active.cwd, args) };
        candidate.cwd = await validateDirectory(candidate);
        active = candidate;
        display(ctx);
        ctx.ui.notify(`Remote path: ${candidate.machine}:${candidate.cwd}`, "info");
      } catch (error) { ctx.ui.notify(`Remote path not changed: ${String(error)}`, "error"); }
    },
  });

  pi.registerTool({ ...localRead, async execute(id, params, signal, onUpdate, ctx) {
    const remote = active;
    if (!remote) return localRead.execute(id, params, signal, onUpdate, ctx);
    return createReadToolDefinition(remote.cwd, { operations: readOps(remote, signal) })
      .execute(id, params, signal, onUpdate, { ...ctx, cwd: remote.cwd });
  } });
  pi.registerTool({ ...localWrite, async execute(id, params, signal, onUpdate, ctx) {
    const remote = active;
    if (!remote) return localWrite.execute(id, params, signal, onUpdate, ctx);
    return createWriteToolDefinition(remote.cwd, { operations: writeOps(remote, signal) })
      .execute(id, params, signal, onUpdate, { ...ctx, cwd: remote.cwd });
  } });
  pi.registerTool({ ...localEdit, async execute(id, params, signal, onUpdate, ctx) {
    const remote = active;
    if (!remote) return localEdit.execute(id, params, signal, onUpdate, ctx);
    return createEditToolDefinition(remote.cwd, { operations: editOps(remote, signal) })
      .execute(id, params, signal, onUpdate, { ...ctx, cwd: remote.cwd });
  } });
  pi.registerTool({ ...localBash, async execute(id, params, signal, onUpdate, ctx) {
    const remote = active;
    if (!remote) return localBash.execute(id, params, signal, onUpdate, ctx);
    return createBashToolDefinition(remote.cwd, { operations: bashOps(remote, localCwd) })
      .execute(id, params, signal, onUpdate, { ...ctx, cwd: remote.cwd });
  } });
  pi.registerTool({ ...localLs, async execute(id, params, signal, onUpdate, ctx) {
    const remote = active;
    if (!remote) return localLs.execute(id, params, signal, onUpdate, ctx);
    return createLsToolDefinition(remote.cwd, { operations: lsOps(remote, signal) })
      .execute(id, params, signal, onUpdate, { ...ctx, cwd: remote.cwd });
  } });
  pi.registerTool({ ...localFind, async execute(id, params, signal, onUpdate, ctx) {
    const remote = active;
    if (!remote) return localFind.execute(id, params, signal, onUpdate, ctx);
    return createFindToolDefinition(remote.cwd, { operations: findOps(remote, signal) })
      .execute(id, params, signal, onUpdate, { ...ctx, cwd: remote.cwd });
  } });
  pi.registerTool({ ...localGrep, async execute(id, params, signal, onUpdate, ctx) {
    const remote = active;
    if (!remote) return localGrep.execute(id, params, signal, onUpdate, ctx);
    const root = remotePath(remote.cwd, params.path || ".");
    const directory = await isDirectory(remote, root, signal);
    const args = ["rg", "--no-config", "--json", "--line-number", "--color=never", "--hidden"];
    if (params.ignoreCase) args.push("--ignore-case");
    if (params.literal) args.push("--fixed-strings");
    if (params.glob) args.push("--glob", params.glob);
    if (params.context && params.context > 0) args.push("--context", String(Math.floor(params.context)));
    args.push("--", params.pattern, directory ? "." : root);
    const result = await exec(remote, args, { cwd: directory ? root : remote.cwd, signal });
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.toString() || "Remote rg failed");
    let matches = 0;
    const lines: string[] = [];
    const max = Math.max(1, params.limit ?? 100);
    for (const raw of result.stdout.toString("utf8").split("\n")) {
      if (!raw) continue;
      const item = JSON.parse(raw);
      if (item.type !== "match" && item.type !== "context") continue;
      if (item.type === "match" && ++matches > max) break;
      const text = (field: { text?: string; bytes?: string }) => field?.text ?? Buffer.from(field?.bytes ?? "", "base64").toString("utf8");
      const filename = text(item.data.path).replace(/^\.\//, "");
      lines.push(`${filename}${item.type === "match" ? ":" : "-"}${item.data.line_number}${item.type === "match" ? ":" : "-"} ${text(item.data.lines).replace(/\r?\n$/, "")}`);
    }
    if (!matches) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
    const truncated = truncateHead(lines.join("\n"));
    const notice = matches > max ? `\n\n[${max} matches limit reached]` : "";
    return { content: [{ type: "text" as const, text: truncated.content + notice }], details: truncated.truncated ? { truncation: truncated } : undefined };
  } });

  pi.on("user_bash", () => active ? { operations: bashOps(active, localCwd) } : undefined);
  pi.on("before_agent_start", (event) => {
    if (!active) return;
    const localLine = `Current working directory: ${localCwd}`;
    const remoteLine = `Current working directory: ${active.cwd} (Herdr Core machine: ${active.machine}). Workspace tools and ! commands execute on this machine; Pi session files and extensions stay local.`;
    return { systemPrompt: event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, remoteLine)
      : `${event.systemPrompt}\n\n${remoteLine}` };
  });
}
