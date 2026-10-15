STATUS: DONE

Change: src/slugify.js - the separator replacement now matches runs (`/[^a-z0-9]+/g`), so "a  b -- c" gives "a-b-c".
Leading and trailing hyphens are still stripped by the next replace. No test file touched.

Checks (npm test):
  tests 4, pass 4, fail 0

Unverified: `npm run test:full` was not run (heavy; lead only).

Suggestions: none.
