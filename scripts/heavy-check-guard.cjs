'use strict';
// PreToolUse(Bash): тяжёлые команды из heavyCommands запрещены субагентам.
const { deny, run } = require('./lib/hook-io.cjs');
const { load } = require('./lib/config.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'heavy-check-guard.cjs: хук PreToolUse(Bash). Запрещает команды, подходящие под регэксп из heavyCommands, ' +
      'если вызывает субагент (agent_id во входе). heavyGuard.requireLeadEnv=true: ещё и без ORC_ROLE=lead. ' +
      'Нет конфига проекта - разрешено всё.',
  );
  process.exit(0);
}

run((input) => {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return;
  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string') return;

  const cfg = load(input.cwd);
  const patterns = Array.isArray(cfg.heavyCommands) ? cfg.heavyCommands : [];
  const heavy = patterns.some((p) => {
    try {
      return new RegExp(p).test(command);
    } catch {
      return false;
    }
  });
  if (!heavy) return;

  if (input.agent_id) return deny('тяжёлые проверки запускает только лид.');
  if (cfg.heavyGuard && cfg.heavyGuard.requireLeadEnv && process.env.ORC_ROLE !== 'lead') {
    return deny('тяжёлые проверки запускает только лид (нет ORC_ROLE=lead).');
  }
});
