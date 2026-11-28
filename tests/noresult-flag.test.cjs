'use strict';
// NORESULT: a tasked worker is idle or done and its report has no fresh result line. Also: STALLED is judged on the fresh result line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpProject, TEST_TMP } = require('./helpers.cjs');
process.env.GHORC_TMP = TEST_TMP; // the state file path of this process equals the one of the hook processes
const tabs = require('../scripts/lib/tabs.cjs');

const NONE = JSON.stringify({ result: { agents: [] } });
const hdr = (agents) => JSON.stringify({ result: { agents } });
const agent = (name, status, cwd, extra = {}) => ({ name, agent_status: status, pane_id: 'w4:p1', cwd, agent_session: { value: `s-${name}` }, ...extra });
const hcl = (terminals) => JSON.stringify({ terminals });
const term = (name, status, extra = {}) => ({ address: `t-${name}`, name, parent: 'self1', state: 'live', status, agent: 'claude-code', ...extra });
const BYPASS = ['--permission-mode', 'bypassPermissions'];

let seq = 0;
function project(tabsCfg) {
  const cwd = fs.realpathSync.native(tmpProject({ tabs: tabsCfg || {}, worker: { permissionArgs: BYPASS }, handoff: { candidatePermissionArgs: BYPASS } }));
  return { cwd, sid: `${String(++seq).padStart(4, '0')}-noresult-session` };
}
const ev = (p, event, extra = {}) => ({ hook_event_name: event, session_id: p.sid, cwd: p.cwd, ...extra });
const hEnv = (p, list, env = {}) => ({ CLAUDE_PROJECT_DIR: p.cwd, GHORC_CAPACITY_HERDR_JSON: list, ...env });
const cEnv = (p, list, env = {}) => ({ CLAUDE_PROJECT_DIR: p.cwd, GHORC_CAPACITY_HC_JSON: list, HC_TERMINAL_ID: 'self1', ...env });
const mon = (p, event, env, extra = {}) => runScript('tabs-guard.cjs', ev(p, event, extra), { cwd: p.cwd, env });
const pre = (p, command, env) => runScript('tabs-guard.cjs', { ...ev(p, 'PreToolUse'), tool_name: 'Bash', tool_input: { command } }, { cwd: p.cwd, env });
const ctx = (r) => JSON.parse(r.out).hookSpecificOutput.additionalContext;
const blocks = (r) => r.out.trim() !== '' && JSON.parse(r.out).decision === 'block';
const ago = (min) => Date.now() - min * 60000;
const readState = (p) => JSON.parse(fs.readFileSync(tabs.stateFile(p.sid), 'utf8'));
function seed(p, workers, tasked) {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  fs.writeFileSync(tabs.stateFile(p.sid), JSON.stringify(tasked ? { workers, tasked } : { workers }));
}
const w = (status, { first = 30, since = 5, worked } = {}) => ({ firstSeen: ago(first), status, statusSince: ago(since), notified: false, ...(worked ? { worked: true } : {}) });
function report(p, name, lastLine, { old = false } = {}) {
  const f = tabs.reportFile(p.cwd, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `# report\n\nsome text\n${lastLine}\n`);
  if (old) {
    const t = new Date(Date.now() - 3 * 3600000);
    fs.utimesSync(f, t, t);
  }
  return f;
}
const NAME = 'a1-implementer';
const abs = (p, name = NAME) => path.resolve(p.cwd, '.claude', 'ghorc-out', `${name}.md`);
const mockEnv = (ms) => ({ NODE_OPTIONS: `--require "${path.join(__dirname, 'mock-now.cjs').split('\\').join('/')}"`, GHORC_MOCK_NOW_MS: String(ms) });

test('NORESULT: tasked, idle, no report file: the flag names the worker and the absolute report path', () => {
  const p = project();
  seed(p, { [NAME]: w('idle') }, { [NAME]: ago(8) });
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'idle', p.cwd)]))));
  const line = text.split('\n').find((l) => l.startsWith('tabs NORESULT:'));
  assert.ok(line, text);
  assert.ok(line.includes(`${NAME} is idle and has no fresh result line, so its package is NOT delivered.`), line);
  assert.ok(line.includes(`Expected report: ${abs(p)}.`), line);
  assert.ok(path.isAbsolute(abs(p)));
  assert.match(line, /Read its screen \(herdr pane read w4:p1 --source recent --lines 40\), ask the same worker once to write the file with the result line last, and do not continue without it\.$/);
  assert.equal(/FINISHED|RESULT\?/.test(text), false, text);
});

test('NORESULT: a stale result line from an earlier round is not a result and does not silence it', () => {
  const p = project();
  report(p, NAME, `DONE ${NAME}`, { old: true });
  seed(p, { [NAME]: w('done') }, { [NAME]: ago(8) });
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'done', p.cwd)]))));
  assert.match(text, /tabs NORESULT: a1-implementer is done and has no fresh result line/);
  assert.equal(text.includes('FINISHED'), false, text);
});

test('NORESULT: a fresh result line gives FINISHED as before and no NORESULT', () => {
  const p = project();
  report(p, NAME, `DONE ${NAME}`);
  seed(p, { [NAME]: w('idle', { worked: true }) }, { [NAME]: ago(8) });
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'idle', p.cwd, { tab_id: 'w4:t2' })]))));
  assert.match(text, /tabs FINISHED: a1-implementer wrote "DONE a1-implementer" but its tab is still open\. Accept the report and close the tab now: herdr tab close w4:t2\./);
  assert.equal(text.includes('NORESULT'), false, text);
});

test('NORESULT: it goes away once a fresh result line appears', () => {
  const p = project();
  seed(p, { [NAME]: w('idle') }, { [NAME]: ago(8) });
  const env = hEnv(p, hdr([agent(NAME, 'idle', p.cwd)]));
  assert.match(ctx(mon(p, 'UserPromptSubmit', env)), /tabs NORESULT: a1-implementer/);
  report(p, NAME, `DONE ${NAME}`);
  const text = ctx(mon(p, 'UserPromptSubmit', env));
  assert.equal(text.includes('NORESULT'), false, text);
  assert.match(text, /tabs FINISHED: a1-implementer/);
});

test('NORESULT: a worker that was started but never given a task never gets it', () => {
  const p = project({ idleMin: 10 });
  seed(p, { [NAME]: w('idle', { first: 30, since: 20 }) }); // no task recorded, never seen working
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'idle', p.cwd)]))));
  assert.equal(text.includes('NORESULT'), false, text);
  assert.match(text, /tabs STALLED: a1-implementer has been idle 20m without a result line/, 'STALLED still covers it');
  assert.equal(blocks(mon(p, 'Stop', hEnv(p, hdr([agent(NAME, 'idle', p.cwd)])))), false);
  // a first sighting is no task either
  const q = project();
  assert.equal(ctx(mon(q, 'UserPromptSubmit', hEnv(q, hdr([agent(NAME, 'idle', q.cwd)])))), 'tabs: 1 live (a1-implementer idle 0m)');
});

test('NORESULT: a working or blocked worker never has it, even when tasked', () => {
  for (const status of ['working', 'blocked']) {
    const p = project();
    seed(p, { [NAME]: w(status, { worked: true }) }, { [NAME]: ago(8) });
    const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, status, p.cwd)]))));
    assert.equal(text.includes('NORESULT'), false, `${status}: ${text}`);
  }
  // a long-lived tab has no report
  const q = project();
  seed(q, { 't1-runner': w('idle', { worked: true }) }, { 't1-runner': ago(8) });
  assert.equal(ctx(mon(q, 'UserPromptSubmit', hEnv(q, hdr([agent('t1-runner', 'idle', q.cwd)])))).includes('NORESULT'), false);
  // a closed tab is GONE, not NORESULT
  const g = project();
  seed(g, { [NAME]: w('idle', { worked: true }) }, { [NAME]: ago(8) });
  const text = ctx(mon(g, 'UserPromptSubmit', hEnv(g, NONE)));
  assert.match(text, /tabs GONE: a1-implementer/);
  assert.equal(text.includes('NORESULT'), false, text);
  assert.equal(readState(g).tasked, undefined, 'a worker that left the list is forgotten');
});

test('NORESULT: not inside the grace period after the send, then raised', () => {
  const p = project();
  const T = Date.now();
  seed(p, { [NAME]: w('idle', { first: 0, since: 0 }) }, { [NAME]: T - 20000 });
  const list = hdr([agent(NAME, 'idle', p.cwd)]);
  const at = (ms) => mon(p, 'UserPromptSubmit', hEnv(p, list, mockEnv(ms)));
  assert.equal(ctx(at(T)).includes('NORESULT'), false, 'sent 20 s ago');
  assert.equal(ctx(at(T + 30000)).includes('NORESULT'), false, 'sent 50 s ago');
  assert.equal(tabs.NORESULT_GRACE_MS, 60000);
  assert.match(ctx(at(T + 41000)), /tabs NORESULT: a1-implementer/);
  // the grace does not hold a Stop block back for a worker that was seen working earlier: it has no send time
  const q = project();
  seed(q, { [NAME]: w('idle', { worked: true }) });
  assert.match(ctx(mon(q, 'UserPromptSubmit', hEnv(q, hdr([agent(NAME, 'idle', q.cwd)])))), /tabs NORESULT/);
});

test('NORESULT blocks Stop once, like FINISHED, and again when it comes back', () => {
  const p = project();
  seed(p, { [NAME]: w('idle') }, { [NAME]: ago(8) });
  const idle = hEnv(p, hdr([agent(NAME, 'idle', p.cwd)]));
  const st = mon(p, 'Stop', idle);
  assert.ok(blocks(st));
  assert.match(JSON.parse(st.out).reason, /tabs NORESULT: a1-implementer is idle and has no fresh result line/);
  assert.deepEqual(readState(p).workers[NAME].sb, ['NORESULT']);
  assert.equal(mon(p, 'Stop', hEnv(p, hdr([agent(NAME, 'idle', p.cwd)])), { stop_hook_active: true }).out.trim(), '');
  assert.equal(mon(p, 'Stop', idle).out.trim(), '', 'the same occurrence does not block again');
  assert.match(ctx(mon(p, 'UserPromptSubmit', idle)), /tabs NORESULT/, 'the prompt line still shows it');
  // it works again (the nudge), the flag goes away, and a new idle period blocks again
  mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'working', p.cwd)])));
  assert.deepEqual(readState(p).workers[NAME].sb, []);
  assert.ok(blocks(mon(p, 'Stop', idle)));
  // stopBlock off: no block, the prompt line stays
  const q = project({ stopBlock: false });
  seed(q, { [NAME]: w('idle') }, { [NAME]: ago(8) });
  const e = hEnv(q, hdr([agent(NAME, 'idle', q.cwd)]));
  assert.equal(mon(q, 'Stop', e).out.trim(), '');
  assert.match(ctx(mon(q, 'UserPromptSubmit', e)), /tabs NORESULT/);
  // a SessionStart shows it too
  assert.match(ctx(mon(q, 'SessionStart', e, { source: 'resume' })), /tabs NORESULT/);
});

test('NORESULT blocks Stop together with FINISHED in one reason; a tab that already blocked as FINISHED does not block again', () => {
  const p = project();
  report(p, 'b1-implementer', 'DONE b1-implementer');
  seed(p, { [NAME]: w('idle'), 'b1-implementer': w('idle') }, { [NAME]: ago(8) });
  const env = hEnv(p, hdr([agent(NAME, 'idle', p.cwd), agent('b1-implementer', 'idle', p.cwd)]));
  const why = JSON.parse(mon(p, 'Stop', env).out).reason;
  assert.match(why, /tabs NORESULT: a1-implementer/);
  assert.match(why, /tabs FINISHED: b1-implementer/);
  assert.equal(mon(p, 'Stop', env).out.trim(), '');
});

test('STALLED: a stale result line no longer silences it; NORESULT takes its place for a tasked worker', () => {
  const p = project({ idleMin: 10 });
  report(p, NAME, `DONE ${NAME}`, { old: true });
  report(p, 'b1-implementer', `DONE b1-implementer`, { old: true });
  seed(p, { [NAME]: w('idle', { first: 30, since: 12 }), 'b1-implementer': w('idle', { first: 30, since: 12 }) }, { 'b1-implementer': ago(20) });
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'idle', p.cwd), agent('b1-implementer', 'idle', p.cwd)]))));
  assert.match(text, /tabs STALLED: a1-implementer has been idle 12m without a fresh result line \(its report still ends with a result line from \d\d:\d\d, written before this tab was first seen at \d\d:\d\d\)\./);
  assert.equal(text.includes('NORESULT: a1-implementer'), false);
  assert.match(text, /tabs NORESULT: b1-implementer is idle/);
  assert.equal(text.includes('STALLED: b1-implementer'), false, 'never both for one worker');
  // a fresh line still silences STALLED
  report(p, NAME, `DONE ${NAME}`);
  const again = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'idle', p.cwd), agent('b1-implementer', 'idle', p.cwd)]))));
  assert.equal(again.includes('STALLED'), false, again);
  assert.match(again, /tabs FINISHED: a1-implementer/);
});

test('NORESULT: a worker seen working and idle again later gets it (no recorded send needed)', () => {
  const p = project();
  const T = Date.now();
  const at = (ms, list) => mon(p, 'UserPromptSubmit', hEnv(p, list, mockEnv(ms)));
  assert.equal(ctx(at(T, hdr([agent(NAME, 'working', p.cwd)]))), 'tabs: 1 live (a1-implementer working 0m)');
  assert.equal(readState(p).workers[NAME].worked, true);
  assert.match(ctx(at(T + 60000, hdr([agent(NAME, 'idle', p.cwd)]))), /tabs NORESULT: a1-implementer is idle/);
});

test('NORESULT on hc: the same rule, the hc read form in the text', () => {
  const p = project();
  seed(p, { [NAME]: w('idle') }, { [NAME]: ago(8) });
  const text = ctx(mon(p, 'UserPromptSubmit', cEnv(p, hcl([term(NAME, 'idle', { cwd: p.cwd })]))));
  assert.match(text, new RegExp(`tabs NORESULT: a1-implementer is idle and has no fresh result line, so its package is NOT delivered\\. Expected report: ${abs(p).replace(/[\\.]/g, '\\$&')}\\. Read its screen \\(hc read a1-implementer\\)`));
  assert.ok(blocks(mon(p, 'Stop', cEnv(p, hcl([term(NAME, 'idle', { cwd: p.cwd })])))));
  // never tasked, working, fresh result: no NORESULT
  const q = project();
  seed(q, { [NAME]: w('idle'), 'b1-implementer': w('working', { worked: true }), 'c1-implementer': w('idle', { worked: true }) });
  report(q, 'c1-implementer', 'DONE c1-implementer');
  const t = ctx(mon(q, 'UserPromptSubmit', cEnv(q, hcl([term(NAME, 'idle', { cwd: q.cwd }), term('b1-implementer', 'working', { cwd: q.cwd }), term('c1-implementer', 'idle', { cwd: q.cwd })]))));
  assert.equal(t.includes('NORESULT'), false, t);
  assert.match(t, /tabs FINISHED: c1-implementer/);
});

// ---- the send is recorded by the PreToolUse check ----
const HCRUN = (name, prompt = ' "do it"') => `hc run --bg --name ${name} --cwd . env GHORC_ROLE=worker claude --model sonnet --effort medium -n ${name} --permission-mode bypassPermissions${prompt}`;
const taskedOf = (p) => (fs.existsSync(tabs.stateFile(p.sid)) ? readState(p).tasked || {} : {});

test('recording: an hc run with a prompt, an hc send and a herdr text send record the worker; start-only and send-keys do not', () => {
  const p = project();
  const hcEnv = cEnv(p, hcl([]));
  const r1 = pre(p, HCRUN('a1-implementer', ''), hcEnv);
  assert.equal(r1.out.trim(), '', r1.out);
  assert.deepEqual(taskedOf(p), {}, 'started without a task');
  const r2 = pre(p, HCRUN('a1-implementer'), hcEnv);
  assert.equal(r2.out.trim(), '', r2.out);
  assert.deepEqual(Object.keys(taskedOf(p)), ['a1-implementer']);
  const t0 = taskedOf(p)['a1-implementer'];
  assert.ok(Math.abs(Date.now() - t0) < 60000);
  assert.equal(pre(p, 'hc send B1-Scout "do it now"', hcEnv).out.trim(), '');
  assert.deepEqual(Object.keys(taskedOf(p)).sort(), ['a1-implementer', 'b1-scout']);
  assert.equal(pre(p, 'hc send c1-scout', hcEnv).out.trim(), '', 'no text');
  assert.equal(pre(p, 'hc read d1-scout', hcEnv).out.trim(), '');
  // herdr: the pane id is resolved by the live list
  const q = project();
  const hl = hEnv(q, hdr([agent('a1-implementer', 'idle', q.cwd, { pane_id: 'w4:p7' })]), { HERDR_WORKSPACE_ID: 'w4' });
  const r3 = pre(q, 'MSYS_NO_PATHCONV=1 herdr pane run w4:p7 "Read /x/brief.md and follow it."', hl);
  assert.equal(r3.out.trim(), '', r3.out);
  assert.deepEqual(Object.keys(taskedOf(q)), ['a1-implementer']);
  const r4 = pre(q, 'herdr pane send-keys w4:p7 enter', hl);
  assert.equal(r4.out.trim(), '');
  pre(q, 'MSYS_NO_PATHCONV=1 herdr pane run a1-implementer "again"', hl);
  assert.deepEqual(Object.keys(taskedOf(q)), ['a1-implementer'], 'by agent name too');
  // a denied command records nothing
  const d = project();
  assert.ok(pre(d, 'herdr pane run w4:p7 "two\nlines"', hEnv(d, hdr([agent('a1-implementer', 'idle', d.cwd, { pane_id: 'w4:p7' })]))).out.includes('deny'));
  assert.deepEqual(taskedOf(d), {});
});

test('recording end to end: a recorded send, then idle without a report: quiet in the grace period, NORESULT after it, per backend', () => {
  for (const kind of ['herdr', 'hc']) {
    const p = project();
    const T = Date.now();
    const list = kind === 'herdr' ? hdr([agent(NAME, 'idle', p.cwd, { pane_id: 'w4:p7' })]) : hcl([term(NAME, 'idle', { cwd: p.cwd })]);
    const env = (extra = {}) => (kind === 'herdr' ? hEnv(p, list, { HERDR_WORKSPACE_ID: 'w4', ...extra }) : cEnv(p, list, extra));
    const send = kind === 'herdr' ? 'MSYS_NO_PATHCONV=1 herdr pane run w4:p7 "Read /x/brief.md and follow it."' : 'hc send a1-implementer "do it"';
    assert.equal(pre(p, send, env()).out.trim(), '', kind);
    const at = (ms) => mon(p, 'UserPromptSubmit', env(mockEnv(ms)));
    const sentAt = taskedOf(p)[NAME];
    assert.equal(ctx(at(sentAt + 10000)).includes('NORESULT'), false, `${kind}: 10 s after the send`);
    assert.equal(blocks(mon(p, 'Stop', env(mockEnv(sentAt + 20000)))), false, `${kind}: Stop inside the grace period`);
    assert.match(ctx(at(sentAt + 70000)), /tabs NORESULT: a1-implementer is idle/, kind);
    assert.ok(blocks(mon(p, 'Stop', env(mockEnv(sentAt + 80000)))), `${kind}: Stop blocked`);
    assert.ok(T > 0);
  }
});

test('state that cannot be read: no NORESULT, no crash, STALLED as before from the first sighting', () => {
  const p = project();
  fs.mkdirSync(TEST_TMP, { recursive: true });
  fs.writeFileSync(tabs.stateFile(p.sid), '{ not json');
  const r = mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'idle', p.cwd)])));
  assert.equal(r.code, 0);
  assert.equal(ctx(r), 'tabs: 1 live (a1-implementer idle 0m)');
  // a state of the wrong shape for the new field is ignored too
  const q = project();
  fs.writeFileSync(tabs.stateFile(q.sid), JSON.stringify({ workers: {}, tasked: [1, 2] }));
  assert.equal(ctx(mon(q, 'UserPromptSubmit', hEnv(q, hdr([agent(NAME, 'idle', q.cwd)])))), 'tabs: 1 live (a1-implementer idle 0m)');
  // a send recorded into an unreadable state starts a fresh state
  const s = project();
  fs.writeFileSync(tabs.stateFile(s.sid), '{ not json');
  assert.equal(pre(s, 'hc send a1-implementer "go"', cEnv(s, hcl([]))).out.trim(), '');
  assert.deepEqual(Object.keys(taskedOf(s)), ['a1-implementer']);
});

test('a recorded send for a tab that is not listed yet is kept for a while, then dropped', () => {
  const p = project();
  const T = Date.now();
  seed(p, {}, { [NAME]: T - 5000, 'b1-implementer': T - 2 * 3600000 });
  const at = (ms, list) => mon(p, 'UserPromptSubmit', hEnv(p, list, mockEnv(ms)));
  at(T, NONE);
  at(T, hdr([agent('c1-implementer', 'working', p.cwd)])); // another worker: the list is not empty, the name is still not listed
  assert.deepEqual(Object.keys(readState(p).tasked || {}), [NAME], 'the old one is dropped, the new one kept');
  // the tab shows up idle: the send is remembered and, after the grace period, NORESULT
  at(T + 1000, hdr([agent(NAME, 'idle', p.cwd)]));
  assert.deepEqual(Object.keys(readState(p).tasked), [NAME]);
  assert.match(ctx(at(T + 70000, hdr([agent(NAME, 'idle', p.cwd)]))), /tabs NORESULT: a1-implementer/);
});

// ---- round 2: freshness counts from the last recorded send; session commands are no task; agent prompt; absolute GONE path ----
const setMtime = (f, minAgo) => {
  const t = new Date(ago(minAgo));
  fs.utimesSync(f, t, t);
};

test('freshness 1a: DONE for task 1, task 2 sent to the same tab, idle without a rewrite: no FINISHED, NORESULT after the grace period', () => {
  const p = project();
  setMtime(report(p, NAME, `DONE ${NAME}`), 10); // written after the first sighting (30 min ago), before the send
  seed(p, { [NAME]: w('idle', { first: 30, since: 3 }) }, { [NAME]: ago(5) });
  const list = hdr([agent(NAME, 'idle', p.cwd)]);
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, list)));
  assert.equal(text.includes('FINISHED'), false, text);
  assert.match(text, /tabs NORESULT: a1-implementer is idle and has no fresh result line/);
  assert.ok(blocks(mon(p, 'Stop', hEnv(p, list))), 'Stop blocked by NORESULT');
  // inside the grace period of the second send: quiet, and still no FINISHED
  const T = Date.now();
  const q = project();
  setMtime(report(q, NAME, `DONE ${NAME}`), 10);
  seed(q, { [NAME]: w('idle', { first: 30, since: 3 }) }, { [NAME]: T - 20000 });
  const quiet = ctx(mon(q, 'UserPromptSubmit', hEnv(q, hdr([agent(NAME, 'idle', q.cwd)]), mockEnv(T))));
  assert.equal(/FINISHED|NORESULT|RESULT\?/.test(quiet), false, quiet);
  // a line older than the first sighting does not silence STALLED (an untasked worker); a tasked one gets NORESULT instead (line older than the send)
  const s = project({ idleMin: 10 });
  setMtime(report(s, 'b1-implementer', 'DONE b1-implementer'), 40); // older than the first sighting (30 min ago)
  seed(s, { 'b1-implementer': w('idle', { first: 30, since: 12 }) }, { 'c1-implementer': ago(1) });
  assert.match(ctx(mon(s, 'UserPromptSubmit', hEnv(s, hdr([agent('b1-implementer', 'idle', s.cwd)])))), /tabs STALLED: b1-implementer has been idle 12m/);
  const s2 = project({ idleMin: 10 });
  setMtime(report(s2, 'b1-implementer', 'DONE b1-implementer'), 20);
  seed(s2, { 'b1-implementer': w('idle', { first: 30, since: 12 }) }, { 'b1-implementer': ago(15) });
  const t2 = ctx(mon(s2, 'UserPromptSubmit', hEnv(s2, hdr([agent('b1-implementer', 'idle', s2.cwd)]))));
  assert.match(t2, /tabs NORESULT: b1-implementer/);
  assert.equal(t2.includes('STALLED'), false, t2);
});

test('freshness 1b: the worker rewrites the file after the send: FINISHED, no NORESULT', () => {
  const p = project();
  setMtime(report(p, NAME, `DONE ${NAME}`), 10);
  seed(p, { [NAME]: w('idle', { first: 30, since: 3 }) }, { [NAME]: ago(5) });
  const list = hdr([agent(NAME, 'idle', p.cwd, { tab_id: 'w4:t2' })]);
  assert.match(ctx(mon(p, 'UserPromptSubmit', hEnv(p, list))), /tabs NORESULT/);
  report(p, NAME, `DONE ${NAME}`); // written now, after the send
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, list)));
  assert.match(text, /tabs FINISHED: a1-implementer wrote "DONE a1-implementer"/);
  assert.equal(text.includes('NORESULT'), false, text);
  // a BLOCKED line after the send is a result as well
  report(p, NAME, `BLOCKED ${NAME}: no network`);
  assert.match(ctx(mon(p, 'UserPromptSubmit', hEnv(p, list))), /BLOCKED by the worker/);
});

test('freshness 1c: a fresh result and no further send behave as before', () => {
  const p = project();
  setMtime(report(p, NAME, `DONE ${NAME}`), 10);
  seed(p, { [NAME]: w('idle', { first: 30, since: 3, worked: true }) }, { [NAME]: ago(15) }); // the send is older than the line
  const list = hdr([agent(NAME, 'idle', p.cwd, { tab_id: 'w4:t2' })]);
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, list)));
  assert.match(text, /tabs FINISHED: a1-implementer wrote "DONE a1-implementer" but its tab is still open\. Accept the report and close the tab now: herdr tab close w4:t2\./);
  assert.equal(/NORESULT|STALLED/.test(text), false, text);
  const q = project();
  setMtime(report(q, NAME, `DONE ${NAME}`), 10);
  seed(q, { [NAME]: w('idle', { first: 30, since: 3 }) }); // no send recorded: the first sighting, as before
  assert.match(ctx(mon(q, 'UserPromptSubmit', hEnv(q, hdr([agent(NAME, 'idle', q.cwd)])))), /tabs FINISHED/);
});

test('freshness: first sighting after a recorded send: an older line is the previous task, not a RESULT? question', () => {
  const p = project();
  setMtime(report(p, NAME, `DONE ${NAME}`), 10);
  seed(p, {}, { [NAME]: ago(5) }); // sent 5 minutes ago; the tab shows up now, idle, and still holds the earlier line
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'idle', p.cwd)]))));
  assert.equal(/RESULT\?|FINISHED/.test(text), false, text);
  assert.match(text, /tabs NORESULT: a1-implementer/);
  // without a recorded send the same line is the soft question, as before
  const q = project();
  setMtime(report(q, NAME, `DONE ${NAME}`), 10);
  assert.match(ctx(mon(q, 'UserPromptSubmit', hEnv(q, hdr([agent(NAME, 'idle', q.cwd)])))), /tabs RESULT\?: a1-implementer has a result line from/);
});

test('session commands are not a task: /exit, /clear, /compact on every send form record nothing; a task text does', () => {
  for (const text of ['/exit', '/clear', '/compact', '/compact keep the plan', '  /exit']) {
    const p = project();
    assert.equal(pre(p, `hc send ${NAME} "${text}"`, cEnv(p, hcl([]))).out.trim(), '', text);
    const q = project();
    const hl = hEnv(q, hdr([agent(NAME, 'idle', q.cwd, { pane_id: 'w4:p7' })]), { HERDR_WORKSPACE_ID: 'w4' });
    pre(q, `MSYS_NO_PATHCONV=1 herdr pane run w4:p7 "${text}"`, hl);
    pre(q, `herdr pane send-text ${NAME} '${text}'`, hl);
    pre(q, `herdr agent prompt ${NAME} "${text}" --wait --until idle --timeout 60000`, hl);
    assert.deepEqual([taskedOf(p), taskedOf(q)], [{}, {}], text);
  }
  // a text that starts with a slash path, or a slash command that is a task, is recorded
  const r = project();
  const rl = hEnv(r, hdr([agent(NAME, 'idle', r.cwd, { pane_id: 'w4:p7' })]), { HERDR_WORKSPACE_ID: 'w4' });
  pre(r, 'MSYS_NO_PATHCONV=1 herdr pane run w4:p7 "/x/brief.md"', rl);
  assert.deepEqual(Object.keys(taskedOf(r)), [NAME]);
  const t = project();
  pre(t, `hc send ${NAME} "/ghorc:implement the brief"`, cEnv(t, hcl([])));
  assert.deepEqual(Object.keys(taskedOf(t)), [NAME]);
});

test('closing sequence: result accepted, the lead sends /exit, the tab closes: no false NORESULT and FINISHED stays, per backend', () => {
  for (const kind of ['herdr', 'hc']) {
    const p = project();
    report(p, NAME, `DONE ${NAME}`);
    // the task was sent before the worker wrote its result
    seed(p, { [NAME]: w('idle', { first: 30, since: 1, worked: true }) }, { [NAME]: ago(20) });
    const list = kind === 'herdr' ? hdr([agent(NAME, 'idle', p.cwd, { pane_id: 'w4:p7', tab_id: 'w4:t2' })]) : hcl([term(NAME, 'idle', { cwd: p.cwd })]);
    const env = (extra = {}) => (kind === 'herdr' ? hEnv(p, list, { HERDR_WORKSPACE_ID: 'w4', ...extra }) : cEnv(p, list, extra));
    assert.match(ctx(mon(p, 'UserPromptSubmit', env())), /tabs FINISHED: a1-implementer/, kind);
    const before = readState(p).tasked[NAME];
    const send = kind === 'herdr' ? 'MSYS_NO_PATHCONV=1 herdr pane run w4:p7 "/exit"' : `hc send ${NAME} "/exit"`;
    assert.equal(pre(p, send, env()).out.trim(), '', kind);
    assert.equal(readState(p).tasked[NAME], before, 'the /exit send is not recorded');
    const T = Date.now();
    for (const ms of [T, T + 30000, T + 120000]) {
      const text = ctx(mon(p, 'UserPromptSubmit', env(mockEnv(ms))));
      assert.match(text, /tabs FINISHED: a1-implementer/, `${kind} at +${ms - T}`);
      assert.equal(text.includes('NORESULT'), false, `${kind}: ${text}`);
    }
    // the session ended and the tab left the list: the delivered result is not GONE
    const left = mon(p, 'UserPromptSubmit', kind === 'herdr' ? hEnv(p, NONE) : cEnv(p, hcl([])));
    assert.equal(left.out, '', `${kind}: ${left.out}`);
  }
});

test('herdr agent prompt is a recorded send: by name and by pane; options and the --until values are not text', () => {
  const p = project();
  const hl = hEnv(p, hdr([agent(NAME, 'idle', p.cwd, { pane_id: 'w4:p7' }), agent('b1-reviewer', 'idle', p.cwd, { pane_id: 'w4:p8' })]), { HERDR_WORKSPACE_ID: 'w4' });
  assert.equal(pre(p, 'herdr agent prompt w4:p7 "Read /x/brief.md and follow it." --wait --until idle --until blocked --timeout 600000', hl).out.trim(), '');
  assert.deepEqual(Object.keys(taskedOf(p)), [NAME], 'a pane id resolves to the worker');
  assert.equal(pre(p, 'herdr agent prompt B1-Reviewer "Review it"', hl).out.trim(), '');
  assert.deepEqual(Object.keys(taskedOf(p)).sort(), [NAME, 'b1-reviewer'], 'by name too');
  // no text, an unknown pane: nothing
  const q = project();
  const ql = hEnv(q, hdr([agent(NAME, 'idle', q.cwd, { pane_id: 'w4:p7' })]), { HERDR_WORKSPACE_ID: 'w4' });
  pre(q, 'herdr agent prompt w4:p7 --wait --until idle', ql);
  pre(q, 'herdr agent prompt w4:p9 "x"', ql);
  assert.deepEqual(taskedOf(q), {});
  // end to end: recorded, idle, no report: NORESULT after the grace period
  const r = project();
  const rl = hEnv(r, hdr([agent(NAME, 'idle', r.cwd, { pane_id: 'w4:p7' })]), { HERDR_WORKSPACE_ID: 'w4' });
  pre(r, 'herdr agent prompt a1-implementer "Read /x/brief.md and follow it."', rl);
  const sentAt = taskedOf(r)[NAME];
  assert.equal(ctx(mon(r, 'UserPromptSubmit', hEnv(r, hdr([agent(NAME, 'idle', r.cwd)]), mockEnv(sentAt + 10000)))).includes('NORESULT'), false);
  assert.match(ctx(mon(r, 'UserPromptSubmit', hEnv(r, hdr([agent(NAME, 'idle', r.cwd)]), mockEnv(sentAt + 70000)))), /tabs NORESULT: a1-implementer/);
});

test('GONE names the report by its absolute path, built as in NORESULT', () => {
  for (const kind of ['herdr', 'hc']) {
    const p = project();
    seed(p, { [NAME]: w('idle', { worked: true }) });
    const text = ctx(mon(p, 'UserPromptSubmit', kind === 'herdr' ? hEnv(p, NONE) : cEnv(p, hcl([]))));
    assert.ok(text.includes(`Read its report file (${abs(p)}) if there is one, then re-brief or drop the package.`), `${kind}: ${text}`);
    assert.equal(text.includes('(.claude/ghorc-out/'), false);
  }
  // a delivered result is not GONE, and one older than the last send is
  const q = project();
  report(q, NAME, `DONE ${NAME}`);
  seed(q, { [NAME]: w('idle') });
  assert.equal(mon(q, 'UserPromptSubmit', hEnv(q, NONE)).out, '', 'a fresh line: not GONE');
  const r = project();
  setMtime(report(r, NAME, `DONE ${NAME}`), 10);
  seed(r, { [NAME]: w('idle') }, { [NAME]: ago(5) });
  assert.match(ctx(mon(r, 'UserPromptSubmit', hEnv(r, NONE))), /tabs GONE: a1-implementer/);
});

// ---- round 3: a task send behind the wrappers the parser sees through is recorded like a plain one ----
const GOODARGS = '--model sonnet --effort medium -n a1-implementer --permission-mode bypassPermissions';
const START = (head, env = 'env GHORC_ROLE=worker', prompt = ' "do it"') => `${head} hc run --bg --name a1-implementer --cwd . ${env} claude ${GOODARGS}${prompt}`.trim();

test('wrappers: a worker start with a task is recorded and allowed behind env options, a second env, nohup and env -S', () => {
  const forms = [
    ['hc run behind plain env', START('', 'env GHORC_ROLE=worker')],
    ['env -i after the run', START('', 'env -i GHORC_ROLE=worker')],
    ['env --ignore-environment', START('', 'env --ignore-environment GHORC_ROLE=worker')],
    ['env -u NAME', START('', 'env -u FOO GHORC_ROLE=worker')],
    ['env --unset NAME', START('', 'env --unset FOO GHORC_ROLE=worker')],
    ['env --unset=NAME', START('', 'env --unset=FOO GHORC_ROLE=worker')],
    ['nohup env in front of hc', START('nohup env FOO=1')],
    ['env -u in front of hc', START('env -u BAR')],
    ['env -Shc', `env -Shc run --bg --name a1-implementer --cwd . env GHORC_ROLE=worker claude ${GOODARGS} "do it"`],
  ];
  for (const [label, command] of forms) {
    const p = project();
    const r = pre(p, command, cEnv(p, hcl([])));
    assert.equal(r.out.trim(), '', `${label}: not allowed: ${r.out}`);
    assert.deepEqual(Object.keys(taskedOf(p)), [NAME], label);
  }
  // a quoted env -S string is denied by the start checks (a rule of the env-wrapper work, since round 3): it records nothing
  {
    const p = project();
    const r = pre(p, `env -S "hc run --bg --name a1-implementer --cwd . env GHORC_ROLE=worker claude ${GOODARGS}"`, cEnv(p, hcl([])));
    assert.ok(r.out.includes('deny'), r.out);
    assert.deepEqual(taskedOf(p), {});
  }
  // the same starts without a task record nothing
  for (const command of [START('', 'env -i GHORC_ROLE=worker', ''), START('nohup env FOO=1', 'env GHORC_ROLE=worker', ''), `env -Shc run --bg --name a1-implementer --cwd . env GHORC_ROLE=worker claude ${GOODARGS}`]) {
    const p = project();
    assert.equal(pre(p, command, cEnv(p, hcl([]))).out.trim(), '', command);
    assert.deepEqual(taskedOf(p), {}, command);
  }
});

test('wrappers: a send behind env options, nohup and env -S is recorded; a denied command records nothing', () => {
  const hcSends = ['nohup env FOO=1 hc send a1-implementer "go on"', 'env -i hc send a1-implementer "go on"', 'env -u FOO hc send a1-implementer "go on"', 'env -Shc send a1-implementer "go on"'];
  for (const command of hcSends) {
    const p = project();
    assert.equal(pre(p, command, cEnv(p, hcl([]))).out.trim(), '', command);
    assert.deepEqual(Object.keys(taskedOf(p)), [NAME], command);
  }
  for (const command of ['nohup env -i hc send a1-implementer "/exit"', 'env -Shc send a1-implementer "/clear"']) {
    const p = project();
    assert.equal(pre(p, command, cEnv(p, hcl([]))).out.trim(), '', command);
    assert.deepEqual(taskedOf(p), {}, `a session command behind a wrapper: ${command}`);
  }
  const heads = ['env -i', 'env -u FOO', 'nohup env FOO=1', 'timeout 20'];
  for (const head of heads) {
    const q = project();
    const hl = hEnv(q, hdr([agent(NAME, 'idle', q.cwd, { pane_id: 'w4:p7' })]), { HERDR_WORKSPACE_ID: 'w4' });
    assert.equal(pre(q, `${head} herdr pane run w4:p7 "Read /x/brief.md and follow it."`, hl).out.trim(), '', head);
    pre(q, `${head} herdr agent prompt ${NAME} "Read /x/brief.md and follow it."`, hl);
    assert.deepEqual(Object.keys(taskedOf(q)), [NAME], head);
  }
  // a start the checks deny records nothing, wrapper or not
  for (const command of [START('', 'env -i GHORC_ROLE=worker').replace('--model sonnet', '--model gpt'), `env -Shc run --bg --name a1-implementer --cwd . env GHORC_ROLE=worker claude --effort medium "do it"`, START('', 'env -S x GHORC_ROLE=worker')]) {
    const p = project();
    assert.ok(pre(p, command, cEnv(p, hcl([]))).out.includes('deny'), command);
    assert.deepEqual(taskedOf(p), {}, command);
  }
});

// ---- round 4: freshness bound = the last recorded send; prompt detection; own inventory only; grace ends at a working sighting; stale-line texts ----
const clk = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const setAt = (f, ms) => fs.utimesSync(f, new Date(ms), new Date(ms));

test('N1: a report written after the send but before the guard first saw the tab is fresh: FINISHED, never NORESULT', () => {
  const run = (reportAfterMs, firstHookAfterMs) => {
    const p = project();
    const T = Date.now();
    const gone = cEnv(p, hcl([]), mockEnv(T));
    assert.equal(pre(p, START('', 'env GHORC_ROLE=worker', ' "Read /x/brief.md"'), gone).out.trim(), '');
    assert.equal(taskedOf(p)[NAME], T);
    setAt(report(p, NAME, `DONE ${NAME}`), T + reportAfterMs);
    const list = hcl([term(NAME, 'idle', { cwd: p.cwd })]);
    const e = (ms) => cEnv(p, list, mockEnv(ms));
    return { p, T, e, first: mon(p, firstHookAfterMs.event, e(T + firstHookAfterMs.at)) };
  };
  // the quoted sequence: DONE at +200 s, first hook run is Stop at +300 s
  const a = run(200000, { event: 'Stop', at: 300000 });
  assert.ok(blocks(a.first), 'Stop at +300 s blocks with FINISHED');
  assert.match(JSON.parse(a.first.out).reason, /tabs FINISHED: a1-implementer wrote "DONE a1-implementer"/);
  const t400 = ctx(mon(a.p, 'UserPromptSubmit', a.e(a.T + 400000)));
  assert.equal(/NORESULT|RESULT\?/.test(t400), false, t400);
  assert.match(t400, /tabs FINISHED: a1-implementer/);
  assert.equal(blocks(mon(a.p, 'Stop', a.e(a.T + 410000))), false, 'FINISHED already blocked once');
  // the grace variant: DONE at +20 s, first sighting at +30 s (was RESULT?), then +90 s (was NORESULT)
  const b = run(20000, { event: 'UserPromptSubmit', at: 30000 });
  const t30 = ctx(b.first);
  assert.equal(/NORESULT|RESULT\?/.test(t30), false, t30);
  assert.match(t30, /tabs FINISHED: a1-implementer/);
  const t90 = ctx(mon(b.p, 'UserPromptSubmit', b.e(b.T + 90000)));
  assert.equal(t90.includes('NORESULT'), false, t90);
  // a line written before the send is still the previous task's
  const c = project();
  const T = Date.now();
  setAt(report(c, NAME, `DONE ${NAME}`), T - 5000);
  assert.equal(pre(c, START('', 'env GHORC_ROLE=worker', ' "Read /x/brief.md"'), cEnv(c, hcl([]), mockEnv(T))).out.trim(), '');
  const stale = ctx(mon(c, 'UserPromptSubmit', cEnv(c, hcl([term(NAME, 'idle', { cwd: c.cwd })]), mockEnv(T + 120000))));
  assert.match(stale, /tabs NORESULT: a1-implementer is idle and has no fresh result line \(its report still ends with a result line from /);
  assert.equal(stale.includes('RESULT?'), false);
});

test('N1: RESULT? stays for a first sighting with a result line and no recorded send', () => {
  const p = project();
  report(p, NAME, `DONE ${NAME}`);
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'idle', p.cwd)]))));
  assert.match(text, /tabs RESULT\?: a1-implementer has a result line from \d\d:\d\d/);
  assert.equal(/NORESULT|FINISHED/.test(text), false, text);
});

test('N2: a start without a prompt records nothing when a claude argument is quoted; a start with a prompt records', () => {
  const NOTASK = [
    ' --allowedTools "Bash(git:*)"',
    ' --append-system-prompt "be terse"',
    ' --append-system-prompt "be terse" --system-prompt "x"',
    ' --allowedTools "Bash(git:*)" "Read"', // a quoted word after a variadic option: cannot tell
    ' --some-new-option "x"', // an option this code does not know: cannot tell
    ' --allowedTools "Bash(git:*)" --verbose',
  ];
  for (const tail of NOTASK) {
    const p = project();
    const r = pre(p, `hc run --bg --name a1-implementer --cwd . env GHORC_ROLE=worker claude ${GOODARGS}${tail}`, cEnv(p, hcl([])));
    assert.equal(r.out.includes('deny'), false, `${tail}: ${r.out}`);
    assert.deepEqual(taskedOf(p), {}, tail);
  }
  // the quoted option value is no task: the idle tab never gets NORESULT
  const q = project();
  const T = Date.now();
  assert.equal(pre(q, `hc run --bg --name a1-implementer --cwd . env GHORC_ROLE=worker claude ${GOODARGS} --allowedTools "Bash(git:*)"`, cEnv(q, hcl([]), mockEnv(T))).out.trim(), '');
  const list = hcl([term(NAME, 'idle', { cwd: q.cwd })]);
  assert.equal(ctx(mon(q, 'UserPromptSubmit', cEnv(q, list, mockEnv(T + 120000)))).includes('NORESULT'), false);
  assert.equal(blocks(mon(q, 'Stop', cEnv(q, list, mockEnv(T + 130000)))), false);
  // a prompt records: after the permission arguments, after a quoted option value, after a flag, after --
  for (const tail of [' "Read /x/brief.md"', ' --append-system-prompt "be terse" "Read /x/brief.md"', ' --verbose "Read /x/brief.md"', ' --allowedTools "Bash(git:*)" -- "Read /x/brief.md"']) {
    const p = project();
    const r = pre(p, `hc run --bg --name a1-implementer --cwd . env GHORC_ROLE=worker claude ${GOODARGS}${tail}`, cEnv(p, hcl([])));
    assert.equal(r.out.trim(), '', `${tail}: ${r.out}`);
    assert.deepEqual(Object.keys(taskedOf(p)), [NAME], tail);
  }
});

test('N3: a herdr send to a pane of another workspace or project records nothing, even when its agent has the same name', () => {
  const p = project();
  const other = fs.mkdtempSync(path.join(TEST_TMP, 'other-'));
  const own = agent(NAME, 'idle', p.cwd, { pane_id: 'w4:p1' });
  const list = hdr([own, agent(NAME, 'idle', p.cwd, { pane_id: 'w9:p1', agent_session: { value: 's-other' } })]);
  const env = hEnv(p, list, { HERDR_WORKSPACE_ID: 'w4' });
  pre(p, 'herdr pane run w9:p1 "Read /x/brief.md and follow it."', env);
  assert.deepEqual(taskedOf(p), {}, 'pane of workspace w9');
  pre(p, 'herdr agent prompt w9:p1 "Read /x/brief.md and follow it."', env);
  assert.deepEqual(taskedOf(p), {}, 'agent prompt to the pane of workspace w9');
  // the same name in a pane of this workspace but another project
  const env2 = hEnv(p, hdr([agent(NAME, 'idle', other, { pane_id: 'w4:p3' })]), { HERDR_WORKSPACE_ID: 'w4' });
  pre(p, 'herdr pane run w4:p3 "Read /x/brief.md and follow it."', env2);
  assert.deepEqual(taskedOf(p), {}, 'pane of another project');
  // the lead's own pane records
  pre(p, 'herdr pane run w4:p1 "Read /x/brief.md and follow it."', env);
  assert.deepEqual(Object.keys(taskedOf(p)), [NAME]);
  // taskNames on its own: own inventory by pane id and by name
  const ctxOf = (ws) => ({ root: p.cwd, self: '', leadPrefix: 'lead-', workspace: () => ws });
  const entries = [{ name: NAME, status: 'idle', pane: 'w9:p1', cwd: p.cwd, workspace: 'w9' }];
  assert.deepEqual(tabs.taskNames('herdr pane run w9:p1 "go"', false, () => entries, ctxOf('w4')), []);
  assert.deepEqual(tabs.taskNames('herdr agent prompt a1-implementer "go"', false, () => entries, ctxOf('w4')), [], 'a name listed only in another workspace');
  assert.deepEqual(tabs.taskNames('herdr agent prompt a1-implementer "go"', false, () => entries, ctxOf('w9')), [NAME]);
  assert.deepEqual(tabs.taskNames('herdr agent prompt b1-implementer "go"', false, () => entries, ctxOf('w4')), ['b1-implementer'], 'a name not listed at all: a tab that has not shown up yet');
});

test('N4: the grace period ends once the guard has seen the worker working after the send', () => {
  const p = project();
  const list = (status) => hdr([agent(NAME, status, p.cwd, { pane_id: 'w4:p7' })]);
  const env = (status, extra = {}) => hEnv(p, list(status), { HERDR_WORKSPACE_ID: 'w4', ...extra });
  const T = Date.now();
  assert.equal(pre(p, 'herdr pane run w4:p7 "Read /x/brief.md and follow it."', env('idle', mockEnv(T))).out.trim(), '');
  assert.equal(taskedOf(p)[NAME], T);
  assert.equal(ctx(mon(p, 'UserPromptSubmit', env('working', mockEnv(T + 10000)))), 'tabs: 1 live (a1-implementer working 0m)');
  assert.equal(readState(p).workers[NAME].wAt, T + 10000);
  assert.ok(blocks(mon(p, 'Stop', env('idle', mockEnv(T + 30000)))), 'idle at +30 s after it worked: NORESULT blocks Stop');
  // control: never seen working, the same moment is still inside the grace period
  const q = project();
  const e2 = hEnv(q, hdr([agent(NAME, 'idle', q.cwd, { pane_id: 'w4:p7' })]), { HERDR_WORKSPACE_ID: 'w4' });
  assert.equal(pre(q, 'herdr pane run w4:p7 "Read /x/brief.md and follow it."', { ...e2, ...mockEnv(T) }).out.trim(), '');
  assert.equal(blocks(mon(q, 'Stop', { ...e2, ...mockEnv(T + 30000) })), false);
  // a second send starts a new grace period: a sighting before it does not end it
  const r = project();
  const e3 = (status, ms) => hEnv(r, hdr([agent(NAME, status, r.cwd, { pane_id: 'w4:p7' })]), { HERDR_WORKSPACE_ID: 'w4', ...mockEnv(ms) });
  mon(r, 'UserPromptSubmit', e3('working', T));
  pre(r, 'herdr pane run w4:p7 "second task"', e3('idle', T + 100000));
  assert.equal(blocks(mon(r, 'Stop', e3('idle', T + 120000))), false, 'new send at +100 s, idle at +120 s: grace again');
  assert.ok(blocks(mon(r, 'Stop', e3('idle', T + 170000))));
});

test('N5: NORESULT and STALLED name the stale result line, its time and the send (or first sighting) it predates', () => {
  const p = project({ idleMin: 10 });
  const sent = ago(20);
  const f = report(p, NAME, `DONE ${NAME}`, { old: true });
  const lineAt = fs.statSync(f).mtimeMs;
  seed(p, { [NAME]: w('idle', { first: 30, since: 12 }) }, { [NAME]: sent });
  const text = ctx(mon(p, 'UserPromptSubmit', hEnv(p, hdr([agent(NAME, 'idle', p.cwd)]))));
  const line = text.split('\n').find((l) => l.startsWith('tabs NORESULT:'));
  assert.ok(line.includes(`${NAME} is idle and has no fresh result line (its report still ends with a result line from ${clk(lineAt)}, written before the task sent at ${clk(sent)}), so its package is NOT delivered.`), line);
  // no stale line: the text has no parenthesis
  const q = project();
  seed(q, { [NAME]: w('idle') }, { [NAME]: ago(8) });
  const plain = ctx(mon(q, 'UserPromptSubmit', hEnv(q, hdr([agent(NAME, 'idle', q.cwd)])))).split('\n').find((l) => l.startsWith('tabs NORESULT:'));
  assert.ok(plain.includes(`${NAME} is idle and has no fresh result line, so its package is NOT delivered.`), plain);
  // STALLED of an untasked worker: first sighting is the bound
  const r = project({ idleMin: 10 });
  const first = ago(30);
  const g = report(r, NAME, `DONE ${NAME}`, { old: true });
  seed(r, { [NAME]: { firstSeen: first, status: 'idle', statusSince: ago(12), notified: false } });
  const stalled = ctx(mon(r, 'UserPromptSubmit', hEnv(r, hdr([agent(NAME, 'idle', r.cwd)])))).split('\n').find((l) => l.startsWith('tabs STALLED:'));
  assert.ok(stalled.includes(`${NAME} has been idle 12m without a fresh result line (its report still ends with a result line from ${clk(fs.statSync(g).mtimeMs)}, written before this tab was first seen at ${clk(first)}). Read its screen`), stalled);
});
