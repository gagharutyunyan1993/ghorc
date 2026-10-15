'use strict';
// Project config loading: <root>/.claude/ghorc.json over templates/ghorc.json.
// The root is found as: CLAUDE_PROJECT_DIR, then walking up from cwd to the git root (inclusive).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'ghorc.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Objects merge recursively; arrays and scalars are replaced.
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
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

function envProjectDir() {
  const v = process.env.CLAUDE_PROJECT_DIR;
  return v && v.trim() ? v : null;
}

// Main repository root when working in a worktree: the parent of `git rev-parse --git-common-dir`.
// null: not git, git unavailable, or a bare repository.
function gitCommonRoot(cwd) {
  try {
    const base = path.resolve(cwd || process.cwd());
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: base, encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return null;
    const out = String(r.stdout).trim();
    if (!out) return null;
    const common = path.resolve(base, out);
    return path.basename(common) === '.git' ? path.dirname(common) : null;
  } catch {
    return null;
  }
}

// Project root: CLAUDE_PROJECT_DIR, else the main git root (including from a worktree), else walk up to .git, else cwd.
function projectRoot(cwd) {
  const env = envProjectDir();
  if (env) return path.resolve(env);
  const common = gitCommonRoot(cwd);
  if (common) return common;
  const list = ancestors(cwd);
  const last = list[list.length - 1];
  return fs.existsSync(path.join(last, '.git')) ? last : path.resolve(cwd || process.cwd());
}

// Path to the found ghorc.json, or null.
function findConfig(cwd) {
  const dirs = [];
  const env = envProjectDir();
  if (env) dirs.push(path.resolve(env));
  for (const d of ancestors(cwd)) if (!dirs.includes(d)) dirs.push(d);
  const common = gitCommonRoot(cwd);
  if (common && !dirs.includes(common)) dirs.push(common);
  for (const d of dirs) {
    const p = path.join(d, '.claude', 'ghorc.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// For messages: the found path, or the expected one in the project root.
function configPath(cwd) {
  return findConfig(cwd) || path.join(projectRoot(cwd), '.claude', 'ghorc.json');
}

// load(cwd) -> the final config. found(cwd) -> whether a readable project file exists.
function load(cwd) {
  const defaults = readJson(TEMPLATE) || {};
  const file = findConfig(cwd);
  const project = file ? readJson(file) : null;
  return project ? merge(defaults, project) : defaults;
}

function found(cwd) {
  const file = findConfig(cwd);
  return file !== null && readJson(file) !== null;
}

module.exports = { load, found, merge, configPath, findConfig, projectRoot, gitCommonRoot, ancestors, readJson, TEMPLATE };
