'use strict';
// Two terminal backends (hc of herdr-app and the older herdr CLI): detection, worker counts, the command forms that
// subagents and workers may not run. The tools are replaced by a fake program, nothing here starts a real hc or herdr.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript, isDeny, tmpProject, sid, TEST_TMP } = require('./helpers.cjs');
const backend = require('../scripts/lib/backend.cjs');
const cap = require('../scripts/lib/capacity.cjs');
const cmd = require('../scripts/lib/cmd.cjs');

// ---- a fake hc / herdr --------------------------------------------------------------------------------------------
// FAKE_DIR holds one file per call: "<args joined by _>.out" is printed on stdout, ".err" on stderr, ".code" is the exit code.
// A call without a file exits 3 and prints "unscripted: <args>" on stderr.
const FAKE = path.join(TEST_TMP, 'fake-tool.cjs');
fs.writeFileSync(
  FAKE,
  `const fs=require('fs'),path=require('path');
const key=process.argv.slice(2).join('_');
const f=(e)=>path.join(process.env.FAKE_DIR,key+'.'+e);
if(!fs.existsSync(f('out'))&&!fs.existsSync(f('err'))&&!fs.existsSync(f('code'))){console.error('unscripted: '+key);process.exit(3);}
if(fs.existsSync(f('out')))process.stdout.write(fs.readFileSync(f('out'),'utf8'));
if(fs.existsSync(f('err')))process.stderr.write(fs.readFileSync(f('err'),'utf8'));
process.exit(fs.existsSync(f('code'))?Number(fs.readFileSync(f('code'),'utf8')):0);
`,
);
const SPEC = JSON.stringify([process.execPath, FAKE]);
function fakeDir(files) {
  const d = fs.mkdtempSync(path.join(TEST_TMP, 'fake-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), body);
  return d;
}
// The environment of a session: none of the real backend variables leaks in from the machine running the tests.
const envOf = (extra = {}) => ({ GHORC_TOOL_TIMEOUT_MS: '30000', HC_TERMINAL_ID: '', HERDR_ENV: '', GHORC_HC_BIN: SPEC, GHORC_HERDR_BIN: SPEC, GHORC_CAPACITY_HC_JSON: undefined, GHORC_CAPACITY_HERDR_JSON: undefined, ...extra });
const clean = (extra) => ({ ...process.env, ...envOf(extra) });
// delete variables set to undefined (spawn would print them as the text "undefined")
const toEnv = (e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));

const HC_LS = JSON.stringify({
  hidden_finished: 1,
  terminals: [
    { address: 't5', agent: 'claude-code', state: 'live', status: 'done', where: 'p / lead' }, // the lead: top level
    { address: 't7', agent: 'claude-code', name: 'lead-next', parent: 't5', state: 'live', status: 'working' }, // lead by name
    { address: 't8', agent: 'cmd.exe', name: 'chain', parent: 't7', state: 'live' }, // a plain program: no status
    { address: 't13', agent: 'claude-code', name: 'impl', parent: 't5', state: 'live', status: 'working' }, // worker
    { address: 't14', agent: 'claude-code', name: 'me', parent: 't5', state: 'live', status: 'working' }, // this terminal
    { address: 't15', agent: 'claude-code', name: 'rev', parent: 't5', state: 'live', status: 'blocked' }, // worker
    { address: 't16', agent: 'claude-code', name: 'idle', parent: 't5', state: 'live', status: 'idle' },
    { address: 't17', agent: 'claude-code', name: 'gone', parent: 't5', state: 'finished', status: 'working' },
  ],
});
const HERDR_LIST = (n) => JSON.stringify({ result: { agents: Array.from({ length: n }, (_, i) => ({ name: `w${i}`, agent_status: 'working', agent_session: { value: `x${i}` } })) } });
const SERVER_DOWN = '{"id":"cli:agent:list","error":{"code":"server_not_running","message":"no herdr server is running"}}';

// ---- detection ----------------------------------------------------------------------------------------------------
test('detect: HC_TERMINAL_ID selects hc, even when HERDR_ENV=1 as well; no tool is asked', () => {
  const calls = [];
  const d = backend.detect({ env: { HC_TERMINAL_ID: 't9', HERDR_ENV: '1' }, exec: (...a) => calls.push(a) });
  assert.deepEqual([d.backend, d.terminal], ['hc', 't9']);
  assert.equal(calls.length, 0);
});

test('detect: nothing set, or HERDR_ENV not 1, is none without asking herdr', () => {
  const calls = [];
  const exec = (...a) => calls.push(a);
  for (const env of [{}, { HERDR_ENV: '' }, { HERDR_ENV: '0' }, { HC_TERMINAL_ID: '  ' }]) {
    assert.equal(backend.detect({ env, exec }).backend, 'none', JSON.stringify(env));
  }
  assert.equal(calls.length, 0);
});

test('detect: HERDR_ENV=1 needs a herdr server that answers', () => {
  const env = { HERDR_ENV: '1' };
  const ok = backend.detect({ env, exec: () => HERDR_LIST(2) });
  assert.equal(ok.backend, 'herdr');
  assert.equal(ok.raw, HERDR_LIST(2), 'the probe output is handed on');
  const err = (props) => () => {
    throw Object.assign(new Error('boom'), props);
  };
  // the real herdr 0.9.5 shape: exit 1, empty stdout, the JSON on stderr
  const down = backend.detect({ env, exec: err({ status: 1, stdout: '', stderr: SERVER_DOWN }) });
  assert.equal(down.backend, 'none');
  assert.match(down.reason, /server_not_running/);
  assert.ok(!down.failed, 'a stopped server is an answer, not a failure');
  const missing = backend.detect({ env, exec: err({ code: 'ENOENT' }) });
  assert.equal(missing.backend, 'none');
  assert.match(missing.reason, /not installed/);
  const odd = backend.detect({ env, exec: err({ status: 2, stdout: '', stderr: 'weird' }) });
  assert.deepEqual([odd.backend, odd.failed], ['none', true]);
  const slow = backend.detect({ env, exec: err({ code: 'ETIMEDOUT' }) });
  assert.deepEqual([slow.backend, slow.failed], ['none', true]);
});

test('scripts/backend.cjs prints the backend as JSON and as a word', () => {
  const run = (extra, args = []) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'backend.cjs'), ...args], { encoding: 'utf8', env: toEnv(clean(extra)) });
  const hc = run({ HC_TERMINAL_ID: 't3' });
  assert.deepEqual(JSON.parse(hc.stdout), { backend: 'hc', reason: 'HC_TERMINAL_ID=t3', terminal: 't3' });
  assert.equal(run({}, ['--name']).stdout.trim(), 'none');
  const none = JSON.parse(run({}).stdout);
  assert.equal(none.backend, 'none');
  assert.equal('raw' in none, false);
  const dir = fakeDir({ 'agent_list.out': HERDR_LIST(0) });
  const herdr = JSON.parse(run({ HERDR_ENV: '1', FAKE_DIR: dir }).stdout);
  assert.equal(herdr.backend, 'herdr');
  assert.equal('raw' in herdr, false, 'the probe text is for the hooks');
  const down = fakeDir({ 'agent_list.err': SERVER_DOWN, 'agent_list.code': '1' });
  assert.equal(run({ HERDR_ENV: '1', FAKE_DIR: down }, ['--name']).stdout.trim(), 'none');
});

// ---- workers ------------------------------------------------------------------------------------------------------
test('workersFromHc: live, working or blocked, has a parent, not lead-named, not this terminal', () => {
  assert.equal(backend.workersFromHc(HC_LS, 't14'), 2, 't13 and t15');
  assert.equal(backend.workersFromHc(HC_LS, 't5'), 3, 'the lead itself is no worker (no parent); t14 counts for t5');
  assert.equal(backend.workersFromHc(HC_LS, 't14', 'impl'), 2, 'another prefix moves the lead name rule: t7 now counts, t13 does not');
  assert.equal(backend.workersFromHc(HC_LS, ''), 3, 'without an own address nothing is excluded by it');
  for (const bad of ['', 'nope', '{}', '[]', '{"terminals":1}']) assert.equal(backend.workersFromHc(bad, 't14'), null, bad);
  assert.equal(backend.workersFromHc('{"terminals":[]}', 't14'), 0);
});

test('liveWorkers: seams force a backend, hc first', () => {
  const env = { HC_TERMINAL_ID: 't14', GHORC_CAPACITY_HC_JSON: HC_LS, GHORC_CAPACITY_HERDR_JSON: HERDR_LIST(5) };
  assert.equal(cap.liveWorkers('s', 'lead-', () => {}, { env }), 2);
  delete env.GHORC_CAPACITY_HC_JSON;
  assert.equal(cap.liveWorkers('s', 'lead-', () => {}, { env }), 5);
  const logs = [];
  assert.equal(cap.liveWorkers('s', 'lead-', (m) => logs.push(m), { env: { GHORC_CAPACITY_HC_JSON: 'junk' } }), null);
  assert.match(logs.join(), /hc ls/);
});

test('liveWorkers: none counts 0 and never asks a tool; hc and herdr ask their own', () => {
  const asked = [];
  const exec = (prog, args) => {
    asked.push(`${prog} ${args.join(' ')}`);
    return args[0] === 'ls' ? HC_LS : HERDR_LIST(4);
  };
  const log = () => {};
  assert.equal(cap.liveWorkers('s', 'lead-', log, { env: {}, exec }), 0);
  assert.equal(cap.liveWorkers('s', 'lead-', log, { env: { HERDR_ENV: '0' }, exec }), 0);
  assert.deepEqual(asked, []);
  // hc must be asked by `hc ls --json`; its terminal is excluded
  assert.equal(cap.liveWorkers('s', 'lead-', log, { env: { HC_TERMINAL_ID: 't14', GHORC_HC_BIN: '' }, exec }), 2);
  assert.deepEqual(asked, ['hc ls --json']);
  // herdr: HERDR_ENV=1; the probe output is the list, it is asked once
  asked.length = 0;
  assert.equal(cap.liveWorkers('s', 'lead-', log, { env: { HERDR_ENV: '1', GHORC_HERDR_BIN: '' }, exec }), 4);
  assert.deepEqual(asked, ['herdr agent list']);
  // HERDR_ENV=1 but the server is down: 0; an unknown failure: null with the cause logged
  const down = () => {
    throw Object.assign(new Error('x'), { status: 1, stdout: '', stderr: SERVER_DOWN });
  };
  assert.equal(cap.liveWorkers('s', 'lead-', log, { env: { HERDR_ENV: '1' }, exec: down }), 0);
  const logs = [];
  const slow = () => {
    throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  };
  assert.equal(cap.liveWorkers('s', 'lead-', (m) => logs.push(m), { env: { HERDR_ENV: '1' }, exec: slow }), null);
  assert.match(logs.join(), /timed out/);
  // hc failing is unknown, not zero; hc missing from PATH is zero
  const hcFail = () => {
    throw Object.assign(new Error('hc down'), { status: 1, stdout: '', stderr: 'no core' });
  };
  assert.equal(cap.liveWorkers('s', 'lead-', log, { env: { HC_TERMINAL_ID: 't1' }, exec: hcFail }), null);
  const gone = () => {
    throw Object.assign(new Error('x'), { code: 'ENOENT' });
  };
  assert.equal(cap.liveWorkers('s', 'lead-', log, { env: { HC_TERMINAL_ID: 't1' }, exec: gone }), 0);
});

// The Stop hook end to end: the machine measurements are fixed, the backend is a fake program.
function capacityStop(extraEnv) {
  const cwd = tmpProject({ capacity: { enabled: true } });
  const s = sid();
  const env = toEnv({ ...envOf(extraEnv), GHORC_CAPACITY_CPU_PCT: '20', GHORC_CAPACITY_FREE_GB: '16', GHORC_CAPACITY_LEDGER: path.join(cwd, 'ledger.jsonl') });
  const r = runScript('capacity-guard.cjs', { hook_event_name: 'Stop', session_id: s, cwd, last_assistant_message: 'Waiting.' }, { env });
  return r.out.trim() ? JSON.parse(r.out).reason : '';
}

test('capacity-guard Stop counts the workers of the active backend', () => {
  const hcDir = fakeDir({ 'ls_--json.out': HC_LS });
  assert.match(capacityStop({ HC_TERMINAL_ID: 't14', FAKE_DIR: hcDir }), /agents 2 \(workers 2\) of 3/, 'hc');
  const hrDir = fakeDir({ 'agent_list.out': HERDR_LIST(1) });
  assert.match(capacityStop({ HERDR_ENV: '1', FAKE_DIR: hrDir }), /agents 1 \(workers 1\) of 3/, 'herdr');
  // none: a herdr that WOULD list workers is not asked
  assert.match(capacityStop({ FAKE_DIR: hrDir }), /agents 0 of 3/, 'none');
  assert.doesNotMatch(capacityStop({ FAKE_DIR: hrDir }), /workers/);
});

// ---- the forbidden forms --------------------------------------------------------------------------------------------
test('subagents and workers may not run hc run, exec, keys or interrupt; read-only hc commands stay', () => {
  const denied = [
    'hc run --bg --name x claude "do it"',
    'hc run cargo test',
    'hc.exe run --bg --name x -- claude.exe',
    'hc exec git status',
    'hc keys t5 down enter',
    'hc interrupt t5',
    'cd /tmp && hc run x',
    'env GHORC_ROLE=lead hc run x',
    'bash -c "hc run x"',
    'nohup hc run x',
    '/usr/local/bin/hc run x',
    'hc --json run x',
    // global options that take a value must not hide the subcommand
    'hc --on laptop run claude.exe',
    'hc --via ssh run x',
    'hc --on laptop exec git status',
    'hc -x y keys t5 enter',
    'hc --on laptop --json interrupt t5',
    'HC --ON laptop RUN x',
  ];
  const allowed = ['hc ls', 'hc get t5', 'hc read t5 --lines 40', 'hc wait t5', 'hc templates', 'git status', 'echo hc run'];
  for (const c of denied) assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), true, c);
  for (const c of allowed) assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), false, c);
});

test('hcSendTargets reads the target of every hc send, null when unreadable', () => {
  assert.deepEqual(cmd.hcSendTargets('hc send t5 "done"'), ['t5']);
  assert.deepEqual(cmd.hcSendTargets('hc send --force t5 x'), ['t5']);
  assert.deepEqual(cmd.hcSendTargets('hc send --wait --timeout 30 t5 x'), ['t5']);
  assert.deepEqual(cmd.hcSendTargets('hc send --if idle t5 x'), ['t5']);
  assert.deepEqual(cmd.hcSendTargets('hc.exe --json send t5 x'), ['t5']);
  assert.deepEqual(cmd.hcSendTargets('hc send t5 a && hc send t6 b'), ['t5', 't6']);
  assert.deepEqual(cmd.hcSendTargets('hc send $HC_TERMINAL_ID x'), ['$HC_TERMINAL_ID']);
  assert.deepEqual(cmd.hcSendTargets('hc send'), [null]);
  assert.deepEqual(cmd.hcSendTargets('hc ls'), []);
  assert.deepEqual(cmd.hcSendTargets('echo hc send t5'), []);
  assert.deepEqual(cmd.hcSendTargets('hc --on laptop send t5 x'), ['t5']);
  assert.deepEqual(cmd.hcSendTargets('hc --via ssh --json send --force t5 x'), ['t5']);
  assert.equal(cmd.matches('hc --on laptop send t5 x', cmd.BUILTIN_SUBAGENT_DENY), false);
  assert.equal(cmd.matches('hc --on laptop run claude.exe', cmd.AGENT_START), true);
  assert.equal(cmd.matches('hc --on laptop ls', cmd.AGENT_START), false);
});

// E408 fix1: the review's bypasses. String.raw keeps the backslashes of Windows paths.
const DENY_FORMS = [
  // P1-1: a Windows path to hc / herdr (backslashes), SH and PS
  String.raw`C:\Users\Developer\AppData\herdr-core\hc.exe --on m run claude`,
  String.raw`C:\x\hc.exe run claude`,
  String.raw`C:\x\herdr.exe agent start x`,
  // P1-2: env with a path, .exe, options
  'env.exe hc run claude',
  '/usr/bin/env hc run claude',
  'env -u GHORC_ROLE hc run claude',
  'env -i hc run claude',
  'env -u A -u B X=1 hc run claude',
  String.raw`C:\Git\usr\bin\env.exe GHORC_ROLE=lead hc run claude`,
  '"C:\\Program Files\\Git\\usr\\bin\\env.exe" hc run claude',
  "'C:/Program Files/Git/usr/bin/env.exe' hc run claude",
  '"C:\\x\\hc.exe" run claude',
  '& "C:\\x\\hc.exe" run claude',
  "& 'C:\\x\\hc.exe' --on m run claude",
  'env herdr agent start x',
  '/usr/bin/env.exe -i herdr pane run p x',
  // P2-5: a herdr option with a value
  'herdr --session x agent start',
  'herdr --session x --json agent prompt a hi',
  String.raw`C:\x\herdr.exe --session x pane send-keys p enter`,
  'herdr -s x pane run p y',
  // a shell wrapper with a path
  '/bin/bash -c "hc run claude"',
  '/usr/bin/sh -c "herdr agent start x"',
  String.raw`C:\Git\bin\bash.exe -c "hc run claude"`,
  'bash -lc "/usr/bin/env hc run claude"',
  String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -Command "hc run claude"`,
  '/opt/pwsh/pwsh -c "hc run claude"',
  // Start-Process options before the program, xargs -J, a quoted subcommand
  'Start-Process -NoNewWindow hc -ArgumentList "run claude"',
  'Start-Process -WindowStyle Hidden -FilePath hc -ArgumentList run,claude',
  'saps -Wait -PassThru hc -ArgumentList "run claude"',
  "Start-Process -WindowStyle Hidden 'C:/x/hc.exe' -ArgumentList 'run claude'",
  'xargs -J % hc run claude',
  'hc "run" claude',
  "hc 'exec' ls",
  'hc --on m "run" claude',
  'hc "keys" t5 enter',
  'herdr "agent" "start"',
  "herdr --session x 'pane' 'run' p y",
  // P2-6: xargs, Start-Process
  'echo x | xargs hc run claude',
  'xargs -n 1 hc run claude',
  'xargs -I {} hc run {} claude',
  'xargs -0 -P 4 hc --on m run claude',
  'xargs herdr agent start',
  'Start-Process hc -ArgumentList "run claude"',
  "Start-Process hc -ArgumentList 'run','claude'",
  'Start-Process -FilePath "C:\\x\\hc.exe" -ArgumentList run,claude -NoNewWindow',
  "Start-Process hc -NoNewWindow -ArgumentList 'run claude'",
  'saps hc -ArgumentList "keys t5 enter"',
  'powershell -Command "Start-Process hc -ArgumentList \'run claude\'"',
];
const OK_FORMS = [
  'hc send t5 "run"',
  'hc "ls"',
  'Start-Process -NoNewWindow notepad -ArgumentList "run claude"',
  'Start-Process -WindowStyle Hidden hc -ArgumentList "ls"',
  'xargs -J % echo hc',
  'herdr "agent" "list"',
  '/bin/bash -c "hc ls"',
  '/usr/bin/sh -c "git status"',
  String.raw`C:\x\hc.exe ls`,
  String.raw`C:\x\hc.exe --on m get t5`,
  '"C:\\x\\hc.exe" ls',
  '& "C:\\x\\hc.exe" read t5',
  'env hc ls',
  'env -u A hc get t5',
  'herdr --session x agent list',
  'herdr --session x pane list',
  'xargs echo hc run',
  'xargs -n 1 echo',
  'Start-Process notepad -ArgumentList "run claude"',
  'Start-Process hc -ArgumentList "ls"',
  'echo "C:\\x\\hc.exe run claude"',
];

test('E408 fix1: path, env, xargs, Start-Process and herdr option forms of the built-in deny', () => {
  for (const c of DENY_FORMS) {
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), true, `sh: ${c}`);
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY, { powershell: true }), true, `ps: ${c}`);
  }
  for (const c of OK_FORMS) {
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY), false, `sh: ${c}`);
    assert.equal(cmd.matches(c, cmd.BUILTIN_SUBAGENT_DENY, { powershell: true }), false, `ps: ${c}`);
  }
});

test('E408 fix1: agent-start detection sees the same forms; hc send target through paths and env', () => {
  for (const c of [String.raw`C:\x\hc.exe --on m run claude`, 'env.exe hc run claude', '& "C:\\x\\hc.exe" run claude', 'herdr --session x agent start', 'xargs hc run claude', 'Start-Process hc -ArgumentList "run claude"']) {
    assert.equal(cmd.matches(c, cmd.AGENT_START, { powershell: true }), true, c);
  }
  assert.equal(cmd.matches('herdr --session x agent list', cmd.AGENT_START), false);
  assert.deepEqual(cmd.hcSendTargets(String.raw`C:\x\hc.exe send t5 x`), ['t5']);
  assert.deepEqual(cmd.hcSendTargets('env -u A /usr/bin/hc send t5 x'), ['t5']);
  assert.deepEqual(cmd.hcSendTargets('& "C:\\x\\hc.exe" send t1f x', { powershell: true }), ['t1f']);
});

const hgInput = (cwd, command, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: sid(), cwd, tool_name: 'Bash', tool_input: { command }, ...extra });
const hg = (input, env) => runScript('heavy-check-guard.cjs', input, { env: toEnv(env) });

test('hc send: a worker may report to its own parent, nobody else, no subagent, no unreadable parent', () => {
  const cwd = tmpProject({ heavyCommands: ['^never-matches-anything$'] });
  const dir = fakeDir({ 'get_t14.out': JSON.stringify({ address: 't14', parent: 't5', state: 'live' }) });
  const worker = envOf({ GHORC_ROLE: 'worker', HC_TERMINAL_ID: 't14', FAKE_DIR: dir });
  const send = (command, extra = {}, env = worker) => isDeny(hg(hgInput(cwd, command, extra), env));
  assert.equal(send('hc send t5 "E408: DONE"'), false, 'the parent');
  assert.equal(send('hc send --force t5 x'), false);
  assert.equal(send('hc send t6 x'), true, 'another terminal');
  assert.equal(send('hc send t5 a && hc send t6 b'), true, 'one of two is foreign');
  assert.equal(send('hc send $HC_TERMINAL_ID x'), true, 'a target the hook cannot read');
  assert.equal(send('hc send t5 x', { agent_id: 'ag1' }), true, 'a subagent');
  assert.equal(send('hc run --bg claude'), true);
  assert.equal(send('hc keys t5 enter'), true);
  assert.equal(send('hc interrupt t5'), true);
  assert.equal(send('hc exec ls'), true);
  assert.equal(send('hc ls'), false);
  assert.equal(send('hc read t5'), false);
  // the lead sends and runs freely
  const lead = envOf({ GHORC_ROLE: 'lead', HC_TERMINAL_ID: 't5', FAKE_DIR: dir });
  for (const c of ['hc send t14 "go"', 'hc run --bg claude', 'hc keys t14 enter']) assert.equal(send(c, {}, lead), false, c);
  // a worker whose parent cannot be read is denied: the reason says so
  const none = fakeDir({ 'get_t14.code': '1' });
  const blind = envOf({ GHORC_ROLE: 'worker', HC_TERMINAL_ID: 't14', FAKE_DIR: none });
  const r = hg(hgInput(cwd, 'hc send t5 x'), blind);
  assert.equal(isDeny(r), true);
  assert.match(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /none readable/);
  // not in hc at all (no HC_TERMINAL_ID): no parent, so hc send is denied for a worker
  assert.equal(send('hc send t5 x', {}, envOf({ GHORC_ROLE: 'worker' })), true);
  // the old herdr forms stay denied
  for (const c of ['herdr pane run p x', 'herdr agent start x', 'claude -p x']) assert.equal(send(c), true, c);
});

test('hc send: after a lead handover a worker may also report to a live lead from hc ls, nobody else', () => {
  const cwd = tmpProject({ heavyCommands: ['^never-matches-anything$'] });
  const ls = JSON.stringify({
    terminals: [
      { address: 't5', agent: 'claude-code', state: 'finished' }, // the parent: gone after the handover
      { address: 't1f', agent: 'claude-code', cwd, state: 'live', status: 'idle' }, // the new lead: top level
      { address: 't9', agent: 'claude-code', cwd: path.join(cwd, '.claude', 'worktrees', 'w'), name: 'lead-next', parent: 't1f', state: 'live', status: 'working' }, // lead by name
      { address: 't13', agent: 'claude-code', name: 'impl', parent: 't1f', state: 'live', status: 'working' }, // a foreign worker
      { address: 't14', agent: 'claude-code', name: 'me', parent: 't5', state: 'live', status: 'working' },
      { address: 't20', agent: 'claude-code', name: 'old-lead', state: 'finished' }, // a dead top-level one
      { address: 'tOther', agent: 'claude-code', cwd: path.join(path.dirname(cwd), 'other-project'), state: 'live' }, // a lead of another project
      { address: 'tNoCwd', agent: 'claude-code', name: 'lead-x', state: 'live' }, // no cwd: unknown project
      { address: 'tS', agent: 'cmd.exe', state: 'live' }, // the owner's shells: text sent there would be run
      { address: 'tP', agent: 'pwsh', state: 'live' },
      { address: 'tL', agent: 'cmd.exe', name: 'lead-fake', state: 'live' },
    ],
  });
  const get = JSON.stringify({ address: 't14', parent: 't5', state: 'live' });
  const send = (command, files, extra = {}) => {
    const dir = fakeDir(files);
    return isDeny(hg(hgInput(cwd, command, extra), envOf({ GHORC_ROLE: 'worker', HC_TERMINAL_ID: 't14', FAKE_DIR: dir })));
  };
  const both = { 'get_t14.out': get, 'ls_--json.out': ls };
  assert.equal(send('hc send t1f "E408 DONE"', both), false, 'the new lead, parent dead');
  assert.equal(send('hc send t9 x', both), false, 'a lead by name');
  assert.equal(send('hc send t5 x', both), false, 'the (dead) parent stays allowed');
  assert.equal(send('hc send t1f a && hc send t5 b', both), false);
  assert.equal(send('hc send t13 x', both), true, 'a foreign worker');
  assert.equal(send('hc send t20 x', both), true, 'a dead top-level terminal');
  for (const t of ['tOther', 'tNoCwd']) assert.equal(send(`hc send ${t} x`, both), true, `a lead of another project: ${t}`);
  for (const t of ['tS', 'tP', 'tL']) assert.equal(send(`hc send ${t} "claude -p x"`, both), true, `a shell without parent: ${t}`);
  assert.equal(send('hc send t1f a && hc send t13 b', both), true, 'one of two is foreign');
  assert.equal(send('hc send t1f x', both, { agent_id: 'ag1' }), true, 'a subagent');
  assert.equal(send('hc send t1f x', { 'get_t14.out': get }), true, 'hc ls unreadable and t1f is not the parent');
  assert.equal(send('hc send t1f x', { 'get_t14.code': '1', 'ls_--json.out': ls }), false, 'parent unreadable, lead from hc ls');
  assert.equal(send('hc send t13 x', { 'get_t14.code': '1', 'ls_--json.out': ls }), true);
  const { leadsFromHc } = backend;
  assert.deepEqual(leadsFromHc(ls), ['t1f', 't9', 'tOther', 'tNoCwd'], 'without roots: no project filter');
  assert.deepEqual(leadsFromHc(ls, 'lead-', [cwd]), ['t1f', 't9'], 'with the project root');
  assert.deepEqual(leadsFromHc(ls, 'lead-', [cwd.toUpperCase().split(path.sep).join('/')]), ['t1f', 't9'], 'case and slashes do not matter');
  assert.equal(leadsFromHc('not json'), null);
  assert.equal(leadsFromHc('{"x":1}'), null);
});

test('hc send: the cwd of the parent terminal also marks the project (a lead in another directory of the same repository)', () => {
  const cwd = tmpProject({ heavyCommands: ['^never-matches-anything$'] });
  const repo = path.join(path.dirname(cwd), 'elsewhere-repo');
  const ls = JSON.stringify({
    terminals: [
      { address: 't5', agent: 'claude-code', cwd: repo, state: 'live', status: 'done' },
      { address: 'tE', agent: 'claude-code', cwd: path.join(repo, 'app'), state: 'live' },
      { address: 'tF', agent: 'claude-code', cwd: `${repo}-2`, state: 'live' }, // a sibling directory, not inside
      { address: 't14', agent: 'claude-code', parent: 't5', state: 'live', status: 'working' },
    ],
  });
  const dir = fakeDir({ 'get_t14.out': JSON.stringify({ address: 't14', parent: 't5' }), 'ls_--json.out': ls });
  const send = (c) => isDeny(hg(hgInput(cwd, c), envOf({ GHORC_ROLE: 'worker', HC_TERMINAL_ID: 't14', FAKE_DIR: dir })));
  assert.equal(send('hc send tE x'), false);
  assert.equal(send('hc send tF x'), true);
});

test('the deny holds with an invalid config too', () => {
  const cwd = tmpProject({ heavyCommands: 'not a list' });
  const e = envOf({ GHORC_ROLE: 'worker' });
  assert.equal(isDeny(hg(hgInput(cwd, 'hc run x'), e)), true);
});
