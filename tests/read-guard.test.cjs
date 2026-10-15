'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');

const pre = (s, file, extra = {}, tool_input = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: s,
  cwd: extra.cwd,
  agent_id: extra.agent_id,
  tool_name: 'Read',
  tool_input: { file_path: file, ...tool_input },
});
const post = (s, tool, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  session_id: s,
  cwd: extra.cwd,
  agent_id: extra.agent_id,
  tool_name: tool,
  tool_input: {},
});

test('4-е подряд чтение того же файла запрещено, 3 первых разрешены', () => {
  const s = sid();
  const cwd = tmpProject();
  for (let i = 1; i <= 3; i++) {
    assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }))), false, `чтение ${i}`);
  }
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }))), true);
});

test('Read после Edit разрешён (счётчик сброшен)', () => {
  const s = sid();
  const cwd = tmpProject();
  for (let i = 0; i < 3; i++) runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }));
  runScript('read-guard.cjs', post(s, 'Edit', { agent_id: 'ag1', cwd }));
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }))), false);
});

test('счётчики агентов раздельны', () => {
  const s = sid();
  const cwd = tmpProject();
  for (let i = 0; i < 3; i++) runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }));
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag2', cwd }))), false);
});

test('maxRepeat берётся из конфига', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { maxRepeat: 1 } });
  runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }));
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }))), true);
});

test('PDF без pages запрещён агенту, с pages разрешён', () => {
  const s = sid();
  const cwd = tmpProject();
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'x.pdf', { agent_id: 'ag1', cwd }))), true);
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'x.pdf', { agent_id: 'ag1', cwd }, { pages: '1-2' }))), false);
});

test('картинка больше лимита запрещена агенту, меньше - разрешена', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { maxImageBytes: 1000 } });
  const big = path.join(os.tmpdir(), `orc-big-${process.pid}.png`);
  const small = path.join(os.tmpdir(), `orc-small-${process.pid}.png`);
  fs.writeFileSync(big, Buffer.alloc(5000));
  fs.writeFileSync(small, Buffer.alloc(10));
  try {
    assert.equal(isDeny(runScript('read-guard.cjs', pre(s, big, { agent_id: 'ag1', cwd }))), true);
    assert.equal(isDeny(runScript('read-guard.cjs', pre(s, small, { agent_id: 'ag1', cwd }))), false);
  } finally {
    fs.rmSync(big, { force: true });
    fs.rmSync(small, { force: true });
  }
});

test('лид (нет agent_id) не читает PDF и картинки; leadNoMedia=false отключает', () => {
  const s = sid();
  const cwd = tmpProject();
  const r = runScript('read-guard.cjs', pre(s, 'x.pdf', { cwd }, { pages: '1' }));
  assert.equal(isDeny(r), true);
  assert.match(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /media/);
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'x.png', { cwd }))), true);
  const cwd2 = tmpProject({ readGuard: { leadNoMedia: false } });
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'x.png', { cwd: cwd2 }))), false);
});

test('обычный текстовый файл лидом читается', () => {
  assert.equal(isDeny(runScript('read-guard.cjs', pre(sid(), 'a.md', { cwd: tmpProject() }))), false);
});

test('мусор на stdin: exit 0, пустой вывод', () => {
  const r = runScript('read-guard.cjs', 'не json {{{');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('--help печатает справку', () => {
  const r = runScript('read-guard.cjs', '', { args: ['--help'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /read-guard/);
});
