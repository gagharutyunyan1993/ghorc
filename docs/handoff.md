# Handoff: a fresh session takes over the lead

`/ghorc:handoff` hands the lead shift to a new session before the context gets too large. It always works: without
herdr it writes STATE.md and you run `/clear`; inside herdr it also starts a candidate lead in a new tab and hands
over with a READY/STOP protocol. Parameters come from `.claude/ghorc.json`: `lead.model`, `lead.effort`,
`thresholds.*` and `handoff.*` ([configuration.md](configuration.md#handoff)).

## When

- Context reaches `thresholds.ctxHandoff` (150K) at a package boundary, or ~170K at the nearest stage boundary.
- From `thresholds.ctxPrepare` (120K): refresh STATE.md at a stage boundary.
- The lead reads its context with `node "<plugin>/scripts/ctx.cjs" --session <id>` (id from the SessionStart line or
  the `#id` status segment). The thresholds are instructions, not enforced by a script.

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

**Sequence** (never use `--wait` on `herdr agent prompt`):

1. Fill `handoff.handoffPath` from `templates/HANDOFF.md` (at most 50 lines), `status: DRAFT`.
2. Start the candidate in a new tab, prompt it (the skill has the full prompt text), wait for READY, read:

```
herdr tab create
herdr agent start lead-next --kind claude -- --model opus --effort medium <permArgs>
herdr agent prompt lead-next "Read HANDOFF.md, verify it against git, answer READY handoff=<id>; wait for ACTIVATE."
herdr agent wait lead-next --until idle,blocked
herdr agent read lead-next
```

   `<permArgs>` is `handoff.candidatePermissionArgs`; model and effort come from `lead.model` and `lead.effort`. The
   candidate may start with `GHORC_ROLE=lead` (optional: a plain main session is already the lead). Whether herdr
   passes the variable to the child session is not verified: check the candidate's SessionStart line.

3. **READY:** the candidate answers `READY handoff=<id>`, the state path, the next action, restrictions and
   discrepancies. With discrepancies the old lead fixes HANDOFF and asks again in the same tab. The old lead polls
   `herdr agent get lead-next` every 60 s up to `handoff.readyTimeoutMin` (default 10) minutes.
4. **ACTIVATE and STOP:** on an accepted READY the old lead writes `status: SENT` (STATE `seq` + 1), sends
   `herdr agent prompt lead-next "ACTIVATE <handoff_id>"` as its last action (the owner does it when
   `handoff.allowSendKeysExit` is `false`), prints `HANDOFF SENT - STOP` and does nothing more. `/exit` in the old tab
   comes from the owner, or from the new lead via `herdr agent send-keys` when `allowSendKeysExit` is `true`.
5. The candidate acts only on `ACTIVATE <id>` and refuses a different id. It re-reads STATE.md and refuses if `head`
   moved without a note or `seq` changed. It then waits until `herdr agent get` shows the old lead finished, reads the
   last owner message there with `herdr agent read`, answers every `unanswered_owner_messages` item, collects every
   `in_flight` item, and verifies SHA, branch and processes itself: READY is a report, not proof.

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

- `handoff.allowSendKeysExit` (`false`): when `true`, the new lead may send `/exit` to the old tab through
  `herdr agent send-keys`; otherwise the owner does it.
- `handoff.candidatePermissionArgs` (`[]`): permission-mode arguments for the candidate, for example
  `["--permission-mode", "acceptEdits"]`. Empty means default permissions, and the candidate may wait on a prompt.
- The new lead closes the old tab only on the owner's word recorded in the config or STATE.
