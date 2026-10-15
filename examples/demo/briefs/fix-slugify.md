<role>You are the implementer of task D1. You work alone and spawn no subagents.</role>

<context>
`slugify` leaves repeated hyphens in the result ("a  b -- c" gives "a--b----c"), so one test in
tests/slugify.test.js fails. Fix the function so separators collapse into a single hyphen.
Starting tree: the demo project as checked in. Working directory: this folder.
</context>

<read_first>
- src/slugify.js:4-10 - the function
- tests/slugify.test.js:17-19 - the failing case
</read_first>

<you_own>src/slugify.js only. Anything else goes to "Suggestions" in the report.</you_own>

<steps>
1. Make runs of non-alphanumeric characters become one hyphen; keep trimming of leading and trailing hyphens.
2. Checks: npm test
Done when:
- all 4 tests in tests/slugify.test.js pass and no test file was changed.
</steps>

<constraints>
- No incidental refactoring. Checks only through `npm test`; do not run `npm run test:full` or the slow check
  (the lead runs it once).
- After two failed fixes of the same cause stop guessing: return observations, hypotheses and the next step.
</constraints>

<report_back>
STATUS: DONE | HANDOFF | BLOCKED. Then: the change; the `npm test` output; unverified items;
suggestions. Up to 25 lines,
the rest goes to `.claude/ghorc-out/fix-slugify-report.md`.
</report_back>
