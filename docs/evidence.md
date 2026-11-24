# Evidence: what to measure and how

**No numbers are published yet.** ghorc 0.5.0 is an early release. This page names the three outcomes ghorc is meant
to change and how to measure each one, so that any claim made later can be checked and repeated. Until a measurement
exists, the README makes no claim about savings.

## Baseline

Compare against plain Claude Code **with** its own subagents, not against a session that does everything itself.
Use matched pairs: the same task, the same starting commit, the same lead model and effort, once with ghorc and once
without. Ten pairs is the planned minimum. Count every attempt, including retries and failed packages.

## 1. Lead compactions per package

Claim template: "Ran [N] packages with [X] lead compactions instead of [Y] on the same tasks."

- **What:** how often the lead session auto-compacts while finishing the same work.
- **How:** count compaction boundaries in the lead's transcript (`~/.claude/projects/<encoded project root>/`), and
  record the context fill at each stage boundary with `node "<plugin>/scripts/ctx.cjs" --session <id>` (it reads the
  `ctx-<session_id>.json` file the status line writes). Note `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: it must be the same in
  both runs of a pair.

## 2. Worker full-suite attempts stopped

Claim template: "Workers tried the full suite [N] times; the hook stopped them, and the lead ran it [M] times."

- **What:** how often a subagent or worker tried a configured heavy command, and how often the lead ran the full
  check.
- **How:** count `heavy-check-guard` lines in `<tmp>/ghorc-<user>/denials.log` (format
  `<iso time> <session8> <hook> <reason>`, kept 7 days); `/ghorc:status` prints the counts per hook. Count the lead's
  full-check runs from its transcript. The baseline run has no hook, so count the same commands in the workers'
  transcripts (`subagents/`) instead. Repeated reads are counted the same way from `read-guard` lines.
- **Limit:** the hook only sees commands that match `heavyCommands`. An empty list denies nothing and logs nothing.

## 3. Estimated cost per accepted package

Claim template: "[X]% lower estimated API cost per accepted package, counting workers and retries."

- **What:** the estimated API cost of all sessions (lead, subagents, workers) per package that passed review and the
  full check.
- **How:** sum input, cache creation, cache read and output tokens per model from every transcript of the package,
  multiply by the public API prices of each model on the day of the run, and divide by the number of accepted
  packages. Failed and retried attempts stay in the sum. State the prices used next to the result.
- **Ledger:** `ledger.cjs report` now gives this estimate per subagent run (see [Call ledger](#call-ledger)), at the list
  prices in `scripts/lib/prices.cjs` (as of 2026-11-24). The lead session itself and terminal tab workers are not in the
  ledger, so their cost still has to be summed by hand from their transcripts and added.
- **Limit:** on a subscription plan this is an estimate of relative load, not money spent.

## Call ledger

`scripts/ledger.cjs` keeps `<project>/.claude/ghorc-out/ledger.jsonl` (git-excluded by setup), one JSON line each.

- **Synchronous call line** (PostToolUse hook on `Agent`): `ts`, `session` (first 8 chars), `desc` (max 80), `role`
  (`subagent_type`, else `agent`), `modelReq`, `modelRes` (`resolvedModel`), `effortReq`, `agentId`, `tokens`
  (`totalTokens`), `usage` (as received), `ms`, `tools`. The prompt and the response text are never stored.
- **Background call, two stages.** For a background Agent call PostToolUse fires at launch with
  `{isAsync:true, status:"async_launched", agentId, outputFile, ...}` and no totals, so the hook writes a `launch` line
  (same fields, plus `outputFile`, no totals). The SubagentStop hook (`ledger.cjs stop`) reads the transcript path
  (`agent_transcript_path` or `transcript_path`) and `agent_id` from its payload and appends a `done` line:
  `{agentId, tokens:{input, output, cacheRead, cacheCreate, total}, tools, ms, turns, cost, unpriced, models,
  cacheTtlAssumed}`, summed from each assistant message's `usage` (once per message id); a payload without those fields
  writes nothing. `report` joins `launch` and
  `done` by `agentId`; a launch without a done line is read lazily from its `outputFile`, if the file exists.
- **Cost fields of a `done` line.** `cost` is the estimated USD at list prices (rounded to 6 decimals, `null` when no
  message had a price), summed per assistant message from its own `message.model` and `usage`. `unpriced` counts
  messages with non-zero usage whose model has no price (such as `<synthetic>` or a model not in the table); their
  tokens are in `tokens` but not in `cost`. `models` lists the distinct model ids seen. `cacheTtlAssumed` is true when
  a priced message wrote cache tokens without the 5-minute / 1-hour split in `usage.cache_creation`, and all of them were
  priced at the 5-minute rate (1.25 x input; the 1-hour rate is 2 x). Prices live in `scripts/lib/prices.cjs`
  (USD per 1M tokens, date in `PRICES_AS_OF`, now 2026-11-24); Haiku has two tiers by the prompt length of each request
  (input + cache read + cache creation, up to 100000 tokens or above). No price is invented for other models. A
  synchronous call line has no per-message data, so it has no cost.
- **Verdict line** (the lead): `{ts, kind:"verdict", pkg, round, verdict, cause}` through
  `ledger.cjs verdict <pkg> <round 1-9> <ACCEPT|CHANGES_REQUIRED> [cause] [--class critical|ordinary]`; the cause
  (`BRIEF_OMISSION|SKIPPED_CHECK|REASONING_FAILURE|OTHER|CASCADE`) is required for CHANGES_REQUIRED and absent for ACCEPT.
- **Report** (`ledger.cjs report`, `/ghorc:status`): per role calls, median and upper-quartile tokens and ms, mean
  tools, share of calls where the resolved model really differs from the requested one (`sonnet` matches
  `claude-sonnet-<version>`: a dash-delimited part counts); per package rounds and first-round verdict; first-round ACCEPT
  rate overall and per class (critical, ordinary); cause counts. Each role line ends with
  `cost med=$<x> total=$<y>` (`-` without a priced call), and a line
  `estimated cost: $<total> at list prices as of <date> (<n> calls priced, <m> without a price)` follows the roles.
  `--json` adds `costMedian` / `costTotal` per role and `costTotal`, `costCalls`, `unpricedCalls`, `pricesAsOf` on top.
  `m` counts calls that have totals but no cost, or some unpriced messages.
- **Unverified:** `tokens` and `usage` of a synchronous call may cover only the final API request of the subagent, not
  the whole run. The transcript totals of a `done` line (and of a call with a matching `done` line) cover every
  assistant message. Compare the two on the first 10 calls before trusting the synchronous figures.
- **Sample sizes:** 10 packages before the instrumentation is trusted; 20 observed packages per role before any
  effort table change; a change needs first-round ACCEPT rate +15 pp or tokens -20% with no lost P0/P1.

## What would count as a published result

The task list, the commits, the config used, the raw counts for both arms, and the script or commands that produced
them. Anything less stays out of the README.
