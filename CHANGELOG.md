# Changelog

## 0.3.1
- Root: one rule in `scripts/lib/root.cjs` (`CLAUDE_PROJECT_DIR`, else git common root, else cwd) used by config, setup, statusline and ctx; setup now finds and writes the config at the main root from a worktree.
- setup: new check item `statusLineStale` (statusLine points to an older plugin cache version than the running one).
- read-guard: `leadNoMedia` no longer treats `GHORC_ROLE=worker` sessions as the lead.
- read-guard: PDF/image extension checks are case-insensitive on every OS.
- watchdog: size alerts persist in `<tmp>/ghorc/watchdog-state.json`; a restart does not repeat them, re-alert after growth of `warnMiB`/2 or a level rise.
- statusline writer and `ctx.cjs` reader now agree on the root (the writer ignored `CLAUDE_PROJECT_DIR` before).
- Docs: heavy-check-guard header says `Bash|PowerShell`; statusline `--help` shows the real separator.

## 0.3.0
- All user-facing text, comments and tests translated to English; skill triggers are English only.
- session-start autostarts the transcript watchdog for lead sessions (config `watchdog.*`, pid lock, `--notify-file`, alerts shown by `ctx.cjs`).
- New skill `/ghorc:setup` and `scripts/setup.cjs` (check and apply the recommended setup).
- session-start reminds about a missing `<!-- ghorc -->` section in CLAUDE.md; README gains "Daily use" and "With and without herdr"; `/ghorc:handoff` prints a fallback without herdr.
- statusline saves a raw stdin sample once to `<tmp>/ghorc/statusline-sample.json`.
- Names are namespaced everywhere: `/ghorc:*`, `ghorc:<role>`.

## 0.2.0
- statusline: subscription-oriented line (model, effort, ctx with autocompact marker, 5h/7d rate limits, role, git branch, session), colors, no cost; opt-in raw dump via GHORC_STATUSLINE_DUMP; ctx file gains effort and rate_limits keys (additive).

## 0.1.2
- review rounds 1-2 fixes.
