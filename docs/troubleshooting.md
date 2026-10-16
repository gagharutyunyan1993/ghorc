# Troubleshooting

Start with `/ghorc:status`: it shows the role, the guards, the heavy patterns, the watchdog state and the last denials.
Every deny is also in `<tmp>/ghorc-<user>/denials.log` ([hooks.md](hooks.md#denial-log)).

## Denials

- **"<file> was already read 3 times".** The per-path limit (`readGuard.maxRepeat`); ranges do not help. Use what was
  read, or edit the file first (an Edit of that path resets it).
- **"the lead (GHORC_ROLE=lead) does not read media".** The session was started with `GHORC_ROLE=lead` and
  `readGuard.leadNoMedia` is true. Give the path to `ghorc:media`, start the lead without `GHORC_ROLE`, or set
  `leadNoMedia: false`. A plain session without `GHORC_ROLE` is not affected.
- **"media is read by the media role".** A subagent that is not in `readGuard.mediaRoles` tried a PDF or image; hand
  the file to `ghorc:media`.
- **"Do not read a PDF without pages".** Every Read of a PDF needs `pages`, for the lead too. Convert it with
  `pdftotext`/`pdftoppm` or pass `pages`.
- **"only the lead runs heavy checks".** A subagent or worker ran a `heavyCommands` match. Intended: agents run
  `checks.fast`; the lead runs the full check. If the pattern is too broad, test it with `check-config.cjs --sample`.
- **"config invalid: ..." on a Bash call.** `.claude/ghorc.json` has an error; every heavy command is denied, for the
  lead too, until it is fixed. Run `node "<plugin>/scripts/check-config.cjs"`; the fix is seen at once.
- **The lead's Bash is denied: "GHORC_ROLE=lead is not set".** `heavyGuard.requireLeadEnv` is `true` and the session
  started without the marker. Restart the lead with `GHORC_ROLE=lead`, or set `requireLeadEnv` to false.
- **The heavy guard denies nothing.** `heavyCommands` is empty (the default). Run `/ghorc:setup`: it proposes
  patterns from your `package.json` scripts and writes them only after you confirm (`--apply heavy`).

## Status line and ctx

- **Status line empty.** `statusLine` is missing from settings, or `node` is not on `PATH`. Run `/ghorc:setup` and
  restart. Test the script: `echo '{}' | node "<plugin>/scripts/statusline.cjs"` prints a line starting
  `model? │ ctx --`.
- **Status line stops updating after `plugin update`.** Setup writes the path of the running copy, which under a
  plugin cache is a versioned directory. After an update the old path may be gone: `setup.cjs --check` reports
  `statusLineStale`; re-run `/ghorc:setup` (or `--apply statusLineStale`).
- **No `5h`/`7d` segments.** `rate_limits` is absent from the status line input (not every session provides it; its
  shape is undocumented). Inspect `<tmp>/ghorc-<user>/statusline-sample.json` (the first input, saved once) or set
  `GHORC_STATUSLINE_DUMP=<file>` to append every input.
- **`ctx.cjs` prints a usage line and exits 2.** It needs `--session <id>` (or `GHORC_SESSION`, or `--all`).
- **`ctx.cjs` says "no ctx-*.json files".** The status line is not configured, or wrote under another root: it uses
  the root rule (`CLAUDE_PROJECT_DIR`, else the git common root of `workspace.project_dir` or the cwd). Run
  `ctx.cjs --cwd <that root>`.

## Config

- **"config not found" in a worktree.** No file in the worktree, its ancestors or the main repository root, or git is
  not on `PATH`. `check-config.cjs --cwd <worktree>` shows the expected path; put the file in the main repository's
  `.claude/`.
- **"config warning: ..." at session start.** An unknown key; nothing is denied. Check the spelling against
  [configuration.md](configuration.md).

## Watchdog

- **It does not run.** It is off by default: `/ghorc:setup` item `watchdog` turns it on. SessionStart restarts one
  that is dead, of another version or silent for two intervals. Check `<tmp>/ghorc-<user>/watchdog-<root hash>.pid`
  (JSON) and `.log`; `GHORC_NO_AUTOSTART=1` and worker sessions never start it.
- **I want it gone.** `node "<plugin>/scripts/watchdog.cjs" --stop` in the project directory, then set
  `watchdog.autostart` back to false.
- **Duplicate alerts.** Size alerts persist in `<tmp>/ghorc-<user>/watchdog-<root hash>.state.json`, so a restart
  repeats none for unchanged files; delete that file to reset.

## Handoff

- **The candidate never answers READY.** It waits on a permission prompt (`candidatePermissionArgs` empty), did not
  receive its settings, or the 10 minutes passed. Close it and its tab, void the `handoff_id`, fix, retry; after 2
  failures ask the owner. See [handoff.md](handoff.md).

## Where files live

`<tmp>` is the OS temp directory (`%TEMP%` on Windows, usually `/tmp` on Linux); the plugin works in
`<tmp>/ghorc-<user>` (one directory per OS user) and `GHORC_TMP` replaces that whole path. Per project root (an
8-character hash) it keeps `watchdog-<hash>.log`, `.pid`, `.beat`, `.state.json` and `alerts-<hash>.log`; per session
an alert offset file and read counters; for everyone `denials.log` and `config-valid.json`. The status line writes
`<project>/.claude/ctx-<session_id>.json`.

## Install scopes and updating

`claude plugin install ghorc@ghorc` takes `--scope`:

| Scope | Written to | Pick it when |
|---|---|---|
| `user` (default) | `~/.claude/settings.json` | you want ghorc in every project on this machine |
| `project` | `<project>/.claude/settings.json` | the team uses it (commit the file) |
| `local` | this project, not shared | you try it in one project without affecting teammates |

To update an installed copy (restart the session afterwards):

```
claude plugin marketplace update ghorc
claude plugin update ghorc@ghorc
```

Users of 0.4.x have the old marketplace name: remove `ghorc-local` and add `gagharutyunyan1993/ghorc` (see
[CHANGELOG.md](../CHANGELOG.md)).

## Removal

- **Put the previous status line back.** `node "<plugin>/scripts/setup.cjs" --restore statusline` restores the status
  line that `/ghorc:setup` replaced (or removes the `statusLine` key when there was none) and deletes
  `~/.claude/ghorc-statusline-backup.json`. Without that file it says so and changes nothing.
- **Stop the watchdog.** `node "<plugin>/scripts/watchdog.cjs" --stop`.
- **Uninstall.** `claude plugin uninstall ghorc@ghorc`; `.claude/ghorc.json` and the `<!-- ghorc -->` section of
  `CLAUDE.md` stay until you delete them.

## Debugging hooks and development

`GHORC_HOOK_DUMP=<file>` makes every hook append its raw stdin JSON, one line per call, to that file (off by default;
it contains tool arguments, so clean it before sharing). Use it to see which fields (`agent_type`, `agent_id`) Claude
Code really sends.

During development `claude --plugin-dir <path-to-ghorc>` loads the working tree; edits apply on the next start. The
checks are `npm test` (it runs only `tests/*.test.cjs`, so `examples/` never joins the run) and
`claude plugin validate .`. Tests set `GHORC_TMP` and `GHORC_WATCHDOG_ROOT` to temp directories and never touch the
real `~/.claude/projects`; one test fails on any Cyrillic character in the repository.

**Versioning.** Bump `version` in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `package.json`
together and add a `CHANGELOG.md` entry; an installed copy sees no update without a version change. See also
[CONTRIBUTING.md](../CONTRIBUTING.md).
