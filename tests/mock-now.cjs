'use strict';
// Preload for tests: NODE_OPTIONS=--require <this> with GHORC_MOCK_NOW_MS fixes Date.now().
if (process.env.GHORC_MOCK_NOW_MS) {
  const t = Number(process.env.GHORC_MOCK_NOW_MS);
  Date.now = () => t;
}
