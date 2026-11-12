'use strict';
// ghorc.json check: JSON validity, known keys, types, regex compilation.
const fs = require('node:fs');
const { findConfig, readJson, TEMPLATE } = require('./config.cjs');

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typeOf(v) {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}

// Weekly percentages of the capacity section: each 0..100 (0 = off); when non-zero they must climb weeklyAgentsStepPct <=
// weeklyNoNewPct <= weeklyCapPct. Wrong types are reported by the generic check, so only numbers are looked at here.
function checkCapacity(c, problems) {
  const keys = ['weeklyAgentsStepPct', 'weeklyNoNewPct', 'weeklyCapPct'];
  const val = (k) => (typeof c[k] === 'number' && Number.isFinite(c[k]) ? c[k] : null);
  for (const k of keys) {
    const v = val(k);
    if (v !== null && (v < 0 || v > 100)) problems.push(`capacity.${k}: ${v} is outside 0..100`);
  }
  const [step, noNew, capPct] = keys.map(val);
  if (step > 0 && noNew > 0 && step > noNew) problems.push(`capacity.weeklyAgentsStepPct (${step}) must not exceed capacity.weeklyNoNewPct (${noNew})`);
  if (noNew > 0 && capPct > 0 && noNew > capPct) problems.push(`capacity.weeklyNoNewPct (${noNew}) must not exceed capacity.weeklyCapPct (${capPct})`);
  if (step > 0 && capPct > 0 && step > capPct) problems.push(`capacity.weeklyAgentsStepPct (${step}) must not exceed capacity.weeklyCapPct (${capPct})`);
}

// Returns { path, problems: string[], fatal: string[] }. path=null means there is no file (not an error).
// fatal = the problems that make the config unusable (everything except unknown keys).
const isFatal = (p) => !p.startsWith('unknown key');
function result(path, problems) {
  return { path, problems, fatal: problems.filter(isFatal) };
}

function check(cwd, opts = {}) {
  return checkFile(findConfig(cwd, opts));
}

function checkFile(file) {
  if (!file) return result(null, []);
  const problems = [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return result(file, [`invalid JSON: ${e.message}`]);
  }
  if (!isObj(data)) return result(file, ['the root must be an object']);
  const tpl = readJson(TEMPLATE) || {};

  for (const key of Object.keys(data)) {
    if (key.startsWith('_comment')) continue;
    if (!(key in tpl)) {
      problems.push(`unknown key: ${key}`);
      continue;
    }
    const want = typeOf(tpl[key]);
    if (typeOf(data[key]) !== want) {
      problems.push(`${key}: expected ${want}, got ${typeOf(data[key])}`);
      continue;
    }
    if (isObj(tpl[key])) {
      for (const sub of Object.keys(data[key])) {
        if (sub.startsWith('_comment')) continue;
        if (!(sub in tpl[key])) problems.push(`unknown key: ${key}.${sub}`);
        else if (typeOf(data[key][sub]) !== typeOf(tpl[key][sub])) {
          problems.push(`${key}.${sub}: expected ${typeOf(tpl[key][sub])}, got ${typeOf(data[key][sub])}`);
        }
      }
    }
  }
  if (isObj(data.capacity)) checkCapacity(data.capacity, problems);
  if (Array.isArray(data.heavyCommands)) {
    data.heavyCommands.forEach((p, i) => {
      if (typeof p !== 'string') return problems.push(`heavyCommands[${i}]: not a string`);
      if (p === '') return problems.push(`heavyCommands[${i}]: an empty pattern matches everything`);
      try {
        new RegExp(p, 'i');
      } catch (e) {
        problems.push(`heavyCommands[${i}]: regex does not compile (${e.message})`);
      }
    });
  }
  return result(file, problems);
}

module.exports = { check, checkFile };
