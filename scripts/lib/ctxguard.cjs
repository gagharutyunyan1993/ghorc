'use strict';
// Shared by context-guard.cjs and setup.cjs: the lead's context numbers, the thresholds and the sticky handoff flag.
// The ctx file is written by statusline.cjs: <project root>/.claude/ctx-<session_id>.json (the file ctx.cjs prints).
// The flag file <tmp>/ghorc-<user>/handoff-<session_id>.json is written when the context first reaches ctxHandoff and is
// never removed by the hooks (compaction does not clear it; a new session id after /clear has no flag).
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, atomicWrite } = require('./tmp.cjs');

const STALE_MS = 10 * 60 * 1000; // an older ctx file is not trusted (fail-open)

const safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]/g, '_');

function num(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

// { prepare, warn, handoff } in tokens. thresholds.ctxWarn 0 (the default) means ctxHandoff - 10000.
function thresholds(cfg) {
  const t = (cfg && cfg.thresholds) || {};
  const handoff = num(t.ctxHandoff, 150000);
  const prepare = num(t.ctxPrepare, 120000);
  const w = num(t.ctxWarn, 0);
  const warn = w > 0 ? Math.min(w, handoff) : Math.max(handoff - 10000, 0);
  return { prepare, warn, handoff };
}

// 'ok' | 'prepare' | 'warn' | 'drain' by tokens.
function stageOf(tokens, th) {
  if (tokens >= th.handoff) return 'drain';
  if (tokens >= th.warn) return 'warn';
  if (tokens >= th.prepare) return 'prepare';
  return 'ok';
}

// { found, ageMs, tokens, size }: tokens = input + cache creation + cache read of the last request (null when the file
// has no current_usage yet), size = context window size or null.
function readCtx(root, sid, now = Date.now()) {
  const none = { found: false, ageMs: Infinity, tokens: null, size: null };
  try {
    const file = path.join(root, '.claude', `ctx-${safeId(sid)}.json`);
    const st = fs.statSync(file);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const u = d && d.current_usage;
    const tokens = u && typeof u === 'object' ? num(u.input_tokens, 0) + num(u.cache_creation_input_tokens, 0) + num(u.cache_read_input_tokens, 0) : null;
    return { found: true, ageMs: Math.max(0, now - st.mtimeMs), tokens, size: num(d && d.context_window_size, null) };
  } catch {
    return none;
  }
}

// The context window size of the newest ctx file under <root>/.claude that has one, else null (used by setup.cjs).
function newestWindowSize(root) {
  try {
    const dir = path.join(root, '.claude');
    const rows = fs
      .readdirSync(dir)
      .filter((f) => /^ctx-.*\.json$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const r of rows) {
      try {
        const s = num(JSON.parse(fs.readFileSync(path.join(dir, r.f), 'utf8')).context_window_size, 0);
        if (s > 0) return s;
      } catch {
        /* a broken file */
      }
    }
  } catch {
    /* no directory */
  }
  return null;
}

const flagFile = (sid) => path.join(tmpDir(), `handoff-${safeId(sid).slice(0, 80)}.json`);

// { ts, tokens, stopBlocks } or null.
function readFlag(sid) {
  try {
    const j = JSON.parse(fs.readFileSync(flagFile(sid), 'utf8'));
    return j && typeof j === 'object' && Number.isFinite(j.ts) ? j : null;
  } catch {
    return null;
  }
}

function writeFlag(sid, flag) {
  try {
    fs.mkdirSync(tmpDir(), { recursive: true });
    atomicWrite(flagFile(sid), JSON.stringify(flag));
  } catch {
    /* without the file the flag lives for this call only: fail-open */
  }
  return flag;
}

// true when the handoff file says `status: SENT` and its `old_session_id` is this session: the old lead has handed the
// shift over and must be allowed to go idle (the new lead waits for that to close the old tab). A SENT file of an
// earlier handoff (another old_session_id) does not count. BOM-tolerant; fail-open (false).
function handoffSentBy(file, sid) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!/(^|\s)status:\s*SENT\b/im.test(text)) return false;
    const old = /(^|\s)old_session_id:\s*(\S+)/im.exec(text);
    return Boolean(old) && old[2] === String(sid);
  } catch {
    return false;
  }
}

module.exports = { STALE_MS, handoffSentBy, thresholds, stageOf, readCtx, newestWindowSize, flagFile, readFlag, writeFlag, safeId };
