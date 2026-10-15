'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, tmpProject, TEST_TMP, stopWatchdogs } = require('./helpers.cjs');
const config = require('../scripts/lib/config.cjs');

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-v03-'));
}

test('watchdog liveness: no pid, dead pid, version mismatch, stale heartbeat, alive', () => {
  const dir = freshTmp();
  const old = process.env.GHORC_TMP;
  process.env.GHORC_TMP = dir;
  try {
    const tmp = require('../scripts/lib/tmp.cjs');
    const root = path.join(dir, 'proj');
    const put = (info) => tmp.atomicWrite(tmp.pidFile(root), typeof info === 'string' ? info : JSON.stringify(info));
    const now = Date.now();
    assert.equal(tmp.watchdogStatus(root, '1.0.0', 30, now).alive, false, 'no pid file');
    put({ pid: 999999999, version: '1.0.0', root, startedAt: now });
    assert.equal(tmp.watchdogStatus(root, '1.0.0', 30, now).reason, 'dead pid');
    put({ pid: process.pid, version: '0.9.0', root, startedAt: now });
    assert.equal(tmp.watchdogStatus(root, '1.0.0', 30, now).reason, 'version mismatch');
    put({ pid: process.pid, version: '1.0.0', root, startedAt: now - 10 * 60000 });
    assert.equal(tmp.watchdogStatus(root, '1.0.0', 30, now).reason, 'stale heartbeat');
    fs.writeFileSync(tmp.heartbeatFile(root), String(now));
    assert.equal(tmp.watchdogStatus(root, '1.0.0', 30, now).alive, true, 'fresh heartbeat');
    put(String(process.pid));
    assert.equal(tmp.readPidInfo(tmp.pidFile(root)).pid, process.pid, 'a bare number is tolerated');
    put('garbage');
    assert.equal(tmp.watchdogStatus(root, '1.0.0', 30, now).alive, false, 'garbage');
    assert.notEqual(tmp.pidFile(path.join(dir, 'a')), tmp.pidFile(path.join(dir, 'b')), 'one file per root');
  } finally {
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session-start: autostart writes a JSON pid file per root; a live fresh watchdog is not replaced', () => {
  const dir = freshTmp();
  const root = path.join(dir, 'tr');
  fs.mkdirSync(root);
  const proj = tmpProject();
  const env = { GHORC_TMP: dir, GHORC_WATCHDOG_ROOT: root, GHORC_ROLE: 'lead', GHORC_NO_AUTOSTART: '' };
  const tmp = require('../scripts/lib/tmp.cjs');
  const old = process.env.GHORC_TMP;
  process.env.GHORC_TMP = dir;
  try {
    const pf = tmp.pidFile(config.projectRoot(proj));
    runScript('session-start.cjs', { cwd: proj }, { env });
    const info = JSON.parse(fs.readFileSync(pf, 'utf8'));
    assert.ok(info.pid > 0);
    assert.ok(info.version);
    runScript('session-start.cjs', { cwd: proj }, { env });
    assert.equal(JSON.parse(fs.readFileSync(pf, 'utf8')).pid, info.pid, 'kept');
  } finally {
    stopWatchdogs(dir);
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session-start: workers and watchdog.autostart=false do not start a watchdog', () => {
  const dir = freshTmp();
  const proj = tmpProject({ watchdog: { autostart: false } });
  try {
    runScript('session-start.cjs', { cwd: proj }, { env: { GHORC_TMP: dir, GHORC_ROLE: 'lead' } });
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.pid')), []);
    const proj2 = tmpProject();
    runScript('session-start.cjs', { cwd: proj2 }, { env: { GHORC_TMP: dir, GHORC_ROLE: 'worker' } });
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.pid')), []);
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

test('ctx.cjs shows unread alerts of ONE session, oldest first, marks only those; session-start counts them', () => {
  const dir = freshTmp();
  const tmp = require('../scripts/lib/tmp.cjs');
  const old = process.env.GHORC_TMP;
  process.env.GHORC_TMP = dir;
  try {
    const proj = tmpProject();
    const root = config.projectRoot(proj);
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push(`2026-01-01T00:00:${String(i).padStart(2, '0')}Z alert-${i}`);
    fs.writeFileSync(tmp.alertsFile(root), rows.join('\n') + '\n');
    const env = { GHORC_TMP: dir, GHORC_ROLE: 'lead', GHORC_WATCHDOG_ROOT: path.join(dir, 'tr') };
    const ss = runScript('session-start.cjs', { cwd: proj, session_id: 'sess-aaaa1111' }, { env });
    assert.match(ss.out, /^12 watchdog alerts pending, run ctx\n/);
    assert.match(ss.out, /alert-12/);
    assert.ok(ss.out.length <= 300, `length ${ss.out.length}`);
    stopWatchdogs(dir);
    const first = runScript('ctx.cjs', '', { cwd: proj, env, args: ['--session', 'sess-aaaa1111'] });
    for (let i = 1; i <= 10; i++) assert.ok(first.out.includes(`alert-${i}\n`), `alert-${i}`);
    assert.ok(!first.out.includes('alert-11'));
    assert.ok(first.out.indexOf('alert-1\n') < first.out.indexOf('alert-10'), 'oldest first');
    const second = runScript('ctx.cjs', '', { cwd: proj, env, args: ['--session', 'sess-aaaa1111'] });
    assert.ok(!second.out.includes('alert-10\n'), 'marked read');
    assert.ok(second.out.includes('alert-11') && second.out.includes('alert-12'));
    // another session has its own offset
    const other = runScript('ctx.cjs', '', { cwd: proj, env, args: ['--session', 'sess-bbbb2222'] });
    assert.ok(other.out.includes('alert-1\n'), 'independent offset');
  } finally {
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
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
    assert.ok(before.items.filter((i) => i.id !== 'statusLineStale' && i.id !== 'heavy').every((i) => !i.ok), 'all items missing');
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
