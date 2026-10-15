'use strict';
// Prints this session's <project root>/.claude/ctx-<session_id>.json, then its unread watchdog alerts.
const fs = require('node:fs');
const path = require('node:path');
const { projectRoot } = require('./lib/config.cjs');
const { unreadAlerts, markAlertsRead } = require('./lib/tmp.cjs');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'ctx.cjs --session <id> [--max-age <minutes>] [--cwd <dir>]  |  ctx.cjs --all: shows session context from .claude/ctx-*.json ' +
      '(--session takes the full id or the 8-character prefix from the status line; env GHORC_SESSION is the default), ' +
      'then up to 10 unread watchdog alerts of that session, oldest first, marking only those read. --all lists every session and marks nothing.',
  );
  process.exit(0);
}
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const all = args.includes('--all');
const session = opt('--session') || (process.env.GHORC_SESSION && process.env.GHORC_SESSION.trim()) || undefined;
if (!all && !session) {
  console.log('usage: ctx.cjs --session <id> (the id from SessionStart or the #xxxxxxxx status line segment; env GHORC_SESSION) or ctx.cjs --all');
  process.exit(2);
}
const maxAge = opt('--max-age') !== undefined ? Number(opt('--max-age')) : Infinity;
const root = projectRoot(opt('--cwd') || process.cwd());
const dir = path.join(root, '.claude');

const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
let rows = [];
try {
  rows = fs
    .readdirSync(dir)
    .filter((f) => /^ctx-.*\.json$/.test(f))
    .filter((f, _i, names) => {
      if (all) return true;
      const exact = `ctx-${safe(session)}.json`;
      return names.includes(exact) ? f === exact : f.startsWith(`ctx-${safe(session)}`);
    })
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

if (!rows.length) {
  console.log(all ? 'no ctx-*.json files (the status line is not configured or no session has written yet)' : `no ctx file for session ${session}`);
}
rows.forEach((r) => {
  const d = r.data;
  const u = d.current_usage;
  const used = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null;
  const pct = typeof d.used_percentage === 'number' ? `${Math.round(d.used_percentage)}%` : '--';
  const model = d.model && (d.model.display_name || d.model.id) ? d.model.display_name || d.model.id : '?';
  console.log(`  ${r.f}  ${model}  ctx ${pct}  used=${used === null ? '?' : used}/${d.context_window_size ?? '?'}  age=${r.age}m`);
});

// Alerts: per session. The full id comes from the matched ctx file when there is exactly one.
const sid = all ? null : rows.length === 1 && rows[0].data.session_id ? String(rows[0].data.session_id) : session;
const { lines, ends } = unreadAlerts(root, sid);
if (lines.length) {
  const cap = all ? lines.length : 10;
  const n = Math.min(cap, lines.length);
  console.log(`watchdog alerts (${lines.length} unread${n < lines.length ? `, first ${n} shown` : ''}):`);
  for (const l of lines.slice(0, n)) console.log(`  ${l}`);
  if (!all) {
    markAlertsRead(root, sid, ends[n - 1]);
    if (n < lines.length) console.log(`  ${lines.length - n} more unread: run ctx again`);
  }
}
process.exit(0);
