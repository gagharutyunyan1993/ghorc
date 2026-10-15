'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function runScript(name, input, opts = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name), ...(opts.args || [])], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-kit-test-'));
  if (config) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'orc-kit.json'), JSON.stringify(config));
  }
  return dir;
}

let n = 0;
function sid() {
  return `test-${process.pid}-${Date.now()}-${n++}`;
}

module.exports = { runScript, isDeny, tmpProject, sid };
