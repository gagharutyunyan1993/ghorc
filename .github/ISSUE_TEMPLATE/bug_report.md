---
name: Bug report
about: Something in ghorc does not behave as documented
labels: bug
---

**ghorc version** (first line of the SessionStart output, for example `ghorc 0.5.0 session=... role=lead`):

**Claude Code version** (`claude --version`):

**OS and Node.js version:**

**SessionStart output** (paste the lines it printed):

```
```

**What happened, and what you expected:**

**Hook payload.** If a hook is involved, rerun with `GHORC_HOOK_DUMP=<file>` set and attach the relevant line. It
contains tool arguments, so remove anything private first.

**Relevant `.claude/ghorc.json` fields** (optional):
