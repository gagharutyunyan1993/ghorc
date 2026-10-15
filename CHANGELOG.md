# Changelog

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
