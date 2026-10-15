# Contributing

Thanks for helping. ghorc is plain Node.js (CommonJS, no dependencies), so there is nothing to install.

## Setup

```
git clone https://github.com/gagharutyunyan1993/ghorc
cd ghorc
node --version   # 20 or newer; CI uses 22
```

Try your changes in a real session without installing: `claude --plugin-dir <path-to-ghorc>`.

## Checks before a pull request

```
npm test
claude plugin validate .
```

Both must pass. Tests use temporary directories and `GHORC_TMP`, and never touch your real `~/.claude`. CI runs the
tests on Windows and Linux, so avoid platform-specific assumptions or guard them with `process.platform`.

## Style

- All text in the repository (code, comments, docs, messages) is English only; CI rejects Cyrillic.
- Markdown lines are at most 120 characters.
- Scripts stay dependency-free and must run on Windows and Linux.
- Behavior changes need a test and a line in `CHANGELOG.md`. Do not bump the version in a pull request.

## Commits

Conventional style, short imperative subject: `fix: ...`, `feat: ...`, `docs: ...`, `chore: ...`, `test: ...`.
Explain the why in the body when it is not obvious.
