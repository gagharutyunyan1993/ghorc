---
name: setup
description: Check and apply the recommended ghorc setup - user settings (status line, autocompact threshold (global, or per project with `--project`), idle compaction, model, effort) and project files (ghorc.json, CLAUDE.md section, git exclude). Use for "setup ghorc", "ghorc setup", or when the SessionStart reminder says "run /ghorc:setup".
user-invocable: true
---
# ghorc setup

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.cjs" --check` (add `--cwd <project>` if the session is not in the project). It prints one line per item and a final JSON line.
2. Show the user a table: item, current value, recommended value, why. Mark items that are already `ok`.
3. Ask which missing items to apply. Apply only what the user confirms:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.cjs" --apply statusLine,pct,idle,config,claudemd,exclude`
   `pct` is GLOBAL (all projects); offer `--project` (writes `<project>/.claude/settings.local.json`) when the user wants it for this project only. `--apply all` skips warnings; use it only if the user said "apply everything", including model and effort.
4. `model` and `effort` are owner-level decisions (global model and effort of every session): never include them without an explicit yes for exactly those two items. The same holds for cache TTL, which this script does not touch.
5. `--apply` backs up `~/.claude/settings.json` to `settings.json.ghorc-<timestamp>.bak`, changes only the listed keys and prints a diff. Show the diff to the user. Settings changes take effect in a new session.
6. Run `--check` again and report the result; the status line, autocompact and model changes need a restart of the session.

Items: `statusLine` (ghorc status line), `statusLineStale` (statusLine points to an older plugin version; same fix), `pct` (`env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` = 18), `idle` (`idleCompaction` = false), `model` (config `lead.model`), `effort` (config `lead.effort`), `config` (`.claude/ghorc.json` from the template), `claudemd` (the `<!-- ghorc -->` section in `CLAUDE.md`), `exclude` (`.claude/ctx-*.json` and `.claude/ghorc-out/` in git `info/exclude`), `heavy` (warning only: `heavyCommands` empty or no match for `checks.full`; fix it by hand in the config).
