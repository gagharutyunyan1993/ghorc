'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpProject, sid } = require('./helpers.cjs');
const config = require('../scripts/lib/config.cjs');

test('statusline: печатает строку и пишет ctx-файл', () => {
  const cwd = tmpProject();
  const s = sid();
  const r = runScript('statusline.cjs', {
    session_id: s,
    cwd,
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    cost: { total_cost_usd: 1.234 },
    context_window: {
      used_percentage: 12.4,
      context_window_size: 200000,
      current_usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 21000 },
    },
  });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'Opus | ctx 12% (24K/200K) | $1.23');
  const file = path.join(cwd, '.claude', `ctx-${s}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(d.session_id, s);
  assert.equal(d.used_percentage, 12.4);
  assert.equal(d.context_window_size, 200000);
  assert.equal(d.current_usage.cache_read_input_tokens, 21000);
  assert.ok(d.ts > 0);
});

test('statusline: пустые поля (начало сессии) не падают', () => {
  const cwd = tmpProject();
  const r = runScript('statusline.cjs', { session_id: sid(), cwd, context_window: { used_percentage: null, current_usage: null } });
  assert.equal(r.code, 0);
  assert.match(r.out, /ctx --/);
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
  fs.writeFileSync(path.join(cwd, '.claude', 'orc-kit.json'), '{bad');
  assert.equal(config.load(cwd).thresholds.ctxPrepare, 120000);
});

test('session-start: короткое напоминание, <300 символов', () => {
  const cwd = tmpProject();
  const r = runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid(), cwd });
  assert.equal(r.code, 0);
  assert.ok(r.out.length < 300, `длина ${r.out.length}`);
  assert.match(r.out, /orc-kit 0.1.2/);
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
