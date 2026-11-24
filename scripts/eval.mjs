// eval.mjs - runs the search test cases against a running Mitos server and
// reports hit@1 / hit@3 per section, plus two type checks per case: the
// front door read the input as the expected kind, and no table listed in
// `notTables` appears. Change the parser or the ranking, re-run, compare.
//
// Usage: npm run eval  (server must be running; MITOS_URL overrides the base;
// EVAL_CASES=<file> runs another cases file, such as the one
// scripts/make-test-data.mjs writes). A case's `notAny` lists strings that
// must not show in any row of the result (the robot vacuum for "robert bolt").

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MITOS_URL || "http://localhost:8080";
const KEY = process.env.SITE_PASSWORD || "";

const CASES = process.env.EVAL_CASES || path.join(__dirname, "..", "eval", "cases.json");
const { cases } = JSON.parse(fs.readFileSync(CASES, "utf8"));

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
      const rows = JSON.stringify((data.groups || []).map((g) => g.results.map((r) => r.display)));
      const unwanted = (c.notAny || []).filter((s) => rows.includes(s));
      if (unwanted.length) error = `${error ? error + "; " : ""}should not show ${unwanted.join(", ")}`;
    }
  } catch (e) {
    error = e.message;
  }
  // A case with no expectAny only checks what must not show (notAny).
  if (!error && !(c.expectAny || []).length) rank = 1;
  const mark = error ? "ERR " : rank === 1 ? "PASS" : rank ? `@${rank}  ` : "MISS";
  console.log(`${mark}  [${c.section}] "${c.query}" -> ${((c.expectAny || []).join(" | ") || `not ${(c.notAny || []).join(", ")}`)}${error ? `  (${error})` : ""}`);
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
