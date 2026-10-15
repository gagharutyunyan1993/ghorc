'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');

const read = (s, cwd, file, ti = {}, agent_id = 'ag1') => ({
  hook_event_name: 'PreToolUse',
  session_id: s,
  cwd,
  agent_id,
  tool_name: 'Read',
  tool_input: { file_path: file, ...ti },
});
const post = (s, cwd, tool, tool_input = {}, agent_id = 'ag1') => ({
  hook_event_name: 'PostToolUse',
  session_id: s,
  cwd,
  agent_id,
  tool_name: tool,
  tool_input,
});

test('A1: reading one file in parts still counts per path (offset and limit do not make a new key)', () => {
  const s = sid();
  const cwd = tmpProject();
  const offsets = [1, 2001, 4001, 6001];
  offsets.slice(0, 3).forEach((offset) => {
    assert.equal(isDeny(runScript('read-guard.cjs', read(s, cwd, 'big.log', { offset, limit: 2000 }))), false, `offset ${offset}`);
  });
  assert.equal(isDeny(runScript('read-guard.cjs', read(s, cwd, 'big.log', { offset: offsets[3], limit: 2000 }))), true);
});

test('A1: PDF pages of one file count per path; an identical call repeats up to the limit', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { leadNoMedia: false } });
  const m = { ...read(s, cwd, 'x.pdf', { pages: '1-5' }), agent_type: 'ghorc:media' };
  for (const pages of ['1-5', '6-10', '11-15']) {
    assert.equal(isDeny(runScript('read-guard.cjs', { ...m, tool_input: { file_path: 'x.pdf', pages } })), false, pages);
  }
  assert.equal(isDeny(runScript('read-guard.cjs', { ...m, tool_input: { file_path: 'x.pdf', pages: '16-20' } })), true);
  const s2 = sid();
  for (let i = 0; i < 3; i++) runScript('read-guard.cjs', read(s2, cwd, 'a.txt', { offset: 5 }));
  assert.equal(isDeny(runScript('read-guard.cjs', read(s2, cwd, 'a.txt', { offset: 5 }))), true);
});

test('P2-1: paths are normalized (relative and absolute are one file)', () => {
  const s = sid();
  const cwd = tmpProject();
  const abs = path.join(cwd, 'a.txt');
  runScript('read-guard.cjs', read(s, cwd, 'a.txt'));
  runScript('read-guard.cjs', read(s, cwd, abs));
  runScript('read-guard.cjs', read(s, cwd, './a.txt'));
  assert.equal(isDeny(runScript('read-guard.cjs', read(s, cwd, abs))), true);
});

test('A2: NotebookEdit of the same path resets; Bash and PowerShell never reset (no basename heuristic)', () => {
  const s = sid();
  const cwd = tmpProject();
  for (let i = 0; i < 3; i++) runScript('read-guard.cjs', read(s, cwd, 'a.ipynb'));
  runScript('read-guard.cjs', post(s, cwd, 'NotebookEdit', { notebook_path: 'a.ipynb' }));
  assert.equal(isDeny(runScript('read-guard.cjs', read(s, cwd, 'a.ipynb'))), false, 'notebook');
  for (const tool of ['Bash', 'PowerShell']) {
    const s2 = sid();
    for (let i = 0; i < 3; i++) runScript('read-guard.cjs', read(s2, cwd, 'a.txt'));
    runScript('read-guard.cjs', post(s2, cwd, tool, { command: 'echo hi > a.txt' }));
    const r = runScript('read-guard.cjs', read(s2, cwd, 'a.txt'));
    assert.equal(isDeny(r), true, tool);
    assert.doesNotMatch(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /Bash/);
  }
});

test('P2-10: the media role is not told to hand it to the media role', () => {
  const s = sid();
  const cwd = tmpProject();
  const input = { ...read(s, cwd, 'x.pdf'), agent_type: 'ghorc:media' };
  const r = runScript('read-guard.cjs', input);
  assert.match(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /pages/);
  assert.equal(isDeny(r), true);
  assert.doesNotMatch(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /to the media role/);
});

test('P2-5: no counter is kept without session_id', () => {
  const cwd = tmpProject();
  for (let i = 0; i < 6; i++) {
    assert.equal(isDeny(runScript('read-guard.cjs', read(undefined, cwd, 'a.txt'))), false);
  }
});

test('P1-3: the config is found from a project subdirectory (walk up to the git root)', () => {
  const cwd = tmpProject({ heavyCommands: ['\\bnpm\\s+test\\b'] });
  fs.mkdirSync(path.join(cwd, '.git'));
  const sub = path.join(cwd, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const input = { hook_event_name: 'PreToolUse', session_id: sid(), cwd: sub, agent_id: 'ag1', tool_name: 'Bash', tool_input: { command: 'NPM  test 2>&1 | tail' } };
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', input)), true);
});

test('P1-3: CLAUDE_PROJECT_DIR takes priority over cwd', () => {
  const proj = tmpProject({ heavyCommands: ['zzheavy'] });
  const other = tmpProject();
  const input = { hook_event_name: 'PreToolUse', session_id: sid(), cwd: other, agent_id: 'ag1', tool_name: 'Bash', tool_input: { command: 'zzheavy --go' } };
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', input, { env: { CLAUDE_PROJECT_DIR: proj } })), true);
  assert.equal(isDeny(runScript('heavy-check-guard.cjs', input)), false);
});

test('P1-3: config.load and found from a subdirectory', () => {
  const config = require('../scripts/lib/config.cjs');
  const cwd = tmpProject({ readGuard: { maxRepeat: 9 } });
  fs.mkdirSync(path.join(cwd, '.git'));
  const sub = path.join(cwd, 'x');
  fs.mkdirSync(sub);
  assert.equal(config.load(sub).readGuard.maxRepeat, 9);
  assert.equal(config.found(sub), true);
});

test('P1-2: the skill lead reminder goes to the lead only', () => {
  const cwd = tmpProject();
  const input = { hook_event_name: 'SessionStart', session_id: sid(), cwd };
  assert.match(runScript('session-start.cjs', input).out, /skill ghorc:lead/);
  assert.match(runScript('session-start.cjs', input, { env: { GHORC_ROLE: 'lead' } }).out, /skill ghorc:lead/);
  assert.doesNotMatch(runScript('session-start.cjs', input, { env: { GHORC_ROLE: 'worker' } }).out, /skill ghorc:lead/);
  assert.doesNotMatch(runScript('session-start.cjs', { ...input, agent_id: 'a1' }).out, /skill ghorc:lead/);
  const off = tmpProject({ lead: { remind: false } });
  assert.doesNotMatch(runScript('session-start.cjs', { ...input, cwd: off }).out, /skill ghorc:lead/);
  assert.match(runScript('session-start.cjs', { ...input, cwd: off }, { env: { GHORC_ROLE: 'lead' } }).out, /skill ghorc:lead/);
});

test('P2-4: check-config catches a broken regex, session-start prints one line', () => {
  const cwd = tmpProject({ heavyCommands: ['(['], readGuard: { maxRepeat: 'three' }, bogus: 1 });
  const r = runScript('check-config.cjs', '', { args: ['--cwd', cwd] });
  assert.equal(r.code, 1);
  assert.match(r.out, /regex does not compile/);
  assert.match(r.out, /unknown key: bogus/);
  assert.match(r.out, /readGuard\.maxRepeat/);
  const s = runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid(), cwd });
  assert.equal(s.out.split('\n').filter((l) => l.startsWith('config invalid')).length, 1);
});

test('P2-4: check-config --sample and a valid config', () => {
  const cwd = tmpProject({ heavyCommands: ['\\bnpm\\s+(run\\s+)?test\\b(?!:)'] });
  const r = runScript('check-config.cjs', '', { args: ['--cwd', cwd, '--sample', 'NPM  test; echo done', '--sample', 'git status'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /sample "NPM  test; echo done": HEAVY/);
  assert.match(r.out, /sample "git status": ordinary/);
  assert.match(r.out, /no errors/);
});

test('P2-4: invalid config JSON does not break the hooks (fail open)', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'ghorc.json'), '{bad');
  const r = runScript('check-config.cjs', '', { args: ['--cwd', cwd] });
  assert.equal(r.code, 1);
  assert.match(r.out, /invalid JSON/);
});

test('F8: --notify spawns an argv array without a shell; the alert text is the last argument', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'dir with space'));
  fs.writeFileSync(path.join(root, 'dir with space', 'big file.jsonl'), Buffer.alloc(2 * 1024 * 1024));
  const out = path.join(root, 'notify.json');
  const script = path.join(root, 'notify.cjs');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({argv: process.argv.slice(2), env: process.env.GHORC_ALERT}));`);
  const r = runScript('watchdog.cjs', '', { args: ['--once', '--root', root, '--warnMiB', '1', '--notify', `"${process.execPath}" "${script}" fixed`] });
  assert.equal(r.code, 0);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(got.argv.length, 2);
  assert.equal(got.argv[0], 'fixed');
  assert.match(got.argv[1], /big file\.jsonl/);
  assert.equal(got.env, got.argv[1]);
  // shell metacharacters in the alert text are inert: no shell is involved
  assert.ok(!fs.existsSync(path.join(root, 'pwned')));
});

test('P2-7: the watchdog alerts about a subagent file above the threshold', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, 'subagents'));
  fs.writeFileSync(path.join(root, 'subagents', 'a.jsonl'), Buffer.alloc(2 * 1024 * 1024));
  const r = runScript('watchdog.cjs', '', { args: ['--once', '--root', root, '--warnMiB', '100', '--subagentsMiB', '1'] });
  assert.match(r.out, /subagent file over 1 MiB/);
});

test('P2-8: statusline writes to the project root (git), atomically, ctx --session', () => {
  const proj = tmpProject();
  fs.mkdirSync(path.join(proj, '.git'));
  const sub = path.join(proj, 'sub');
  fs.mkdirSync(sub);
  const s1 = sid();
  const s2 = sid();
  for (const s of [s1, s2]) runScript('statusline.cjs', { session_id: s, cwd: sub, context_window: { used_percentage: 5 } });
  assert.ok(fs.existsSync(path.join(proj, '.claude', `ctx-${s1}.json`)));
  assert.ok(!fs.existsSync(path.join(sub, '.claude')));
  assert.equal(fs.readdirSync(path.join(proj, '.claude')).filter((f) => f.endsWith('.tmp')).length, 0);
  const r = runScript('ctx.cjs', '', { args: ['--cwd', sub, '--session', s2] });
  assert.equal(r.out.trim().split('\n').length, 1);
  assert.match(r.out, new RegExp(`ctx-${s2}`));
  // workspace.project_dir beats cwd
  const pd = tmpProject();
  const s3 = sid();
  runScript('statusline.cjs', { session_id: s3, cwd: sub, workspace: { project_dir: pd }, context_window: {} });
  assert.ok(fs.existsSync(path.join(pd, '.claude', `ctx-${s3}.json`)));
});

test('F8: --notify with a .cmd script works through "cmd /c" on Windows', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'big file.jsonl'), Buffer.alloc(2 * 1024 * 1024));
  const out = path.join(root, 'n.json');
  const js = path.join(root, 'n.cjs');
  fs.writeFileSync(js, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`);
  const cmd = path.join(root, 'notify.cmd');
  fs.writeFileSync(cmd, `@echo off\r\nnode "${js}" %*\r\n`);
  const r = runScript('watchdog.cjs', '', { args: ['--once', '--root', root, '--warnMiB', '1', '--notify', `cmd /c "${cmd}"`] });
  assert.equal(r.code, 0);
  const argv = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(argv.length, 1);
  assert.match(argv[0], /big file\.jsonl/);
});

test('round 2: the project root from a worktree is the main repository (git worktree add)', () => {
  const { spawnSync } = require('node:child_process');
  const config = require('../scripts/lib/config.cjs');
  const repo = fs.realpathSync(tmpProject());
  const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  assert.equal(git(repo, 'init', '-q').status, 0);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  git(repo, 'add', '-A');
  assert.equal(git(repo, 'commit', '-q', '-m', 'i').status, 0);
  const wt = path.join(path.dirname(repo), path.basename(repo) + '-wt');
  assert.equal(git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt1').status, 0);
  try {
    const real = (p) => fs.realpathSync(p).toLowerCase();
    assert.equal(real(config.projectRoot(wt)), real(repo));
    // statusline from a worktree writes ctx to the main repository
    const s = sid();
    runScript('statusline.cjs', { session_id: s, cwd: wt, context_window: { used_percentage: 3 } });
    assert.ok(fs.existsSync(path.join(repo, '.claude', `ctx-${s}.json`)));
    assert.ok(!fs.existsSync(path.join(wt, '.claude')));
    // ctx.cjs from a worktree sees the same file
    assert.match(runScript('ctx.cjs', '', { args: ['--cwd', wt, '--session', s] }).out, new RegExp(`ctx-${s}`));
    // the main repository config is found from the worktree
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'ghorc.json'), JSON.stringify({ readGuard: { maxRepeat: 8 } }));
    assert.equal(config.load(wt).readGuard.maxRepeat, 8);
  } finally {
    git(repo, 'worktree', 'remove', '--force', wt);
    fs.rmSync(wt, { recursive: true, force: true });
  }
});
