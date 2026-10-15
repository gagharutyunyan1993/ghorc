'use strict';
// Загрузка конфига проекта: <корень>/.claude/ghorc.json поверх templates/ghorc.json.
// Корень ищется так: CLAUDE_PROJECT_DIR, затем подъём от cwd до корня git (включительно).
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

// Объекты сливаются рекурсивно, массивы и скаляры заменяются.
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

// Каталоги от cwd вверх до корня git включительно (если .git не найден - до корня диска).
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

// Основной корень репозитория при работе в worktree: родитель `git rev-parse --git-common-dir`.
// null - не git, git недоступен или bare-репозиторий.
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

// Корень проекта: CLAUDE_PROJECT_DIR, иначе основной корень git (в т.ч. из worktree), иначе подъём до .git, иначе cwd.
function projectRoot(cwd) {
  const env = envProjectDir();
  if (env) return path.resolve(env);
  const common = gitCommonRoot(cwd);
  if (common) return common;
  const list = ancestors(cwd);
  const last = list[list.length - 1];
  return fs.existsSync(path.join(last, '.git')) ? last : path.resolve(cwd || process.cwd());
}

// Путь к найденному ghorc.json или null.
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

// Для сообщений: найденный путь или ожидаемый в корне проекта.
function configPath(cwd) {
  return findConfig(cwd) || path.join(projectRoot(cwd), '.claude', 'ghorc.json');
}

// load(cwd) -> итоговый конфиг. found(cwd) -> есть ли читаемый файл проекта.
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
