'use strict';
// PreToolUse(Read): повторные чтения, PDF без pages, большие картинки, медиа у лида.
// PostToolUse(Edit|Write|NotebookEdit|Bash|PowerShell): сброс счётчика повторов.
const fs = require('node:fs');
const path = require('node:path');
const { deny, readState, writeState, run } = require('./lib/hook-io.cjs');
const { load } = require('./lib/config.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'read-guard.cjs: хук Claude Code. Вход: JSON события на stdin. ' +
      'PreToolUse(Read) может вернуть deny; PostToolUse(Edit|Write|NotebookEdit|Bash|PowerShell) сбрасывает счётчик повторов ' +
      '(Bash и PowerShell - только если команда упоминает читаемый файл). Повтор - полностью одинаковый вызов: ' +
      'путь, offset, limit, pages. Настройки: readGuard.* в <проект>/.claude/ghorc.json.',
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
      // Любая команда не сбрасывает всё: только если она упоминает читаемый файл.
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
    return deny('лид не читает медиа; отдай роли media.');
  }
  if (isPdf && !ti.pages) {
    return deny(
      isMediaRole
        ? 'PDF без pages не читать: сначала pdftotext или pdftoppm, затем читай по страницам (pages).'
        : 'PDF без pages не читать: сделай pdftotext/pdftoppm или укажи pages, лучше отдай роли media.',
    );
  }
  if (isImage) {
    let size = 0;
    try {
      size = fs.statSync(path.resolve(input.cwd || process.cwd(), file)).size;
    } catch {
      /* нет файла - пусть Read сам скажет */
    }
    if (size > maxImage) {
      return deny(
        `картинка ${size} байт больше лимита ${maxImage}: уменьши (pdftoppm -r, resize)` +
          (isMediaRole ? '.' : ' или отдай роли media.'),
      );
    }
  }

  if (!sid) return; // без session_id общего состояния не заводим
  const key = [abs, ti.offset ?? '', ti.limit ?? '', ti.pages ?? ''].join('|');
  const st = readState(sid, stateName);
  if (st.key === key) {
    if (st.count >= maxRepeat) {
      return deny(
        `тот же вызов Read повторён ${st.count} раз подряд без правок: не перечитывай, используй уже полученное или сначала измени файл (Edit/Write).`,
      );
    }
    writeState(sid, stateName, { key, path: abs, count: st.count + 1 });
  } else {
    writeState(sid, stateName, { key, path: abs, count: 1 });
  }
});
