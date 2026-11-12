<!-- ghorc -->
## Orchestration (ghorc)

The `ghorc` plugin provides roles, skills and hooks. Project settings live in `.claude/ghorc.json`. At the start of a
session the lead loads the `ghorc:lead` skill; `/ghorc:status` shows role, guards and the denial log. `GHORC_ROLE` is
optional: a plain main session is the lead.

### Roles
| Role | Model / effort | Purpose |
|---|---|---|
| `ghorc:implementer` | sonnet / medium (money, migrations - high) | code, tests, documents from a brief |
| `ghorc:reviewer` | sonnet / medium | ordinary diff review |
| `ghorc:reviewer-critical` | opus / high | critical review, final verdict of a critical package |
| `ghorc:scout` | sonnet / low | facts with `file:line` written to a file |
| `ghorc:integrator` | sonnet / medium | merge conflicts, red checks |
| `ghorc:release` | sonnet / medium | release, only on the owner's word |
| `ghorc:consult` | sonnet / low | consultations with external models |
| `ghorc:media` | sonnet / low | the only role for PDFs and images |

Project roles: if `.claude/agents/*.md` exist, they take precedence over the plugin roles above for the same purpose;
the lead launches them by name with explicit `model` and `effort`. Map them here (project role | model / effort |
plugin counterpart).

### Project checks
- fast: `<command>` (run by agents and the lead)
- full: `<command>` (one at a time, lead only, in the background, after fast)
- A bare test runner and full are forbidden for agents.

### Critical areas
`<money, contracts, policy, hooks: paths and invariants>`. Edits here go to the critical reviewer (`ghorc:reviewer-critical`, or the project's own critical reviewer role at
opus / high).

### Lead rules
- The lead is started explicitly: `--model opus --effort medium` (default; an owner may run a stronger lead, which then only orchestrates). On every Agent call pass `effort` explicitly from the
  table in skill `ghorc:lead`; do not rely on frontmatter or global settings.
- The lead does not read PDFs and images (role `ghorc:media`), does not read logs or files over 100 lines whole, does
  not write package code, does not run checks synchronously, does not poll agents.
- Small things (at most 2 commands, output at most 100 lines) - do them yourself; the rest goes to agents, large output
  to a file.
- Context thresholds (`node "<plugin>/scripts/ctx.cjs" --session <id>`, id from SessionStart or the `#id` status
  segment): `thresholds.ctxPrepare` - refresh STATE; `ctxWarn` - prepare the handoff, take no new package, and with no
  agents in flight start it at once; `ctxHandoff` - handoff mode, skill `ghorc:handoff`. Keep `ctxHandoff` + 35K at or
  below the autocompact point (5K overshoot, 25K handoff, 5K spare).
- A brief is written with skill `ghorc:brief`; an ordinary one is at most 500 words. An agent report is at most 25 lines
  (review at most 30), large output to a file.
- Review: at most 2 fix rounds, then a closure check (a separate agent only for a critical package, otherwise the same
  reviewer checks the fix diff); a second CHANGES_REQUIRED means the lead changes the task statement. Every finding
  gets a recorded fate: taken, queued with an id, or rejected with a reason.
- Inside a terminal backend (hc or herdr; `node scripts/backend.cjs` tells which) every package, review and the integrator run as a tab with a report file; an Agent call only for
  scouting up to about 5 minutes and for memory. Tab workers do not reach the ledger. The result is the LAST line of the
  report file: `DONE <name>` / `BLOCKED <name>: <reason>` / `HANDOFF <name>`; a review ends with `VERDICT <...>`. Names:
  lead `lead-*`, worker `<package>-<role>`. Long-lived tabs on hc only with `--outlive-parent`. Close a worker tab right
  after accepting its result. Backend with both present: `backend.prefer`; worker permission arguments: `worker.permissionArgs`.
- Limit: `capacity.agents` when the capacity guard is enabled, otherwise bounded by machine load; one heavy check
  per machine. The heavy guard also applies to `GHORC_ROLE=worker`; subagents may not run `claude -p`,
  `herdr agent start|prompt|send-keys`, `herdr pane run|send-keys|send-text` or `hc run|exec|keys|interrupt`.
- Reports, scratch and large output go to `.claude/ghorc-out/` (git-excluded by setup).
- An agent waits up to ~10 min in the foreground with output to a file; it never starts work of unknown length or over 15 min.
  Stop-loss per agent: about 80 calls or 45 min, checkpoint at 50, stop after 12 calls without progress.
- State lives in `STATE.md` (at most 8192 bytes); it is the source of truth, not the conversation.
