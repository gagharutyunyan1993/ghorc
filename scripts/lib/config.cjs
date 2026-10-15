'use strict';
// Project config loading: <root>/.claude/ghorc.json over templates/ghorc.json.
// Root rule (lib/root.cjs): CLAUDE_PROJECT_DIR, else the main git root, else cwd. The config is also searched in cwd ancestors.
const fs = require('node:fs');
const path = require('node:path');
const { projectRoot, gitCommonRoot, ancestors, envProjectDir } = require('./root.cjs');

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
