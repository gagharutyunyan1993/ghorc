'use strict';
// Tabs guard for the lead (config tabs): PreToolUse(Bash|PowerShell) denies badly named or badly started worker tabs;
// UserPromptSubmit, SessionStart and Stop report the worker tabs that are open (blocked, finished but not closed, stalled, overtime).
const path = require('node:path');
const { deny, run } = require('./lib/hook-io.cjs');
const { load, found } = require('./lib/config.cjs');
const { isWorker } = require('./lib/role.cjs');
const { projectRoot, sessionRoot } = require('./lib/root.cjs');
const { handoffSentBy } = require('./lib/ctxguard.cjs');
const tabs = require('./lib/tabs.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'tabs-guard.cjs: hook for PreToolUse(Bash|PowerShell), UserPromptSubmit, SessionStart (startup, resume) and Stop; the lead only ' +
      '(no agent_id, not GHORC_ROLE=worker) and only with tabs.enabled (default true). ' +
      'PreToolUse denies `herdr tab create`, `herdr agent start` and `hc run` that break the tab policy: name <pkg>-<kind> (worker) or ' +
      'capacity.leadNamePrefix + name (lead), a letter first then [a-z0-9-], 32 characters at most; herdr tab create needs --workspace (the own one) and --no-focus; the lead may not create, close or start in another workspace;  GHORC_ROLE on the tab; --model alias, --effort, ' +
      '-n equal to the tab name, worker.permissionArgs / handoff.candidatePermissionArgs; no live name twice; at most tabs.maxWorkers agent workers; ' +
      '--outlive-parent for full/runner/train. The reason shows the corrected form. Internal errors and unreadable lists allow the command. ' +
      'tabs.devCommands (regexes; every session, backend hc or herdr): dev servers and watchers are denied outside a <pkg>-runner tab. '+
      'The other events list the project\'s worker tabs (`tabs: N live (name status minutes, ...)`) with a flag line for BLOCKED, FINISHED ' +
      '(report file has a result line, tab still open), STALLED (idle >= tabs.idleMin, no result), OVERTIME (>= tabs.overtimeMin), OVER_LIMIT and RESULT? (a result line at the first sighting, never blocks Stop). ' +
      'Stop blocks once per (tab, flag) occurrence (never on stop_hook_active) when a tab turns BLOCKED or FINISHED and tabs.stopBlock is true; it stays silent once HANDOFF.md says SENT for this session and for a candidate lead before ACTIVATE. On herdr a worker turning blocked ' +
      'raises one `herdr notification show` (tabs.notify). Test seams: GHORC_CAPACITY_HC_JSON, GHORC_CAPACITY_HERDR_JSON, GHORC_TABS_NOTIFY_LOG, ' +
      'GHORC_HC_BIN, GHORC_HERDR_BIN; HERDR_PANE_ID (prefix) / HERDR_WORKSPACE_ID is the own workspace; only a project with .claude/ghorc.json is judged.',
  );
  process.exit(0);
}

const TAB_WORD = /\b(?:hc|herdr)(?:\.exe)?\b/i;
const out = (obj) => process.stdout.write(JSON.stringify(obj));

run((input) => {
  const event = input.hook_event_name;
  if (!['PreToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop'].includes(event)) return;
  // workers and subagents get the dev-command rule only: heavy-check-guard already denies them every agent start
  const sub = Boolean(input.agent_id) || isWorker();
  if (sub && event !== 'PreToolUse') return;
  const cwd = input.cwd || process.cwd();
  // ghorc is installed at user scope: a project that has no .claude/ghorc.json never opted in, so nothing is denied or reported there
  if (!found(cwd)) return;
  const cfg = load(cwd);
  if (cfg.invalid) return; // fail open
  const s = tabs.settings(cfg);
  if (!s.enabled) return;
  const root = projectRoot(cwd);

  if (event === 'PreToolUse') {
    if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return;
    const command = input.tool_input && input.tool_input.command;
    if (typeof command !== 'string') return;
    const ps = input.tool_name === 'PowerShell';
    // a long-running process (dev server, watcher) runs only in a runner tab: every session, backend hc or herdr
    if (s.devCommands.length) {
      const seg = tabs.devMatch(command, s.devCommands, ps);
      if (seg) {
        const kind = tabs.backendKind(process.env, cwd);
        if (kind === 'hc' || kind === 'herdr') {
          deny(tabs.devReason(seg, command, { kind, lead: !sub, background: Boolean(input.tool_input && input.tool_input.run_in_background === true), powershell: ps }));
          return;
        }
      }
    }
    if (sub || !TAB_WORD.test(command)) return;
    // one list call per run: the backend of the first tab command (backend.detect decides when both are present); the rules of
    // another backend's commands are skipped, never read a second time
    let live;
    const reason = tabs.checkCommand(command, {
      powershell: ps,
      s,
      workspace: tabs.ownWorkspace(process.env),
      root,
      self: String(process.env.HC_TERMINAL_ID || '').trim(),
      session: String(input.session_id || ''),
      list: (kind) => {
        if (live === undefined) live = tabs.readLive(process.env, cwd, kind);
        return live && live.kind === kind ? live.entries : null;
      },
    });
    if (reason) deny(reason);
    return;
  }

  const live = tabs.readLive(process.env, cwd);
  if (!live) return;
  const session = String(input.session_id || 'unknown');
  const now = Date.now();
  const r = tabs.evaluate(live, tabs.readTabState(session), now, { root, s, workspace: tabs.ownWorkspace(process.env), session });
  // a lead that has sent its handoff must go idle (its Stop stays silent, like context-guard), and a candidate that is not activated
  // yet owns none of the old lead's workers: neither blocks Stop nor notifies
  const hand = cfg.handoff || {};
  const own = sessionRoot(cwd);
  const handoffPath = path.resolve(own, hand.handoffPath || 'HANDOFF.md');
  const statePath = path.resolve(own, hand.statePath || 'STATE.md');
  const quiet = handoffSentBy(handoffPath, session) || tabs.candidateBeforeActivation(handoffPath, statePath, session, now);
  if (quiet && event === 'Stop') return;
  if (quiet) for (const name of r.toNotify) r.state.workers[name.toLowerCase()].notified = false; // not told: the next run that may tell, does
  else if (s.notify && live.kind === 'herdr') for (const name of r.toNotify) tabs.notify(name);
  if (!r.lines.length) {
    tabs.writeTabState(session, r.state);
    return;
  }

  const text = r.lines.join('\n');
  if (event === 'Stop') {
    if (input.stop_hook_active || !s.stopBlock || !r.stopNew.length) {
      tabs.writeTabState(session, r.state);
      return;
    }
    tabs.markStopped(r.state, r.stopNew);
    tabs.writeTabState(session, r.state);
    out({ decision: 'block', reason: `tabs-guard: ${text}` });
    return;
  }
  tabs.writeTabState(session, r.state);
  out({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}, 'tabs-guard');
