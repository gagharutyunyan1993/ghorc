---
name: lead
description: Lead skill (was ghorc:orc) - how the Opus lead delegates to Sonnet subagents, routes by model and effort, keeps its context small and hands the shift over. Load at the start of a lead session, when delegating, or when choosing model or effort.
user-invocable: true
---
# Orchestrating lead

Project config: `.claude/ghorc.json` (checks, critical areas, thresholds). Plugin roles: `ghorc:implementer`, `ghorc:reviewer`, `ghorc:reviewer-critical`, `ghorc:integrator`, `ghorc:release`, `ghorc:scout`, `ghorc:consult`, `ghorc:media`.

## Rules on one page
1. The lead is Opus/medium by default; model and effort are set explicitly at launch (`--model opus --effort medium`); a global fallback does not replace this for a role. An owner may run the lead on a stronger model; it then only orchestrates.
2. The implementer is Sonnet/medium; money, recovery, migrations - Sonnet/high (never Opus on a critical package).
3. Ordinary review and re-check of fixes of an ordinary package - Sonnet/medium; critical review - Opus/high in round 1; on a critical package the final verdict and the check of money findings are Opus/high, and Sonnet checks only non-critical findings.
4. Opus again - if a fix changes a money invariant.
5. Haiku/low - only mechanical work with a machine-checkable result; not browser work, not scouting.
6. Fable - arbiter of a disputed question or a consultation; not the lead and not the default reviewer.
7. Small things (at most 2 commands, output at most 100 lines, no package code edits) the lead does itself; anything bigger goes to a file or an agent.
8. On every Agent call pass `effort` explicitly from the table below; do not rely on frontmatter or global settings. When the implementer model equals the reviewer's default model, pass `model` on the reviewer call so that they differ, and say so in the brief. When the project defines its own roles in `.claude/agents/`, launch those instead of the `ghorc:*` roles and keep the same effort table.
9. The lead does not read PDFs and images, transcripts, logs and files over 100 lines whole (a diff - by `--stat` and by file). Attachments go as a file with a path to the `ghorc:media` role. PDFs are converted to text/PNG beforehand.
10. The lead does not write package code, does not run checks synchronously, does not poll agents.
11. The lead reads context with `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.cjs"` at a stage boundary (the status line writes the file). The lead reads its own session id from the SessionStart line (`session=<id>`) or the `#id` status line segment, then runs `ctx.cjs --session <id>` (never a guess of the newest file): `thresholds.ctxPrepare` - refresh STATE; `thresholds.ctxWarn` - prepare the handoff, take no new package, and with no agents in flight start the handoff at once; `thresholds.ctxHandoff` - handoff mode, skill `ghorc:handoff` (`ctxWarn` 0 means `ctxHandoff` - 10K). Set `ctxHandoff` + 35K at or below the autocompact point (5K overshoot, 25K handoff, 5K spare). `ctx.cjs` also prints unread watchdog alerts: act on them. The context guard hook enforces these thresholds for you (UserPromptSubmit / PreToolUse / Stop): from `ctxHandoff` (and, with `handoff.stickyOnCompact`, from any compaction, when the numbers are unreliable and the session is a proven lead: `GHORC_ROLE=lead`, or no role and a terminal that proves it) a new Agent and edits outside STATE/HANDOFF are denied, and Stop blocks (with the sticky key: once per turn until HANDOFF says `status: SENT` for this session); obey its lines instead of working around them. Before launching a candidate push the in-flight branches (skill `ghorc:handoff`).
12. Do not pull large output in; if it was pulled in, `/rewind` is done by the owner. `/clear` is not used by the lead.
13. In chat at most 25 lines; an agent report at most 25 lines (review at most 30); anything large goes to a file.
14. A brief is one tagged structure (skill `ghorc:brief`); an ordinary one is at most 500 words, a critical review at most 800; over 200 lines is a task-statement error.
15. Checks only through the commands from the config `checks`; a bare test runner and `full` are forbidden for agents.
16. `full` - one, on the final tree, lead only, in the background, after fast; it runs on the merge SHA and the report quotes that SHA; incomplete - cause first, restart only the failed phase. Heavy commands are denied also for `GHORC_ROLE=worker`; subagents and workers may not run `claude -p`, `herdr agent start|prompt|send-keys`, `herdr pane run|send-keys|send-text`, `hc run|exec|keys|interrupt`, or `hc send` to anyone but their own parent (a worker reports to its parent with `hc send`; a subagent never).
17. Review limit - at most 2 fix rounds (config `review.maxFixRounds`), then a closure check instead of a full re-review. A separate closure-check agent only for a critical package (Opus/high); on an ordinary package the same reviewer checks the fix diff. Input: the basis of each taken finding, the fix diff, the surrounding code and the test. Output: closed or not closed with evidence per finding, plus a scan of the fix diff for new P0/P1. Every finding gets a recorded fate: taken, queued with an id, or rejected with a reason. A full re-review only when the fixes went beyond the findings and changed behaviour. P0/P1 still open after round 2: blocked, and the lead narrows the task. A second `CHANGES_REQUIRED` means the lead changes the task statement (cause first) rather than sending the same implementer again.
18. There is no sub-lead. Inside a terminal backend (`hc` or `herdr`, see "Terminal backend" below; owner's rule of 2026-11-01) every package, every review and the integrator run as a separate tab (a worker) and write their result to the report file named in the brief; an in-process Agent call is only for scouting of up to about 5 minutes and for writing memory. Why: background agents inside the lead are invisible to the owner, and work stood still because of that. Tradeoff: tab workers do not reach the ledger (only Agent calls do). With backend `none` the default stays direct Agent calls. `GHORC_ROLE` is optional: a plain main session is the lead. A worker gets its role at start: on `herdr` from the tab (`herdr tab create --env GHORC_ROLE=worker ...`, then start the agent in that pane with `--pane <pane_id>`; `GHORC_ROLE=worker herdr agent start ...` does NOT reach the session, because the agent is typed into the pane's shell); on `hc` through `env` in the command (`hc run` has no `--env`). Without it the worker receives the lead reminder and, after a compaction or at the handoff threshold, the lead's handoff block; a roleless session counts as the lead there when its terminal proves it (hc: tab named with `capacity.leadNamePrefix` or no parent; herdr: tab label starting with the prefix), so `GHORC_ROLE=worker` is the only reliable way to keep a worker out. Check its SessionStart line for `role=worker`. `GHORC_ROLE=lead` is only needed for the optional strict mode (`leadNoMedia`, `heavyGuard.requireLeadEnv`).
19. Limit: `capacity.agents` (agents and workers together) when the capacity guard is enabled, otherwise bounded by machine load (CPU, free RAM); one heavy check per machine. A lead is also recognised without `GHORC_ROLE` by a tab/terminal name prefix `capacity.leadNamePrefix`.
20. "Significant" for a consultation - any of: money/data/recovery; an external contract or migration; a hard-to-reverse dependency; a conflict of key requirements; two failed approaches. Composition: a counterpart plus a critic, one round.

## Terminal backend (before any tab or agent command)
Two terminal backends exist and a machine may have either, both, or none. Never assume one: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/backend.cjs"` first (JSON; `--name` prints the word) and use only the forms of its answer. `hc` = `HC_TERMINAL_ID` is set (herdr-app, `hc --skill` is its manual); `herdr` = `HERDR_ENV=1` and `herdr agent list` answers (the older CLI); `none` = neither (use Agent calls and the `/clear` fallback; run no tab command). If both are set, `backend.prefer` decides (`hc` default, or `herdr`).

| Action | `hc` | `herdr` |
|---|---|---|
| Start a worker with a role | `hc run --bg --name <n> --cwd <dir> "C:\Program Files\Git\usr\bin\env.exe" GHORC_ROLE=worker claude.exe --model <m> --effort <e> <worker.permissionArgs> "<task>"` | `herdr tab create --label <n> --cwd <dir> --env GHORC_ROLE=worker`, then `herdr agent start <n> --kind claude --pane <pane_id> -- --model <m> --effort <e> <worker.permissionArgs>`, then `herdr pane run <pane_id> "<task>"` |
| Wait | `hc wait <n>` (foreground; `hc wait --children any\|all`) | `herdr agent wait <n> --until idle --until done --until blocked --timeout <ms>`, then `agent read` (a comma list does not work) |
| Read | `hc read <n> --lines 100` | `herdr agent read <n>` |
| Send text | `hc send <n> "<text>"` | `herdr pane run <pane_id> "<text>"` |
| Close (right after accepting the result) | `hc kill <n>; hc rm <n>` | close the tab (`/exit` via `herdr pane run`, owner rule in handoff) |
| List / state | `hc ls`, `hc get <n>` | `herdr agent list`, `herdr agent get <n>` |

A worker finishes with a report file; its LAST line is the signal: `DONE <name>` / `BLOCKED <name>: <reason>` / `HANDOFF <name>`; a review ends with `VERDICT <ACCEPT|ACCEPT_WITH_NOTES|CHANGES_REQUIRED|BLOCKED>`. `worker.permissionArgs` (default empty) is appended to every worker start the way the candidate gets `handoff.candidatePermissionArgs`. Tab names: lead `lead-*`, worker `<package>-<role>`. Long-lived tabs (trains, integrator, `full`, runners) on `hc` only with `--outlive-parent`, otherwise closing the lead kills them. Close a worker tab right after accepting its result; at handoff close finished children and pass live ones to the new lead. A worker on `hc` reports with `hc send <parent> "<line>"`, the parent address is in its `hc get $HC_TERMINAL_ID` `parent` field. The capacity guard counts workers of the active backend only (on `none`: none). Handoff forms (READY/ACTIVATE): skill `ghorc:handoff`.

## Capacity guard (only when `capacity.enabled` is true in `.claude/ghorc.json`)
If a prompt line says `agents N/M, CPU X%, free Y GB` or Stop returns your turn as "Machine underloaded", the machine has room: start work that can move in parallel (a package, a review, a scout) or end the answer with a line `Idle: <reason>` (the marker is `capacity.idleMarker`; the reason must be a real one, for example "waiting for the owner" or "CPU busy with a foreign process"). `WEEKLY CAP` in the line means no new agents at all: only merge what is ready. Without the line and the hook nothing here applies.

## Routing
| Class of work | Role / model | Effort |
|---|---|---|
| Lead | Opus | medium |
| Ordinary implementer | `ghorc:implementer` sonnet | medium |
| Edit by a ready pattern | `ghorc:implementer` | low |
| Money, recovery, migrations | `ghorc:implementer` | high |
| Architecture with clear constraints | Opus | medium (conflicting invariants - high) |
| Ordinary review, re-check of fixes | `ghorc:reviewer` sonnet | medium |
| Critical review (contract, policy, hook, money) | `ghorc:reviewer-critical` opus | high |
| Scouting (facts about code, git) | `ghorc:scout` sonnet | low-medium |
| Mechanical work with a machine check | Haiku | low |
| Attachments (PDFs, screenshots) | `ghorc:media` sonnet | low |
| Consultation with external models | `ghorc:consult` sonnet | low |
| Dispute, arbiter | Fable, targeted | medium-high |
| Merge conflict, red pipeline | `ghorc:integrator` | medium |
| Release (only on the owner's word) | `ghorc:release` | medium |
| Backend `hc` or `herdr`: any package, review or integrator; backend `none`: waits >~15 min, must survive a lead restart, or owner watches/answers | herdr worker (tab) with a report file, `--effort` explicit | - |

## Effort
Roles keep their frontmatter effort; the lead raises it for one named condition and writes that condition in the brief.

| Role | Default | Moves up when |
|---|---|---|
| `implementer` | sonnet / medium | high: critical area (money, contracts, policy, hooks, migrations), concurrency/IPC state, or a bug whose cause is not named in the brief |
| `reviewer` | sonnet / medium | high: diff over 5 files or 300 lines, or shared state/concurrency |
| `reviewer-critical` | opus / high | xhigh: only a single named task on a disputed P0 reproduction |
| `scout` | sonnet / low | medium: sources conflict or a cross-file inference is needed |
| `integrator` | sonnet / medium | high: the resolution changes behavior, or a check stays red after resolution |
| `consult`, `media` | sonnet / low | medium: conflicting answers to adjudicate / charts or contracts to interpret |
| `release` | sonnet / medium | none |

The thresholds (5 files, 300 lines) are provisional until the ledger (`docs/evidence.md`) replaces them.

- The implementer on a critical package is Sonnet high, never Opus: the critical reviewer is Opus and the models must differ. Its escalation path: reformulate, then high, then split the task. A switch to Opus is allowed only on non-critical packages.
- Sonnet high is eligible when the scope is bounded (at most 4 writable files), the acceptance command is deterministic and the cause is named. "Investigate" or an unclear cause across subsystems goes to Opus medium on non-critical packages only.
- Cause first, effort second. On CHANGES_REQUIRED with P0/P1 the lead classifies the cause before re-briefing: `BRIEF_OMISSION` (the brief lacked a fact or a check) - fix the brief, same effort; `SKIPPED_CHECK` (the agent did not run a check it could run) - add the check line, same effort; `REASONING_FAILURE` (the brief was complete, the agent reasoned wrong) - the next implementer call goes one level up (medium to high). A second CHANGES_REQUIRED with P0/P1 changes the task statement or splits it; no further raise. A fourth code, `OTHER` (a cause outside the three: environment, flaky check, owner change), never changes effort. The cause is required on CHANGES_REQUIRED and absent on ACCEPT; the verdict command takes an optional `--class critical|ordinary`. Network failure, out of memory or a wrong command never raise effort. There is no automatic downshift; the table changes only through the ledger. The critical reviewer stays high in every round. The lead records the verdict with `/ghorc:status --verdict <pkg> <round> <verdict> <cause>`.
- Pre-mortem for a critical package: before writing the brief, list at most 3 ways the package could pass review and still be wrong, and turn each into a check in the brief.
- Precedence: env `CLAUDE_CODE_EFFORT_LEVEL` > per-call `effort` > frontmatter > session. Keep the variable unset, and pass `effort` on every Agent call.
- Global settings: no top-level `effortLevel`; per-model medium for sonnet-5.5 and opus-5.5, so an Agent call that omits effort never lands on low or high by accident.

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
