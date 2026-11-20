// test-preload.mjs - loaded with `node --import` by scripts/test.mjs.
// env.js loads ./.env with OVERRIDE semantics, so a developer's FM_* and AI
// keys would beat the clean environment the test gives the server. Hide the
// repo's .env from env.js (this process only) so the run is always sample mode.
import fs from "fs";
const isEnv = (p) => typeof p === "string" && /(^|[\\/])\.env$/.test(p);
const exists = fs.existsSync;
fs.existsSync = (p) => (isEnv(p) ? false : exists(p));
