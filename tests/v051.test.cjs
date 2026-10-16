'use strict';
// 0.5.1: PowerShell quoting, heredoc bodies, git budget, setup --project with a broken global file, validity cache key,
// heavy proposals for test:full, status line backup and restore.
const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScript, isDeny, tmpProject, TEST_TMP } = require('./helpers.cjs');
const cmd = require('../scripts/lib/cmd.cjs');
const root = require('../scripts/lib/root.cjs');
const config = require('../scripts/lib/config.cjs');

const ROOT = path.join(__dirname, '..');
const hit = (command, patterns, opts) => cmd.matches(command, cmd.compile(patterns), opts);
const NPM_TEST = ['^npm\\s+test\\b'];
const guard = (cwd, command, tool = 'Bash', extra = {}) =>
  runScript('heavy-check-guard.cjs', { hook_event_name: 'PreToolUse', session_id: 's', cwd, tool_name: tool, tool_input: { command }, agent_id: 'ag1', ...extra });
const setupOut = (args, env) => runScript('setup.cjs', '', { args, env }).out;
const lastJson = (out) => JSON.parse(out.trim().split('\n').pop());

test('R9: a trailing backslash before a closing quote does not hide the next command in PowerShell', () => {
  assert.equal(hit('cd "D:\\a\\"; npm test; echo "x"', NPM_TEST, { powershell: true }), true);
  assert.equal(hit('powershell -Command "cd \\"D:\\a\\\\"; npm test"', NPM_TEST), true);
  assert.equal(hit('pwsh -NoProfile -Command "cd \'D:\\a\\\'; npm test"', NPM_TEST), true);
  // quoted text is still ignored when it really is quoted
  assert.equal(hit('echo "npm test"', NPM_TEST, { powershell: true }), false);
  assert.equal(hit('echo "a `" npm test"', NPM_TEST, { powershell: true }), false, 'backtick escapes the quote');
  const cwd = tmpProject({ heavyCommands: NPM_TEST });
  assert.equal(isDeny(guard(cwd, 'cd "D:\\a\\"; npm test; echo "x"', 'PowerShell')), true);
  assert.equal(isDeny(guard(cwd, 'echo "D:\\a\\"; echo ok', 'PowerShell')), false);
});

test('R10: heredoc bodies are not commands, the command lines around them are', () => {
  const doc = "cat > notes.md <<'EOF'\n# Checks\nrun npm test before merging\nnpm test\nEOF";
  assert.equal(hit(doc, NPM_TEST), false);
  assert.equal(hit('cat <<EOF\nbody\nEOF\nnpm test', NPM_TEST), true);
  assert.equal(hit('cat <<EOF && npm test\nbody\nEOF', NPM_TEST), true);
  assert.equal(hit('cat <<EOF; npm test\nbody\nEOF', NPM_TEST), true);
  assert.equal(hit('cat <<-EOF\n\tnpm test\n\tEOF', NPM_TEST), false, '<<- allows tab-indented terminator');
  assert.equal(hit('cat <<"EOF"\r\nnpm test\r\nEOF\r\n', NPM_TEST), false, 'CRLF terminator');
  assert.equal(hit('cat <<A <<B\nnpm test\nA\nnpm test\nB', NPM_TEST), false, 'two heredocs on one line');
  assert.equal(hit('cat <<EOF; npm test\nbody', NPM_TEST), true, 'unterminated: nothing is hidden');
  assert.equal(hit('echo "<<EOF"\nnpm test\nEOF', NPM_TEST), true, '<< inside quotes opens nothing');
  assert.equal(hit('cat <<< "x"\nnpm test', NPM_TEST), true, 'here-string is not a heredoc');
  const cwd = tmpProject({ heavyCommands: NPM_TEST });
  assert.equal(isDeny(guard(cwd, doc)), false, 'a subagent may write a doc that mentions npm test');
  assert.equal(isDeny(guard(cwd, 'cat <<EOF\nx\nEOF\nnpm test')), true);
});

test('R12: after the first git timeout no further git is spawned; a hanging git costs one timeout', () => {
  const real = cp.spawnSync;
  let calls = 0;
  const seen = [];
  cp.spawnSync = (c, args, o) => {
    calls++;
    seen.push(o.timeout);
    return { status: null, stdout: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  };
  try {
    root.resetGit();
    const dir = tmpProject();
    assert.equal(root.gitCommonRoot(dir), null);
    assert.equal(root.cliRoot(dir), dir);
    assert.equal(root.git(['status'], dir).status, null);
    assert.equal(calls, 1);
    assert.ok(seen[0] <= 1000, `per-call timeout is ${seen[0]}`);
    root.resetGit();
    cp.spawnSync = real;
    assert.equal(root.cliRoot(dir), dir, 'works again after reset (no git repo here: falls back to the directory)');
  } finally {
    cp.spawnSync = real;
    root.resetGit();
  }
});

test('R12: SessionStart finishes under 5 s with a git that hangs (posix: fake git on PATH)', { skip: process.platform === 'win32' }, () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-fakegit-'));
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  try {
    const proj = tmpProject({ checks: { fast: 'x' } });
    const t0 = Date.now();
    const r = runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: 'g', cwd: proj }, { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.equal(r.code, 0);
    assert.match(r.out, /ghorc /);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('R13: setup --project works with a broken global settings.json (warning only); without --project it is an error', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
    const proj = tmpProject({});
    const env = { GHORC_HOME: home };
    const chk = setupOut(['--check', '--project', '--cwd', proj], env);
    assert.match(chk, /WARN: .*settings\.json is not valid JSON/);
    assert.doesNotMatch(chk, /^ERROR:/m);
    const ap = setupOut(['--apply', 'pct', '--project', '--cwd', proj], env);
    assert.doesNotMatch(ap, /ERROR/);
    const local = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(local.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '18');
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ not json', 'the global file is untouched');
    const glob = setupOut(['--apply', 'pct', '--cwd', proj], env);
    assert.match(glob, /ERROR: .*not valid JSON/);
    const both = setupOut(['--apply', 'idle', '--project', '--cwd', proj], env);
    assert.match(both, /ERROR: .*not valid JSON/, 'a global item still needs a readable global file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R14: the config validity cache key includes the template, so a template change drops a stale verdict', () => {
  const proj = tmpProject({ heavyCommands: ['^make full'] });
  const file = path.join(proj, '.claude', 'ghorc.json');
  const st = fs.statSync(file);
  const cacheFile = path.join(TEST_TMP, 'config-valid.json');
  const seed = (tpl) =>
    fs.writeFileSync(cacheFile, JSON.stringify({ [file]: { mtimeMs: st.mtimeMs, size: st.size, tpl, reason: 'stale verdict' } }));
  const reason = () => {
    const r = guard(proj, 'make full');
    return r.out.trim() ? JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason : '';
  };
  seed(config.templateKey());
  assert.match(reason(), /config invalid: stale verdict/, 'same template: the cached verdict is used');
  seed('0:0');
  assert.doesNotMatch(reason(), /stale verdict/, 'another template: the verdict is recomputed');
  assert.match(reason(), /only the lead runs heavy checks/);
  assert.notEqual(config.templateKey(), '');
});

test('R15: the demo package.json gets test:full proposed; npm test only when checks.fast does not cover it', () => {
  const demo = fs.readFileSync(path.join(ROOT, 'examples', 'demo', 'package.json'), 'utf8');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  try {
    const proj = tmpProject({ checks: { fast: 'npm test', full: 'npm run test:full' } });
    fs.writeFileSync(path.join(proj, 'package.json'), demo);
    const chk = setupOut(['--check', '--cwd', proj], { GHORC_HOME: home });
    const item = lastJson(chk).items.find((i) => i.id === 'heavy');
    assert.deepEqual(item.proposed, ['^npm\\s+run\\s+test:full\\b']);
    assert.match(chk, /npm\\s\+run\\s\+test:full/);
    const other = tmpProject({ checks: { fast: 'npm run lint' } });
    fs.writeFileSync(path.join(other, 'package.json'), demo);
    const o = lastJson(setupOut(['--check', '--cwd', other], { GHORC_HOME: home })).items.find((i) => i.id === 'heavy');
    assert.deepEqual(o.proposed, ['^npm\\s+(?:run\\s+)?test\\b(?!:)', '^npm\\s+run\\s+test:full\\b']);
    assert.equal(hit('npm run test:full', o.proposed), true);
    assert.equal(hit('npm run test:full', [o.proposed[0]]), false, 'the npm test regex does not swallow test:full');
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', full: 'x', dev: 'y' } }));
    const t = lastJson(setupOut(['--check', '--cwd', other], { GHORC_HOME: home })).items.find((i) => i.id === 'heavy');
    assert.deepEqual(t.proposed, ['^npm\\s+run\\s+typecheck\\b', '^npm\\s+run\\s+full\\b']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('#17: applying statusLine saves the previous one; --restore puts it back; check shows the state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-home-'));
  try {
    const settingsFile = path.join(home, '.claude', 'settings.json');
    const backup = path.join(home, '.claude', 'ghorc-statusline-backup.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const mine = { type: 'command', command: 'node my-line.js', padding: 1 };
    fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: mine, theme: 'dark' }));
    const proj = tmpProject({});
    const env = { GHORC_HOME: home };
    const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.match(setupOut(['--check', '--cwd', proj], env), /^statusline: other$/m);
    const ap = setupOut(['--apply', 'statusLine', '--cwd', proj], env);
    assert.match(ap, /saved previous statusLine/);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')).value, mine);
    assert.match(read().statusLine.command, /statusline\.cjs/);
    assert.match(setupOut(['--check', '--cwd', proj], env), /^statusline: ghorc \(previous saved\)$/m);
    // a second apply (stale path, say) must not overwrite the saved original with a ghorc line
    setupOut(['--apply', 'statusLine', '--cwd', proj], env);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')).value, mine);
    const rs = setupOut(['--restore', 'statusline', '--cwd', proj], env);
    assert.match(rs, /\+ statusLine: /);
    assert.deepEqual(read(), { statusLine: mine, theme: 'dark' });
    assert.equal(fs.existsSync(backup), false, 'backup deleted');
    assert.match(setupOut(['--restore', 'statusline', '--cwd', proj], env), /ERROR: no saved previous status line/);
    assert.match(setupOut(['--restore', 'model', '--cwd', proj], env), /ERROR: --restore knows only: statusline/);

    // there was none: restore removes the key
    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }));
    assert.match(setupOut(['--check', '--cwd', proj], env), /^statusline: none$/m);
    setupOut(['--apply', 'statusLine', '--cwd', proj], env);
    assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).had, false);
    setupOut(['--restore', 'statusline', '--cwd', proj], env);
    assert.deepEqual(read(), { theme: 'dark' });

    // a ghorc line that is only stale is not recorded as a previous one
    const stale = { type: 'command', command: 'node "C:/x/.claude/plugins/cache/ghorc/ghorc/0.1/scripts/statusline.cjs"' };
    fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: stale }));
    setupOut(['--apply', 'statusLine', '--cwd', proj], env);
    assert.equal(fs.existsSync(backup), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('manifests carry the same version', () => {
  const v = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  assert.equal(v('package.json').version, '0.6.1');
  assert.equal(v('.claude-plugin/plugin.json').version, '0.6.1');
  const mp = v('.claude-plugin/marketplace.json');
  assert.ok(JSON.stringify(mp).includes('0.6.1'));
});
