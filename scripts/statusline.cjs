'use strict';
// statusLine: одна строка + файл <cwd>/.claude/ctx-<session_id>.json для лида.
const fs = require('node:fs');
const path = require('node:path');

if (process.argv.includes('--help')) {
  console.log(
    'statusline.cjs: команда statusLine. Читает JSON со stdin, печатает "model | ctx NN% (used/size) | $cost" ' +
      'и пишет <cwd>/.claude/ctx-<session_id>.json. См. README про настройку statusLine в settings.',
  );
  process.exit(0);
}

function fmt(n) {
  if (typeof n !== 'number') return '?';
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8')) || {};
} catch {
  /* пустой ввод */
}

const cw = input.context_window || {};
const usage = cw.current_usage || null;
const used = usage
  ? (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  : null;
const size = cw.context_window_size;
const pct = typeof cw.used_percentage === 'number' ? cw.used_percentage : null;
const model = (input.model && (input.model.display_name || input.model.id)) || 'model?';
const cost = input.cost && typeof input.cost.total_cost_usd === 'number' ? input.cost.total_cost_usd : null;

const parts = [model];
parts.push(pct === null ? 'ctx --' : `ctx ${Math.round(pct)}% (${fmt(used)}/${fmt(size)})`);
parts.push(cost === null ? '$--' : `$${cost.toFixed(2)}`);
process.stdout.write(parts.join(' | ') + '\n');

try {
  const sid = input.session_id;
  const cwd = input.cwd || (input.workspace && input.workspace.current_dir);
  if (sid && cwd) {
    const dir = path.join(cwd, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `ctx-${String(sid).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`),
      JSON.stringify({
        session_id: sid,
        used_percentage: pct,
        current_usage: usage,
        context_window_size: size === undefined ? null : size,
        model: input.model || null,
        ts: Date.now(),
      }),
    );
  }
} catch {
  /* не мешаем строке состояния */
}
