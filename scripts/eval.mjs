// eval.mjs - runs the search test cases against a running Mitos server and
// reports hit@1 / hit@3 per section, plus two type checks per case: the
// front door read the input as the expected kind, and no table listed in
// `notTables` appears. Change the parser or the ranking, re-run, compare.
//
// Usage: npm run eval  (server must be running; MITOS_URL overrides the base)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MITOS_URL || "http://localhost:8080";
const KEY = process.env.SITE_PASSWORD || "";

const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "eval", "cases.json"), "utf8"));

function hitRank(data, table, expectAny) {
  const group = (data.groups || []).find((g) => g.table === table);
  if (!group) return null;
  for (let i = 0; i < group.results.length; i++) {
    const display = JSON.stringify(group.results[i].display);
    if (expectAny.some((name) => display.includes(name))) return i + 1;
  }
  return null;
}

const results = [];
for (const c of cases) {
  const url = `${BASE}/api/search?q=${encodeURIComponent(c.query)}${KEY ? `&key=${encodeURIComponent(KEY)}` : ""}`;
  let rank = null, error = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const data = await res.json();
    if (data.error) error = data.error;
    else {
      rank = hitRank(data, c.table, c.expectAny);
      if (c.kind && data.kind !== c.kind) error = `read as ${data.kind}, expected ${c.kind}`;
      const leaked = (c.notTables || []).filter((t) => (data.groups || []).some((g) => g.table === t));
      if (leaked.length) error = `${error ? error + "; " : ""}also searched ${leaked.join(", ")}`;
    }
  } catch (e) {
    error = e.message;
  }
  const mark = error ? "ERR " : rank === 1 ? "PASS" : rank ? `@${rank}  ` : "MISS";
  console.log(`${mark}  [${c.section}] "${c.query}" -> ${c.expectAny.join(" | ")}${error ? `  (${error})` : ""}`);
  results.push({ ...c, rank, error });
}

console.log("");
const sections = [...new Set(results.map((r) => r.section))];
for (const s of [...sections, "overall"]) {
  const rs = s === "overall" ? results : results.filter((r) => r.section === s);
  const h1 = rs.filter((r) => r.rank === 1).length;
  const h3 = rs.filter((r) => r.rank && r.rank <= 3).length;
  console.log(`${s.padEnd(14)} hit@1 ${h1}/${rs.length}   hit@3 ${h3}/${rs.length}`);
}

process.exit(results.some((r) => r.error) ? 2 : 0);
