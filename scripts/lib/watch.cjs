'use strict';
// Pure watchdog decisions, kept separate so tests can drive them without time.

// Growth streak in polls: +1 on a fast poll, -1 (not zero) on a slow one.
function nextStreak(streak, fast) {
  return fast ? streak + 1 : Math.max(0, streak - 1);
}

// Polls of sustained growth needed for the streak alert.
function pollsNeeded(streakMs, intervalSec) {
  return Math.max(1, Math.ceil(streakMs / (Math.max(1, intervalSec) * 1000)));
}

// Level 2 (over the stop threshold and growing): a file seen for the first time already over the threshold counts too.
function stopAlarm(first, size, delta, stopBytes) {
  return size > stopBytes && (first || delta > 0);
}

// Splits a --notify string into an argv array (double quotes group words); no shell is involved.
function splitCommand(s) {
  const out = [];
  const re = /"((?:[^"]|\\")*?)"(?=\s|$)|(\S+)/g;
  let m;
  while ((m = re.exec(String(s)))) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]);
  return out;
}

module.exports = { nextStreak, pollsNeeded, stopAlarm, splitCommand };
