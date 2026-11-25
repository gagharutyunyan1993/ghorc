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

// tabs: maxWorkers 1..20 (integer), idleMin and overtimeMin 1..1440. Wrong types are reported by the generic check.
function checkTabs(c, problems) {
  const range = { maxWorkers: [1, 20], idleMin: [1, 1440], overtimeMin: [1, 1440] };
  for (const [k, [lo, hi]] of Object.entries(range)) {
    const v = c[k];
    if (typeof v !== 'number') continue;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < lo || v > hi) problems.push(`tabs.${k}: ${v} must be a whole number in ${lo}..${hi}`);
  }
  // devCommands: regexes of long-running commands that only a runner tab may start; [] turns the rule off
  if (Array.isArray(c.devCommands)) {
    c.devCommands.forEach((p, i) => {
      if (typeof p !== 'string') return problems.push(`tabs.devCommands[${i}]: not a string`);
      if (p === '') return problems.push(`tabs.devCommands[${i}]: an empty pattern matches everything`);
      try {
        new RegExp(p, 'i');
      } catch (e) {
        problems.push(`tabs.devCommands[${i}]: regex does not compile (${e.message})`);
      }
    });
  }
}

// git.protectedBranches: non-empty strings ([] = no branch is protected). Wrong types are reported by the generic check.
function checkGit(c, problems) {
  if (!Array.isArray(c.protectedBranches)) return;
  c.protectedBranches.forEach((b, i) => {
    if (typeof b !== 'string' || !b.trim()) problems.push(`git.protectedBranches[${i}]: must be a non-empty string`);
  });
}

// ciRetry: freeRetries 0..100 and hardCap 1..100 (whole numbers), freeRetries <= hardCap, windowHours above 0 and at most 720.
function checkCiRetry(c, problems) {
  const range = { freeRetries: [0, 100], hardCap: [1, 100] };
  for (const [k, [lo, hi]] of Object.entries(range)) {
    const v = c[k];
    if (typeof v !== 'number') continue;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < lo || v > hi) problems.push(`ciRetry.${k}: ${v} must be a whole number in ${lo}..${hi}`);
  }
  const h = c.windowHours;
  if (typeof h === 'number' && (!Number.isFinite(h) || h <= 0 || h > 720)) problems.push(`ciRetry.windowHours: ${h} must be above 0 and at most 720`);
  if (Number.isInteger(c.freeRetries) && Number.isInteger(c.hardCap) && c.freeRetries > c.hardCap) {
    problems.push(`ciRetry.freeRetries (${c.freeRetries}) must not exceed ciRetry.hardCap (${c.hardCap})`);
  }
}

// Returns { path, problems: string[], fatal: string[] }. path=null means there is no file (not an error).
// fatal = the problems that make the config unusable (everything except unknown keys).
// (a bad element of tabs.devCommands is reported but does not make the config unusable: the guard drops that one pattern)
const isFatal = (p) => !p.startsWith('unknown key') && !/^tabs\.devCommands\[\d+\]:/.test(p);
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
  if (isObj(data.backend) && typeof data.backend.prefer === 'string' && !['hc', 'herdr'].includes(data.backend.prefer)) {
    problems.push(`backend.prefer: must be "hc" or "herdr", got ${JSON.stringify(data.backend.prefer)}`);
  }
  if (isObj(data.worker) && Array.isArray(data.worker.permissionArgs)) {
    data.worker.permissionArgs.forEach((a, i) => {
      if (typeof a !== 'string') problems.push(`worker.permissionArgs[${i}]: not a string`);
    });
  }
  if (isObj(data.capacity)) checkCapacity(data.capacity, problems);
  if (isObj(data.tabs)) checkTabs(data.tabs, problems);
  if (isObj(data.git)) checkGit(data.git, problems);
  if (isObj(data.ciRetry)) checkCiRetry(data.ciRetry, problems);
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
