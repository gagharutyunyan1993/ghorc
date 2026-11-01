'use strict';
// Capacity guard: Stop (idle lead), UserPromptSubmit line, SubagentStart/Stop ledger, herdr workers, weekly cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpProject, sid } = require('./helpers.cjs');
const cap = require('../scripts/lib/capacity.cjs');
const validate = require('../scripts/lib/validate.cjs');

const NO_WORKERS = JSON.stringify({ result: { agents: [] } });
const base = (extra = {}) => ({ enabled: true, ...extra });

// A project with the capacity config; the environment fixes CPU, RAM, herdr and the ledger so nothing depends on the machine.
function setup(capacity, { cpu = '20', free = '16', herdr = NO_WORKERS } = {}) {
  const cwd = tmpProject(capacity === undefined ? {} : { capacity });
  const s = sid();
  const ledger = path.join(cwd, 'ledger.jsonl');
  const env = { GHORC_CAPACITY_CPU_PCT: cpu, GHORC_CAPACITY_FREE_GB: free, GHORC_CAPACITY_HERDR_JSON: herdr, GHORC_CAPACITY_LEDGER: ledger };
  return { cwd, s, ledger, env, log: path.join(cwd, '.claude', 'ghorc-out', 'capacity-guard.log') };
}
const ev = (p, event, extra = {}) => ({ hook_event_name: event, session_id: p.s, cwd: p.cwd, ...extra });
// a real assistant message by default: a Stop without text is the fail-open case and is tested on its own
const stop = (p, extra = {}, env = {}) =>
  runScript('capacity-guard.cjs', ev(p, 'Stop', { last_assistant_message: 'Waiting.', ...extra }), { env: { ...p.env, ...env } });
const prompt = (p, extra = {}, env = {}) => runScript('capacity-guard.cjs', ev(p, 'UserPromptSubmit', extra), { env: { ...p.env, ...env } });
const sub = (p, event, agent) => runScript('capacity-guard.cjs', ev(p, event, { agent_id: agent }), { env: p.env });
const blocks = (r) => r.out.trim() !== '' && JSON.parse(r.out).decision === 'block';
const reason = (r) => JSON.parse(r.out).reason;
const line = (r) => JSON.parse(r.out).hookSpecificOutput.additionalContext;
const tasks = (...st) => st.map((status, i) => ({ id: `t${i}`, type: 'subagent', status }));
const readLog = (p) => (fs.existsSync(p.log) ? fs.readFileSync(p.log, 'utf8') : '');

function writeCtx(p, sessionId, week, ageMin = 0) {
  const file = path.join(p.cwd, '.claude', `ctx-${sessionId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const j = { session_id: sessionId, ts: Date.now() - ageMin * 60000 };
  if (week) j.rate_limits = { seven_day: week };
  fs.writeFileSync(file, JSON.stringify(j));
  const t = new Date(Date.now() - ageMin * 60000);
  fs.utimesSync(file, t, t);
}
const nowS = () => Math.floor(Date.now() / 1000);
const HALF_WEEK_LEFT = () => nowS() + 302400; // f = 0.5

test('disabled by default: no output in any event', () => {
  for (const capacity of [undefined, { enabled: false }]) {
    const p = setup(capacity);
    assert.equal(stop(p).out, '');
    assert.equal(prompt(p).out, '');
    assert.equal(sub(p, 'SubagentStart', 'a1').out, '');
    assert.equal(fs.existsSync(p.ledger), false);
  }
});

test('Stop blocks an idle lead once the conditions hold', () => {
  const p = setup(base());
  const r = stop(p, { last_assistant_message: 'Waiting.' });
  assert.equal(r.code, 0);
  assert.ok(blocks(r));
  assert.match(reason(r), /agents 0 of 3, CPU 20%, free 16\.0 GB/);
  assert.match(reason(r), /"Idle: <reason>"/);
});

test('a valid idle line lets the turn end, in the default and in any configured marker', () => {
  const p = setup(base());
  for (const msg of [
    'Idle: CPU busy with a foreign process',
    'Done.\n- Idle: waiting for the review',
    '**Idle:** nothing to schedule',
    '1. idle: owner question answered',
    '> `Idle: WIP 4 of 4`',
    '**Idle**: real reason here',
    '- **Idle** : real reason here',
    '__Idle__: another reason',
  ]) {
    assert.equal(stop(p, { last_assistant_message: msg }).out, '', msg);
  }
  const q = setup(base({ idleMarker: 'Standby:' }));
  assert.equal(stop(q, { last_assistant_message: 'Standby: nothing can move now' }).out, '');
  assert.ok(blocks(stop(q, { last_assistant_message: 'Idle: nothing can move now' })), 'the old marker no longer counts');
  assert.match(reason(stop(q)), /"Standby: <reason>"/);
});

test('the placeholder, a repeated letter and a short reason do not count', () => {
  const p = setup(base());
  for (const msg of ['Idle: <reason>', 'Idle: aa aa', 'Idle: ab1', 'Idle:', 'Not idle: because', 'text Idle: reason in the middle']) {
    assert.ok(blocks(stop(p, { last_assistant_message: msg })), msg);
  }
});

test('stop_hook_active, a subagent and a worker session are skipped', () => {
  const p = setup(base());
  assert.equal(stop(p, { stop_hook_active: true }).out, '');
  assert.equal(stop(p, { agent_id: 'a1' }).out, '');
  assert.equal(stop(p, {}, { GHORC_ROLE: 'worker' }).out, '');
  assert.equal(prompt(p, {}, { GHORC_ROLE: 'worker' }).out, '');
  assert.ok(blocks(stop(p)), 'the lead is still blocked');
});

test('CPU and RAM gates', () => {
  const p = setup(base());
  assert.ok(blocks(stop(p, {}, { GHORC_CAPACITY_CPU_PCT: '59.9' })));
  assert.equal(stop(p, {}, { GHORC_CAPACITY_CPU_PCT: '60' }).out, '');
  assert.equal(stop(p, {}, { GHORC_CAPACITY_CPU_PCT: '95' }).out, '');
  assert.ok(blocks(stop(p, {}, { GHORC_CAPACITY_FREE_GB: '4' })));
  assert.equal(stop(p, {}, { GHORC_CAPACITY_FREE_GB: '3.9' }).out, '');
  const q = setup(base({ cpuStartPct: 90, minFreeRamGb: 8 }), { cpu: '85', free: '7' });
  assert.equal(stop(q).out, '', 'configured RAM gate');
  assert.ok(blocks(stop(q, {}, { GHORC_CAPACITY_FREE_GB: '8' })), 'configured CPU gate');
  assert.equal(stop(q, {}, { GHORC_CAPACITY_FREE_GB: '8', GHORC_CAPACITY_CPU_PCT: '90' }).out, '');
});

test('agents come from background_tasks: only in-flight subagents and teammates', () => {
  const p = setup(base());
  assert.equal(stop(p, { background_tasks: tasks('running', 'running', 'pending') }).out, '');
  assert.ok(blocks(stop(p, { background_tasks: tasks('running', 'completed', 'failed', 'killed') })));
  const mixed = [...tasks('running'), { id: 'x', type: 'teammate', status: 'running' }, { id: 'y', type: 'shell', status: 'running' }];
  assert.ok(blocks(stop(p, { background_tasks: mixed })), '1 subagent + 1 teammate = 2 of 3, the shell is not counted');
  assert.equal(stop(p, { background_tasks: [...mixed, { id: 'z', type: 'subagent', status: 'paused' }] }).out, '');
  assert.ok(blocks(stop(p, { background_tasks: [] })));
  stop(p, { background_tasks: [{ id: 'q', type: 'subagent', status: 'weird' }] });
  assert.match(readLog(p), /unknown task status "weird"/);
});

test('ledger fallback: SubagentStart/Stop events count when background_tasks is absent', () => {
  const p = setup(base());
  for (const a of ['a1', 'a2', 'a3']) assert.equal(sub(p, 'SubagentStart', a).out, '');
  assert.equal(stop(p).out, '', '3 of 3');
  sub(p, 'SubagentStop', 'a2');
  assert.ok(blocks(stop(p)), '2 of 3');
  assert.equal(sub(p, 'SubagentStart', null).code, 0); // no agent_id: nothing written
  const lines = fs.readFileSync(p.ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => `${l.e}:${l.a}`), ['start:a1', 'start:a2', 'start:a3', 'stop:a2']);
  // an empty background_tasks wins over the ledger and clears this session's entries
  assert.ok(blocks(stop(p, { background_tasks: [] })));
  assert.ok(blocks(stop(p)), 'after the clear the ledger count is 0');
  assert.equal(JSON.parse(fs.readFileSync(p.ledger, 'utf8').trim().split('\n').pop()).e, 'clear');
});

test('ledger: entries older than 3 hours are stale; other sessions are not counted', () => {
  const p = setup(base());
  const old = Date.now() - 3 * 3600 * 1000 - 1000;
  const rows = [
    { e: 'start', s: p.s, a: 'old1', ts: old },
    { e: 'start', s: p.s, a: 'old2', ts: old },
    { e: 'start', s: p.s, a: 'old3', ts: old },
    { e: 'start', s: 'other-session', a: 'x1', ts: Date.now() },
    { e: 'start', s: 'other-session', a: 'x2', ts: Date.now() },
    { e: 'start', s: 'other-session', a: 'x3', ts: Date.now() },
  ];
  fs.writeFileSync(p.ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.ok(blocks(stop(p)));
  assert.equal(cap.readLedger(p.ledger).length, 3, 'the fold drops the stale ones');
});

test('ledger: a busy compaction lock never fails the event', () => {
  const p = setup(base());
  fs.writeFileSync(p.ledger, 'x'.repeat(300 * 1024) + '\n');
  fs.writeFileSync(`${p.ledger}.lock`, 'held');
  const r = sub(p, 'SubagentStart', 'a1');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.match(fs.readFileSync(p.ledger, 'utf8'), /"a":"a1"/);
  assert.match(readLog(p), /ledger lock busy/);
});

test('herdr workers: working and blocked count, own session and lead-* do not', () => {
  const list = (agents) => JSON.stringify({ result: { agents } });
  const w = (name, status, session = 'someone-else') => ({ name, agent_status: status, agent_session: { value: session } });
  const p0 = setup(base());
  const herdr = list([w('w1', 'working'), w('w2', 'blocked'), w('w3', 'idle'), w('lead-h1', 'working'), w('Lead-X', 'working'), w('mine', 'working', p0.s)]);
  const p = setup(base(), { herdr });
  p.s = p0.s;
  assert.ok(blocks(stop(p)), '2 workers of 3');
  assert.match(reason(stop(p)), /agents 2 \(herdr workers 2\) of 3/);
  const three = list([w('w1', 'working'), w('w2', 'blocked'), w('w3', 'working')]);
  assert.equal(stop(p, {}, { GHORC_CAPACITY_HERDR_JSON: three }).out, '');
  // a worker plus tasks add up
  assert.equal(stop(p, { background_tasks: tasks('running') }).out, '', '2 workers + 1 task');
  const q = setup(base({ leadNamePrefix: 'boss-' }), { herdr: list([w('lead-1', 'working'), w('lead-2', 'working'), w('boss-1', 'working')]) });
  assert.match(reason(stop(q)), /agents 2 \(herdr workers 2\) of 3/, 'lead-* counts when the prefix is boss-; boss-1 does not');
  assert.match(line(prompt(q)), /^agents 2 \(herdr workers 2\)\/3,/);
});

test('herdr failure: the count is unknown, the hook stays silent and logs', () => {
  for (const herdr of ['', 'not json', '{"result":{}}', '[]']) {
    const p = setup(base(), { herdr });
    assert.equal(stop(p).out, '', `[${herdr}]`);
    assert.match(readLog(p), /herdr agent list/);
    const r = prompt(p);
    assert.match(line(r), /^agents \?\/3, CPU 20%, free 16\.0 GB/);
  }
});

test('UserPromptSubmit adds the load line for the lead only', () => {
  const p = setup(base());
  sub(p, 'SubagentStart', 'a1');
  const r = prompt(p);
  assert.equal(JSON.parse(r.out).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(line(r), 'agents 1/3, CPU 20%, free 16.0 GB.');
  assert.equal(prompt(p, { agent_id: 'a9' }).out, '');
});

test('weekly cap: used >= cap demands no agents and says so', () => {
  const p = setup(base({ weeklyCapPct: 65, agentsOverPace: 2 }));
  writeCtx(p, p.s, { used_percentage: 70, resets_at: HALF_WEEK_LEFT() });
  assert.equal(stop(p).out, '', 'Stop does not demand agents');
  assert.match(line(prompt(p)), /WEEKLY CAP: no new agents \(used 70% >= 65%\)\.? ?/);
  assert.doesNotMatch(line(prompt(p)), /stale/);
  writeCtx(p, p.s, { used_percentage: 64.9, resets_at: HALF_WEEK_LEFT() });
  assert.doesNotMatch(line(prompt(p)), /WEEKLY CAP/);
  // without weeklyCapPct the rule is off, however high the usage is
  const q = setup(base());
  writeCtx(q, q.s, { used_percentage: 99, resets_at: HALF_WEEK_LEFT() });
  assert.ok(blocks(stop(q)));
  assert.equal(line(prompt(q)), 'agents 0/3, CPU 20%, free 16.0 GB.');
});

test('weekly pace: used > cap*f limits the agents to agentsOverPace', () => {
  const p = setup(base({ weeklyCapPct: 65, agentsOverPace: 2 }));
  writeCtx(p, p.s, { used_percentage: 40, resets_at: HALF_WEEK_LEFT() }); // plan 32.5
  assert.equal(stop(p, { background_tasks: tasks('running', 'running') }).out, '', '2 of 2');
  const r = stop(p, { background_tasks: tasks('running') });
  assert.ok(blocks(r), '1 of 2');
  assert.match(reason(r), /of 2, /);
  assert.match(reason(r), /Weekly pace: used 40% > plan 32\.[45]%/);
  assert.match(line(prompt(p)), /Weekly pace: used 40% > plan 32\.[45]% \(cap 65%\); at most 2 agents\./);
  // on or under the plan: the plain rules (3 agents)
  writeCtx(p, p.s, { used_percentage: 30, resets_at: HALF_WEEK_LEFT() });
  assert.ok(blocks(stop(p, { background_tasks: tasks('running', 'running') })), '2 of 3');
  assert.doesNotMatch(line(prompt(p)), /pace/);
  // agentsOverPace 0: the pace rule is off
  const q = setup(base({ weeklyCapPct: 65 }));
  writeCtx(q, q.s, { used_percentage: 40, resets_at: HALF_WEEK_LEFT() });
  assert.ok(blocks(stop(q, { background_tasks: tasks('running', 'running') })));
});

test('weekly cap: stale data is marked, another session file fills in, no data is said aloud', () => {
  const p = setup(base({ weeklyCapPct: 65 }));
  writeCtx(p, p.s, { used_percentage: 80, resets_at: nowS() - 100 }); // the window has reset
  assert.match(line(prompt(p)), /WEEKLY CAP: no new agents \(used 80% >= 65%\) \(stale\)/);
  assert.equal(stop(p).out, '');
  // own file without rate_limits (new session): the newest other file is used and marked stale
  const q = setup(base({ weeklyCapPct: 65 }));
  writeCtx(q, q.s, null);
  writeCtx(q, 'older-session', { used_percentage: 70, resets_at: HALF_WEEK_LEFT() }, 5);
  assert.match(line(prompt(q)), /WEEKLY CAP: .*\(stale\)/);
  assert.equal(stop(q).out, '');
  // resets_at missing: the cap applies, marked stale
  const m = setup(base({ weeklyCapPct: 65 }));
  writeCtx(m, m.s, { used_percentage: 66 });
  assert.match(line(prompt(m)), /WEEKLY CAP: .*\(stale\)/);
  // no data at all: the plain rules, a line in the prompt and in the log
  const n = setup(base({ weeklyCapPct: 65 }));
  assert.ok(blocks(stop(n)));
  assert.match(line(prompt(n)), /Week: no rate_limits in any ctx file/);
  assert.match(readLog(n), /weekly cap: no rate_limits/);
});

test('weekState: seconds vs milliseconds and the clamp of f', () => {
  const s = cap.settings({ capacity: { weeklyCapPct: 60, agentsOverPace: 3 } });
  const now = 1_800_000_000_000; // ms
  const nowSec = now / 1000;
  const at = (resetsAt, used = 30) => cap.weekState({ used, resetsAt }, s, now);
  assert.equal(at(nowSec + 302400).f, 0.5, 'resets_at in seconds, now in milliseconds');
  assert.equal(at(nowSec + 302400).plan, 30);
  assert.equal(at(nowSec + 302400, 30).overPace, false, 'used == plan is not over the pace');
  assert.equal(at(nowSec + 302400, 30.1).overPace, true);
  assert.equal(at(nowSec + cap.WEEK_S * 3).f, 0, 'a window start in the future clamps to 0');
  assert.equal(at(nowSec + cap.WEEK_S * 3).overPace, true, 'plan 0: any use is over the pace');
  assert.equal(at(nowSec + cap.WEEK_S).f, 0);
  assert.equal(at(nowSec - 10).f, 1, 'a past window end clamps to 1');
  assert.equal(at(nowSec - 10).stale, true);
  assert.equal(at(nowSec + 100).stale, false);
  assert.equal(at(null).f, 1);
  assert.equal(at(null).stale, true);
  assert.equal(cap.weekState(null, s, now), null);
  assert.equal(cap.weekState({ used: 'x' }, s, now), null);
});

test('idleReasonGiven', () => {
  const g = cap.idleReasonGiven;
  assert.equal(g('Idle: a real reason'), true);
  assert.equal(g('Idle: 100% CPU of another process'), true);
  assert.equal(g('Idle: <reason>'), false);
  assert.equal(g('Idle: <Reason>'), false);
  assert.equal(g('Idle: aaaa'), false);
  assert.equal(g('Idle: !!! ???'), false);
  assert.equal(g('Idle: abab'), true);
  assert.equal(g('Idle: <reason>\nIdle: second line is real'), true);
  assert.equal(g(undefined), false);
  assert.equal(g('Pause: wait for CI', 'Pause:'), true);
  assert.equal(g('Idle: wait for CI', 'Pause:'), false);
  assert.equal(g('Wait (a+b): the reason is long', 'Wait (a+b):'), true, 'regex characters in the marker are literal');
});

test('measureCpu: the sampling stays inside 1.5 s whatever GHORC_CAPACITY_SAMPLE_MS says', () => {
  const waits = [];
  let tick = 0;
  const cpus = () => [{ times: { user: tick * 10, sys: 0, idle: tick * 90, nice: 0, irq: 0 } }];
  const wait = (ms) => {
    waits.push(ms);
    tick++;
  };
  const keep = process.env.GHORC_CAPACITY_SAMPLE_MS;
  const keepCpu = process.env.GHORC_CAPACITY_CPU_PCT;
  delete process.env.GHORC_CAPACITY_CPU_PCT;
  try {
    process.env.GHORC_CAPACITY_SAMPLE_MS = '5000';
    const v = cap.measureCpu({ samples: 3, cpus, wait });
    assert.ok(Math.abs(v - 10) < 1e-9, `got ${v}`);
    assert.deepEqual(waits, [500, 500, 500]);
    waits.length = 0;
    delete process.env.GHORC_CAPACITY_SAMPLE_MS;
    cap.measureCpu({ samples: 3, cpus, wait });
    assert.deepEqual(waits, [400, 400, 400]);
    assert.equal(cap.measureCpu({ cpus: () => [], wait }), null);
    assert.equal(cap.measureCpu({ cpus: () => { throw new Error('x'); }, wait }), null);
  } finally {
    if (keep === undefined) delete process.env.GHORC_CAPACITY_SAMPLE_MS;
    else process.env.GHORC_CAPACITY_SAMPLE_MS = keep;
    if (keepCpu !== undefined) process.env.GHORC_CAPACITY_CPU_PCT = keepCpu;
  }
});

test('Stop with real CPU sampling adds about 1.5 s at most', () => {
  const p = setup(base(), { free: '16' });
  const env = { ...p.env, GHORC_CAPACITY_CPU_PCT: '', GHORC_CAPACITY_SAMPLE_MS: '5000' };
  const t0 = Date.now();
  const r = runScript('capacity-guard.cjs', ev(p, 'Stop', { last_assistant_message: 'Waiting.' }), { env });
  const ms = Date.now() - t0;
  assert.equal(r.code, 0);
  assert.ok(ms >= 1400, `the three samples really ran (${ms} ms)`);
  assert.ok(ms < 4500, `${ms} ms`);
});

test('a malformed input fails open', () => {
  const p = setup(base());
  for (const raw of ['not json', '', '[]', '42', 'null', '{"hook_event_name":"Stop"}', '{"hook_event_name":"Stop","cwd":123,"background_tasks":"x"}']) {
    const r = runScript('capacity-guard.cjs', raw, { env: p.env, cwd: p.cwd });
    assert.equal(r.code, 0, raw);
    assert.equal(r.out, '', raw);
  }
  // no usable text (absent, null, a number, an object): the CLI sends undefined when the answer has no text blocks
  for (const m of [undefined, null, 5, {}, []]) {
    const extra = m === undefined ? {} : { last_assistant_message: m };
    const r = runScript('capacity-guard.cjs', { ...ev(p, 'Stop', extra) }, { env: p.env });
    assert.equal(r.code, 0);
    assert.equal(r.out, '', JSON.stringify(m));
  }
  const r = runScript('capacity-guard.cjs', { hook_event_name: 'Stop', cwd: p.cwd, session_id: p.s, background_tasks: 'x', last_assistant_message: 5 }, { env: p.env });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(runScript('capacity-guard.cjs', { hook_event_name: 'PreToolUse', cwd: p.cwd }, { env: p.env }).out, '');
});

test('a broken config value falls back to the default, an unreadable ledger path is logged', () => {
  const p = setup(base({ agents: 'many', cpuStartPct: null, idleMarker: 7 }));
  assert.ok(blocks(stop(p)), 'defaults: 3 agents, 60%, Idle:');
  const q = setup(base());
  q.env.GHORC_CAPACITY_LEDGER = q.cwd; // a directory: the append fails
  const r = sub(q, 'SubagentStart', 'a1');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.match(readLog(q), /error:/);
});

test('config validation knows the capacity section', () => {
  const ok = tmpProject({ capacity: { enabled: true, agents: 5, weeklyCapPct: 65, idleMarker: 'Idle:' } });
  assert.deepEqual(validate.checkFile(path.join(ok, '.claude', 'ghorc.json')).fatal, []);
  const bad = tmpProject({ capacity: { agents: 'many', nope: 1 } });
  const r = validate.checkFile(path.join(bad, '.claude', 'ghorc.json'));
  assert.ok(r.fatal.some((x) => /capacity\.agents: expected number/.test(x)), r.fatal.join(';'));
  assert.ok(r.problems.some((x) => /unknown key: capacity\.nope/.test(x)));
});

test('hooks.json registers the capacity guard for the four events', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const event of ['Stop', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop']) {
    const cmds = hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.some((c) => c.includes('capacity-guard.cjs')), event);
  }
});

// ---- stray status line temp files ----
const cpx = require('node:child_process');
const osx = require('node:os');

test('statusline: a failing rename (directory at the target path) leaves no tmp file and still prints the line', () => {
  const proj = tmpProject();
  const s = sid();
  fs.mkdirSync(path.join(proj, '.claude', `ctx-${s}.json`), { recursive: true });
  const input = { session_id: s, cwd: proj, workspace: { project_dir: proj }, model: { display_name: 'M' } };
  const r = runScript('statusline.cjs', input, { cwd: proj, env: { NO_COLOR: '1' } });
  assert.equal(r.code, 0);
  assert.match(r.out, /^M/);
  assert.deepEqual(fs.readdirSync(path.join(proj, '.claude')).filter((f) => f.endsWith('.tmp')), []);
});

test('statusline: the normal path still writes the ctx file and no tmp file', () => {
  const proj = tmpProject();
  const s = sid();
  runScript('statusline.cjs', { session_id: s, cwd: proj, workspace: { project_dir: proj } }, { cwd: proj });
  const files = fs.readdirSync(path.join(proj, '.claude'));
  assert.ok(files.includes(`ctx-${s}.json`));
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
});

test('setup exclude: a project with only the old two lines is offered the new line and keeps the old ones', () => {
  const home = fs.mkdtempSync(path.join(osx.tmpdir(), 'ghorc-home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(osx.tmpdir(), 'ghorc-excl-')));
  try {
    const git = (...a) => cpx.spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    if (git('init', '-q').status !== 0) return; // git not available
    const exFile = path.join(repo, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exFile), { recursive: true });
    fs.writeFileSync(exFile, '.claude/ctx-*.json\n.claude/ghorc-out/\n');
    const env = { GHORC_HOME: home, CLAUDE_PROJECT_DIR: '' };
    const check = runScript('setup.cjs', '', { args: ['--check', '--cwd', repo], env });
    assert.equal(check.code, 0, check.out + check.err);
    assert.match(check.out, /ctx-\*\.tmp/);
    const ap = runScript('setup.cjs', '', { args: ['--apply', 'exclude', '--cwd', repo], env });
    assert.equal(ap.code, 0, ap.out + ap.err);
    const lines = fs.readFileSync(exFile, 'utf8').split('\n');
    for (const l of ['.claude/ctx-*.json', '.claude/ctx-*.tmp', '.claude/ghorc-out/']) assert.equal(lines.filter((x) => x === l).length, 1, l);
    const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8').split('\n');
    assert.ok(gi.includes('.claude/ctx-*.tmp'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('cleanup removes old ctx-<id>.json.<pid>.tmp leftovers and keeps fresh ones', () => {
  const proj = tmpProject();
  const dir = path.join(proj, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const oldT = path.join(dir, 'ctx-abc.json.123.tmp');
  const newT = path.join(dir, 'ctx-abc.json.456.tmp');
  fs.writeFileSync(oldT, '{}');
  fs.writeFileSync(newT, '{}');
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(oldT, old, old);
  require('../scripts/lib/tmp.cjs').cleanup(proj);
  assert.equal(fs.existsSync(oldT), false);
  assert.equal(fs.existsSync(newT), true);
});

// ---- review round 1 ----
const cgl = require('../scripts/lib/ctxguard.cjs');
const { TEST_TMP } = require('./helpers.cjs');
process.env.GHORC_TMP = TEST_TMP; // the in-process lib calls below use the same tmp area as the spawned hooks

test('handoff: SENT of this session and the handoff flag keep Stop silent; DRAFT and another session do not', () => {
  const p = setup(base());
  const hp = path.join(p.cwd, 'HANDOFF.md');
  assert.ok(blocks(stop(p)), 'no handoff: blocked');
  fs.writeFileSync(hp, `handoff_id: h-1\nstatus: DRAFT\nold_session_id: ${p.s}\n`);
  assert.ok(blocks(stop(p)), 'DRAFT');
  fs.writeFileSync(hp, `handoff_id: h-0\nstatus: SENT\nold_session_id: other-session\n`);
  assert.ok(blocks(stop(p)), 'SENT of another session');
  fs.writeFileSync(hp, `handoff_id: h-1\nstatus: SENT\nold_session_id: ${p.s}\n`);
  const r = stop(p, { last_assistant_message: 'Handed over.' });
  assert.equal(r.out, '', 'the old lead goes idle');
  // a configured handoffPath is honoured
  const q = setup(base());
  fs.mkdirSync(path.join(q.cwd, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(q.cwd, '.claude', 'ghorc.json'), JSON.stringify({ capacity: base(), handoff: { handoffPath: 'docs/H.md' } }));
  fs.writeFileSync(path.join(q.cwd, 'docs', 'H.md'), `status: SENT\nold_session_id: ${q.s}\n`);
  assert.equal(stop(q).out, '');
  // handoff mode (the sticky flag of context-guard): no demand for new work
  const f = setup(base());
  assert.ok(blocks(stop(f)));
  cgl.writeFlag(f.s, { ts: Date.now(), tokens: 170000, stopBlocks: 0 });
  assert.equal(stop(f).out, '', 'flag set');
  fs.rmSync(cgl.flagFile(f.s), { force: true });
  assert.ok(blocks(stop(f)), 'flag removed');
});

test('merge follow-up P2-2: the worker role is read through the shared helper (trim, case)', () => {
  const p = setup(base());
  for (const role of [' Worker ', 'WORKER', 'worker ']) {
    assert.equal(stop(p, {}, { GHORC_ROLE: role }).out, '', JSON.stringify(role));
    assert.equal(prompt(p, {}, { GHORC_ROLE: role }).out, '', JSON.stringify(role));
  }
  assert.ok(blocks(stop(p)), 'no role: still the lead');
});

test('merge follow-up P2-3: a compaction-only flag silences Stop for the lead only; a crossed flag for everyone', () => {
  const now = Date.now();
  const compacted = { ts: now, tokens: 0, compacted: true, compactedAt: now, lead: false };
  const crossed = { ts: now, tokens: 170000, stopBlocks: 0 };
  const p = setup(base());
  cgl.writeFlag(p.s, compacted);
  assert.ok(blocks(stop(p)), 'no role: the compaction-only flag is no flag');
  assert.ok(blocks(stop(p, {}, { GHORC_ROLE: 'someone' })), 'another role');
  assert.equal(stop(p, {}, { GHORC_ROLE: 'lead' }).out, '', 'GHORC_ROLE=lead: the flag counts');
  assert.equal(stop(p, {}, { GHORC_ROLE: ' Lead ' }).out, '', 'the lead role is trimmed and lowercased');
  cgl.writeFlag(p.s, { ...compacted, crossed: true });
  assert.equal(stop(p).out, '', 'a flag that also crossed ctxHandoff counts for a roleless session');
  cgl.writeFlag(p.s, crossed);
  assert.equal(stop(p).out, '', 'the 0.7.0 flag counts for a roleless session');
  fs.rmSync(cgl.flagFile(p.s), { force: true });
  assert.ok(blocks(stop(p)));
});

test('ledger clear: only when no agent-bearing task is in flight (workflow and cloud session count)', () => {
  const run = (bt) => {
    const p = setup(base());
    for (const a of ['a1', 'a2', 'a3']) sub(p, 'SubagentStart', a);
    const r = stop(p, { background_tasks: bt });
    const last = JSON.parse(fs.readFileSync(p.ledger, 'utf8').trim().split('\n').pop()).e;
    return { r, cleared: last === 'clear', p };
  };
  const wf = run([{ id: 'w', type: 'workflow', status: 'running' }]);
  assert.equal(wf.cleared, false, 'a running workflow keeps the ledger');
  assert.equal(wf.r.out, '', 'the ledger still counts 3 agents');
  assert.equal(run([{ id: 'c', type: 'cloud session', status: 'running' }]).cleared, false);
  assert.equal(run([{ id: 'u', type: 'something_new', status: 'running' }]).cleared, false, 'an unknown type is treated as agent-bearing');
  assert.equal(run([{ id: 'w', type: 'workflow', status: 'completed' }]).cleared, true, 'a finished workflow does not hold the ledger');
  const sh = run([{ id: 's', type: 'shell', status: 'running' }]);
  assert.equal(sh.cleared, true, 'a shell carries no agent');
  assert.ok(blocks(sh.r));
  for (const type of ['monitor', 'monitor_mcp', 'local_bash', 'bash']) {
    assert.equal(run([{ id: 'm', type, status: 'running' }]).cleared, true, `${type} carries no agent`);
  }
  assert.equal(cap.anyAgentTaskInFlight([{ type: 'monitor', status: 'running' }]), false);
  assert.equal(cap.anyAgentTaskInFlight([{ type: 'monitor', status: 'running' }, { type: 'workflow', status: 'running' }]), true);
  assert.equal(run(undefined).cleared, false, 'no background_tasks field: the ledger is the source');
  // after the clear the entries are gone: 3 starts cleared leave 0 of 3 (kills "clear ignored in the fold")
  const c = run([]);
  assert.equal(c.cleared, true);
  assert.ok(blocks(c.r), '0 of 3 after the clear');
  assert.ok(blocks(stop(c.p)), 'still 0 of 3 on the next Stop');
  assert.equal(cap.readLedger(c.p.ledger).length, 0);
});

test('a running workflow next to listed subagents: the larger of the listed count and the ledger wins', () => {
  const wf = { id: 'w', type: 'workflow', status: 'running' };
  const seeded = () => {
    const p = setup(base());
    for (const a of ['a1', 'a2', 'a3']) sub(p, 'SubagentStart', a);
    return p;
  };
  const p = seeded();
  assert.equal(stop(p, { background_tasks: [wf, ...tasks('running')] }).out, '', 'ledger 3 > listed 1: 3 of 3');
  const q = seeded();
  assert.equal(stop(q, { background_tasks: [wf, ...tasks('running', 'running', 'running', 'running')] }).out, '', 'listed 4 > ledger 3');
  // no workflow: the listed count alone decides, the ledger is not consulted
  const r = seeded();
  assert.ok(blocks(stop(r, { background_tasks: tasks('running') })), '1 of 3');
  // a shell is not an agent-bearing task: the listed count alone decides, and the ledger is cleared only for no agents
  const s = seeded();
  assert.ok(blocks(stop(s, { background_tasks: [{ id: 'sh', type: 'shell', status: 'running' }, ...tasks('running')] })), '1 of 3');
  assert.equal(cap.otherAgentTaskInFlight([wf]), true);
  assert.equal(cap.otherAgentTaskInFlight([wf, ...tasks('running')].slice(1)), false, 'subagents alone are not "other"');
  assert.equal(cap.otherAgentTaskInFlight([{ type: 'workflow', status: 'completed' }, { type: 'shell', status: 'running' }]), false);
  assert.equal(cap.otherAgentTaskInFlight(undefined), false);
});

test('foldLedger: clear removes this session only, a later start counts again', () => {
  const now = 1_800_000_000_000;
  const rows = [
    { e: 'start', s: 'A', a: '1', ts: now },
    { e: 'start', s: 'A', a: '2', ts: now },
    { e: 'start', s: 'B', a: '1', ts: now },
    { e: 'clear', s: 'A', ts: now },
    { e: 'start', s: 'A', a: '3', ts: now },
  ].map((r) => JSON.stringify(r));
  const live = cap.foldLedger(rows, now);
  assert.deepEqual(live.map((e) => `${e.session}${e.agent}`).sort(), ['A3', 'B1']);
});

test('ledger: an entry younger than 3 hours counts, an older one does not', () => {
  const now = 1_800_000_000_000;
  const H = 3600 * 1000;
  const rows = [
    { e: 'start', s: 'A', a: 'young', ts: now - 2.9 * H },
    { e: 'start', s: 'A', a: 'mid', ts: now - 1.5 * H },
    { e: 'start', s: 'A', a: 'old', ts: now - 3.1 * H },
  ].map((r) => JSON.stringify(r));
  assert.deepEqual(cap.foldLedger(rows, now).map((e) => e.agent).sort(), ['mid', 'young']);
});

test('herdr: a stopped server (server_not_running) means 0 workers; other failures stay unknown', () => {
  const dead = JSON.stringify({ error: { code: 'server_not_running', message: 'no server' } });
  assert.equal(cap.workersFromHerdr(dead, 's'), 0);
  assert.equal(cap.workersFromHerdr(JSON.stringify({ error: { code: 'other' } }), 's'), null);
  const p = setup(base(), { herdr: dead });
  assert.ok(blocks(stop(p)), 'no herdr server: the guard still works');
  assert.match(line(prompt(p)), /^agents 0\/3,/);
  const q = setup(base(), { herdr: JSON.stringify({ error: { code: 'internal' } }) });
  assert.equal(stop(q).out, '');
  assert.match(line(prompt(q)), /^agents \?\/3,/);
});

test('herdrText: ENOENT is "not installed" (0 workers), server_not_running on stdout is read, others throw', () => {
  const keep = process.env.GHORC_CAPACITY_HERDR_JSON;
  delete process.env.GHORC_CAPACITY_HERDR_JSON;
  try {
    const fail = (props) => () => {
      throw Object.assign(new Error('x'), props);
    };
    const noop = () => {};
    assert.equal(cap.herdrText(fail({ code: 'ENOENT' })), null);
    assert.equal(cap.herdrWorkers('s', 'lead-', noop, () => cap.herdrText(fail({ code: 'ENOENT' }))), 0, 'not installed: 0 workers');
    const body = '{"id":"cli:agent:list","error":{"code":"server_not_running","message":"no herdr server is running"}}';
    // the real herdr 0.9.5 shape: exit 1, empty stdout, the JSON on stderr
    assert.equal(cap.herdrText(fail({ status: 1, stdout: '', stderr: body })), body);
    assert.equal(cap.herdrWorkers('s', 'lead-', noop, () => cap.herdrText(fail({ status: 1, stdout: '', stderr: body }))), 0);
    assert.equal(cap.herdrText(fail({ status: 1, stdout: body })), body, 'stdout is read too');
    assert.throws(() => cap.herdrText(fail({ status: 1, stdout: '', stderr: '{"error":{"code":"x"}}' })));
    assert.throws(() => cap.herdrText(fail({ status: 1, stdout: '', stderr: '' })));
    // stderr is piped, never inherited, so a herdr message cannot reach the hook output
    let opts;
    cap.herdrText((_cmd, _args, o) => {
      opts = o;
      return '{"result":{"agents":[]}}';
    });
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
    assert.throws(() => cap.herdrText(fail({ status: 1, stdout: '{"error":{"code":"x"}}' })));
    assert.throws(() => cap.herdrText(fail({ code: 'ETIMEDOUT' })));
    const logs = [];
    assert.equal(cap.herdrWorkers('s', 'lead-', (m) => logs.push(m), () => cap.herdrText(fail({ code: 'ETIMEDOUT' }))), null);
    assert.equal(logs.length, 1);
    assert.equal(cap.herdrText(() => '{"result":{"agents":[]}}'), '{"result":{"agents":[]}}');
  } finally {
    if (keep !== undefined) process.env.GHORC_CAPACITY_HERDR_JSON = keep;
  }
});

test('compaction: a big ledger shrinks to the live starts, leaves no tmp file and keeps late events', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ghorc-compact-'));
  try {
    const file = path.join(dir, 'l.jsonl');
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 3000; i++) {
      rows.push(JSON.stringify({ e: 'start', s: 'S', a: `x${i}`, ts: now }));
      rows.push(JSON.stringify({ e: 'stop', s: 'S', a: `x${i}`, ts: now }));
    }
    rows.push(JSON.stringify({ e: 'start', s: 'S', a: 'live1', ts: now }));
    fs.writeFileSync(file, rows.join('\n') + '\n');
    assert.ok(fs.statSync(file).size > 256 * 1024);
    const logs = [];
    // an event that arrives while the new file is being written must survive the rename
    const late = JSON.stringify({ e: 'start', s: 'S', a: 'late1', ts: now }) + '\n';
    const api = {
      ...fs,
      writeFileSync: (f, d) => {
        fs.writeFileSync(f, d);
        if (String(f).endsWith('.tmp')) fs.appendFileSync(file, late);
      },
    };
    cap.compactLedger(file, now, (m) => logs.push(m), api);
    assert.deepEqual(logs, []);
    assert.ok(fs.statSync(file).size < 1024, `compacted (${fs.statSync(file).size} bytes)`);
    assert.deepEqual(cap.readLedger(file, now).map((e) => e.agent).sort(), ['late1', 'live1']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['l.jsonl'], 'no tmp and no lock left');
    // a normal append below the threshold does not rewrite the file
    const before = fs.readFileSync(file, 'utf8');
    const ev1 = { e: 'start', s: 'S', a: 'n', ts: now };
    cap.appendEvent(file, ev1);
    assert.equal(fs.readFileSync(file, 'utf8'), before + JSON.stringify(ev1) + '\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compaction: a failing rename removes the tmp file and the lock, logs, and keeps the ledger', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ghorc-compact-'));
  try {
    const file = path.join(dir, 'l.jsonl');
    const now = Date.now();
    const rows = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ e: 'start', s: 'S', a: `x${i}`, ts: now }));
    fs.writeFileSync(file, rows.join('\n') + '\n');
    const before = fs.readFileSync(file, 'utf8');
    const logs = [];
    const api = {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error('EPERM: busy'), { code: 'EPERM' });
      },
    };
    assert.ok(fs.statSync(file).size > 256 * 1024);
    cap.compactLedger(file, now, (m) => logs.push(m), api);
    assert.match(logs.join('|'), /ledger compaction: EPERM/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the ledger is untouched');
    assert.deepEqual(fs.readdirSync(dir), ['l.jsonl']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compaction: a stale lock (older than 10 s) is taken over, a fresh one is respected', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ghorc-compact-'));
  try {
    const file = path.join(dir, 'l.jsonl');
    const lock = `${file}.lock`;
    const now = Date.now();
    const rows = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ e: 'start', s: 'S', a: `x${i}`, ts: now - 1000 }));
    rows.push(...Array.from({ length: 3000 }, (_, i) => JSON.stringify({ e: 'stop', s: 'S', a: `x${i}`, ts: now - 500 })));
    const write = () => fs.writeFileSync(file, rows.join('\n') + '\n');
    write();
    const big = fs.statSync(file).size;
    assert.ok(big > 256 * 1024);
    // a lock of a crashed process, 60 s old: taken over, the ledger is compacted, the lock is gone
    fs.writeFileSync(lock, 'dead');
    const old = new Date(now - 60000);
    fs.utimesSync(lock, old, old);
    const logs = [];
    cap.compactLedger(file, now, (m) => logs.push(m), fs);
    assert.deepEqual(logs, []);
    assert.equal(fs.statSync(file).size, 0, 'compacted to nothing live');
    assert.deepEqual(fs.readdirSync(dir), ['l.jsonl'], 'the lock is removed');
    // a lock 5 s old is a live compaction: skipped and logged, the lock stays
    write();
    fs.writeFileSync(lock, 'live');
    const young = new Date(now - 5000);
    fs.utimesSync(lock, young, young);
    cap.compactLedger(file, now, (m) => logs.push(m), fs);
    assert.match(logs.join('|'), /ledger lock busy/);
    assert.equal(fs.statSync(file).size, big, 'not compacted');
    assert.equal(fs.existsSync(lock), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idleReasonGiven: no quadratic backtracking on blank lines or long runs of emphasis', () => {
  const timed = (text) => {
    const t0 = process.hrtime.bigint();
    const r = cap.idleReasonGiven(text, 'Idle:');
    return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  };
  for (const [name, text] of [
    ['blank lines', '\n'.repeat(100 * 1024)],
    ['blank lines with spaces', ' \n'.repeat(50 * 1024)],
    ['emphasis run', '*'.repeat(50 * 1024)],
    ['emphasis run after a number', '1. ' + '*'.repeat(50 * 1024)],
    ['quote marks', '> '.repeat(25 * 1024)],
  ]) {
    const { r, ms } = timed(text);
    assert.equal(r, false, name);
    assert.ok(ms < 200, `${name}: ${ms.toFixed(1)} ms`);
  }
  assert.equal(timed('\n'.repeat(100 * 1024) + 'Idle: a real reason').r, true, 'a late idle line is still found');
  assert.equal(timed('1. **Idle**: a real reason').r, true);
});

test('cleanup removes old capacity-ledger.jsonl.<pid>.tmp leftovers and keeps fresh ones and the ledger', () => {
  const proj = tmpProject();
  const dir = path.join(proj, '.claude', 'ghorc-out');
  fs.mkdirSync(dir, { recursive: true });
  const oldT = path.join(dir, 'capacity-ledger.jsonl.123.tmp');
  const newT = path.join(dir, 'capacity-ledger.jsonl.456.tmp');
  const ledger = path.join(dir, 'capacity-ledger.jsonl');
  for (const f of [oldT, newT, ledger]) fs.writeFileSync(f, '');
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(oldT, old, old);
  fs.utimesSync(ledger, old, old);
  require('../scripts/lib/tmp.cjs').cleanup(proj);
  assert.equal(fs.existsSync(oldT), false);
  assert.equal(fs.existsSync(newT), true);
  assert.equal(fs.existsSync(ledger), true, 'the ledger itself stays');
});

test('weekly pace: agentsOverPace above agents does not raise the limit (the min ceiling)', () => {
  const p = setup(base({ agents: 2, weeklyCapPct: 65, agentsOverPace: 5 }));
  writeCtx(p, p.s, { used_percentage: 40, resets_at: HALF_WEEK_LEFT() }); // over the plan
  assert.equal(stop(p, { background_tasks: tasks('running', 'running') }).out, '', '2 of min(2, 5) = 2');
  const r = stop(p, { background_tasks: tasks('running') });
  assert.ok(blocks(r));
  assert.match(reason(r), /of 2, /);
});

test('weekly: used_percentage 0 is data, not "no data"', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ghorc-week-'));
  try {
    const file = path.join(dir, 'ctx-s0.json');
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), rate_limits: { seven_day: { used_percentage: 0, resets_at: HALF_WEEK_LEFT() } } }));
    assert.equal(cap.readSevenDay(file).used, 0);
    const s = cap.settings({ capacity: { weeklyCapPct: 65 } });
    const w = cap.weekState(cap.readWeekRaw(dir, 's0'), s);
    assert.ok(w, 'a state, not null');
    assert.equal(w.used, 0);
    assert.equal(w.capped, false);
    const p = setup(base({ weeklyCapPct: 65 }));
    writeCtx(p, p.s, { used_percentage: 0, resets_at: HALF_WEEK_LEFT() });
    assert.doesNotMatch(line(prompt(p)), /Week: no rate_limits/);
    assert.doesNotMatch(readLog(p), /weekly cap: no rate_limits/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readWeekRaw: units and the choice between ctx files', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ghorc-week-'));
  try {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const put = (id, week, ts, ageMin = 0) => {
      const f = path.join(dir, `ctx-${id}.json`);
      fs.writeFileSync(f, JSON.stringify({ ts, rate_limits: { seven_day: week } }));
      const t = new Date(nowMs - ageMin * 60000);
      fs.utimesSync(f, t, t);
    };
    // 1. a fresh own file wins over a newer, larger file of another session (kills nowS = nowMs)
    put('own', { used_percentage: 50, resets_at: nowSec + 1000 }, nowMs - 60000, 2);
    put('other', { used_percentage: 90, resets_at: nowSec + 1000 }, nowMs, 0);
    let w = cap.readWeekRaw(dir, 'own', nowMs);
    assert.equal(w.used, 50);
    assert.equal(w.other, false);
    // 2. own stale, another fresh with an older ts: the fresh one wins
    put('own', { used_percentage: 50, resets_at: nowSec - 1000 }, nowMs, 0);
    put('other', { used_percentage: 90, resets_at: nowSec + 1000 }, nowMs - 600000, 5);
    w = cap.readWeekRaw(dir, 'own', nowMs);
    assert.equal(w.used, 90);
    assert.equal(w.other, true);
    // 3. no own file: a fresh older candidate beats a stale newer one, in both mtime orders
    fs.rmSync(path.join(dir, 'ctx-own.json'));
    for (const [freshAge, staleAge] of [[1, 9], [9, 1]]) {
      put('fresh', { used_percentage: 20, resets_at: nowSec + 1000 }, nowMs - 600000, freshAge);
      put('stale', { used_percentage: 80, resets_at: nowSec - 1000 }, nowMs, staleAge);
      fs.rmSync(path.join(dir, 'ctx-other.json'), { force: true });
      w = cap.readWeekRaw(dir, 'nobody', nowMs);
      assert.equal(w.used, 20, `fresh ${freshAge} min, stale ${staleAge} min`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
