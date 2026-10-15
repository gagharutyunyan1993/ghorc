'use strict';
// Загрузка конфига проекта: <cwd>/.claude/orc-kit.json поверх templates/orc-kit.json.
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'orc-kit.json');

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

function configPath(cwd) {
  return path.join(cwd || process.cwd(), '.claude', 'orc-kit.json');
}

// load(cwd) -> итоговый конфиг. found(cwd) -> есть ли файл проекта.
function load(cwd) {
  const defaults = readJson(TEMPLATE) || {};
  const project = readJson(configPath(cwd));
  return project ? merge(defaults, project) : defaults;
}

function found(cwd) {
  return readJson(configPath(cwd)) !== null;
}

module.exports = { load, found, merge, configPath, TEMPLATE };
