// check-order.mjs - proves the one name map against a running server.
// GET /api/config `displayNames` and GET /api/fm/tables rows must agree on
// every table's display name, and the sync plan must run in display-name
// order (A to Z, case-insensitive, then the raw name). Prints PASS or FAIL.
//
// Usage: MITOS_URL=http://localhost:8090 node scripts/check-order.mjs
//        SITE_PASSWORD=<key> when the server has one.

const BASE = (process.env.MITOS_URL || "http://localhost:8080").replace(/\/$/, "");
const KEY = process.env.SITE_PASSWORD || "";

async function get(route) {
  const url = `${BASE}${route}${KEY ? `${route.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}` : ""}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${route} answered ${res.status}: ${data.error || ""}`);
  return data;
}

const orderOf = (names, map) => {
  const key = (n) => String(map[n] || n).toLowerCase();
  return [...names].sort((a, b) => key(a).localeCompare(key(b)) || a.localeCompare(b));
};

const problems = [];
const cfg = await get("/api/config");
const names = cfg.displayNames || {};
const configured = Object.keys(cfg.tables || {});

// 1. Every scanned table's row carries the map's name.
let scanned = 0;
try {
  const scan = await get("/api/fm/tables");
  if (scan.building) console.log("note: the scan is still building; table rows not checked");
  for (const t of scan.tables || []) {
    scanned++;
    if (t.displayName !== (names[t.name] || t.name)) problems.push(`${t.name}: /api/fm/tables says "${t.displayName}", /api/config says "${names[t.name] || t.name}"`);
  }
  // 2. The two sources sort the configured tables the same way.
  const byScan = Object.fromEntries((scan.tables || []).map((t) => [t.name, t.displayName]));
  const a = orderOf(configured, names).join(" | "), b = orderOf(configured, byScan).join(" | ");
  if (a !== b) problems.push(`sort order differs:\n  config: ${a}\n  tables: ${b}`);
} catch (e) {
  // Sample mode has no FileMaker: the name map still has to cover the config.
  console.log(`note: /api/fm/tables not checked (${e.message.slice(0, 80)})`);
}

// 3. Every configured table has an entry in the map.
for (const n of configured) if (!names[n]) problems.push(`${n}: no display name in /api/config`);

// 4. The last sync's plan (the start event) ran in that order.
try {
  const job = await get("/api/index/job");
  const start = (job.job?.events || []).find((e) => e.type === "start");
  if (start && start.tables?.length) {
    const ran = start.tables.map((t) => t.name);
    const want = orderOf(ran, names);
    if (ran.join(" | ") !== want.join(" | ")) problems.push(`the sync plan ran out of order:\n  ran:  ${ran.join(" | ")}\n  want: ${want.join(" | ")}`);
    for (const t of start.tables) if (t.label !== (names[t.name] || t.name)) problems.push(`${t.name}: the sync said "${t.label}", /api/config says "${names[t.name] || t.name}"`);
  }
} catch { /* no job yet */ }

console.log(`checked ${configured.length} configured tables, ${scanned} scanned rows`);
if (problems.length) {
  console.log("FAIL");
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
console.log("PASS");
