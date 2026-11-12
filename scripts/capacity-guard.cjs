'use strict';
// Capacity guard for the lead (off by default, config capacity.enabled): Stop, UserPromptSubmit, SubagentStart, SubagentStop.
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./lib/hook-io.cjs');
const { load, projectRoot } = require('./lib/config.cjs');
const { sessionRoot } = require('./lib/root.cjs');
const cg = require('./lib/ctxguard.cjs');
const { isWorker, provenLead } = require('./lib/role.cjs');
const cap = require('./lib/capacity.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'capacity-guard.cjs: hook for Stop, UserPromptSubmit, SubagentStart and SubagentStop; does nothing unless ' +
      'capacity.enabled is true in .claude/ghorc.json. Stop (lead only; never on stop_hook_active, agent_id or ' +
      'GHORC_ROLE=worker) blocks once when agents < capacity.agents AND CPU < cpuStartPct AND free RAM >= minFreeRamGb ' +
      'AND the last answer has no line starting with capacity.idleMarker and a real reason. Agents = background_tasks of ' +
      'the Stop input (fallback: the SubagentStart/Stop ledger .claude/ghorc-out/capacity-ledger.jsonl) + workers of ' +
      'the active terminal backend (scripts/lib/backend.cjs: hc -> `hc ls`, herdr -> `herdr agent list`, none -> 0; working/blocked, ' +
      'name not starting with capacity.leadNamePrefix, not this session; for hc also only terminals that have a parent). ' +
      'UserPromptSubmit adds "agents N/M, CPU X%, free Y GB". capacity.weeklyCapPct / agentsOverPace read ' +
      'rate_limits.seven_day from the status line ctx files; weeklyAgentsStepPct (agent limit drops to agentsOverPace) and ' +
      'weeklyNoNewPct (no new packages, no Stop block) are optional steps below the cap, never taken on stale data. Errors go to .claude/ghorc-out/capacity-guard.log; the hook ' +
      'fails open. Test seams: GHORC_CAPACITY_CPU_PCT, _FREE_GB, _HERDR_JSON, _HC_JSON, _LEDGER, _SAMPLE_MS.',
  );
  process.exit(0);
}

const out = (obj) => process.stdout.write(JSON.stringify(obj));

run((input) => {
  const event = input.hook_event_name;
  if (!['Stop', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop'].includes(event)) return;
  const cwd = input.cwd || process.cwd();
  const cfg = load(cwd);
  const s = cap.settings(cfg);
  if (!s.enabled) return;
  const root = projectRoot(cwd);
  const outDir = path.join(root, '.claude', 'ghorc-out');
  const logFile = path.join(outDir, 'capacity-guard.log');
  const log = (msg) => {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${event} ${msg}\n`);
    } catch {
      /* the log must not break anything */
    }
  };
  const ledgerFile = process.env.GHORC_CAPACITY_LEDGER || path.join(outDir, 'capacity-ledger.jsonl');
  const session = String(input.session_id || 'unknown');

  try {
    if (event === 'SubagentStart' || event === 'SubagentStop') {
      if (!input.agent_id) return;
      cap.appendEvent(ledgerFile, { e: event === 'SubagentStart' ? 'start' : 'stop', s: session, a: String(input.agent_id), ts: Date.now() }, log);
      return;
    }
    if (input.agent_id || isWorker()) return; // the lead only

    // weekly cap: null - the rule is on but there is no data; undefined - the rule is off
    let week;
    if (s.weeklyCapPct > 0 || s.weeklyAgentsStepPct > 0 || s.weeklyNoNewPct > 0) {
      week = cap.weekState(cap.readWeekRaw(path.join(root, '.claude'), session), s);
      if (week === null) log('weekly cap: no rate_limits.seven_day in any ctx file, the weekly brake is off');
    }

    if (event === 'Stop') {
      if (input.stop_hook_active) return;
      // handoff (HANDOFF.md at the session root, the same helper as context-guard): the old lead must go idle (SENT), and in handoff mode context-guard demands the opposite of new work
      const handoffPath = path.resolve(sessionRoot(cwd), ((cfg && cfg.handoff) || {}).handoffPath || 'HANDOFF.md');
      // a compaction-only flag (handoff.stickyOnCompact) binds the lead only: for any other session it is no flag. The lead
      // is the proven one (role, else the terminal), asked only here, only for such a flag; a failed lookup is "not proven"
      const flag = cg.readFlag(session);
      if (
        cg.handoffSentBy(handoffPath, session) ||
        (flag && (!cg.compactOnly(flag) || provenLead({ session, leadPrefix: s.leadNamePrefix, prefer: (cfg.backend || {}).prefer, cwd })))
      ) {
        return;
      }
      const fromTasks = cap.agentsFromTasks(input.background_tasks, log);
      const mine = cap.readLedger(ledgerFile).filter((e) => e.session === session).length;
      if (!cap.anyAgentTaskInFlight(input.background_tasks) && mine > 0) {
        try {
          cap.appendEvent(ledgerFile, { e: 'clear', s: session, ts: Date.now() }, log);
        } catch (e) {
          log(`ledger clear: ${e && e.message ? e.message : e}`);
        }
      }
      // a workflow or cloud session runs: its agents are not listed in the Stop input, but the ledger knows them, so the
      // larger of the two counts wins (the listed subagents are in the ledger too)
      let own = fromTasks;
      if (fromTasks === null) own = mine;
      else if (cap.otherAgentTaskInFlight(input.background_tasks)) own = Math.max(fromTasks, mine);
      const workers = cap.liveWorkers(session, s.leadNamePrefix, log);
      const reason = cap.stopDecision(input, s, {
        agents: workers === null ? null : own + workers,
        workers: workers || 0,
        week: week || null,
        cpu: () => cap.measureCpu({ samples: 3 }),
        freeGb: cap.measureFreeGb,
      });
      if (reason) out({ decision: 'block', reason });
      return;
    }

    // UserPromptSubmit
    const own = cap.readLedger(ledgerFile).filter((e) => e.session === session).length;
    const workers = cap.liveWorkers(session, s.leadNamePrefix, log);
    const line = cap.promptLine(s, {
      agents: workers === null ? null : own + workers,
      workers: workers || 0,
      cpu: cap.measureCpu({ samples: 1 }),
      freeGb: cap.measureFreeGb(),
      week,
    });
    out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line } });
  } catch (e) {
    log(`error: ${e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : e}`); // fail open: silent
  }
}, 'capacity-guard');
