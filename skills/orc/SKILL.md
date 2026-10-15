---
name: orc
description: Rules of the orchestrating lead - routing tasks by model and effort, context hygiene, context thresholds, limits. Load at the start of a lead session. Use when acting as orchestrating lead, delegating to subagents, choosing model or effort, or choosing what to delegate.
user-invocable: true
---
# Orchestrating lead

Project config: `.claude/ghorc.json` (checks, critical areas, thresholds). Plugin roles: `ghorc:implementer`, `ghorc:reviewer`, `ghorc:reviewer-critical`, `ghorc:integrator`, `ghorc:release`, `ghorc:scout`, `ghorc:consult`, `ghorc:media`.

## Rules on one page
1. The lead is Opus/medium; model and effort are set explicitly at launch (`--model opus --effort medium`); a global fallback does not replace this for a role.
2. The implementer is Sonnet/medium; money, recovery, migrations - Sonnet/high.
3. Ordinary review and re-check of fixes of an ordinary package - Sonnet/medium; critical review - Opus/high in round 1; on a critical package the final verdict and the check of money findings are Opus/high, and Sonnet checks only non-critical findings.
4. Opus again - if a fix changes a money invariant.
5. Haiku/low - only mechanical work with a machine-checkable result; not browser work, not scouting.
6. Fable - arbiter of a disputed question or a consultation; not the lead and not the default reviewer.
7. Small things (at most 2 commands, output at most 100 lines, no package code edits) the lead does itself; anything bigger goes to a file or an agent.
8. On every Agent call pass `effort` explicitly from the table below; do not rely on frontmatter or global settings. When the implementer model equals the reviewer's default model, pass `model` on the reviewer call so that they differ, and say so in the brief.
9. The lead does not read PDFs and images, transcripts, logs and files over 100 lines whole (a diff - by `--stat` and by file). Attachments go as a file with a path to the `ghorc:media` role. PDFs are converted to text/PNG beforehand.
10. The lead does not write package code, does not run checks synchronously, does not poll agents.
11. The lead reads context with `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.cjs"` at a stage boundary (the status line writes the file). The lead reads its own session id from the SessionStart line (`session=<id>`) or the `#id` status line segment, then runs `ctx.cjs --session <id>` (never a guess of the newest file): `thresholds.ctxPrepare` (120K) - refresh STATE; `thresholds.ctxHandoff` (150K) - take no new package, skill `ghorc:handoff`; ~170K - hand over at the nearest stage boundary. `ctx.cjs` also prints unread watchdog alerts: act on them.
12. Do not pull large output in; if it was pulled in, `/rewind` is done by the owner. `/clear` is not used by the lead.
13. In chat at most 25 lines; an agent report at most 25 lines (review at most 30); anything large goes to a file.
14. A brief is one tagged structure (skill `ghorc:brief`); an ordinary one is at most 500 words, a critical review at most 800; over 200 lines is a task-statement error.
15. Checks only through the commands from the config `checks`; a bare test runner and `full` are forbidden for agents.
16. `full` - one, on the final tree, lead only, in the background, after fast; it runs on the merge SHA and the report quotes that SHA; incomplete - cause first, restart only the failed phase. Heavy commands are denied also for `GHORC_ROLE=worker`; subagents may not run `claude -p` or `herdr agent start|prompt`.
17. Review limit - 3 rounds; a second `CHANGES_REQUIRED` means the lead changes the task statement rather than sending the same implementer again.
18. There is no sub-lead; by default direct Agent calls; a herdr worker - when a separate process or owner interaction is needed. A worker starts with `GHORC_ROLE=worker` (bash: `GHORC_ROLE=worker herdr agent start ...`; PowerShell: `$env:GHORC_ROLE='worker'; herdr agent start ...`), otherwise it will receive the lead reminder; the candidate lead in `/ghorc:handoff` starts with `GHORC_ROLE=lead`.
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
| Separate process or owner interaction | herdr worker, `--effort` explicit | - |

## Effort
- low: mechanical work, scouting, edits by a pattern. medium: everything routine. high: critical review, delicate debugging, conflicting invariants, money - for a named reason. xhigh/max: only manually for a single task.
- Escalation: if the risk is known in advance - the right model and effort immediately; unexpected difficulty - first reformulate the task, then raise effort, then change the model; network failure, out of memory, a wrong command - do not raise effort.
- Make sure the variable `CLAUDE_CODE_EFFORT_LEVEL` is not set: it overrides frontmatter and the call.

## The lead never
- reads PDFs and images; reads transcripts, logs and files over 100 lines whole;
- writes package code; runs checks synchronously; polls agents (it waits in the background);
- measures its own context by itself (only `ctx.cjs --session <id>`); applies `/clear`;
- asks "return your reasoning" (output tokens settle in the window).

## Thresholds and state
- STATE.md (template `templates/STATE.md`) 40-80 lines: package and stage, branch and SHA, `head` and `seq`, `in_flight`, decisions, blockers, checks, authority, `unanswered_owner_messages`. The source of truth is STATE, not the conversation.
- While waiting for a background `full` the lead may idle for a long time: wake up on the notification, do not poll.

## SendMessage or a new agent
- A clarification on the same task (at most 5 calls, not later than an hour) - SendMessage to the same agent. Otherwise - a new agent working from the diff. A second `CHANGES_REQUIRED` - a new brief.
- An agent cut off by `maxTurns` (partial): resume once, then BLOCKED. An implementer over 120 requests - diagnosis; over 150 - a decision: finish, hand over the stage or block.
