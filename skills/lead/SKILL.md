---
name: lead
description: Lead skill (was ghorc:orc) - how the Opus lead delegates to Sonnet subagents, routes by model and effort, keeps its context small and hands the shift over. Load at the start of a lead session, when delegating, or when choosing model or effort.
user-invocable: true
---
# Orchestrating lead

Project config: `.claude/ghorc.json` (checks, critical areas, thresholds). Plugin roles: `ghorc:implementer`, `ghorc:reviewer`, `ghorc:reviewer-critical`, `ghorc:integrator`, `ghorc:release`, `ghorc:scout`, `ghorc:consult`, `ghorc:media`.

## Rules on one page
1. The lead is Opus/medium; model and effort are set explicitly at launch (`--model opus --effort medium`); a global fallback does not replace this for a role.
2. The implementer is Sonnet/medium; money, recovery, migrations - Sonnet/high (never Opus on a critical package).
3. Ordinary review and re-check of fixes of an ordinary package - Sonnet/medium; critical review - Opus/high in round 1; on a critical package the final verdict and the check of money findings are Opus/high, and Sonnet checks only non-critical findings.
4. Opus again - if a fix changes a money invariant.
5. Haiku/low - only mechanical work with a machine-checkable result; not browser work, not scouting.
6. Fable - arbiter of a disputed question or a consultation; not the lead and not the default reviewer.
7. Small things (at most 2 commands, output at most 100 lines, no package code edits) the lead does itself; anything bigger goes to a file or an agent.
8. On every Agent call pass `effort` explicitly from the table below; do not rely on frontmatter or global settings. When the implementer model equals the reviewer's default model, pass `model` on the reviewer call so that they differ, and say so in the brief. When the project defines its own roles in `.claude/agents/`, launch those instead of the `ghorc:*` roles and keep the same effort table.
9. The lead does not read PDFs and images, transcripts, logs and files over 100 lines whole (a diff - by `--stat` and by file). Attachments go as a file with a path to the `ghorc:media` role. PDFs are converted to text/PNG beforehand.
10. The lead does not write package code, does not run checks synchronously, does not poll agents.
11. The lead reads context with `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.cjs"` at a stage boundary (the status line writes the file). The lead reads its own session id from the SessionStart line (`session=<id>`) or the `#id` status line segment, then runs `ctx.cjs --session <id>` (never a guess of the newest file): `thresholds.ctxPrepare` (120K) - refresh STATE; `thresholds.ctxHandoff` (150K) - take no new package, skill `ghorc:handoff`; ~170K - hand over at the nearest stage boundary. `ctx.cjs` also prints unread watchdog alerts: act on them.
12. Do not pull large output in; if it was pulled in, `/rewind` is done by the owner. `/clear` is not used by the lead.
13. In chat at most 25 lines; an agent report at most 25 lines (review at most 30); anything large goes to a file.
14. A brief is one tagged structure (skill `ghorc:brief`); an ordinary one is at most 500 words, a critical review at most 800; over 200 lines is a task-statement error.
15. Checks only through the commands from the config `checks`; a bare test runner and `full` are forbidden for agents.
16. `full` - one, on the final tree, lead only, in the background, after fast; it runs on the merge SHA and the report quotes that SHA; incomplete - cause first, restart only the failed phase. Heavy commands are denied also for `GHORC_ROLE=worker`; subagents may not run `claude -p` or `herdr agent start|prompt`.
17. Review limit - 3 rounds; a second `CHANGES_REQUIRED` means the lead changes the task statement rather than sending the same implementer again.
18. There is no sub-lead; by default direct Agent calls; a herdr worker - when the task waits on an external event for longer than about 15 minutes (a pipeline, a release), must survive a lead restart, or the owner wants to watch or answer it; otherwise an Agent call (cheaper, and only Agent calls reach the ledger). `GHORC_ROLE` is optional: a plain main session is the lead. A herdr worker starts with `GHORC_ROLE=worker` (bash: `GHORC_ROLE=worker herdr agent start ...`; PowerShell: `$env:GHORC_ROLE='worker'; herdr agent start ...`), otherwise it will receive the lead reminder. `GHORC_ROLE=lead` is only needed for the optional strict mode (`leadNoMedia`, `heavyGuard.requireLeadEnv`).
19. Limit: the lead plus 2 workers in total (agents and workers together); one heavy check per machine.
20. "Significant" for a consultation - any of: money/data/recovery; an external contract or migration; a hard-to-reverse dependency; a conflict of key requirements; two failed approaches. Composition: a counterpart plus a critic, one round.

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
| Waits >~15 min on an external event, must survive a lead restart, or owner watches/answers | herdr worker, `--effort` explicit | - |

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
- STATE.md (template `templates/STATE.md`) 40-80 lines: package and stage, branch and SHA, `head` and `seq`, `in_flight`, decisions, blockers, checks, authority, `unanswered_owner_messages`. The source of truth is STATE, not the conversation.
- While waiting for a background `full` the lead may idle for a long time: wake up on the notification, do not poll.

## SendMessage or a new agent
- A clarification on the same task (at most 5 calls, not later than an hour) - SendMessage to the same agent. Otherwise - a new agent working from the diff. A second `CHANGES_REQUIRED` - a new brief.
- An agent cut off by `maxTurns` (partial): resume once, then BLOCKED. An implementer over 120 requests - diagnosis; over 150 - a decision: finish, hand over the stage or block.
