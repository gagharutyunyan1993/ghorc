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
- **Limit:** on a subscription plan this is an estimate of relative load, not money spent.

## What would count as a published result

The task list, the commits, the config used, the raw counts for both arms, and the script or commands that produced
them. Anything less stays out of the README.
