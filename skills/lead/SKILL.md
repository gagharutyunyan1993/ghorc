---
name: lead
description: Lead skill (was ghorc:orc) - how the Opus lead delegates to Sonnet subagents, routes by model and effort, keeps its context small and hands the shift over. Load at the start of a lead session, when delegating, or when choosing model or effort.
user-invocable: true
---
# Orchestrating lead

Project config: `.claude/ghorc.json` (checks, critical areas, thresholds). Plugin roles: `ghorc:implementer`, `ghorc:reviewer`, `ghorc:reviewer-critical`, `ghorc:integrator`, `ghorc:release`, `ghorc:scout`, `ghorc:log-reader`, `ghorc:consult`, `ghorc:media`.

## Rules on one page
1. The lead is Opus/medium by default, set explicitly at launch (`--model opus --effort medium`). For a major refactor, a migration, an architecture plan, many packages in parallel or a long unattended run the lead is Fable/medium (`lead.model: fable`). Change the lead's model only at a handoff (skill `ghorc:handoff`), never with `/model` in a running lead: the prompt cache belongs to the model, and reasoning is dropped on a move down a tier. Source of every model choice: `docs/models.md` (from Anthropic's model guide).
2. The implementer is Sonnet/medium for well-scoped work; money and recovery - Sonnet/high (the critical reviewer is Opus, the models must differ); migrations and performance optimization - Opus/medium, a clear spec alone does not justify Sonnet there; a major migration - Fable/medium.
3. Ordinary review and re-check of fixes of an ordinary package - Sonnet/medium; critical review - `ghorc:reviewer-critical` on a model other than the implementer's: Opus/high for Sonnet or Fable work, Fable/medium (`model: fable`) for Opus work. On a critical package the final verdict and the check of money findings stay with the critical reviewer; Sonnet checks only non-critical findings.
4. The critical reviewer again - if a fix changes a money invariant.
5. Haiku only where a mistake is cheap to spot: `ghorc:log-reader` (logs, test output) and mechanical work with a machine-checkable result (brief Template 3), at medium. Never code edits, never the facts a brief is written from (that is `ghorc:scout` on Sonnet).
6. Fable - the lead for the cases in rule 1, the arbiter of a disputed question or a disputed P0, the architecture plan of a major change, and the critical reviewer of Opus work; not the default reviewer.
7. Small things (at most 2 commands, output at most 100 lines, no package code edits) the lead does itself; anything bigger goes to a file or an agent. Work that fits one context and is one chain of dependent steps goes to one implementer, not split across agents: planning and merging would cost more than they save.
8. On every Agent call pass `model` and `effort` explicitly from the Routing table below; do not rely on frontmatter or global settings (the call's values outrank the frontmatter; `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` outrank the call, keep both unset). Do not start the built-in `Explore`, `Plan` or `general-purpose` agents: they run on the lead's model, so their reading costs the lead's rates; use `ghorc:scout` and `ghorc:log-reader`. When the project defines its own roles in `.claude/agents/`, launch those instead of the `ghorc:*` roles and keep the same table.
9. The lead does not read PDFs and images, transcripts, logs and files over 100 lines whole (a diff - by `--stat` and by file). Attachments go as a file with a path to the `ghorc:media` role; logs and test output (including the lead's own background `full`) to `ghorc:log-reader`. PDFs are converted to text/PNG beforehand.
10. The lead does not write package code, does not run checks synchronously, does not poll agents.
11. The lead reads context with `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.cjs"` at a stage boundary (the status line writes the file). The lead reads its own session id from the SessionStart line (`session=<id>`) or the `#id` status line segment, then runs `ctx.cjs --session <id>` (never a guess of the newest file): `thresholds.ctxPrepare` - refresh STATE; `thresholds.ctxWarn` - prepare the handoff, take no new package, and with no agents in flight start the handoff at once; `thresholds.ctxHandoff` - handoff mode, skill `ghorc:handoff` (`ctxWarn` 0 means `ctxHandoff` - 10K). Set `ctxHandoff` + 35K at or below the autocompact point (5K overshoot, 25K handoff, 5K spare). `ctx.cjs` also prints unread watchdog alerts: act on them. The context guard hook enforces these thresholds for you (UserPromptSubmit / PreToolUse / Stop): from `ctxHandoff` (and, with `handoff.stickyOnCompact`, from any compaction, when the numbers are unreliable and the session is a proven lead: `GHORC_ROLE=lead`, or no role and a terminal that proves it) a new Agent and edits outside STATE/HANDOFF are denied, and Stop blocks (with the sticky key: once per turn until HANDOFF says `status: SENT` for this session); obey its lines instead of working around them. Before launching a candidate push the in-flight branches (skill `ghorc:handoff`).
12. Do not pull large output in; if it was pulled in, `/rewind` is done by the owner. `/clear` is not used by the lead.
13. In chat at most 25 lines; an agent report at most 25 lines (review at most 30); anything large goes to a file.
14. A brief is one tagged structure (skill `ghorc:brief`); an ordinary one is at most 500 words, a critical review at most 800; over 200 lines is a task-statement error.
15. Checks only through the commands from the config `checks`; a bare test runner and `full` are forbidden for agents.
16. `full` - one, on the final tree, lead only, in the background, after fast; it runs on the merge SHA and the report quotes that SHA; incomplete - cause first, restart only the failed phase. Heavy commands are denied also for `GHORC_ROLE=worker`; subagents and workers may not run `claude -p`, `herdr agent start|prompt|send-keys`, `herdr pane run|send-keys|send-text`, `hc run|exec|keys|interrupt`, or `hc send` to anyone but their own parent (a worker reports to its parent with `hc send`; a subagent never).
17. Review limit - at most 2 fix rounds (config `review.maxFixRounds`), then a closure check instead of a full re-review. A separate closure-check agent only for a critical package, on the critical reviewer's model and effort (Opus/high, or Fable/medium on Opus work); on an ordinary package the same reviewer checks the fix diff. Input: the basis of each taken finding, the fix diff, the surrounding code and the test. Output: closed or not closed with evidence per finding, plus a scan of the fix diff for new P0/P1. Every finding gets a recorded fate: taken, queued with an id, or rejected with a reason. A full re-review only when the fixes went beyond the findings and changed behaviour. P0/P1 still open after round 2: blocked, and the lead narrows the task. A second `CHANGES_REQUIRED` means the lead changes the task statement (cause first) rather than sending the same implementer again.
18. There is no sub-lead. Inside a terminal backend (`hc` or `herdr`, see "Terminal backend" below; owner's rule of 2026-11-01) every package, every review and the integrator run as a separate tab (a worker) and write their result to the report file named in the brief; an in-process Agent call is only for scouting of up to about 5 minutes and for writing memory. Why: background agents inside the lead are invisible to the owner, and work stood still because of that. Tradeoff: tab workers do not reach the ledger (only Agent calls do). With backend `none` the default stays direct Agent calls. `GHORC_ROLE` is optional: a plain main session is the lead. A worker gets its role at start: on `herdr` from the tab (`herdr tab create --env GHORC_ROLE=worker ...`, then start the agent in that pane with `--pane <pane_id>`; `GHORC_ROLE=worker herdr agent start ...` does NOT reach the session, because the agent is typed into the pane's shell); on `hc` through `env` in the command (`hc run` has no `--env`). Without it the worker receives the lead reminder and, after a compaction or at the handoff threshold, the lead's handoff block; a roleless session counts as the lead there when its terminal proves it (hc: tab named with `capacity.leadNamePrefix` or no parent; herdr: tab label starting with the prefix), so `GHORC_ROLE=worker` is the only reliable way to keep a worker out. Check its SessionStart line for `role=worker`. `GHORC_ROLE=lead` is only needed for the optional strict mode (`leadNoMedia`, `heavyGuard.requireLeadEnv`).
19. Limit: `capacity.agents` (agents and workers together) when the capacity guard is enabled, otherwise bounded by machine load (CPU, free RAM); one heavy check per machine. A lead is also recognised without `GHORC_ROLE` by a tab/terminal name prefix `capacity.leadNamePrefix`.
20. "Significant" for a consultation - any of: money/data/recovery; an external contract or migration; a hard-to-reverse dependency; a conflict of key requirements; two failed approaches. Composition: a counterpart plus a critic (`methodology-toolkit:red-team-critic`), one round. For a judgement call of your own (a verdict, a disputed cause, a choice between designs) load the skill `methodology-toolkit:methodology-driven-thinking` before deciding; methodology-toolkit is installed with ghorc as its dependency. Its agents declare no model, so pass `model` and `effort` like for every role.

## Terminal backend (before any tab or agent command)
Two terminal backends exist and a machine may have either, both, or none. Never assume one: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/backend.cjs"` first (JSON; `--name` prints the word) and use only the forms of its answer. `hc` = `HC_TERMINAL_ID` is set (herdr-app, `hc --skill` is its manual); `herdr` = `HERDR_ENV=1` and `herdr agent list` answers (the older CLI); `none` = neither (use Agent calls and the `/clear` fallback; run no tab command). If both are set, `backend.prefer` decides (`hc` default, or `herdr`).

| Action | `hc` | `herdr` |
|---|---|---|
| Start a worker with a role | `hc run --bg --name <n> --cwd <dir> "C:\Program Files\Git\usr\bin\env.exe" GHORC_ROLE=worker claude.exe -n <n> --model <m> --effort <e> <worker.permissionArgs> "<task>"` | `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --no-focus --label <n> --cwd <dir> --env GHORC_ROLE=worker`, then `herdr agent start <n> --kind claude --pane <pane_id> -- -n <n> --model <m> --effort <e> <worker.permissionArgs>`, then `herdr pane run <pane_id> "<task>"` |
| Wait | `hc wait <n>` (foreground; `hc wait --children any\|all`) | `herdr agent wait <n> --until idle --until done --until blocked --timeout <ms>`, then `agent read` (a comma list does not work) |
| Read | `hc read <n> --lines 100` | `herdr agent read <n>` |
| Send text | `hc send <n> "<text>"` | `herdr pane run <pane_id> "<text>"` |
| Close (right after accepting the result) | `hc kill <n>; hc rm <n>` | `herdr tab list`, then `herdr tab close <tab_id>` |
| List / state | `hc ls`, `hc get <n>` | `herdr agent list`, `herdr agent get <n>` |

A worker finishes with a report file; its LAST line is the signal: `DONE <name>` / `BLOCKED <name>: <reason>` / `HANDOFF <name>`; a review ends with `VERDICT <ACCEPT|ACCEPT_WITH_NOTES|CHANGES_REQUIRED|BLOCKED>`. `worker.permissionArgs` (default `--permission-mode bypassPermissions`) is appended to every worker start the way the candidate gets `handoff.candidatePermissionArgs` (same default). Long-lived tabs (trains, integrator, `full`, runners) on `hc` only with `--outlive-parent`, otherwise closing the lead kills them. Close a worker tab right after accepting its result; at handoff close finished children and pass live ones to the new lead. A worker on `hc` reports with `hc send <parent> "<line>"`, the parent address is in its `hc get $HC_TERMINAL_ID` `parent` field. The capacity guard counts workers of the active backend only (on `none`: none). Handoff forms (READY/ACTIVATE): skill `ghorc:handoff`.

## Tabs: open, name, watch, close
Enforced by the `tabs-guard` hook when `tabs.enabled` (default on): a tab or worker start that breaks the rules below is denied with the corrected form, every prompt shows a `tabs:` line while workers are live, and Stop is blocked while a worker is BLOCKED or FINISHED but still open.
- **Open a tab** for every package, every review, the integrator, a release, and every long-lived command (`full`, a runner, a train). Not for scouting under about 5 minutes, log reading (`ghorc:log-reader`) or memory writes: those are Agent calls. One tab is one package and one role; never reuse a finished tab for other work, its context belongs to the old task.
- **Name it** lowercase `[a-z0-9-]`, starting with a letter, at most 32 characters (herdr's agent-name rule): the lead `lead-<slug>`; a worker `<pkg>-<role>` (`implementer`, `reviewer`, `reviewer-critical`, `scout`, `integrator`, `release`, `consult`, `media`, `log-reader`); a long-lived command `<pkg>-full`, `<pkg>-runner`, `<pkg>-train`. `<pkg>` is the package id from STATE. The Claude session in the tab gets the same name with `-n <name>`, so the terminal title and `/resume` show it.
- **Start it** with the role env (`GHORC_ROLE=worker`), `-n <name>`, `--model <alias>` and `--effort` from the Routing table (an alias, never a versioned id), `worker.permissionArgs`, and the package worktree as cwd. The brief names the report file `.claude/ghorc-out/<name>.md`; the guard reads its last line.
- **Stay in your workspace (herdr):** every `herdr tab create` carries `--workspace "$HERDR_WORKSPACE_ID"` (PowerShell: `$env:HERDR_WORKSPACE_ID`), the workspace of the lead's own pane, and `--no-focus`. Without `--workspace` herdr creates the tab in the UI-focused workspace, which may belong to another project's lead; without `--no-focus` it moves the owner's focus. Never create, close or start anything in another workspace.
- **Long-running processes go to a runner tab, never to a background task:** dev servers and watchers (`npm run dev|start|serve|watch`, `vite`, `next dev`, `docker compose up`, `nodemon`, `tsc --watch`, anything that does not exit by itself) run only in a tab `<pkg>-runner` (herdr: `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --no-focus --label <pkg>-runner --cwd <dir>`, then `herdr pane run <pane_id> "<command>"`; hc: `hc run --bg --outlive-parent --name <pkg>-runner --cwd <dir> <command>`). Not as a Bash background task and not inside a worker: a hung process stays visible, and its log is read with `herdr pane read <pane_id> --source recent-unwrapped --lines 120` (hc: `hc read <name>`). A worker that needs one ends BLOCKED with the command; the lead starts the runner and puts the URL or port into the next brief. Close the runner when the package that needed it is accepted. The guard denies these commands outside a runner tab (`tabs.devCommands`).
- **Limit:** at most `tabs.maxWorkers` agent tabs at once (long-lived command tabs do not count). At the limit, accept and close before opening.
- **Watch** in the background (`hc wait`, or `herdr agent wait <n> --until idle --until done --until blocked --timeout <ms>`), never by polling. The `tabs:` line flags: BLOCKED - the worker waits on a dialog: read its screen and bring a permission or question prompt to the owner, never answer it yourself; STALLED (idle `tabs.idleMin` minutes without a result line) - read its screen, nudge once on the same task, otherwise close and re-brief; OVERTIME (`tabs.overtimeMin` minutes) - the stop-loss: finish, hand over the stage or block; OVER_LIMIT - close before opening more.
- **Close** right after accepting the result (report read, verdict recorded), before the next package starts; a BLOCKED worker after the owner's decision; at a handoff close the finished ones and list the live ones in HANDOFF. Never close a lead tab (the old lead closes itself in the handoff flow) or a tab of another project.
- **After a restart or a handoff** the SessionStart `tabs:` lines list the live workers: adopt each into STATE `in_flight` or close it.
- Workers in bypassPermissions still stop on a critical-path removal prompt and on `AskUserQuestion`; those show as BLOCKED. `/ghorc:setup` item `bypassPrompt` pre-accepts the one-time bypass warning so the first worker does not stop on it.

## Capacity guard (only when `capacity.enabled` is true in `.claude/ghorc.json`)
If a prompt line says `agents N/M, CPU X%, free Y GB` or Stop returns your turn as "Machine underloaded", the machine has room: start work that can move in parallel (a package, a review, a scout) or end the answer with a line `Idle: <reason>` (the marker is `capacity.idleMarker`; the reason must be a real one, for example "waiting for the owner" or "CPU busy with a foreign process"). `WEEKLY CAP` in the line means no new agents at all: only merge what is ready. Without the line and the hook nothing here applies.

## Routing
Model and start effort per class of work, from Anthropic's model guide; the reasons and the guide row of each line are in `docs/models.md`. Pass both on the call.

| Class of work | Role | Model / effort | Next step if it falls short |
|---|---|---|---|
| Lead, everyday work | lead | opus / medium | high, then the next handoff on fable |
| Lead of a major refactor, migration, architecture plan, many parallel packages, a long unattended run | lead | fable / medium | high |
| Well-scoped implementation (named cause, a spec) | `ghorc:implementer` | sonnet / medium | high, then opus / medium (ordinary packages) |
| Edit by a ready pattern | `ghorc:implementer` | sonnet / low | medium |
| Money, recovery | `ghorc:implementer` | sonnet / high | split the task |
| Migration, performance optimization | `ghorc:implementer` | opus / medium | high, then fable / medium |
| Major migration | `ghorc:implementer` | fable / medium | high |
| Investigation, a cause unclear across subsystems (ordinary packages) | `ghorc:implementer` | opus / medium | high |
| Ordinary review, re-check of fixes | `ghorc:reviewer` | sonnet / medium | high |
| Critical review of Sonnet or Fable work (contract, policy, hook, money, recovery) | `ghorc:reviewer-critical` | opus / high | disputed P0: the arbiter |
| Critical review of Opus work (migration, performance) | `ghorc:reviewer-critical` | fable / medium | disputed P0: the arbiter |
| Scouting (facts about code, git) | `ghorc:scout` | sonnet / low | medium |
| Logs, test output, the output of a background `full` | `ghorc:log-reader` | haiku / medium | `ghorc:scout` |
| Mechanical work with a machine check | ad hoc, brief Template 3 | haiku / medium | sonnet / low |
| Attachments (PDFs, screenshots) | `ghorc:media` | sonnet / low | medium; opus / medium for a long vision-heavy loop |
| Consultation with external models | `ghorc:consult` | sonnet / low | medium |
| Architecture with clear constraints | lead or ad hoc | opus / medium | high, then fable / medium |
| Architecture plan of a major change | ad hoc | fable / medium | high |
| Dispute, arbiter, disputed P0 | ad hoc | fable / medium | high |
| Critic of a significant decision, plan or hypothesis (rule 20) | `methodology-toolkit:red-team-critic` | opus / medium | high; fable / medium for an Opus-made plan |
| Sourced facts for product, market or vendor questions | `methodology-toolkit:evidence-scout` | sonnet / low | medium |
| Merge conflict, red pipeline | `ghorc:integrator` | sonnet / medium | high, then opus / medium |
| Release (only on the owner's word) | `ghorc:release` | sonnet / medium | none |
| Backend `hc` or `herdr`: any package, review or integrator; backend `none`: waits >~15 min, must survive a lead restart, or owner watches/answers | worker (tab) with a report file, `--model` and `--effort` explicit | - | - |

## Effort
Roles keep the start effort of the table; the lead moves one step for one named condition and writes that condition in the brief.

| Role | Moves one step up when |
|---|---|
| `implementer` | concurrency/IPC state, a critical area, or a `REASONING_FAILURE` on a complete brief |
| `reviewer` | diff over 5 files or 300 lines, or shared state/concurrency |
| `reviewer-critical` | never past its start effort; a disputed P0 goes to the Fable arbiter at medium |
| `scout` | sources conflict or a cross-file inference is needed |
| `log-reader` | never; an unreadable or ambiguous log goes to `ghorc:scout` |
| `integrator` | the resolution changes behavior, or a check stays red after resolution |
| `consult`, `media` | conflicting answers to adjudicate / charts or contracts to interpret |
| `release` | none |

The thresholds (5 files, 300 lines) are provisional until the ledger (`docs/evidence.md`) replaces them.

- Escalation order, from the guide: (1) verification first: if the agent could not check its work, add the check (`SKIPPED_CHECK`, `BRIEF_OMISSION`), same model and effort; (2) one effort level up, only after a `REASONING_FAILURE`; (3) past high, the next model up at medium, never `xhigh` or `max` (one level past high can cost as much as a bigger model; effort does not add knowledge the model lacks, and a wrong approach needs a new brief, not more effort). `xhigh` and `max` need a measured gain in the ledger for that role.
- The implementer on money or recovery is Sonnet high, never Opus: the critical reviewer is Opus and the models must differ. Its escalation path: reformulate, then split the task. On migrations and performance work the implementer is Opus and the critical reviewer Fable. A switch from Sonnet to Opus otherwise only on non-critical packages.
- Sonnet high is eligible when the scope is bounded (at most 4 writable files), the acceptance command is deterministic and the cause is named. "Investigate" or an unclear cause across subsystems goes to Opus medium on non-critical packages only.
- Cascade: a batch of similar packages with a deterministic acceptance command starts every package at low and re-runs only the failures one step up; record each re-run with cause `CASCADE` (it never counts as a reasoning failure).
- Cause first, effort second. On CHANGES_REQUIRED with P0/P1 the lead classifies the cause before re-briefing: `BRIEF_OMISSION` (the brief lacked a fact or a check) - fix the brief, same effort; `SKIPPED_CHECK` (the agent did not run a check it could run) - add the check line, same effort; `REASONING_FAILURE` (the brief was complete, the agent reasoned wrong) - the next implementer call goes one step up (medium to high; past high, the next model at medium). A second CHANGES_REQUIRED with P0/P1 changes the task statement or splits it; no further raise. Past the last entry of the "Next step" column the same rule applies. `OTHER` (environment, flaky check, owner change) and `CASCADE` never change the table. The cause is required on CHANGES_REQUIRED and absent on ACCEPT; the verdict command takes an optional `--class critical|ordinary`. Network failure, out of memory or a wrong command never raise effort. There is no automatic downshift; the table changes only through the ledger (20 packages per role; `ledger.cjs report` gives tokens and estimated cost per role). The critical reviewer stays at its start effort in every round. The lead records the verdict with `/ghorc:status --verdict <pkg> <round> <verdict> <cause>`.
- Pre-mortem for a critical package: before writing the brief, list at most 3 ways the package could pass review and still be wrong, and turn each into a check in the brief.
- Precedence: env `CLAUDE_CODE_EFFORT_LEVEL` > per-call `effort` > frontmatter > session. For the model: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` > per-call `model` > frontmatter > `CLAUDE_CODE_SUBAGENT_MODEL` > the lead's model. Keep the env variables unset and pass both on every Agent call.
- Global settings: no top-level `effortLevel`; Claude Code starts all four current models at medium, and a per-model `modelSettings.<id>.effortLevel` of medium keeps a saved `/effort` choice from moving every call.
- Not used by default: `opusplan`, the advisor tool, fast mode (an owner decision per session).

## The lead never
- reads PDFs and images; reads transcripts, logs and files over 100 lines whole;
- writes package code; runs checks synchronously; polls agents (it waits in the background);
- measures its own context by itself (only `ctx.cjs --session <id>`); applies `/clear`;
- asks an agent to return its reasoning (output tokens settle in the window).

## Thresholds and state
- STATE.md (template `templates/STATE.md`) at most 8192 bytes: package and stage, branch and SHA, `head` and `seq`, `in_flight`, decisions, blockers, checks, authority, `unanswered_owner_messages`. The source of truth is STATE, not the conversation.
- An agent waits up to ~10 min in the foreground with output to a file; it never starts work of unknown length or over 15 min.
- Recommended stop-loss per agent: about 80 calls or 45 min, checkpoint at 50, stop after 12 calls without progress.
- While waiting for a background `full` the lead may idle for a long time: wake up on the notification, do not poll.

## SendMessage or a new agent
- A clarification on the same task (at most 5 calls, not later than an hour) - SendMessage to the same agent. Otherwise - a new agent working from the diff. A second `CHANGES_REQUIRED` - a new brief.
- An agent cut off by `maxTurns` (partial): resume once, then BLOCKED. An implementer over the stop-loss - diagnosis; over 150 requests - a decision: finish, hand over the stage or block.
