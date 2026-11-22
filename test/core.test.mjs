import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { checked, exec, exists, hc, isDirectory, read, remotePath, validateDirectory, write } from '../src/core.ts';

const machine = process.env.HC_TEST_MACHINE;
const cwd = process.env.HC_TEST_CWD;
const remote = { machine, cwd };

test('resolve remote paths', () => {
  assert.equal(remotePath('/srv/project', 'a/../b'), '/srv/project/b');
  assert.equal(remotePath('/srv/project', '/etc/hostname'), '/etc/hostname');
  assert.throws(() => remotePath('/srv/project', '  '));
});

test('remote exec does not forward the local shell environment', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-herdr-core-remote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'hc'), `#!/usr/bin/env node
const stdout = Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64');
process.stdout.write(JSON.stringify({ code: 0, stdout }));
`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  process.env.PATH = originalPath ? `${dir}${delimiter}${originalPath}` : dir;

  const result = await exec({ machine: 'test-host', cwd: '/srv/project' }, ['pwd'], {
    env: { PI_SESSION_FILE: '/local/session.jsonl', PI_TEST_TOKEN: 'not-for-remote' },
  });
  assert.deepEqual(JSON.parse(result.stdout.toString()), [
    '--json', 'exec', '--on', 'test-host', '--cwd', '/srv/project', '--timeout', '60', '--', 'pwd',
  ]);
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
