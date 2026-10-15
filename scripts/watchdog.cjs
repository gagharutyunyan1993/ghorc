'use strict';
// Сторож транскриптов: опрос ~/.claude/projects/**/*.jsonl. Только уведомляет, ничего не убивает.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    [
      'watchdog.cjs [--interval <сек, 30>] [--rateMiBPerMin 10] [--warnMiB 100] [--stopMiB 250]',
      '             [--root <каталог, по умолчанию ~/.claude/projects>] [--once] [--notify "<команда>"]',
      'Тревоги: рост выше rateMiBPerMin два интервала подряд; размер выше warnMiB; выше stopMiB и всё ещё растёт.',
      'Сторож никого не останавливает.',
    ].join('\n'),
  );
  process.exit(0);
}
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const interval = Number(opt('--interval', 30));
const rateMiB = Number(opt('--rateMiBPerMin', 10));
const warnMiB = Number(opt('--warnMiB', 100));
const stopMiB = Number(opt('--stopMiB', 250));
const root = opt('--root', path.join(os.homedir(), '.claude', 'projects'));
const once = args.includes('--once');
const notify = opt('--notify', null);
const MiB = 1024 * 1024;

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function alert(text) {
  console.log(`[orc-kit watchdog] ${text}`);
  if (notify) {
    try {
      spawn(notify, [text], { shell: true, stdio: 'ignore', detached: true }).unref();
    } catch {
      /* уведомление необязательно */
    }
  }
}

const prev = new Map(); // path -> { size, t, fastStreak, warned, stopped }

function pass() {
  const now = Date.now();
  for (const p of walk(root, [])) {
    let size;
    try {
      size = fs.statSync(p).size;
    } catch {
      continue;
    }
    const st = prev.get(p) || { size, t: now, fastStreak: 0, warned: false, stopped: false };
    const dtMin = (now - st.t) / 60000;
    const delta = size - st.size;
    const rate = dtMin > 0 ? delta / MiB / dtMin : 0;
    const growing = delta > 0;
    if (prev.has(p)) {
      st.fastStreak = rate > rateMiB ? st.fastStreak + 1 : 0;
      const info = `${p} size=${(size / MiB).toFixed(1)}MiB rate=${rate.toFixed(1)}MiB/min`;
      if (st.fastStreak === 2) alert(`быстрый рост два интервала подряд: ${info}`);
      if (size > stopMiB * MiB && growing) {
        if (!st.stopped) alert(`ТРЕВОГА, больше ${stopMiB} MiB и растёт: ${info}`);
        st.stopped = true;
      } else if (size > warnMiB * MiB && !st.warned) {
        alert(`больше ${warnMiB} MiB: ${info}`);
        st.warned = true;
      }
    } else if (once && size > warnMiB * MiB) {
      // единственный проход: нет истории роста, но размер сообщаем
      alert(`больше ${warnMiB} MiB: ${p} size=${(size / MiB).toFixed(1)}MiB`);
      if (size > stopMiB * MiB) alert(`больше ${stopMiB} MiB (рост за один проход не измерить): ${p}`);
    }
    st.size = size;
    st.t = now;
    prev.set(p, st);
  }
}

pass();
if (!once) setInterval(pass, Math.max(1, interval) * 1000);
