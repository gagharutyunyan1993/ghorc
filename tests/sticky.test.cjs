'use strict';
// Sticky handoff: a compaction writes the flag, only SENT of this session clears it, Stop blocks once per turn,
// ctx.cjs says the number is unreliable, a broken ctx file is named, unpushed.cjs and handoff.pushGuard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript, isDeny, tmpProject, sid, TEST_TMP } = require('./helpers.cjs');

process.env.GHORC_TMP = TEST_TMP;
const cg = require('../scripts/lib/ctxguard.cjs');

const SEC = 1000;
const LEAD = { GHORC_ROLE: 'lead', GHORC_HOOK_GIT_TIMEOUT_MS: '15000' }; // the sticky tests run as the lead unless a test says otherwise
const STICKY = { handoff: { stickyOnCompact: true } };
function writeCtx(cwd, s, tokens, ageMin = 0) {
  const p = path.join(cwd, '.claude', `ctx-${s}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ used_percentage: 9, current_usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 1000 }, context_window_size: 1000000 }));
  const t = new Date(Date.now() - ageMin * 60 * SEC);
  fs.utimesSync(p, t, t);
  return p;
}
// a project with a fresh low ctx file (a session right after a compaction) and a STATE file
function project(tokens = 12000, config = STICKY) {
  const cwd = tmpProject(config);
  const s = sid();
  writeCtx(cwd, s, tokens);
  fs.writeFileSync(path.join(cwd, 'STATE.md'), 'state\n');
  return { cwd, s };
}
const hook = (cwd, s, event, extra = {}) => ({ hook_event_name: event, session_id: s, cwd, ...extra });
const call = (input, env = LEAD) => runScript('context-guard.cjs', input, { env });
const compact = (cwd, s, env) => call(hook(cwd, s, 'SessionStart', { source: 'compact' }), env);
const json = (r) => (r.out.trim() ? JSON.parse(r.out) : {});
const text = (r) => {
  const j = json(r);
  return (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || j.systemMessage || j.reason || '';
};
const blocks = (r) => json(r).decision === 'block';
const stop = (cwd, s, active = false, env) => call(hook(cwd, s, 'Stop', { stop_hook_active: active }), env);
// the Stop backstop (a repeat block within 60 s passes): move the last block back in time
const rewind = (s, ms = 61 * SEC) => {
  const file = path.join(TEST_TMP, s, 'ctxguard.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.stopBlockAt -= ms;
  fs.writeFileSync(file, JSON.stringify(st));
};
const noNumbers = (reason, s) => assert.doesNotMatch(reason.split(s).join('<sid>'), /\d+K\b|\d{3,}/);
const agentDenied = (cwd, s, env) => isDeny(call(hook(cwd, s, 'PreToolUse', { tool_name: 'Agent', tool_input: {} }), env));
const editDenied = (cwd, s, file, env) => isDeny(call(hook(cwd, s, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file } }), env));
const ROLELESS = { GHORC_HOOK_GIT_TIMEOUT_MS: '15000' }; // no GHORC_ROLE at all (the helper clears it)
const writeHandoff = (cwd, status, old) => fs.writeFileSync(path.join(cwd, 'HANDOFF.md'), `# HANDOFF\nhandoff_id: h-1   status: ${status}   old_session_id: ${old}\n`);

test('hooks.json: SessionStart has a compact matcher entry that runs the context guard', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.SessionStart.find((e) => e.matcher === 'compact');
  assert.ok(entry, 'matcher compact');
  assert.match(entry.hooks[0].command, /context-guard\.cjs/);
});

test('compact writes the flag at low token counts; other SessionStart sources do not', () => {
  const { cwd, s } = project(9000);
  assert.equal(compact(cwd, s).code, 0);
  const flag = cg.readFlag(s);
  assert.ok(flag, 'flag written by the compaction');
  assert.equal(flag.compacted, true);
  for (const source of ['startup', 'resume', 'clear']) {
    const o = project(9000);
    call(hook(o.cwd, o.s, 'SessionStart', { source }));
    assert.equal(cg.readFlag(o.s), null, source);
  }
  // the compaction line goes to the model and has no token numbers
  const r = compact(cwd, sid());
  assert.match(json(r).hookSpecificOutput.additionalContext, /compacted.*handoff is due.*ghorc:handoff/);
  assert.equal(json(r).hookSpecificOutput.hookEventName, 'SessionStart');
});

test('after a compaction the handoff mode is the same as at ctxHandoff: no agents, edits only to STATE and HANDOFF', () => {
  const { cwd, s } = project(9000);
  compact(cwd, s);
  assert.equal(agentDenied(cwd, s), true);
  const edit = (file) => isDeny(call(hook(cwd, s, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file } })));
  assert.equal(edit(path.join(cwd, 'src.js')), true);
  assert.equal(edit(path.join(cwd, 'STATE.md')), false);
  const reason = JSON.parse(call(hook(cwd, s, 'PreToolUse', { tool_name: 'Agent', tool_input: {} })).out).hookSpecificOutput.permissionDecisionReason;
  assert.doesNotMatch(reason, /\d+K\b/, 'no token numbers after a compaction');
});

test('a token number below the threshold does not clear the flag', () => {
  const { cwd, s } = project(9000);
  compact(cwd, s);
  writeCtx(cwd, s, 5000); // a fresh, tiny number
  assert.equal(agentDenied(cwd, s), true);
  assert.equal(blocks(stop(cwd, s)), true);
  assert.ok(cg.readFlag(s), 'the flag file is still there');
  const crossed = project(160000); // the same for a flag from the token crossing
  call(hook(crossed.cwd, crossed.s, 'PreToolUse', { tool_name: 'Bash', tool_input: {} }));
  assert.ok(cg.readFlag(crossed.s));
  writeCtx(crossed.cwd, crossed.s, 20000);
  assert.equal(blocks(stop(crossed.cwd, crossed.s)), true);
});

test('SENT with a foreign old_session_id does not clear the flag; SENT with this session does', () => {
  const { cwd, s } = project(9000);
  compact(cwd, s);
  writeHandoff(cwd, 'SENT', 'some-other-session');
  assert.equal(blocks(stop(cwd, s)), true, 'a foreign SENT');
  assert.equal(agentDenied(cwd, s), true);
  assert.ok(cg.readFlag(s));
  writeHandoff(cwd, 'DRAFT', s);
  rewind(s);
  assert.equal(blocks(stop(cwd, s)), true, 'DRAFT of this session');
  writeHandoff(cwd, 'SENT', s);
  const r = stop(cwd, s);
  assert.equal(r.out, '', 'SENT of this session: silent');
  assert.equal(cg.readFlag(s), null, 'and the flag is gone');
  assert.equal(agentDenied(cwd, s), false, 'low tokens and no flag: free again');
});

test('SENT of this session is not undone by a high token number (no new flag)', () => {
  const { cwd, s } = project(160000);
  writeHandoff(cwd, 'SENT', s);
  assert.equal(stop(cwd, s).out, '');
  call(hook(cwd, s, 'UserPromptSubmit'));
  assert.equal(cg.readFlag(s), null, 'the crossing does not write a flag again once SENT');
  assert.equal(blocks(stop(cwd, s)), false);
});

test('Stop blocks once per turn until SENT, never on stop_hook_active; the reason has no numbers', () => {
  const { cwd, s } = project(9000);
  compact(cwd, s);
  for (let i = 0; i < 3; i++) {
    const first = stop(cwd, s);
    assert.equal(blocks(first), true, `turn ${i}`);
    noNumbers(json(first).reason, s);
    assert.match(json(first).reason, /ghorc:handoff/);
    assert.equal(blocks(stop(cwd, s, true)), false, `turn ${i}: stop_hook_active`);
    rewind(s); // the next turn is more than 60 s later
  }
  writeHandoff(cwd, 'SENT', s);
  assert.equal(blocks(stop(cwd, s)), false);
});

test('the reminder reaches the model: additionalContext of UserPromptSubmit, without token numbers', () => {
  const { cwd, s } = project(9000);
  compact(cwd, s);
  const t = text(call(hook(cwd, s, 'UserPromptSubmit')));
  assert.match(t, /Handoff due.*compacted.*unreliable.*ghorc:handoff/);
  assert.doesNotMatch(t, /\d+K\b/);
  const j = json(call(hook(cwd, s, 'UserPromptSubmit')));
  assert.ok(j.hookSpecificOutput.additionalContext, 'additionalContext, not systemMessage');
  assert.equal(j.systemMessage, undefined);
});

test('a non-lead session (GHORC_ROLE=worker) gets a reminder only: no deny, no block', () => {
  const { cwd, s } = project(9000);
  const env = { GHORC_ROLE: 'worker' };
  assert.equal(call(hook(cwd, s, 'UserPromptSubmit'), env).out, '', 'no flag, nothing to say');
  compact(cwd, s, env);
  assert.ok(cg.readFlag(s), 'a compaction flags the worker too');
  assert.match(text(call(hook(cwd, s, 'UserPromptSubmit'), env)), /compacted.*Finish the task/);
  const st = call(hook(cwd, s, 'Stop', { stop_hook_active: false }), env);
  assert.equal(blocks(st), false);
  assert.match(json(st).systemMessage, /compacted/);
  assert.equal(isDeny(call(hook(cwd, s, 'PreToolUse', { tool_name: 'Agent', tool_input: {} }), env)), false);
  assert.equal(isDeny(call(hook(cwd, s, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'x.js') } }), env)), false);
  const sub = call(hook(cwd, s, 'SessionStart', { source: 'compact', agent_id: 'ag1' }));
  assert.equal(sub.out, '', 'a subagent is never touched');
});

test('a broken ctx file is reported as found, bad JSON; a missing one as no ctx file', () => {
  const cwd = tmpProject({});
  const s = sid();
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', `ctx-${s}.json`), '{"current_usage": {');
  const r = call(hook(cwd, s, 'UserPromptSubmit'));
  assert.match(text(r), /Context guard inactive: the ctx file was found, bad JSON/);
  assert.doesNotMatch(text(r), /no ctx file/);
  const root = require('../scripts/lib/config.cjs').projectRoot(cwd);
  const ctx = cg.readCtx(root, s);
  assert.equal(ctx.found, true);
  assert.equal(ctx.bad, true);
  assert.equal(ctx.tokens, null);
  const none = call(hook(cwd, sid(), 'UserPromptSubmit'));
  assert.match(text(none), /no ctx file/);
  assert.equal(cg.readCtx(root, 'nothing-here').found, false);
});

test('ctx.cjs: the numbers stay; one extra line after a compaction of this session', () => {
  const { cwd, s } = project(9000);
  const ctxOut = () => runScript('ctx.cjs', '', { args: ['--session', s, '--cwd', cwd] }).out;
  const before = ctxOut();
  assert.match(before, /used=9000\/1000000/);
  assert.doesNotMatch(before, /unreliable/);
  compact(cwd, s);
  const after = ctxOut();
  assert.match(after, /ctx 9%.*used=9000\/1000000/, 'numbers unchanged');
  assert.match(after, /compacted.*unreliable.*handoff is due/);
  assert.equal(after.split('\n').filter((l) => /unreliable/.test(l)).length, 1);
  const other = project(9000); // another session without a compaction
  const o = runScript('ctx.cjs', '', { args: ['--all', '--cwd', other.cwd] }).out;
  assert.doesNotMatch(o, /unreliable/);
});

test('inFlightBranches: branch: and branches: fields of the in_flight section only', () => {
  const dir = fs.mkdtempSync(path.join(TEST_TMP, 'state-'));
  const f = path.join(dir, 'STATE.md');
  const read = (body) => {
    fs.writeFileSync(f, body);
    return cg.inFlightBranches(f);
  };
  assert.equal(cg.inFlightBranches(path.join(dir, 'none.md')), null, 'no file');
  assert.equal(read('# STATE\n## Next\n- branch: feat/other\n'), null, 'no in_flight section');
  assert.deepEqual(read('## in_flight (mandatory)\n- none\n## Decisions\n- branch: feat/not-me\n'), []);
  assert.deepEqual(read('## in_flight (mandatory)\n- w1, impl, branch: feat/a, out: x.md\n- w2 `branch: fix/b`; collect: y\n'), ['feat/a', 'fix/b']);
  assert.deepEqual(read('## in_flight\n- w3 branches: feat/c, feat/d (two)\n'), ['feat/c', 'feat/d']);
  assert.deepEqual(read('## in_flight\n- agent, branch: <name>\n'), [], 'a template placeholder is ignored');
});

// ---- push before handoff ----

const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
function git(cwd, ...args) {
  const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
// a repo with a bare origin, main pushed, a feature branch with one local commit (not pushed) and a STATE file
function repo(config) {
  const cwd = tmpProject(config);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-bare-'));
  const cleanup = () => fs.rmSync(bare, { recursive: true, force: true });
  process.on('exit', cleanup);
  git(bare, 'init', '--bare', '-q');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  git(cwd, 'add', 'a.txt');
  git(cwd, 'commit', '-q', '-m', 'init');
  git(cwd, 'push', '-q', 'origin', 'main');
  git(cwd, 'checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(cwd, 'b.txt'), 'b\n');
  git(cwd, 'add', 'b.txt');
  git(cwd, 'commit', '-q', '-m', 'work');
  return cwd;
}

test('unpushed.cjs: lists branches ahead of or missing on origin, exit 1 when any, no network', () => {
  const cwd = repo({});
  const run = (...args) => runScript('unpushed.cjs', '', { args: [...args, '--cwd', cwd] });
  let r = run();
  assert.equal(r.code, 1);
  assert.match(r.out, /feat\/x: not on origin/);
  assert.doesNotMatch(r.out, /^main:/m, 'main is pushed and not listed');
  r = run('--branches', 'feat/x,main');
  assert.equal(r.code, 1);
  assert.match(r.out, /feat\/x: not on origin.*head [0-9a-f]{12}/);
  assert.match(r.out, /main: pushed, head [0-9a-f]{12}/);
  git(cwd, 'push', '-q', 'origin', 'feat/x');
  r = run();
  assert.equal(r.code, 0);
  assert.match(r.out, /all local branches are on origin/);
  fs.appendFileSync(path.join(cwd, 'b.txt'), 'more\n');
  git(cwd, 'commit', '-q', '-am', 'more');
  r = run('--branches', 'feat/x');
  assert.equal(r.code, 1);
  assert.match(r.out, /feat\/x: 1 commit\(s\) ahead of origin\/feat\/x/);
  assert.equal(run('--branches', 'nope').code, 1);
  assert.match(run('--branches', 'nope').out, /nope: no local branch/);
  const plain = fs.mkdtempSync(path.join(TEST_TMP, 'norepo-'));
  const nr = runScript('unpushed.cjs', '', { args: ['--cwd', plain] });
  assert.equal(nr.code, 2);
  assert.match(nr.out, /not a git repository/);
});

test('handoff.pushGuard: off by default; on, it denies herdr agent start while an in-flight branch is unpushed; fails open without in_flight', () => {
  const start = 'herdr agent start lead-next --kind claude --pane w1:p2 -- --model opus';
  const bashPre = (cwd, s, command, tool = 'Bash') => call(hook(cwd, s, 'PreToolUse', { tool_name: tool, tool_input: { command } }));
  const stateWith = (cwd, body) => fs.writeFileSync(path.join(cwd, 'STATE.md'), body);
  const inFlight = '# STATE\n## in_flight (mandatory)\n- w1, impl, branch: feat/x, out: report.md\n## Decisions\n- none\n';

  // off by default
  const off = repo({});
  const so = sid();
  writeCtx(off, so, 160000);
  stateWith(off, inFlight);
  assert.equal(isDeny(bashPre(off, so, start)), false, 'pushGuard is not set: nothing denied');

  // on
  const cwd = repo({ handoff: { pushGuard: true } });
  const s = sid();
  writeCtx(cwd, s, 160000);
  stateWith(cwd, inFlight);
  const denied = bashPre(cwd, s, start);
  assert.equal(isDeny(denied), true, 'unpushed feat/x');
  assert.match(JSON.parse(denied.out).hookSpecificOutput.permissionDecisionReason, /pushGuard.*feat\/x/);
  assert.equal(isDeny(bashPre(cwd, s, start, 'PowerShell')), true, 'the PowerShell tool too');
  assert.equal(isDeny(bashPre(cwd, s, 'git status')), false, 'other commands are not touched');
  assert.equal(isDeny(bashPre(cwd, s, 'herdr agent list')), false);
  git(cwd, 'push', '-q', 'origin', 'feat/x');
  assert.equal(isDeny(bashPre(cwd, s, start)), false, 'pushed: allowed');

  // fail open: no in_flight field, none listed, branch unknown locally
  const open = repo({ handoff: { pushGuard: true } });
  const sf = sid();
  writeCtx(open, sf, 160000);
  for (const body of ['# STATE\n## Next\n- branch: feat/x\n', '# STATE\n## in_flight\n- none\n', '# STATE\n## in_flight\n- w9 branch: gone/branch\n']) {
    stateWith(open, body);
    assert.equal(isDeny(bashPre(open, sf, start)), false, body);
  }
  fs.rmSync(path.join(open, 'STATE.md'));
  assert.equal(isDeny(bashPre(open, sf, start)), false, 'no STATE file');

  // outside handoff mode the guard does nothing
  const low = repo({ handoff: { pushGuard: true } });
  const sl = sid();
  writeCtx(low, sl, 50000);
  stateWith(low, inFlight);
  assert.equal(isDeny(bashPre(low, sl, start)), false, 'not in handoff mode');
});

// ---- fix round 1: opt-in, roles, parsers, pushGuard fail-open, backstop ----

const noFile = (cfg) => {
  const cwd = tmpProject(cfg); // undefined: no .claude/ghorc.json at all (the helper writes none)
  const s = sid();
  writeCtx(cwd, s, 9000);
  fs.writeFileSync(path.join(cwd, 'STATE.md'), 'state\n');
  return { cwd, s };
};

test('handoff.stickyOnCompact absent or false: a compaction equals 0.7.0 (no output, no flag, nothing denied or blocked)', () => {
  const configs = [undefined, {}, { handoff: {} }, { handoff: { stickyOnCompact: false } }];
  for (const cfg of configs) {
    const { cwd, s } = noFile(cfg);
    if (cfg === undefined) assert.equal(fs.existsSync(path.join(cwd, '.claude', 'ghorc.json')), false, 'no config file');
    // every role with no config file at all; the lead only for the other spellings of 'off'
    for (const env of cfg === undefined ? [LEAD, ROLELESS, { GHORC_ROLE: 'worker' }] : [LEAD]) {
      const label = `${JSON.stringify(cfg)} ${env.GHORC_ROLE || 'roleless'}`;
      const r = compact(cwd, s, env);
      assert.equal(r.code, 0, label);
      assert.equal(r.out, '', `${label}: no output on source compact`);
      assert.equal(cg.readFlag(s), null, `${label}: no flag`);
      assert.equal(agentDenied(cwd, s, env), false, label);
      assert.equal(editDenied(cwd, s, path.join(cwd, 'src.js'), env), false, label);
      for (let i = 0; i < 3; i++) assert.equal(stop(cwd, s, false, env).out, '', `${label}: Stop ${i} silent`);
      assert.equal(call(hook(cwd, s, 'UserPromptSubmit'), env).out, '', label);
    }
  }
});

test('stickyOnCompact off: the number-crossed flag keeps the 0.7.0 Stop (2 blocks, released by a newer STATE)', () => {
  const { cwd, s } = project(160000, {});
  assert.equal(blocks(stop(cwd, s)), true);
  assert.equal(blocks(stop(cwd, s)), true);
  assert.match(text(stop(cwd, s)), /did not hand over the shift: context 160K/);
});

test('stickyOnCompact on, no GHORC_ROLE: a compaction gives a reminder only, never a text about HANDOFF or SENT', () => {
  const { cwd, s } = project(9000);
  const start = compact(cwd, s, ROLELESS);
  assert.match(text(start), /compacted.*token numbers are unreliable/);
  assert.ok(cg.readFlag(s), 'the compaction is recorded');
  const prompt = call(hook(cwd, s, 'UserPromptSubmit'), ROLELESS);
  assert.match(text(prompt), /compacted/);
  const st = stop(cwd, s, false, ROLELESS);
  assert.equal(blocks(st), false);
  const all = [text(start), text(prompt), text(st)].join('\n');
  assert.doesNotMatch(all, /HANDOFF|SENT|ghorc:handoff|STATE\.md|Handoff/);
  assert.equal(agentDenied(cwd, s, ROLELESS), false);
  assert.equal(editDenied(cwd, s, path.join(cwd, 'src.js'), ROLELESS), false);
  // and no write of SENT is asked for at any of the three events
  assert.equal(call(hook(cwd, s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), ROLELESS).out, '');
  // crossing ctxHandoff afterwards is the number-crossed flag: it keeps its 0.7.0 reach
  writeCtx(cwd, s, 160000);
  assert.equal(agentDenied(cwd, s, ROLELESS), true, 'a number-crossed flag reaches a roleless session');
});

test('stickyOnCompact on, GHORC_ROLE=lead (any case or padding): the block and the denies apply', () => {
  for (const role of ['lead', ' LEAD ', 'Lead']) {
    const { cwd, s } = project(9000);
    const env = { ...LEAD, GHORC_ROLE: role };
    assert.match(text(compact(cwd, s, env)), /handoff is due.*ghorc:handoff/, role);
    assert.equal(agentDenied(cwd, s, env), true, role);
    assert.equal(editDenied(cwd, s, path.join(cwd, 'src.js'), env), true, role);
    assert.equal(blocks(stop(cwd, s, false, env)), true, role);
  }
});

test('GHORC_ROLE is trimmed and lowercased: worker, Worker and "worker " are all workers', () => {
  const role = require('../scripts/lib/role.cjs');
  const saved = process.env.GHORC_ROLE;
  try {
    for (const v of ['worker', 'Worker', 'WORKER', 'worker ', ' worker']) {
      process.env.GHORC_ROLE = v;
      assert.equal(role.isWorker(), true, JSON.stringify(v));
      assert.equal(role.isLead(), false);
    }
    process.env.GHORC_ROLE = ' Lead';
    assert.equal(role.isLead(), true);
    delete process.env.GHORC_ROLE;
    assert.equal(role.role(), '');
  } finally {
    if (saved === undefined) delete process.env.GHORC_ROLE;
    else process.env.GHORC_ROLE = saved;
  }
  const cwd = tmpProject({ heavyCommands: [] });
  const hv = (env) => runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: sid(), cwd, tool_name: 'Bash', tool_input: { command: 'herdr agent start w1 --kind claude' } }, { env });
  for (const v of ['worker ', 'Worker', 'WORKER']) assert.equal(isDeny(hv({ GHORC_ROLE: v })), true, `heavy guard: ${JSON.stringify(v)}`);
  assert.equal(isDeny(hv({ GHORC_ROLE: 'lead' })), false);
  // the context guard: a padded "worker " gets the worker reminder, not the lead's deny
  const { cwd: c2, s } = project(9000);
  const env = { GHORC_ROLE: 'Worker ' };
  compact(c2, s, env);
  assert.match(text(call(hook(c2, s, 'UserPromptSubmit'), env)), /Finish the task/);
  assert.equal(agentDenied(c2, s, env), false);
});

test('Stop backstop: a repeat block within 60 s for the session passes, also without stop_hook_active', () => {
  const { cwd, s } = project(9000);
  compact(cwd, s);
  const bare = () => call({ hook_event_name: 'Stop', session_id: s, cwd }); // no stop_hook_active field at all
  assert.equal(blocks(bare()), true, 'first');
  assert.equal(blocks(bare()), false, 'a repeat right away passes');
  rewind(s, 30 * SEC);
  assert.equal(blocks(bare()), false, 'still within 60 s of the block');
  rewind(s, 40 * SEC); // 70 s since the block
  assert.equal(blocks(bare()), true, 'a new turn after 60 s is blocked again');
  assert.ok(cg.readFlag(s), 'the passes did not clear the flag');
});

test('the block reason prints the literal header lines it waits for', () => {
  const { cwd, s } = project(9000);
  compact(cwd, s);
  const reason = json(stop(cwd, s)).reason;
  assert.ok(reason.includes('`status: SENT`'), reason);
  assert.ok(reason.includes(`\`old_session_id: ${s}\``), reason);
});

test('HANDOFF with CRLF, a BOM, markdown bold, backticks or a trailing comma clears the flag; a prefix of the id does not', () => {
  const cases = {
    crlf: (s) => `# HANDOFF\r\nhandoff_id: h-1\r\nstatus: SENT\r\nold_session_id: ${s}\r\n`,
    bom: (s) => `\uFEFF# HANDOFF\nstatus: SENT\nold_session_id: ${s}\n`,
    bold: (s) => `# HANDOFF\n**status:** SENT\n**old_session_id:** ${s}\n`,
    ticks: (s) => `# HANDOFF\nstatus: \`SENT\`\nold_session_id: \`${s}\`\n`,
    comma: (s) => `# HANDOFF\nhandoff_id: h-1, status: SENT, old_session_id: ${s},\n`,
  };
  for (const [name, make] of Object.entries(cases)) {
    const { cwd, s } = project(9000);
    compact(cwd, s);
    fs.writeFileSync(path.join(cwd, 'HANDOFF.md'), make(s));
    assert.equal(stop(cwd, s).out, '', name);
    assert.equal(cg.readFlag(s), null, `${name}: flag cleared`);
  }
  const { cwd, s } = project(9000);
  compact(cwd, s);
  fs.writeFileSync(path.join(cwd, 'HANDOFF.md'), `# HANDOFF\nstatus: SENT\nold_session_id: ${s.slice(0, 8)}\n`);
  assert.equal(blocks(stop(cwd, s)), true, 'the 8-character prefix is not the session');
});

test('inFlightBranches: field-initial branch only, no default branch, sub-headings stay in, CRLF', () => {
  const dir = fs.mkdtempSync(path.join(TEST_TMP, 'state2-'));
  const f = path.join(dir, 'STATE.md');
  const read = (body) => {
    fs.writeFileSync(f, body);
    return cg.inFlightBranches(f);
  };
  assert.deepEqual(read('## in_flight\n- w1 base branch: develop, branch: feat/a\n'), ['feat/a'], 'a qualified branch is not a package branch');
  assert.deepEqual(read('## in_flight\n- base branch: main\n'), [], 'base branch: main');
  assert.deepEqual(read('## in_flight\n- branch: main\n- branch: master\n'), [], 'the default branch is never required');
  assert.deepEqual(read('## in_flight\n- w1 branches: feat/a, feat/b, worktree D:\\p, out: x.md\n'), ['feat/a', 'feat/b'], 'a list ends at the first key');
  assert.deepEqual(read('## in_flight\n### w1\n- branch: feat/sub\n### w2\n- branch: "feat/q"\n- **branch:** **feat/r**\n'), ['feat/sub', 'feat/q', 'feat/r']);
  assert.deepEqual(read('## in_flight\n#### w1\n- branch: feat/deep\n## Next\n- branch: feat/other\n'), ['feat/deep'], 'a same-level heading ends the section');
  assert.deepEqual(read('### in_flight\n- branch: feat/x\n## Up\n- branch: feat/y\n'), ['feat/x'], 'a higher heading ends it');
  assert.deepEqual(read('## in_flight\r\n- w1, branch: feat/crlf\r\n- w2, `branch: feat/tick`\r\n## Next\r\n'), ['feat/crlf', 'feat/tick'], 'CRLF');
  assert.deepEqual(read('\uFEFF## in_flight\n- branch: feat/bom\n'), ['feat/bom'], 'BOM');
});

test('skills/handoff: the candidate accepts exactly READY seq + 1 together with SENT (no self-contradiction)', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'handoff', 'SKILL.md'), 'utf8');
  assert.match(skill, /accepts exactly the `seq` it reported in READY plus 1, together with `status: SENT`/);
  assert.match(skill, /any other `seq`, or `seq` \+ 1 without SENT, is refused/);
  assert.doesNotMatch(skill, /if `seq` moved since READY/);
  assert.match(skill, /State read: <path>, seq=<N>/, 'READY carries the seq it read');
  assert.match(skill, /writes `status: SENT` to the file and STATE \(`seq` \+ 1\)/);
});

test('ctx.cjs: a compaction of a roleless session says the number is unreliable, but not that the handoff is due', () => {
  const { cwd, s } = project(9000);
  compact(cwd, s, ROLELESS);
  const o = runScript('ctx.cjs', '', { args: ['--session', s, '--cwd', cwd] }).out;
  assert.match(o, /compacted.*unreliable/);
  assert.doesNotMatch(o, /handoff is due/);
});

// ---- pushGuard fails open ----

test('pushGuard fails open: no origin remote, and a fetch refspec that does not cover the branch', () => {
  const start = 'herdr agent start lead-next --kind claude --pane w1:p2 -- --model opus';
  const inFlight = '# STATE\n## in_flight (mandatory)\n- w1, impl, branch: feat/x, out: report.md\n';
  const bashPre = (cwd, s, command = start) => call(hook(cwd, s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command } }));
  const setup = () => {
    const cwd = repo({ handoff: { pushGuard: true } });
    const s = sid();
    writeCtx(cwd, s, 160000);
    fs.writeFileSync(path.join(cwd, 'STATE.md'), inFlight);
    return { cwd, s };
  };

  // control: origin has the default refspec and feat/x is not pushed -> deny
  const a = setup();
  assert.equal(isDeny(bashPre(a.cwd, a.s)), true, 'control');

  // (a) no origin remote
  git(a.cwd, 'remote', 'remove', 'origin');
  const s2 = sid();
  writeCtx(a.cwd, s2, 160000);
  assert.equal(isDeny(bashPre(a.cwd, s2)), false, 'no origin remote: fail open');
  const cli = runScript('unpushed.cjs', '', { args: ['--branches', 'feat/x', '--cwd', a.cwd] });
  assert.equal(cli.code, 2);
  assert.match(cli.out, /no origin remote/);

  // (b) a fetch refspec that covers main only (what --single-branch writes)
  const b = setup();
  git(b.cwd, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  assert.equal(isDeny(bashPre(b.cwd, b.s)), false, 'narrow refspec: fail open');
  const nb = runScript('unpushed.cjs', '', { args: ['--branches', 'feat/x,main', '--cwd', b.cwd] });
  assert.equal(nb.code, 0, nb.out);
  assert.match(nb.out, /feat\/x: not tracked by the fetch refspec of origin, cannot tell/);
  assert.match(nb.out, /main: pushed/);
  git(b.cwd, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  assert.equal(isDeny(bashPre(b.cwd, sid())), false, 'sanity: a new session without a ctx file is not in handoff mode');
  const s3 = sid();
  writeCtx(b.cwd, s3, 160000);
  assert.equal(isDeny(bashPre(b.cwd, s3)), true, 'the full refspec denies again');
});

test('pushGuard: a real --single-branch clone, pushed branch, is allowed; the default branch is never required', () => {
  const start = 'herdr agent start lead-next --kind claude --pane w1:p2 -- --model opus';
  const origin = repo({});
  const bare = git(origin, 'remote', 'get-url', 'origin');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-clone-'));
  process.on('exit', () => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'c');
  git(parent, 'clone', '-q', '--single-branch', '-b', 'main', bare, dir);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'ghorc.json'), JSON.stringify({ handoff: { pushGuard: true } }));
  git(dir, 'checkout', '-q', '-b', 'feat/y');
  fs.writeFileSync(path.join(dir, 'y.txt'), 'y\n');
  git(dir, 'add', 'y.txt');
  git(dir, 'commit', '-q', '-m', 'y');
  git(dir, 'push', '-q', 'origin', 'feat/y');
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/remotes/origin/feat/y'], { cwd: dir }).status === 0, false, 'the push left no remote-tracking ref (the reported case)');
  const s = sid();
  writeCtx(dir, s, 160000);
  fs.writeFileSync(path.join(dir, 'STATE.md'), '## in_flight\n- w1, branch: feat/y\n');
  const run1 = call(hook(dir, s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: start } }));
  assert.equal(isDeny(run1), false, 'pushed branch in a single-branch clone: allowed');

  // the default branch is never required, even when local main is ahead of origin/main
  const cwd = repo({ handoff: { pushGuard: true } });
  git(cwd, 'checkout', '-q', 'main');
  fs.appendFileSync(path.join(cwd, 'a.txt'), 'more\n');
  git(cwd, 'commit', '-q', '-am', 'main ahead');
  git(cwd, 'push', '-q', 'origin', 'feat/x');
  const s2 = sid();
  writeCtx(cwd, s2, 160000);
  fs.writeFileSync(path.join(cwd, 'STATE.md'), '## in_flight\n- w1 base branch: main, branch: feat/x\n');
  assert.equal(isDeny(call(hook(cwd, s2, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: start } }))), false, 'main ahead is not required');
  fs.writeFileSync(path.join(cwd, 'STATE.md'), '## in_flight\n- w1, branch: main\n');
  assert.equal(isDeny(call(hook(cwd, s2, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: start } }))), false, 'branch: main is ignored too');
});

test('pushGuard: in_flight names no branch -> allowed with a reminder that nothing was checked', () => {
  const start = 'herdr agent start lead-next --kind claude --pane w1:p2 -- --model opus';
  const cwd = repo({ handoff: { pushGuard: true } });
  const s = sid();
  writeCtx(cwd, s, 160000);
  for (const body of ['## in_flight\n- Branch of the package: feat/x (prose, no field)\n', '# STATE\n## Next\n- x\n']) {
    fs.writeFileSync(path.join(cwd, 'STATE.md'), body);
    const r = call(hook(cwd, s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: start } }));
    assert.equal(isDeny(r), false);
    assert.match(text(r), /pushGuard is on, but STATE in_flight names no `branch: <name>` field.*unpushed\.cjs/);
  }
  // a command that is not a herdr agent start gets no such reminder
  const other = call(hook(cwd, s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } }));
  assert.doesNotMatch(text(other), /pushGuard/);
});

// ---- fix round 2 ----

test('N1: a roleless session with a crossed flag takes the 0.7.0 Stop (2 blocks, then a message), never the sticky block', () => {
  const { cwd, s } = project(160000);
  call(hook(cwd, s, 'UserPromptSubmit'), ROLELESS); // crossing ctxHandoff writes the flag
  assert.ok(cg.readFlag(s));
  fs.writeFileSync(path.join(cwd, 'STATE.md'), 'state\n');
  const old = new Date(Date.now() - 60 * SEC);
  fs.utimesSync(path.join(cwd, 'STATE.md'), old, old); // STATE not newer than the flag: no release
  const reasons = [];
  for (let i = 0; i < 5; i++) {
    const r = stop(cwd, s, false, ROLELESS);
    reasons.push(text(r));
    assert.equal(blocks(r), i < 2, `Stop ${i}: 2 blocks, then capped (v0.7.0)`);
  }
  assert.match(reasons[2], /did not hand over the shift/);
  assert.doesNotMatch(reasons.join('\n'), /status: SENT|old_session_id/);
  // the lead with the same kind of flag still gets the sticky block
  const lead = project(160000);
  call(hook(lead.cwd, lead.s, 'UserPromptSubmit'), LEAD);
  assert.match(json(stop(lead.cwd, lead.s, false, LEAD)).reason, /`status: SENT`/);
});

test('N2: a qualifier applies only when whitespace alone separates it from branch; every branch: field on a line counts', () => {
  const start = 'herdr agent start lead-next --kind claude --pane w1:p2 -- --model opus';
  const cwd = repo({ handoff: { pushGuard: true } });
  const s = sid();
  writeCtx(cwd, s, 160000);
  const check = (line) => {
    fs.writeFileSync(path.join(cwd, 'STATE.md'), `## in_flight\n${line}\n`);
    return call(hook(cwd, s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: start } }));
  };
  for (const line of [
    '- w1 base branch: main, branch: feat/x',
    '- w1, base: main, branch: feat/x',
    '- w1, out: main, branch: feat/x',
    '- E310 on main, branch: feat/x',
    '- w1, branch: feat/x',
    '- branch: feat/x',
  ]) {
    const r = check(line);
    assert.equal(isDeny(r), true, `${line}: feat/x is unpushed and must be found`);
    assert.doesNotMatch(text(r), /names no/, line);
  }
  const f = path.join(cwd, 'STATE.md');
  const read = (line) => {
    fs.writeFileSync(f, `## in_flight\n${line}\n`);
    return cg.inFlightBranches(f);
  };
  assert.deepEqual(read('- branch: a, branch: b'), ['a', 'b']);
  assert.deepEqual(read('- (branch: a) (branch: b)'), ['a', 'b']);
  assert.deepEqual(read('- w1 branch: a; w2 branch: b'), ['a', 'b']);
  assert.deepEqual(read('- w1 base branch: develop, branch: a'), ['a']);
  assert.deepEqual(read('- w1 base branch: main'), []);
  assert.deepEqual(read('- w1 branches: a, b, branch: c'), ['a', 'b', 'c']);
});

test('N3: key off, a compaction-only flag left by a run with the key on counts as no flag (0.7.0)', () => {
  const { cwd, s } = noFile(undefined);
  cg.writeFlag(s, { ts: Date.now() - 5000, tokens: 0, compacted: true, lead: false });
  for (const env of [ROLELESS, LEAD]) {
    assert.equal(agentDenied(cwd, s, env), false, 'agent allowed');
    assert.equal(editDenied(cwd, s, path.join(cwd, 'src.js'), env), false, 'edit allowed');
    assert.equal(stop(cwd, s, false, env).out, '', 'Stop silent');
    assert.doesNotMatch(call(hook(cwd, s, 'UserPromptSubmit'), env).out, /context 9K|Handoff|compacted/);
  }
  // a flag from crossing (the 0.7.0 shape) is still a flag with the key off
  const x = noFile(undefined);
  cg.writeFlag(x.s, { ts: Date.now() - 5000, tokens: 160000, stopBlocks: 0 });
  assert.equal(agentDenied(x.cwd, x.s, ROLELESS), true);
});

test('N4: the reminder is added to the stage lines and watchdog alerts of a roleless session; it is not a deny', () => {
  const tmpMod = require('../scripts/lib/tmp.cjs');
  const { cwd, s } = project(145000);
  cg.writeFlag(s, { ts: Date.now() - 5000, tokens: 0, compacted: true, lead: false });
  const t = text(call(hook(cwd, s, 'UserPromptSubmit'), ROLELESS));
  assert.match(t, /compacted.*token numbers are unreliable/);
  assert.match(t, /prepare the handoff now/, 'the stage line stays');
  assert.equal(agentDenied(cwd, s, ROLELESS), false);
  assert.equal(editDenied(cwd, s, path.join(cwd, 'src.js'), ROLELESS), false);
  assert.equal(blocks(stop(cwd, s, false, ROLELESS)), false);
  assert.match(text(stop(cwd, s, false, ROLELESS)), /compacted/, 'Stop still says the reminder');
  // watchdog alerts are not skipped
  const alerts = tmpMod.alertsFile(cwd);
  fs.mkdirSync(path.dirname(alerts), { recursive: true });
  fs.appendFileSync(alerts, 'ALERT-LINE-1\n');
  const t2 = text(call(hook(cwd, s, 'UserPromptSubmit'), ROLELESS));
  assert.match(t2, /compacted/);
  assert.match(t2, /unread alert/);
  // a worker still gets the reminder only
  const w = project(145000);
  const wenv = { GHORC_ROLE: 'worker' };
  cg.writeFlag(w.s, { ts: Date.now() - 5000, tokens: 0, compacted: true, lead: false });
  const wt = text(call(hook(w.cwd, w.s, 'UserPromptSubmit'), wenv));
  assert.match(wt, /Finish the task/);
  assert.doesNotMatch(wt, /prepare the handoff/);
});

test('N6: a compaction after a crossing, or of a 0.7.0 flag, keeps the flag enforced; a compaction-only flag stays compaction-only', () => {
  // (a) crossed by the number, then compacted: a roleless session stays denied at low numbers
  const a = project(160000);
  call(hook(a.cwd, a.s, 'UserPromptSubmit'), ROLELESS);
  writeCtx(a.cwd, a.s, 9000);
  compact(a.cwd, a.s, ROLELESS);
  assert.equal(cg.readFlag(a.s).crossed, true);
  assert.equal(agentDenied(a.cwd, a.s, ROLELESS), true, 'crossed then compacted');
  // (b) a 0.7.0 flag (no compacted, no crossed) on upgrade, key on, then a compaction
  const b = project(9000);
  cg.writeFlag(b.s, { ts: Date.now() - 5000, tokens: 160000, stopBlocks: 0 });
  assert.equal(agentDenied(b.cwd, b.s, ROLELESS), true, '0.7.0 flag, key on: enforced');
  compact(b.cwd, b.s, ROLELESS);
  assert.equal(cg.readFlag(b.s).crossed, true);
  assert.equal(cg.compactOnly(cg.readFlag(b.s)), false);
  assert.equal(agentDenied(b.cwd, b.s, ROLELESS), true, '0.7.0 flag then compacted: still enforced');
  // (c) a compaction-only flag, compacted again, stays compaction-only
  const c = project(9000);
  compact(c.cwd, c.s, ROLELESS);
  compact(c.cwd, c.s, ROLELESS);
  assert.equal(cg.compactOnly(cg.readFlag(c.s)), true);
  assert.equal(agentDenied(c.cwd, c.s, ROLELESS), false);
});

test('N7: SKILL.md states the sticky qualifier, exit 2 / cannot tell and the lead role; session-start warns about a roleless sticky session', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'handoff', 'SKILL.md'), 'utf8');
  assert.match(skill, /With `handoff\.stickyOnCompact` and `GHORC_ROLE=lead`, Stop blocks you until/);
  assert.match(skill, /at most 2 blocks, released once STATE is newer/);
  assert.match(skill, /Exit 2 .*"cannot tell"/);
  assert.doesNotMatch(skill, /optional, a plain main session is the lead\)/);
  assert.match(skill, /created with `--env GHORC_ROLE=lead`/);
  const startWith = (cfg, role) =>
    runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid(), cwd: tmpProject(cfg) }, { env: { GHORC_NO_AUTOSTART: '1', ...(role ? { GHORC_ROLE: role } : {}) } }).out;
  assert.match(startWith(STICKY), /stickyOnCompact is on, but GHORC_ROLE is not set.*no enforcement until GHORC_ROLE=lead/);
  assert.doesNotMatch(startWith(STICKY, 'lead'), /no enforcement/);
  assert.doesNotMatch(startWith({}), /no enforcement/);
});

test('statusline prints the role through the helper: trimmed and lowercased', () => {
  const run = (role) => runScript('statusline.cjs', { session_id: sid(), cwd: tmpProject({}), context_window: { used_percentage: 5 } }, { env: { GHORC_ROLE: role, NO_COLOR: '1' } }).out;
  assert.match(run(' Worker '), /│ worker │/);
  assert.doesNotMatch(run('   '), /│ {2}│/);
});
