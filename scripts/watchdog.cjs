'use strict';
// Сторож транскриптов: опрос ~/.claude/projects/**/*.jsonl. Только уведомляет, ничего не убивает.
// Пороги по STRATEGY §10: рост >10 МиБ/мин две минуты подряд; >100 МиБ; >250 МиБ и рост; subagents/*.jsonl >500 МиБ.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    [
      'watchdog.cjs [--interval <сек, 30>] [--rateMiBPerMin 10] [--streakSec 120] [--warnMiB 100] [--stopMiB 250]',
      '             [--subagentsMiB 500] [--root <каталог, по умолчанию ~/.claude/projects>] [--once] [--notify "<команда>"]',
      'Тревоги: рост выше rateMiBPerMin непрерывно streakSec секунд; размер выше warnMiB (проверить содержимое);',
      'выше stopMiB и всё ещё растёт; файл в subagents/ выше subagentsMiB.',
      '--notify: команда запускается через шелл (.cmd/.bat работают) в фоне, таймер 10 с; текст тревоги - ОДИН аргумент в кавычках (и переменная GHORC_ALERT).',
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
const streakMs = Number(opt('--streakSec', 120)) * 1000;
const warnMiB = Number(opt('--warnMiB', 100));
const stopMiB = Number(opt('--stopMiB', 250));
const subMiB = Number(opt('--subagentsMiB', 500));
const root = opt('--root', path.join(os.homedir(), '.claude', 'projects'));
const once = args.includes('--once');
const notify = opt('--notify', null);
const MiB = 1024 * 1024;

// Один аргумент для шелла: Windows - двойные кавычки, иначе одинарные.
function quoteArg(s) {
  if (process.platform === 'win32') return '"' + String(s).replace(/"/g, '\\"') + '"';
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

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
  console.log(`[ghorc watchdog] ${text}`);
  if (!notify) return;
  // Через шелл (работают .cmd/.bat); не ждём завершения, убиваем через 10 с.
  try {
    const child = spawn(`${notify} ${quoteArg(text)}`, {
      shell: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, GHORC_ALERT: text },
    });
    child.on('error', (e) => console.log(`[ghorc watchdog] notify не запустился: ${e.message}`));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* уже завершился */
      }
    }, 10000);
    timer.unref();
    child.on('exit', () => clearTimeout(timer));
  } catch {
    /* уведомление необязательно */
  }
}

const prev = new Map(); // path -> { size, t, fastSince, streakAlerted, warned, stopped, subAlerted }

function pass() {
  const now = Date.now();
  const files = walk(root, []);
  const live = new Set(files);
  for (const k of [...prev.keys()]) if (!live.has(k)) prev.delete(k);

  for (const p of files) {
    let size;
    try {
      size = fs.statSync(p).size;
    } catch {
      continue;
    }
    const first = !prev.has(p);
    const st = prev.get(p) || { size, t: now, fastSince: null, streakAlerted: false, warned: false, stopped: false, subAlerted: false };
    const dtMin = (now - st.t) / 60000;
    const delta = size - st.size;
    const rate = dtMin > 0 ? delta / MiB / dtMin : 0;
    const info = `${p} size=${(size / MiB).toFixed(1)}MiB rate=${rate.toFixed(1)}MiB/min`;

    if (!first) {
      if (rate > rateMiB) {
        if (st.fastSince === null) st.fastSince = st.t;
        if (!st.streakAlerted && now - st.fastSince >= streakMs) {
          alert(`рост выше ${rateMiB} MiB/мин дольше ${streakMs / 1000} с: ${info}`);
          st.streakAlerted = true;
        }
      } else {
        st.fastSince = null;
        st.streakAlerted = false;
      }
      if (size > stopMiB * MiB && delta > 0 && !st.stopped) {
        alert(`ТРЕВОГА, больше ${stopMiB} MiB и растёт: ${info}`);
        st.stopped = true;
      }
    }
    if (size > warnMiB * MiB && !st.warned) {
      alert(`больше ${warnMiB} MiB, проверь характер содержимого: ${info}`);
      st.warned = true;
    }
    if (size > subMiB * MiB && /[\\/]subagents[\\/]/.test(p) && !st.subAlerted) {
      alert(`ТРЕВОГА, файл субагента больше ${subMiB} MiB: ${info}`);
      st.subAlerted = true;
    }
    st.size = size;
    st.t = now;
    prev.set(p, st);
  }
}

pass();
if (!once) setInterval(pass, Math.max(1, interval) * 1000);
