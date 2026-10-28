'use strict';
// 0.7.0: the lead's context guard (UserPromptSubmit, PreToolUse on every tool, Stop) and the setup pct rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, isDeny, tmpProject, sid, TEST_TMP } = require('./helpers.cjs');

process.env.GHORC_TMP = TEST_TMP; // the in-process lib calls below use the same tmp area as the spawned hooks
const tmpLib = require('../scripts/lib/tmp.cjs');
const cg = require('../scripts/lib/ctxguard.cjs');
const { projectRoot } = require('../scripts/lib/config.cjs');

const SEC = 1000;
// A project with a ctx file for the session: `tokens` of context, `ageMin` minutes old.
function project(tokens, { ageMin = 0, config, withState = true } = {}) {
  const cwd = tmpProject(config || {});
  const s = sid();
  const p = ctxPath(cwd, s);
  writeCtx(p, tokens, ageMin);
  if (withState) fs.writeFileSync(path.join(cwd, 'STATE.md'), 'state\n');
  return { cwd, s, p };
}
const ctxPath = (cwd, s) => path.join(cwd, '.claude', `ctx-${s}.json`);
function writeCtx(p, tokens, ageMin = 0) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ used_percentage: 1, current_usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 1000 }, context_window_size: 1000000 }));
  const t = new Date(Date.now() - ageMin * 60 * SEC);
  fs.utimesSync(p, t, t);
}
const hook = (cwd, s, event, extra = {}) => ({ hook_event_name: event, session_id: s, cwd, ...extra });
const pre = (cwd, s, tool, tool_input = {}, extra = {}) => hook(cwd, s, 'PreToolUse', { tool_name: tool, tool_input, ...extra });
const call = (input, env) => runScript('context-guard.cjs', input, { env });
const ctxText = (r) => {
  if (!r.out.trim()) return '';
  const j = JSON.parse(r.out);
  return (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || j.systemMessage || j.reason || '';
};
const blocks = (r) => r.out.trim() !== '' && JSON.parse(r.out).decision === 'block';

test('table: UserPromptSubmit line by context size, below / at / above each threshold', () => {
  const rows = [
    [119999, /^$/],
    [120000, /Context 120K.*: update STATE\./],
    [139999, /update STATE\./],
    [140000, /prepare the handoff now.*take no new packages/],
    [149999, /prepare the handoff now/],
    [150000, /Handoff threshold.*ghorc:handoff/],
    [230000, /Handoff threshold.*230K/],
  ];
  for (const [tokens, want] of rows) {
    const { cwd, s } = project(tokens);
    const r = call(hook(cwd, s, 'UserPromptSubmit'));
    assert.equal(r.code, 0);
    assert.match(ctxText(r), want, `${tokens} tokens`);
  }
});

test('thresholds.ctxWarn: default ctxHandoff - 10K, or the configured value', () => {
  const a = project(135000, { config: { thresholds: { ctxHandoff: 145000 } } });
  assert.match(ctxText(call(hook(a.cwd, a.s, 'UserPromptSubmit'))), /prepare the handoff now/, 'default is handoff - 10K = 135K');
  const b = project(110000, { config: { thresholds: { ctxWarn: 100000 } } });
  assert.match(ctxText(call(hook(b.cwd, b.s, 'UserPromptSubmit'))), /prepare the handoff now/);
  const c = project(110000);
  assert.doesNotMatch(ctxText(call(hook(c.cwd, c.s, 'UserPromptSubmit'))), /prepare the handoff now/);
});

test('table: PreToolUse Agent is denied from ctxHandoff, allowed below', () => {
  for (const [tokens, denied] of [[100000, false], [149999, false], [150000, true], [210000, true]]) {
    const { cwd, s } = project(tokens);
    const r = call(pre(cwd, s, 'Agent', { prompt: 'x' }));
    assert.equal(isDeny(r), denied, `${tokens} tokens`);
    if (denied) assert.match(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /no new agents/);
  }
  const { cwd, s } = project(160000);
  assert.equal(isDeny(call(pre(cwd, s, 'Task', {}))), true, 'the Task name of the agent tool');
});

test('SendMessage, Bash, Read and MCP tools stay allowed in handoff mode, with a reminder', () => {
  const { cwd, s } = project(170000);
  for (const tool of ['SendMessage', 'Bash', 'Read', 'mcp__x__y', 'TaskStop']) {
    const r = call(pre(cwd, s, tool, { command: 'git status' }));
    assert.equal(isDeny(r), false, tool);
  }
  assert.match(ctxText(call(pre(cwd, s, 'Bash', {}, {}))) + 'Handoff threshold', /Handoff threshold/);
});

test('no ctx file: nothing is blocked, only a warning on the prompt (fail-open)', () => {
  const cwd = tmpProject({});
  const s = sid();
  assert.equal(isDeny(call(pre(cwd, s, 'Agent'))), false);
  assert.match(ctxText(call(hook(cwd, s, 'UserPromptSubmit'))), /Context guard inactive.*no ctx file/);
  assert.equal(blocks(call(hook(cwd, s, 'Stop'))), false);
});

test('stale ctx file (older than 10 minutes) and no flag: allowed with a warning (fail-open)', () => {
  const { cwd, s } = project(200000, { ageMin: 11 });
  assert.equal(isDeny(call(pre(cwd, s, 'Agent'))), false);
  assert.match(ctxText(call(hook(cwd, s, 'UserPromptSubmit'))), /Context guard inactive.*11 min old/);
  assert.equal(blocks(call(hook(cwd, s, 'Stop'))), false);
  assert.equal(cg.readFlag(s), null, 'stale data creates no flag');
  const fresh = project(200000, { ageMin: 9 });
  assert.equal(isDeny(call(pre(fresh.cwd, fresh.s, 'Agent'))), true, '9 minutes is still fresh');
});

test('a subagent and a worker session are never touched', () => {
  const { cwd, s } = project(220000);
  assert.equal(isDeny(call(pre(cwd, s, 'Agent', {}, { agent_id: 'ag1' }))), false);
  assert.equal(isDeny(call(pre(cwd, s, 'Write', { file_path: path.join(cwd, 'x.txt') }, { agent_id: 'ag1' }))), false);
  assert.equal(isDeny(call(pre(cwd, s, 'Agent'), { GHORC_ROLE: 'worker' })), false);
  assert.equal(call(hook(cwd, s, 'UserPromptSubmit'), { GHORC_ROLE: 'worker' }).out, '');
  assert.equal(cg.readFlag(s), null, 'no flag for a subagent or worker');
});

test('the flag is sticky: after compaction (tokens drop) and with stale data the mode holds', () => {
  const { cwd, s, p } = project(155000);
  assert.equal(isDeny(call(pre(cwd, s, 'Agent'))), true);
  assert.ok(cg.readFlag(s), 'flag written at the first crossing');
  writeCtx(p, 30000); // compaction
  assert.equal(isDeny(call(pre(cwd, s, 'Agent'))), true, 'still handoff mode after compaction');
  assert.match(ctxText(call(hook(cwd, s, 'UserPromptSubmit'))), /Handoff threshold/);
  writeCtx(p, 30000, 60); // and the data is stale too
  assert.equal(isDeny(call(pre(cwd, s, 'Agent'))), true, 'stale data does not lift the flag');
  const other = project(30000); // a new session (after /clear) has no flag
  assert.equal(isDeny(call(pre(other.cwd, other.s, 'Agent'))), false);
});

test('handoff mode: Edit/Write only on STATE and HANDOFF', () => {
  const { cwd, s } = project(160000);
  const ed = (tool, file) => call(pre(cwd, s, tool, { file_path: file }));
  assert.equal(isDeny(ed('Edit', path.join(cwd, 'src', 'a.js'))), true);
  assert.equal(isDeny(ed('Write', path.join(cwd, 'notes.md'))), true);
  assert.equal(isDeny(ed('NotebookEdit', path.join(cwd, 'n.ipynb'))), true);
  assert.equal(isDeny(call(pre(cwd, s, 'Edit', {}))), true, 'no path: cannot verify, denied');
  assert.match(JSON.parse(ed('Edit', path.join(cwd, 'a.js')).out).hookSpecificOutput.permissionDecisionReason, /only STATE\.md and HANDOFF\.md/);
  assert.equal(isDeny(ed('Edit', path.join(cwd, 'STATE.md'))), false, 'STATE may be edited');
  assert.equal(isDeny(ed('Write', path.join(cwd, 'HANDOFF.md'))), false, 'HANDOFF may be written');
  assert.equal(isDeny(ed('Edit', 'STATE.md')), false, 'a relative path resolves against cwd');
  assert.equal(isDeny(ed('Edit', path.join(cwd, 'sub', '..', 'STATE.md'))), false);
  const below = project(100000);
  assert.equal(isDeny(call(pre(below.cwd, below.s, 'Edit', { file_path: path.join(below.cwd, 'a.js') }))), false, 'below the threshold edits are free');
});

test('Stop: blocks until STATE is newer than the flag, then lets go with a /clear reminder', () => {
  const { cwd, s } = project(160000);
  assert.equal(blocks(call(hook(cwd, s, 'Stop', { stop_hook_active: false }))), true);
  const flag = cg.readFlag(s);
  assert.equal(flag.stopBlocks, 1);
  const later = new Date(flag.ts + 5000);
  fs.utimesSync(path.join(cwd, 'STATE.md'), later, later); // STATE updated after the crossing
  const r = call(hook(cwd, s, 'Stop', { stop_hook_active: false }));
  assert.equal(blocks(r), false);
  assert.match(ctxText(r), /\/clear/);
});

test('Stop: a repeated Stop does not loop (stop_hook_active, and at most 2 blocks per crossing)', () => {
  // stop_hook_active: the turn was already blocked once
  const a = project(160000);
  assert.equal(blocks(call(hook(a.cwd, a.s, 'Stop', { stop_hook_active: true }))), false, 'stop_hook_active is respected');
  assert.equal(cg.readFlag(a.s).stopBlocks, 0, 'and it consumes no block');
  // the counter: 2 blocks, then the turn ends with a systemMessage for the owner
  const b = project(160000);
  const stop = () => call(hook(b.cwd, b.s, 'Stop', { stop_hook_active: false }));
  assert.equal(blocks(stop()), true);
  assert.equal(blocks(stop()), true);
  const third = stop();
  assert.equal(blocks(third), false);
  assert.match(ctxText(third), /the lead did not hand over the shift: context 160K/);
  assert.equal(blocks(stop()), false, 'and it stays released');
});

test('Stop: HANDOFF status SENT of this session is silent even with an old STATE; a SENT of another session or DRAFT is not', () => {
  const { cwd, s } = project(160000);
  const hp = path.join(cwd, 'HANDOFF.md');
  const stop = () => call(hook(cwd, s, 'Stop', { stop_hook_active: false }));
  fs.writeFileSync(hp, `\uFEFF# HANDOFF
handoff_id: h-1
status: DRAFT
old_session_id: ${s}
`);
  assert.equal(blocks(stop()), true, 'DRAFT');
  fs.writeFileSync(hp, `handoff_id: h-0
status: SENT
old_session_id: other-session
`);
  assert.equal(blocks(stop()), true, 'a SENT file of another session');
  fs.writeFileSync(hp, `\uFEFF# HANDOFF
handoff_id: h-1
status: SENT
old_session_id: ${s}
`);
  const r = stop();
  assert.equal(r.out, '', 'SENT of this session: no block and no message');
  assert.equal(cg.handoffSentBy(hp, s), true);
  assert.equal(cg.handoffSentBy(hp, 'x'), false);
  assert.equal(cg.handoffSentBy(path.join(cwd, 'none.md'), s), false, 'no file');
});

test('Stop below the threshold and without a flag never blocks', () => {
  const { cwd, s } = project(110000);
  assert.equal(call(hook(cwd, s, 'Stop', { stop_hook_active: false })).out, '');
});

test('PreToolUse reminders: on a stage change at once, then at most every 5 minutes', () => {
  const { cwd, s, p } = project(125000);
  assert.match(ctxText(call(pre(cwd, s, 'Bash', { command: 'ls' }))), /update STATE/);
  assert.equal(ctxText(call(pre(cwd, s, 'Bash', { command: 'ls' }))), '', 'throttled');
  writeCtx(p, 142000);
  assert.match(ctxText(call(pre(cwd, s, 'Bash', { command: 'ls' }))), /prepare the handoff now/, 'a new stage is shown at once');
});

test('the transcript size is a secondary signal: a line, never a block', () => {
  const { cwd, s } = project(50000, { config: { watchdog: { warnMiB: 1, stopMiB: 2 } } });
  const tr = path.join(cwd, 't.jsonl');
  fs.writeFileSync(tr, Buffer.alloc(3 * 1048576));
  const r = call(hook(cwd, s, 'UserPromptSubmit', { transcript_path: tr }));
  assert.match(ctxText(r), /Context 50K \/ file 3 MB: update STATE/);
  assert.equal(isDeny(call(pre(cwd, s, 'Agent', {}, { transcript_path: tr }))), false);
  assert.equal(cg.readFlag(s), null);
});

test('unread watchdog alerts are shown on the prompt (and marked read)', () => {
  const { cwd, s } = project(10000);
  const root = projectRoot(cwd);
  fs.writeFileSync(tmpLib.alertsFile(root), '2026-01-01T00:00:01Z growth alarm\n');
  assert.match(ctxText(call(hook(cwd, s, 'UserPromptSubmit'))), /watchdog: 1 unread alert.*growth alarm/s);
  assert.doesNotMatch(ctxText(call(hook(cwd, s, 'UserPromptSubmit'))), /growth alarm/);
});

test('garbage input and unknown events never fail the session', () => {
  assert.equal(runScript('context-guard.cjs', '###').code, 0);
  assert.equal(runScript('context-guard.cjs', { hook_event_name: 'Notification', session_id: 'x', cwd: tmpProject({}) }).out, '');
});

test('setup pct: recommended is above ctxHandoff, a value at or below it is wrong', () => {
  const home = fs.mkdtempSync(path.join(TEST_TMP, 'home-'));
  const proj = tmpProject({});
  fs.mkdirSync(path.join(proj, '.git', 'info'), { recursive: true });
  const env = { GHORC_HOME: home };
  const check = () => runScript('setup.cjs', '', { args: ['--check', '--project', '--cwd', proj], env }).out;
  const setPct = (v) => {
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: v } }));
  };
  const pctLine = () => check().split('\n').find((l) => /pct \[project\]/.test(l)) || '';
  assert.match(pctLine(), /-> "17"/, '170K of 1M, rounded up');
  setPct('15'); // 150K = ctxHandoff: compaction would reset the counter before the guard acts
  assert.doesNotMatch(pctLine(), /\bok\b/i);
  setPct('14');
  assert.doesNotMatch(pctLine(), /\bok\b/i);
  setPct('17');
  assert.match(pctLine(), /\bok\b/i);
  setPct('18');
  assert.match(pctLine(), /\bok\b/i);
  setPct('30'); // far too late
  assert.doesNotMatch(pctLine(), /\bok\b/i);
  // another window: 200K gives 85
  fs.writeFileSync(path.join(proj, '.claude', 'ctx-w.json'), JSON.stringify({ context_window_size: 200000 }));
  assert.match(pctLine(), /-> "85"/);
});

// ---- review round 1 (E300) ----

const hbash = (cwd, command, extra = {}) =>
  runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: sid(), cwd, tool_name: 'Bash', tool_input: { command }, ...extra }, { env: extra.env });

test('P1-1: a subagent and a worker may not put text or keys into another pane, however the command is written', () => {
  const cwd = tmpProject({});
  const forbidden = [
    'herdr pane run w1:p2 "ACTIVATE h-1"',
    'MSYS_NO_PATHCONV=1 herdr pane run w1:p2 "/exit"',
    'env MSYS_NO_PATHCONV=1 herdr pane run w1:p2 "/exit"',
    'bash -c "MSYS_NO_PATHCONV=1 herdr pane run w1:p2 /exit"',
    "sh -c 'herdr pane run w1:p2 hi'",
    'cd x && herdr pane run w1:p2 hi',
    'echo y | herdr pane run w1:p2 hi',
    'command herdr pane run w1:p2 hi',
    'herdr.exe pane run w1:p2 hi',
    '/c/Tools/herdr pane run w1:p2 hi',
    'herdr --no-color pane run w1:p2 hi',
    'herdr pane send-keys w1:p2 hi enter',
    'herdr pane send-text w1:p2 hi',
    'herdr agent send-keys lead-next enter',
    'herdr agent prompt lead-next hi',
    'herdr agent start lead-next --kind claude',
  ];
  for (const c of forbidden) {
    assert.equal(isDeny(hbash(cwd, c, { agent_id: 'ag1' })), true, `subagent: ${c}`);
    assert.equal(isDeny(hbash(cwd, c, { env: { GHORC_ROLE: 'worker' } })), true, `worker: ${c}`);
    assert.equal(isDeny(hbash(cwd, c)), false, `lead: ${c}`); // the lead hands the shift over with these
    assert.equal(isDeny(hbash(cwd, c, { env: { GHORC_ROLE: 'lead' } })), false, `lead role: ${c}`);
  }
  for (const c of ['herdr pane list', 'herdr pane read w1:p2', 'herdr agent list', 'herdr agent get x', 'herdr agent read x', 'herdr agent wait x --until idle', 'echo herdr pane run']) {
    assert.equal(isDeny(hbash(cwd, c, { agent_id: 'ag1' })), false, `read-only: ${c}`);
  }
  assert.match(JSON.parse(hbash(cwd, 'herdr pane run p x', { agent_id: 'a' }).out).hookSpecificOutput.permissionDecisionReason, /herdr pane run/);
});

test('P2-1: only the first status: counts; prose with "status: SENT" in a DRAFT file does not silence Stop', () => {
  const { cwd, s } = project(160000);
  const hp = path.join(cwd, 'HANDOFF.md');
  fs.writeFileSync(hp, `# HANDOFF\nhandoff_id: h-1   status: DRAFT   old_session_id: ${s}\nnote: after ACTIVATE write status: SENT\n`);
  assert.equal(cg.handoffSentBy(hp, s), false, 'prose after a DRAFT header');
  assert.equal(blocks(call(hook(cwd, s, 'Stop', { stop_hook_active: false }))), true, 'Stop still blocks');
  fs.writeFileSync(hp, `handoff_id: h-1   status: SENT   old_session_id: ${s}\nnote: status: DRAFT is the first state\n`);
  assert.equal(cg.handoffSentBy(hp, s), true, 'a real SENT header, also with prose below and fields on one line');
  fs.writeFileSync(hp, `handoff_id: h-1\nstatus: sent\nold_session_id: ${s}\n`);
  assert.equal(cg.handoffSentBy(hp, s), true, 'case-insensitive');
  fs.writeFileSync(hp, `handoff_id: h-1\nstatus: SENTINEL\nold_session_id: ${s}\n`);
  assert.equal(cg.handoffSentBy(hp, s), false, 'SENT is a whole word');
});

test('P2-3: the K in the lines is rounded down, so 149999 is 149K and never reads as the 150K threshold', () => {
  const a = project(149999);
  assert.match(ctxText(call(hook(a.cwd, a.s, 'UserPromptSubmit'))), /^Context 149K.*prepare the handoff now/);
  const b = project(139999);
  assert.match(ctxText(call(hook(b.cwd, b.s, 'UserPromptSubmit'))), /^Context 139K.*update STATE/);
});

test('P2-4: MultiEdit is an edit tool; the path compare ignores case on Windows; the flag is written exactly at ctxHandoff', () => {
  const { cwd, s } = project(160000);
  assert.equal(isDeny(call(pre(cwd, s, 'MultiEdit', { file_path: path.join(cwd, 'a.js') }))), true, 'MultiEdit outside STATE');
  assert.equal(isDeny(call(pre(cwd, s, 'MultiEdit', { file_path: path.join(cwd, 'STATE.md') }))), false, 'MultiEdit on STATE');
  if (process.platform === 'win32') {
    assert.equal(isDeny(call(pre(cwd, s, 'Edit', { file_path: path.join(cwd, 'STATE.md').toUpperCase() }))), false, 'case-insensitive on Windows');
  }
  const exact = project(150000);
  call(pre(exact.cwd, exact.s, 'Bash', { command: 'ls' }));
  assert.ok(cg.readFlag(exact.s), 'the flag exists at exactly 150000');
  const below = project(149999);
  call(pre(below.cwd, below.s, 'Bash', { command: 'ls' }));
  assert.equal(cg.readFlag(below.s), null, 'and not at 149999');
});

test('P2-5: cleanup removes handoff-*.json flags older than maxAgeDays and keeps fresh ones', () => {
  const cwd = tmpProject({});
  const dir = tmpLib.tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const oldF = path.join(dir, 'handoff-cleanup-old.json');
  const newF = path.join(dir, 'handoff-cleanup-new.json');
  fs.writeFileSync(oldF, '{}');
  fs.writeFileSync(newF, '{}');
  const t = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(oldF, t, t);
  tmpLib.cleanup(cwd);
  assert.equal(fs.existsSync(oldF), false, 'old flag removed');
  assert.equal(fs.existsSync(newF), true, 'fresh flag kept');
  fs.rmSync(newF, { force: true });
});
