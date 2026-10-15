'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, tmpProject, TEST_TMP } = require('./helpers.cjs');

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-v03-'));
}

test('pid lock: a dead pid starts the watchdog, a live pid skips it', () => {
  const dir = freshTmp();
  const old = process.env.GHORC_TMP;
  process.env.GHORC_TMP = dir;
  try {
    const tmp = require('../scripts/lib/tmp.cjs');
    const f = tmp.pidFile();
    assert.equal(tmp.shouldStartWatchdog(f), true, 'no lock file');
    fs.writeFileSync(f, '999999999');
    assert.equal(tmp.shouldStartWatchdog(f), true, 'dead pid');
    fs.writeFileSync(f, String(process.pid));
    assert.equal(tmp.shouldStartWatchdog(f), false, 'live pid');
    fs.writeFileSync(f, 'garbage');
    assert.equal(tmp.shouldStartWatchdog(f), true, 'garbage lock');
  } finally {
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session-start: autostart writes a pid lock; a live lock is not replaced', () => {
  const dir = freshTmp();
  const root = path.join(dir, 'tr');
  fs.mkdirSync(root);
  const proj = tmpProject();
  const env = { GHORC_TMP: dir, GHORC_WATCHDOG_ROOT: root, GHORC_ROLE: 'lead' };
  try {
    runScript('session-start.cjs', { cwd: proj }, { env });
    const pid = Number(fs.readFileSync(path.join(dir, 'watchdog.pid'), 'utf8'));
    assert.ok(pid > 0);
    runScript('session-start.cjs', { cwd: proj }, { env });
    assert.equal(Number(fs.readFileSync(path.join(dir, 'watchdog.pid'), 'utf8')), pid, 'lock kept');
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session-start: workers and watchdog.autostart=false do not start a watchdog', () => {
  const dir = freshTmp();
  const proj = tmpProject({ watchdog: { autostart: false } });
  try {
    runScript('session-start.cjs', { cwd: proj }, { env: { GHORC_TMP: dir, GHORC_ROLE: 'lead' } });
    assert.equal(fs.existsSync(path.join(dir, 'watchdog.pid')), false);
    const proj2 = tmpProject();
    runScript('session-start.cjs', { cwd: proj2 }, { env: { GHORC_TMP: dir, GHORC_ROLE: 'worker' } });
    assert.equal(fs.existsSync(path.join(dir, 'watchdog.pid')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watchdog --notify-file appends "<ISO time> <text>" lines', () => {
  const dir = freshTmp();
  try {
    const root = path.join(dir, 'tr');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'big.jsonl'), Buffer.alloc(2 * 1024 * 1024));
    const file = path.join(dir, 'a', 'alerts.log');
    const r = runScript('watchdog.cjs', '', { args: ['--once', '--root', root, '--warnMiB', '1', '--notify-file', file] });
    assert.equal(r.code, 0);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 1);
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z over 1 MiB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session-start: CLAUDE.md marker check (missing, no marker, present)', () => {
  const env = { GHORC_TMP: freshTmp(), GHORC_ROLE: 'worker' };
  const proj = tmpProject();
  const input = { cwd: proj };
  assert.match(runScript('session-start.cjs', input, { env }).out, /CLAUDE\.md is missing/);
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# project\n');
  assert.match(runScript('session-start.cjs', input, { env }).out, /no ghorc section/);
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# project\n<!-- ghorc -->\n');
  const out = runScript('session-start.cjs', input, { env }).out;
  assert.doesNotMatch(out, /CLAUDE\.md/);
  fs.rmSync(env.GHORC_TMP, { recursive: true, force: true });
});

test('ctx.cjs prints the last 5 unread alerts once; session-start counts them and stays under 300 chars', () => {
  const dir = freshTmp();
  try {
    const rows = [];
    for (let i = 1; i <= 7; i++) rows.push(`2026-01-01T00:00:0${i}Z alert-${i}`);
    fs.writeFileSync(path.join(dir, 'alerts.log'), rows.join('\n') + '\n');
    const proj = tmpProject();
    const env = { GHORC_TMP: dir, GHORC_ROLE: 'lead', GHORC_WATCHDOG_ROOT: path.join(dir, 'tr') };
    const ss = runScript('session-start.cjs', { cwd: proj }, { env });
    assert.match(ss.out, /7 watchdog alerts pending, run ctx\.cjs/);
    assert.ok(ss.out.length < 300, `length ${ss.out.length}`);
    try {
      process.kill(Number(fs.readFileSync(path.join(dir, 'watchdog.pid'), 'utf8')));
    } catch {
      /* none */
    }
    const first = runScript('ctx.cjs', '', { cwd: proj, env });
    for (const i of [3, 4, 5, 6, 7]) assert.ok(first.out.includes(`alert-${i}`), `alert-${i}`);
    assert.ok(!first.out.includes('alert-2'));
    const second = runScript('ctx.cjs', '', { cwd: proj, env });
    assert.ok(!second.out.includes('alert-7'), 'marked read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup.cjs: --check finds everything missing, --apply all makes it clean, other keys survive', () => {
  const home = freshTmp();
  const proj = tmpProject();
  fs.mkdirSync(path.join(proj, '.git', 'info'), { recursive: true });
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const sf = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(sf, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, env: { KEEP: '1' } }));
    const env = { GHORC_HOME: home, CLAUDE_PROJECT_DIR: '' };
    const parse = (o) => JSON.parse(o.trim().split('\n').pop());
    const before = parse(runScript('setup.cjs', '', { args: ['--check', '--cwd', proj], env }).out);
    assert.equal(before.clean, false);
    assert.ok(before.items.filter((i) => i.id !== 'statusLineStale').every((i) => !i.ok), 'all items missing');
    const ap = runScript('setup.cjs', '', { args: ['--apply', 'all', '--cwd', proj], env });
    assert.equal(ap.code, 0, ap.out + ap.err);
    const after = parse(runScript('setup.cjs', '', { args: ['--check', '--cwd', proj], env }).out);
    assert.equal(after.clean, true);
    const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
    assert.equal(s.env.KEEP, '1');
    assert.ok(s.statusLine);
    assert.ok(fs.readdirSync(path.join(home, '.claude')).some((f) => /^settings\.json\.ghorc-.*\.bak$/.test(f)), 'backup');
    assert.ok(fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8').includes('<!-- ghorc -->'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('statusline writes a raw sample once and does not overwrite it', () => {
  const dir = freshTmp();
  try {
    const env = { GHORC_TMP: dir };
    runScript('statusline.cjs', { model: { display_name: 'A' } }, { env });
    const f = path.join(dir, 'statusline-sample.json');
    assert.ok(fs.existsSync(f));
    const first = fs.readFileSync(f, 'utf8');
    runScript('statusline.cjs', { model: { display_name: 'B' } }, { env });
    assert.equal(fs.readFileSync(f, 'utf8'), first);
    assert.ok(first.includes('"A"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no Cyrillic anywhere in the repository files', () => {
  const root = path.join(__dirname, '..');
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (new RegExp("["+"\\u0400-\\u04FF"+"]").test(fs.readFileSync(p, 'utf8'))) bad.push(p);
    }
  };
  walk(root);
  assert.deepEqual(bad, []);
});

void TEST_TMP;
