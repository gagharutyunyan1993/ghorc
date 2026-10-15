'use strict';
// PreToolUse(Bash): heavy commands from heavyCommands are denied to subagents.
const { deny, run } = require('./lib/hook-io.cjs');
const { load } = require('./lib/config.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'heavy-check-guard.cjs: PreToolUse(Bash) hook. Denies commands matching a regex from heavyCommands ' +
      'when a subagent calls them (agent_id in the input). heavyGuard.requireLeadEnv=true: also denies without GHORC_ROLE=lead. ' +
      'No project config: everything is allowed.',
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
      return new RegExp(p, 'i').test(command);
    } catch {
      return false;
    }
  });
  if (!heavy) return;

  if (input.agent_id) return deny('only the lead runs heavy checks.');
  if (cfg.heavyGuard && cfg.heavyGuard.requireLeadEnv && process.env.GHORC_ROLE !== 'lead') {
    return deny('only the lead runs heavy checks (GHORC_ROLE=lead is not set).');
  }
});
