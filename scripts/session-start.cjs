'use strict';
// SessionStart: короткое напоминание в контекст (stdout).
const path = require('node:path');
const { found, configPath } = require('./lib/config.cjs');
const { run } = require('./lib/hook-io.cjs');

if (process.argv.includes('--help')) {
  console.log('session-start.cjs: хук SessionStart; печатает 3 строки напоминания в контекст.');
  process.exit(0);
}

run((input) => {
  let version = '?';
  try {
    version = require(path.join(__dirname, '..', '.claude-plugin', 'plugin.json')).version;
  } catch {
    /* версия необязательна */
  }
  const cwd = input.cwd || process.cwd();
  const cfg = found(cwd)
    ? `конфиг: ${configPath(cwd)}`
    : 'конфиг не найден - скопируй templates/orc-kit.json в .claude/orc-kit.json';
  process.stdout.write(`orc-kit ${version}\n${cfg}\nлид: загрузи skill orc\n`);
});
