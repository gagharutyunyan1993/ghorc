'use strict';
// PreToolUse(Bash|PowerShell): heavy commands from heavyCommands are denied to subagents and workers.
const { deny, run } = require('./lib/hook-io.cjs');
const { load } = require('./lib/config.cjs');
const { BUILTIN_SUBAGENT_DENY, DEFAULT_HEAVY, matches, compile } = require('./lib/cmd.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'heavy-check-guard.cjs: PreToolUse(Bash|PowerShell) hook. Denies commands matching a regex from heavyCommands ' +
      'when a subagent (agent_id) or a worker (GHORC_ROLE=worker) calls them. Matching is per command segment ' +
      '(split on && || ; | & newline ( ) { } $( and backticks; quoted text ignored except a shell wrapper argument such as ' +
      'bash -c "..." / cmd /c / powershell -Command and substitutions in double quotes), anchored at the segment start after ' +
      'env assignments, shell wrappers, npm global options and npm run/npx. ' +
      'Built in for subagents and workers: claude -p/--print, herdr agent start, herdr agent prompt (also with an invalid config). ' +
      'heavyGuard.requireLeadEnv=true: also denies without GHORC_ROLE=lead. ' +
      'An invalid project config makes it deny the built-in default heavy commands, with the reason. No project config: nothing is denied.',
  );
  process.exit(0);
}

run((input) => {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return;
  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string') return;

  const cfg = load(input.cwd);
  const configured = compile(Array.isArray(cfg.heavyCommands) ? cfg.heavyCommands : []);

  // the built-in agent-start denies apply to subagents and workers only, also while the config is invalid
  const sub = Boolean(input.agent_id) || process.env.GHORC_ROLE === 'worker';
  if (sub && matches(command, BUILTIN_SUBAGENT_DENY)) {
    return deny('subagents and workers may not start other agents (claude -p, herdr agent start/prompt): ask the lead.');
  }

  if (cfg.invalid) {
    if (matches(command, [...configured, ...DEFAULT_HEAVY])) {
      return deny(`config invalid: ${cfg.invalid}. Heavy-command rules cannot be trusted: fix .claude/ghorc.json (node scripts/check-config.cjs).`);
    }
    return;
  }
  if (!matches(command, configured)) return;

  if (sub) return deny('only the lead runs heavy checks.');
  if (cfg.heavyGuard && cfg.heavyGuard.requireLeadEnv && process.env.GHORC_ROLE !== 'lead') {
    return deny('only the lead runs heavy checks (GHORC_ROLE=lead is not set).');
  }
});
