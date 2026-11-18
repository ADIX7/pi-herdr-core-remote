import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checked, exists, read } from '../src/core.ts';

const machine = process.env.HC_TEST_MACHINE;
const cwd = process.env.HC_TEST_CWD;
const remote = { machine, cwd };

test('extension routes tools and commands without local fallback (opt-in)', { skip: !machine || !cwd }, async () => {
  const commands = new Map(), tools = new Map(), events = new Map(), updates = [];
  const pi = {
    registerCommand: (key, command) => commands.set(key, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (key, handler) => events.set(key, handler),
    events: { emit: (name, payload) => updates.push({ name, payload }) },
  };
  const notices = [], status = [];
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'test', getSessionFile: () => undefined }, ui: { notify: (...x) => notices.push(x), setStatus: (...x) => status.push(x) } };
  const { default: extension } = await import('../src/extension.ts');
  extension(pi);
  assert.deepEqual([...tools.keys()].sort(), ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
  await events.get('session_start')({}, ctx);
  const call = (name, params) => tools.get(name).execute('test', params, undefined, () => {}, ctx);
  assert.match((await call('read', { path: 'README.md' })).content[0].text, /pi-herdr-core-remote/);
  await commands.get('hc-remote').handler(`${machine} ${cwd}`, ctx);
  assert.match(status.at(-1)[1], new RegExp(machine));
  assert.equal(updates.at(-1).payload.id, 'hc-remote');
  assert.match(events.get('before_agent_start')({ systemPrompt: `Current working directory: ${ctx.cwd}` }).systemPrompt, new RegExp(cwd));
  const name = `.pi-herdr-core-test-${randomUUID()}.txt`;
  try {
    await call('write', { path: name, content: 'alpha\nbeta\n' });
    assert.equal((await read(remote, `${cwd}/${name}`)).toString(), 'alpha\nbeta\n');
    assert.match((await call('read', { path: name, offset: 2 })).content[0].text, /beta/);
    const many = Array.from({ length: 420 }, (_, i) => `line-${i + 1}`).join('\n') + '\n';
    await call('write', { path: name, content: many });
    assert.match((await call('read', { path: name, offset: 205, limit: 3 })).content[0].text, /line-205/);
    await call('write', { path: name, content: 'alpha\nbeta\n' });
    await call('edit', { path: name, edits: [{ oldText: 'alpha', newText: 'gamma' }] });
    assert.match((await call('read', { path: name })).content[0].text, /gamma/);
    assert.match((await call('bash', { command: `pwd` })).content[0].text, new RegExp(cwd));
    assert.match((await call('ls', { path: '.' })).content[0].text, new RegExp(name));
    assert.match((await call('find', { pattern: '*.txt' })).content[0].text, new RegExp(name));
    assert.match((await call('grep', { pattern: 'gamma', glob: name })).content[0].text, /gamma/);
    const userBash = events.get('user_bash')();
    const output = [];
    assert.equal((await userBash.operations.exec('pwd', ctx.cwd, { onData: b => output.push(b.toString()) })).exitCode, 0);
    assert.ok(output.some(line => line.includes(cwd)));
    const subdir = `.pi-herdr-subdir-${randomUUID()}`;
    await checked(remote, ['mkdir', '-p', '--', `${cwd}/${subdir}`]);
    try {
      await commands.get('hc-remote-path').handler(subdir, ctx);
      assert.equal(status.at(-1)[1], `${machine}:${cwd}/${subdir}`);
      assert.match((await call('bash', { command: 'pwd' })).content[0].text, new RegExp(`${cwd}/${subdir}`));
      await commands.get('hc-remote-path').handler('..', ctx);
      assert.equal(status.at(-1)[1], `${machine}:${cwd}`);
    } finally { await checked(remote, ['rmdir', '--', `${cwd}/${subdir}`]); }
    await assert.rejects(() => call('read', { path: `${ctx.cwd}/README.md` }));
    await commands.get('hc-remote-path').handler('missing-directory', ctx);
    assert.equal(status.at(-1)[1], `${machine}:${cwd}`);
    await commands.get('hc-remote').handler('local', ctx);
    assert.equal(status.at(-1)[1], undefined);
    await assert.rejects(() => call('read', { path: `${cwd}/${name}` }));
  } finally {
    await checked(remote, ['rm', '-f', '--', `${cwd}/${name}`]);
  }
  assert.equal(await exists(remote, `${cwd}/${name}`), false);
});
