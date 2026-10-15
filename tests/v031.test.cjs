'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript, isDeny, tmpProject, sid } = require('./helpers.cjs');

const REPO = path.join(__dirname, '..');
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const lastJson = (o) => JSON.parse(o.trim().split('\n').pop());

test('root rule: in a worktree setup finds the main config and writes to the main root', () => {
  const main = mk('ghorc-v031-main-');
  const wtParent = mk('ghorc-v031-wt-');
  const home = mk('ghorc-v031-home-');
  const wt = path.join(wtParent, 'wt');
  try {
    git(main, 'init', '-q');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
    const w = git(main, 'worktree', 'add', '-q', wt, '-b', 'wtb');
    assert.equal(w.status, 0, w.stderr);
    fs.mkdirSync(path.join(main, '.claude'));
    fs.writeFileSync(path.join(main, '.claude', 'ghorc.json'), '{}');
    const env = { GHORC_HOME: home };
    const chk = lastJson(runScript('setup.cjs', '', { args: ['--check', '--cwd', wt], env }).out);
    assert.equal(chk.items.find((i) => i.id === 'config').ok, true, 'config found from the worktree');
    fs.rmSync(path.join(main, '.claude', 'ghorc.json'));
    const ap = runScript('setup.cjs', '', { args: ['--apply', 'config', '--cwd', wt], env });
    assert.equal(ap.code, 0, ap.out + ap.err);
    assert.ok(fs.existsSync(path.join(main, '.claude', 'ghorc.json')), 'written to the main root');
    assert.ok(!fs.existsSync(path.join(wt, '.claude', 'ghorc.json')), 'not written into the worktree');
  } finally {
    for (const d of [wtParent, main, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('root rule: statusline writes the ctx file under CLAUDE_PROJECT_DIR like ctx.cjs reads it', () => {
  const proj = tmpProject();
  const other = mk('ghorc-v031-other-');
  try {
    const env = { CLAUDE_PROJECT_DIR: proj };
    runScript('statusline.cjs', { session_id: 'abc', cwd: other, model: { display_name: 'M' } }, { env });
    assert.ok(fs.existsSync(path.join(proj, '.claude', 'ctx-abc.json')));
    assert.ok(!fs.existsSync(path.join(other, '.claude', 'ctx-abc.json')));
    const r = runScript('ctx.cjs', '', { env, cwd: other });
    assert.match(r.out, /ctx-abc\.json/);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('setup: statusLine pointing to an older plugin cache version is flagged and fixed', () => {
  const home = mk('ghorc-v031-home-');
  const cache = path.join(home, '.claude', 'plugins', 'cache', 'm', 'ghorc');
  const proj = tmpProject();
  try {
    const cur = path.join(cache, '0.3.1');
    for (const d of ['scripts', 'templates']) fs.cpSync(path.join(REPO, d), path.join(cur, d), { recursive: true });
    const old = path.join(cache, '0.3.0', 'scripts', 'statusline.cjs').split('\\').join('/');
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: `node "${old}"` } }),
    );
    const run = (args) =>
      spawnSync(process.execPath, [path.join(cur, 'scripts', 'setup.cjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, GHORC_HOME: home, CLAUDE_PROJECT_DIR: '' },
      });
    let c = lastJson(run(['--check', '--cwd', proj]).stdout);
    assert.equal(c.items.find((i) => i.id === 'statusLineStale').ok, false);
    const ap = run(['--apply', 'statusLineStale', '--cwd', proj]);
    assert.equal(ap.status, 0, ap.stdout + ap.stderr);
    c = lastJson(run(['--check', '--cwd', proj]).stdout);
    assert.equal(c.items.find((i) => i.id === 'statusLineStale').ok, true);
    const cmd = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).statusLine.command;
    assert.match(cmd, /0\.3\.1/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const pre = (file, extra = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: sid(),
  tool_name: 'Read',
  tool_input: { file_path: file, pages: '1' },
  ...extra,
});

test('read-guard: GHORC_ROLE=worker without agent_id is not the lead for media', () => {
  const proj = tmpProject();
  const f = path.join(proj, 'a.png');
  fs.writeFileSync(f, 'x');
  assert.equal(isDeny(runScript('read-guard.cjs', pre(f, { cwd: proj }), { cwd: proj })), true, 'lead denied');
  assert.equal(isDeny(runScript('read-guard.cjs', pre(f, { cwd: proj }), { cwd: proj, env: { GHORC_ROLE: 'worker' } })), false);
});

test('read-guard: extension checks are case-insensitive (.PDF, .PNG)', () => {
  const proj = tmpProject();
  const png = path.join(proj, 'BIG.PNG');
  fs.writeFileSync(png, Buffer.alloc(3 * 1024 * 1024));
  const pdf = path.join(proj, 'DOC.PDF');
  fs.writeFileSync(pdf, 'x');
  const sub = { agent_id: 'sub1', cwd: proj };
  const env = { GHORC_ROLE: 'worker' };
  assert.equal(isDeny(runScript('read-guard.cjs', pre(png, sub), { cwd: proj, env })), true, 'large .PNG denied');
  const nopages = { ...pre(pdf, sub), tool_input: { file_path: pdf } };
  assert.equal(isDeny(runScript('read-guard.cjs', nopages, { cwd: proj, env })), true, '.PDF without pages denied');
  assert.equal(isDeny(runScript('read-guard.cjs', pre(pdf, { cwd: proj }), { cwd: proj })), true, 'lead .PDF denied');
});

test('watchdog: alert state survives a restart; re-alerts only after growth of warnMiB/2 or a level rise', () => {
  const root = mk('ghorc-v031-wd-');
  const tmpd = mk('ghorc-v031-wdtmp-');
  const f = path.join(root, 'big.jsonl');
  const run = (extra = []) =>
    runScript('watchdog.cjs', '', {
      args: ['--once', '--root', root, '--warnMiB', '2', '--stopMiB', '1000', ...extra],
      env: { GHORC_TMP: tmpd },
    }).out;
  try {
    fs.writeFileSync(f, Buffer.alloc(3 * 1024 * 1024));
    assert.match(run(), /over 2 MiB/);
    assert.ok(fs.existsSync(path.join(tmpd, 'watchdog-state.json')));
    assert.doesNotMatch(run(), /over 2 MiB/, 'unchanged file: no repeat after restart');
    fs.writeFileSync(f, Buffer.alloc(3.5 * 1024 * 1024));
    assert.doesNotMatch(run(), /over 2 MiB/, 'growth below warnMiB/2: no repeat');
    fs.writeFileSync(f, Buffer.alloc(4.5 * 1024 * 1024));
    assert.match(run(), /over 2 MiB/, 'growth of warnMiB/2: alert again');
    const sub = path.join(root, 'subagents');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 's.jsonl'), Buffer.alloc(3 * 1024 * 1024));
    assert.match(run(['--subagentsMiB', '2']), /subagent file over 2 MiB/, 'level rose: alert');
    assert.doesNotMatch(run(['--subagentsMiB', '2']), /subagent file over/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpd, { recursive: true, force: true });
  }
});
