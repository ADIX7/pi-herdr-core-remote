import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checked, exec, exists, hc, isDirectory, read, remotePath, validateDirectory, write } from '../src/core.ts';

const machine = process.env.HC_TEST_MACHINE;
const cwd = process.env.HC_TEST_CWD;
const remote = { machine, cwd };

test('resolve remote paths', () => {
  assert.equal(remotePath('/srv/project', 'a/../b'), '/srv/project/b');
  assert.equal(remotePath('/srv/project', '/etc/hostname'), '/etc/hostname');
  assert.throws(() => remotePath('/srv/project', '  '));
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
