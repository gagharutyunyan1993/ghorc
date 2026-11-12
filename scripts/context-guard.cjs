'use strict';
// Context guard for the lead: SessionStart (compact), UserPromptSubmit, PreToolUse (any tool) and Stop.
const fs = require('node:fs');
const path = require('node:path');
const { run, deny, readState, writeState } = require('./lib/hook-io.cjs');
const { load, projectRoot } = require('./lib/config.cjs');
const { sessionRoot } = require('./lib/root.cjs');
const tmp = require('./lib/tmp.cjs');
const cg = require('./lib/ctxguard.cjs');
const { isWorker, provenLead } = require('./lib/role.cjs');
const { matches, AGENT_START } = require('./lib/cmd.cjs');
const { unpushed, pending, originDefaultBranch } = require('./lib/unpushed.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'context-guard.cjs: hook for SessionStart (matcher compact), UserPromptSubmit, PreToolUse (every tool) and Stop; ' +
      'acts for the lead only (no agent_id, GHORC_ROLE is not worker). ' +
      'Context tokens come from the status line ctx file <root>/.claude/ctx-<session_id>.json (see ctx.cjs). ' +
      'Stages: ctxPrepare - "update STATE"; ctxWarn (default ctxHandoff - 10000) - "prepare the handoff, take no new ' +
      'packages"; ctxHandoff - handoff mode. Handoff mode is kept by a flag file ' +
      '<tmp>/ghorc-<user>/handoff-<session_id>.json written at the first crossing of ctxHandoff. In handoff mode ' +
      'PreToolUse denies Agent/Task and Edit/Write/NotebookEdit outside handoff.statePath and handoff.handoffPath ' +
      '(Bash, Read, SendMessage, MCP tools stay allowed); with handoff.pushGuard true it also denies `herdr agent start` and `hc run ... claude` ' +
      'while a branch named in STATE in_flight is ahead of or missing on origin. Stop blocks the lead until ' +
      'handoff.statePath is newer than the flag, at most 2 times, never when stop_hook_active. STATE.md and HANDOFF.md are ' +
      'looked for at the root of the own git worktree of the session (a lead branch in a linked worktree uses that worktree, not the main checkout). ' +
      'handoff.stickyOnCompact (default false) switches on the sticky mode: any compaction (SessionStart with source ' +
      'compact) also writes the flag, the flag is cleared only when HANDOFF.md (handoff.handoffPath) has ' +
      '`status: SENT` and `old_session_id` equal to this session (token numbers never clear it), and Stop blocks once ' +
      'per turn until then (never when stop_hook_active, and a repeat block within 60 s for the session passes), with a ' +
      'reason that has no token numbers. A flag caused by a compaction denies and blocks only a session with ' +
      'GHORC_ROLE=lead, or a roleless session whose terminal proves it is a lead (hc: the terminal name starts with ' +
      'capacity.leadNamePrefix or it has no parent; herdr: the tab label starts with the prefix as configured; a failed ' +
      'or slow lookup proves nothing); GHORC_ROLE=worker never; any other session gets a reminder only; a flag from crossing ctxHandoff ' +
      'reaches every main session that is not a worker. The reminder also goes to the model through the ' +
      'additionalContext of UserPromptSubmit. Without a ctx file, or with one older than 10 minutes, and without a ' +
      'flag, it only warns (fail-open). The transcript size and unread watchdog alerts are secondary signals ' +
      '(watchdog.warnMiB); they never block. Any internal error allows the call.',
  );
  process.exit(0);
}

const MAX_STOP_BLOCKS = 2;
const STOP_BACKSTOP_MS = 60 * 1000; // sticky mode: a repeat Stop block within this time for the session passes
const REMIND_EVERY_MS = 5 * 60 * 1000; // PreToolUse: the same stage is repeated at most this often
const STALE_WARN_EVERY_MS = 30 * 60 * 1000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const WORKER_LINE = 'Reminder: this session was compacted, so token numbers are unreliable. Finish the task, write the report and stop.';
const NEUTRAL_LINE = 'Reminder: this session was compacted, so token numbers are unreliable.';

const kTokens = (n) => (typeof n === 'number' ? `${Math.floor(n / 1000)}K` : '?K');
const mib = (input) => {
  try {
    return input.transcript_path ? fs.statSync(input.transcript_path).size / 1048576 : null;
  } catch {
    return null;
  }
};
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}
function context(event, lines) {
  if (lines.length) out({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } });
}

// handoff.pushGuard: in handoff mode `herdr agent start` is denied while a branch named in STATE `in_flight` is ahead of
// or missing on origin. Returns { deny } or { note } (STATE names no branch: nothing could be checked, say so), else null.
// Fail-open: no git, no origin remote, a fetch refspec that does not cover the branch, not a herdr agent start. The
// default branch is never required.
function pushGuardCheck(input, cwd, statePath) {
  try {
    const command = input.tool_input && input.tool_input.command;
    if (typeof command !== 'string') return null;
    if (!matches(command, AGENT_START, { powershell: input.tool_name === 'PowerShell' })) return null;
    const branches = cg.inFlightBranches(statePath);
    if (!branches || !branches.length) {
      return {
        note:
          'handoff.pushGuard is on, but STATE in_flight names no `branch: <name>` field, so no branch was checked: push the ' +
          'in-flight branches yourself (never main or a foreign branch) and check them with node scripts/unpushed.cjs --branches <list>.',
      };
    }
    const base = originDefaultBranch(cwd);
    const wanted = branches.filter((b) => b !== base);
    if (!wanted.length) return null;
    const { error, rows } = unpushed(cwd, wanted);
    if (error) return null;
    const list = pending(rows);
    if (!list.length) return null;
    return {
      deny:
        `handoff.pushGuard: push the in-flight branches before launching the candidate (${list.map((r) => r.branch).join(', ')} ` +
        'not on origin): git push origin <branch> for each, never main or a foreign branch, then check with ' +
        'node scripts/unpushed.cjs --branches <list>.',
    };
  } catch {
    return null;
  }
}

run((input) => {
  if (input.agent_id) return;
  const worker = isWorker(); // a non-lead session: reminder only, never a deny or a block
  const sid = input.session_id;
  const event = input.hook_event_name;
  if (!sid || !['UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionStart'].includes(event)) return;
  if (worker && event !== 'SessionStart' && !cg.readFlag(sid)) return; // a worker without a flag costs one file read

  const cwd = input.cwd || process.cwd();
  const cfg = load(cwd);
  const hand = cfg.handoff || {};
  // handoff.stickyOnCompact (default false). Off: the behaviour of v0.7.0 (no compaction flag, Stop blocks at most 2
  // times and lets go once STATE is newer than the flag). On: the sticky mode described in --help.
  const sticky = hand.stickyOnCompact === true;
  if (worker && !sticky) return;
  // A lead that may be blocked: GHORC_ROLE=lead, or (no role at all) a terminal that proves it. Asked lazily, once, and only
  // where the answer matters; the role variable is read before any lookup. See lib/role.cjs.
  let leadAnswer = null;
  const isLead = () => {
    if (leadAnswer === null) {
      leadAnswer = provenLead({
        session: sid,
        leadPrefix: (cfg.capacity || {}).leadNamePrefix,
        prefer: (cfg.backend || {}).prefer,
        cwd,
      });
    }
    return leadAnswer;
  };
  const root = projectRoot(cwd); // the ctx files and watchdog alerts live under the project root
  const own = sessionRoot(cwd); // STATE.md and HANDOFF.md live at the root of the session's own worktree
  const th = cg.thresholds(cfg);
  const now = Date.now();
  const statePath = path.resolve(own, hand.statePath || 'STATE.md');
  const handoffPath = path.resolve(own, hand.handoffPath || 'HANDOFF.md');
  const stateName = path.basename(statePath);
  const handoffName = path.basename(handoffPath);

  if (event === 'SessionStart') {
    if (!sticky || input.source !== 'compact' || cg.handoffSentBy(handoffPath, sid)) return;
    const lead = !worker && isLead();
    const flag = cg.markCompacted(sid, now, lead);
    const enforced = !worker && (lead || Boolean(flag.crossed));
    return context('SessionStart', [
      enforced
        ? 'This session was compacted, so token numbers are unreliable and the handoff is due: run ghorc:handoff ' +
          `(update ${stateName} and ${handoffName}, hand the shift over).`
        : worker
          ? WORKER_LINE
          : NEUTRAL_LINE,
    ]);
  }

  // The sticky flag: written at the first crossing of ctxHandoff or (sticky mode) by a compaction; in sticky mode it is
  // cleared only by HANDOFF.md `status: SENT` with this session as old_session_id. Token numbers never clear it.
  let flag = cg.readFlag(sid);
  if (!sticky && flag && cg.compactOnly(flag)) flag = null; // left by a run with the key on: with the key off it is no flag (0.7.0)
  if (sticky && flag && cg.handoffSentBy(handoffPath, sid)) {
    cg.deleteFlag(sid);
    flag = null;
  }
  const compacted = sticky && Boolean(flag && flag.compacted);

  // Reminder only: a worker, or a roleless session whose flag came from a compaction alone (a flag from a compaction
  // denies and blocks a session with GHORC_ROLE=lead only). A roleless session that then crosses ctxHandoff gets the
  // v0.7.0 behaviour of the crossing. A worker gets the reminder and nothing else; a roleless session gets the reminder
  // in addition to the stage lines and watchdog alerts of an unflagged session.
  let ctx = null;
  const readCtx = () => ctx || (ctx = cg.readCtx(root, sid, now));
  let reminder = null;
  if (sticky && flag && (worker || cg.compactOnly(flag)) && !isLead()) {
    let reminderOnly = true;
    if (!worker) {
      const c = readCtx();
      if (c.found && c.ageMs <= cg.STALE_MS && c.tokens !== null && c.tokens >= th.handoff) {
        flag = cg.writeFlag(sid, { ...flag, tokens: c.tokens, crossed: true });
        reminderOnly = false;
      }
    }
    if (reminderOnly) {
      reminder = worker ? WORKER_LINE : NEUTRAL_LINE;
      if (worker) {
        if (event === 'UserPromptSubmit') return context('UserPromptSubmit', [reminder]);
        if (event === 'Stop' && !input.stop_hook_active) return out({ systemMessage: reminder });
        return;
      }
    }
  }

  ctx = readCtx();
  const fresh = ctx.found && ctx.ageMs <= cg.STALE_MS && ctx.tokens !== null;
  if (!flag && fresh && ctx.tokens >= th.handoff && !(sticky && cg.handoffSentBy(handoffPath, sid))) {
    flag = cg.writeFlag(sid, sticky ? { ts: now, tokens: ctx.tokens, crossed: true } : { ts: now, tokens: ctx.tokens, stopBlocks: 0 });
  }
  const tokens = flag ? Math.max(flag.tokens || 0, fresh ? ctx.tokens : 0) : ctx.tokens; // for messages
  const stage = flag && !reminder ? 'drain' : fresh ? cg.stageOf(ctx.tokens, th) : 'unknown';
  const size = mib(input);
  const warnMiB = Number((cfg.watchdog || {}).warnMiB) || 100;
  const big = size !== null && size >= warnMiB;
  const sizeText = size === null ? '' : ` / file ${Math.round(size)} MB`;
  // after a compaction the numbers describe the new, shorter context: never quote them
  const where = compacted ? 'context compacted' : `context ${kTokens(tokens)}${sizeText}`;
  const denyWhere = compacted ? 'context compacted' : `context ${kTokens(tokens)}`;

  const stageLine = () => {
    if (stage === 'drain') {
      return (
        (compacted
          ? 'Handoff due: the context was compacted, so token numbers are unreliable. Run ghorc:handoff. '
          : `Handoff threshold (${where}): run ghorc:handoff. `) +
        `Handoff mode: no new agents, edits only to ${stateName} and ${handoffName}.`
      );
    }
    if (stage === 'warn') return `Context ${kTokens(ctx.tokens)}${sizeText}: prepare the handoff now (update STATE), take no new packages.`;
    if (stage === 'prepare' || big) return `Context ${kTokens(ctx.tokens)}${sizeText}: update STATE.`;
    return null;
  };

  if (event === 'UserPromptSubmit') {
    // additionalContext reaches the model (a Stop systemMessage reaches only the user), so the reminder lives here
    const lines = reminder ? [reminder] : [];
    const l = stageLine();
    if (l) lines.push(l);
    else if (stage === 'unknown') {
      const st = readState(sid, 'ctxguard.json');
      if (!(now - (st.staleWarnAt || 0) < STALE_WARN_EVERY_MS)) {
        const why = ctx.bad
          ? 'the ctx file was found, bad JSON (is the status line writing it?)'
          : ctx.found
            ? `the ctx file is ${Math.round(ctx.ageMs / 60000)} min old or empty`
            : 'no ctx file (is the ghorc status line set up?)';
        lines.push(`Context guard inactive: ${why}.`);
        writeState(sid, 'ctxguard.json', { ...st, staleWarnAt: now });
      }
    }
    const { lines: alerts, ends } = tmp.unreadAlerts(root, sid);
    if (alerts.length) {
      const n = Math.min(5, alerts.length);
      lines.push(`watchdog: ${alerts.length} unread alert(s):`, ...alerts.slice(0, n).map((a) => `  ${a.slice(0, 160)}`));
      tmp.markAlertsRead(root, sid, ends[n - 1]);
    }
    return context('UserPromptSubmit', lines);
  }

  if (event === 'PreToolUse') {
    const tool = String(input.tool_name || '');
    if (stage === 'drain') {
      if (AGENT_TOOLS.has(tool)) {
        return deny(
          `Handoff mode (${denyWhere}): no new agents. Resume a running agent with SendMessage, ` +
            'or hand the shift over: ghorc:handoff, then /clear.',
        );
      }
      if (EDIT_TOOLS.has(tool)) {
        const ti = input.tool_input || {};
        const given = ti.file_path || ti.notebook_path;
        const abs = typeof given === 'string' && given ? path.resolve(cwd, given) : null;
        if (!abs || !(samePath(abs, statePath) || samePath(abs, handoffPath))) {
          return deny(
            `Handoff mode (${denyWhere}): only ${stateName} and ${handoffName} ` +
              'may be edited; hand the work to the next shift (ghorc:handoff).',
          );
        }
        return;
      }
      if ((tool === 'Bash' || tool === 'PowerShell') && hand.pushGuard === true) {
        const g = pushGuardCheck(input, cwd, statePath);
        if (g && g.deny) return deny(g.deny);
        if (g && g.note) return context('PreToolUse', [g.note]);
      }
    }
    // reminders: at once on a stage change, then at most every 5 minutes; unread alerts at the same pace
    const st = readState(sid, 'ctxguard.json');
    const lines = [];
    const l = stageLine();
    const changed = st.stage !== stage;
    if (l && (changed || now - (st.remindAt || 0) >= REMIND_EVERY_MS)) lines.push(l);
    let alertsAt = st.alertsAt || 0;
    if (now - alertsAt >= REMIND_EVERY_MS) {
      const { lines: alerts, ends } = tmp.unreadAlerts(root, sid);
      if (alerts.length) {
        const n = Math.min(3, alerts.length);
        lines.push(`watchdog: ${alerts.length} unread alert(s):`, ...alerts.slice(0, n).map((a) => `  ${a.slice(0, 160)}`));
        tmp.markAlertsRead(root, sid, ends[n - 1]);
        alertsAt = now;
      }
    }
    if (changed || lines.length) writeState(sid, 'ctxguard.json', { ...st, stage, remindAt: l && lines.includes(l) ? now : st.remindAt || 0, alertsAt });
    return context('PreToolUse', lines);
  }

  // Stop
  if (reminder) return input.stop_hook_active ? undefined : out({ systemMessage: reminder });
  if (!flag) return;

  if (sticky && isLead()) {
    // Blocked once per turn until HANDOFF.md says SENT for this session (which also removed the flag above). Never on
    // the second pass of a turn (stop_hook_active). Backstop: stop_hook_active may be missing, so a repeat block within
    // 60 s for the session passes. No token numbers in the reason.
    if (input.stop_hook_active) return;
    const st = readState(sid, 'ctxguard.json');
    if (now - (st.stopBlockAt || 0) < STOP_BACKSTOP_MS) return;
    writeState(sid, 'ctxguard.json', { ...st, stopBlockAt: now });
    return out({
      decision: 'block',
      reason:
        `Handoff is due${compacted ? ' (the context was compacted, so token numbers are unreliable)' : ''}. Before stopping, ` +
        `update ${stateName} and ${handoffName} with the in-flight work and open owner messages: ghorc:handoff. ` +
        `The block lifts when the header of ${handoffName} has the lines \`status: SENT\` and \`old_session_id: ${sid}\` ` +
        '(exactly these, plain text). Then stop; the owner runs /clear.',
    });
  }

  // v0.7.0
  if (cg.handoffSentBy(handoffPath, sid)) return; // status SENT of this session: the old lead must go idle, say nothing
  let stateMtime = null;
  try {
    stateMtime = fs.statSync(statePath).mtimeMs;
  } catch {
    /* no state file yet */
  }
  if (stateMtime !== null && stateMtime > flag.ts) {
    return out({ systemMessage: `${stateName} is up to date (context ${kTokens(tokens)}): hand over now with /clear and let the new session read it.` });
  }
  if (input.stop_hook_active) return; // loop protection: this turn was already blocked once
  if ((flag.stopBlocks || 0) >= MAX_STOP_BLOCKS) {
    return out({ systemMessage: `the lead did not hand over the shift: context ${kTokens(tokens)}` });
  }
  cg.writeFlag(sid, { ...flag, stopBlocks: (flag.stopBlocks || 0) + 1 });
  out({
    decision: 'block',
    reason:
      `Handoff threshold reached (context ${kTokens(tokens)}). Before stopping, update ${stateName} ` +
      `(and ${handoffName}) with the in-flight work and open owner messages: ghorc:handoff. Then stop; the owner runs /clear.`,
  });
}, 'context-guard');
