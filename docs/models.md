# Models and effort

ghorc picks a model and an effort for every role and class of work. This page is the single source of those choices
and of why each one was made. The operative copy the lead follows is the Routing table in skill `ghorc:lead`; the
tables in `README.md`, `docs/workflow.md` and `templates/CLAUDE-section.md` repeat only the role defaults.

The starting point is Anthropic's guide
["Which Claude model should you build with?"](https://claude.dev/blog/which-claude-model-should-you-build-with/)
(Nov 2026), with its companion posts on effort and on task cost. Where ghorc departs from the guide, the row says why.

## Model families, never versions

ghorc names models only by their aliases: `haiku`, `sonnet`, `opus`, `fable`. Claude Code resolves each alias to the
newest model of that family on the Anthropic API, so a new release is picked up without a change here. Two caveats
from the guide: on Amazon Bedrock, Google Cloud, Microsoft Foundry and Claude Platform on AWS the `haiku` alias still
resolves to the previous Haiku generation, and the newest Haiku needs Claude Code v2.1.293 or later; `ANTHROPIC_DEFAULT_HAIKU_MODEL` pins what the
alias means there. The roles' frontmatter, the
Routing table, the briefs and `lead.model` use aliases only; `/ghorc:setup` learns the full id of the lead model from
the session's own status line file instead of a table. The one place that lists model ids is the price table of the
ledger (`scripts/lib/prices.cjs`), because a price belongs to one model id; a model that is not in it is reported as
unpriced, never priced with an older model's numbers.

| Family | Cost per token | Speed | In ghorc |
|---|---|---|---|
| `haiku` | lowest (about a twentieth of Sonnet on short prompts) | fastest | logs and test output, mechanical work with a machine check |
| `sonnet` | about half of Opus | fast | workers: implementer, reviewer, scout, integrator, media, consult, release |
| `opus` | the reference | moderate | the lead; critical review; migrations and performance work; unclear causes |
| `fable` | twice Opus on uncached input and output; the same cache-read price | moderate | lead of major work; arbiter; critical review of Opus work |

Ratios are the guide's at the time of writing; current numbers are in `scripts/lib/prices.cjs`. On a long, cache-heavy
run the gap between Fable and Opus comes down to uncached input and output, because a cache read costs both the same.

## Routing

| Class of work | Role | Model / start effort | Next step if it falls short | Guide row, or why ghorc differs |
|---|---|---|---|---|
| Lead, everyday work | lead | opus / medium | high, then the next handoff on fable / medium | "Not sure yet" and "Everyday engineering": Opus at medium |
| Lead of a major refactor, migration or architecture plan, many packages in parallel, a long unattended run | lead | fable / medium | high | "Major refactors, migrations, architecture planning, leading many subagents": Fable |
| Well-scoped implementation: a bug with a named cause, a feature from a spec | `implementer` | sonnet / medium | high, then opus / medium (ordinary packages only) | "Well-scoped coding": Sonnet at medium, then high |
| Edit by a ready pattern | `implementer` | sonnet / low | medium | Effort post: low for mechanical work (renames, a known pattern) |
| Money, recovery | `implementer` | sonnet / high | opus / medium, the critical reviewer then fable / medium | ghorc starts on Sonnet so the Opus critical reviewer differs; past high the guide's next step is the next model up at a lower effort |
| Migration, performance optimization | `implementer` | opus / medium | high, then fable / medium | "A clear spec alone does not justify Sonnet": migrations and performance work need Opus |
| Major migration (many modules, a data model, a contract) | `implementer` | fable / medium | high | Guide: "or Fable if major"; the critical reviewer is then Opus |
| Investigation, a cause unclear across subsystems (ordinary packages) | `implementer` | opus / medium | high | "Everyday engineering, debugging": Opus |
| Ordinary review, re-check of fixes | `reviewer` | sonnet / medium | high | "Repeated agent tasks: investigation, review, drafting": Sonnet at medium |
| Critical review of Sonnet work (money, recovery, contracts, policy, hooks) | `reviewer-critical` | opus / high | a disputed P0 goes to the arbiter | Effort post: high where verification and edge cases matter |
| Critical review of Opus work (migration, performance) | `reviewer-critical`, `model: fable` | fable / medium | a disputed P0 goes to the arbiter | ghorc's own rule, not the guide's: a critical reviewer runs on another model than the implementer, and is not the weaker one; past Opus that is the guide's next model up at a lower effort |
| Critical review of Fable work | `reviewer-critical` | opus / high | a disputed P0 goes to the arbiter | ghorc's rule (another model); Opus at high is the strongest other model |
| Scouting: facts about code and git | `scout` | sonnet / medium | high | "Subagents that search files, read logs, or summarize": Haiku or Sonnet at the model's default; ghorc keeps Sonnet because scout facts become briefs, and a wrong fact costs a whole package |
| Logs and test output: which cases failed, first error line | `log-reader` | haiku / medium | `scout` on sonnet | "Subagents that read logs": Haiku; a mistake is cheap to spot against the log |
| Mechanical work with a machine check | ad hoc (brief Template 3) | haiku / medium | sonnet / low | "Classification, routing, extraction": Haiku at its default |
| Attachments: PDFs, images | `media` | sonnet / medium | high; opus / medium for a long vision-heavy loop | "Everyday documents": Sonnet; "Computer use and vision-heavy workflows": Opus |
| Consultation in a browser | `consult` | sonnet / low | medium | Paste, wait, save: a wrong answer file is cheap to spot |
| Architecture with clear constraints | lead or an ad hoc agent | opus / medium | high, then fable / medium | Bounded design is everyday engineering |
| Architecture plan for a major change | ad hoc agent or the lead | fable / medium | high | "Architecture planning": Fable |
| Dispute, arbiter, disputed P0 | ad hoc agent | fable / medium | high | "Past high, test the next model up at a lower effort" |
| Critic of a significant decision or plan | `methodology-toolkit:red-team-critic` | opus / medium | high; fable / medium for a migration, data-model or external-contract decision | A judgement call stays on the main model; the fresh context, not another model, makes the critic independent of an Opus author; Fable (twice Opus on uncached input and output) only where a wrong call is hardest to reverse |
| Sourced facts for product, market or vendor questions | `methodology-toolkit:evidence-scout` | sonnet / medium | high | Search work at the model's default; the facts feed a decision, so Sonnet rather than Haiku |
| Merge conflict, red check | `integrator` | sonnet / medium | high, then opus / medium | Conflicts are well-scoped; an unclear red cause is debugging |
| Release (only on the owner's word) | `release` | sonnet / medium | none | A fixed procedure |

## Escalation

The guide's order, in ghorc terms:

1. **Verification first.** If the agent could not check its own work (no test, build or command in the brief), add the
   check, not effort. This is the ledger cause `SKIPPED_CHECK` or `BRIEF_OMISSION`: same model, same effort.
2. **One effort level up.** Only after a `REASONING_FAILURE` on a brief that was complete.
3. **The next model up, at a lower effort.** Past `high` do not raise effort; start the next model at `medium`. One
   level past `high` can cost as much as a bigger model (the guide's SWE-bench Pro numbers: `xhigh` about 1.4 points over
   `high` at 2.5 times the cost). Higher effort does not add knowledge the model lacks: a wrong approach needs a
   different brief or a bigger model, not more effort.
4. A second `CHANGES_REQUIRED` changes the task statement or splits it; nothing is raised further. This is also the
   end of every path once the "Next step" column is used up. The critical reviewer never moves past its start effort.

`xhigh` and `max` are not used by default anywhere. They need a measured gain in the ledger for that role.

## Cascade

When a batch of similar packages has a deterministic acceptance command, start each at `low` and re-run only the
failures at `high`, as the guide does: "run everything at a low level and re-run only the failures at a high one". Its
measurement on Opus: low with failures re-run at high passed about 97% of
tasks at about $0.17 each, against 95.3% at $0.29 each with every task at high. Record a cascade re-run with cause
`CASCADE`, which does not count as a reasoning failure; a package whose first verdict carries it is left out of the
first-round ACCEPT rate, because its first round was planned to fail sometimes.

## Mixing models

- **Change the lead's model only at a handoff.** The prompt cache belongs to the model that wrote it, so the first
  turn on a new model pays a cache write for the whole conversation, and reasoning from a bigger model is dropped
  when the conversation moves down a tier. A handoff starts a fresh session from `STATE.md`, which is the natural
  break the guide asks for. Do not use `/model` in a running lead session. Treat the lead's effort and fast mode the
  same way: the prompt-caching docs say a changed effort setting can invalidate cached message blocks and a speed
  change invalidates the cache, so a raise of the lead's effort or fast mode waits for the next handoff too.
- **Small models only where a mistake is cheap to spot.** Haiku reads logs and does mechanical work with a check. It
  does not edit code and does not produce the facts a brief is written from.
- **Do not use the built-in `Explore`, `Plan` or `general-purpose` agents from the lead.** The guide: "the built-in Explore
  subagent runs on your session's model" (capped at Opus on the Claude API); `Plan` and `general-purpose` inherit the
  session's model too, so their reading costs the lead's rates. The agent guard hook denies them from the lead. Use `ghorc:scout` and
  `ghorc:log-reader`. `/ghorc:setup` item `explore` (opt-in) writes a project `Explore` agent on `haiku` for the
  cases where the built-in one is still started.
- **Pass `model` and `effort` on every Agent call.** The call's `model` outranks the role's frontmatter; the call's
  `effort` outranks the frontmatter `effort`; `CLAUDE_CODE_EFFORT_LEVEL` outranks both, so keep it unset.
  `CLAUDE_CODE_SUBAGENT_MODEL` only fills in a missing model, unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, which
  overrides every role: keep that unset too.
- **Do not split work that fits one context and is one dependent chain.** Planning and merging then cost more than
  they save; give it to one implementer.
- **Not used by default:** `opusplan` (the guide calls it the reverse of its own advice; measure first), the advisor
  tool (none of the guide's pairings clearly beat the executor alone), fast mode (faster output at a premium price;
  an owner decision per session).

## Why the lead's context stays small

Every turn re-sends the context, so a big context costs on every turn even when cached. In the guide's numbers for Opus a turn's cache
read costs about $0.03 at 150K tokens and about $0.004 at 20K. The bigger the lead's model, the more this matters:
"Keep the expensive model's context for the decisions, and let cheaper subagents do the verbose reading." That is
the reason for the read guard, the 25-line reports and the context thresholds. A pause longer than the cache TTL (5
minutes by default) makes the next turn write the whole context again at 1.25 times the input price (2 times with the
1-hour TTL): at 265K tokens on Opus about $1.33, which is about 25 cached turns. A lead above `ctxPrepare` that expects a
long wait hands off first.

Why the handoff point is 265K (30% of a 1M window) and not 150K: a handoff is not free either. The old lead's closing
turns, the new lead's first cache write (about 35K) and its orientation come to about $1 on Opus, and a new lead starts
at 65-85K, not at zero. With cost per turn = cache-read price x (threshold + start) / 2 + handoff cost x growth per turn /
(threshold - start), measured growth of 1.3-2K tokens per turn puts the cheapest point at about 185-210K, and the cost at
150K and at 265K within about 10% of it. Price does not decide between them; fewer handoffs (each a chance to drop a
nuance) and a 25K handoff budget that takes 13% of the room instead of 31% do. The lever that matters more is the
start: every token of skill text and CLAUDE.md is read on every turn of every lead.

## Changing a row

The guide is a prior, not a measurement on your project. Its method, which a routing change follows:

1. Take a sample of real tasks with an outcome check each (a package's acceptance command).
2. Run each candidate model at two or three effort levels, each in its own session so the runs share no cache. Include
   a single-model run (everything on the lead's model) as a baseline: "keep a multi-model setup only if it beats every
   single-model point" on the chart of score against spend.
3. Pick the setup that is not lower on score and lower on cost; a cheaper setup that loses accepted packages does not
   win. Then run it in shadow on a slice of real packages before switching the row.

Observed packages in the ledger are a cheaper first signal: 20 packages per role, first-round ACCEPT not lower and
estimated cost at least 20% lower, no lost P0/P1 (`docs/evidence.md`). `ledger.cjs report` gives tokens, estimated cost
and first-round verdicts per role and model. Tab workers do not reach the ledger, so a measurement of a tab role needs
its sessions run as Agent calls or read from their transcripts.
