# Handoff: a fresh session takes over the lead

`/ghorc:handoff` hands the lead shift to a new session before the context gets too large. It always works: without
herdr it writes STATE.md and you run `/clear`; inside herdr it also starts a candidate lead in a new tab and hands
over with a READY/STOP protocol. Parameters come from `.claude/ghorc.json`: `lead.model`, `lead.effort`,
`thresholds.*` and `handoff.*` ([configuration.md](configuration.md#handoff)).

## When

- From `thresholds.ctxWarn` (140K): prepare the handoff and take no new package. At `thresholds.ctxHandoff` (150K):
  hand the shift over (handoff mode: no new agents, edits only to STATE and HANDOFF).
- From `thresholds.ctxPrepare` (120K): refresh STATE.md at a stage boundary.
- The lead reads its context with `node "<plugin>/scripts/ctx.cjs" --session <id>` (id from the SessionStart line or
  the `#id` status segment).

## The context guard

`scripts/context-guard.cjs` (UserPromptSubmit, PreToolUse on every tool, Stop) enforces the thresholds for the lead
only (not subagents, not `GHORC_ROLE=worker`). It reads the status line ctx file, so the status line must be set up.

- From `ctxPrepare`: an "update STATE" line; from `ctxWarn` (default `ctxHandoff` - 10K): "prepare the handoff".
  The transcript size (`watchdog.warnMiB`) and unread watchdog alerts are added as lines; they never block.
- From `ctxHandoff`: handoff mode, kept by a flag file `<tmp>/ghorc-<user>/handoff-<session_id>.json`. Compaction does
  not clear it; a new session id (after `/clear`) has no flag. The mode denies a new Agent (SendMessage still works)
  and Edit/Write/NotebookEdit outside `handoff.statePath` and `handoff.handoffPath`; Bash, Read and MCP tools stay
  allowed with a reminder.
- Stop blocks until STATE is newer than the flag (at most 2 blocks, never when `stop_hook_active`), then lets the turn
  end with a "/clear" reminder; after 2 blocks it ends with a message to the owner.
- No ctx file, or one older than 10 minutes, and no flag: it only warns (fail-open).


## Without herdr

When `HERDR_ENV` is not `1`, the skill runs no herdr command and prints the fallback:

1. Write STATE.md (template `templates/STATE.md`) at `handoff.statePath`; it is the source of truth.
2. The owner runs `/clear`.
3. The owner says: "read STATE.md and continue".

Cheaper, but it does not free process memory.

## With herdr

**Preconditions:** `HERDR_ENV=1` (the lead runs inside herdr); no background agents or commands of the lead
(otherwise a notification wakes the old lead after STOP); herdr workers listed in HANDOFF with pane ids; new owner
messages written to STATE before the candidate starts. STATE.md is written first with the mandatory sections
`in_flight`, `unanswered_owner_messages` (verbatim, with time), `head` (git HEAD) and `seq` (+1 on every write), and
the `handoff_id` copied into it.

**Sequence** (prompts go through `herdr pane run <pane_id> "<text>"`; pane id from `herdr agent get lead-next`; never use `--wait`):

1. Fill `handoff.handoffPath` from `templates/HANDOFF.md` (at most 50 lines), `status: DRAFT`.
2. Start the candidate in a new tab, prompt it (the skill has the full prompt text), wait for READY, read:

```
herdr tab create
herdr agent start lead-next --kind claude -- --model opus --effort medium <permArgs>
herdr pane run <pane_id> "Read HANDOFF.md, verify it against git, answer READY handoff=<id>; wait for ACTIVATE."
herdr agent wait lead-next --until idle,blocked
herdr agent read lead-next
```

   `<permArgs>` is `handoff.candidatePermissionArgs`; model and effort come from `lead.model` and `lead.effort`. The
   candidate may start with `GHORC_ROLE=lead` (optional: a plain main session is already the lead). Whether herdr
   passes the variable to the child session is not verified: check the candidate's SessionStart line. A herdr worker
   that did not receive `GHORC_ROLE=worker` looks like a lead to the context guard: at 150K it would be put in handoff
   mode and asked to update `handoff.statePath` (the lead's STATE in the main checkout), so verify the variable live
   when installing 0.7.0.

3. **READY:** the candidate answers `READY handoff=<id>`, the state path, the next action, restrictions and
   discrepancies. With discrepancies the old lead fixes HANDOFF and asks again in the same tab. The old lead polls
   `herdr agent get lead-next` every 60 s up to `handoff.readyTimeoutMin` (default 10) minutes.
4. **ACTIVATE and STOP:** on an accepted READY the old lead writes `status: SENT` (STATE `seq` + 1), sends
   `herdr pane run <pane_id> "ACTIVATE <handoff_id>"` (text plus Enter in one call) as its last action; it is always the
   old lead, never the owner. Delivery is confirmed by status `working` or the line "running UserPromptSubmit hooks" in
   `herdr agent read`, not by the text in the input field (a `❯ <text>` line can be a grey prompt suggestion); do not
   press `esc esc`. Then it prints `HANDOFF SENT - STOP` and does nothing more; the Stop hooks stay silent once HANDOFF says
   `status: SENT` for that session, so it goes idle.
5. The candidate acts only on `ACTIVATE <id>` and refuses a different id. It re-reads STATE.md and refuses if `head`
   moved without a note or `seq` changed. It then waits until `herdr agent get` shows the old lead finished, reads the
   last owner message there with `herdr agent read`, answers every `unanswered_owner_messages` item, collects every
   `in_flight` item, and verifies SHA, branch and processes itself: READY is a report, not proof.
6. **Closing the old tab** (mandatory and verified when `handoff.allowSendKeysExit` is `true`; otherwise the owner closes
   it): right after ACTIVATE the new lead runs `herdr agent wait <old agent> --until idle`, then
   `MSYS_NO_PATHCONV=1 herdr pane run <old_pane_id> "/exit"`, then checks that the pane is gone from `herdr pane list`.
   Git Bash turns a slash command into a path (`/exit` becomes `C:/Program Files/Git/exit`), so every `herdr pane run` or
   `send-keys` with a slash command carries `MSYS_NO_PATHCONV=1` (or runs from PowerShell).

## Guards

- Candidate `blocked` or no READY by the deadline: the old lead reports, closes the candidate and its tab, voids the
  `handoff_id` and continues.
- One candidate per `handoff_id`; repeating the command returns the state of the existing handoff.
- After 2 failed handoffs, ask the owner.
- The candidate does not start its own rotation and does not act before `ACTIVATE`.
- Never delete uncommitted changes for a "clean intake"; never kill processes by the name `claude`.
- A candidate with a large context from the start points to oversized startup instructions: fix those instead of
  rotating again.

## Standing owner permissions

Set once in the project config and only read by the skill:

- `handoff.allowSendKeysExit` (`false`): when `true`, the new lead closes the old tab itself (step 6: `/exit` through
  `herdr pane run`); otherwise the owner does it.
- `handoff.candidatePermissionArgs` (`[]`): permission-mode arguments for the candidate, for example
  `["--permission-mode", "acceptEdits"]`. Empty means default permissions, and the candidate may wait on a prompt.
- The new lead closes the old tab only with `allowSendKeysExit` `true` (the owner's word in the config) or the owner's word recorded in STATE.
