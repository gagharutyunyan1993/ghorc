'use strict';
// Shared by the heavy-slots tests: an isolated "machine" (own GHORC_TMP with slot files) and a project with a config.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tmpProject, sid } = require('./helpers.cjs');

const WRAPPER = path.join(__dirname, '..', 'scripts', 'heavy-slot.cjs');
const SLOTS_LIB = path.join(__dirname, '..', 'scripts', 'lib', 'slots.cjs');
const NODE = process.execPath;
const made = [];
process.on('exit', () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function hookIn(cwd, command, session = sid(), extra = {}) {
  return { hook_event_name: 'PreToolUse', session_id: session, cwd, tool_name: 'Bash', tool_input: { command }, ...extra };
}

function mkTmp(prefix = 'ghorc-slots-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

// heavySlots undefined: no project config at all.
function world(heavySlots, extra = {}) {
  const tmp = mkTmp();
  const cwd = tmpProject(heavySlots === undefined ? undefined : { heavySlots, ...extra });
  const env = { GHORC_TMP: tmp, GHORC_SESSION: '', CLAUDE_CODE_SESSION_ID: '', GHORC_TEST_FREE_RAM_GB: '64' };
  const dir = path.join(tmp, 'heavy-slots');
  const file = (i) => path.join(dir, `slot-${i}.json`);
  const plant = (i, claim) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(i), JSON.stringify({ ts: Date.now(), heartbeat: Date.now(), minutes: 0, label: 'other check', ...claim }));
  };
  const wrap = (args, opts = {}) =>
    spawnSync(NODE, [WRAPPER, ...args], { cwd: opts.cwd || cwd, encoding: 'utf8', env: { ...process.env, ...env, ...(opts.env || {}) } });
  const wrapAsync = (args, opts = {}) => {
    const c = spawn(NODE, [WRAPPER, ...args], { cwd: opts.cwd || cwd, env: { ...process.env, ...env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let out = '';
    c.stderr.on('data', (d) => (err += d));
    c.stdout.on('data', (d) => (out += d));
    const done = new Promise((res) => c.on('close', (code, signal) => res({ code, signal, err, out })));
    return { child: c, done };
  };
  return { tmp, cwd, env, dir, file, plant, wrap, wrapAsync };
}

// A pid no process has (above the pid limit of Windows, Linux and macOS): a pid of a process that just exited can be given
// to a new process at once, which made the tests flaky under load.
const deadPid = () => 2147483632;
const exitedPid = () => spawnSync(NODE, ['-e', '']).pid;
const sleepNode = (ms) => ['--', NODE, '-e', `setTimeout(()=>{},${ms})`];
const exitNode = (code) => ['--', NODE, '-e', `process.exit(${code})`];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits (up to 20 s, the machine may be busy) until a parseable claim is in the slot file; returns it.
async function waitClaim(file) {
  const end = Date.now() + 20000;
  for (;;) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (Date.now() > end) throw e;
      await wait(25);
    }
  }
}

module.exports = { WRAPPER, SLOTS_LIB, NODE, hookIn, mkTmp, world, deadPid, exitedPid, sleepNode, exitNode, wait, waitClaim };
