'use strict';
// PreToolUse(Read): repeated reads, PDFs without pages, large images, media for the lead.
// PostToolUse(Edit|Write|NotebookEdit|Bash|PowerShell): resets the repeat counter.
const fs = require('node:fs');
const path = require('node:path');
const { deny, readState, writeState, run } = require('./lib/hook-io.cjs');
const { load } = require('./lib/config.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'read-guard.cjs: Claude Code hook. Input: the event JSON on stdin. ' +
      'PreToolUse(Read) may return deny; PostToolUse(Edit|Write|NotebookEdit|Bash|PowerShell) resets the repeat counter ' +
      '(Bash and PowerShell only if the command mentions the file being read). A repeat is a fully identical call: ' +
      'path, offset, limit, pages. Settings: readGuard.* in <project>/.claude/ghorc.json.',
  );
  process.exit(0);
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];

function normPath(cwd, file) {
  const p = path.resolve(cwd || process.cwd(), file);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

run((input) => {
  const sid = input.session_id;
  const agentKey = input.agent_id ? String(input.agent_id) : 'main';
  const stateName = `read-${agentKey.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;

  if (input.hook_event_name === 'PostToolUse') {
    if (!sid) return;
    if (EDIT_TOOLS.includes(input.tool_name)) {
      writeState(sid, stateName, {});
    } else if (SHELL_TOOLS.includes(input.tool_name)) {
      // A command does not reset everything: only if it mentions the file being read.
      const st = readState(sid, stateName);
      const cmd = String((input.tool_input && input.tool_input.command) || '').toLowerCase();
      if (st.path && cmd.includes(path.basename(st.path).toLowerCase())) writeState(sid, stateName, {});
    }
    return;
  }
  if (input.tool_name !== 'Read') return;

  const ti = input.tool_input || {};
  const file = ti.file_path;
  if (!file || typeof file !== 'string') return;

  const cfg = load(input.cwd).readGuard || {};
  const maxRepeat = Number.isFinite(cfg.maxRepeat) ? cfg.maxRepeat : 3;
  const maxImage = Number.isFinite(cfg.maxImageBytes) ? cfg.maxImageBytes : 2097152;
  const leadNoMedia = cfg.leadNoMedia !== false;

  const abs = normPath(input.cwd, file);
  const ext = path.extname(abs);
  const isPdf = ext === '.pdf';
  const isImage = IMAGE_EXT.has(ext);
  const isMediaRole = /(^|:)media$/.test(String(input.agent_type || ''));

  if (leadNoMedia && !input.agent_id && (isPdf || isImage)) {
    return deny('the lead does not read media; hand it to the media role.');
  }
  if (isPdf && !ti.pages) {
    return deny(
      isMediaRole
        ? 'Do not read a PDF without pages: run pdftotext or pdftoppm first, then read by page (pages).'
        : 'Do not read a PDF without pages: run pdftotext/pdftoppm or set pages, or better hand it to the media role.',
    );
  }
  if (isImage) {
    let size = 0;
    try {
      size = fs.statSync(path.resolve(input.cwd || process.cwd(), file)).size;
    } catch {
      /* no file: let Read report it */
    }
    if (size > maxImage) {
      return deny(
        `image of ${size} bytes exceeds the limit ${maxImage}: shrink it (pdftoppm -r, resize)` +
          (isMediaRole ? '.' : ' or hand it to the media role.'),
      );
    }
  }

  if (!sid) return; // without session_id we keep no shared state
  const key = [abs, ti.offset ?? '', ti.limit ?? '', ti.pages ?? ''].join('|');
  const st = readState(sid, stateName);
  if (st.key === key) {
    if (st.count >= maxRepeat) {
      return deny(
        `the same Read call was repeated ${st.count} times in a row without edits: do not re-read, use what you already have or change the file first (Edit/Write).`,
      );
    }
    writeState(sid, stateName, { key, path: abs, count: st.count + 1 });
  } else {
    writeState(sid, stateName, { key, path: abs, count: 1 });
  }
});
