'use strict';
// Shared by context-guard.cjs and setup.cjs: the lead's context numbers, the thresholds and the sticky handoff flag.
// The ctx file is written by statusline.cjs: <project root>/.claude/ctx-<session_id>.json (the file ctx.cjs prints).
// The flag file <tmp>/ghorc-<user>/handoff-<session_id>.json is the one sticky "handoff is due" flag of a session. It is
// written when the context first reaches ctxHandoff or, with handoff.stickyOnCompact, when the session is compacted
// (SessionStart, source compact). With stickyOnCompact token numbers never clear it; only HANDOFF.md with `status: SENT`
// and this session as `old_session_id` does. A new session id after /clear has no flag.
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

// { found, bad, ageMs, tokens, size }: tokens = input + cache creation + cache read of the last request (null when the
// file has no current_usage yet), size = context window size or null. bad = the file exists but is not valid JSON
// (found stays true, so the message can say "found, bad JSON" instead of "no ctx file").
function readCtx(root, sid, now = Date.now()) {
  const none = { found: false, bad: false, ageMs: Infinity, tokens: null, size: null };
  let st;
  const file = path.join(root, '.claude', `ctx-${safeId(sid)}.json`);
  try {
    st = fs.statSync(file);
  } catch {
    return none;
  }
  const ageMs = Math.max(0, now - st.mtimeMs);
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const u = d && d.current_usage;
    const tokens = u && typeof u === 'object' ? num(u.input_tokens, 0) + num(u.cache_creation_input_tokens, 0) + num(u.cache_read_input_tokens, 0) : null;
    return { found: true, bad: false, ageMs, tokens, size: num(d && d.context_window_size, null) };
  } catch {
    return { found: true, bad: true, ageMs, tokens: null, size: null };
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

// { ts, tokens, compacted?, compactedAt? } or null.
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

function deleteFlag(sid) {
  try {
    fs.rmSync(flagFile(sid), { force: true });
  } catch {
    /* a flag that cannot be removed stays: fail-safe for the handoff, harmless otherwise */
  }
}

// A compaction of this session (handoff.stickyOnCompact on): the flag is written (or kept) and marked compacted, so
// messages drop the token numbers. A flag that already existed came from crossing ctxHandoff and stays `crossed`; a flag
// made here is compaction-only (`crossed` absent) and is enforced for a session with GHORC_ROLE=lead only. `lead` records
// whether the session had that role, for the wording of ctx.cjs.
function markCompacted(sid, now = Date.now(), lead = false) {
  const flag = readFlag(sid);
  if (!flag) return writeFlag(sid, { ts: now, tokens: 0, compacted: true, compactedAt: now, lead });
  return writeFlag(sid, { ...flag, crossed: flag.compacted ? flag.crossed : true, compacted: true, compactedAt: flag.compactedAt || now, lead: Boolean(flag.lead || lead) });
}

// true for a flag that only a compaction wrote (not the token crossing).
const compactOnly = (flag) => Boolean(flag && flag.compacted && !flag.crossed);

// The header of a handoff file with markdown noise removed (bold, backticks, a BOM): `**status:** SENT` reads like
// `status: SENT`.
const headerText = (text) => text.replace(/^\uFEFF/, '').replace(/[*`]/g, '');

// true when the handoff file says `status: SENT` and its `old_session_id` is this session: the old lead has handed the
// shift over and must be allowed to go idle (the new lead waits for that to close the old tab). A SENT file of an
// earlier handoff (another old_session_id) does not count. BOM-, CRLF- and markdown-tolerant (`**status:** SENT`,
// `id`, a trailing comma); the id must equal the full session id. Fail-open (false).
function handoffSentBy(file, sid) {
  try {
    const text = headerText(fs.readFileSync(file, 'utf8'));
    // the header comes first (fields may share a line): only the FIRST `status:` counts, prose further down does not
    const status = /(^|\s)status:\s*(\w+)/im.exec(text);
    if (!status || status[2].toUpperCase() !== 'SENT') return false;
    const old = /(^|\s)old_session_id:\s*(\S+)/im.exec(text);
    return Boolean(old) && old[2].replace(/[,;.]+$/, '') === String(sid);
  } catch {
    return false;
  }
}

const NOT_BRANCH = new Set(['main', 'master']); // the default branch is never required to be pushed by the guard
const QUALIFIER = /^(base|target|default|parent|source|merge|upstream|main|trunk|origin|remote|integration)$/i;
const NAME = /^\w[\w./-]*$/;
const clean = (t) => t.replace(/^["'(\[]+|["')\].,;:]+$/g, '');

// Branch names listed in the STATE file section `in_flight` as `branch: <name>` or `branches: a, b`. Only a field that
// starts an item counts (line start, after a bullet, a comma or semicolon, a backtick or bold, or after a plain word
// that is not a qualifier such as base/target/default/merge): `base branch: main` does not, and neither do main/master.
// The section ends at the next heading of the same or a higher level (a `###` inside it stays in it). Names may be
// quoted, bold or in backticks; a placeholder such as <name> and prose are ignored. null when the file or the section is missing, [] when the section names none.
function inFlightBranches(stateFile) {
  let text;
  try {
    text = fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  let level = 0;
  const start = lines.findIndex((l) => {
    const m = /^(#{1,6})\s*in_flight\b/i.exec(l);
    if (m) level = m[1].length;
    return Boolean(m);
  });
  if (start < 0) return null;
  const out = [];
  const add = (raw) => {
    const name = clean(raw);
    if (NAME.test(name) && !NOT_BRANCH.has(name) && !out.includes(name)) out.push(name);
  };
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s/.exec(lines[i]);
    if (h && h[1].length <= level) break;
    const line = lines[i];
    // every field start on the line: group 1 is the prefix, 2 the word, 3 is set for `branches`
    const re = /(^[\s>*+\-`]*|[,;]\s*[*`]*|[\s(][*`]*)(branch(es)?)\s*[:=]/gi;
    const fields = [];
    let m;
    while ((m = re.exec(line))) fields.push({ from: m.index, at: m.index + m[1].length, end: m.index + m[0].length, plural: Boolean(m[3]) });
    for (let f = 0; f < fields.length; f++) {
      const fld = fields[f];
      // a qualifier counts only when whitespace alone separates it from `branch` (`base branch: main`), not after a comma
      const q = /(\w+)\s+$/.exec(line.slice(0, fld.at));
      if (q && QUALIFIER.test(q[1])) continue;
      // the value runs to the next field or a semicolon
      let value = line.slice(fld.end, f + 1 < fields.length ? fields[f + 1].from : line.length);
      const semi = value.indexOf(';');
      if (semi >= 0) value = value.slice(0, semi);
      const toks = value.replace(/[*`]/g, '').split(/[,\s]+/).filter(Boolean);
      if (!fld.plural) {
        if (toks.length) add(toks[0]);
        continue;
      }
      for (let k = 0; k < toks.length; k++) {
        // a list ends at a key (`worktree D:\p`, `out: x.md`) or a parenthesis
        if (/[:=]/.test(toks[k]) || /^\(/.test(toks[k]) || (toks[k + 1] && /[:=]/.test(toks[k + 1]))) break;
        add(toks[k]);
      }
    }
  }
  return out;
}

module.exports = { STALE_MS, handoffSentBy, inFlightBranches, thresholds, stageOf, readCtx, newestWindowSize, flagFile, readFlag, writeFlag, deleteFlag, markCompacted, compactOnly, safeId };
