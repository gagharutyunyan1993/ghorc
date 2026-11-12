'use strict';
// PreToolUse(Bash|PowerShell): heavy commands from heavyCommands are denied to subagents and workers.
const { deny, run } = require('./lib/hook-io.cjs');
const { load } = require('./lib/config.cjs');
const { isWorker, isLead } = require('./lib/role.cjs');
const slots = require('./lib/slots.cjs');
const { BUILTIN_SUBAGENT_DENY, DEFAULT_HEAVY, matches, compile, hcSendTargets } = require('./lib/cmd.cjs');
const backend = require('./lib/backend.cjs');
const { projectRoot } = require('./lib/root.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'heavy-check-guard.cjs: PreToolUse(Bash|PowerShell) hook. Denies commands matching a regex from heavyCommands ' +
      'when a subagent (agent_id) or a worker (GHORC_ROLE=worker) calls them. Matching is per command segment ' +
      '(split on && || ; | & newline ( ) { } $( and backticks; quoted text ignored except a shell wrapper argument such as ' +
      'bash -c "..." / cmd /c / powershell -Command and substitutions in double quotes), anchored at the segment start after ' +
      'env assignments, shell wrappers, npm global options and npm run/npx. ' +
      'Built in for subagents and workers: claude -p/--print, herdr agent start/prompt/send-keys, herdr pane run/send-keys/send-text, hc run/exec/keys/interrupt (also with an invalid config; the lead may use them). ' +
      '`hc send` is denied too, except for a worker (GHORC_ROLE=worker, not a subagent) sending to its own parent terminal (`hc get $HC_TERMINAL_ID` -> parent) or to a live claude-code lead of the same project from `hc ls` (no parent, or named lead-*, cwd inside the project root or the parent\'s cwd); nothing readable means deny. ' +
      'heavyGuard.requireLeadEnv=true: also denies without GHORC_ROLE=lead. ' +
      'heavySlots.slots > 0: the lead is also denied a heavy command while every slot holds a live claim of another session (the holder is named; scripts/heavy-slot.cjs is the real lock; read errors fail open). ' +
      'Every deny is appended to <tmp>/ghorc-<user>/denials.log. An invalid project config makes it deny the built-in default heavy commands, with the reason. No project config: nothing is denied.',
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
  const ps = { powershell: input.tool_name === 'PowerShell' };
  const sub = Boolean(input.agent_id) || isWorker();
  const agentsMsg =
    'subagents and workers may not start other agents (claude -p, herdr agent start/prompt/send-keys, herdr pane run/send-keys/send-text, hc run/exec/keys/interrupt/send): ask the lead.';
  if (sub && matches(command, BUILTIN_SUBAGENT_DENY, ps)) return deny(agentsMsg);
  if (sub) {
    // hc send is a worker's way to report to its parent or, after a lead handover, to the new lead; so it is judged by its
    // target. A subagent has no terminal of its own.
    const targets = hcSendTargets(command, ps);
    if (targets.length) {
      const allowed = input.agent_id ? [] : backend.hcSendTargets(process.env, undefined, [projectRoot(input.cwd)]);
      if (!allowed.length || !targets.every((t) => allowed.includes(t))) {
        return deny(`${agentsMsg} A worker may hc send only to its own parent terminal or a live lead${allowed.length ? ` (${allowed.join(', ')})` : ' (none readable here)'}.`);
      }
    }
  }

  if (cfg.invalid) {
    if (matches(command, [...configured, ...DEFAULT_HEAVY], ps)) {
      return deny(`config invalid: ${cfg.invalid}. Heavy-command rules cannot be trusted: fix .claude/ghorc.json (node scripts/check-config.cjs).`);
    }
    return;
  }
  if (!matches(command, configured, ps)) return;

  if (sub) {
    // heavyGuard.agentsWhenFree (default false = only the lead): with slots on, an agent may start a heavy check while a slot is
    // free and is denied only when all are taken. A claim of the parent session is not "its own" for an agent. Any read problem
    // lets the command through, like the lead's hint (heavy-slot.cjs still holds the lock).
    if (cfg.heavyGuard && cfg.heavyGuard.agentsWhenFree === true) {
      let sc = null;
      try {
        sc = slots.slotConfig(cfg);
      } catch {
        /* falls to the plain deny below */
      }
      if (sc && sc.slots > 0) {
        try {
          const p = slots.plan(sc, '\0agent');
          if (!p.ok) return deny(`heavy-check slots are full (heavyGuard.agentsWhenFree): ${p.message}. Wait for a slot (node scripts/heavy-slot.cjs status).${sc.warning ? ` Note: ${sc.warning}.` : ''}`);
        } catch {
          /* fail open */
        }
        return;
      }
    }
    return deny('only the lead runs heavy checks.');
  }
  if (cfg.heavyGuard && cfg.heavyGuard.requireLeadEnv && !isLead()) {
    return deny('only the lead runs heavy checks (GHORC_ROLE=lead is not set).');
  }

  // slots: an early hint only (heavy-slot.cjs holds the lock); any read problem lets the command through
  try {
    const sc = slots.slotConfig(cfg);
    if (sc.slots) {
      const p = slots.plan(sc, input.session_id);
      if (!p.ok) return deny(`${p.message}. Wait for a slot (node scripts/heavy-slot.cjs status).${sc.warning ? ` Note: ${sc.warning}.` : ''}`);
    }
  } catch {
    /* fail open */
  }
}, 'heavy-check-guard');
