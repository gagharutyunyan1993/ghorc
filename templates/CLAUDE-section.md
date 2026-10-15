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

### Project checks
- fast: `<command>` (run by agents and the lead)
- full: `<command>` (one at a time, lead only, in the background, after fast)
- A bare test runner and full are forbidden for agents.

### Critical areas
`<money, contracts, policy, hooks: paths and invariants>`. Edits here go to `ghorc:reviewer-critical`.

### Lead rules
- The lead is started explicitly: `--model opus --effort medium`. On every Agent call pass `effort` explicitly from the
  table in skill `ghorc:lead`; do not rely on frontmatter or global settings.
- The lead does not read PDFs and images (role `ghorc:media`), does not read logs or files over 100 lines whole, does
  not write package code, does not run checks synchronously, does not poll agents.
- Small things (at most 2 commands, output at most 100 lines) - do them yourself; the rest goes to agents, large output
  to a file.
- Context thresholds (`node "<plugin>/scripts/ctx.cjs" --session <id>`, id from SessionStart or the `#id` status
  segment): 120K - refresh STATE; 150K - take no new package, skill `ghorc:handoff`; ~170K - hand over at a stage
  boundary.
- A brief is written with skill `ghorc:brief`; an ordinary one is at most 500 words. An agent report is at most 25 lines
  (review at most 30), large output to a file.
- Review: at most 3 rounds; a second CHANGES_REQUIRED means the lead changes the task statement.
- Limit: the lead plus 2 workers in total; one heavy check per machine. The heavy guard also applies to
  `GHORC_ROLE=worker`; subagents may not run `claude -p` or `herdr agent start|prompt`.
- Reports, scratch and large output go to `.claude/ghorc-out/` (git-excluded by setup).
- State lives in `STATE.md` (40-80 lines); it is the source of truth, not the conversation.
