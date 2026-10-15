'use strict';
// Prints <cwd>/.claude/ctx-*.json files, newest first (the newest is marked *), then the last 5 unread watchdog alerts.
const fs = require('node:fs');
const path = require('node:path');
const { projectRoot } = require('./lib/config.cjs');
const { unreadAlerts, markAlertsRead } = require('./lib/tmp.cjs');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('ctx.cjs [--max-age <minutes>] [--session <id>] [--cwd <dir>]: shows session context from .claude/ctx-*.json, then the last 5 unread watchdog alerts (and marks them read).');
  process.exit(0);
}
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const maxAge = opt('--max-age') !== undefined ? Number(opt('--max-age')) : Infinity;
const session = opt('--session');
const dir = path.join(projectRoot(opt('--cwd') || process.cwd()), '.claude');

let rows = [];
try {
  rows = fs
    .readdirSync(dir)
    .filter((f) => /^ctx-.*\.json$/.test(f))
    .filter((f) => !session || f === `ctx-${session}.json`)
    .map((f) => {
      const p = path.join(dir, f);
      const mtime = fs.statSync(p).mtimeMs;
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* broken file */
      }
      return { f, mtime, data, age: Math.round((Date.now() - mtime) / 60000) };
    })
    .filter((r) => r.age <= maxAge)
    .sort((a, b) => b.mtime - a.mtime);
} catch {
  /* no directory */
}

if (!rows.length) console.log('no ctx-*.json files (the status line is not configured or no session has written yet)');
rows.forEach((r, i) => {
  const d = r.data;
  const u = d.current_usage;
  const used = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null;
  const pct = typeof d.used_percentage === 'number' ? `${Math.round(d.used_percentage)}%` : '--';
  const model = d.model && (d.model.display_name || d.model.id) ? d.model.display_name || d.model.id : '?';
  console.log(
    `${i === 0 ? '*' : ' '} ${r.f}  ${model}  ctx ${pct}  used=${used === null ? '?' : used}/${d.context_window_size ?? '?'}  age=${r.age}m`,
  );
});

const { lines, size } = unreadAlerts();
if (lines.length) {
  const shown = lines.slice(-5);
  console.log(`watchdog alerts (${lines.length} unread${lines.length > shown.length ? ', last ' + shown.length + ' shown' : ''}):`);
  for (const l of shown) console.log(`  ${l}`);
  markAlertsRead(size);
}
process.exit(0);
