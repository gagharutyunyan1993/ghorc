'use strict';
// 0.5.0: opt-in watchdog, optional role, leadNoMedia only for an explicit lead, heavy proposals, lead/status skills, denial log.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runScript, isDeny, tmpProject, sid, TEST_TMP, killTree } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const read = (s, cwd, file, extra = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: s,
  cwd,
  tool_name: 'Read',
  tool_input: { file_path: file },
  ...extra,
});
const bash = (s, cwd, command, extra = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: s,
  cwd,
  tool_name: 'Bash',
  tool_input: { command },
  ...extra,
});

test('#2 default config: SessionStart does not start the watchdog; autostart=true does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-v050-'));
  try {
    const env = { GHORC_TMP: dir, GHORC_NO_AUTOSTART: '', GHORC_WATCHDOG_DRY: '1' };
    const off = runScript('session-start.cjs', { cwd: tmpProject(), session_id: 'a' }, { env });
    assert.doesNotMatch(off.err, /watchdog-args/);
    const on = runScript('session-start.cjs', { cwd: tmpProject({ watchdog: { autostart: true } }), session_id: 'a' }, { env });
    assert.match(on.err, /watchdog-args/);
    const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'defaults.json'), 'utf8'));
    assert.equal(defaults.watchdog.autostart, false);
    const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'ghorc.json'), 'utf8'));
    assert.equal(tpl.watchdog.autostart, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#2 watchdog.cjs --stop kills the project watchdog and removes the pid and heartbeat files', async () => {
  const proj = tmpProject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-v050-stop-'));
  const tr = path.join(dir, 'tr');
  fs.mkdirSync(tr);
  const env = { ...process.env, GHORC_TMP: dir };
  const tmp = require('../scripts/lib/tmp.cjs');
  const old = process.env.GHORC_TMP;
  process.env.GHORC_TMP = dir;
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'watchdog.cjs'), '--interval', '1', '--transcript-dir', tr, '--project-root', proj], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const pf = tmp.pidFile(proj);
    for (let i = 0; i < 50 && !fs.existsSync(pf); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(pf), 'pid file written');
    const r = runScript('watchdog.cjs', '', { args: ['--stop', '--project-root', proj], env: { GHORC_TMP: dir } });
    assert.match(r.out, /stopped/);
    assert.ok(!fs.existsSync(pf), 'pid file removed');
    assert.ok(!fs.existsSync(tmp.heartbeatFile(proj)), 'heartbeat removed');
    for (let i = 0; i < 50 && tmp.isAlive(child.pid); i++) await new Promise((r2) => setTimeout(r2, 100));
    assert.equal(tmp.isAlive(child.pid), false, 'process gone');
    const again = runScript('watchdog.cjs', '', { args: ['--stop', '--project-root', proj], env: { GHORC_TMP: dir } });
    assert.match(again.out, /no watchdog running/);
  } finally {
    killTree(child.pid);
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#3 SessionStart prints role=lead for a plain main session and keeps worker explicit', () => {
  const cwd = tmpProject();
  const plain = runScript('session-start.cjs', { cwd, session_id: 'abc' }).out;
  assert.match(plain, /ghorc [0-9.]+ session=abc role=lead\n/);
  assert.doesNotMatch(plain, /unknown|set GHORC_ROLE/);
  assert.match(plain, /skill ghorc:lead/);
  const worker = runScript('session-start.cjs', { cwd, session_id: 'abc' }, { env: { GHORC_ROLE: 'worker' } }).out;
  assert.match(worker, /role=worker/);
});

test('#4 leadNoMedia applies only when GHORC_ROLE=lead is set explicitly', () => {
  const cwd = tmpProject();
  const png = path.join(cwd, 'x.png');
  fs.writeFileSync(png, 'png');
  assert.equal(isDeny(runScript('read-guard.cjs', read(sid(), cwd, png))), false, 'plain session reads images');
  const pdf = runScript('read-guard.cjs', read(sid(), cwd, path.join(cwd, 'x.pdf'), { tool_input: { file_path: path.join(cwd, 'x.pdf'), pages: '1-2' } }));
  assert.equal(isDeny(pdf), false, 'plain session reads a PDF with pages');
  const lead = runScript('read-guard.cjs', read(sid(), cwd, png), { env: { GHORC_ROLE: 'lead' } });
  assert.equal(isDeny(lead), true, 'explicit lead is denied');
  assert.match(lead.out, /GHORC_ROLE=lead/);
});

test('#5 setup --check proposes heavyCommands from package.json scripts, --apply heavy writes them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  const proj = tmpProject({ checks: { fast: 'npm run lint' } });
  fs.mkdirSync(path.join(proj, 'app'));
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', dev: 'x', 'test:e2e': 'pw' } }));
  fs.writeFileSync(path.join(proj, 'app', 'package.json'), JSON.stringify({ scripts: { build: 'tsc', 'build:win': 'x', e2e: 'y' } }));
  try {
    const env = { GHORC_HOME: home };
    const chk = runScript('setup.cjs', '', { args: ['--check', '--cwd', proj], env }).out;
    assert.match(chk, /proposed heavyCommands/);
    const item = JSON.parse(chk.trim().split('\n').pop()).items.find((i) => i.id === 'heavy');
    assert.deepEqual(item.proposed, [
      '^npm\\s+(?:run\\s+)?test\\b(?!:)',
      '^npm\\s+run\\s+test:e2e\\b',
      '^npm\\s+run\\s+build\\b',
      '^npm\\s+run\\s+e2e\\b',
    ]);
    assert.ok(!item.proposed.some((p) => /lint/.test(p)), 'checks.fast is never proposed');
    const before = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'ghorc.json'), 'utf8'));
    assert.deepEqual(before.heavyCommands, undefined, 'check writes nothing');
    const all = runScript('setup.cjs', '', { args: ['--apply', 'all', '--cwd', proj], env }).out;
    assert.doesNotMatch(all, /heavyCommands:/, 'all does not apply heavy');
    const ap = runScript('setup.cjs', '', { args: ['--apply', 'heavy', '--cwd', proj], env }).out;
    assert.match(ap, /adding 4 regex/);
    const after = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'ghorc.json'), 'utf8'));
    assert.deepEqual(after.heavyCommands, item.proposed);
    assert.equal(after.checks.fast, 'npm run lint');
    const wd = runScript('setup.cjs', '', { args: ['--apply', 'watchdog', '--cwd', proj], env }).out;
    assert.match(wd, /watchdog\.autostart = true/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'ghorc.json'), 'utf8')).watchdog.autostart, true);
    const st = runScript('setup.cjs', '', { args: ['--check', '--cwd', proj], env }).out;
    assert.match(st, /ok\s+watchdog/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('#6 #7 skills: lead, orc alias, status exist with the right names', () => {
  const fm = (n) => fs.readFileSync(path.join(ROOT, 'skills', n, 'SKILL.md'), 'utf8').split(String.fromCharCode(13)).join('');
  assert.match(fm('lead'), /^---\nname: lead\n/);
  const orc = fm('orc');
  assert.match(orc, /^---\nname: orc\n/);
  assert.ok(orc.trim().split('\n').length <= 9);
  assert.match(orc, /ghorc:lead/);
  assert.match(fm('status'), /^---\nname: status\n/);
  assert.match(fm('status'), /ctx\.cjs/);
  assert.match(fm('status'), /setup\.cjs/);
});

test('#8 denials are logged by both guards, shown by setup --status, trimmed after 7 days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-v050-den-'));
  const env = { GHORC_TMP: dir };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  try {
    const cwd = tmpProject({ heavyCommands: ['^npm\\s+test'] });
    const s = 'session1234567';
    assert.equal(isDeny(runScript('heavy-check-guard.cjs', bash(s, cwd, 'npm test', { agent_id: 'a1' }), { env })), true);
    assert.equal(isDeny(runScript('read-guard.cjs', read(s, cwd, path.join(cwd, 'x.png'), { agent_id: 'a1', agent_type: 'general-purpose' }), { env })), true);
    assert.equal(isDeny(runScript('heavy-check-guard.cjs', bash(s, cwd, 'ls', { agent_id: 'a1' }), { env })), false);
    const log = fs.readFileSync(path.join(dir, 'denials.log'), 'utf8').trim().split('\n');
    assert.equal(log.length, 2);
    assert.match(log[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z session1 heavy-check-guard only the lead runs heavy checks/);
    assert.match(log[1], / session1 read-guard media is read by the media role/);
    const st = runScript('setup.cjs', '', { args: ['--check', '--status', '--cwd', cwd], env: { ...env, GHORC_HOME: home } }).out;
    assert.match(st, /status: denials 2 total \(heavy-check-guard=1, read-guard=1\)/);
    assert.match(st, /status: role=lead/);
    assert.match(st, /status: watchdog autostart=off/);
    // cleanup keeps 7 days
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    fs.appendFileSync(path.join(dir, 'denials.log'), `${old} oldsess1 read-guard ancient\n`);
    const tmp = require('../scripts/lib/tmp.cjs');
    const prev = process.env.GHORC_TMP;
    process.env.GHORC_TMP = dir;
    try {
      tmp.cleanup(cwd);
    } finally {
      if (prev === undefined) delete process.env.GHORC_TMP;
      else process.env.GHORC_TMP = prev;
    }
    const kept = fs.readFileSync(path.join(dir, 'denials.log'), 'utf8');
    assert.doesNotMatch(kept, /ancient/);
    assert.equal(kept.trim().split('\n').length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('#9 the short template keeps six keys; defaults and validator still accept every key', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'ghorc.json'), 'utf8'));
  const keys = Object.keys(tpl).filter((k) => !k.startsWith('_comment'));
  assert.deepEqual(keys.sort(), ['checks', 'heavyCommands', 'lead', 'readGuard', 'thresholds', 'watchdog']);
  assert.deepEqual(Object.keys(tpl.readGuard).filter((k) => !k.startsWith('_')), ['maxRepeat']);
  assert.deepEqual(Object.keys(tpl.lead).filter((k) => !k.startsWith('_')), ['model']);
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'defaults.json'), 'utf8'));
  const proj = tmpProject(defaults);
  assert.deepEqual(require('../scripts/lib/validate.cjs').check(proj).problems, []);
  assert.equal(require('../scripts/lib/config.cjs').load(tmpProject(tpl)).readGuard.maxImageBytes, 2097152);
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'configuration.md')));
});

test('#9 agent descriptions are one line and start with the role name', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) {
    const line = fs.readFileSync(path.join(ROOT, 'agents', f), 'utf8').split('\n').find((l) => l.startsWith('description:'));
    assert.ok(line, f);
    const role = f === 'reviewer-critical.md' ? 'critical reviewer' : f.replace('.md', '');
    assert.ok(line.toLowerCase().startsWith(`description: ${role}`), f);
  }
});

test('#1 #18 manifests: marketplace ghorc, version 0.5.1 everywhere, plugin metadata', () => {
  const j = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const mp = j('.claude-plugin/marketplace.json');
  const pl = j('.claude-plugin/plugin.json');
  assert.equal(mp.name, 'ghorc');
  assert.equal(mp.plugins[0].version, '0.5.1');
  assert.equal(pl.version, '0.5.1');
  assert.equal(j('package.json').version, '0.5.1');
  assert.equal(pl.license, 'MIT');
  assert.ok(pl.repository && pl.homepage);
  assert.match(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), /^# Changelog\n\n(## Unreleased\n[\s\S]*?)?## 0\.5\.1/);
  assert.ok(TEST_TMP);
});
