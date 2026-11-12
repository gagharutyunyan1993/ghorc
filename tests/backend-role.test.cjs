'use strict';
// backend.prefer, worker.permissionArgs, the proven lead without GHORC_ROLE for the sticky handoff block, and the session
// root of HANDOFF.md. No real hc or herdr runs: the tools are a fake program (GHORC_HC_BIN / GHORC_HERDR_BIN) or an injected exec.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript, tmpProject, sid, TEST_TMP } = require('./helpers.cjs');

process.env.GHORC_TMP = TEST_TMP;
const backend = require('../scripts/lib/backend.cjs');
const role = require('../scripts/lib/role.cjs');
const validate = require('../scripts/lib/validate.cjs');
const defaults = require('../scripts/lib/defaults.json');
const cg = require('../scripts/lib/ctxguard.cjs');

// ---- a fake tool: prints FAKE_DIR/<args joined by _>.out, exit code from .code; appends the call to FAKE_LOG ------------
const FAKE = path.join(TEST_TMP, 'fake-role-tool.cjs');
fs.writeFileSync(
  FAKE,
  `const fs=require('fs'),path=require('path');
const key=process.argv.slice(2).join('_');
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,key+'\\n');
const f=(e)=>path.join(process.env.FAKE_DIR,key+'.'+e);
if(!fs.existsSync(f('out'))&&!fs.existsSync(f('code'))){console.error('unscripted: '+key);process.exit(3);}
if(fs.existsSync(f('out')))process.stdout.write(fs.readFileSync(f('out'),'utf8'));
process.exit(fs.existsSync(f('code'))?Number(fs.readFileSync(f('code'),'utf8')):0);
`,
);
const SPEC = JSON.stringify([process.execPath, FAKE]);
function fakeTool(files) {
  const dir = fs.mkdtempSync(path.join(TEST_TMP, 'fakerole-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  const log = path.join(dir, 'calls.log');
  return { dir, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}
const HERDR_LIST = (agents) => JSON.stringify({ result: { agents } });
const agent = (name, session) => ({ name, agent_status: 'working', agent_session: { value: session } });

// ---- step 1: backend.prefer ---------------------------------------------------------------------------------------------
test('prefer: both backends present: hc by default, herdr when asked; one present wins whatever the key says', () => {
  const both = { HC_TERMINAL_ID: 't9', HERDR_ENV: '1' };
  const calls = [];
  const exec = (...a) => (calls.push(a), HERDR_LIST([agent('x', 's')]));
  // default (no prefer, no config at this cwd): hc, herdr not asked
  const none = fs.mkdtempSync(path.join(TEST_TMP, 'nocfg-'));
  assert.equal(backend.detect({ env: both, exec, cwd: none }).backend, 'hc');
  assert.equal(backend.detect({ env: both, exec, prefer: 'hc' }).backend, 'hc');
  assert.equal(calls.length, 0, 'hc preferred: the herdr server is not asked');
  // herdr preferred and the server answers
  const h = backend.detect({ env: both, exec, prefer: 'herdr' });
  assert.equal(h.backend, 'herdr');
  assert.equal(h.raw, HERDR_LIST([agent('x', 's')]));
  // herdr preferred but down, missing or failing: hc stays
  const err = (props) => () => {
    throw Object.assign(new Error('boom'), props);
  };
  for (const props of [{ status: 1, stdout: '', stderr: '{"error":{"code":"server_not_running"}}' }, { code: 'ENOENT' }, { status: 2, stdout: '', stderr: 'weird' }, { code: 'ETIMEDOUT' }]) {
    const d = backend.detect({ env: both, exec: err(props), prefer: 'herdr' });
    assert.equal(d.backend, 'hc', JSON.stringify(props));
    assert.equal(d.terminal, 't9');
  }
  // one present: that one regardless of prefer
  calls.length = 0;
  assert.equal(backend.detect({ env: { HC_TERMINAL_ID: 't9' }, exec, prefer: 'herdr' }).backend, 'hc');
  assert.equal(calls.length, 0, 'hc alone: no herdr probe');
  assert.equal(backend.detect({ env: { HERDR_ENV: '1' }, exec, prefer: 'hc' }).backend, 'herdr');
  assert.equal(backend.detect({ env: { HERDR_ENV: '1' }, exec: err({ code: 'ENOENT' }), prefer: 'herdr' }).backend, 'none');
  // an unknown prefer value is the default
  assert.equal(backend.detect({ env: both, exec, prefer: 'bogus', cwd: none }).backend, 'hc');
});

test('prefer (c): scripts/backend.cjs reads backend.prefer from the project config; default stays hc', () => {
  const list = HERDR_LIST([agent('w1', 'x')]);
  const fake = fakeTool({ 'agent_list.out': list });
  const env = { HC_TERMINAL_ID: 't9', HERDR_ENV: '1', GHORC_HC_BIN: SPEC, GHORC_HERDR_BIN: SPEC, FAKE_DIR: fake.dir, FAKE_LOG: fake.log, GHORC_TOOL_TIMEOUT_MS: '30000' };
  const name = (cwd) => runScript('backend.cjs', '', { args: ['--name'], env, cwd }).out.trim();
  const herdrProject = tmpProject({ backend: { prefer: 'herdr' } });
  const hcProject = tmpProject({ backend: { prefer: 'hc' } });
  const plain = tmpProject({});
  assert.equal(name(herdrProject), 'herdr');
  assert.equal(name(hcProject), 'hc');
  assert.equal(name(plain), 'hc', 'default');
  assert.deepEqual(fake.calls(), ['agent_list'], 'herdr was probed only for the project that prefers it');
  // the same session with only HC_TERMINAL_ID: hc, whatever the key says
  const only = runScript('backend.cjs', '', { args: ['--name'], env: { ...env, HERDR_ENV: '' }, cwd: herdrProject });
  assert.equal(only.out.trim(), 'hc');
});

test('prefer: the key is validated and defaulted', () => {
  assert.deepEqual(defaults.backend, { prefer: 'hc' });
  const check = (cfg) => {
    const dir = tmpProject(cfg);
    return validate.checkFile(path.join(dir, '.claude', 'ghorc.json'));
  };
  assert.deepEqual(check({ backend: { prefer: 'herdr' } }).problems, []);
  assert.deepEqual(check({ backend: { prefer: 'hc' } }).problems, []);
  for (const bad of ['HC', 'both', '', 'none', 1, null]) {
    const r = check({ backend: { prefer: bad } });
    assert.ok(r.fatal.length > 0, `prefer ${JSON.stringify(bad)} is rejected`);
    assert.match(r.fatal[0], /backend\.prefer/);
  }
  assert.match(check({ backend: { prefr: 'hc' } }).problems[0], /unknown key: backend\.prefr/);
});

// ---- step 2: worker.permissionArgs --------------------------------------------------------------------------------------
test('worker.permissionArgs: default [], strings only', () => {
  assert.deepEqual(defaults.worker, { permissionArgs: [] });
  const check = (cfg) => validate.checkFile(path.join(tmpProject(cfg), '.claude', 'ghorc.json'));
  assert.deepEqual(check({ worker: { permissionArgs: ['--permission-mode', 'acceptEdits'] } }).problems, []);
  assert.deepEqual(check({ worker: { permissionArgs: [] } }).problems, []);
  assert.ok(check({ worker: { permissionArgs: '--dangerously-skip-permissions' } }).fatal.length > 0, 'a string is not an array');
  const r = check({ worker: { permissionArgs: ['ok', 3] } });
  assert.match(r.fatal[0], /worker\.permissionArgs\[1\]: not a string/);
  assert.match(check({ worker: { permissionArg: [] } }).problems[0], /unknown key: worker\.permissionArg/);
});

// ---- step 3: the proven lead ---------------------------------------------------------------------------------------------
const hcGet = (obj) => JSON.stringify(obj);
function execHc(answer) {
  const calls = [];
  const exec = (prog, args) => {
    calls.push(args.join(' '));
    if (typeof answer === 'function') return answer(args);
    return answer;
  };
  exec.calls = calls;
  return exec;
}
const HC = { HC_TERMINAL_ID: 't5' };

test('provenLead: the role variable answers first and nothing is asked', () => {
  const exec = execHc(hcGet({ address: 't5', name: 'lead-x' }));
  assert.equal(role.provenLead({ env: { ...HC, GHORC_ROLE: 'lead' }, exec }), true);
  assert.equal(role.provenLead({ env: { ...HC, GHORC_ROLE: ' Lead ' }, exec }), true);
  // (a) a worker in a tab called lead-x is never a lead
  assert.equal(role.provenLead({ env: { ...HC, GHORC_ROLE: 'worker' }, exec }), false);
  assert.equal(role.provenLead({ env: { ...HC, GHORC_ROLE: 'WORKER' }, exec }), false);
  assert.equal(exec.calls.length, 0, 'no lookup when the role answers');
});

test('provenLead on hc: name with the lead prefix or no parent; everything else, and every failure, is not proven', () => {
  const lead = (obj, extra = {}) => role.provenLead({ env: HC, exec: execHc(hcGet(obj)), ...extra });
  assert.equal(lead({ address: 't5', name: 'lead-h12', parent: 't1' }), true, 'named lead-');
  assert.equal(lead({ address: 't5', name: 'LEAD-X', parent: 't1' }), true, 'case-insensitive');
  assert.equal(lead({ address: 't5', name: 'impl', parent: null }), true, 'no parent');
  assert.equal(lead({ address: 't5', parent: '' }), true, 'empty parent, no name');
  assert.equal(lead({ address: 't5', name: 'impl', parent: 't1' }), false, 'a worker');
  assert.equal(lead({ address: 't5', name: 'chief', parent: 't1' }, { leadPrefix: 'chief' }), true, 'configured prefix');
  assert.equal(lead({ address: 't5', name: 'lead-x', parent: 't1' }, { leadPrefix: '' }), false, 'empty prefix: only the parent counts');
  assert.equal(lead({ address: 't7', name: 'lead-x' }), false, 'the answer is about another terminal');
  assert.equal(lead({ jsonrpc: 'x' }), false, 'not a terminal object');
  assert.equal(lead([]), false);
  assert.equal(lead('lead-x'), false);
  // failures
  const ask = (exec, env = HC) => role.provenLead({ env, exec });
  assert.equal(ask(execHc('not json')), false, 'garbage');
  assert.equal(ask(execHc('')), false, 'empty');
  assert.equal(ask(() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }), false, 'hc missing');
  assert.equal(ask(() => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); }), false, 'timeout');
  assert.equal(ask(() => { throw Object.assign(new Error('x'), { status: 3, stdout: '{"name":"lead-x"}', stderr: '' }); }), false, 'non-zero exit');
  assert.equal(ask(execHc(hcGet({ address: 't5', name: 'lead-x' })), {}), false, 'no backend at all');
});

test('provenLead on herdr: the tab label of this session starts with the prefix without its dash', () => {
  const env = { HERDR_ENV: '1' };
  const mk = (agents) => () => HERDR_LIST(agents);
  const lead = (agents, extra = {}) => role.provenLead({ env, exec: mk(agents), session: 's1', ...extra });
  assert.equal(lead([agent('lead-h12', 's1')]), true);
  assert.equal(lead([agent('lead', 's1')]), true, 'the bare prefix without dash');
  assert.equal(lead([agent('leader-x', 's1')]), true, 'starts with lead');
  assert.equal(lead([agent('impl', 's1'), agent('lead-x', 's2')]), false, 'another session is the lead');
  assert.equal(lead([agent('impl', 's1')]), false);
  assert.equal(lead([agent('lead-x', 's1')], { session: '' }), false, 'no session id: nothing to match');
  assert.equal(lead([agent('lead-x', 's1')], { leadPrefix: '' }), false);
  assert.equal(lead([agent('lead-x', 's1')], { leadPrefix: '-' }), false, 'a prefix that is only a dash');
  assert.equal(role.provenLead({ env, exec: () => 'not json', session: 's1' }), false);
  assert.equal(role.provenLead({ env, exec: () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); }, session: 's1' }), false);
  assert.equal(role.provenLead({ env: { ...env, GHORC_ROLE: 'worker' }, exec: mk([agent('lead-x', 's1')]), session: 's1' }), false);
});

test('provenLead: with both backends the preferred one is asked', () => {
  const env = { HC_TERMINAL_ID: 't5', HERDR_ENV: '1' };
  const exec = (prog, args) => (args[0] === 'agent' ? HERDR_LIST([agent('impl', 's1')]) : hcGet({ address: 't5', name: 'lead-x' }));
  assert.equal(role.provenLead({ env, exec, session: 's1', prefer: 'hc' }), true, 'hc says lead');
  assert.equal(role.provenLead({ env, exec, session: 's1', prefer: 'herdr' }), false, 'herdr says worker');
});

// ---- the hook: sticky block for a proven lead only ----------------------------------------------------------------------
const STICKY = { handoff: { stickyOnCompact: true } };
const SEC = 1000;
function writeCtx(cwd, s, tokens) {
  const p = path.join(cwd, '.claude', `ctx-${s}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ used_percentage: 9, current_usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 1000 }, context_window_size: 1000000 }));
}
const hook = (cwd, s, event, extra = {}) => ({ hook_event_name: event, session_id: s, cwd, ...extra });
const json = (r) => (r.out.trim() ? JSON.parse(r.out) : {});
const blocks = (r) => json(r).decision === 'block';
function session(config = STICKY, tokens = 12000) {
  const cwd = tmpProject(config);
  const s = sid();
  writeCtx(cwd, s, tokens);
  fs.writeFileSync(path.join(cwd, 'STATE.md'), 'state\n');
  return { cwd, s };
}
// env of a roleless session in an hc terminal whose `hc get` answer is `answer` (a string), or with no hc program at all
function hcEnv(answer, role = '') {
  const t = fakeTool(answer === null ? {} : { 'get_t5.out': answer });
  return { env: { GHORC_ROLE: role, HC_TERMINAL_ID: 't5', GHORC_HC_BIN: SPEC, FAKE_DIR: t.dir, FAKE_LOG: t.log, GHORC_TOOL_TIMEOUT_MS: '30000' }, tool: t };
}
const compactStop = (cwd, s, env) => {
  const c = runScript('context-guard.cjs', hook(cwd, s, 'SessionStart', { source: 'compact' }), { env });
  const st = runScript('context-guard.cjs', hook(cwd, s, 'Stop', { stop_hook_active: false }), { env });
  return { c, st };
};

test('hook: a roleless session in an hc terminal named lead-* is blocked at Stop after a compaction; no parent counts too', () => {
  for (const answer of [JSON.stringify({ address: 't5', name: 'lead-h1', parent: 't1' }), JSON.stringify({ address: 't5', name: 'x' })]) {
    const { cwd, s } = session();
    const { env, tool } = hcEnv(answer);
    const { c, st } = compactStop(cwd, s, env);
    assert.equal(c.code, 0);
    assert.equal(st.code, 0);
    assert.equal(blocks(st), true, answer);
    assert.match(json(st).reason, /status: SENT/);
    assert.ok(tool.calls().includes('get_t5'), 'hc get was asked');
  }
});

test('pre-mortem (a): GHORC_ROLE=worker in a tab named lead-x is not blocked and nothing is asked', () => {
  const { cwd, s } = session();
  const { env, tool } = hcEnv(JSON.stringify({ address: 't5', name: 'lead-x' }), 'worker');
  const { c, st } = compactStop(cwd, s, env);
  assert.equal(c.code, 0);
  assert.equal(st.code, 0);
  assert.equal(blocks(st), false);
  assert.match(json(st).systemMessage || '', /Finish the task/);
  assert.deepEqual(tool.calls(), [], 'the role answered: no lookup');
  // a crossed flag as well
  const x = session(STICKY, 160000);
  const env2 = hcEnv(JSON.stringify({ address: 't5', name: 'lead-x' }), 'worker');
  runScript('context-guard.cjs', hook(x.cwd, x.s, 'UserPromptSubmit'), { env: env2.env });
  assert.equal(blocks(runScript('context-guard.cjs', hook(x.cwd, x.s, 'Stop'), { env: env2.env })), false);
  assert.deepEqual(env2.tool.calls(), []);
});

test('pre-mortem (b): no role and no hc program, an hc that fails, or garbage: no block, no crash, exit 0', () => {
  const cases = [
    ['hc missing', { GHORC_ROLE: '', HC_TERMINAL_ID: 't5', GHORC_HC_BIN: path.join(TEST_TMP, 'no-such-hc-program') }],
    ['hc exits 3 (unscripted)', hcEnv(null).env],
    ['hc prints garbage', hcEnv('lead-x, trust me').env],
    ['hc prints an object of another terminal', hcEnv(JSON.stringify({ address: 't9', name: 'lead-x' })).env],
    ['herdr missing', { GHORC_ROLE: '', HERDR_ENV: '1', GHORC_HERDR_BIN: path.join(TEST_TMP, 'no-such-herdr-program') }],
  ];
  for (const [label, env] of cases) {
    const { cwd, s } = session();
    const { c, st } = compactStop(cwd, s, env);
    assert.equal(c.code, 0, `${label}: SessionStart exit`);
    assert.equal(st.code, 0, `${label}: Stop exit`);
    assert.equal(st.err, '', `${label}: stderr`);
    assert.equal(blocks(st), false, `${label}: not blocked`);
    assert.match(json(st).systemMessage || '', /compacted/, `${label}: the reminder`);
    // not proven is also no deny of the handoff mode for a compaction-only flag
    const deny = runScript('context-guard.cjs', hook(cwd, s, 'PreToolUse', { tool_name: 'Agent', tool_input: {} }), { env });
    assert.equal(deny.code, 0, label);
    assert.doesNotMatch(deny.out, /"deny"/, label);
  }
});

test('hook: a roleless herdr session whose tab label starts with lead is blocked; another label is not', () => {
  for (const [label, name, expected] of [['lead', 'lead-h2', true], ['worker', 'e12-impl', false]]) {
    const { cwd, s } = session();
    const t = fakeTool({ 'agent_list.out': HERDR_LIST([agent(name, s)]) });
    const env = { GHORC_ROLE: '', HERDR_ENV: '1', GHORC_HERDR_BIN: SPEC, FAKE_DIR: t.dir, FAKE_LOG: t.log, GHORC_TOOL_TIMEOUT_MS: '30000' };
    const { st } = compactStop(cwd, s, env);
    assert.equal(blocks(st), expected, label);
    assert.equal(st.code, 0);
  }
});

test('hook: the lookup is not made for a session without a flag, and a hook with GHORC_ROLE=lead never asks', () => {
  const { cwd, s } = session();
  const { env, tool } = hcEnv(JSON.stringify({ address: 't5', name: 'lead-x' }));
  const r = runScript('context-guard.cjs', hook(cwd, s, 'Stop'), { env });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.deepEqual(tool.calls(), [], 'no flag, no lookup');
  const lead = hcEnv(JSON.stringify({ address: 't5', name: 'impl', parent: 't1' }), 'lead');
  const l = compactStop(cwd, s, lead.env);
  assert.equal(blocks(l.st), true, 'GHORC_ROLE=lead blocks whatever the terminal says');
  assert.deepEqual(lead.tool.calls(), []);
});

// ---- step 4: the root of HANDOFF.md is the session's own worktree --------------------------------------------------------
const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
function git(cwd, ...args) {
  const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

test('step 4: a session in a linked worktree looks for HANDOFF.md at the worktree root, not in the main checkout', () => {
  const main = tmpProject({ handoff: { stickyOnCompact: true } });
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  git(main, 'add', 'a.txt');
  git(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-wt-')), 'lead-branch');
  process.on('exit', () => fs.rmSync(path.dirname(wt), { recursive: true, force: true }));
  git(main, 'worktree', 'add', '-q', '-b', 'lead-branch', wt);
  const s = sid();
  writeCtx(main, s, 12000); // the status line writes the ctx file under the project (main) root
  const env = { GHORC_ROLE: 'lead' };
  const stop = () => runScript('context-guard.cjs', hook(wt, s, 'Stop', { stop_hook_active: false }), { env });
  const rewind = () => {
    const file = path.join(TEST_TMP, s, 'ctxguard.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    st.stopBlockAt -= 61 * SEC;
    fs.writeFileSync(file, JSON.stringify(st));
  };
  const sent = `# HANDOFF\nhandoff_id: h-1   status: SENT   old_session_id: ${s}\n`;

  assert.equal(runScript('context-guard.cjs', hook(wt, s, 'SessionStart', { source: 'compact' }), { env }).code, 0);
  const first = stop();
  assert.equal(blocks(first), true, 'flag set, no HANDOFF.md yet');
  assert.match(json(first).reason, /HANDOFF\.md/);

  // SENT in the main checkout is the other lead's file: it does not clear this session's flag
  fs.writeFileSync(path.join(main, 'HANDOFF.md'), sent);
  rewind();
  assert.equal(blocks(stop()), true, 'HANDOFF.md of the main checkout is not read');
  assert.ok(cg.readFlag(s), 'flag still there');

  // SENT at the worktree root clears it
  fs.writeFileSync(path.join(wt, 'HANDOFF.md'), sent);
  rewind();
  assert.equal(blocks(stop()), false);
  assert.equal(cg.readFlag(s), null, 'flag cleared by the worktree HANDOFF.md');

  // handoff mode edits: STATE.md and HANDOFF.md of the worktree are allowed, the ones of the main checkout are not
  const s2 = sid();
  writeCtx(main, s2, 160000);
  const edit = (file) =>
    runScript('context-guard.cjs', hook(wt, s2, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file } }), { env }).out.includes('"deny"');
  runScript('context-guard.cjs', hook(wt, s2, 'UserPromptSubmit'), { env }); // crossing ctxHandoff writes the flag
  assert.equal(edit(path.join(wt, 'HANDOFF.md')), false, 'worktree HANDOFF.md');
  assert.equal(edit(path.join(wt, 'STATE.md')), false, 'worktree STATE.md');
  assert.equal(edit(path.join(main, 'HANDOFF.md')), true, 'main checkout HANDOFF.md');
});

test('step 4: outside a linked worktree the root is the project root as before (a subdirectory, CLAUDE_PROJECT_DIR)', () => {
  const { sessionRoot } = require('../scripts/lib/root.cjs');
  const main = tmpProject();
  git(main, 'init', '-q', '-b', 'main');
  const sub = path.join(main, 'pkg', 'inner');
  fs.mkdirSync(sub, { recursive: true });
  const real = (p) => fs.realpathSync(p).toLowerCase();
  assert.equal(real(sessionRoot(main)), real(main));
  assert.equal(real(sessionRoot(sub)), real(main));
  const plain = fs.mkdtempSync(path.join(TEST_TMP, 'nogit-'));
  assert.equal(real(sessionRoot(plain)), real(plain), 'no git: cwd');
});
