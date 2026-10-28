---
name: handoff
description: Hand the lead shift over when context gets large - writes STATE.md and works without herdr (then you run /clear); with herdr it also launches a candidate lead in a new tab (READY/STOP protocol). Use at the handoff threshold, or "hand over the lead shift".
user-invocable: true
---
# Lead self-handoff (version 1: a skill, no scripts and no locks)

Paths and parameters come from `.claude/ghorc.json`: `lead.model`, `lead.effort`, `thresholds.*`, `handoff.statePath`, `handoff.handoffPath`, `handoff.allowSendKeysExit`, `handoff.candidatePermissionArgs`, `handoff.readyTimeoutMin` (default 10).

## Standing owner permission
Filled in once in the project config, only read here:
- `handoff.allowSendKeysExit` = `true`: the new lead closes the old tab itself (step 6 below: `/exit` through `herdr pane run`). With `false` (the default) the owner closes the old tab.
- `handoff.candidatePermissionArgs`: permission-mode arguments for the candidate (as for the old lead). Empty - the candidate starts with default permissions; tell the owner so.
- The new lead closes the old tab only with `allowSendKeysExit` `true` (the owner's word in the config) or the owner's word recorded in STATE.

## Preconditions
- First check `HERDR_ENV`. If it is not `1` (the lead does not run inside herdr), do NOT run any herdr command and do not fail: print the fallback below to the owner and stop. Continue with the steps below only when `HERDR_ENV=1`.
- Zero background agents and background commands of the lead (otherwise a notification will wake the old lead after STOP). herdr workers are listed in HANDOFF (pane id).
- New owner messages received during the handoff are written to STATE before the candidate is launched.

## Triggers
- Context >= `thresholds.ctxWarn` (140K): prepare the handoff, take no new package. Context >= `thresholds.ctxHandoff` (150K): hand over. Context comes from `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.cjs" --session <id>` (id from the SessionStart line or the `#id` status segment).
- From `thresholds.ctxPrepare` (120K): refresh STATE at a stage boundary.
- The context guard hook enforces this: from `ctxHandoff` it denies new Agent calls and edits outside `handoff.statePath` / `handoff.handoffPath` (the flag survives compaction), and Stop waits until STATE is newer than the crossing, so write STATE first. A new session after `/clear` starts clean.
- If the candidate context is large from the start, diagnose the startup instructions instead of rotating again.

## HANDOFF template (at most 50 lines; `templates/HANDOFF.md`)
Fill the file at `handoff.handoffPath`: handoff_id, status (DRAFT), old_session_id, reason; package chain and stages; background processes; decisions of the shift; unclosed messages and promised actions; first 3 steps.
Before launching the candidate, write STATE.md (`templates/STATE.md`) with the mandatory sections `in_flight` (agent/worker id, kind, expected output path, how to collect), `unanswered_owner_messages` (verbatim, with time), `head` (git HEAD) and `seq` (incremented on every STATE write), and copy `handoff_id` into it. Reports and scratch go to `<project>/.claude/ghorc-out/`.

## herdr commands (without `--wait`)
```
herdr tab create
GHORC_ROLE=lead herdr agent start lead-next --kind claude -- --model <lead.model> --effort <lead.effort> <handoff.candidatePermissionArgs>
herdr agent get lead-next        # note result.agent.pane_id
herdr pane run <pane_id> "Read <HANDOFF path>. Verify it against git and the project status. Answer strictly: READY handoff=<id>; Next action: <one>; Discrepancies: <none/list>. Change nothing and do not start your own rotation until you get `ACTIVATE <id>`."
herdr agent wait lead-next --until idle,blocked
herdr agent read lead-next
```
Sending prompts: ACTIVATE and any other prompt to the candidate or a worker is sent by the old lead itself with `herdr pane run <pane_id> "<text>"` (text plus Enter in one call). Never ask the owner to press Enter. `herdr agent prompt` and `send-keys enter` may leave the text unsent: the `❯ <text>` line in `herdr agent read` can be a grey Claude Code prompt suggestion, not typed input. Verify delivery by status `working` (`herdr agent get`) or the line "running UserPromptSubmit hooks" in `herdr agent read`, never by the text in the input field. Do not press `esc esc` (it opens the rewind menu). Do not use `--wait` on any of these.
The candidate lead may start with `GHORC_ROLE=lead` (optional, a plain main session is the lead; PowerShell: `$env:GHORC_ROLE='lead'; herdr agent start ...`); any other herdr worker starts with `GHORC_ROLE=worker` (`$env:GHORC_ROLE='worker'`) so that it does not receive the lead reminder. Candidate and worker herdr starts are fine; whether herdr passes the variable on has not been verified live: if the candidate session prints `role=lead` although you started a worker, the variable did not arrive (check with `GHORC_ROLE` in its shell).

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
3. READY accepted: the old lead writes `status: SENT` to the file and STATE (`seq` + 1), then as its LAST action before STOP sends `herdr pane run <pane_id> "ACTIVATE <handoff_id>"` itself (always the old lead, never the owner), confirms delivery (status `working` or "running UserPromptSubmit hooks" in `herdr agent read`), prints `HANDOFF SENT - STOP` and does nothing more. It cannot run `/exit` itself (it is user input): closing the old tab is step 6. The Stop hooks stay silent once `HANDOFF` says `status: SENT` for the old session, so the old lead really goes idle.
4. Activation: the candidate acts only on `ACTIVATE <id>`. If the id differs from `handoff_id` in STATE.md it refuses and says so. It re-reads STATE.md and refuses if `head` differs from `git rev-parse HEAD` without a note in STATE, or if `seq` moved since READY. Then it waits for `herdr agent get` to show the old lead finished and reads the last owner message in the old tab with `herdr agent read`; every `unanswered_owner_messages` item is answered first, every `in_flight` item is collected or re-checked.
5. READY is a report, not proof: the new lead verifies SHA, branch and processes itself with commands.
6. Closing the old tab is mandatory and verified (when `allowSendKeysExit` is `true`; with `false` the owner closes it). Right after ACTIVATE, without waiting to be asked, the new lead runs `herdr agent wait <old pane or agent> --until idle`, then `MSYS_NO_PATHCONV=1 herdr pane run <old_pane_id> "/exit"`, then checks that the pane is gone from `herdr pane list`. If it is still there, read the old tab with `herdr agent read` and repeat once; then report to the owner.
   Git Bash trap: a slash command passed to herdr from Git Bash is turned into a path (`/exit` becomes `C:/Program Files/Git/exit`). Always put `MSYS_NO_PATHCONV=1` in front of every `herdr pane run`/`send-keys` that carries a slash command (or run it from PowerShell).

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
