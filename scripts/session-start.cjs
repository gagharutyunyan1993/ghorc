'use strict';
// SessionStart: короткое напоминание в контекст (stdout).
const path = require('node:path');
const { found, configPath, load } = require('./lib/config.cjs');
const { check } = require('./lib/validate.cjs');
const { run } = require('./lib/hook-io.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'session-start.cjs: хук SessionStart; печатает версию, найденный конфиг и (только лиду) напоминание про skill orc. ' +
      'Лид: ORC_ROLE=lead, либо ORC_ROLE не задан и lead.remind не false. Воркеры стартуют с ORC_ROLE=worker и напоминания не получают.',
  );
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
  const lines = [`orc-kit ${version}`];
  lines.push(
    found(cwd) ? `конфиг: ${configPath(cwd)}` : 'конфиг не найден - скопируй templates/orc-kit.json в .claude/orc-kit.json',
  );
  try {
    const { problems } = check(cwd);
    if (problems.length) lines.push(`конфиг неверен: ${problems[0]}`.slice(0, 150) + ' (node scripts/check-config.cjs)');
  } catch {
    /* проверка необязательна */
  }

  const role = (process.env.ORC_ROLE || '').trim();
  const remind = load(cwd).lead;
  const isLead = !input.agent_id && (role === 'lead' || (role === '' && !(remind && remind.remind === false)));
  if (isLead) lines.push('лид: загрузи skill orc');
  process.stdout.write(lines.join('\n') + '\n');
});
