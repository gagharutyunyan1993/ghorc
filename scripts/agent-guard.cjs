'use strict';
// PreToolUse(Agent|Task): the lead's Agent calls name a role and a model. The built-in Explore, Plan and general-purpose
// agents have no ghorc report contract (short report, check rules, frontmatter effort) and without a model run on the
// session's model (the guide: "the built-in Explore subagent runs on your session's model"); a fork inherits the lead's
// whole context and always runs on the lead's model (a per-call model is ignored); a call without subagent_type starts
// general-purpose.
const fs = require('node:fs');
const path = require('node:path');
const { deny, run } = require('./lib/hook-io.cjs');
const { load, optedIn } = require('./lib/config.cjs');
const { isWorker } = require('./lib/role.cjs');
const { projectRoot } = require('./lib/root.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'agent-guard.cjs: PreToolUse(Agent|Task) hook for the lead (no agent_id, GHORC_ROLE not worker) in a project with ' +
      '.claude/ghorc.json and agentGuard.enabled (default true). Denies (1) a call without subagent_type (it starts ' +
      'general-purpose); (2) subagent_type fork (the lead context at the lead model; a model override is ignored); (3) ' +
      'subagent_type Explore, Plan or general-purpose unless the project defines its own agent of that name in ' +
      '.claude/agents/<name>.md (setup item explore writes a Haiku Explore): no ghorc report contract, and without a model ' +
      'they run on the session model; (4) a call without `model`, because a role without a ' +
      'model in its frontmatter then runs on the lead model. Every deny is appended to ' +
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
  const roles = 'Use a ghorc role (ghorc:scout for facts about code and git, ghorc:log-reader for logs, ghorc:implementer, ...) with model and effort from the Routing table (skill ghorc:lead)';
  if (!type) {
    return deny(`an Agent call without subagent_type starts general-purpose, which has no ghorc report contract. ${roles}.`);
  }
  if (type.toLowerCase() === 'fork') {
    return deny(
      `a fork inherits the lead's whole context and always runs on the lead's model (a model override is ignored), so every turn costs the lead's rates. ${roles}, with a brief instead of the context.`,
    );
  }
  if (BUILTIN.has(type.toLowerCase()) && !projectAgent(projectRoot(cwd), type)) {
    return deny(
      `the built-in ${type} agent has no ghorc report contract (a short report, check rules, an effort in its frontmatter), and without a model it runs on the session model. ` +
        `${roles}; /ghorc:setup item explore adds a project Explore on haiku.`,
    );
  }
  if (typeof ti.model !== 'string' || !ti.model.trim()) {
    return deny(
      `pass model (and effort) on every Agent call from the Routing table of skill ghorc:lead${type ? ` (${type})` : ''}: ` +
        'the call outranks the frontmatter, and a role without a model in its frontmatter runs on the lead model.',
    );
  }
}, 'agent-guard');
