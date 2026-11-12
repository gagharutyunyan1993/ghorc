---
name: handoff
description: Hand the lead shift over when context gets large - writes STATE.md and works without a terminal backend (then you run /clear); with hc or herdr it also launches a candidate lead in a new terminal (READY/STOP protocol). Use at the handoff threshold, or "hand over the lead shift".
user-invocable: true
---
# Lead self-handoff (version 1: a skill, no scripts and no locks)

Paths and parameters come from `.claude/ghorc.json`: `lead.model`, `lead.effort`, `thresholds.*`, `handoff.statePath`, `handoff.handoffPath`, `handoff.allowSendKeysExit`, `handoff.candidatePermissionArgs`, `handoff.readyTimeoutMin` (default 10).

## Standing owner permission
Filled in once in the project config, only read here:
- `handoff.allowSendKeysExit` = `true`: the new lead closes the old tab itself (step 6 below: `/exit` through `herdr pane run`, or `hc kill` on `hc`). With `false` (the default) the owner closes the old tab.
- `handoff.candidatePermissionArgs`: permission-mode arguments for the candidate (as for the old lead). Empty - the candidate starts with default permissions; tell the owner so.
- The new lead closes the old tab only with `allowSendKeysExit` `true` (the owner's word in the config) or the owner's word recorded in STATE.

## Preconditions
- First determine the backend: `node "${CLAUDE_PLUGIN_ROOT}/scripts/backend.cjs" --name` prints `hc`, `herdr` or `none` (`hc` when `HC_TERMINAL_ID` is set; `herdr` when `HERDR_ENV=1` and `herdr agent list` answers; with both, `backend.prefer` decides, `hc` by default). On `none` run no tab or agent command and do not fail: print the fallback below to the owner and stop. Otherwise use only the command forms of that backend (sections below); never claim that only one backend works.
- Zero background agents and background commands of the lead (otherwise a notification will wake the old lead after STOP). Workers are listed in HANDOFF (pane id on `herdr`, terminal address on `hc`).
- New owner messages received during the handoff are written to STATE before the candidate is launched.

## Triggers
- Context >= `thresholds.ctxWarn`: prepare the handoff, take no new package; with no agents in flight start the handoff at once. Context >= `thresholds.ctxHandoff`: hand over. `ctxHandoff` + 35K should stay at or below the autocompact point (5K overshoot, 25K handoff, 5K spare). Context comes from `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.cjs" --session <id>` (id from the SessionStart line or the `#id` status segment).
- From `thresholds.ctxPrepare`: refresh STATE at a stage boundary.
- The context guard hook enforces this. Handoff mode starts at `ctxHandoff` and, with `handoff.stickyOnCompact` and `GHORC_ROLE=lead`, at any compaction of the session (after a compaction the token numbers are unreliable, so the handoff is due at once, whatever `ctx.cjs` shows). It denies new Agent calls and edits outside `handoff.statePath` / `handoff.handoffPath`. With `handoff.stickyOnCompact` and `GHORC_ROLE=lead`, Stop blocks you until `HANDOFF.md` has the header lines `status: SENT` and `old_session_id: <this session id>` (plain text, as the block reason prints them), and token numbers never lift it. Without the sticky key, or in a session that is not `GHORC_ROLE=lead`, Stop follows the 0.7.0 rule: at most 2 blocks, released once STATE is newer than the flag. A new session after `/clear` starts clean.
- If the candidate context is large from the start, diagnose the startup instructions instead of rotating again.

## HANDOFF template (at most 3072 bytes, `wc -c`; `templates/HANDOFF.md`)
With several leads each lead lives in its own worktree, and `handoff.handoffPath` / `handoff.statePath` are read from the root of the session's worktree, not of the project. Fill the file at `handoff.handoffPath`: handoff_id, status (DRAFT), old_session_id, reason; package chain and stages; background processes; decisions of the shift; unclosed messages and promised actions; first 3 steps.
The old lead may add an optional acceptance block (at most 1600 bytes and 15 lines) with the READY/ACTIVATE lines and the first steps, so that the candidate need not load this skill. Before launching the candidate, write STATE.md (`templates/STATE.md`, at most 8192 bytes) with the mandatory sections `in_flight` (agent/worker id, kind, expected output path, how to collect), `unanswered_owner_messages` (verbatim, with time), `head` (git HEAD) and `seq` (incremented on every STATE write), and copy `handoff_id` into it. Write every in-flight package branch as `branch: <name>` in `in_flight`. Reports and scratch go to `<project>/.claude/ghorc-out/`.

## Push in-flight branches first (before the candidate is launched)
Unpushed branches die with a PC or worktree change. For every package listed in STATE `in_flight` (write its branch there as `branch: <name>`):
1. Push it from its worktree: `git push origin <branch>`. Never push `main` and never a branch you do not own (foreign or not in `in_flight`).
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/unpushed.cjs" --branches <a,b>` (local refs only, no network). Exit 0 and every branch `pushed`: go on. Exit 1: push what it lists, run it again. Exit 2 (not a git repository, no `origin` remote, git unavailable) or a line "cannot tell" (the fetch refspec of `origin` does not cover the branch): the script could not check, so do not read it as pushed; check the branch yourself (`git ls-remote origin <branch>` against `git rev-parse <branch>`) or report to the owner before the candidate is launched.
3. Write each branch and its head SHA (printed by the script) into HANDOFF section 1.
With `handoff.pushGuard` `true` the hook denies `herdr agent start` and `hc run ... claude` from the lead in handoff mode until the in-flight branches are pushed (no `branch:` field in `in_flight`: nothing is checked).

## herdr commands (backend `herdr`; without `--wait`)
```
herdr tab create --label lead-next --cwd <project root> --env GHORC_ROLE=lead   # note result.root_pane.pane_id
herdr agent start lead-next --kind claude --pane <pane_id> -- --model <lead.model> --effort <lead.effort> <handoff.candidatePermissionArgs>
herdr agent get lead-next        # note result.agent.pane_id
herdr pane run <pane_id> "Read <HANDOFF path>. Verify it against git and the project status. Answer strictly: READY handoff=<id>; Next action: <one>; Discrepancies: <none/list>. Change nothing and do not start your own rotation until you get `ACTIVATE <id>`."
herdr agent wait lead-next --until idle --until done --until blocked --timeout 60000
herdr agent read lead-next
```
Repeat `--until` for each state: a comma-separated list of states does not work as "or", nor does a lone `idle`. A wait that ends on `--timeout` is a check-in, not a refusal. After it, `agent read` and look for `READY`.
Sending prompts: ACTIVATE and any other prompt to the candidate or a worker is sent by the old lead itself with `herdr pane run <pane_id> "<text>"` (text plus Enter in one call). Never ask the owner to press Enter. `herdr agent prompt` and `send-keys enter` may leave the text unsent: the `❯ <text>` line in `herdr agent read` can be a grey Claude Code prompt suggestion, not typed input. Check `working` (`herdr agent get`) after EVERY send to the candidate (first prompt, READY repeat, ACTIVATE); verify delivery by status `working` or the line "running UserPromptSubmit hooks" in `herdr agent read`, never by the text in the input field. Do not press `esc esc` (it opens the rewind menu). Do not use `--wait` on any of these.
The candidate lead is created with `--env GHORC_ROLE=lead`: with `handoff.stickyOnCompact` on, only a session with that role is denied and blocked after a compaction, and a roleless session gets a reminder only (without the key the role is optional and a plain main session is the lead). Any other herdr worker is created with `herdr tab create --env GHORC_ROLE=worker` (append `worker.permissionArgs` to its `agent start` the way the candidate gets `handoff.candidatePermissionArgs`) so that it does not receive the lead reminder and the context guard never puts it in handoff mode. Role goes into the tab, not into `herdr agent start`: `herdr agent start` types the `claude` command into an existing pane's shell, so `GHORC_ROLE=worker herdr agent start ...` sets the variable on the herdr CLI only and it never reaches the session (checked live: `GHORC_ROLE` was empty in such a tab). `herdr tab create --env GHORC_ROLE=<role>` sets it for the pane shell and every child (checked live: `$env:GHORC_ROLE` read `worker` in the new pane). Verify on the first worker: its SessionStart line must say `role=worker`; if it says `role=lead`, close it and recreate the tab. Do not tell a worker from a lead by tab name.

## hc commands (backend `hc`)
The candidate must outlive the old lead, so it is started with `--outlive-parent`; the role goes through `env` (`hc run` has no `--env`):
```
hc run --bg --name lead-next --cwd <project root> --outlive-parent "C:\Program Files\Git\usr\bin\env.exe" GHORC_ROLE=lead claude.exe --model <lead.model> --effort <lead.effort> <handoff.candidatePermissionArgs> "Read <HANDOFF path>. Verify it against git and the project status. Answer with hc send <old terminal address> strictly: READY handoff=<id>; Next action: <one>; Discrepancies: <none/list>. Change nothing and do not start your own rotation until you get `ACTIVATE <id>`."
hc wait lead-next            # the READY arrives as a tagged message <hc from="...">, or read it:
hc read lead-next --lines 60
hc send lead-next "ACTIVATE <id>"
```
`<old terminal address>` is the old lead's own `HC_TERMINAL_ID`. The task is in the `run` itself (a send to a booting agent can be dropped; check `first_message.sent` in the `hc run` output, and if it is false read `hc read lead-next` before resending). Check the status `working` in `hc get lead-next` after EVERY send (the `run`, a READY repeat, ACTIVATE), not the text in the input field. `hc wait lead-next` is a foreground wait with its own timeout (`reason: timeout` is a check-in, not a refusal: wait again; a `done` without READY: read the tab and sort it out); the old lead is closed (step 6) with `hc kill <old>; hc rm <old>` after it is idle.

## READY / STOP protocol
The candidate answers:
```
READY handoff=<id>
State read: <path>, seq=<N>
Next action: <one concrete action>
Restrictions: <merge/release/payment>
Discrepancies: <none / list>
```
1. The old lead reads READY; if there are discrepancies it fixes HANDOFF and repeats in the same tab.
2. READY deadline: after the prompt the old lead checks `herdr agent get lead-next` (on `hc`: `hc wait lead-next`, which returns on a message or after its timeout) every 60 s, up to `handoff.readyTimeoutMin` minutes (default 10); a wait timeout is a check-in, not a refusal. If the candidate is `blocked` or there is no READY by then, the old lead reports to the owner, closes the candidate (`/exit` in its tab and closes the created tab on `herdr`; `hc kill lead-next; hc rm lead-next` on `hc`), voids the `handoff_id` and keeps leading.
3. READY accepted: the old lead writes `status: SENT` to the file and STATE (`seq` + 1), then as its LAST action before STOP sends `herdr pane run <pane_id> "ACTIVATE <handoff_id>"` (on `hc`: `hc send lead-next "ACTIVATE <handoff_id>"`) itself (always the old lead, never the owner), confirms delivery (status `working` or "running UserPromptSubmit hooks" in `herdr agent read`; on `hc` status `working` in `hc get lead-next`), prints `HANDOFF SENT - STOP` and does nothing more. It cannot run `/exit` itself (it is user input): closing the old tab is step 6. The Stop hooks stay silent once `HANDOFF` says `status: SENT` for the old session, so the old lead really goes idle.
4. Activation: the candidate acts only on `ACTIVATE <id>`. If the id differs from `handoff_id` in STATE.md it refuses and says so. It re-reads STATE.md and refuses if `head` differs from `git rev-parse HEAD` without a note in STATE. It accepts exactly the `seq` it reported in READY plus 1, together with `status: SENT` (the old lead's own SENT write); any other `seq`, or `seq` + 1 without SENT, is refused. Then it waits for `herdr agent get` (on `hc`: `hc wait <old>`) to show the old lead finished and reads the last owner message in the old tab with `herdr agent read` (`hc read <old> --lines 100`); every `unanswered_owner_messages` item is answered first, every `in_flight` item is collected or re-checked.
5. READY is a report, not proof: the new lead verifies SHA, branch and processes itself with commands.
6. Closing the old tab is mandatory and verified (when `allowSendKeysExit` is `true`; with `false` the owner closes it). Right after ACTIVATE, without waiting to be asked, the new lead runs `herdr agent wait <old pane or agent> --until idle --until done --until blocked --timeout 60000`, then `MSYS_NO_PATHCONV=1 herdr pane run <old_pane_id> "/exit"`, then checks that the pane is gone from `herdr pane list`. If it is still there, read the old tab with `herdr agent read` and repeat once; then report to the owner. On `hc`: `hc wait <old>`, then `hc kill <old>; hc rm <old>`, then check that it is gone from `hc ls`; repeat once, then report.
   Git Bash trap: a slash command passed to herdr from Git Bash is turned into a path (`/exit` becomes `C:/Program Files/Git/exit`). Always put `MSYS_NO_PATHCONV=1` in front of every `herdr pane run`/`send-keys` that carries a slash command (or run it from PowerShell).

## Children at handoff
Close finished children (workers whose result is accepted) before the candidate starts; live ones stay open and are listed in HANDOFF for the new lead. A live long-lived tab on `hc` must have been started with `--outlive-parent`, otherwise closing the old lead kills it.

## Protection
- One candidate per `handoff_id`; repeating the command returns the state of the existing handoff.
- After 2 failed handoffs - stop and ask the owner.
- The candidate does not start its own rotation and does not act before `ACTIVATE`.
- Do not delete dirty changes for a "clean intake"; do not kill processes by the name `claude`.

## Fallback (backend `none`: neither hc nor herdr is available)
Print this to the owner instead of failing:
1. Write STATE.md (template `templates/STATE.md`) at `handoff.statePath`; it is the source of truth. Push the in-flight branches first (see above). Then write `handoff.handoffPath` with at least `status: SENT` and `old_session_id: <this session id>` in its header: the context guard keeps blocking Stop until it sees that (no candidate exists, so SENT only means STATE is written).
2. The owner runs `/clear`.
3. The owner says: "read STATE.md and continue".
Cheaper, but it does not free process memory.
