# Models and effort

ghorc picks a model and an effort for every role and class of work. This page is the single source of those choices
and of why each one was made. The operative copy the lead follows is the Routing table in skill `ghorc:lead`; the
tables in `README.md`, `docs/workflow.md` and `templates/CLAUDE-section.md` repeat only the role defaults.

The starting point is Anthropic's guide
["Which Claude model should you build with?"](https://claude.dev/blog/which-claude-model-should-you-build-with/)
(Nov 2026), with its companion posts on effort and on task cost. Where ghorc departs from the guide, the row says why.

## Model families, never versions

ghorc names models only by their aliases: `haiku`, `sonnet`, `opus`, `fable`. Claude Code resolves each alias to the
newest model of that family, so a new release is picked up without a change here. The roles' frontmatter, the
Routing table, the briefs and `lead.model` use aliases only; `/ghorc:setup` learns the full id of the lead model from
the session's own status line file instead of a table. The one place that lists model ids is the price table of the
ledger (`scripts/lib/prices.cjs`), because a price belongs to one model id; a model that is not in it is reported as
unpriced, never priced with an older model's numbers.

| Family | Cost per token | Speed | In ghorc |
|---|---|---|---|
| `haiku` | lowest (about a twentieth of Sonnet on short prompts) | fastest | logs and test output, mechanical work with a machine check |
| `sonnet` | about half of Opus | fast | workers: implementer, reviewer, scout, integrator, media, consult, release |
| `opus` | the reference | moderate | the lead; critical review; migrations and performance work; unclear causes |
| `fable` | about twice Opus | moderate | lead of major work; arbiter; critical review of Opus work |

Ratios are the guide's at the time of writing; current numbers are in `scripts/lib/prices.cjs`.

## Routing

| Class of work | Role | Model / start effort | Next step if it falls short | Guide row, or why ghorc differs |
|---|---|---|---|---|
| Lead, everyday work | lead | opus / medium | high, then the next handoff on fable / medium | "Not sure yet" and "Everyday engineering": Opus at medium |
| Lead of a major refactor, migration or architecture plan, many packages in parallel, a long unattended run | lead | fable / medium | high | "Major refactors, migrations, architecture planning, leading many subagents": Fable |
| Well-scoped implementation: a bug with a named cause, a feature from a spec | `implementer` | sonnet / medium | high, then opus / medium (ordinary packages only) | "Well-scoped coding": Sonnet at medium, then high |
| Edit by a ready pattern | `implementer` | sonnet / low | medium | Effort post: low for mechanical work (renames, a known pattern) |
| Money, recovery | `implementer` | sonnet / high | split the task | ghorc: the critical reviewer is Opus and the models must differ |
| Migration, performance optimization | `implementer` | opus / medium | high, then fable / medium | "A clear spec alone does not justify Sonnet": migrations and performance work need Opus |
| Major migration (many modules, a data model, a contract) | `implementer` | fable / medium | high | Guide: "or Fable if major"; the critical reviewer is then Opus |
| Investigation, a cause unclear across subsystems (ordinary packages) | `implementer` | opus / medium | high | "Everyday engineering, debugging": Opus |
| Ordinary review, re-check of fixes | `reviewer` | sonnet / medium | high | "Repeated agent tasks: investigation, review, drafting": Sonnet at medium |
| Critical review of Sonnet work (money, recovery, contracts, policy, hooks) | `reviewer-critical` | opus / high | a disputed P0 goes to the arbiter | Effort post: high where verification and edge cases matter |
| Critical review of Opus work (migration, performance) | `reviewer-critical`, `model: fable` | fable / medium | a disputed P0 goes to the arbiter | The reviewer's model differs from the implementer's |
| Critical review of Fable work | `reviewer-critical` | opus / high | a disputed P0 goes to the arbiter | The reviewer's model differs from the implementer's |
| Scouting: facts about code and git | `scout` | sonnet / low | medium | Guide allows Haiku or Sonnet; ghorc keeps Sonnet because scout facts become briefs, and a wrong fact costs a whole package |
| Logs and test output: which cases failed, first error line | `log-reader` | haiku / medium | `scout` on sonnet | "Subagents that read logs": Haiku; a mistake is cheap to spot against the log |
| Mechanical work with a machine check | ad hoc (brief Template 3) | haiku / medium | sonnet / low | "Classification, routing, extraction": Haiku at its default |
| Attachments: PDFs, images | `media` | sonnet / low | medium; opus / medium for a long vision-heavy loop | "Everyday documents": Sonnet; "Computer use and vision-heavy workflows": Opus |
| Consultation in a browser | `consult` | sonnet / low | medium | Paste, wait, save: a wrong answer file is cheap to spot |
| Architecture with clear constraints | lead or an ad hoc agent | opus / medium | high, then fable / medium | Bounded design is everyday engineering |
| Architecture plan for a major change | ad hoc agent or the lead | fable / medium | high | "Architecture planning": Fable |
| Dispute, arbiter, disputed P0 | ad hoc agent | fable / medium | high | "Past high, test the next model up at a lower effort" |
| Critic of a significant decision or plan | `methodology-toolkit:red-team-critic` | opus / medium | high; fable / medium when Opus made the plan | A judgement call stays on the main model; the critic differs from the author |
| Sourced facts for product, market or vendor questions | `methodology-toolkit:evidence-scout` | sonnet / low | medium | Search work; the facts feed a decision, so Sonnet rather than Haiku |
| Merge conflict, red check | `integrator` | sonnet / medium | high, then opus / medium | Conflicts are well-scoped; an unclear red cause is debugging |
| Release (only on the owner's word) | `release` | sonnet / medium | none | A fixed procedure |

## Escalation

The guide's order, in ghorc terms:

1. **Verification first.** If the agent could not check its own work (no test, build or command in the brief), add the
   check, not effort. This is the ledger cause `SKIPPED_CHECK` or `BRIEF_OMISSION`: same model, same effort.
2. **One effort level up.** Only after a `REASONING_FAILURE` on a brief that was complete.
3. **The next model up, at a lower effort.** Past `high` do not raise effort; start the next model at `medium`. One
   level past `high` can cost as much as a bigger model (the guide's SWE-bench Pro run on Opus: `xhigh` about 1.4 points over
   `high` at 2.5 times the cost"). Higher effort does not add knowledge the model lacks: a wrong approach needs a
   different brief or a bigger model, not more effort.
4. A second `CHANGES_REQUIRED` changes the task statement or splits it; nothing is raised further. This is also the
   end of every path once the "Next step" column is used up. The critical reviewer never moves past its start effort.

`xhigh` and `max` are not used by default anywhere. They need a measured gain in the ledger for that role.

## Cascade

When a batch of similar packages has a deterministic acceptance command, start each at `low` and re-run only the
failures one level up. The guide's measurement on Opus: low with failures re-run at high passed about 97% of
tasks at about $0.17 each, against 95.3% at $0.29 each with every task at high. Record a cascade re-run with cause
`CASCADE`, which does not count as a reasoning failure; a package whose first verdict carries it is left out of the
first-round ACCEPT rate, because its first round was planned to fail sometimes.

## Mixing models

- **Change the lead's model only at a handoff.** The prompt cache belongs to the model that wrote it, so the first
  turn on a new model pays a cache write for the whole conversation, and reasoning from a bigger model is dropped
  when the conversation moves down a tier. A handoff starts a fresh session from `STATE.md`, which is the natural
  break the guide asks for. Do not use `/model` in a running lead session.
- **Small models only where a mistake is cheap to spot.** Haiku reads logs and does mechanical work with a check. It
  does not edit code and does not produce the facts a brief is written from.
- **Do not use the built-in `Explore`, `Plan` or `general-purpose` agents from the lead.** They run on the session's
  model (for a Fable lead: Opus on a subscription or the API, Fable on Bedrock, Vertex or Foundry), so their reading
  costs the lead's rates. Use `ghorc:scout` and
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
the reason for the read guard, the 25-line reports and the context thresholds.

## Changing a row

The guide is a prior, not a measurement on your project. A row changes when the ledger shows it should:
20 observed packages per role, and first-round ACCEPT +15 pp or estimated cost -20% with no lost P0/P1
(`docs/evidence.md`). `ledger.cjs report` gives tokens, estimated cost and first-round verdicts per role.
