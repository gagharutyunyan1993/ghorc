'use strict';
// The single project-root rule, shared by every writer and reader of <root>/.claude:
// Hooks and the status line: CLAUDE_PROJECT_DIR if set, else the main git root (git common dir, also from a worktree), else cwd (with git unavailable: the nearest ancestor holding .git).
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process'); // called as cp.spawnSync so tests can stub it

const GIT_TIMEOUT_MS = 1000;
const GIT_BUDGET_MS = 2500; // all git calls of one process together
let gitSpent = 0;
let gitDead = false; // set by the first timeout: git hangs, so no further spawn is tried in this process

// The only way scripts spawn git: a per-call timeout, a shared budget and a kill switch after the first timeout, so a
// hanging git costs a hook one timeout instead of one per call. Returns { status, stdout } (status null on failure).
function git(args, cwd) {
  if (gitDead || gitSpent >= GIT_BUDGET_MS) return { status: null, stdout: '' };
  const t0 = Date.now();
  try {
    const r = cp.spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: Math.min(GIT_TIMEOUT_MS, GIT_BUDGET_MS - gitSpent),
      windowsHide: true,
    });
    if (r.error && r.error.code === 'ETIMEDOUT') gitDead = true;
    return r;
  } catch {
    return { status: null, stdout: '' };
  } finally {
    gitSpent += Date.now() - t0;
  }
}

// Tests only: forget the budget and the kill switch.
function resetGit() {
  gitSpent = 0;
  gitDead = false;
}

function envProjectDir() {
  const v = process.env.CLAUDE_PROJECT_DIR;
  return v && v.trim() ? v : null;
}

// Main repository root when working in a worktree: the parent of `git rev-parse --git-common-dir`.
// null: not git, git unavailable, or a bare repository.
function gitCommonRoot(cwd) {
  try {
    const base = path.resolve(cwd || process.cwd());
    const r = git(['rev-parse', '--git-common-dir'], base);
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

// CLI tools (setup, check-config, ctx): the root of the directory they are run in. Never CLAUDE_PROJECT_DIR (hooks only).
// git toplevel of cwd (a worktree is its own root), else the nearest ancestor holding .git, else cwd.
function cliRoot(cwd) {
  const base = path.resolve(cwd || process.cwd());
  try {
    const r = git(['rev-parse', '--show-toplevel'], base);
    const out = r.status === 0 ? String(r.stdout).trim() : '';
    if (out) return path.resolve(base, out);
  } catch {
    // git unavailable: fall through
  }
  const last = ancestors(base).pop();
  return fs.existsSync(path.join(last, '.git')) ? last : base;
}

module.exports = { git, resetGit, GIT_TIMEOUT_MS, cliRoot, projectRoot, gitCommonRoot, ancestors, envProjectDir };
