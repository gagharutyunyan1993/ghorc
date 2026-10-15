# ghorc

[![CI][ci-badge]][ci] [![License: MIT][mit-badge]](LICENSE) [![Node >=20][node-badge]](package.json)
[![Dependencies: 0][deps-badge]](package.json)

[ci]: https://github.com/gagharutyunyan1993/ghorc/actions/workflows/test.yml
[ci-badge]: https://github.com/gagharutyunyan1993/ghorc/actions/workflows/test.yml/badge.svg
[mit-badge]: https://img.shields.io/badge/license-MIT-blue.svg
[node-badge]: https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg
[deps-badge]: https://img.shields.io/badge/dependencies-0-brightgreen.svg

**Keep the lead focused. Let subagents do the heavy reading.**

ghorc is a Claude Code plugin: an Opus lead plans, Sonnet subagents work, and hooks block repeated reads and worker
test-suite runs. It is for long sessions on real projects, where:

- the lead's context fills with logs, test output and whole files it only needed a few lines of;
- the most expensive model spends its turns on reading and searching that a cheaper one could do;
- workers re-read the same file again and again, or start the full test suite on their own.

Early release: no public benchmarks yet; the measurement method is in [docs/evidence.md](docs/evidence.md).

## What it looks like

Real hook output from [examples/demo](examples/demo/README.md) (a worker is a subagent; deny reasons are shown
without their JSON wrapper):

```
# SessionStart in a plain `claude` session
ghorc 0.5.0 session=a1b2c3d4-0000-4000-8000-000000000001 role=lead
config: ok
lead: load skill ghorc:lead
# read-guard: the worker reads src/slugify.js a 4th time without editing it
deny: slugify.js was already read 3 times: do not re-read it, use what you have or edit it first.
# heavy-check-guard: the worker runs `npm run test:full` (the same command from the lead is allowed)
deny: only the lead runs heavy checks.
# setup.cjs --check --status, which /ghorc:status runs
status: read-guard on (maxRepeat=3, media blocked for the lead: no), heavy-check-guard on (2 patterns)
status: denials 2 total (read-guard=1, heavy-check-guard=1), last 2:
```

## Install

Requirements: Claude Code with plugin support, Node.js 20+ on `PATH`, git.

```
claude plugin marketplace add gagharutyunyan1993/ghorc
claude plugin install ghorc@ghorc
```

Then, in a session inside your project, run `/ghorc:setup`. It checks the status line, the autocompact threshold,
`.claude/ghorc.json`, the `CLAUDE.md` section and the git exclude, proposes `heavyCommands` from your `package.json`
scripts, and applies only the items you confirm. To try ghorc for one session without installing:
`claude --plugin-dir <path-to-clone>`. Upgrading from 0.4.x: see [CHANGELOG.md](CHANGELOG.md) (the marketplace was
renamed from `ghorc-local` to `ghorc`).

## First 5 minutes

[examples/demo](examples/demo/README.md) is a dependency-free Node project with one failing test and a 3-second
stand-in for a heavy suite.

1. Install the plugin as above and clone this repository.
2. Open Claude Code in `examples/demo`. The SessionStart lines above appear (`role=lead`, `config: ok`).
3. Run `/ghorc:setup`. `heavyCommands` already lists `npm run test:full` and `node scripts/slow-check.js`.
4. Run `/ghorc:lead`: this session becomes the lead.
5. Tell the lead: `The slugify test fails; fix it`.
6. The lead writes a brief like [briefs/fix-slugify.md](examples/demo/briefs/fix-slugify.md) and starts
   `ghorc:implementer`, which runs `npm test`, edits `src/slugify.js` and writes a short report.
7. If the worker re-reads a file a 4th time or tries `npm run test:full`, the hook denies it, as above.
8. The lead checks the diff, runs `npm run test:full` once in the background, and `/ghorc:status` shows the denials.

Compare the worker's report with [expected-report.md](examples/demo/expected-report.md). Reset with
`git checkout -- src`.

## What is enforced and what is advised

| Enforced by hooks (the tool call is denied) | Advised (skills, roles, `CLAUDE.md`) |
|---|---|
| A 4th read of a file with no edit in between (`readGuard.maxRepeat`) | Which role, model and effort gets which work |
| A subagent or `GHORC_ROLE=worker` running a `heavyCommands` match | Briefs: 7 tags, at most 500 words |
| A subagent starting agents: `claude -p`, `herdr agent start/prompt` | Reports: at most 25 lines, the rest to a file |
| A PDF without `pages`; media outside the media role; media budgets | Context thresholds: 120K, 150K |
| Any heavy command while `.claude/ghorc.json` is invalid | The lead runs the full check once, in the background |

Details: [docs/hooks.md](docs/hooks.md) and [docs/workflow.md](docs/workflow.md).

## Commands

| Command | What it does |
|---|---|
| `/ghorc:setup` | checks the recommended setup, shows a table, applies only confirmed items |
| `/ghorc:lead` | loads the lead rules: routing, effort, thresholds, acceptance (`/ghorc:orc` is a 0.5 alias) |
| `/ghorc:status` | one block: role, active guards, heavy patterns, watchdog, context, recent denials |
| `/ghorc:brief` | the brief structure (7 tags) and three templates |
| `/ghorc:handoff` | hands the lead shift to a fresh session via STATE.md; with herdr, into a new tab |

## Roles

Called as `ghorc:<role>`. The lead passes `effort` on every call.

| Role | Model / effort | Purpose |
|---|---|---|
| `implementer` | sonnet / medium | code, tests and documents from a brief |
| `reviewer` | sonnet / medium | ordinary diff review; writes a review file with a verdict |
| `scout` | sonnet / low | read-only facts with `file:line`, written to a file |
| `reviewer-critical` (advanced) | opus / high | adversarial review of paths listed in `criticalPaths` |
| `media` (advanced) | sonnet / low | the only subagent role that reads PDFs and images |
| `consult` (advanced) | sonnet / low | asks external models in a browser (needs a browser MCP) |

`integrator` and `release` also ship; see [docs/workflow.md](docs/workflow.md).

## Evidence and limits

- No numbers are published yet. [docs/evidence.md](docs/evidence.md) describes how to measure compactions, denied
  worker runs and estimated cost against plain Claude Code on the same tasks.
- The hooks are not a sandbox. They match tool calls against rules; a worker can still do expensive work the rules
  do not name. `heavyCommands` is empty by default, and then the heavy guard denies nothing.
- The heavy guard is not a scheduler: it does not queue or limit parallel runs, it only denies matched commands to
  subagents and workers.
- On an internal error the hooks fail open (the call proceeds). The one exception: an invalid `.claude/ghorc.json`
  makes the heavy guard deny heavy commands for everyone until the file is fixed.

## Security and removal

The hooks make no network calls and send nothing anywhere; your model provider still receives your prompts as usual.
State lives in `<os tmp>/ghorc-<user>` and `<project>/.claude/ctx-<session>.json`. Details: [SECURITY.md](SECURITY.md).

The transcript watchdog is off by default. Turn it on with `/ghorc:setup` (item `watchdog`); stop it with
`node "<plugin>/scripts/watchdog.cjs" --stop` in the project directory.

To remove ghorc (stop the watchdog first if you turned it on, and drop `statusLine` from `~/.claude/settings.json`
if setup added it):

```
node "<plugin>/scripts/watchdog.cjs" --stop
claude plugin uninstall ghorc@ghorc
claude plugin marketplace remove ghorc
```

## Docs

- [docs/workflow.md](docs/workflow.md): the lead/worker cycle, roles, briefs, reports and acceptance
- [docs/hooks.md](docs/hooks.md): each hook, the status line, the watchdog and the scripts
- [docs/configuration.md](docs/configuration.md): every key of `.claude/ghorc.json`
- [docs/handoff.md](docs/handoff.md): handing the lead shift to a fresh session
- [docs/with-herdr.md](docs/with-herdr.md): optional terminal integration
- [docs/troubleshooting.md](docs/troubleshooting.md): denials, status line, watchdog, updating
- [docs/evidence.md](docs/evidence.md): what to measure and how
- [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md)

## License

MIT, see [LICENSE](LICENSE).
