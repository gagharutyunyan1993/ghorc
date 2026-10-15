'use strict';
// statusLine: one line + the file <project root>/.claude/ctx-<session_id>.json for the lead.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { projectRoot } = require('./lib/root.cjs');
const { tmpDir } = require('./lib/tmp.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'statusline.cjs: statusLine command. Reads JSON from stdin, prints "model ·effort │ ctx NN% (used/size) │ 5h │ 7d (~Nd from 48 h) │ role │ #<session_id first 8> │ branch │ session name" ' +
      'and writes <project root>/.claude/ctx-<session_id>.json. GHORC_STATUSLINE_DUMP=<file> appends the raw stdin. ' +
      'The first raw stdin is also saved once to <tmpdir>/ghorc-<user>/statusline-sample.json. ' +
      'NO_COLOR / GHORC_STATUSLINE_PLAIN=1 disable color. GHORC_GIT_TIMEOUT_MS overrides the 300 ms git timeout. See README.',
  );
  process.exit(0);
}

const SEP = ' │ ';
const plain = Boolean(process.env.NO_COLOR) || process.env.GHORC_STATUSLINE_PLAIN === '1';
const RESET = '\x1b[0m';
const paint = (code, s) => (plain ? s : `\x1b[${code}m${s}${RESET}`);
const GREEN = '32';
const YELLOW = '33';
const RED = '31';
const BOLD_RED = '1;31';
const DIM = '2';
const CYAN = '36';

function band(pct) {
  if (pct >= 80) return BOLD_RED;
  if (pct >= 70) return RED;
  if (pct >= 50) return YELLOW;
  return GREEN;
}

function fmt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '?';
  if (n >= 1000000) return `${Math.round((n / 1000000) * 10) / 10}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// Verified live shape (Claude Code 2.1.300): rate_limits.{five_hour,seven_day} = { used_percentage, resets_at (epoch SECONDS) }.
// The other keys below are defensive fallbacks only.
function limitPct(o) {
  if (typeof o === 'number') return o;
  if (!o || typeof o !== 'object') return null;
  for (const k of ['used_percentage', 'utilization', 'used_percent', 'percent', 'percentage', 'pct']) {
    const v = num(o[k]);
    if (v !== null) return v <= 1 && k === 'utilization' ? v * 100 : v;
  }
  const rem = num(o.remaining_percentage) ?? num(o.remaining_percent);
  return rem !== null ? 100 - rem : null;
}

function limitResetHours(o, now) {
  if (!o || typeof o !== 'object') return null;
  const secs = num(o.resets_in_seconds) ?? num(o.reset_in_seconds);
  if (secs !== null) return secs / 3600;
  for (const k of ['resets_at', 'reset_at', 'resetsAt', 'resets', 'reset']) {
    let v = o[k];
    if (v === undefined || v === null) continue;
    let ms = null;
    if (typeof v === 'number') ms = v < 1e11 ? v * 1000 : v;
    else if (typeof v === 'string') {
      const t = Date.parse(v);
      ms = isNaN(t) ? null : t;
    }
    if (ms !== null) return Math.max(0, (ms - now) / 3600000);
  }
  return null;
}

function limitSegment(label, o, now) {
  const p = limitPct(o);
  if (p === null) return null;
  let s = `${label} ${Math.round(p)}%`;
  const h = limitResetHours(o, now);
  if (h !== null) s += h < 1 ? ` (~${Math.max(1, Math.round(h * 60))}m)` : h >= 48 ? ` (~${Math.round(h / 24)}d)` : ` (~${Math.round(h)}h)`;
  return paint(band(p), s);
}

function gitBranch(cwd, worktree) {
  if (!cwd) return null;
  try {
    const run = (args) => {
      const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: Number(process.env.GHORC_GIT_TIMEOUT_MS) || 300, windowsHide: true });
      return r.status === 0 ? String(r.stdout).trim() : null;
    };
    let b = run(['rev-parse', '--abbrev-ref', 'HEAD']) || run(['symbolic-ref', '--short', 'HEAD']);
    if (!b) return null;
    if (b === 'HEAD') b = run(['rev-parse', '--short', 'HEAD']);
    if (!b) return null;
    return paint(CYAN, `${worktree ? '⎇ ' : ''}${b}`);
  } catch {
    return null;
  }
}

let raw = '';
let input = {};
try {
  raw = fs.readFileSync(0, 'utf8');
  input = JSON.parse(raw) || {};
} catch {
  /* empty input */
}

try {
  const dump = process.env.GHORC_STATUSLINE_DUMP;
  if (dump && raw.trim()) fs.appendFileSync(dump, raw.replace(/\r?\n/g, ' ').trim() + '\n');
} catch {
  /* the dump is optional */
}
try {
  // One-time live sample (no env needed): captured so the real rate_limits shape can be learned.
  if (raw.trim()) {
    const sampleDir = tmpDir();
    const sample = path.join(sampleDir, 'statusline-sample.json');
    if (!fs.existsSync(sample)) {
      fs.mkdirSync(sampleDir, { recursive: true });
      fs.writeFileSync(sample, raw);
    }
  }
} catch {
  /* the sample is optional */
}

const cw = input.context_window || {};
const usage = cw.current_usage || null;
const used = usage
  ? (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  : null;
const size = cw.context_window_size;
const pct = typeof cw.used_percentage === 'number' ? cw.used_percentage : null;
const model = (input.model && (input.model.display_name || input.model.id)) || 'model?';
const effort = input.effort && input.effort.level;
const rl = input.rate_limits && typeof input.rate_limits === 'object' ? input.rate_limits : null;

try {
  const cwd0 = input.cwd || (input.workspace && input.workspace.current_dir);
  const segs = [];

  let m = paint('1', model);
  if (effort) m += paint(DIM, ` ·${effort}`);
  if (input.fast_mode === true) m += ' ⚡';
  segs.push(m);

  let ctx;
  if (pct === null) ctx = 'ctx --';
  else {
    ctx = paint(band(pct), `ctx ${Math.round(pct)}% (${fmt(used)}/${fmt(size)})`);
  }
  // Autocompact threshold: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is the fill percentage at which compaction happens;
  // the default is not documented, so the marker is printed only when the variable is set.
  const ac = Number(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  if (process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE && isFinite(ac) && ac > 0 && ac <= 100) {
    ctx += paint(DIM, ` →ac ${Math.round(ac)}%`);
  }
  segs.push(ctx);

  if (rl) {
    const now = Date.now();
    const a = limitSegment('5h', rl.five_hour, now);
    const b = limitSegment('7d', rl.seven_day, now);
    if (a) segs.push(a);
    if (b) segs.push(b);
  }

  const role = [];
  if (process.env.GHORC_ROLE) role.push(process.env.GHORC_ROLE);
  if (input.agent && input.agent.name) role.push(String(input.agent.name));
  if (role.length) segs.push(role.join(' '));
  if (input.session_id) segs.push(paint(DIM, `#${String(input.session_id).slice(0, 8)}`));

  const br = gitBranch(cwd0, input.workspace && input.workspace.git_worktree);
  if (br) segs.push(br);

  if (input.session_name) segs.push(String(input.session_name).slice(0, 24));

  process.stdout.write(segs.join(SEP) + '\n');
} catch {
  process.stdout.write(`${model}${SEP}ctx ?%\n`);
}

try {
  const sid = input.session_id;
  const cwd = input.cwd || (input.workspace && input.workspace.current_dir);
  const pd = input.workspace && input.workspace.project_dir;
  const base = pd || cwd;
  const root = base || process.env.CLAUDE_PROJECT_DIR ? projectRoot(base) : null;
  if (sid && root) {
    const dir = path.join(root, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `ctx-${String(sid).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    const out = {
      session_id: sid,
      used_percentage: pct,
      current_usage: usage,
      context_window_size: size === undefined ? null : size,
      model: input.model || null,
      ts: Date.now(),
    };
    if (effort) out.effort = effort;
    if (rl) out.rate_limits = rl;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, target);
  }
} catch {
  /* never break the status line */
}
