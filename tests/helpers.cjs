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
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', GHORC_ROLE: '', GHORC_TMP: TEST_TMP, GHORC_WATCHDOG_ROOT: TEST_ROOT, ...(opts.env || {}) },
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

function tmpProject(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghorc-test-'));
  made.push(dir);
  if (config) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'ghorc.json'), JSON.stringify(config));
  }
  return dir;
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
      if (pid) process.kill(pid);
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

module.exports = { stopWatchdogs, runScript, isDeny, tmpProject, sid, TEST_TMP, TEST_ROOT };
