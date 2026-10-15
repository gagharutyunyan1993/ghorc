'use strict';
// Печатает файлы <cwd>/.claude/ctx-*.json, новые первыми; самый новый помечен *.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('ctx.cjs [--max-age <минуты>] [--cwd <каталог>]: показывает контекст сессий из .claude/ctx-*.json.');
  process.exit(0);
}
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const maxAge = opt('--max-age') !== undefined ? Number(opt('--max-age')) : Infinity;
const dir = path.join(opt('--cwd') || process.cwd(), '.claude');

let rows = [];
try {
  rows = fs
    .readdirSync(dir)
    .filter((f) => /^ctx-.*\.json$/.test(f))
    .map((f) => {
      const p = path.join(dir, f);
      const mtime = fs.statSync(p).mtimeMs;
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* битый файл */
      }
      return { f, mtime, data, age: Math.round((Date.now() - mtime) / 60000) };
    })
    .filter((r) => r.age <= maxAge)
    .sort((a, b) => b.mtime - a.mtime);
} catch {
  /* нет каталога */
}

if (!rows.length) console.log('нет файлов ctx-*.json (статус-строка не настроена или сессия не писала)');
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
process.exit(0);
