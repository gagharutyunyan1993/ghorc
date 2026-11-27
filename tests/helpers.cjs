'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
// Per-process temp area: keeps tests away from the real <tmp>/ghorc and from the real ~/.claude/projects.
const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-testtmp-'));
const TEST_ROOT = path.join(TEST_TMP, 'transcripts');
fs.mkdirSync(TEST_ROOT, { recursive: true });

function runScript(name, input, opts = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name), ...(opts.args || [])], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    // the herdr ids of a test run inside a herdr pane must not reach the hooks (own workspace, HERDR_BIN_PATH fallback)
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', GHORC_ROLE: '', HC_TERMINAL_ID: '', HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_WORKSPACE_ID: '', HERDR_TAB_ID: '', HERDR_BIN_PATH: '', GHORC_TMP: TEST_TMP, GHORC_WATCHDOG_ROOT: TEST_ROOT, GHORC_NO_AUTOSTART: '1', GHORC_HOOK_GIT_TIMEOUT_MS: '15000', ...(opts.env || {}) }, // root.cjs gives git 1000 ms: too little under load
    cwd: opts.cwd,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function isDeny(r) {
  if (!r.out.trim()) return false;
  try {
    return JSON.parse(r.out).hookSpecificOutput.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

// A project that opted in to ghorc: .claude/ghorc.json is always written ({} when no config is given), because every hook
// is silent in a project without one. bareProject() is a project that never opted in.
function tmpProject(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-test-'));
  made.push(dir);
  if (config) {
    // The context-guard mechanics tests were written at the 0.10 thresholds (120K/150K); a project config without its own
    // thresholds keeps them, so a change of the shipped defaults does not move every fixture. Defaults are tested apart.
    const cfg = config.thresholds === undefined ? { ...config, thresholds: { ctxPrepare: 120000, ctxHandoff: 150000 } } : config;
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'ghorc.json'), JSON.stringify(cfg));
  }
  return dir;
}

// The status line's ctx file of session sid as a hook child process sees it: <TEST_TMP>/ctx/<root hash>/ctx-<sid>.json,
// with the root computed like the hooks do (CLAUDE_PROJECT_DIR = projectDir, else the git root of cwd). The directory
// is created. tmpDir overrides TEST_TMP for a test that gives its children another GHORC_TMP.
function ctxPath(cwd, sid, { projectDir = '', tmpDir = TEST_TMP } = {}) {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  let root;
  try {
    root = require('../scripts/lib/root.cjs').projectRoot(cwd);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
  const dir = path.join(tmpDir, 'ctx', require('../scripts/lib/tmp.cjs').rootHash(root));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `ctx-${String(sid).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

function bareProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-test-'));
  made.push(dir);
  return dir;
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid);
  } catch {
    /* gone */
  }
}

// Every watchdog-<hash>.pid in a tmp dir: JSON { pid } or a bare number.
function stopWatchdogs(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^watchdog-.*\.pid$/.test(f));
  } catch {
    return;
  }
  for (const f of names) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      let pid = Number(raw);
      if (!pid) pid = Number(JSON.parse(raw).pid);
      if (pid) killTree(pid);
    } catch {
      /* gone */
    }
  }
}

let n = 0;
const made = [];
process.on('exit', () => {
  // A session-start test may have autostarted the watchdog: stop it before removing its files.
  try {
    stopWatchdogs(TEST_TMP);
  } catch {
    /* none running */
  }
  for (const d of [...made, TEST_TMP]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* a log file may still be open for a moment */
    }
  }
});
function sid() {
  const id = `test-${process.pid}-${Date.now()}-${n++}`;
  made.push(path.join(TEST_TMP, id));
  return id;
}

module.exports = { killTree, stopWatchdogs, runScript, isDeny, tmpProject, bareProject, ctxPath, sid, TEST_TMP, TEST_ROOT };
