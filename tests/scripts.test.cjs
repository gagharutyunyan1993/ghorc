'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpProject, sid } = require('./helpers.cjs');
const config = require('../scripts/lib/config.cjs');

const PLAIN = { GHORC_STATUSLINE_PLAIN: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '', GHORC_GIT_TIMEOUT_MS: '15000' };

test('statusline: prints the line and writes the ctx file', () => {
  const cwd = tmpProject();
  const s = sid();
  const r = runScript('statusline.cjs', {
    session_id: s,
    cwd,
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    cost: { total_cost_usd: 1.234 },
    effort: { level: 'medium' },
    fast_mode: true,
    session_name: 'my-session',
    rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 75 } },
    context_window: {
      used_percentage: 12.4,
      context_window_size: 200000,
      current_usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 21000 },
    },
  }, { env: PLAIN });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'Opus 5.5 ·medium ⚡ │ ctx 12% (24K/200K) │ 5h 42% │ 7d 75% │ #' + s.slice(0, 8) + ' │ my-session');
  assert.ok(!r.out.includes('$'));
  const file = path.join(cwd, '.claude', `ctx-${s}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(d.session_id, s);
  assert.equal(d.used_percentage, 12.4);
  assert.equal(d.context_window_size, 200000);
  assert.equal(d.current_usage.cache_read_input_tokens, 21000);
  assert.ok(d.ts > 0);
  assert.equal(d.effort, 'medium');
  assert.equal(d.rate_limits.five_hour.used_percentage, 42);
});

test('statusline: empty fields (session start) do not crash', () => {
  const cwd = tmpProject();
  const r = runScript('statusline.cjs', { session_id: sid(), cwd, context_window: { used_percentage: null, current_usage: null } });
  assert.equal(r.code, 0);
  assert.match(r.out, /ctx --/);
});

test('statusline: no effort or rate_limits - segments are omitted', () => {
  const r = runScript('statusline.cjs', { cwd: tmpProject(), model: { display_name: 'Opus' }, context_window: { used_percentage: 10, context_window_size: 1000000, current_usage: { input_tokens: 76000 } } }, { env: PLAIN });
  assert.equal(r.out.trim(), 'Opus │ ctx 10% (76K/1M)');
});

test('statusline: colors by band and the autocompact marker', () => {
  const at = (p, env) => runScript('statusline.cjs', { cwd: tmpProject(), model: { display_name: 'M' }, context_window: { used_percentage: p, context_window_size: 200000 } }, { env: { GHORC_STATUSLINE_PLAIN: '', NO_COLOR: '', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '', ...env } }).out;
  assert.ok(at(10).includes('[32mctx 10%'));
  assert.ok(at(55).includes('[33mctx 55%'));
  assert.ok(at(72).includes('[31mctx 72%'));
  assert.ok(at(85).includes('[1;31mctx 85%'));
  assert.ok(!at(10, { NO_COLOR: '1' }).includes(''));
  assert.match(at(10, { GHORC_STATUSLINE_PLAIN: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '82' }), /→ac 82%/);
  assert.ok(!/→ac/.test(at(10, { GHORC_STATUSLINE_PLAIN: '1' })));
});

test('statusline: git branch omitted outside a repo; worktree and role', () => {
  const nonRepo = tmpProject();
  const r1 = runScript('statusline.cjs', { cwd: nonRepo, model: { display_name: 'M' }, context_window: { used_percentage: 1 } }, { env: PLAIN });
  assert.ok(!/⎇/.test(r1.out));
  assert.equal(r1.out.trim().split(' │ ').length, 2);
  const repo = tmpProject();
  const g = (...a) => require('node:child_process').spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-b', 'feat-x');
  const r2 = runScript('statusline.cjs', { cwd: repo, model: { display_name: 'M' }, workspace: { git_worktree: 'wt' }, context_window: { used_percentage: 1 } }, { env: { ...PLAIN, GHORC_ROLE: 'lead' } });
  assert.match(r2.out, /│ lead │ ⎇ feat-x/);
});

test('statusline: GHORC_STATUSLINE_DUMP appends the raw input, nothing by default', () => {
  const dir = tmpProject();
  const f = path.join(dir, 'dump.jsonl');
  runScript('statusline.cjs', { cwd: dir, a: 1 }, { env: { ...PLAIN, GHORC_STATUSLINE_DUMP: f } });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8').trim()).a, 1);
  const f2 = path.join(dir, 'none.jsonl');
  runScript('statusline.cjs', { cwd: dir }, { env: PLAIN });
  assert.ok(!fs.existsSync(f2));
});

test('statusline: garbage on stdin - exit 0', () => {
  assert.equal(runScript('statusline.cjs', 'oops').code, 0);
});

test('ctx.cjs --all: newest first, --max-age filters', () => {
  const cwd = tmpProject();
  const dir = path.join(cwd, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const mk = (name, pct, ageMin) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify({ used_percentage: pct, context_window_size: 200000, model: { display_name: 'M' } }));
    const t = new Date(Date.now() - ageMin * 60000);
    fs.utimesSync(p, t, t);
  };
  mk('ctx-old.json', 10, 120);
  mk('ctx-new.json', 55, 1);
  const r = runScript('ctx.cjs', '', { args: ['--cwd', cwd, '--all'] });
  const lines = r.out.trim().split('\n');
  assert.equal(r.code, 0);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /ctx-new\.json.*55%/);
  assert.match(lines[1], /ctx-old\.json/);
  const f = runScript('ctx.cjs', '', { args: ['--cwd', cwd, '--all', '--max-age', '30'] });
  assert.equal(f.out.trim().split('\n').length, 1);
  assert.match(f.out, /ctx-new/);
});

test('ctx.cjs: no directory - exit 0', () => {
  const r = runScript('ctx.cjs', '', { args: ['--cwd', path.join(tmpProject(), 'none'), '--all'] });
  assert.equal(r.code, 0);
});

test('config: the project config merges over the defaults', () => {
  const cwd = tmpProject({ readGuard: { maxRepeat: 7 }, lead: { effort: 'high' }, heavyCommands: ['x'] });
  const c = config.load(cwd);
  assert.equal(c.readGuard.maxRepeat, 7);
  assert.equal(c.readGuard.maxImageBytes, 2097152);
  assert.equal(c.lead.model, 'opus');
  assert.equal(c.lead.effort, 'high');
  assert.deepEqual(c.heavyCommands, ['x']);
  assert.equal(c.thresholds.ctxHandoff, 150000);
  assert.equal(config.found(cwd), true);
});

test('config: no file - defaults, found=false; broken JSON - the same', () => {
  const cwd = tmpProject();
  assert.equal(config.found(cwd), false);
  assert.equal(config.load(cwd).readGuard.maxRepeat, 3);
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'ghorc.json'), '{bad');
  assert.equal(config.load(cwd).thresholds.ctxPrepare, 120000);
});

test('session-start: a short reminder, under 300 characters', () => {
  const cwd = tmpProject();
  const r = runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid(), cwd });
  assert.equal(r.code, 0);
  assert.ok(r.out.length < 300, `length ${r.out.length}`);
  assert.match(r.out, /ghorc [0-9.]+ session=/);
  assert.match(r.out, /config not found/);
  assert.match(r.out, /skill ghorc:orc/);
});

test('watchdog: --once reports a large file and kills nothing', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'big.jsonl'), Buffer.alloc(2 * 1024 * 1024));
  const r = runScript('watchdog.cjs', '', { args: ['--once', '--root', root, '--warnMiB', '1'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /over 1 MiB/);
});

test('--help for all scripts', () => {
  for (const s of ['statusline.cjs', 'ctx.cjs', 'watchdog.cjs', 'heavy-check-guard.cjs', 'session-start.cjs']) {
    const r = runScript(s, '', { args: ['--help'] });
    assert.equal(r.code, 0, s);
    assert.ok(r.out.length > 10, s);
  }
});
