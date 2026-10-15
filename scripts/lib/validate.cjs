'use strict';
// Проверка ghorc.json: JSON, известные ключи, типы, компиляция регэкспов.
const fs = require('node:fs');
const { findConfig, readJson, TEMPLATE } = require('./config.cjs');

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typeOf(v) {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}

// Возвращает { path, problems: string[] }. path=null - файла нет (не ошибка).
function check(cwd) {
  const file = findConfig(cwd);
  if (!file) return { path: null, problems: [] };
  const problems = [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { path: file, problems: [`невалидный JSON: ${e.message}`] };
  }
  if (!isObj(data)) return { path: file, problems: ['корень должен быть объектом'] };
  const tpl = readJson(TEMPLATE) || {};

  for (const key of Object.keys(data)) {
    if (key.startsWith('_comment')) continue;
    if (!(key in tpl)) {
      problems.push(`неизвестный ключ: ${key}`);
      continue;
    }
    const want = typeOf(tpl[key]);
    if (typeOf(data[key]) !== want) {
      problems.push(`${key}: ожидался ${want}, получен ${typeOf(data[key])}`);
      continue;
    }
    if (isObj(tpl[key])) {
      for (const sub of Object.keys(data[key])) {
        if (sub.startsWith('_comment')) continue;
        if (!(sub in tpl[key])) problems.push(`неизвестный ключ: ${key}.${sub}`);
        else if (typeOf(data[key][sub]) !== typeOf(tpl[key][sub])) {
          problems.push(`${key}.${sub}: ожидался ${typeOf(tpl[key][sub])}, получен ${typeOf(data[key][sub])}`);
        }
      }
    }
  }
  if (Array.isArray(data.heavyCommands)) {
    data.heavyCommands.forEach((p, i) => {
      if (typeof p !== 'string') return problems.push(`heavyCommands[${i}]: не строка`);
      if (p === '') return problems.push(`heavyCommands[${i}]: пустой шаблон совпадает со всем`);
      try {
        new RegExp(p, 'i');
      } catch (e) {
        problems.push(`heavyCommands[${i}]: регэксп не компилируется (${e.message})`);
      }
    });
  }
  return { path: file, problems };
}

module.exports = { check };
