'use strict';
// The single project-root rule, shared by every writer and reader of <root>/.claude:
// CLAUDE_PROJECT_DIR if set, else the main git root (git common dir, also from a worktree), else cwd (with git unavailable: the nearest ancestor holding .git).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function envProjectDir() {
  const v = process.env.CLAUDE_PROJECT_DIR;
  return v && v.trim() ? v : null;
}

// Main repository root when working in a worktree: the parent of `git rev-parse --git-common-dir`.
// null: not git, git unavailable, or a bare repository.
function gitCommonRoot(cwd) {
  try {
    const base = path.resolve(cwd || process.cwd());
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: base, encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status !== 0) return null;
    const out = String(r.stdout).trim();
    if (!out) return null;
    const common = path.resolve(base, out);
    return path.basename(common) === '.git' ? path.dirname(common) : null;
  } catch {
    return null;
  }
}

// Directories from cwd up to the git root inclusive (if .git is not found, up to the drive root).
function ancestors(cwd) {
  const out = [];
  let dir = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 64; i++) {
    out.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

// Project root: CLAUDE_PROJECT_DIR, else the main git root, else cwd.
function projectRoot(cwd) {
  const env = envProjectDir();
  if (env) return path.resolve(env);
  const common = gitCommonRoot(cwd);
  if (common) return common;
  // git unavailable: nearest ancestor holding .git, else cwd
  const last = ancestors(cwd).pop();
  return fs.existsSync(path.join(last, '.git')) ? last : path.resolve(cwd || process.cwd());
}

module.exports = { projectRoot, gitCommonRoot, ancestors, envProjectDir };
