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
function findConfig(cwd, opts = {}) {
  const dirs = [];
  const env = opts.cli ? null : envProjectDir(); // CLI tools ignore CLAUDE_PROJECT_DIR
  if (env) dirs.push(path.resolve(env));
  for (const d of ancestors(cwd)) if (!dirs.includes(d)) dirs.push(d);
  const probe = (list) => {
    for (const d of list) {
      const p = path.join(d, '.claude', 'ghorc.json');
      if (fs.existsSync(p)) return p;
    }
    return null;
  };
  // git is spawned only when the cheap lookups (CLAUDE_PROJECT_DIR, cwd ancestors) found nothing
  const hit = probe(dirs);
  if (hit) return hit;
  const common = gitCommonRoot(cwd);
  return !opts.cli && common && !dirs.includes(common) ? probe([common]) : null;
}

// For messages: the found path, or the expected one in the project root.
function configPath(cwd) {
  return findConfig(cwd) || path.join(projectRoot(cwd), '.claude', 'ghorc.json');
}

// Validation result for a config file, cached by mtime+size in the tmp dir: null (valid) or a reason string.
function validity(file) {
  const tmp = require('./tmp.cjs');
  const cacheFile = path.join(tmp.tmpDir(), 'config-valid.json');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  let cache = {};
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (isObj(j)) cache = j;
  } catch {
    /* no cache yet */
  }
  const hit = cache[file];
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.reason;
  const { fatal } = require('./validate.cjs').checkFile(file);
  const reason = fatal.length ? fatal[0] : null;
  try {
    fs.mkdirSync(tmp.tmpDir(), { recursive: true });
    cache[file] = { mtimeMs: st.mtimeMs, size: st.size, reason };
    tmp.atomicWrite(cacheFile, JSON.stringify(cache));
  } catch {
    /* the cache is optional */
  }
  return reason;
}

// load(cwd) -> the final config; config.invalid is a reason string when the project file fails validation
// (parse error, wrong type, bad regex). found(cwd) -> whether a readable project file exists.
function load(cwd, opts = {}) {
  const defaults = readJson(TEMPLATE) || {};
  const file = findConfig(cwd, opts);
  const project = file ? readJson(file) : null;
  const cfg = isObj(project) ? merge(defaults, project) : defaults;
  if (file) {
    try {
      const reason = validity(file);
      if (reason) cfg.invalid = reason;
    } catch {
      /* validation is best effort */
    }
  }
  return cfg;
}

function found(cwd, opts = {}) {
  const file = findConfig(cwd, opts);
  return file !== null && readJson(file) !== null;
}

module.exports = { load, found, merge, configPath, findConfig, projectRoot, gitCommonRoot, ancestors, readJson, TEMPLATE };
