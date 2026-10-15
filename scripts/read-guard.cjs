'use strict';
// PreToolUse(Read): повторные чтения, PDF без pages, большие картинки, медиа у лида.
// PostToolUse(Edit|Write|Bash): сброс счётчика повторов.
const fs = require('node:fs');
const path = require('node:path');
const { deny, readState, writeState, run } = require('./lib/hook-io.cjs');
const { load } = require('./lib/config.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'read-guard.cjs: хук Claude Code. Вход: JSON события на stdin. ' +
      'PreToolUse(Read) может вернуть deny; PostToolUse(Edit|Write|Bash) сбрасывает счётчик повторов. ' +
      'Настройки: readGuard.* в <проект>/.claude/orc-kit.json.',
  );
  process.exit(0);
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

run((input) => {
  const sid = input.session_id;
  const agentKey = input.agent_id ? String(input.agent_id) : 'main';
  const stateName = `read-${agentKey.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;

  if (input.hook_event_name === 'PostToolUse') {
    if (['Edit', 'Write', 'Bash'].includes(input.tool_name)) writeState(sid, stateName, {});
    return;
  }
  if (input.tool_name !== 'Read') return;

  const file = input.tool_input && input.tool_input.file_path;
  if (!file || typeof file !== 'string') return;

  const cfg = load(input.cwd).readGuard || {};
  const maxRepeat = Number.isFinite(cfg.maxRepeat) ? cfg.maxRepeat : 3;
  const maxImage = Number.isFinite(cfg.maxImageBytes) ? cfg.maxImageBytes : 2097152;
  const leadNoMedia = cfg.leadNoMedia !== false;

  const ext = path.extname(file).toLowerCase();
  const isPdf = ext === '.pdf';
  const isImage = IMAGE_EXT.has(ext);

  if (leadNoMedia && !input.agent_id && (isPdf || isImage)) {
    return deny('лид не читает медиа; отдай роли media (путь к файлу в брифе).');
  }
  if (isPdf && !(input.tool_input && input.tool_input.pages)) {
    return deny('PDF без pages не читать: сделай pdftotext/pdftoppm или укажи pages, лучше отдай роли media.');
  }
  if (isImage) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* нет файла - пусть Read сам скажет */
    }
    if (size > maxImage) {
      return deny(`картинка ${size} байт больше лимита ${maxImage}: уменьши (pdftoppm -r, resize) или отдай роли media.`);
    }
  }

  const st = readState(sid, stateName);
  if (st.path === file) {
    if (st.count >= maxRepeat) {
      return deny(
        `тот же файл прочитан ${st.count} раз подряд без правок: не перечитывай, используй уже полученное или сделай Edit/Write/Bash.`,
      );
    }
    writeState(sid, stateName, { path: file, count: st.count + 1 });
  } else {
    writeState(sid, stateName, { path: file, count: 1 });
  }
});
