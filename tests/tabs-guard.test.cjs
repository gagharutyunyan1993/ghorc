'use strict';
// Tabs guard: naming policy, PreToolUse denies (herdr tab create / agent start, hc run), the inventory report and Stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, isDeny, tmpProject, TEST_TMP } = require('./helpers.cjs');
process.env.GHORC_TMP = TEST_TMP; // the state file path of this process equals the one of the hook processes
const tabs = require('../scripts/lib/tabs.cjs');
const validate = require('../scripts/lib/validate.cjs');

// ---- naming policy ----
test('naming policy: valid and invalid names', () => {
  const ok = (n) => tabs.parseName(n, 'lead-');
  const table = [
    ['a1-implementer', true, 'worker', 'a1', 'implementer'],
    ['a1-reviewer-critical', true, 'worker', 'a1', 'reviewer-critical'], // the longest kind suffix wins
    ['a1-reviewer', true, 'worker', 'a1', 'reviewer'],
    ['a1-critical-reviewer', true, 'worker', 'a1-critical', 'reviewer'],
    ['x-log-reader', true, 'worker', 'x', 'log-reader'],
    ['pkg-9-scout', true, 'worker', 'pkg-9', 'scout'],
    ['m1-integrator', true, 'worker', 'm1', 'integrator'],
    ['r-release', true, 'worker', 'r', 'release'],
    ['c-consult', true, 'worker', 'c', 'consult'],
    ['v-media', true, 'worker', 'v', 'media'],
    ['a-full', true, 'worker', 'a', 'full'],
    ['t-runner', true, 'worker', 't', 'runner'],
    ['t-train', true, 'worker', 't', 'train'],
    ['lead-next', true, 'lead', 'next', 'lead'],
    ['lead-a', true, 'lead', 'a', 'lead'],
  ];
  for (const [name, valid, role, pkg, kind] of table) {
    const r = ok(name);
    assert.equal(r.ok, valid, name);
    assert.equal(r.role, role, name);
    assert.equal(r.pkg, pkg, name);
    assert.equal(r.kind, kind, name);
  }
  assert.equal(ok('a1-reviewer-critical').kind, 'reviewer-critical');
  assert.equal(ok('a-full').long, true);
  assert.equal(ok('a-implementer').long, false);
  for (const bad of ['', 'lead-', 'implementer', '-implementer', 'A1-implementer', 'a_1-implementer', 'a1 implementer', 'a1-worker', 'a1-implementer-x', 'a1-', `${'a'.repeat(33)}-implementer`, 'a1.implementer', 'ä-scout', '1a-implementer', '9-implementer']) {
    assert.equal(ok(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(ok(`${'a'.repeat(20)}-implementer`).ok, true); // 32 characters
  assert.equal(ok(`${'a'.repeat(21)}-implementer`).ok, false); // 33
  assert.match(ok('1a-implementer').why, /must start with a letter/);
  // the lead prefix is configurable, a prefix without a dash too
  assert.equal(tabs.parseName('boss1', 'boss').role, 'lead');
  assert.equal(tabs.parseName('lead-x', 'boss').ok, false);
});

// ---- helpers ----
const NONE = JSON.stringify({ result: { agents: [] } });
const hdr = (agents) => JSON.stringify({ result: { agents } });
const agent = (name, status, cwd, extra = {}) => ({ name, agent_status: status, pane_id: 'w4:p1', cwd, agent_session: { value: `s-${name}` }, ...extra });
const hcl = (terminals) => JSON.stringify({ terminals });
const term = (name, status, extra = {}) => ({ address: `t-${name}`, name, parent: 'self1', state: 'live', status, agent: 'claude-code', ...extra });

let seq = 0;
const SID = () => `${String(++seq).padStart(4, '0')}-tabs-session-x`;

function project(tabsCfg, extra = {}) {
  const cwd = fs.realpathSync.native(tmpProject({ tabs: tabsCfg || {}, ...extra }));
  return { cwd, sid: SID() };
}
const penv = (p, env = {}) => ({ CLAUDE_PROJECT_DIR: p.cwd, GHORC_CAPACITY_HERDR_JSON: NONE, GHORC_CAPACITY_HC_JSON: hcl([]), ...env });
// the report events read one backend: hc when its text is given, else herdr
const menv = (p, env = {}) => ({ CLAUDE_PROJECT_DIR: p.cwd, ...(env.GHORC_CAPACITY_HC_JSON === undefined ? { GHORC_CAPACITY_HERDR_JSON: NONE } : {}), ...env });
const pre = (p, command, { tool = 'Bash', env = {}, extra = {} } = {}) =>
  runScript('tabs-guard.cjs', { hook_event_name: 'PreToolUse', tool_name: tool, session_id: p.sid, cwd: p.cwd, tool_input: { command }, ...extra }, { cwd: p.cwd, env: penv(p, env) });
const reasonOf = (r) => JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
const denied = (r) => {
  assert.equal(r.code, 0);
  return isDeny(r);
};
function allowed(r, msg) {
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '', `${msg || ''} ${r.out}`);
}

// the own workspace and the owner's focus are part of every tab create (rule B)
const WSF = '--workspace $HERDR_WORKSPACE_ID --no-focus';
const TAB = (label, role, more = WSF) => `herdr tab create ${label === null ? '' : `--label ${label} `}--cwd /w ${role ? `--env GHORC_ROLE=${role} ` : ''}${more}`.trim();
const ARGS = '--model opus --effort medium';
const PERM = '--permission-mode bypassPermissions';
const START = (name, args) => `herdr agent start ${name} --kind claude --pane w1:p1 -- ${args}`;
const ENVW = 'env GHORC_ROLE=worker';
const HC = (name, role, args, more = '') => `hc run --bg --name ${name} --cwd /w ${more} env ${role ? `GHORC_ROLE=${role} ` : ''}claude ${args} "do it"`;

// ---- herdr tab create ----
test('herdr tab create: label rules', () => {
  const p = project();
  assert.ok(denied(pre(p, TAB(null, 'worker'))));
  assert.match(reasonOf(pre(p, TAB(null, 'worker'))), /--label is missing/);
  for (const bad of ['Big-implementer', 'x-worker', 'implementer', 'a_b-implementer', 'lead-']) {
    assert.ok(denied(pre(p, TAB(bad, 'worker'))), bad);
  }
  const r = pre(p, TAB('Big-implementer', 'worker'));
  assert.match(reasonOf(r), /--label "Big-implementer" is not allowed/);
  assert.match(reasonOf(r), /Corrected form: herdr tab create --label big-implementer --cwd \/w --env GHORC_ROLE=worker/);
  allowed(pre(p, TAB('a1-implementer', 'worker')));
  allowed(pre(p, TAB('a1-reviewer-critical', 'worker')));
  allowed(pre(p, `herdr tab create --label=a1-scout --env=GHORC_ROLE=worker --workspace=$HERDR_WORKSPACE_ID --no-focus`));
});

test('herdr tab create: the role env must match the label', () => {
  const p = project();
  const r = pre(p, TAB('a1-implementer', null));
  assert.ok(denied(r));
  assert.match(reasonOf(r), /a worker tab needs --env GHORC_ROLE=worker/);
  assert.match(reasonOf(r), /Corrected form: .*--label a1-implementer .*--env GHORC_ROLE=worker/);
  assert.ok(denied(pre(p, TAB('a1-implementer', 'lead'))));
  assert.ok(denied(pre(p, TAB('lead-next', null))));
  assert.ok(denied(pre(p, TAB('lead-next', 'worker'))));
  assert.match(reasonOf(pre(p, TAB('lead-next', 'worker'))), /a lead tab needs --env GHORC_ROLE=lead/);
  allowed(pre(p, TAB('lead-next', 'lead')));
});

test('herdr tab create: duplicate live name and the worker limit', () => {
  const p = project({ maxWorkers: 2 });
  const live = hdr([agent('a-implementer', 'working', p.cwd), agent('b-reviewer', 'idle', p.cwd)]);
  const dup = pre(p, TAB('a-implementer', 'worker'), { env: { GHORC_CAPACITY_HERDR_JSON: live } });
  assert.ok(denied(dup));
  assert.match(reasonOf(dup), /name a-implementer is already used by a live tab/);
  const lim = pre(p, TAB('c-implementer', 'worker'), { env: { GHORC_CAPACITY_HERDR_JSON: live } });
  assert.ok(denied(lim));
  assert.match(reasonOf(lim), /2 agent workers are already live \(tabs\.maxWorkers is 2: a-implementer, b-reviewer\)/);
  // a long-lived kind and a lead are not limited by it
  allowed(pre(p, TAB('c-full', 'worker'), { env: { GHORC_CAPACITY_HERDR_JSON: live } }));
  allowed(pre(p, TAB('lead-next', 'lead'), { env: { GHORC_CAPACITY_HERDR_JSON: live } }));
  // an agent of another project does not count
  const other = hdr([agent('a-implementer', 'working', path.join(p.cwd, '..', 'elsewhere')), agent('b-reviewer', 'working', '/some/where/else')]);
  allowed(pre(p, TAB('c-implementer', 'worker'), { env: { GHORC_CAPACITY_HERDR_JSON: other } }));
  // an agent in a worktree of the project does
  const wt = hdr([agent('a-implementer', 'working', path.join(p.cwd, '.claude', 'worktrees', 'a')), agent('b-reviewer', 'working', p.cwd)]);
  assert.ok(denied(pre(p, TAB('c-implementer', 'worker'), { env: { GHORC_CAPACITY_HERDR_JSON: wt } })));
});

test('herdr tab create: tabs opened in one command count together', () => {
  const p = project({ maxWorkers: 2 });
  const cmd = [TAB('a-implementer', 'worker'), TAB('b-implementer', 'worker'), TAB('c-implementer', 'worker')].join(' && ');
  const r = pre(p, cmd);
  assert.ok(denied(r));
  assert.match(reasonOf(r), /2 agent workers are already live/);
  allowed(pre(p, [TAB('a-implementer', 'worker'), TAB('b-implementer', 'worker')].join('; ')));
});

// ---- herdr agent start ----
test('herdr agent start: a full model id is denied and the corrected form is shown', () => {
  const p = project();
  const bad = 'herdr agent start x-implementer --kind claude --pane w1:p1 -- --model claude-opus-5-5 --effort medium';
  const r = pre(p, bad);
  assert.ok(denied(r));
  const why = reasonOf(r);
  assert.match(why, /--model claude-opus-5-5 is not an alias: use opus/);
  assert.match(why, /-n x-implementer is missing/);
  assert.match(why, /permission arguments are missing: --permission-mode bypassPermissions/);
  assert.match(why, /Corrected form: herdr agent start x-implementer --kind claude --pane w1:p1 -- --model opus --effort medium -n x-implementer --permission-mode bypassPermissions/);
  const fixed = why.split('Corrected form: ')[1].trim();
  allowed(pre(p, fixed), 'the corrected form must pass');
});

test('herdr agent start: every rule on its own', () => {
  const p = project();
  const good = `${ARGS} -n a-implementer ${PERM}`;
  allowed(pre(p, START('a-implementer', good)));
  allowed(pre(p, START('a-implementer', `--model=sonnet --effort=high --name=a-implementer ${PERM} "task"`)));
  allowed(pre(p, START('a-implementer', `--model opus[1m] --effort max --permission-mode=bypassPermissions -n a-implementer`)));
  for (const [args, re] of [
    [`--effort medium -n a-implementer ${PERM}`, /--model is missing/],
    [`--model opus -n a-implementer ${PERM}`, /--effort is missing/],
    [`--model opus --effort extreme -n a-implementer ${PERM}`, /--effort extreme is not one of/],
    [`--model sonnet-4-5 --effort low -n a-implementer ${PERM}`, /--model sonnet-4-5 is not an alias: use sonnet/],
    [`${ARGS} -n other-implementer ${PERM}`, /-n other-implementer differs from the tab name a-implementer/],
    [`${ARGS} ${PERM}`, /-n a-implementer is missing/],
    [`${ARGS} -n a-implementer`, /permission arguments are missing/],
  ]) {
    const r = pre(p, START('a-implementer', args));
    assert.ok(denied(r), args);
    assert.match(reasonOf(r), re, args);
  }
  const bare = pre(p, 'herdr agent start a-implementer --kind claude --pane w1:p1');
  assert.ok(denied(bare));
  assert.match(reasonOf(bare), /--model is missing/);
  const nm = pre(p, START('Bad_Name', good));
  assert.ok(denied(nm));
  assert.match(reasonOf(nm), /agent name "Bad_Name" is not allowed/);
  // another kind of agent: the name only
  allowed(pre(p, 'herdr agent start a-implementer --kind codex --pane w1:p1'));
  assert.ok(denied(pre(p, 'herdr agent start nope --kind codex --pane w1:p1')));
});

test('herdr agent start: a lead name needs handoff.candidatePermissionArgs, a worker name worker.permissionArgs', () => {
  const p = project({}, { worker: { permissionArgs: ['--permission-mode', 'acceptEdits'] }, handoff: { candidatePermissionArgs: ['--dangerously-skip-permissions'] } });
  allowed(pre(p, START('a-implementer', `${ARGS} -n a-implementer --permission-mode acceptEdits`)));
  assert.ok(denied(pre(p, START('a-implementer', `${ARGS} -n a-implementer ${PERM}`))));
  allowed(pre(p, START('lead-next', `${ARGS} -n lead-next --dangerously-skip-permissions`)));
  assert.ok(denied(pre(p, START('lead-next', `${ARGS} -n lead-next --permission-mode acceptEdits`))));
  // no permission args configured: nothing is demanded
  const q = project({}, { worker: { permissionArgs: [] } });
  allowed(pre(q, START('a-implementer', `${ARGS} -n a-implementer`)));
});

// ---- hc run ----
test('hc run: role env, model, effort, name, permission args', () => {
  const p = project();
  const good = `${ARGS} -n a-implementer ${PERM}`;
  allowed(pre(p, HC('a-implementer', 'worker', good)));
  const noRole = pre(p, HC('a-implementer', null, good));
  assert.ok(denied(noRole));
  assert.match(reasonOf(noRole), /GHORC_ROLE=worker is missing in front of claude/);
  assert.match(reasonOf(noRole), /Corrected form: hc run --bg --name a-implementer --cwd \/w env GHORC_ROLE=worker claude --model opus/);
  assert.ok(denied(pre(p, HC('a-implementer', 'lead', good))));
  assert.ok(denied(pre(p, HC('lead-next', 'worker', good))));
  allowed(pre(p, HC('lead-next', 'lead', `${ARGS} -n lead-next ${PERM}`)));
  const full = pre(p, HC('a-implementer', 'worker', 'claude-opus-5-5-x'.length ? '--model claude-opus-5-5 --effort medium' : ''));
  assert.ok(denied(full));
  assert.match(reasonOf(full), /--model claude-opus-5-5 is not an alias: use opus/);
  assert.match(reasonOf(full), /-n a-implementer is missing/);
  assert.ok(denied(pre(p, 'hc run --bg --cwd /w env GHORC_ROLE=worker claude --model opus --effort medium')));
  assert.match(reasonOf(pre(p, 'hc run --bg --cwd /w env GHORC_ROLE=worker claude --model opus --effort medium')), /--name is missing/);
  assert.ok(denied(pre(p, HC('BAD', 'worker', good))));
  // Windows form: the quoted env.exe path, claude.exe
  allowed(pre(p, String.raw`hc run --bg --name a-implementer --cwd "D:\my proj" "C:\Program Files\Git\usr\bin\env.exe" GHORC_ROLE=worker claude.exe ${good} "task"`));
  const w = pre(p, String.raw`hc run --bg --name a-implementer --cwd "D:\my proj" claude.exe ${good} "task"`);
  assert.ok(denied(w));
  assert.match(reasonOf(w), /Corrected form: hc run --bg --name a-implementer --cwd "..." .*env.exe"? GHORC_ROLE=worker claude.exe/i);
});

test('hc run: long-lived kinds need --outlive-parent; other programs get the name rules only', () => {
  const p = project();
  const good = `${ARGS} -n a-full ${PERM}`;
  const r = pre(p, HC('a-full', 'worker', good));
  assert.ok(denied(r));
  assert.match(reasonOf(r), /a-full is a long-lived tab \(kind full\): start it with --outlive-parent/);
  assert.match(reasonOf(r), /Corrected form: hc run --outlive-parent --bg/);
  allowed(pre(p, HC('a-full', 'worker', good, '--outlive-parent')));
  allowed(pre(p, HC('a-train', 'worker', `${ARGS} -n a-train ${PERM}`, '--outlive-parent')));
  assert.ok(denied(pre(p, HC('a-runner', 'worker', `${ARGS} -n a-runner ${PERM}`))));
  // not claude: no role, model or args needed
  allowed(pre(p, 'hc run --bg --name a-runner --outlive-parent npm run dev'));
  assert.ok(denied(pre(p, 'hc run --bg --name a-runner npm run dev')));
  assert.ok(denied(pre(p, 'hc run --bg --name devserver --outlive-parent npm run dev')));
  allowed(pre(p, 'hc run --bg --name a-implementer node build.js'));
});

test('hc run: duplicate live name and the worker limit', () => {
  const p = project({ maxWorkers: 1 });
  const good = `${ARGS} -n b-implementer ${PERM}`;
  const live = hcl([term('a-implementer', 'working', { cwd: p.cwd })]);
  const lim = pre(p, HC('b-implementer', 'worker', good), { env: { GHORC_CAPACITY_HC_JSON: live } });
  assert.ok(denied(lim));
  assert.match(reasonOf(lim), /1 agent workers are already live \(tabs\.maxWorkers is 1: a-implementer\)/);
  const dup = pre(p, HC('a-implementer', 'worker', `${ARGS} -n a-implementer ${PERM}`), { env: { GHORC_CAPACITY_HC_JSON: live } });
  assert.ok(denied(dup));
  assert.match(reasonOf(dup), /name a-implementer is already used by a live tab.*hc kill a-implementer; hc rm a-implementer/);
  // a dead terminal does not count; a child of this terminal does, wherever its cwd is
  const dead = hcl([term('a-implementer', 'idle', { cwd: p.cwd, state: 'dead' })]);
  allowed(pre(p, HC('b-implementer', 'worker', good), { env: { GHORC_CAPACITY_HC_JSON: dead } }));
  const child = hcl([term('a-implementer', 'working', { cwd: '/elsewhere', parent: 'self1' })]);
  assert.ok(denied(pre(p, HC('b-implementer', 'worker', good), { env: { GHORC_CAPACITY_HC_JSON: child, HC_TERMINAL_ID: 'self1' } })));
  allowed(pre(p, HC('b-implementer', 'worker', good), { env: { GHORC_CAPACITY_HC_JSON: child, HC_TERMINAL_ID: 'someone-else' } }));
});

test('PowerShell form', () => {
  const p = project();
  const ps = (c) => pre(p, c, { tool: 'PowerShell' });
  const r = ps(String.raw`& "C:\Users\me\bin\herdr.exe" agent start x-implementer --kind claude --pane w1:p1 -- --model claude-opus-5-5 --effort medium`);
  assert.ok(denied(r));
  assert.match(reasonOf(r), /--model claude-opus-5-5 is not an alias/);
  assert.ok(denied(ps('herdr tab create --label Bad_Label --env GHORC_ROLE=worker ' + WSF)));
  allowed(ps('herdr tab create --label a1-implementer --env GHORC_ROLE=worker --workspace $env:HERDR_WORKSPACE_ID --no-focus'));
  assert.ok(denied(ps(String.raw`Start-Process hc -ArgumentList "run --bg --name a-implementer claude --model opus --effort medium"`)));
  allowed(ps('herdr tab create --label a1-implementer --env GHORC_ROLE=worker --workspace $env:HERDR_WORKSPACE_ID --no-focus; herdr tab list'));
});

test('commands that are not tab commands and quoted values pass', () => {
  const p = project();
  for (const c of ['hc ls', 'hc send t5 "run claude"', 'herdr agent list', 'herdr tab list', 'herdr pane read w1:p1', 'git status', 'echo hc run claude', 'hc kill a-implementer; hc rm a-implementer', 'herdr tab close w1:t2']) {
    allowed(pre(p, c), c);
  }
  // an unreadable value (quoted, a variable) is not judged
  allowed(pre(p, 'herdr tab create --label "a1-implementer" --env GHORC_ROLE=worker --workspace "$HERDR_WORKSPACE_ID" --no-focus'));
  allowed(pre(p, 'herdr tab create --label $name --env GHORC_ROLE=worker --workspace $env:HERDR_WORKSPACE_ID --no-focus', { tool: 'PowerShell' }));
});

test('fail open: unreadable lists skip the list rules only; garbage config and flags allow', () => {
  const p = project({ maxWorkers: 1 });
  for (const garbage of ['', 'not json', '{"result":{}}', '[]', 'null']) {
    allowed(pre(p, TAB('a-implementer', 'worker'), { env: { GHORC_CAPACITY_HERDR_JSON: garbage } }), JSON.stringify(garbage));
    allowed(pre(p, HC('a-implementer', 'worker', `${ARGS} -n a-implementer ${PERM}`), { env: { GHORC_CAPACITY_HC_JSON: garbage } }), JSON.stringify(garbage));
    // the static rules still apply
    assert.ok(denied(pre(p, TAB('Bad', 'worker'), { env: { GHORC_CAPACITY_HERDR_JSON: garbage } })));
  }
  // no tool command at all, non-string command, garbage stdin
  assert.equal(runScript('tabs-guard.cjs', '{not json').out, '');
  assert.equal(runScript('tabs-guard.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }).out, '');
  assert.equal(runScript('tabs-guard.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { command: 'herdr tab create' } }).out, '');
  // an invalid project config never makes this guard deny
  const bad = project({ maxWorkers: 'many' });
  allowed(pre(bad, TAB('Bad', 'worker')));
});

test('workers, subagents and a disabled guard are not checked', () => {
  const p = project();
  const cmd = TAB('Bad', null);
  assert.ok(denied(pre(p, cmd)));
  allowed(pre(p, cmd, { env: { GHORC_ROLE: 'worker' } }));
  allowed(pre(p, cmd, { extra: { agent_id: 'sub1' } }));
  assert.ok(denied(pre(p, cmd, { env: { GHORC_ROLE: 'lead' } })));
  const off = project({ enabled: false });
  allowed(pre(off, cmd));
  allowed(pre(off, START('x', '--model claude-opus-5-5')));
});

test('a denial is written to the denial log under the hook name', () => {
  const p = project();
  assert.ok(denied(pre(p, TAB('Bad', 'worker'))));
  const log = fs.readFileSync(path.join(TEST_TMP, 'denials.log'), 'utf8');
  assert.match(log, new RegExp(`${p.sid.slice(0, 8)} tabs-guard tabs-guard: tab command refused`));
});

// ---- the inventory ----
const ev = (p, event, extra = {}) => ({ hook_event_name: event, session_id: p.sid, cwd: p.cwd, ...extra });
const mon = (p, event, env = {}, extra = {}) => runScript('tabs-guard.cjs', ev(p, event, extra), { cwd: p.cwd, env: menv(p, env) });
const ctx = (r) => JSON.parse(r.out).hookSpecificOutput.additionalContext;
const blocks = (r) => r.out.trim() !== '' && JSON.parse(r.out).decision === 'block';
function report(p, name, lastLine) {
  const f = tabs.reportFile(p.cwd, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `# report\n\nsome text\n${lastLine}\n`);
  return f;
}
function seed(p, workers) {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  fs.writeFileSync(tabs.stateFile(p.sid), JSON.stringify({ workers }));
}
const ago = (min) => Date.now() - min * 60000;
// workers the hook has seen for a while (a result line counts only when the report is not older than the first sighting)
const seedOld = (p, map, min = 30) => seed(p, Object.fromEntries(Object.entries(map).map(([n, status]) => [n, { firstSeen: ago(min), status, statusSince: ago(min), notified: false }])));

test('inventory: one blocked and one finished worker give both flags, the line format and a Stop block', () => {
  const p = project();
  report(p, 'b1-implementer', 'DONE b1-implementer');
  const list = hdr([
    agent('a1-implementer', 'blocked', p.cwd, { pane_id: 'w4:p2' }),
    agent('b1-implementer', 'idle', p.cwd),
    agent('lead-main', 'working', p.cwd),
    agent('foreign-implementer', 'working', '/other/project'),
    agent('Weird Name', 'working', p.cwd),
  ]);
  const env = { GHORC_CAPACITY_HERDR_JSON: list, GHORC_TABS_NOTIFY_LOG: path.join(p.cwd, 'notify.log') };
  seedOld(p, { 'a1-implementer': 'blocked', 'b1-implementer': 'idle' }, 4);
  const r = mon(p, 'UserPromptSubmit', env);
  const lines = ctx(r).split('\n');
  assert.equal(lines[0], 'tabs: 2 live (a1-implementer blocked 4m, b1-implementer idle 4m)');
  assert.match(lines[1], /^tabs BLOCKED: a1-implementer waits on a dialog\. Read its screen \(herdr pane read w4:p2 --source recent --lines 40\) and tell the owner; never answer a permission prompt yourself\.$/);
  assert.match(lines[2], /^tabs FINISHED: b1-implementer wrote "DONE b1-implementer" but its tab is still open\. Accept the report and close the tab now: herdr tab list, then herdr tab close <tab_id>\.$/);
  assert.match(lines[3], /^tabs BADNAME: "Weird Name" \(working\) breaks the tab naming policy/);
  assert.equal(lines.length, 4);
  // SessionStart reports the same
  const s = mon(p, 'SessionStart', env, { source: 'startup' });
  assert.equal(JSON.parse(s.out).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx(s), /BLOCKED: a1-implementer/);
  // Stop blocks once, with the same lines
  const st = mon(p, 'Stop', env);
  assert.ok(blocks(st));
  const why = JSON.parse(st.out).reason;
  assert.match(why, /tabs BLOCKED: a1-implementer/);
  assert.match(why, /tabs FINISHED: b1-implementer/);
  assert.equal(mon(p, 'Stop', env, { stop_hook_active: true }).out.trim(), '');
  // the same flags do not block the next turn's Stop again, the prompt line still shows them
  assert.equal(mon(p, 'Stop', env).out.trim(), '');
  assert.match(ctx(mon(p, 'UserPromptSubmit', env)), /tabs BLOCKED: a1-implementer/);
  // stopBlock off: no block, the prompt line stays
  const q = project({ stopBlock: false });
  report(q, 'b1-implementer', 'DONE b1-implementer');
  seedOld(q, { 'b1-implementer': 'idle' });
  assert.equal(mon(q, 'Stop', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('b1-implementer', 'idle', q.cwd)]) }).out.trim(), '');
  assert.match(ctx(mon(q, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('b1-implementer', 'idle', q.cwd)]) })), /FINISHED/);
});

test('inventory: hc form, close and read commands, parent or project membership', () => {
  const p = project();
  report(p, 'a1-reviewer', 'VERDICT ACCEPT_WITH_NOTES');
  const list = hcl([
    term('a1-reviewer', 'idle', { cwd: '/not/here', parent: 'self1' }),
    term('b1-implementer', 'blocked', { cwd: p.cwd, parent: 'someone-else' }),
    term('c1-implementer', 'working', { cwd: '/not/here', parent: 'someone-else' }),
    term('d1-implementer', 'working', { cwd: p.cwd, state: 'dead' }),
    term('lead-old', 'idle', { cwd: p.cwd, parent: '' }),
  ]);
  seedOld(p, { 'a1-reviewer': 'idle', 'b1-implementer': 'blocked' }, 3);
  const r = mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HC_JSON: list, HC_TERMINAL_ID: 'self1' });
  const lines = ctx(r).split('\n');
  assert.equal(lines[0], 'tabs: 2 live (a1-reviewer idle 3m, b1-implementer blocked 3m)');
  assert.match(lines.join('\n'), /tabs BLOCKED: b1-implementer waits on a dialog\. Read its screen \(hc read b1-implementer\)/);
  assert.match(lines.join('\n'), /tabs FINISHED: a1-reviewer wrote "VERDICT ACCEPT_WITH_NOTES" but its tab is still open\. Accept the report and close the tab now: hc kill a1-reviewer; hc rm a1-reviewer\./);
});

test('inventory: no workers, a worker session and a subagent print nothing', () => {
  const p = project();
  assert.equal(mon(p, 'UserPromptSubmit').out, '');
  assert.equal(mon(p, 'Stop').out, '');
  const env = { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'blocked', p.cwd)]) };
  assert.ok(ctx(mon(p, 'UserPromptSubmit', env)));
  assert.equal(mon(p, 'UserPromptSubmit', { ...env, GHORC_ROLE: 'worker' }).out, '');
  assert.equal(mon(p, 'UserPromptSubmit', env, { agent_id: 'x' }).out, '');
  const off = project({ enabled: false });
  assert.equal(mon(off, 'UserPromptSubmit', env).out, '');
  // garbage list: silent
  assert.equal(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: 'garbage' }).out, '');
  assert.equal(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: 'garbage' }).out, '');
});

test('inventory: a healthy working tab only gets the line; no result line means not finished', () => {
  const p = project();
  report(p, 'a1-implementer', 'still writing, no result yet');
  const r = mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'working', p.cwd)]) });
  assert.equal(ctx(r), 'tabs: 1 live (a1-implementer working 0m)');
  assert.equal(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'working', p.cwd)]) }).out.trim(), '');
});

test('result line forms: DONE, BLOCKED, HANDOFF, VERDICT; only the last non-empty line counts', () => {
  const p = project();
  const n = 'a1-implementer';
  for (const last of [`DONE ${n}`, `BLOCKED ${n}: no network`, `HANDOFF ${n}`, 'VERDICT ACCEPT', 'VERDICT CHANGES_REQUIRED', 'VERDICT BLOCKED', `**DONE ${n}**`]) {
    report(p, n, last);
    assert.ok(tabs.resultLine(p.cwd, n), last);
  }
  for (const last of [`DONE other-implementer`, 'DONE', `BLOCKED ${n}x`, 'VERDICT MAYBE', 'all good']) {
    report(p, n, last);
    assert.equal(tabs.resultLine(p.cwd, n), null, last);
  }
  fs.writeFileSync(tabs.reportFile(p.cwd, n), `DONE ${n}\nand then more text\n\n`);
  assert.equal(tabs.resultLine(p.cwd, n), null);
  fs.writeFileSync(tabs.reportFile(p.cwd, n), `text\nDONE ${n}\n\n\n`);
  assert.ok(tabs.resultLine(p.cwd, n));
  assert.equal(tabs.resultLine(p.cwd, 'nothing-implementer'), null);
});

test('a result line from before a new working period is stale; one written during it is finished', () => {
  const p = project();
  const f = report(p, 'a1-implementer', 'DONE a1-implementer');
  const list = hdr([agent('a1-implementer', 'working', p.cwd)]);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(f, old, old);
  seed(p, { 'a1-implementer': { firstSeen: ago(30), status: 'working', statusSince: ago(5), notified: false } });
  assert.equal(ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list })).includes('FINISHED'), false);
  const now = new Date();
  fs.utimesSync(f, now, now);
  seed(p, { 'a1-implementer': { firstSeen: ago(130), status: 'working', statusSince: ago(120), notified: false } });
  assert.match(ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list })), /FINISHED: a1-implementer/);
});

test('STALLED, OVERTIME and OVER_LIMIT from the remembered state', () => {
  const p = project({ maxWorkers: 2, idleMin: 10, overtimeMin: 45 });
  report(p, 'd1-scout', 'no result');
  const list = hdr([
    agent('a1-implementer', 'idle', p.cwd),
    agent('b1-implementer', 'working', p.cwd),
    agent('c1-implementer', 'idle', p.cwd),
    agent('t1-runner', 'idle', p.cwd),
    agent('d1-scout', 'working', p.cwd),
  ]);
  seed(p, {
    'a1-implementer': { firstSeen: ago(30), status: 'idle', statusSince: ago(12), notified: false },
    'b1-implementer': { firstSeen: ago(50), status: 'working', statusSince: ago(50), notified: false },
    'c1-implementer': { firstSeen: ago(30), status: 'idle', statusSince: ago(3), notified: false },
    't1-runner': { firstSeen: ago(900), status: 'idle', statusSince: ago(800), notified: false },
  });
  const text = ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list }));
  assert.match(text, /^tabs: 5 live \(a1-implementer idle 30m, b1-implementer working 50m, c1-implementer idle 30m, t1-runner idle 900m, d1-scout working 0m\)/);
  assert.match(text, /tabs STALLED: a1-implementer has been idle 12m without a result line/);
  assert.match(text, /tabs OVERTIME: b1-implementer runs 50m \(tabs\.overtimeMin 45\)/);
  assert.match(text, /tabs OVER_LIMIT: 4 agent workers are live, tabs\.maxWorkers is 2/);
  assert.equal(/c1-implementer has been idle/.test(text), false);
  assert.equal(/t1-runner (has been|runs)/.test(text), false, 'a long-lived tab is neither stalled nor overtime');
  // STALLED and OVERTIME alone do not block Stop
  assert.equal(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: list }).out.trim(), '');
});

test('state: runtime and idle time come from earlier runs (fake clock), and a gone worker is forgotten', () => {
  const p = project({ idleMin: 10 });
  const pre = path.join(__dirname, 'mock-now.cjs').split('\\').join('/');
  const at = (ms, list) =>
    mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list, NODE_OPTIONS: `--require "${pre}"`, GHORC_MOCK_NOW_MS: String(ms) });
  const T = Date.UTC(2026, 10, 24, 10, 0, 0);
  const idle = hdr([agent('a1-implementer', 'idle', p.cwd)]);
  assert.equal(ctx(at(T, idle)), 'tabs: 1 live (a1-implementer idle 0m)');
  assert.equal(ctx(at(T + 5 * 60000, idle)), 'tabs: 1 live (a1-implementer idle 5m)');
  assert.match(ctx(at(T + 11 * 60000, idle)), /tabs STALLED: a1-implementer has been idle 11m/);
  // it works for a while: the idle clock restarts
  assert.equal(ctx(at(T + 12 * 60000, hdr([agent('a1-implementer', 'working', p.cwd)]))), 'tabs: 1 live (a1-implementer working 12m)');
  assert.equal(ctx(at(T + 13 * 60000, idle)), 'tabs: 1 live (a1-implementer idle 13m)');
  // gone and back: a new worker
  assert.equal(at(T + 14 * 60000, NONE).out, '');
  assert.equal(ctx(at(T + 20 * 60000, idle)), 'tabs: 1 live (a1-implementer idle 0m)');
});

test('notify: once per transition to blocked, herdr only, tabs.notify off silences it', () => {
  const p = project();
  const log = path.join(p.cwd, 'notify.log');
  const run = (status, env = {}) => mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', status, p.cwd)]), GHORC_TABS_NOTIFY_LOG: log, ...env });
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  run('working');
  assert.equal(lines().length, 0);
  run('blocked');
  assert.equal(lines().length, 1);
  assert.deepEqual(lines()[0], ['herdr', 'notification', 'show', 'ghorc: a1-implementer waits', '--body', 'a1-implementer is blocked on a dialog: read its screen and tell the owner', '--sound', 'request']);
  run('blocked');
  mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'blocked', p.cwd)]), GHORC_TABS_NOTIFY_LOG: log });
  assert.equal(lines().length, 1, 'the same blocked period is notified once');
  run('working');
  run('blocked');
  assert.equal(lines().length, 2, 'a new transition notifies again');
  // hc: no notification
  const q = project();
  const log2 = path.join(q.cwd, 'notify.log');
  mon(q, 'UserPromptSubmit', { GHORC_CAPACITY_HC_JSON: hcl([term('a1-implementer', 'blocked', { cwd: q.cwd })]), HC_TERMINAL_ID: 'self1', GHORC_TABS_NOTIFY_LOG: log2 });
  assert.equal(fs.existsSync(log2), false);
  // notify: false
  const off = project({ notify: false });
  const log3 = path.join(off.cwd, 'notify.log');
  mon(off, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'blocked', off.cwd)]), GHORC_TABS_NOTIFY_LOG: log3 });
  assert.equal(fs.existsSync(log3), false);
});

// ---- config and registration ----
test('config: tabs keys are validated', () => {
  const check = (tabsCfg) => {
    const dir = tmpProject({ tabs: tabsCfg });
    return validate.check(dir, { cli: true });
  };
  assert.deepEqual(check({ enabled: true, maxWorkers: 3, idleMin: 10, overtimeMin: 45, stopBlock: true, notify: false }).problems, []);
  for (const [cfg, re] of [
    [{ maxWorkers: 0 }, /tabs\.maxWorkers: 0 must be a whole number in 1\.\.20/],
    [{ maxWorkers: 21 }, /tabs\.maxWorkers: 21/],
    [{ maxWorkers: 2.5 }, /tabs\.maxWorkers: 2\.5/],
    [{ idleMin: 0 }, /tabs\.idleMin: 0 must be a whole number in 1\.\.1440/],
    [{ overtimeMin: 1441 }, /tabs\.overtimeMin: 1441/],
    [{ enabled: 'yes' }, /tabs\.enabled: expected boolean, got string/],
    [{ stopBlock: 1 }, /tabs\.stopBlock: expected boolean/],
    [{ notify: null }, /tabs\.notify: expected boolean/],
    [{ maxWorkers: '3' }, /tabs\.maxWorkers: expected number, got string/],
    [{ nope: 1 }, /unknown key: tabs\.nope/],
  ]) {
    const r = check(cfg);
    assert.ok(r.problems.some((x) => re.test(x)), `${JSON.stringify(cfg)} -> ${JSON.stringify(r.problems)}`);
  }
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'defaults.json'), 'utf8'));
  const { devCommands, ...rest } = defaults.tabs;
  assert.deepEqual(rest, { enabled: true, maxWorkers: 3, idleMin: 10, overtimeMin: 45, stopBlock: true, notify: true });
  assert.ok(Array.isArray(devCommands) && devCommands.length > 5 && devCommands.every((x) => typeof x === 'string' && new RegExp(x, 'i')));
});

test('hooks.json registers the tabs guard for PreToolUse, UserPromptSubmit, Stop and SessionStart (not compact)', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const find = (event) => hooks[event].filter((g) => g.hooks.some((h) => h.command.includes('tabs-guard.cjs')));
  const pre = find('PreToolUse');
  assert.equal(pre.length, 1);
  assert.equal(pre[0].matcher, 'Bash|PowerShell');
  for (const e of ['UserPromptSubmit', 'Stop']) assert.equal(find(e).length, 1, e);
  const ss = find('SessionStart');
  assert.equal(ss.length, 1);
  assert.equal(ss[0].matcher, 'startup|resume');
  for (const e of ['PreToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart']) for (const g of find(e)) for (const h of g.hooks.filter((x) => x.command.includes('tabs-guard'))) assert.equal(h.timeout, 8);
});

test('--help prints and exits', () => {
  const r = runScript('tabs-guard.cjs', '', { args: ['--help'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /tabs-guard\.cjs: hook/);
});

// ---- fix round 1 ----
const GOODL = `${ARGS} -n lead-next ${PERM}`;
const stale = (f, h = 3) => {
  const old = new Date(Date.now() - h * 3600000);
  fs.utimesSync(f, old, old);
};

test('P1-1: a result line older than the first sighting is not a result, whatever the status (a name is reused across rounds)', () => {
  const p = project({ idleMin: 10 });
  stale(report(p, 'a1-reviewer', 'VERDICT CHANGES_REQUIRED'));
  stale(report(p, 'b1-implementer', 'DONE b1-implementer'));
  seed(p, {
    'a1-reviewer': { firstSeen: ago(20), status: 'idle', statusSince: ago(12), notified: false },
    'b1-implementer': { firstSeen: ago(20), status: 'done', statusSince: ago(2), notified: false },
  });
  const env = { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-reviewer', 'idle', p.cwd), agent('b1-implementer', 'done', p.cwd)]) };
  const text = ctx(mon(p, 'UserPromptSubmit', env));
  assert.equal(text.includes('FINISHED'), false, text);
  assert.equal(text.includes('STALLED'), false, 'a tab with a result line is never stalled without one');
  assert.equal(mon(p, 'Stop', env).out.trim(), '', 'a stale report does not block Stop');
  // a report written after the first sighting is the result
  const f = tabs.reportFile(p.cwd, 'b1-implementer');
  const now = new Date();
  fs.utimesSync(f, now, now);
  assert.match(ctx(mon(p, 'UserPromptSubmit', env)), /tabs FINISHED: b1-implementer wrote "DONE b1-implementer"/);
});

test('P1-2: once HANDOFF says status SENT for this session, Stop is silent and nothing is notified; the prompt line stays', () => {
  const p = project();
  fs.writeFileSync(path.join(p.cwd, 'HANDOFF.md'), `handoff_id: h1   status: SENT   old_session_id: ${p.sid}\nreason: ctxHandoff\n`);
  const log = path.join(p.cwd, 'notify.log');
  const env = { GHORC_CAPACITY_HERDR_JSON: hdr([agent('b1-implementer', 'blocked', p.cwd)]), GHORC_TABS_NOTIFY_LOG: log };
  assert.equal(mon(p, 'Stop', env).out.trim(), '');
  assert.match(ctx(mon(p, 'UserPromptSubmit', env)), /tabs BLOCKED: b1-implementer/);
  assert.equal(fs.existsSync(log), false);
  // the SENT of another session does not silence this one
  const q = project();
  fs.writeFileSync(path.join(q.cwd, 'HANDOFF.md'), 'handoff_id: h1   status: SENT   old_session_id: some-other-session\n');
  assert.ok(blocks(mon(q, 'Stop', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('b1-implementer', 'blocked', q.cwd)]) })));
});

test('P2-1: --help and -h of the tab commands are allowed', () => {
  const p = project();
  for (const c of ['hc run --help', 'hc run -h', 'hc run --bg --help', 'herdr tab create --help', 'herdr tab create -h', 'herdr agent start --help', 'herdr agent start -h']) {
    allowed(pre(p, c), c);
  }
  assert.ok(denied(pre(p, 'herdr tab create --cwd /w')));
});

test('P2-2: this session\'s own tab is neither a duplicate nor a worker for the limit, and no hint closes it', () => {
  const p = project();
  // hc: the lead was started as lead-next and starts the next candidate with the same documented name
  const own = hcl([term('lead-next', 'working', { address: 'self1', cwd: p.cwd, parent: '' })]);
  const cmd = HC('lead-next', 'lead', GOODL, '--outlive-parent');
  allowed(pre(p, cmd, { env: { GHORC_CAPACITY_HC_JSON: own, HC_TERMINAL_ID: 'self1' } }));
  const other = pre(p, cmd, { env: { GHORC_CAPACITY_HC_JSON: own, HC_TERMINAL_ID: 'someone-else' } });
  assert.ok(denied(other));
  assert.match(reasonOf(other), /name lead-next is already used by a live tab/);
  // herdr: the agent whose session is this one
  const mine = hdr([agent('lead-next', 'working', p.cwd, { agent_session: { value: p.sid } })]);
  allowed(pre(p, TAB('lead-next', 'lead'), { env: { GHORC_CAPACITY_HERDR_JSON: mine } }));
  assert.ok(denied(pre(p, TAB('lead-next', 'lead'), { env: { GHORC_CAPACITY_HERDR_JSON: mine }, extra: { session_id: 'another-session-id' } })));
  // a worker-named own tab does not count against the limit
  const q = project({ maxWorkers: 1 });
  const wl = hdr([agent('a-implementer', 'working', q.cwd, { agent_session: { value: q.sid } })]);
  allowed(pre(q, TAB('b-implementer', 'worker'), { env: { GHORC_CAPACITY_HERDR_JSON: wl } }));
});

test('P2-3: a candidate lead before ACTIVATE gets no Stop block and no notification; after it takes STATE over it does', () => {
  const p = project();
  const old = 'old-lead-session-id';
  const handoff = path.join(p.cwd, 'HANDOFF.md');
  const state = path.join(p.cwd, 'STATE.md');
  fs.writeFileSync(handoff, `handoff_id: h1   status: DRAFT   old_session_id: ${old}   reason: ctxHandoff\n`);
  fs.writeFileSync(state, `# STATE\nUpdated: now   Session: ${old}   seq: 3   handoff_id: h1\n`);
  const log = path.join(p.cwd, 'notify.log');
  report(p, 'a1-implementer', 'DONE a1-implementer');
  seedOld(p, { 'a1-implementer': 'idle', 'b1-implementer': 'working' });
  const env = { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'idle', p.cwd), agent('b1-implementer', 'blocked', p.cwd)]), GHORC_TABS_NOTIFY_LOG: log };
  assert.equal(mon(p, 'Stop', env).out.trim(), '');
  assert.match(ctx(mon(p, 'UserPromptSubmit', env)), /tabs BLOCKED: b1-implementer/);
  assert.equal(fs.existsSync(log), false);
  // activated: the new lead has rewritten STATE with its own session
  fs.writeFileSync(state, `# STATE\nUpdated: later   Session: ${p.sid}   seq: 4   handoff_id: h1\n`);
  assert.ok(blocks(mon(p, 'Stop', env)));
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'the notification was held back, not lost');
  // an old handoff file (older than 2 hours) is no handoff in progress
  const q = project();
  fs.writeFileSync(path.join(q.cwd, 'HANDOFF.md'), `handoff_id: h0   status: SENT   old_session_id: ${old}\n`);
  fs.writeFileSync(path.join(q.cwd, 'STATE.md'), `Updated: x   Session: ${old}   seq: 1\n`);
  stale(path.join(q.cwd, 'HANDOFF.md'), 3);
  assert.ok(blocks(mon(q, 'Stop', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('b1-implementer', 'blocked', q.cwd)]) })));
});

test('Stop blocks once per (tab, flag) occurrence: a flag that stays does not block again, a new one does', () => {
  const p = project();
  const at = (...a) => hdr(a);
  const blockedList = at(agent('a1-implementer', 'blocked', p.cwd));
  assert.ok(blocks(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: blockedList })));
  assert.equal(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: blockedList }).out.trim(), '');
  assert.equal(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: blockedList }).out.trim(), '');
  assert.match(ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: blockedList })), /BLOCKED: a1-implementer/);
  // a second tab turning BLOCKED is new
  const two = at(agent('a1-implementer', 'blocked', p.cwd), agent('b1-implementer', 'blocked', p.cwd));
  assert.ok(blocks(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: two })));
  assert.equal(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: two }).out.trim(), '');
  // it works again and then blocks again: a new occurrence
  assert.equal(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: at(agent('a1-implementer', 'working', p.cwd), agent('b1-implementer', 'working', p.cwd)) }).out.trim(), '');
  assert.ok(blocks(mon(p, 'Stop', { GHORC_CAPACITY_HERDR_JSON: blockedList })));
});

test('a report ending BLOCKED <name>: is brought to the owner, not closed now', () => {
  const p = project();
  report(p, 'a1-implementer', 'BLOCKED a1-implementer: needs a decision on the schema');
  report(p, 'b1-reviewer', 'VERDICT BLOCKED');
  seedOld(p, { 'a1-implementer': 'idle', 'b1-reviewer': 'idle' });
  const text = ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'idle', p.cwd), agent('b1-reviewer', 'idle', p.cwd)]) }));
  assert.match(text, /tabs FINISHED: a1-implementer reported "BLOCKED a1-implementer: needs a decision on the schema": BLOCKED by the worker\. Bring it to the owner; close the tab \(herdr tab list, then herdr tab close <tab_id>\) after the owner decides\./);
  assert.match(text, /tabs FINISHED: b1-reviewer reported "VERDICT BLOCKED": BLOCKED by the worker/);
  assert.equal(/close the tab now/.test(text), false);
});

test('time budget: one list call per hook run, through GHORC_HERDR_BIN / GHORC_HC_BIN', () => {
  const p = project();
  const fake = path.join(p.cwd, 'fake.cjs');
  const calls = path.join(p.cwd, 'calls.log');
  fs.writeFileSync(
    fake,
    `const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, a.join(' ') + '\\n');
process.stdout.write(a[0] === 'herdr' ? process.env.FAKE_HERDR_LIST : '{"terminals":[]}');
`,
  );
  const bins = { GHORC_HERDR_BIN: JSON.stringify([process.execPath, fake, 'herdr']), GHORC_HC_BIN: JSON.stringify([process.execPath, fake, 'hc']) };
  const both = { CLAUDE_PROJECT_DIR: p.cwd, HERDR_ENV: '1', HC_TERMINAL_ID: 'self1', ...bins };
  const two = `${TAB('a-implementer', 'worker')} && ${HC('b-implementer', 'worker', `${ARGS} -n b-implementer ${PERM}`)}`;
  const run = (command, list) =>
    runScript('tabs-guard.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: p.sid, cwd: p.cwd, tool_input: { command } }, { cwd: p.cwd, env: { ...both, FAKE_HERDR_LIST: list } });
  allowed(run(two, NONE));
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['herdr agent list'], 'the herdr list only, hc ls is not asked');
  // the list read through GHORC_HERDR_BIN decides the duplicate rule
  const r = run(TAB('a-implementer', 'worker'), hdr([agent('a-implementer', 'working', p.cwd)]));
  assert.ok(denied(r));
  assert.match(reasonOf(r), /name a-implementer is already used by a live tab/);
  // the reports read one list as well (herdr alone here: with both backends backend.prefer decides, hc by default)
  fs.rmSync(calls);
  const m = runScript('tabs-guard.cjs', ev(p, 'UserPromptSubmit'), { cwd: p.cwd, env: { ...both, HC_TERMINAL_ID: '', FAKE_HERDR_LIST: hdr([agent('a1-implementer', 'working', p.cwd)]) } });
  assert.match(ctx(m), /tabs: 1 live/);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
});

test('state files older than 7 days are removed when a state is written', () => {
  const p = project();
  const oldF = path.join(TEST_TMP, 'tabs-0000-old-session.json');
  const freshF = path.join(TEST_TMP, 'tabs-0000-new-session.json');
  fs.writeFileSync(oldF, '{"workers":{}}');
  fs.writeFileSync(freshF, '{"workers":{}}');
  const t = new Date(Date.now() - 8 * 24 * 3600000);
  fs.utimesSync(oldF, t, t);
  mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'working', p.cwd)]) });
  assert.equal(fs.existsSync(oldF), false);
  assert.equal(fs.existsSync(freshF), true);
  assert.equal(fs.existsSync(tabs.stateFile(p.sid)), true);
});

test('cwd forms (Git-Bash, \\\\?\\ prefix, separators, case) and case-insensitive names in the inventory', () => {
  const same = [
    ['/c/Users/me/Proj', 'C:\\Users\\me\\proj'],
    ['\\\\?\\C:\\Users\\me\\proj\\sub', 'c:/users/me/proj'],
    ['C:/Users/me/proj/', 'C:\\Users\\me\\proj'],
    ['C:\\Users\\me\\proj\\.claude\\worktrees\\x', 'C:\\Users\\me\\proj'],
    ['//?/C:/Users/me/proj', 'C:\\Users\\me\\proj'],
  ];
  for (const [cwd, root] of same) assert.ok(tabs.inside(cwd, root), `${cwd} in ${root}`);
  assert.equal(tabs.inside('/c/Users/me/proj2', 'C:\\Users\\me\\proj'), false);
  assert.equal(tabs.inside('/d/Users/me/proj', 'C:\\Users\\me\\proj'), false);
  assert.equal(tabs.inside('', 'C:\\Users\\me\\proj'), false);
  const p = project();
  const gitBash = p.cwd.replace(/^([A-Za-z]):[\\/]/, (m, d) => `/${d.toLowerCase()}/`).split('\\').join('/');
  const list = hdr([agent('A1-Implementer', 'blocked', gitBash)]);
  assert.match(ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list })), /^tabs: 1 live \(A1-Implementer blocked 0m\)/);
  // a new start must still be lowercase
  assert.ok(denied(pre(p, TAB('A1-Implementer', 'worker'))));
});

// ---- TABS-2 ----
// one backend only: dev-command rule and workspace rules read the backend of the session
const only = (p, kind, env = {}) => ({ CLAUDE_PROJECT_DIR: p.cwd, ...(kind === 'hc' ? { GHORC_CAPACITY_HC_JSON: hcl([]) } : kind === 'herdr' ? { GHORC_CAPACITY_HERDR_JSON: NONE } : {}), ...env });
const run1 = (p, command, kind, { tool = 'Bash', env = {}, extra = {}, input = {} } = {}) =>
  runScript('tabs-guard.cjs', { hook_event_name: 'PreToolUse', tool_name: tool, session_id: p.sid, cwd: p.cwd, tool_input: { command, ...input }, ...extra }, { cwd: p.cwd, env: only(p, kind, env) });

const DEV_DENIED = [
  'npm run dev', 'npm start', 'npm run start', 'pnpm dev', 'yarn start', 'bun run dev', 'npm run serve', 'npm run watch', 'npm run preview', 'npm --prefix web run dev', 'pnpm --filter web dev',
  'vite', 'vite --port 3000', 'npx vite', 'next dev', 'npx next dev -p 3001', 'nuxt dev', 'astro dev', 'nodemon app.js', 'webpack serve', 'webpack-dev-server', 'http-server .', 'npx live-server',
  'tsc --watch', 'tsc -w', 'jest --watch', 'vitest --watch', 'rollup -c -w', 'esbuild src/a.ts --watch',
  'docker compose up', 'docker-compose up', 'docker compose up --build',
  'php artisan serve', 'rails s', 'rails server', 'python -m http.server 8000', 'flask run', 'uvicorn app:app', 'gunicorn app:app', 'python manage.py runserver', 'dotnet watch run',
  'cd web && npm run dev', 'FOO=1 npm run dev',
];
const DEV_ALLOWED = [
  'npm run build', 'npm test', 'npm run lint', 'npm ci', 'npm run watch-types', 'vite build', 'vitest run', 'jest --watch=false', 'webpack', 'tsc', 'tsc --noEmit', 'docker compose up -d', 'docker compose up --detach', 'docker-compose up -d --build',
  'docker compose down', 'git log', 'git commit -m "npm run dev"', 'grep "npm run dev" README.md', 'echo "npm start"', 'cat package.json',
];

test('A: dev servers and watchers are denied on hc and on herdr, one-shot commands stay allowed', () => {
  const p = project();
  for (const kind of ['hc', 'herdr']) {
    for (const c of DEV_DENIED) assert.ok(denied(run1(p, c, kind)), `${kind}: ${c}`);
    for (const c of DEV_ALLOWED) allowed(run1(p, c, kind), `${kind}: ${c}`);
  }
});

test('A: the lead gets the runner form of its backend', () => {
  const p = project();
  const h = reasonOf(run1(p, 'npm run dev', 'herdr'));
  assert.match(h, /"npm run dev" is a long-running process \(matches tabs\.devCommands\)/);
  assert.ok(h.includes('herdr tab create --workspace "$HERDR_WORKSPACE_ID" --no-focus --label <pkg>-runner --cwd <dir>, then herdr pane run <pane_id> "npm run dev"'), h);
  const c = reasonOf(run1(p, 'npm run dev', 'hc'));
  assert.ok(c.includes('hc run --bg --outlive-parent --name <pkg>-runner --cwd <dir> npm run dev'), c);
  const ps = reasonOf(run1(p, 'npm run dev', 'herdr', { tool: 'PowerShell' }));
  assert.ok(ps.includes('--workspace $env:HERDR_WORKSPACE_ID --no-focus'), ps);
});

test('A: a subagent and a worker are told to end BLOCKED with the exact command', () => {
  const p = project();
  for (const r of [run1(p, 'cd web && npm run dev', 'hc', { extra: { agent_id: 'sub1' } }), run1(p, 'cd web && npm run dev', 'hc', { env: { GHORC_ROLE: 'worker' } })]) {
    assert.ok(denied(r));
    const why = reasonOf(r);
    assert.match(why, /end your report with BLOCKED <name>: <why>, with the exact command `cd web && npm run dev`/);
    assert.match(why, /the lead starts it in a runner tab/);
    assert.equal(why.includes('Runner form'), false);
  }
  // the rest of the guard stays out of their way
  allowed(run1(p, TAB('Bad', null), 'herdr', { extra: { agent_id: 'sub1' } }));
  allowed(run1(p, 'npm test', 'hc', { extra: { agent_id: 'sub1' } }));
});

test('A: run_in_background does not make a dev command pass, and is named in the reason', () => {
  const p = project();
  const r = run1(p, 'npm run dev', 'hc', { input: { run_in_background: true } });
  assert.ok(denied(r));
  assert.match(reasonOf(r), /A background task \(run_in_background\) hides it just the same/);
  assert.equal(reasonOf(run1(p, 'npm run dev', 'hc')).includes('run_in_background'), false);
  allowed(run1(p, 'npm test', 'hc', { input: { run_in_background: true } }));
  allowed(run1(p, 'npm run build', 'herdr', { input: { run_in_background: true } }));
});

test('A: backend none, tabs.enabled false and devCommands [] allow; a custom list is used', () => {
  const p = project();
  allowed(run1(p, 'npm run dev', 'none'));
  const off = project({ enabled: false });
  allowed(run1(off, 'npm run dev', 'hc'));
  const empty = project({ devCommands: [] });
  allowed(run1(empty, 'npm run dev', 'hc'));
  const custom = project({ devCommands: ['^my-server(?:\\s|$)'] });
  assert.ok(denied(run1(custom, 'my-server --port 1', 'hc')));
  allowed(run1(custom, 'npm run dev', 'hc'));
  // an invalid config never denies here
  const bad = project({ devCommands: ['(unclosed'] });
  allowed(run1(bad, 'npm run dev', 'hc'));
});

test('A: the payload of a tab launch is allowed, a dev command in a non-runner hc tab is not', () => {
  const p = project();
  for (const kind of ['hc', 'herdr']) {
    allowed(run1(p, 'herdr pane run w1:p1 "npm run dev"', kind), kind);
    allowed(run1(p, 'herdr pane run w1:p1 "docker compose up"', kind), kind);
  }
  allowed(run1(p, 'hc run --bg --outlive-parent --name a-runner --cwd /w npm run dev', 'hc'));
  allowed(run1(p, 'hc run --bg --outlive-parent --name a-runner --cwd /w docker compose up', 'hc'));
  const r = run1(p, 'hc run --bg --name a-implementer --cwd /w npm run dev', 'hc');
  assert.ok(denied(r));
  assert.match(reasonOf(r), /"npm run dev" is a long-running process \(tabs\.devCommands\): it runs only in a runner tab/);
  assert.ok(denied(run1(p, 'hc run --bg --name a-full --outlive-parent --cwd /w npm start', 'hc')));
  // the runner without --outlive-parent keeps its own rule
  assert.match(reasonOf(run1(p, 'hc run --bg --name a-runner --cwd /w npm run dev', 'hc')), /start it with --outlive-parent/);
});

test('A: devCommands is validated', () => {
  const check = (devCommands) => validate.check(tmpProject({ tabs: { devCommands } }), { cli: true }).problems;
  assert.deepEqual(check([]), []);
  assert.deepEqual(check(['^npm\\s+run\\s+dev']), []);
  assert.ok(check(['(unclosed']).some((x) => /tabs\.devCommands\[0\]: regex does not compile/.test(x)));
  assert.ok(check(['']).some((x) => /tabs\.devCommands\[0\]: an empty pattern/.test(x)));
  assert.ok(check([1]).some((x) => /tabs\.devCommands\[0\]: not a string/.test(x)));
  assert.ok(check('npm run dev').some((x) => /tabs\.devCommands: expected array, got string/.test(x)));
});

// ---- B: the own workspace ----
const WS = { HERDR_WORKSPACE_ID: 'w1' };
const hpre = (p, command, env = {}, o = {}) => run1(p, command, 'herdr', { env: { ...WS, ...env }, ...o });
const GOODARGS = `${ARGS} -n a-implementer ${PERM}`;

test('B: herdr tab create needs --workspace of the own workspace and --no-focus', () => {
  const p = project();
  const base = 'herdr tab create --label a-implementer --cwd /w --env GHORC_ROLE=worker';
  const noWs = hpre(p, `${base} --no-focus`);
  assert.ok(denied(noWs));
  assert.match(reasonOf(noWs), /--workspace is missing: without it herdr creates the tab in the UI-focused workspace/);
  assert.match(reasonOf(noWs), /Corrected form: herdr tab create .*--no-focus --workspace "\$HERDR_WORKSPACE_ID"/);
  const noFocus = hpre(p, `${base} --workspace w1`);
  assert.ok(denied(noFocus));
  assert.match(reasonOf(noFocus), /--no-focus is missing/);
  assert.match(reasonOf(noFocus), /Corrected form: .*--workspace w1 --no-focus/);
  // the own workspace: the literal id and every reference form
  for (const ws of ['w1', '$HERDR_WORKSPACE_ID', '"$HERDR_WORKSPACE_ID"', '"${HERDR_WORKSPACE_ID}"', '${HERDR_WORKSPACE_ID}', '%HERDR_WORKSPACE_ID%', "'w1'", '--workspace=w1']) {
    const text = ws.startsWith('--') ? `${base} ${ws} --no-focus` : `${base} --workspace ${ws} --no-focus`;
    allowed(hpre(p, text), ws);
  }
  allowed(hpre(p, `${base} --workspace $env:HERDR_WORKSPACE_ID --no-focus`, {}, { tool: 'PowerShell' }));
  // another workspace
  const other = hpre(p, `${base} --workspace w2 --no-focus`);
  assert.ok(denied(other));
  assert.match(reasonOf(other), /--workspace w2 is not this pane's workspace \(w1\)/);
  assert.match(reasonOf(other), /Corrected form: .*--workspace "\$HERDR_WORKSPACE_ID" --no-focus/);
  assert.ok(denied(hpre(p, `${base} --workspace "w2" --no-focus`)));
  // the own workspace unknown: presence checks only
  allowed(hpre(p, `${base} --workspace w2 --no-focus`, { HERDR_WORKSPACE_ID: '' }));
  assert.ok(denied(hpre(p, `${base} --no-focus`, { HERDR_WORKSPACE_ID: '' })));
  assert.ok(denied(hpre(p, `${base} --workspace w2`, { HERDR_WORKSPACE_ID: '' })));
  // PowerShell corrected form uses $env:
  const ps = hpre(p, `${base} --no-focus`, {}, { tool: 'PowerShell' });
  assert.match(reasonOf(ps), /--workspace \$env:HERDR_WORKSPACE_ID/);
});

test('B: herdr pane split needs --no-focus', () => {
  const p = project();
  const r = hpre(p, 'herdr pane split --pane w1:p1 --direction right');
  assert.ok(denied(r));
  assert.match(reasonOf(r), /herdr pane split needs --no-focus/);
  assert.match(reasonOf(r), /Corrected form: herdr pane split --pane w1:p1 --direction right --no-focus/);
  allowed(hpre(p, 'herdr pane split --pane w1:p1 --direction right --no-focus'));
  assert.ok(denied(hpre(p, 'herdr pane split --pane w1:p1', { HERDR_WORKSPACE_ID: '' })));
});

test('B: the lead may not close, split or start in another workspace, but operator actions are not judged', () => {
  const p = project();
  const bad = [
    'herdr pane close w2:p1',
    'herdr pane split --pane w2:p1 --no-focus',
    'herdr tab close w2:t1',
    'herdr tab close --tab w2:t1',
    `herdr agent start a-implementer --kind claude --pane w2:p1 -- ${GOODARGS}`,
  ];
  for (const c of bad) {
    const r = hpre(p, c);
    assert.ok(denied(r), c);
    assert.match(reasonOf(r), /is in workspace w2, this pane is in w1: the lead acts in its own workspace only/, c);
  }
  for (const c of ['herdr pane close w1:p2', 'herdr tab close w1:t1', `herdr agent start a-implementer --kind claude --pane w1:p1 -- ${GOODARGS}`, 'herdr pane split --pane w1:p1 --no-focus', 'herdr agent list']) {
    allowed(hpre(p, c), c);
  }
  // prompting, sending keys or text, running in or reading a pane of another workspace is what the owner may ask for
  for (const c of ['herdr pane run w2:p1 "ls"', 'herdr pane send-keys w2:p3 enter', 'herdr pane send-text w2:p3 hello', 'herdr pane read w2:p1', 'herdr agent prompt w2:p1 "go"', 'herdr agent send-keys w2:p1 enter', 'herdr agent prompt b-implementer "go"']) {
    allowed(hpre(p, c), c);
  }
  // the own workspace unknown: nothing to compare with
  allowed(hpre(p, 'herdr pane close w2:p1', { HERDR_WORKSPACE_ID: '' }));
  // a worker is not checked here
  allowed(hpre(p, 'herdr pane close w2:p1', { GHORC_ROLE: 'worker' }));
});

test('B (round 3): the own workspace comes from the prefix of HERDR_PANE_ID; a disagreeing or missing id means presence checks only', () => {
  assert.equal(tabs.ownWorkspace({ HERDR_PANE_ID: 'w4:p1' }), 'w4');
  assert.equal(tabs.ownWorkspace({ HERDR_PANE_ID: 'w4:p1', HERDR_WORKSPACE_ID: 'w4' }), 'w4');
  assert.equal(tabs.ownWorkspace({ HERDR_PANE_ID: 'w4:p1', HERDR_WORKSPACE_ID: '3f2a-uuid' }), '');
  assert.equal(tabs.ownWorkspace({ HERDR_WORKSPACE_ID: 'W2' }), 'w2');
  assert.equal(tabs.ownWorkspace({}), '');
  const p = project();
  const base = 'herdr tab create --label a-implementer --cwd /w --env GHORC_ROLE=worker --no-focus';
  // the pane id decides
  allowed(hpre(p, `${base} --workspace w4`, { HERDR_WORKSPACE_ID: '', HERDR_PANE_ID: 'w4:p1' }));
  assert.ok(denied(hpre(p, `${base} --workspace w2`, { HERDR_WORKSPACE_ID: '', HERDR_PANE_ID: 'w4:p1' })));
  assert.ok(denied(hpre(p, 'herdr pane close w2:p1', { HERDR_WORKSPACE_ID: '', HERDR_PANE_ID: 'w4:p1' })));
  // a variable that disagrees with the pane id (an unverified form): no confinement, presence only
  allowed(hpre(p, `${base} --workspace w2`, { HERDR_WORKSPACE_ID: '3f2a-uuid', HERDR_PANE_ID: 'w4:p1' }));
  allowed(hpre(p, 'herdr pane close w2:p1', { HERDR_WORKSPACE_ID: '3f2a-uuid', HERDR_PANE_ID: 'w4:p1' }));
  assert.ok(denied(hpre(p, base, { HERDR_WORKSPACE_ID: '3f2a-uuid', HERDR_PANE_ID: 'w4:p1' })), 'the presence of --workspace is still required');
});

test('B (round 3): only the exact variable counts as a reference; single quotes and typos are denied', () => {
  const p = project();
  const base = 'herdr tab create --label a-implementer --cwd /w --env GHORC_ROLE=worker --no-focus';
  for (const ws of ["'$HERDR_WORKSPACE_ID'", "'$env:HERDR_WORKSPACE_ID'", '"$HERDR_WORKSPACE"', '$WS', '"$HERDR_WORKSPACE_ID/x"', '%HERDR_WORKSPACE%']) {
    for (const own of ['w1', '']) {
      const r = hpre(p, `${base} --workspace ${ws}`, { HERDR_WORKSPACE_ID: own });
      assert.ok(denied(r), `${ws} (own ${own || 'unknown'})`);
      assert.match(reasonOf(r), /does not name the own workspace: a single-quoted reference is not expanded and only the exact variable counts/);
      assert.match(reasonOf(r), /Corrected form: .*--workspace "\$HERDR_WORKSPACE_ID"/);
    }
  }
  for (const ws of ['$HERDR_WORKSPACE_ID', '"$HERDR_WORKSPACE_ID"', '$env:HERDR_WORKSPACE_ID', '%HERDR_WORKSPACE_ID%', '"${HERDR_WORKSPACE_ID}"']) allowed(hpre(p, `${base} --workspace ${ws}`), ws);
});

test('B: workspace create and close are the owner\'s', () => {
  const p = project();
  for (const c of ['herdr workspace create --label x', 'herdr workspace close w2']) {
    const r = hpre(p, c);
    assert.ok(denied(r), c);
    assert.match(reasonOf(r), /herdr workspace (create|close) is the owner's/);
    assert.ok(denied(hpre(p, c, { HERDR_WORKSPACE_ID: '' })), `${c} without the own workspace`);
  }
  allowed(hpre(p, 'herdr workspace list'));
  allowed(hpre(p, 'herdr workspace create --label x', { GHORC_ROLE: 'worker' }));
});

test('B: inventory, duplicate and limit count only the own workspace', () => {
  const p = project({ maxWorkers: 2 });
  const inOther = hdr([
    agent('a-implementer', 'working', p.cwd, { pane_id: 'w2:p1' }),
    agent('b-implementer', 'working', p.cwd, { pane_id: 'w2:p2' }),
    agent('c-reviewer', 'working', p.cwd, { pane_id: 'w2:p3' }),
  ]);
  const env = { GHORC_CAPACITY_HERDR_JSON: inOther };
  allowed(hpre(p, TAB('a-implementer', 'worker'), env), 'same name in another workspace');
  allowed(hpre(p, TAB('d-implementer', 'worker'), env), 'the limit is per workspace');
  // the same list without the own workspace known: everything counts
  assert.ok(denied(hpre(p, TAB('d-implementer', 'worker'), { ...env, HERDR_WORKSPACE_ID: '' })));
  const mine = hdr([agent('a-implementer', 'working', p.cwd, { pane_id: 'w1:p1' }), agent('b-implementer', 'working', p.cwd, { pane_id: 'w1:p2' })]);
  assert.ok(denied(hpre(p, TAB('d-implementer', 'worker'), { GHORC_CAPACITY_HERDR_JSON: mine })));
  assert.ok(denied(hpre(p, TAB('a-implementer', 'worker'), { GHORC_CAPACITY_HERDR_JSON: mine })));
  // the report lists the own workspace only
  const mixed = hdr([agent('a-implementer', 'working', p.cwd, { pane_id: 'w1:p1' }), agent('b-implementer', 'working', p.cwd, { pane_id: 'w2:p2' })]);
  const text = ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: mixed, ...WS }));
  assert.equal(text, 'tabs: 1 live (a-implementer working 0m)');
  const all = ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: mixed }));
  assert.match(all, /^tabs: 2 live/);
});

// ---- C ----
test('C: a name starts with a letter and has at most 32 characters; the reason says so', () => {
  const p = project();
  const r = pre(p, TAB('1a-implementer', 'worker'));
  assert.ok(denied(r));
  assert.match(reasonOf(r), /must start with a letter/);
  assert.match(reasonOf(r), /starts with a lowercase letter, then \[a-z0-9-\], at most 32 characters in all/);
  const long = pre(p, TAB(`${'a'.repeat(21)}-implementer`, 'worker'));
  assert.ok(denied(long));
  assert.match(reasonOf(long), /longer than 32 characters/);
  allowed(pre(p, TAB(`${'a'.repeat(20)}-implementer`, 'worker')));
  assert.ok(denied(pre(p, HC('9a-implementer', 'worker', `${ARGS} -n 9a-implementer ${PERM}`))));
  assert.match(tabs.POLICY_TEXT, /32 characters/);
});

// ---- D ----
test('D: a result line present at the first sighting is a soft RESULT? line that never blocks Stop', () => {
  const p = project();
  const f = report(p, 'a1-implementer', 'DONE a1-implementer');
  const d = fs.statSync(f).mtime;
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const list = hdr([agent('a1-implementer', 'idle', p.cwd), agent('b1-implementer', 'working', p.cwd)]);
  report(p, 'b1-implementer', 'DONE b1-implementer');
  const first = mon(p, 'SessionStart', { GHORC_CAPACITY_HERDR_JSON: list }, { source: 'startup' });
  const lines = ctx(first).split('\n');
  assert.equal(lines[0], 'tabs: 2 live (a1-implementer idle 0m, b1-implementer working 0m)');
  assert.ok(lines.includes(`tabs RESULT?: a1-implementer has a result line from ${hhmm}: if it is the current round, accept it and close the tab`), ctx(first));
  assert.equal(lines.filter((l) => /RESULT\?/.test(l)).length, 1, 'a working tab has not finished');
  assert.equal(lines.some((l) => /FINISHED/.test(l)), false);
  // it never blocks Stop (also not with a first sighting at Stop)
  const q = project();
  report(q, 'a1-implementer', 'DONE a1-implementer');
  assert.equal(mon(q, 'Stop', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'idle', q.cwd)]) }).out.trim(), '');
  // only the first sighting asks: the second run is quiet about it
  assert.equal(ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list })).includes('RESULT?'), false);
  // a worker without a result line has nothing to ask
  const r = project();
  assert.equal(ctx(mon(r, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'idle', r.cwd)]) })), 'tabs: 1 live (a1-implementer idle 0m)');
});

// ---- TABS-3 ----
test('R3-1: a project without .claude/ghorc.json is neither judged nor reported', () => {
  const none = { cwd: fs.realpathSync.native(tmpProject()), sid: SID() };
  assert.equal(fs.existsSync(path.join(none.cwd, '.claude', 'ghorc.json')), false);
  const withCfg = project();
  for (const [kind, cmd] of [['hc', 'npm run dev'], ['herdr', 'docker compose up'], ['herdr', 'herdr tab create --label scratch'], ['herdr', 'herdr pane split --pane w1:p1'], ['hc', 'hc run --bg npm test']]) {
    allowed(run1(none, cmd, kind, { env: WS }), `no config: ${cmd}`);
    if (kind === 'herdr' || cmd === 'npm run dev') assert.ok(denied(run1(withCfg, cmd, kind, { env: WS })), `config: ${cmd}`);
  }
  allowed(run1(none, 'npm run dev', 'hc', { extra: { agent_id: 'sub1' } }));
  allowed(run1(none, 'npm run dev', 'hc', { env: { GHORC_ROLE: 'worker' } }));
  // no report and no Stop block either
  const env = { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'blocked', none.cwd)]) };
  assert.equal(mon(none, 'UserPromptSubmit', env).out, '');
  assert.equal(mon(none, 'SessionStart', env).out, '');
  assert.equal(mon(none, 'Stop', env).out, '');
  assert.ok(blocks(mon(withCfg, 'Stop', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', 'blocked', withCfg.cwd)]) })));
});

test('R3-4: long-lived command tabs need no GHORC_ROLE on herdr tab create; every corrected form the guard prints is allowed when fed back', () => {
  const p = project();
  for (const label of ['a-runner', 'a-full', 'a-train']) allowed(pre(p, TAB(label, null)), label);
  assert.ok(denied(pre(p, TAB('a-implementer', null))));
  assert.ok(denied(pre(p, TAB('lead-next', null))));
  // the runner form of the dev reason passes as printed
  const reason = reasonOf(run1(p, 'npm run dev', 'herdr'));
  const form = /(herdr tab create [^,]*), then/.exec(reason)[1].replace('<pkg>', 'a').replace('<dir>', '/w');
  allowed(run1(p, form, 'herdr'), form);

  // feed the corrected forms back
  const bad = [
    ['herdr', 'herdr tab create --cwd /w'],
    ['herdr', 'herdr tab create --label Big-Name --cwd /w'],
    ['herdr', 'herdr tab create --label a-implementer'],
    ['herdr', 'herdr tab create --label lead-next --workspace w1'],
    ['herdr', 'herdr tab create --label a-implementer --env GHORC_ROLE=worker --workspace w2 --no-focus'],
    ['herdr', "herdr tab create --label a-implementer --env GHORC_ROLE=worker --workspace '$HERDR_WORKSPACE_ID' --no-focus"],
    ['herdr', 'herdr pane split --pane w1:p1 --direction right'],
    ['herdr', 'herdr agent start x-implementer --kind claude --pane w1:p1 -- --model claude-opus-5-5 --effort medium'],
    ['herdr', 'herdr agent start x-implementer --kind claude --pane w1:p1'],
    ['herdr', 'herdr agent start lead-next --kind claude --pane w1:p1 -- --model opus --effort max -n other'],
    ['hc', 'hc run --bg --cwd /w claude --model opus --effort medium "do it"'],
    ['hc', HC('a-implementer', null, '--model claude-opus-5-5 --effort medium')],
    ['hc', HC('a-implementer', 'lead', `${ARGS} -n a-implementer ${PERM}`)],
    ['hc', HC('a-full', 'worker', `${ARGS} -n a-full ${PERM}`)],
    ['hc', 'hc run --bg --name a-runner npm run dev'],
    ['hc', HC('Big', 'worker', ARGS)],
  ];
  let fed = 0;
  for (const [kind, cmd] of bad) {
    const r = run1(p, cmd, kind, { env: WS });
    assert.ok(denied(r), cmd);
    const why = reasonOf(r);
    for (const m of why.matchAll(/Corrected form: (.*)/g)) {
      const fixed = m[1].split('<pkg>-<kind>').join('a1-implementer').split('lead-<name>').join('lead-next').split('"<task>"').join('"do it"');
      const again = run1(p, fixed, kind, { env: WS });
      assert.equal(again.out.trim(), '', `${cmd}\n  -> ${fixed}\n  -> ${again.out}`);
      fed++;
    }
  }
  assert.ok(fed >= bad.length - 2, `corrected forms fed back: ${fed}`);
});

test('R3-5: dev patterns: jest -w is maxWorkers, docker compose up with an exit flag, :-names, --version, and the bypasses', () => {
  const pats = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'defaults.json'), 'utf8')).tabs.devCommands;
  const denyList = [
    ...DEV_DENIED,
    'next start', 'yarn workspace web dev', 'yarn workspace web run dev', 'npm run --silent dev', 'npm run --prefix web dev', 'pnpm run --filter web dev', 'pnpm exec vite', 'pnpm dlx vite', 'bunx vite', 'bunx --bun vite',
    'yarn dlx vite', 'vitest watch', 'vitest dev', 'vitest --watch', 'jest --watchAll', 'jest --watch', 'docker compose up --build web',
  ];
  const allowList = [
    ...DEV_ALLOWED,
    'jest -w 4', 'jest', 'jest --maxWorkers=2', 'vitest', 'vitest run', 'vitest run --coverage', 'next build', 'vite build',
    'docker compose up --abort-on-container-exit --exit-code-from tests', 'docker compose up --exit-code-from tests --build', 'docker compose up --wait', 'docker compose up -d',
    'npm run dev:setup', 'npm run start:check', 'npm run start-check', 'npm run watch-types', 'yarn dev:server', 'pnpm run dev:seed',
    'vite --version', 'vite -v', 'vite --help', 'uvicorn --version', 'nodemon --version', 'nodemon -h', 'tsc -w --help', 'next dev --help', 'npm --version', 'jest --watch=false',
  ];
  for (const c of denyList) assert.ok(tabs.devMatch(c, pats, false), `should match: ${c}`);
  for (const c of allowList) assert.equal(tabs.devMatch(c, pats, false), null, `should not match: ${c}`);
  // through the hook too
  const p = project();
  for (const c of ['next start', 'pnpm exec vite', 'bunx vite', 'yarn workspace web dev', 'npm run --silent dev', 'vitest watch']) assert.ok(denied(run1(p, c, 'hc')), c);
  for (const c of ['jest -w 4', 'docker compose up --exit-code-from tests', 'npm run dev:setup', 'vite --version']) allowed(run1(p, c, 'hc'), c);
});

test('R3-5: a bad regex in devCommands drops that one pattern, the guard and the other rules stay on', () => {
  const p = project({ devCommands: ['(unclosed', '^my-server(?:\\s|$)'] });
  assert.ok(denied(run1(p, 'my-server --port 1', 'hc')));
  assert.ok(denied(run1(p, TAB('Bad_x', 'worker'), 'herdr')), 'the tab rules stay on');
  const r = validate.check(p.cwd, { cli: true });
  assert.ok(r.problems.some((x) => /tabs\.devCommands\[0\]: regex does not compile/.test(x)), 'validation still reports it');
  assert.deepEqual(r.fatal, []);
  assert.ok(tabs.devMatch('my-server', ['(unclosed', '^my-server(?:\\s|$)'], false));
});

test('R3-6: a tab with a result line is never STALLED without one; after RESULT? it stays quiet until its status changes', () => {
  const p = project({ idleMin: 10, overtimeMin: 45 });
  const pre = path.join(__dirname, 'mock-now.cjs').split('\\').join('/');
  const at = (ms, list) => mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list, NODE_OPTIONS: `--require "${pre}"`, GHORC_MOCK_NOW_MS: String(ms) });
  const T = Date.now() + 3600000;
  report(p, 'a1-scout', 'DONE a1-scout');
  const idle = hdr([agent('a1-scout', 'idle', p.cwd)]);
  const first = ctx(at(T, idle));
  assert.match(first, /tabs RESULT\?: a1-scout has a result line from \d\d:\d\d/);
  for (const min of [5, 12, 30, 50, 80]) {
    const text = ctx(at(T + min * 60000, idle));
    assert.equal(/STALLED|OVERTIME|RESULT\?/.test(text), false, `${min}m: ${text}`);
  }
  // the status changes: the result line still exists, so never STALLED; OVERTIME counts again
  assert.equal(/STALLED/.test(ctx(at(T + 81 * 60000, hdr([agent('a1-scout', 'working', p.cwd)])))), false);
  assert.equal(/STALLED/.test(ctx(at(T + 120 * 60000, idle))), false);
  // a tab without a result line is stalled as before
  const q = project({ idleMin: 10 });
  const at2 = (ms, list) => mon(q, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list, NODE_OPTIONS: `--require "${pre}"`, GHORC_MOCK_NOW_MS: String(ms) });
  const l2 = hdr([agent('b1-scout', 'idle', q.cwd)]);
  at2(T, l2);
  assert.match(ctx(at2(T + 11 * 60000, l2)), /tabs STALLED: b1-scout has been idle 11m without a result line/);
});

test('R3-7: an unknown status is shown, without a Stop block', () => {
  const p = project();
  for (const status of ['waiting', 'needs_input', 'unknown', '']) {
    const q = project();
    const env = { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', status, q.cwd)]) };
    const lines = ctx(mon(q, 'UserPromptSubmit', env)).split('\n');
    assert.ok(lines.includes(`tabs UNKNOWN: a1-implementer reports status ${JSON.stringify(status)}: read its screen`), JSON.stringify(lines));
    assert.equal(mon(q, 'Stop', env).out.trim(), '');
  }
  for (const status of ['working', 'idle', 'done', 'blocked']) {
    const q = project();
    assert.equal(/UNKNOWN/.test(ctx(mon(q, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: hdr([agent('a1-implementer', status, q.cwd)]) }))), false, status);
  }
  void p;
});

test('R3-8: live agents of this workspace and project with names that break the policy are listed as BADNAME', () => {
  const p = project();
  const long = `${'a'.repeat(30)}-implementer`;
  const list = hdr([
    agent('Big_Name', 'working', p.cwd, { pane_id: 'w1:p1' }),
    agent(long, 'idle', p.cwd, { pane_id: 'w1:p2' }),
    agent('claude', 'idle', p.cwd, { pane_id: 'w1:p3' }),
    agent('x-implementer', 'working', p.cwd, { pane_id: 'w1:p4' }),
    agent('lead-main', 'working', p.cwd, { pane_id: 'w1:p5' }),
    agent('Other-Ws', 'working', p.cwd, { pane_id: 'w2:p1' }),
    agent('Other-Dir', 'working', '/elsewhere', { pane_id: 'w1:p6' }),
    agent('My-Own-Tab', 'working', p.cwd, { pane_id: 'w1:p7', agent_session: { value: p.sid } }),
  ]);
  const text = ctx(mon(p, 'UserPromptSubmit', { GHORC_CAPACITY_HERDR_JSON: list, ...WS }));
  const lines = text.split('\n');
  assert.equal(lines[0], 'tabs: 1 live (x-implementer working 0m)');
  const bad = lines.filter((l) => l.startsWith('tabs BADNAME:'));
  assert.equal(bad.length, 3, text);
  assert.match(bad[0], /^tabs BADNAME: "Big_Name" \(working\) breaks the tab naming policy \(only lowercase letters, digits and "-" are allowed\), so it is neither counted nor watched: rename it or close it$/);
  assert.match(bad[1], new RegExp(`"${long}" \\(idle\\) breaks the tab naming policy \\(longer than 32 characters\\)`));
  assert.match(bad[2], /"claude" \(idle\) breaks the tab naming policy \(not <pkg>-<kind>/);
  // alone, without a valid worker, the lines are still shown; Stop is not blocked by them
  const q = project();
  const only = { GHORC_CAPACITY_HERDR_JSON: hdr([agent('Big_Name', 'working', q.cwd)]) };
  assert.match(ctx(mon(q, 'UserPromptSubmit', only)), /^tabs BADNAME: "Big_Name"/);
  assert.equal(mon(q, 'Stop', only).out.trim(), '');
  // hc: a claude-code terminal of this terminal or the project; shells and this terminal itself are not listed
  const r = project();
  const hcList = hcl([
    term('Odd', 'working', { cwd: '/elsewhere', parent: 'self1' }),
    term('', 'idle', { cwd: r.cwd, parent: 'someone' }),
    term('shell', 'idle', { cwd: r.cwd, agent: '' }),
    term('self-lead', 'working', { cwd: r.cwd, address: 'self1', parent: '' }),
    term('Foreign', 'working', { cwd: '/elsewhere', parent: 'someone' }),
  ]);
  const hlines = ctx(mon(r, 'UserPromptSubmit', { GHORC_CAPACITY_HC_JSON: hcList, HC_TERMINAL_ID: 'self1' })).split('\n').filter((l) => l.startsWith('tabs BADNAME:'));
  assert.equal(hlines.length, 2);
  assert.match(hlines[0], /"Odd"/);
  assert.match(hlines[1], /\(no name\)/);
});

test('R3-9: hc duplicate and limit checks count only this terminal\'s children and the project', () => {
  const p = project({ maxWorkers: 1 });
  const good = `${ARGS} -n b-implementer ${PERM}`;
  const foreign = hcl([term('a-implementer', 'working', { cwd: '/some/other/project', parent: 'someone-else' }), term('b-implementer', 'working', { cwd: '/some/other/project', parent: 'someone-else' })]);
  allowed(pre(p, HC('b-implementer', 'worker', good), { env: { GHORC_CAPACITY_HC_JSON: foreign, HC_TERMINAL_ID: 'self1' } }), 'a foreign project\'s terminals are neither duplicates nor workers');
  const mine = hcl([term('a-implementer', 'working', { cwd: '/some/other/project', parent: 'self1' })]);
  assert.ok(denied(pre(p, HC('b-implementer', 'worker', good), { env: { GHORC_CAPACITY_HC_JSON: mine, HC_TERMINAL_ID: 'self1' } })), 'a child of this terminal counts');
  const inProject = hcl([term('b-implementer', 'working', { cwd: p.cwd, parent: 'someone-else' })]);
  assert.match(reasonOf(pre(p, HC('b-implementer', 'worker', good), { env: { GHORC_CAPACITY_HC_JSON: inProject, HC_TERMINAL_ID: 'self1' } })), /name b-implementer is already used by a live tab/);
});
