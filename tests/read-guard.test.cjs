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
  agent_type: extra.agent_type,
  tool_name: 'Read',
  tool_input: { file_path: file, ...tool_input },
});
const post = (s, tool, extra = {}, tool_input = {}) => ({
  hook_event_name: 'PostToolUse',
  session_id: s,
  cwd: extra.cwd,
  agent_id: extra.agent_id,
  tool_name: tool,
  tool_input,
});

test('the 4th identical read in a row is denied, the first 3 are allowed', () => {
  const s = sid();
  const cwd = tmpProject();
  for (let i = 1; i <= 3; i++) {
    assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }))), false, `read ${i}`);
  }
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }))), true);
});

test('Read after Edit is allowed (counter reset)', () => {
  const s = sid();
  const cwd = tmpProject();
  for (let i = 0; i < 3; i++) runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }));
  runScript('read-guard.cjs', post(s, 'Edit', { agent_id: 'ag1', cwd }, { file_path: 'a.txt' }));
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }))), false);
});

test('agent counters are separate', () => {
  const s = sid();
  const cwd = tmpProject();
  for (let i = 0; i < 3; i++) runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }));
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag2', cwd }))), false);
});

test('maxRepeat comes from the config', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { maxRepeat: 1 } });
  runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }));
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'a.txt', { agent_id: 'ag1', cwd }))), true);
});

test('PDF without pages is denied to an agent, with pages allowed', () => {
  const s = sid();
  const cwd = tmpProject();
  const m = { agent_id: 'ag1', agent_type: 'ghorc:media', cwd };
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'x.pdf', m))), true);
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'x.pdf', m, { pages: '1-2' }))), false);
});

test('an image above the limit is denied to an agent, below it allowed', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { maxImageBytes: 1000 } });
  const big = path.join(os.tmpdir(), `orc-big-${process.pid}.png`);
  const small = path.join(os.tmpdir(), `orc-small-${process.pid}.png`);
  fs.writeFileSync(big, Buffer.alloc(5000));
  fs.writeFileSync(small, Buffer.alloc(10));
  try {
    const m = { agent_id: 'ag1', agent_type: 'ghorc:media', cwd };
    assert.equal(isDeny(runScript('read-guard.cjs', pre(s, big, m))), true);
    assert.equal(isDeny(runScript('read-guard.cjs', pre(s, small, m))), false);
  } finally {
    fs.rmSync(big, { force: true });
    fs.rmSync(small, { force: true });
  }
});

test('an explicit lead (GHORC_ROLE=lead) does not read PDFs and images; leadNoMedia=false disables this', () => {
  const s = sid();
  const cwd = tmpProject();
  const lead = { env: { GHORC_ROLE: 'lead' } };
  const r = runScript('read-guard.cjs', pre(s, 'x.pdf', { cwd }, { pages: '1' }), lead);
  assert.equal(isDeny(r), true);
  assert.match(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /media/);
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'x.png', { cwd }), lead)), true);
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'x.png', { cwd }))), false, 'a plain session is not the lead');
  const cwd2 = tmpProject({ readGuard: { leadNoMedia: false } });
  assert.equal(isDeny(runScript('read-guard.cjs', pre(s, 'x.png', { cwd: cwd2 }), lead)), false);
});

test('the lead can read an ordinary text file', () => {
  assert.equal(isDeny(runScript('read-guard.cjs', pre(sid(), 'a.md', { cwd: tmpProject() }))), false);
});

test('garbage on stdin: exit 0, empty output', () => {
  const r = runScript('read-guard.cjs', 'not json {{{');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('--help prints usage', () => {
  const r = runScript('read-guard.cjs', '', { args: ['--help'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /read-guard/);
});
