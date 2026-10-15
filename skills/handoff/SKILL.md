---
name: handoff
description: Self-handoff of the lead shift into a new herdr tab - HANDOFF file, candidate launch, READY/STOP protocol. Use when lead context reaches the handoff threshold, or "hand over the lead shift".
user-invocable: true
---
# Lead self-handoff (version 1: a skill, no scripts and no locks)

Paths and parameters come from `.claude/ghorc.json`: `lead.model`, `lead.effort`, `thresholds.*`, `handoff.statePath`, `handoff.handoffPath`, `handoff.allowSendKeysExit`, `handoff.candidatePermissionArgs`, `handoff.readyTimeoutMin` (default 10).

## Standing owner permission
Filled in once in the project config, only read here:
- `handoff.allowSendKeysExit` = `true`: the new lead may send `/exit` to the old tab through `herdr agent send-keys`. With `false` (the default) the owner sends `/exit` to the old tab.
- `handoff.candidatePermissionArgs`: permission-mode arguments for the candidate (as for the old lead). Empty - the candidate starts with default permissions; tell the owner so.
- The new lead closes the old tab only on the owner's word recorded in the config or STATE.

## Preconditions
- First check `HERDR_ENV`. If it is not `1` (the lead does not run inside herdr), do NOT run any herdr command and do not fail: print the fallback below to the owner and stop. Continue with the steps below only when `HERDR_ENV=1`.
- Zero background agents and background commands of the lead (otherwise a notification will wake the old lead after STOP). herdr workers are listed in HANDOFF (pane id).
- New owner messages received during the handoff are written to STATE before the candidate is launched.

## Triggers
- Context >= `thresholds.ctxHandoff` (150K) at a package boundary: hand over. ~170K - at the nearest stage boundary. Context comes from `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.cjs" --session <id>` (id from the SessionStart line or the `#id` status segment).
- From `thresholds.ctxPrepare` (120K): refresh STATE at a stage boundary.
- If the candidate context is large from the start, diagnose the startup instructions instead of rotating again.

## HANDOFF template (at most 50 lines; `templates/HANDOFF.md`)
Fill the file at `handoff.handoffPath`: handoff_id, status (DRAFT), old_session_id, reason; package chain and stages; background processes; decisions of the shift; unclosed messages and promised actions; first 3 steps.
Before launching the candidate, write STATE.md (`templates/STATE.md`) with the mandatory sections `in_flight` (agent/worker id, kind, expected output path, how to collect), `unanswered_owner_messages` (verbatim, with time), `head` (git HEAD) and `seq` (incremented on every STATE write), and copy `handoff_id` into it. Reports and scratch go to `<project>/.claude/ghorc-out/`.

## herdr commands (without `--wait`)
```
herdr tab create
GHORC_ROLE=lead herdr agent start lead-next --kind claude -- --model <lead.model> --effort <lead.effort> <handoff.candidatePermissionArgs>
herdr agent prompt lead-next "Read <HANDOFF path>. Verify it against git and the project status. Answer strictly: READY handoff=<id>; Next action: <one>; Discrepancies: <none/list>. Change nothing and do not start your own rotation until you get `ACTIVATE <id>`."
herdr agent wait lead-next --until idle,blocked
herdr agent read lead-next
```
Do not use `herdr agent prompt --wait` (risk of the hook sending it again).
The candidate lead starts with `GHORC_ROLE=lead` (PowerShell: `$env:GHORC_ROLE='lead'; herdr agent start ...`); any other herdr worker starts with `GHORC_ROLE=worker` (`$env:GHORC_ROLE='worker'`) so that it does not receive the lead reminder. Candidate and worker herdr starts are fine; whether herdr passes the variable on has not been verified live: if SessionStart prints `role=unknown (set GHORC_ROLE)`, the variable did not arrive.

## READY / STOP protocol
The candidate answers:
```
READY handoff=<id>
State read: <path>
Next action: <one concrete action>
Restrictions: <merge/release/payment>
Discrepancies: <none / list>
```
1. The old lead reads READY; if there are discrepancies it fixes HANDOFF and repeats in the same tab.
2. READY deadline: after the prompt the old lead polls `herdr agent get lead-next` every 60 s, up to `handoff.readyTimeoutMin` minutes (default 10). If the candidate is `blocked` or there is no READY by then, the old lead reports to the owner, closes the candidate (`/exit` in its tab, closes the created tab), voids the `handoff_id` and keeps leading.
3. READY accepted: the old lead writes `status: SENT` to the file and STATE (`seq` + 1), then as its LAST action before STOP sends `herdr agent prompt lead-next "ACTIVATE <handoff_id>"` (when `allowSendKeysExit` is false the owner sends it), prints `HANDOFF SENT - STOP` and does nothing more. It cannot run `/exit` itself (it is user input): the new lead sends it through `herdr agent send-keys` (if `allowSendKeysExit`) or the owner does.
4. Activation: the candidate acts only on `ACTIVATE <id>`. If the id differs from `handoff_id` in STATE.md it refuses and says so. It re-reads STATE.md and refuses if `head` differs from `git rev-parse HEAD` without a note in STATE, or if `seq` moved since READY. Then it waits for `herdr agent get` to show the old lead finished and reads the last owner message in the old tab with `herdr agent read`; every `unanswered_owner_messages` item is answered first, every `in_flight` item is collected or re-checked.
5. READY is a report, not proof: the new lead verifies SHA, branch and processes itself with commands.

## Protection
- One candidate per `handoff_id`; repeating the command returns the state of the existing handoff.
- After 2 failed handoffs - stop and ask the owner.
- The candidate does not start its own rotation and does not act before `ACTIVATE`.
- Do not delete dirty changes for a "clean intake"; do not kill processes by the name `claude`.

## Fallback (HERDR_ENV is not 1, herdr unavailable)
Print this to the owner instead of failing:
1. Write STATE.md (template `templates/STATE.md`) at `handoff.statePath`; it is the source of truth.
2. The owner runs `/clear`.
3. The owner says: "read STATE.md and continue".
Cheaper, but it does not free process memory.
