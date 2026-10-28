'use strict';
// Context guard for the lead: UserPromptSubmit, PreToolUse (any tool) and Stop.
const fs = require('node:fs');
const path = require('node:path');
const { run, deny, readState, writeState } = require('./lib/hook-io.cjs');
const { load, projectRoot } = require('./lib/config.cjs');
const tmp = require('./lib/tmp.cjs');
const cg = require('./lib/ctxguard.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'context-guard.cjs: hook for UserPromptSubmit, PreToolUse (every tool) and Stop; acts for the lead only ' +
      '(no agent_id, GHORC_ROLE is not worker). Context tokens come from the status line ctx file ' +
      '<root>/.claude/ctx-<session_id>.json (see ctx.cjs). Stages: ctxPrepare - "update STATE"; ctxWarn ' +
      '(default ctxHandoff - 10000) - "prepare the handoff, take no new packages"; ctxHandoff - handoff mode: ' +
      'a flag file <tmp>/ghorc-<user>/handoff-<session_id>.json is written and never removed by the hooks ' +
      '(compaction does not clear it); in handoff mode PreToolUse denies Agent/Task and Edit/Write/NotebookEdit outside ' +
      'handoff.statePath and handoff.handoffPath (Bash, Read, SendMessage, MCP tools stay allowed). ' +
      'Stop blocks until handoff.statePath is newer than the flag, at most 2 times, never when stop_hook_active; ' +
      'then it lets the turn end with a systemMessage. Without a ctx file, or with one older than 10 minutes, and ' +
      'without a flag, it only warns (fail-open). The transcript size and unread watchdog alerts are secondary signals ' +
      '(watchdog.warnMiB); they never block. Any internal error allows the call.',
  );
  process.exit(0);
}

const MAX_STOP_BLOCKS = 2;
const REMIND_EVERY_MS = 5 * 60 * 1000; // PreToolUse: the same stage is repeated at most this often
const STALE_WARN_EVERY_MS = 30 * 60 * 1000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

const kTokens = (n) => (typeof n === 'number' ? `${Math.round(n / 1000)}K` : '?K');
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

run((input) => {
  if (input.agent_id || process.env.GHORC_ROLE === 'worker') return;
  const sid = input.session_id;
  const event = input.hook_event_name;
  if (!sid || !['UserPromptSubmit', 'PreToolUse', 'Stop'].includes(event)) return;

  const cwd = input.cwd || process.cwd();
  const cfg = load(cwd);
  const root = projectRoot(cwd);
  const th = cg.thresholds(cfg);
  const now = Date.now();
  const ctx = cg.readCtx(root, sid, now);
  const fresh = ctx.found && ctx.ageMs <= cg.STALE_MS && ctx.tokens !== null;
  const hand = cfg.handoff || {};
  const statePath = path.resolve(root, hand.statePath || 'STATE.md');
  const handoffPath = path.resolve(root, hand.handoffPath || 'HANDOFF.md');

  // the sticky flag: written at the first crossing, then it decides on its own (stale data, compaction)
  let flag = cg.readFlag(sid);
  if (!flag && fresh && ctx.tokens >= th.handoff) flag = cg.writeFlag(sid, { ts: now, tokens: ctx.tokens, stopBlocks: 0 });
  const tokens = flag ? Math.max(flag.tokens || 0, fresh ? ctx.tokens : 0) : ctx.tokens; // for messages
  const stage = flag ? 'drain' : fresh ? cg.stageOf(ctx.tokens, th) : 'unknown';
  const size = mib(input);
  const warnMiB = Number((cfg.watchdog || {}).warnMiB) || 100;
  const big = size !== null && size >= warnMiB;
  const sizeText = size === null ? '' : ` / file ${Math.round(size)} MB`;

  const stageLine = () => {
    if (stage === 'drain') {
      return (
        `Handoff threshold (context ${kTokens(tokens)}${sizeText}): run ghorc:handoff. Handoff mode: no new agents, ` +
        `edits only to ${path.basename(statePath)} and ${path.basename(handoffPath)}.`
      );
    }
    if (stage === 'warn') return `Context ${kTokens(ctx.tokens)}${sizeText}: prepare the handoff now (update STATE), take no new packages.`;
    if (stage === 'prepare' || big) return `Context ${kTokens(ctx.tokens)}${sizeText}: update STATE.`;
    return null;
  };

  if (event === 'UserPromptSubmit') {
    const lines = [];
    const l = stageLine();
    if (l) lines.push(l);
    else if (stage === 'unknown') {
      const st = readState(sid, 'ctxguard.json');
      if (!(now - (st.staleWarnAt || 0) < STALE_WARN_EVERY_MS)) {
        const why = ctx.found ? `the ctx file is ${Math.round(ctx.ageMs / 60000)} min old or empty` : 'no ctx file (is the ghorc status line set up?)';
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
          `Handoff mode (context ${kTokens(tokens)}): no new agents. Resume a running agent with SendMessage, ` +
            'or hand the shift over: ghorc:handoff, then /clear.',
        );
      }
      if (EDIT_TOOLS.has(tool)) {
        const ti = input.tool_input || {};
        const given = ti.file_path || ti.notebook_path;
        const abs = typeof given === 'string' && given ? path.resolve(cwd, given) : null;
        if (!abs || !(samePath(abs, statePath) || samePath(abs, handoffPath))) {
          return deny(
            `Handoff mode (context ${kTokens(tokens)}): only ${path.basename(statePath)} and ${path.basename(handoffPath)} ` +
              'may be edited; hand the work to the next shift (ghorc:handoff).',
          );
        }
        return;
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
  if (!flag) return;
  if (cg.handoffSentBy(handoffPath, sid)) return; // status SENT of this session: the old lead must go idle, say nothing
  let stateMtime = null;
  try {
    stateMtime = fs.statSync(statePath).mtimeMs;
  } catch {
    /* no state file yet */
  }
  if (stateMtime !== null && stateMtime > flag.ts) {
    return out({ systemMessage: `${path.basename(statePath)} is up to date (context ${kTokens(tokens)}): hand over now with /clear and let the new session read it.` });
  }
  if (input.stop_hook_active) return; // loop protection: this turn was already blocked once
  if ((flag.stopBlocks || 0) >= MAX_STOP_BLOCKS) {
    return out({ systemMessage: `the lead did not hand over the shift: context ${kTokens(tokens)}` });
  }
  cg.writeFlag(sid, { ...flag, stopBlocks: (flag.stopBlocks || 0) + 1 });
  out({
    decision: 'block',
    reason:
      `Handoff threshold reached (context ${kTokens(tokens)}). Before stopping, update ${path.basename(statePath)} ` +
      `(and ${path.basename(handoffPath)}) with the in-flight work and open owner messages: ghorc:handoff. Then stop; the owner runs /clear.`,
  });
}, 'context-guard');
