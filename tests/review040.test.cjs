'use strict';
// 0.4.0 review fixes: no kill of a foreign pid, shell wrapper matching, changed-file read reset, config consistency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { runScript, isDeny, tmpProject, sid, TEST_TMP, killTree, stopWatchdogs } = require('./helpers.cjs');

process.env.CLAUDE_PROJECT_DIR = ''; // keep the developer's own project config out of validate.check
const cmd = require('../scripts/lib/cmd.cjs');
const validate = require('../scripts/lib/validate.cjs');

const bash = (cwd, command, agent, tool = 'Bash') => ({
  hook_event_name: 'PreToolUse',
  session_id: sid(),
  cwd,
  agent_id: agent,
  tool_name: tool,
  tool_input: { command },
});
const hg = (input, env) => runScript('heavy-check-guard.cjs', input, { env });
const rg = (input, env) => runScript('read-guard.cjs', input, { env });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const waitFor = (fn, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until && !fn()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return fn();
};

test('R1: session-start never kills a live process named by a stale pid file (pid reuse)', () => {
  const cwd = tmpProject({ watchdog: { intervalSec: 1, autostart: true } });
  const foreign = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const prev = process.env.GHORC_TMP;
    process.env.GHORC_TMP = TEST_TMP;
    const tmpLib = require('../scripts/lib/tmp.cjs');
    const pidf = tmpLib.pidFile(path.resolve(cwd));
    process.env.GHORC_TMP = prev === undefined ? '' : prev;
    fs.mkdirSync(path.dirname(pidf), { recursive: true });
    // same plugin version, no heartbeat, started long ago: "stale heartbeat"
    const version = require('../.claude-plugin/plugin.json').version;
    fs.writeFileSync(pidf, JSON.stringify({ pid: foreign.pid, version, root: cwd, startedAt: Date.now() - 600000 }));
    const r = runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid(), cwd }, { cwd, env: { GHORC_NO_AUTOSTART: '' } });
    assert.equal(r.code, 0);
    assert.ok(alive(foreign.pid), 'the foreign process is still alive');
    const now = JSON.parse(fs.readFileSync(pidf, 'utf8')).pid;
    assert.notEqual(now, foreign.pid, 'a new watchdog took the pid file over');
  } finally {
    foreign.kill();
    stopWatchdogs(TEST_TMP);
  }
});

test('R1: a running watchdog exits when the pid file names another pid', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-handover-'));
  const dir = path.join(base, 't');
  fs.mkdirSync(dir);
  const pidf = path.join(base, 'w.pid');
  const child = cp.spawn(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'watchdog.cjs'), '--transcript-dir', dir, '--project-root', base, '--interval', '1',
      '--pid-file', pidf, '--heartbeat-file', path.join(base, 'w.beat'), '--state-file', path.join(base, 'w.state.json')],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => child.on('exit', () => resolve(true)));
  try {
    assert.ok(waitFor(() => fs.existsSync(pidf), 8000), 'pid file written');
    fs.writeFileSync(pidf, JSON.stringify({ pid: 2147483000, version: 'x' }));
    const ok = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 8000))]);
    assert.equal(ok, true, 'the older watchdog stepped down');
  } finally {
    killTree(child.pid);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('R1: a running watchdog exits and removes its files when the project root is gone', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-rootgone-'));
  const root = path.join(base, 'proj');
  fs.mkdirSync(root);
  const pidf = path.join(base, 'w.pid');
  const beat = path.join(base, 'w.beat');
  const child = cp.spawn(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'watchdog.cjs'), '--transcript-dir', path.join(base, 't'), '--project-root', root, '--interval', '1',
      '--pid-file', pidf, '--heartbeat-file', beat, '--state-file', path.join(base, 'w.state.json')],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    assert.ok(waitFor(() => fs.existsSync(pidf) && fs.existsSync(beat), 8000), 'pid file and heartbeat written');
    fs.rmSync(root, { recursive: true, force: true });
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 3500))]);
    assert.equal(code, 0, 'exited within 3 intervals');
    assert.equal(fs.existsSync(pidf), false, 'pid file removed');
    assert.equal(fs.existsSync(beat), false, 'heartbeat removed');
  } finally {
    killTree(child.pid);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('R2: shell wrappers, substitutions, call operators and npm options do not hide a heavy command', () => {
  const re = [/^npm\s+test\b/i, /^npm\s+run\s+test:e2e\b/i];
  for (const c of [
    'bash -c "cd app && npm test"',
    "sh -c 'npm test'",
    'cmd /c npm test',
    'cmd.exe /c "npm test"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "cd app; npm test"',
    'pwsh -c "npm run test:e2e"',
    'echo $(npm test)',
    'echo "$(npm test)"',
    'echo `npm test`',
    '& npm test',
    'foo & npm test',
    '(npm test)',
    'if ($x) { npm test }',
    'npm --prefix app test',
    'npm -C app run test:e2e',
    'npm --silent run test:e2e',
    'npm run-script test:e2e',
    'call npm test',
    'FOO=1 bash -c "BAR=2 npm test"',
  ]) {
    assert.equal(cmd.matches(c, re), true, c);
  }
  for (const c of ['git commit -m "run npm test"', 'echo npm test', 'grep -r "npm test" .', 'echo "cmd /c npm test"', 'npm run test:unit']) {
    assert.equal(cmd.matches(c, re), false, c);
  }
  const cwd = tmpProject({ heavyCommands: ['^npm\\s+test\\b'] });
  assert.equal(isDeny(hg(bash(cwd, 'powershell -Command "cd app; npm test"', 'ag1', 'PowerShell'))), true);
  assert.equal(isDeny(hg(bash(cwd, 'claude --print "hi"', 'ag1'))), true, 'claude --print is an agent start');
});

test('R3: a file changed by another writer starts a new read count; an unchanged one stays counted', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { maxRepeat: 2 } });
  const f = path.join(cwd, 'report.md');
  fs.writeFileSync(f, 'one');
  const read = () => rg({ hook_event_name: 'PreToolUse', session_id: s, cwd, tool_name: 'Read', tool_input: { file_path: f } });
  assert.equal(isDeny(read()), false);
  assert.equal(isDeny(read()), false);
  assert.equal(isDeny(read()), true, 'unchanged: the 3rd read is denied');
  fs.writeFileSync(f, 'two, longer'); // rewritten by a subagent or a script, no Edit of this agent
  assert.equal(isDeny(read()), false, 'changed: counted afresh');
  assert.equal(isDeny(read()), false);
  assert.equal(isDeny(read()), true);
});

test('R4: with an invalid config the lead may still start agents; subagents may not', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'ghorc.json'), '{"heavyCommands": [');
  assert.equal(isDeny(hg(bash(cwd, 'herdr agent start lead-next --kind claude'))), false, 'lead handoff');
  assert.equal(isDeny(hg(bash(cwd, 'herdr agent start x', 'ag1'))), true);
  assert.equal(isDeny(hg(bash(cwd, 'npm test'))), true, 'heavy defaults still denied');
});

test('R5: an unknown key alone is a config warning, not "config invalid"', () => {
  const cwd = tmpProject({ bogus: 1 });
  const r = runScript('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid(), cwd, agent_id: 'x' });
  assert.match(r.out, /config warning: unknown key: bogus/);
  assert.doesNotMatch(r.out, /config invalid/);
});

test('R6: heap snapshot tools do not count toward maxScreenshots', () => {
  const s = sid();
  const cwd = tmpProject({ readGuard: { maxScreenshots: 1 } });
  const call = (tool) => rg({ hook_event_name: 'PreToolUse', session_id: s, cwd, agent_id: 'ag1', tool_name: tool, tool_input: {} });
  for (let i = 0; i < 3; i++) assert.equal(isDeny(call('mcp__chrome-devtools__take_heapsnapshot')), false);
  assert.equal(isDeny(call('mcp__chrome-devtools__take_snapshot')), false);
  assert.equal(isDeny(call('mcp__chrome-devtools__take_screenshot')), true);
});

test('R7: handoff.readyTimeoutMin is in the defaults and checked by the validator', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'defaults.json'), 'utf8'));
  assert.equal(tpl.handoff.readyTimeoutMin, 10);
  const ok = tmpProject({ handoff: { readyTimeoutMin: 15 } });
  assert.deepEqual(validate.check(ok).problems, []);
  const bad = tmpProject({ handoff: { readyTimeoutMin: '15' } });
  assert.match(validate.check(bad).fatal.join('\n'), /handoff\.readyTimeoutMin: expected number/);
});
