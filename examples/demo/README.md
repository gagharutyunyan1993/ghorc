# ghorc demo: fix a failing test in five minutes

A dependency-free Node project with one real bug: `slugify("a  b -- c")` returns `a--b----c` instead of `a-b-c`,
so 1 of 4 tests fails. You watch the lead send a worker to fix it while the hooks keep the worker from re-reading
files and from running the heavy suite.

## Walk-through

1. Install the plugin (marketplace `ghorc`), then open Claude Code in this folder (`examples/demo`).
2. Run `/ghorc:setup`. It checks `CLAUDE.md`, the config and the git exclude for `.claude/ghorc-out/`.
   Confirm `heavyCommands`: they must list `npm run test:full` and `node scripts/slow-check.js`
   (already set in `.claude/ghorc.json`).
3. Run `/ghorc:lead` so this session becomes the lead.
4. Give the lead one line: `The slugify test fails; fix it`.

## What you should see

- The lead writes a worker brief like `briefs/fix-slugify.md` (seven tags, under 500 words) and starts a
  `ghorc:implementer`.
- The worker runs `npm test`, sees one failure and edits `src/slugify.js`.
- If it reads the same file again and again, the read guard answers `DENIED` after the third read without an edit.
- If it tries `npm run test:full` or `node scripts/slow-check.js`, the heavy guard answers `DENIED`: only the lead
  may run the full check.
- The worker report lands in `.claude/ghorc-out/`; compare it with `expected-report.md`.
- The lead runs `npm run test:full` once, in the background: tests pass, then `full check ok` after about 3 seconds.

`npm run test:full` fails on the first step until the bug is fixed; that is expected.

## Reset

```
git checkout -- src
```

Delete `.claude/ghorc-out/` to drop old reports. Run `npm test` to confirm 1 of 4 fails again.

## Files

| Path | Purpose |
|---|---|
| `src/slugify.js` | the code with the bug |
| `tests/slugify.test.js` | 4 tests, 1 fails |
| `scripts/slow-check.js` | stands in for a heavy suite (3 s) |
| `.claude/ghorc.json`, `CLAUDE.md` | minimal ghorc config and project rules |
| `briefs/fix-slugify.md`, `expected-report.md` | a sample brief and a good report |
