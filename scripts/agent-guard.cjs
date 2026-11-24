'use strict';
// PreToolUse(Agent|Task): the lead's Agent calls name a model, and never start the built-in Explore, Plan or
// general-purpose agents, which run on the session's model (the guide: "the built-in Explore subagent runs on your
// session's model"), so their verbose reading would cost the lead's rates.
const fs = require('node:fs');
const path = require('node:path');
const { deny, run } = require('./lib/hook-io.cjs');
const { load, optedIn } = require('./lib/config.cjs');
const { isWorker } = require('./lib/role.cjs');
const { projectRoot } = require('./lib/root.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'agent-guard.cjs: PreToolUse(Agent|Task) hook for the lead (no agent_id, GHORC_ROLE not worker) in a project with ' +
      '.claude/ghorc.json and agentGuard.enabled (default true). Denies (1) subagent_type Explore, Plan or general-purpose ' +
      'unless the project defines its own agent of that name in .claude/agents/<name>.md (setup item explore writes a Haiku ' +
      'Explore), because the built-in ones run on the session model; (2) a call without `model`, because a role without a ' +
      'model in its frontmatter (and methodology-toolkit agents) then runs on the lead model. Every deny is appended to ' +
      '<tmp>/ghorc-<user>/denials.log. Any internal error allows the call.',
  );
  process.exit(0);
}

const BUILTIN = new Set(['explore', 'plan', 'general-purpose']);

function projectAgent(root, name) {
  try {
    return fs.statSync(path.join(root, '.claude', 'agents', `${name}.md`)).isFile();
  } catch {
    return false;
  }
}

run((input) => {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return;
  if (input.agent_id || isWorker()) return; // the lead only
  const cwd = input.cwd || process.cwd();
  if (!optedIn(cwd)) return;
  const cfg = load(cwd);
  const g = cfg.agentGuard && typeof cfg.agentGuard === 'object' ? cfg.agentGuard : {};
  if (g.enabled === false) return;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const type = typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : '';
  if (BUILTIN.has(type.toLowerCase()) && !projectAgent(projectRoot(cwd), type)) {
    return deny(
      `the built-in ${type} agent runs on the session model (the lead's Opus or Fable), so its reading costs the lead's rates. ` +
        'Use ghorc:scout (facts about code and git, sonnet/medium) or ghorc:log-reader (logs, haiku/medium) with model and effort from the Routing table ' +
        '(skill ghorc:lead); /ghorc:setup item explore adds a project Explore on haiku.',
    );
  }
  if (typeof ti.model !== 'string' || !ti.model.trim()) {
    return deny(
      `pass model (and effort) on every Agent call from the Routing table of skill ghorc:lead${type ? ` (${type})` : ''}: ` +
        'the call outranks the frontmatter, and a role without a model in its frontmatter runs on the lead model.',
    );
  }
}, 'agent-guard');
