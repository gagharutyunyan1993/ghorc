'use strict';
// node scripts/check-config.cjs [--cwd <каталог>] [--sample "<команда>"]...
const { check } = require('./lib/validate.cjs');
const { load } = require('./lib/config.cjs');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'check-config.cjs [--cwd <каталог>] [--sample "<команда>"]: проверяет .claude/ghorc.json (JSON, ключи, типы, ' +
      'компиляция heavyCommands). --sample (можно несколько раз) показывает, какие шаблоны срабатывают на команду. ' +
      'Код выхода 1 при ошибках.',
  );
  process.exit(0);
}
const cwd = args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : process.cwd();
const samples = args.flatMap((a, i) => (a === '--sample' && args[i + 1] !== undefined ? [args[i + 1]] : []));

const { path: file, problems } = check(cwd);
console.log(file ? `конфиг: ${file}` : 'конфиг не найден (используются значения по умолчанию)');
for (const p of problems) console.log(`ОШИБКА: ${p}`);

const patterns = (load(cwd).heavyCommands || []).filter((p) => typeof p === 'string');
for (const s of samples) {
  const hit = patterns.filter((p) => {
    try {
      return new RegExp(p, 'i').test(s);
    } catch {
      return false;
    }
  });
  console.log(`образец "${s}": ${hit.length ? 'ТЯЖЁЛАЯ (' + hit.join(' ; ') + ')' : 'обычная'}`);
}
if (!problems.length) console.log('ошибок нет');
process.exit(problems.length ? 1 : 0);
