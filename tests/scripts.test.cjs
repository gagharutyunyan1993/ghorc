'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpProject, sid } = require('./helpers.cjs');
const config = require('../scripts/lib/config.cjs');

const PLAIN = { GHORC_STATUSLINE_PLAIN: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '' };

test('statusline: печатает строку и пишет ctx-файл', () => {
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
  assert.equal(r.out.trim(), 'Opus 5.5 ·medium ⚡ │ ctx 12% (24K/200K) │ 5h 42% │ 7d 75% │ my-session');
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

test('statusline: пустые поля (начало сессии) не падают', () => {
  const cwd = tmpProject();
  const r = runScript('statusline.cjs', { session_id: sid(), cwd, context_window: { used_percentage: null, current_usage: null } });
  assert.equal(r.code, 0);
  assert.match(r.out, /ctx --/);
});

test('statusline: нет effort и rate_limits - сегменты опущены', () => {
  const r = runScript('statusline.cjs', { cwd: tmpProject(), model: { display_name: 'Opus' }, context_window: { used_percentage: 10, context_window_size: 1000000, current_usage: { input_tokens: 76000 } } }, { env: PLAIN });
  assert.equal(r.out.trim(), 'Opus │ ctx 10% (76K/1M)');
});

test('statusline: цвета по полосам и маркер автокомпакта', () => {
  const at = (p, env) => runScript('statusline.cjs', { cwd: tmpProject(), model: { display_name: 'M' }, context_window: { used_percentage: p, context_window_size: 200000 } }, { env: { GHORC_STATUSLINE_PLAIN: '', NO_COLOR: '', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '', ...env } }).out;
  assert.ok(at(10).includes('[32mctx 10%'));
  assert.ok(at(55).includes('[33mctx 55%'));
  assert.ok(at(72).includes('[31mctx 72%'));
  assert.ok(at(85).includes('[1;31mctx 85%'));
  assert.ok(!at(10, { NO_COLOR: '1' }).includes(''));
  assert.match(at(10, { GHORC_STATUSLINE_PLAIN: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '82' }), /→ac 82%/);
  assert.ok(!/→ac/.test(at(10, { GHORC_STATUSLINE_PLAIN: '1' })));
});

test('statusline: ветка git, не репозиторий - опущена; worktree и роль', () => {
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

test('statusline: GHORC_STATUSLINE_DUMP дописывает сырой ввод, по умолчанию нет', () => {
  const dir = tmpProject();
  const f = path.join(dir, 'dump.jsonl');
  runScript('statusline.cjs', { cwd: dir, a: 1 }, { env: { ...PLAIN, GHORC_STATUSLINE_DUMP: f } });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8').trim()).a, 1);
  const f2 = path.join(dir, 'none.jsonl');
  runScript('statusline.cjs', { cwd: dir }, { env: PLAIN });
  assert.ok(!fs.existsSync(f2));
});

test('statusline: мусор на stdin - exit 0', () => {
  assert.equal(runScript('statusline.cjs', 'oops').code, 0);
});

test('ctx.cjs: новые первыми, самый новый с *, --max-age фильтрует', () => {
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
  const r = runScript('ctx.cjs', '', { args: ['--cwd', cwd] });
  const lines = r.out.trim().split('\n');
  assert.equal(r.code, 0);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\* ctx-new\.json.*55%/);
  assert.match(lines[1], /^ {2}ctx-old\.json/);
  const f = runScript('ctx.cjs', '', { args: ['--cwd', cwd, '--max-age', '30'] });
  assert.equal(f.out.trim().split('\n').length, 1);
  assert.match(f.out, /ctx-new/);
});

test('ctx.cjs: нет каталога - exit 0', () => {
  const r = runScript('ctx.cjs', '', { args: ['--cwd', path.join(tmpProject(), 'none')] });
  assert.equal(r.code, 0);
});

test('config: конфиг проекта сливается поверх значений по умолчанию', () => {
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

test('config: без файла - значения по умолчанию, found=false; битый JSON - тоже', () => {
  const cwd = tmpProject();
  assert.equal(config.found(cwd), false);
  assert.equal(config.load(cwd).readGuard.maxRepeat, 3);
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'ghorc.json'), '{bad');
  assert.equal(config.load(cwd).thresholds.ctxPrepare, 120000);
});

test('session-start: короткое напоминание, <300 символов', () => {
  const cwd = tmpProject();
  const r = runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid(), cwd });
  assert.equal(r.code, 0);
  assert.ok(r.out.length < 300, `длина ${r.out.length}`);
  assert.match(r.out, /ghorc 0.2.0/);
  assert.match(r.out, /конфиг не найден/);
  assert.match(r.out, /skill orc/);
});

test('watchdog: --once сообщает о большом файле и ничего не убивает', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'big.jsonl'), Buffer.alloc(2 * 1024 * 1024));
  const r = runScript('watchdog.cjs', '', { args: ['--once', '--root', root, '--warnMiB', '1'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /больше 1 MiB/);
});

test('--help у всех скриптов', () => {
  for (const s of ['statusline.cjs', 'ctx.cjs', 'watchdog.cjs', 'heavy-check-guard.cjs', 'session-start.cjs']) {
    const r = runScript(s, '', { args: ['--help'] });
    assert.equal(r.code, 0, s);
    assert.ok(r.out.length > 10, s);
  }
});
