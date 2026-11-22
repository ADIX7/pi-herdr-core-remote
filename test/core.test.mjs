import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checked, exec, exists, hc, isDirectory, read, remotePath, validateDirectory, write } from '../src/core.ts';

const machine = process.env.HC_TEST_MACHINE;
const cwd = process.env.HC_TEST_CWD;
const remote = { machine, cwd };

test('resolve remote paths', () => {
  assert.equal(remotePath('/srv/project', 'a/../b'), '/srv/project/b');
  assert.equal(remotePath('/srv/project', '/etc/hostname'), '/etc/hostname');
  assert.throws(() => remotePath('/srv/project', '  '));
});

async function useFakeCli(t, scripts) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-herdr-core-remote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink(process.execPath, join(dir, 'node'));
  for (const [name, script] of Object.entries(scripts)) {
    await writeFile(join(dir, name), `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  }
  const originalPath = process.env.PATH;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  process.env.PATH = dir;
}

const alternateCli = `process.stdout.write(JSON.stringify({ cli: 'herdr-core' }));`;

test('remote exec prefers hc and does not forward the local shell environment', async (t) => {
  await useFakeCli(t, {
    hc: `const stdout = Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64');
process.stdout.write(JSON.stringify({ code: 0, stdout }));`,
    'herdr-core': alternateCli,
  });

  const result = await exec({ machine: 'test-host', cwd: '/srv/project' }, ['pwd'], {
    env: { PI_SESSION_FILE: '/local/session.jsonl', PI_TEST_TOKEN: 'not-for-remote' },
  });
  assert.deepEqual(JSON.parse(result.stdout.toString()), [
    '--json', 'exec', '--on', 'test-host', '--cwd', '/srv/project', '--timeout', '60', '--', 'pwd',
  ]);
});

test('uses herdr-core when hc is missing', async (t) => {
  await useFakeCli(t, { 'herdr-core': alternateCli });
  assert.deepEqual(await hc(['exec', '--on', 'test-host', '--', 'pwd']), { cli: 'herdr-core' });
});

test('does not retry with herdr-core after hc reports an error', async (t) => {
  await useFakeCli(t, {
    hc: `process.stdout.write(JSON.stringify({ error: { message: 'machine unavailable' } }));
process.exitCode = 1;`,
    'herdr-core': alternateCli,
  });
  await assert.rejects(hc(['exec', '--on', 'test-host', '--', 'pwd']), /machine unavailable/);
});

test('reports when neither CLI is on PATH', async (t) => {
  await useFakeCli(t, {});
  await assert.rejects(hc(['--version']), /not found on PATH \(tried hc and herdr-core\)/);
});

test('remote roundtrip, shell and absence (opt-in)', { skip: !machine || !cwd }, async () => {
  assert.equal(await validateDirectory(remote), cwd);
  const file = `${cwd}/.pi-herdr-core-remote-${randomUUID()}.txt`;
  try {
    assert.equal(await exists(remote, file), false);
    await write(remote, file, 'remote only\n');
    assert.equal((await read(remote, file)).toString(), 'remote only\n');
    assert.equal(await isDirectory(remote, file), false);
    const output = await exec(remote, ['sh', '-c', 'pwd; printf err >&2']);
    assert.equal(output.code, 0);
    assert.equal(output.stdout.toString().trim(), cwd);
    assert.equal(output.stderr.toString(), 'err');
    assert.match((await checked(remote, ['rg', '--files', '--hidden', '--glob', file.split('/').at(-1), '--', '.'])).toString(), /\.pi-herdr-core-remote-/);
  } finally {
    await checked(remote, ['rm', '-f', '--', file]);
  }
  await assert.rejects(() => read(remote, file));
  await assert.rejects(() => hc(['exec', '--on', `not-a-machine-${randomUUID()}`, '--', 'pwd']));
});
