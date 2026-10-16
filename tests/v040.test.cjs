'use strict';
// 0.4.0: hardened guards, session identity, per-project watchdog.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { runScript, isDeny, tmpProject, sid, TEST_TMP } = require('./helpers.cjs');

const tmpLib = require('../scripts/lib/tmp.cjs');
const watch = require('../scripts/lib/watch.cjs');
const cmd = require('../scripts/lib/cmd.cjs');
const config = require('../scripts/lib/config.cjs');

const read = (s, cwd, file, extra = {}, ti = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: s,
  cwd,
  agent_id: extra.agent_id === undefined ? 'ag1' : extra.agent_id,
  agent_type: extra.agent_type,
  tool_name: extra.tool_name || 'Read',
  tool_input: { file_path: file, ...ti },
});
const bash = (cwd, command, agent, tool = 'Bash') => ({
  hook_event_name: 'PreToolUse',
  session_id: sid(),
  cwd,
  agent_id: agent,
  tool_name: tool,
  tool_input: { command },
});
const reason = (r) => JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
const rg = (input, env) => runScript('read-guard.cjs', input, { env });
const hg = (input, env) => runScript('heavy-check-guard.cjs', input, { env });

// ---- read guard -------------------------------------------------------------------------------------------------

test('A1: round-robin over 8 paths, 4 passes: the 4th read of every path is denied', () => {
  const s = sid();
  const cwd = tmpProject();
  const names = 'abcdefgh'.split('').map((c) => `${c}.txt`);
  for (let pass = 1; pass <= 4; pass++) {
    for (const n of names) {
      const denied = isDeny(rg(read(s, cwd, n, {}, { offset: pass * 10, limit: 5 })));
      assert.equal(denied, pass === 4, `${n} pass ${pass}`);
    }
  }
});

test('A2: Edit of path A resets only A', () => {
  const s = sid();
  const cwd = tmpProject();
  for (let i = 0; i < 3; i++) for (const n of ['a.txt', 'b.txt']) rg(read(s, cwd, n));
  rg({ hook_event_name: 'PostToolUse', session_id: s, cwd, agent_id: 'ag1', tool_name: 'Edit', tool_input: { file_path: 'a.txt' } });
  assert.equal(isDeny(rg(read(s, cwd, 'a.txt'))), false, 'a reset');
  assert.equal(isDeny(rg(read(s, cwd, 'b.txt'))), true, 'b not reset');
});

test('A3: PDF page budget is summed across files (and across .PDF case)', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { pdfPageBudget: 10 } });
  const m = { agent_type: 'ghorc:media' };
  assert.equal(isDeny(rg(read(s, cwd, 'x1.PDF', m, { pages: '1-5' }))), false);
  assert.equal(isDeny(rg(read(s, cwd, 'x2.pdf', m, { pages: '1-5' }))), false);
  const r = rg(read(s, cwd, 'x3.pdf', m, { pages: '1-2' }));
  assert.equal(isDeny(r), true);
  assert.match(reason(r), /page budget/);
});

test('A8: media is read by media roles only (mediaRoles is configurable)', () => {
  const s = sid();
  const cwd = tmpProject();
  const r = rg(read(s, cwd, 'p.png', { agent_type: 'general-purpose' }));
  assert.equal(isDeny(r), true);
  assert.match(reason(r), /media role/);
  assert.equal(isDeny(rg(read(s, cwd, 'p.png', { agent_type: 'media' }))), false, 'built-in media role');
  const cwd2 = tmpProject({ readGuard: { mediaRoles: ['custom'] } });
  assert.equal(isDeny(rg(read(s, cwd2, 'p.png', { agent_type: 'custom' }))), false);
  assert.equal(isDeny(rg(read(s, cwd2, 'p.png', { agent_type: 'ghorc:media' }))), true);
});

test('A24: a stat error on an image still counts as a read', () => {
  const s = sid();
  const cwd = tmpProject();
  const m = { agent_type: 'ghorc:media' };
  for (let i = 1; i <= 3; i++) assert.equal(isDeny(rg(read(s, cwd, 'missing.png', m))), false, `read ${i}`);
  assert.equal(isDeny(rg(read(s, cwd, 'missing.png', m))), true);
});

test('A5: image byte budget is summed per agent', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { mediaByteBudget: 1500, maxImageBytes: 1000 } });
  const files = [1, 2].map((i) => path.join(os.tmpdir(), `ghorc-img-${process.pid}-${i}.png`));
  files.forEach((f) => fs.writeFileSync(f, Buffer.alloc(900)));
  try {
    const m = { agent_type: 'ghorc:media' };
    assert.equal(isDeny(rg(read(s, cwd, files[0], m))), false);
    const r = rg(read(s, cwd, files[1], m));
    assert.equal(isDeny(r), true);
    assert.match(reason(r), /byte budget/);
  } finally {
    files.forEach((f) => fs.rmSync(f, { force: true }));
  }
});

test('A9: MCP screenshot and snapshot calls are budgeted (maxScreenshots)', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { maxScreenshots: 2 } });
  const shot = (tool) => rg({ hook_event_name: 'PreToolUse', session_id: s, cwd, agent_id: 'ag1', tool_name: tool, tool_input: {} });
  assert.equal(isDeny(shot('mcp__chrome-devtools__take_screenshot')), false);
  assert.equal(isDeny(shot('mcp__chrome-devtools__take_snapshot')), false);
  const r = shot('mcp__x__read_page');
  assert.equal(isDeny(r), true);
  assert.match(reason(r), /more than 2/);
  assert.equal(isDeny(shot('mcp__x__click')), false, 'other MCP tools are not counted');
});

test('A13: path keys ignore case on Windows', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const s = sid();
  const cwd = tmpProject();
  const names = ['A.txt', 'a.TXT', 'a.txt'];
  for (const n of names) assert.equal(isDeny(rg(read(s, cwd, n))), false);
  assert.equal(isDeny(rg(read(s, cwd, 'A.TXT'))), true);
});

test('hooks.json: Read matcher covers MCP screenshots; PostToolUse covers Edit|Write|NotebookEdit and the Agent ledger', () => {
  const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const pre = h.PreToolUse.map((e) => e.matcher);
  assert.ok(pre.some((m) => new RegExp(`^(?:${m})$`).test('mcp__chrome-devtools__take_screenshot')));
  assert.ok(pre.some((m) => new RegExp(`^(?:${m})$`).test('Read')));
  const post = h.PostToolUse.map((e) => e.matcher).join('|');
  assert.equal(post, 'Agent|Edit|Write|NotebookEdit');
});

// ---- heavy guard and config validity ------------------------------------------------------------------------------

test('I4: invalid JSON in the project config: heavy commands are denied for everyone with the reason', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude'));
  const f = path.join(cwd, '.claude', 'ghorc.json');
  fs.writeFileSync(f, '{"heavyCommands": [');
  const lead = hg(bash(cwd, 'npm test'));
  assert.equal(isDeny(lead), true, 'the lead too');
  assert.match(reason(lead), /config invalid/);
  assert.equal(isDeny(hg(bash(cwd, 'git status'))), false, 'ordinary commands pass');
  assert.equal(isDeny(hg(bash(cwd, 'npm test', 'ag1'))), true);
  // fixed: the validity cache is keyed by mtime and size, so the fix is seen at once
  fs.writeFileSync(f, JSON.stringify({ heavyCommands: ['^make full'] }) + '\n');
  assert.equal(isDeny(hg(bash(cwd, 'npm test'))), false);
  assert.equal(isDeny(hg(bash(cwd, 'make full', 'ag1'))), true);
});

test('I4: a bad regex or a wrong type is a fatal config error with a reason; an unknown key is not', () => {
  const bad = tmpProject({ heavyCommands: ['(['] });
  const r = hg(bash(bad, 'npm test'));
  assert.equal(isDeny(r), true);
  assert.match(reason(r), /heavyCommands/);
  const typed = tmpProject({ heavyCommands: 'npm test' });
  assert.equal(isDeny(hg(bash(typed, 'npm test'))), true);
  const typo = tmpProject({ heavyCommand: ['x'] });
  assert.equal(isDeny(hg(bash(typo, 'npm test'))), false, 'unknown key is only reported by check-config');
  assert.equal(config.load(typo).invalid, undefined);
});

test('I4: read-guard keeps working with defaults while the config is invalid', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'ghorc.json'), '{oops');
  const s = sid();
  for (let i = 1; i <= 3; i++) assert.equal(isDeny(rg(read(s, cwd, 'a.txt'))), false);
  assert.equal(isDeny(rg(read(s, cwd, 'a.txt'))), true);
});

test('G1: GHORC_ROLE=worker is a subagent for the heavy guard', () => {
  const cwd = tmpProject({ heavyCommands: ['^make full'] });
  const w = { GHORC_ROLE: 'worker' };
  assert.equal(isDeny(hg(bash(cwd, 'make full'), w)), true);
  assert.equal(isDeny(hg(bash(cwd, 'make full'), { GHORC_ROLE: 'lead' })), false);
  assert.equal(isDeny(hg(bash(cwd, 'make full'))), false, 'no role: the lead');
});

test('I5: command matching is per segment, anchored, quote-aware', () => {
  const cwd = tmpProject({ heavyCommands: ['^npm\\s+test\\b'] });
  const sub = (c) => isDeny(hg(bash(cwd, c, 'ag1')));
  assert.equal(sub('git commit -m "run npm test"'), false);
  assert.equal(sub('echo npm test'), false);
  assert.equal(sub('cd app && npm test'), true);
  assert.equal(sub('FOO=1 npm test'), true);
  assert.equal(sub('cd app; npm test -- x'), true);
  assert.equal(sub('ls | npm test'), true);
  assert.equal(cmd.matches('npm run test', [/^test\b/]), true, 'npm run prefix is stripped');
  assert.equal(cmd.matches('npx vitest', [/^vitest\b/]), true);
});

test('I5: built-in denies for subagents only: claude -p, herdr agent start, herdr agent prompt', () => {
  const cwd = tmpProject({ heavyCommands: ['^never-matches-anything$'] });
  for (const c of ['claude -p "hi"', 'claude --model opus -p x', 'herdr agent start x', 'herdr agent prompt x y']) {
    assert.equal(isDeny(hg(bash(cwd, c, 'ag1'))), true, c);
    assert.equal(isDeny(hg(bash(cwd, c))), false, `${c} (lead)`);
  }
  assert.equal(isDeny(hg(bash(cwd, 'claude --version', 'ag1'))), false);
  assert.equal(isDeny(hg(bash(cwd, 'herdr agent list', 'ag1'))), false);
});

test('A11: with CLAUDE_PROJECT_DIR set, config lookup spawns no git', () => {
  const proj = tmpProject({ heavyCommands: ['x'] });
  const real = cp.spawnSync;
  let calls = 0;
  cp.spawnSync = (...a) => {
    calls++;
    return real(...a);
  };
  const old = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = proj;
  try {
    const c = config.load(path.join(proj, 'sub'));
    assert.deepEqual(c.heavyCommands, ['x']);
    assert.equal(calls, 0);
  } finally {
    cp.spawnSync = real;
    if (old === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = old;
  }
});

test('setup --check: heavy item warns on empty heavyCommands and on no match with checks.full; never blocks clean', () => {
  const parse = (o) => JSON.parse(o.trim().split('\n').pop());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  try {
    const env = { GHORC_HOME: home };
    const chk = (cfg) => {
      const proj = tmpProject(cfg);
      return parse(runScript('setup.cjs', '', { args: ['--check', '--cwd', proj], env }).out).items.find((i) => i.id === 'heavy');
    };
    const empty = chk({ checks: { full: 'npm test' }, heavyCommands: [] });
    assert.equal(empty.ok, false);
    assert.equal(empty.warn, true);
    const nomatch = chk({ checks: { full: 'npm test' }, heavyCommands: ['^make full'] });
    assert.equal(nomatch.ok, false);
    const good = chk({ checks: { full: 'npm test' }, heavyCommands: ['^npm\\s+test'] });
    assert.equal(good.ok, true);
    const text = runScript('setup.cjs', '', { args: ['--check', '--cwd', tmpProject({ checks: { full: 'npm test' }, heavyCommands: [] })], env }).out;
    assert.match(text, /WARN\s+heavy/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- tmp lib ------------------------------------------------------------------------------------------------------

test('A10: the tmp dir is per user; GHORC_TMP overrides', () => {
  const old = process.env.GHORC_TMP;
  try {
    delete process.env.GHORC_TMP;
    const d = tmpLib.tmpDir();
    assert.equal(path.dirname(d), os.tmpdir());
    assert.match(path.basename(d), /^ghorc-[A-Za-z0-9_.-]+$/);
    process.env.GHORC_TMP = TEST_TMP;
    assert.equal(tmpLib.tmpDir(), TEST_TMP);
  } finally {
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
  }
});

test('A16: atomicWrite leaves no .tmp file and replaces the content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-atomic-'));
  try {
    const f = path.join(dir, 'x.json');
    tmpLib.atomicWrite(f, '1');
    tmpLib.atomicWrite(f, '22');
    assert.equal(fs.readFileSync(f, 'utf8'), '22');
    assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A21: GHORC_HOOK_DUMP appends the raw hook input only when set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-dump-'));
  try {
    const f = path.join(dir, 'dump.jsonl');
    const input = read(sid(), dir, 'a.txt');
    rg(input);
    assert.equal(fs.existsSync(f), false);
    rg(input, { GHORC_HOOK_DUMP: f });
    rg(input, { GHORC_HOOK_DUMP: f });
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).tool_name, 'Read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- ctx, status line, session start ------------------------------------------------------------------------------

test('E3: ctx.cjs requires --session (id, 8-char prefix, GHORC_SESSION) or --all', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude'));
  const write = (id, pct) => fs.writeFileSync(path.join(cwd, '.claude', `ctx-${id}.json`), JSON.stringify({ session_id: id, used_percentage: pct }));
  write('aaaaaaaa-1111', 11);
  write('bbbbbbbb-2222', 22);
  const none = runScript('ctx.cjs', '', { args: ['--cwd', cwd] });
  assert.equal(none.code, 2);
  assert.match(none.out, /usage: ctx\.cjs --session/);
  const full = runScript('ctx.cjs', '', { args: ['--cwd', cwd, '--session', 'bbbbbbbb-2222'] });
  assert.equal(full.code, 0);
  assert.match(full.out, /22%/);
  assert.doesNotMatch(full.out, /11%/);
  const prefix = runScript('ctx.cjs', '', { args: ['--cwd', cwd, '--session', 'aaaaaaaa'] });
  assert.match(prefix.out, /11%/);
  const env = runScript('ctx.cjs', '', { args: ['--cwd', cwd], env: { GHORC_SESSION: 'bbbbbbbb' } });
  assert.match(env.out, /22%/);
  const all = runScript('ctx.cjs', '', { args: ['--cwd', cwd, '--all'] });
  assert.match(all.out, /11%/);
  assert.match(all.out, /22%/);
  const miss = runScript('ctx.cjs', '', { args: ['--cwd', cwd, '--session', 'zzzz'] });
  assert.match(miss.out, /no ctx file for session zzzz/);
});

test('E4: --all lists alerts but marks nothing read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-all-'));
  const old = process.env.GHORC_TMP;
  process.env.GHORC_TMP = dir;
  try {
    const proj = tmpProject();
    const root = config.projectRoot(proj);
    fs.writeFileSync(tmpLib.alertsFile(root), '2026-01-01T00:00:01Z one\n');
    const env = { GHORC_TMP: dir };
    assert.match(runScript('ctx.cjs', '', { args: ['--cwd', proj, '--all'], env }).out, / one/);
    assert.match(runScript('ctx.cjs', '', { args: ['--cwd', proj, '--all'], env }).out, / one/, 'still unread');
    assert.match(runScript('ctx.cjs', '', { args: ['--cwd', proj, '--session', 's1'], env }).out, / one/);
    assert.doesNotMatch(runScript('ctx.cjs', '', { args: ['--cwd', proj, '--session', 's1'], env }).out, / one/);
  } finally {
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('E6: the status line shows #<8 chars of the session id>; 7d reset >= 48 h is shown in days', () => {
  const PLAIN = { GHORC_STATUSLINE_PLAIN: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '', GHORC_GIT_TIMEOUT_MS: '15000' };
  const cwd = tmpProject();
  const r = runScript('statusline.cjs', { session_id: 'abcdef12-3456-7890', cwd, model: { display_name: 'M' }, context_window: { used_percentage: 1 } }, { env: PLAIN });
  assert.match(r.out, /#abcdef12(?![0-9a-z])/);
  const none = runScript('statusline.cjs', { cwd, model: { display_name: 'M' }, context_window: { used_percentage: 1 } }, { env: PLAIN });
  assert.doesNotMatch(none.out, /#/);
});

test('E8: session-start prints session id and role, alerts first, role lead when unset', () => {
  const proj = tmpProject();
  const lead = runScript('session-start.cjs', { cwd: proj, session_id: 'sess-1234abcd' }, { env: { GHORC_ROLE: 'worker' } }).out;
  assert.match(lead, /ghorc \S+ session=sess-1234abcd role=worker/);
  const plain = runScript('session-start.cjs', { cwd: proj, session_id: 'sess-1234abcd' }, { env: { GHORC_ROLE: '' } }).out;
  assert.match(plain, /role=lead\n/);
});

test('F1: session-start puts alerts first and cuts at 299 chars with a +more marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-ss-'));
  const old = process.env.GHORC_TMP;
  process.env.GHORC_TMP = dir;
  try {
    const proj = tmpProject();
    const root = config.projectRoot(proj);
    const rows = [1, 2, 3].map((i) => `2026-01-01T00:00:0${i}Z ${'x'.repeat(120)}${i}`);
    fs.writeFileSync(tmpLib.alertsFile(root), rows.join('\n') + '\n');
    const out = runScript('session-start.cjs', { cwd: proj, session_id: 's9' }, { env: { GHORC_TMP: dir, GHORC_ROLE: 'worker' } }).out;
    assert.match(out, /^3 watchdog alerts pending, run ctx\n/);
    assert.ok(out.trimEnd().length <= 299, `length ${out.length}`);
    assert.match(out, /\+more: run ctx\n$/);
    assert.ok(!out.includes('x'.repeat(100)), 'alert lines are cut at 80 chars');
  } finally {
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: session-start removes ctx files and tmp state older than 7 days, keeps fresh ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-clean-'));
  try {
    const proj = tmpProject();
    fs.mkdirSync(path.join(proj, '.claude'));
    const old = new Date(Date.now() - 10 * 86400000);
    const mk = (p) => {
      fs.writeFileSync(p, '{}');
      fs.utimesSync(p, old, old);
    };
    mk(path.join(proj, '.claude', 'ctx-old.json'));
    fs.writeFileSync(path.join(proj, '.claude', 'ctx-new.json'), '{}');
    mk(path.join(dir, 'x.offset'));
    mk(path.join(dir, 'y.tmp'));
    fs.writeFileSync(path.join(dir, 'fresh.offset'), '1');
    const sd = path.join(dir, 'old-session');
    fs.mkdirSync(sd);
    fs.writeFileSync(path.join(sd, 'read-main.json'), '{}');
    fs.utimesSync(path.join(sd, 'read-main.json'), old, old);
    fs.utimesSync(sd, old, old);
    runScript('session-start.cjs', { cwd: proj, session_id: 's1' }, { env: { GHORC_TMP: dir, GHORC_ROLE: 'worker' } });
    assert.ok(!fs.existsSync(path.join(proj, '.claude', 'ctx-old.json')));
    assert.ok(fs.existsSync(path.join(proj, '.claude', 'ctx-new.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'x.offset')));
    assert.ok(!fs.existsSync(path.join(dir, 'y.tmp')));
    assert.ok(fs.existsSync(path.join(dir, 'fresh.offset')));
    assert.ok(!fs.existsSync(sd));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- watchdog -----------------------------------------------------------------------------------------------------

test('F3: streak decays by one on a slow poll instead of resetting; polls needed round up', () => {
  assert.equal(watch.nextStreak(0, true), 1);
  assert.equal(watch.nextStreak(3, false), 2);
  assert.equal(watch.nextStreak(0, false), 0);
  assert.equal(watch.pollsNeeded(120000, 30), 4);
  assert.equal(watch.pollsNeeded(100000, 30), 4);
  assert.equal(watch.pollsNeeded(1000, 30), 1);
});

test('F4: a file already above stopMiB on first sight raises the stop alarm', () => {
  assert.equal(watch.stopAlarm(true, 300, 0, 250), true);
  assert.equal(watch.stopAlarm(false, 300, 0, 250), false);
  assert.equal(watch.stopAlarm(false, 300, 5, 250), true);
  assert.equal(watch.stopAlarm(true, 100, 0, 250), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-stop-'));
  try {
    fs.writeFileSync(path.join(root, 'big.jsonl'), Buffer.alloc(2 * 1024 * 1024));
    const r = runScript('watchdog.cjs', '', { args: ['--once', '--transcript-dir', root, '--project-root', root, '--warnMiB', '100', '--stopMiB', '1'] });
    assert.match(r.out, /ALARM, over 1 MiB \(seen for the first time\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F6: the watchdog scans only its --transcript-dir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-scope-'));
  try {
    const mine = path.join(base, 'mine');
    const other = path.join(base, 'other');
    fs.mkdirSync(mine);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(mine, 'small.jsonl'), 'x');
    fs.writeFileSync(path.join(other, 'big.jsonl'), Buffer.alloc(2 * 1024 * 1024));
    const r = runScript('watchdog.cjs', '', { args: ['--once', '--transcript-dir', mine, '--project-root', base, '--warnMiB', '1'] });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.out, /big\.jsonl/);
    const r2 = runScript('watchdog.cjs', '', { args: ['--once', '--transcript-dir', other, '--project-root', base, '--warnMiB', '1'] });
    assert.match(r2.out, /big\.jsonl/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('F7: the watchdog writes a JSON pid file and a heartbeat per project, and removes the pid on exit', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-hb-'));
  try {
    const dir = path.join(base, 't');
    fs.mkdirSync(dir);
    const pidf = path.join(base, 'w.pid');
    const beat = path.join(base, 'w.beat');
    const child = cp.spawn(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'watchdog.cjs'), '--transcript-dir', dir, '--project-root', base, '--version', '9.9.9', '--intervalSec', '1', '--pid-file', pidf, '--heartbeat-file', beat],
      { stdio: 'ignore' },
    );
    const until = Date.now() + 8000;
    while (Date.now() < until && !(fs.existsSync(pidf) && fs.existsSync(beat))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    try {
      const info = JSON.parse(fs.readFileSync(pidf, 'utf8'));
      assert.equal(info.pid, child.pid);
      assert.equal(info.version, '9.9.9');
      assert.equal(info.root, base);
      assert.ok(fs.existsSync(beat));
    } finally {
      require('./helpers.cjs').killTree(child.pid);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('F8: splitCommand groups quoted words, keeps Windows paths intact, no shell', () => {
  assert.deepEqual(watch.splitCommand('a b'), ['a', 'b']);
  assert.deepEqual(watch.splitCommand('"C:\\Program Files\\node.exe" "C:\\x y\\s.cjs" fixed'), ['C:\\Program Files\\node.exe', 'C:\\x y\\s.cjs', 'fixed']);
  assert.deepEqual(watch.splitCommand('cmd /c "a b.cmd"'), ['cmd', '/c', 'a b.cmd']);
  assert.deepEqual(watch.splitCommand(''), []);
});

test('F9: alert offsets are per session and per project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-off-'));
  const old = process.env.GHORC_TMP;
  process.env.GHORC_TMP = dir;
  try {
    const rootA = path.join(dir, 'A');
    const rootB = path.join(dir, 'B');
    assert.notEqual(tmpLib.alertsFile(rootA), tmpLib.alertsFile(rootB));
    fs.writeFileSync(tmpLib.alertsFile(rootA), 'l1\nl2\nl3\n');
    const u = tmpLib.unreadAlerts(rootA, 's1');
    assert.deepEqual(u.lines, ['l1', 'l2', 'l3']);
    tmpLib.markAlertsRead(rootA, 's1', u.ends[1]);
    assert.deepEqual(tmpLib.unreadAlerts(rootA, 's1').lines, ['l3']);
    assert.deepEqual(tmpLib.unreadAlerts(rootA, 's2').lines, ['l1', 'l2', 'l3']);
    assert.deepEqual(tmpLib.unreadAlerts(rootB, 's1').lines, []);
  } finally {
    if (old === undefined) delete process.env.GHORC_TMP;
    else process.env.GHORC_TMP = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- setup --------------------------------------------------------------------------------------------------------

test('E1: setup --apply pct is global by default and project-local with --project', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  try {
    const proj = tmpProject();
    fs.mkdirSync(path.join(proj, '.git', 'info'), { recursive: true });
    const env = { GHORC_HOME: home };
    const sf = path.join(home, '.claude', 'settings.json');
    const lf = path.join(proj, '.claude', 'settings.local.json');
    const r1 = runScript('setup.cjs', '', { args: ['--apply', 'pct', '--project', '--cwd', proj], env });
    assert.equal(r1.code, 0, r1.out + r1.err);
    assert.ok(JSON.parse(fs.readFileSync(lf, 'utf8')).env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
    assert.ok(!fs.existsSync(sf), 'global settings untouched');
    const chk = runScript('setup.cjs', '', { args: ['--check', '--project', '--cwd', proj], env }).out;
    assert.match(chk, /pct \[project\]/);
    const r2 = runScript('setup.cjs', '', { args: ['--apply', 'pct', '--cwd', proj], env });
    assert.equal(r2.code, 0, r2.out + r2.err);
    assert.ok(JSON.parse(fs.readFileSync(sf, 'utf8')).env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
    assert.match(runScript('setup.cjs', '', { args: ['--check', '--cwd', proj], env }).out, /pct \[global\]/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('E2: setup exclude: the path comes from git, also in a worktree; two lines are written once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-wt-')));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    const git = (...a) => cp.spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    if (git('init', '-q').status !== 0) return; // git not available
    git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'i');
    const wt = path.join(base, 'wt');
    if (git('worktree', 'add', '-q', wt).status !== 0) return;
    const env = { GHORC_HOME: home, CLAUDE_PROJECT_DIR: '' };
    for (let i = 0; i < 2; i++) {
      const r = runScript('setup.cjs', '', { args: ['--apply', 'exclude', '--cwd', wt], env });
      assert.equal(r.code, 0, r.out + r.err);
    }
    const ex = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(ex.split('\n').filter((l) => l === '.claude/ctx-*.json').length, 1);
    assert.equal(ex.split('\n').filter((l) => l === '.claude/ghorc-out/').length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    try {
      cp.spawnSync('git', ['worktree', 'prune'], { cwd: path.join(base, 'repo') });
    } catch {
      /* ignore */
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('README lines are at most 120 characters', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').split('\n');
  const long = lines.map((l, i) => [i + 1, l.length]).filter(([, n]) => n > 120);
  assert.deepEqual(long, []);
});
