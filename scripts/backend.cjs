'use strict';
// Which terminal backend runs this session: hc (herdr-app), herdr (the older CLI) or none. The lead and the skills
// (lead, handoff) run it BEFORE any tab or agent command and use the command forms of the answer.
//   node scripts/backend.cjs            one JSON line: {"backend":"hc|herdr|none","reason":"...", ...}
//   node scripts/backend.cjs --name     only the word hc, herdr or none
// Exit code is 0 for every answer (none is an answer, not an error).
const { detect } = require('./lib/backend.cjs');

if (process.argv.includes('--help')) {
  console.log(
    'backend.cjs: prints the active terminal backend. hc when HC_TERMINAL_ID is set; herdr when HERDR_ENV=1 and ' +
      '`herdr agent list` answers; none otherwise (no tab commands: use the Agent tool and the /clear fallback). ' +
      '--name prints only the word. Test seams: GHORC_HC_BIN, GHORC_HERDR_BIN (a path or a JSON array [program, ...args]).',
  );
  process.exit(0);
}

const d = detect();
if (process.argv.includes('--name')) console.log(d.backend);
else {
  const { raw, ...rest } = d; // the herdr agent list text is for the hooks, not for the answer
  console.log(JSON.stringify(rest));
}
