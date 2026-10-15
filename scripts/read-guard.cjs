'use strict';
// PreToolUse(Read, MCP screenshot/snapshot tools): per-path read counts, PDF page and image byte budgets, media roles.
// PostToolUse(Edit|Write|NotebookEdit): resets the counter of the edited path only.
const fs = require('node:fs');
const path = require('node:path');
const { deny, readState, writeState, run } = require('./lib/hook-io.cjs');
const { load } = require('./lib/config.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'read-guard.cjs: Claude Code hook. Input: the event JSON on stdin. ' +
      'PreToolUse(Read) may return deny: more than readGuard.maxRepeat reads of one path (offset, limit and pages do not matter), ' +
      'a PDF without pages, a PDF/image read by a non-media subagent (readGuard.mediaRoles) or by the lead, ' +
      'PDF pages above pdfPageBudget, image bytes above mediaByteBudget. MCP screenshot/snapshot/read_page tools count toward ' +
      'readGuard.maxScreenshots. PostToolUse(Edit|Write|NotebookEdit) resets the counter of the edited path only. ' +
      'Settings: readGuard.* in <project>/.claude/ghorc.json.',
  );
  process.exit(0);
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const MCP_READ = /^mcp__.*(screenshot|snapshot|read_page)/i;

// Same file, same key: resolved, and lower-cased on Windows.
function keyOf(cwd, file) {
  const p = path.resolve(cwd || process.cwd(), file);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// "1-5" -> 5, "3" -> 1, "2,4-6" -> 4; anything unreadable counts as 1.
function countPages(spec) {
  let n = 0;
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    n += m ? Math.max(1, Number(m[2]) - Number(m[1]) + 1) : 1;
  }
  return n || 1;
}

const sum = (map, field) => Object.values(map).reduce((a, e) => a + (Number(e && e[field]) || 0), 0);

function num(v, def) {
  return Number.isFinite(v) ? v : def;
}

run((input) => {
  const sid = input.session_id;
  const agentKey = input.agent_id ? String(input.agent_id) : 'main';
  const stateName = `read-${agentKey.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;

  if (input.hook_event_name === 'PostToolUse') {
    if (!sid || !EDIT_TOOLS.includes(input.tool_name)) return;
    const ti = input.tool_input || {};
    const file = ti.file_path || ti.notebook_path;
    if (!file || typeof file !== 'string') return;
    const st = readState(sid, stateName);
    const key = keyOf(input.cwd, file);
    if (st.byPath && st.byPath[key]) {
      delete st.byPath[key];
      writeState(sid, stateName, st);
    }
    return;
  }

  const cfg = load(input.cwd).readGuard || {};

  if (MCP_READ.test(String(input.tool_name || ''))) {
    if (!sid) return;
    const max = num(cfg.maxScreenshots, 60);
    const st = readState(sid, stateName);
    const n = (Number(st.screenshots) || 0) + 1;
    if (n > max) {
      return deny(`more than ${max} screenshot/snapshot calls in this session: stop capturing, work from what you have or ask the lead.`);
    }
    writeState(sid, stateName, { ...st, screenshots: n });
    return;
  }

  if (input.tool_name !== 'Read') return;
  const ti = input.tool_input || {};
  const file = ti.file_path;
  if (!file || typeof file !== 'string') return;

  const maxRepeat = num(cfg.maxRepeat, 3);
  const maxImage = num(cfg.maxImageBytes, 2097152);
  const pdfBudget = num(cfg.pdfPageBudget, 60);
  const mediaBudget = num(cfg.mediaByteBudget, 8 * 1024 * 1024);
  const leadNoMedia = cfg.leadNoMedia !== false;
  const mediaRoles = Array.isArray(cfg.mediaRoles) ? cfg.mediaRoles.map(String) : ['ghorc:media', 'media'];

  const abs = keyOf(input.cwd, file);
  const ext = path.extname(abs).toLowerCase();
  const isPdf = ext === '.pdf';
  const isImage = IMAGE_EXT.has(ext);
  const isMedia = isPdf || isImage;
  const isMediaRole = mediaRoles.includes(String(input.agent_type || ''));

  if (isMedia) {
    if (input.agent_id) {
      if (!isMediaRole) return deny('media is read by the media role: hand this file to ghorc:media.');
    } else if (leadNoMedia && process.env.GHORC_ROLE !== 'worker') {
      return deny('the lead does not read media (a main session without GHORC_ROLE=worker counts as the lead): hand it to the media role.');
    }
  }
  if (isPdf && !ti.pages) {
    return deny(
      isMediaRole
        ? 'Do not read a PDF without pages: run pdftotext or pdftoppm first, then read by page (pages).'
        : 'Do not read a PDF without pages: run pdftotext/pdftoppm or set pages, or better hand it to the media role.',
    );
  }
  let bytes = 0;
  if (isImage) {
    try {
      bytes = fs.statSync(path.resolve(input.cwd || process.cwd(), file)).size;
    } catch {
      /* unreadable: it still counts as a read below, it is never exempt */
    }
    if (bytes > maxImage) {
      return deny(
        `image of ${bytes} bytes exceeds the limit ${maxImage}: shrink it (pdftoppm -r, resize)` +
          (isMediaRole ? '.' : ' or hand it to the media role.'),
      );
    }
  }

  if (!sid) return; // without session_id we keep no shared state
  const st = readState(sid, stateName);
  const byPath = st.byPath && typeof st.byPath === 'object' && !Array.isArray(st.byPath) ? st.byPath : {};
  const e = byPath[abs] || { reads: 0, bytes: 0, pages: 0 };
  const pages = isPdf ? countPages(ti.pages) : 0;

  if (e.reads + 1 > maxRepeat) {
    return deny(`${path.basename(abs)} was already read ${e.reads} times: do not re-read it, use what you have or edit it first.`);
  }
  if (isPdf && sum(byPath, 'pages') + pages > pdfBudget) {
    return deny(`PDF page budget of ${pdfBudget} pages is used up: stop reading PDFs, report what you have.`);
  }
  if (isImage && sum(byPath, 'bytes') + bytes > mediaBudget) {
    return deny(`image byte budget of ${mediaBudget} is used up: stop reading images, report what you have.`);
  }
  byPath[abs] = { reads: e.reads + 1, bytes: (e.bytes || 0) + bytes, pages: (e.pages || 0) + pages };
  writeState(sid, stateName, { ...st, byPath });
});
