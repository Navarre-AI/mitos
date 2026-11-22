// test.mjs - `npm test`. A self-starting search test for Mitos.
//
// Starts Mitos on the bundled sample data in a throwaway DATA_DIR (the OS temp
// folder), on a free port, with every FM_* and AI key variable removed, so it
// never touches FileMaker and never calls an AI provider. Waits for the sample
// to index, runs eval/search-suite.mjs against /api/search, prints metrics per
// group, and shuts the server down. Deterministic: exact + fuzzy stages only.
//
//   npm test                                  run, print failures and metrics
//   npm test -- --all                         also print every passing case
//   npm test -- --save eval/baseline-X.json   write a baseline
//   npm test -- --compare eval/baseline-1.1.0.json   A/B against a baseline
//   npm test -- --show "Bob Whitfield"        print what the search returns, then stop
//   npm test -- --group names,dates           only these groups
//
// Exit code: 1 when a "must" case fails (or the server cannot start), else 0.
// "should" cases are reported, never fatal: they are known gaps or wishes.

import fs from "fs";
import os from "os";
import net from "net";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const VERBOSE = flag("--all");
const SAVE = opt("--save");
const COMPARE = opt("--compare");
const SHOW = opt("--show");
const ONLY = opt("--group") ? new Set(opt("--group").split(",")) : null;
const HARD_LIMIT_MS = 55000;
const HOUSE_RULES = "kicks = canvas sneakers\nebike = e-mountain bike = electric mountain bike\nCB = cold brew\n# a comment line\nsolo";

// ---- start the server -------------------------------------------------------------------
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  s.on("error", rej);
});

function cleanEnv(port, dataDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FM_|EMBED_|ANTHROPIC|OPENAI|GEMINI|GOOGLE|NAMING|SITE_PASSWORD|MITOS_|FLY_|DUCKDB_(PATH|VEC_PATH)|LOAD_SAMPLE|DATA_DIR|PORT)/i.test(k)) continue;
    if (/(_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i.test(k)) continue;
    env[k] = v;
  }
  // MITOS_MODEL_LIST_URL empty: no read of the public model list either. No network at all.
  return { ...env, PORT: String(port), DATA_DIR: dataDir, MITOS_MODEL_LIST_URL: "" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null, dataDir = null;
function stopAll() {
  try { child?.kill("SIGKILL"); } catch {}
  try { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.on("SIGINT", () => { stopAll(); process.exit(130); });
process.on("SIGTERM", () => { stopAll(); process.exit(143); });
const hardStop = setTimeout(() => { console.error(`test: over ${HARD_LIMIT_MS / 1000}s, giving up`); stopAll(); process.exit(1); }, HARD_LIMIT_MS);
hardStop.unref();

async function startMitos() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-test-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  child = spawn(process.execPath, ["--import", path.join(ROOT, "scripts", "test-preload.mjs"), path.join(ROOT, "server.js")], {
    cwd: ROOT, env: cleanEnv(port, dataDir), stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  let exited = false;
  child.on("exit", () => { exited = true; });
  const j = async (url, init) => { const r = await fetch(base + url, { ...init, signal: AbortSignal.timeout(15000) }); return r.json(); };
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error("Mitos exited at start:\n" + log.slice(-800));
    try { const h = await j("/api/health"); if (h.ok) { if (h.fm) throw new Error("FileMaker is configured in the test server. Refusing to go on."); break; } } catch (e) { if (/FileMaker/.test(e.message)) throw e; }
    await sleep(100);
  }
  if (!/sample mode/.test(log)) { await sleep(300); if (!/sample mode/.test(log)) throw new Error("Mitos did not report sample mode:\n" + log.slice(-800)); }
  // The house word list (R5), saved the way Settings saves it; the "house words" cases use these rules.
  await j("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ houseWords: HOUSE_RULES }) });
  await j("/api/index/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  for (let i = 0; i < 300; i++) {
    if (exited) throw new Error("Mitos exited while indexing:\n" + log.slice(-800));
    const st = await j("/api/index/job");
    if (st.job && st.job.done) { if (st.job.error) throw new Error("sync failed: " + st.job.error); break; }
    await sleep(150);
  }
  const h = await j("/api/health");
  if (!h.indexRows) throw new Error("sample did not index:\n" + log.slice(-800));
  return { base, j, rows: h.indexRows, version: h.version };
}

// ---- judge one case ---------------------------------------------------------------------
const groupOf = (data, t) => (data.groups || []).find((g) => g.table === t);
const rankIn = (data, t, ids) => {
  const g = groupOf(data, t); if (!g) return null;
  const i = g.results.findIndex((r) => ids.includes(r.id));
  return i < 0 ? null : i + 1;
};

function judge(c, data) {
  const why = [];
  const kinds = c.kind ? [].concat(c.kind) : null;
  const tgt = c.ids || c.all || c.exact || null;
  let rank = null;
  if (kinds && !kinds.includes(data.kind)) why.push(`read as ${data.kind}, expected ${kinds.join("/")}`);
  if (c.empty) { if ((data.merged || []).length) why.push(`expected nothing, got ${data.merged.length} rows`); }
  if (c.table && c.ids) {
    rank = rankIn(data, c.table, c.ids);
    const need = c.rank || 1;
    if (!rank) why.push(`${c.ids.join("/")} not in ${c.table}`);
    else if (rank > need) why.push(`${c.ids.join("/")} at ${c.table} #${rank}, need #${need}`);
  }
  if (c.table && c.all) {
    const need = c.rank || 5;
    const ranks = c.all.map((id) => rankIn(data, c.table, [id]));
    const bad = c.all.filter((id, i) => !ranks[i] || ranks[i] > need);
    rank = Math.min(...ranks.map((r) => r || 99)); if (rank === 99) rank = null; // for a set, the rank of the first wanted record
    if (bad.length) why.push(`${bad.join(", ")} not in the first ${need} of ${c.table}`);
  }
  if (c.table && c.exact) {
    const g = groupOf(data, c.table);
    const got = (g?.results || []).map((r) => r.id);
    const miss = c.exact.filter((x) => !got.includes(x)), extra = got.filter((x) => !c.exact.includes(x));
    rank = Math.min(...c.exact.map((id) => (got.indexOf(id) < 0 ? 99 : got.indexOf(id) + 1))); if (rank === 99) rank = null;
    if (miss.length || extra.length) why.push(`${c.table} gave [${got.join(",")}], expected exactly [${c.exact.join(",")}]`);
  }
  if (c.reason) { // some row in the table says this in its reason (`why`)
    const g = groupOf(data, c.table);
    if (!(g?.results || []).some((r) => (r.why || []).join(" ; ").includes(c.reason))) why.push(`no reason says "${c.reason}"`);
  }
  for (const t of c.notTables || []) if (groupOf(data, t)) why.push(`also searched ${t}`);
  for (const id of c.notIds || []) if ((data.merged || []).some((m) => m.id === id)) why.push(`${id} should not appear`);
  if (c.merged) {
    const n = c.merged.n || 3, first = (data.merged || []).slice(0, n);
    if (!first.some((m) => c.merged.ids.includes(m.id))) why.push(`${c.merged.ids.join("/")} not in merged first ${n}`);
  }
  if (c.first && (data.merged || [])[0]?.id !== c.first) why.push(`first row is ${(data.merged || [])[0]?.id}, expected ${c.first}`);
  if (c.balance) {
    const first = (data.merged || []).slice(0, c.balance.n).map((m) => m.table);
    const miss = c.balance.tables.filter((t) => !first.includes(t));
    if (miss.length) why.push(`no ${miss.join(", ")} row in merged first ${c.balance.n}`);
  }
  if (c.cap) for (const g of data.groups || []) if (g.results.length > c.cap) why.push(`${g.table} holds ${g.results.length} rows (cap ${c.cap})`);
  if (c.pctOrder) {
    for (const g of [...(data.groups || []), ...(data.similar || [])]) {
      const p = g.results.map((r) => r.pct);
      if (p.some((x) => typeof x !== "number")) why.push(`${g.table} rows carry no pct`);
      else if (p.some((x, i) => i && x > p[i - 1])) why.push(`${g.table} shows ${p.join(", ")}%, not top to bottom`);
    }
  }
  if ("best" in c) {
    const b = data.best;
    if (c.best === null && b) why.push(`Best Match flagged ${b.id}, expected none (close call)`);
    if (c.best && !b) why.push(`Best Match not flagged, expected ${c.best}`);
    if (c.best && b && b.id !== c.best) why.push(`Best Match is ${b.id}, expected ${c.best}`);
  }
  if (c.tableFirst) {
    const first = (data.groups || [])[0]?.table;
    if (first !== c.tableFirst) why.push(`first table is ${first || "none"}, expected ${c.tableFirst}`);
  }
  // metrics inputs
  const hasTarget = Boolean(c.table && tgt);
  const tableFirst = c.table ? (data.groups || [])[0]?.table === c.table : null;
  return { pass: why.length === 0, why, rank, hasTarget, tableFirst, zero: !(data.merged || []).length };
}

// ---- metrics ----------------------------------------------------------------------------
function metrics(rows) {
  const t = rows.filter((r) => r.hasTarget);
  const tf = rows.filter((r) => r.tableFirst !== null);
  const wantRows = rows.filter((r) => !r.empty);
  const f = (n, d) => (d ? n / d : null);
  return {
    cases: rows.length,
    passed: rows.filter((r) => r.pass).length,
    targets: t.length,
    hit1: f(t.filter((r) => r.rank === 1).length, t.length),
    hit3: f(t.filter((r) => r.rank && r.rank <= 3).length, t.length),
    mrr: f(t.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0), t.length),
    tableFirst: f(tf.filter((r) => r.tableFirst).length, tf.length),
    zero: f(wantRows.filter((r) => r.zero).length, wantRows.length),
  };
}
const pct = (x) => (x === null || x === undefined ? "  -  " : (x * 100).toFixed(0).padStart(3) + "% ");
const num = (x) => (x === null || x === undefined ? " -  " : x.toFixed(2));
const pad = (s, n) => String(s).padEnd(n);

// ---- main -------------------------------------------------------------------------------
const t0 = Date.now();
let exitCode = 0;
try {
  const { CASES } = await import(path.join(ROOT, "eval", "search-suite.mjs"));
  const { base, j, rows, version } = await startMitos();
  console.log(`Mitos ${version || ""} started on the sample data (${rows} rows) in ${((Date.now() - t0) / 1000).toFixed(1)}s. No FileMaker, no AI.`);

  if (SHOW) {
    const d = await j(`/api/search?q=${encodeURIComponent(SHOW)}`);
    console.log(`kind=${d.kind} best=${d.best ? d.best.id : "none"} searched=${d.searched}`);
    for (const g of d.groups || []) { console.log(`[${g.table}]`); for (const r of g.results) console.log(`  ${r.id}  ${r.score}  ${r.via}  ${Object.values(r.display)[0]}  (${(r.why || []).join("; ")})`); }
    stopAll(); process.exit(0);
  }

  const results = [];
  const seenKey = new Map();
  for (const c of CASES) {
    if (ONLY && !ONLY.has(c.group)) continue;
    let data, err = null;
    try { data = await j(`/api/search?q=${encodeURIComponent(c.q)}`); if (data.error) err = data.error; } catch (e) { err = e.message; }
    const base0 = `${c.group}|${c.q}`;
    const n = (seenKey.get(base0) || 0) + 1; seenKey.set(base0, n);
    const key = n > 1 ? `${base0}#${n}` : base0;
    const r = err ? { pass: false, why: [`search error: ${err}`], rank: null, hasTarget: Boolean(c.table && (c.ids || c.all || c.exact)), tableFirst: c.table ? false : null, zero: true } : judge(c, data);
    results.push({ key, group: c.group, q: c.q, level: c.level === "should" ? "should" : "must", empty: Boolean(c.empty), note: c.why || "", ...r });
  }

  // ---- the failed-searches report (R4): a search with no result, and (once a click is
  // recorded) a search with results nobody clicked. A click on another query does not count.
  if (!ONLY) {
    const go = (q) => j(`/api/search?q=${encodeURIComponent(q)}`);
    await go("xqzv nothing here"); await go("Hank"); await go("Murphy");
    await j("/api/click", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "Murphy", table: "people", record_id: "P0007", rank: 1 }) });
    await sleep(200);
    const f = await j("/api/log/failed");
    const row = (q) => (f.rows || []).find((r) => r.query === q);
    const checks = [
      [row("xqzv nothing here")?.zero === 1, "a search with no result is listed once"],
      [row("Hank")?.noClick >= 1, "a search with results and no click is listed"],
      [!row("Murphy"), "a search that got its click is not listed"],
      [f.clicking === true, "the report says clicks are being recorded"],
      [(f.rows || []).every((r, i, a) => !i || a[i - 1].last >= r.last), "newest first"],
    ];
    for (const [ok, what] of checks) { results.push({ key: "failed|" + what, group: "failed searches", q: what, level: "must", empty: false, note: "", pass: ok, why: ok ? [] : [what], rank: null, hasTarget: false, tableFirst: null, zero: false }); }
  }

  // ---- per case lines
  const fails = results.filter((r) => !r.pass);
  for (const r of results) {
    if (r.pass && !VERBOSE) continue;
    console.log(`${r.pass ? "pass" : r.level === "must" ? "FAIL" : "miss"}  ${pad(r.level, 6)} [${r.group}] "${r.q}"${r.pass ? "" : "  ->  " + r.why.join("; ")}${!r.pass && r.note ? `\n        why it is a should: ${r.note}` : ""}`);
  }

  // ---- metrics table
  const groups = [...new Set(results.map((r) => r.group))];
  const gm = Object.fromEntries(groups.map((g) => [g, metrics(results.filter((r) => r.group === g))]));
  const overall = metrics(results);
  console.log("");
  console.log(`${pad("group", 12)} ${pad("pass", 8)} ${pad("hit@1", 6)} ${pad("hit@3", 6)} ${pad("MRR", 5)} ${pad("table1", 7)} zero`);
  for (const [g, m] of [...Object.entries(gm), ["overall", overall]]) {
    console.log(`${pad(g, 12)} ${pad(`${m.passed}/${m.cases}`, 8)} ${pct(m.hit1)} ${pct(m.hit3)} ${num(m.mrr)}  ${pct(m.tableFirst)}  ${pct(m.zero)}`);
  }
  const mustFails = fails.filter((r) => r.level === "must");
  const shouldFails = fails.filter((r) => r.level === "should");
  console.log(`\n${results.length} cases: ${results.filter((r) => r.pass).length} pass, ${mustFails.length} must failed, ${shouldFails.length} should missed. Zero-result rate ${pct(overall.zero).trim()}. ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  if (mustFails.length) exitCode = 1;

  // ---- save / compare
  const snapshot = {
    version: version || null, savedAt: new Date().toISOString(), sampleRows: rows,
    overall, groups: gm,
    cases: Object.fromEntries(results.map((r) => [r.key, { level: r.level, pass: r.pass, rank: r.rank, tableFirst: r.tableFirst, zero: r.zero }])),
  };
  if (SAVE) { fs.writeFileSync(path.resolve(ROOT, SAVE), JSON.stringify(snapshot, null, 2) + "\n"); console.log(`saved ${SAVE}`); }
  if (COMPARE) {
    const A = JSON.parse(fs.readFileSync(path.resolve(ROOT, COMPARE), "utf8"));
    console.log(`\nCompare: A = ${COMPARE} (v${A.version}), B = this run`);
    const d = (a, b, p) => (a === null || b === null ? "  -  " : p ? `${(b - a >= 0 ? "+" : "")}${((b - a) * 100).toFixed(0)}pt` : `${(b - a >= 0 ? "+" : "")}${(b - a).toFixed(2)}`);
    console.log(`${pad("group", 12)} ${pad("hit@1", 9)} ${pad("hit@3", 9)} ${pad("MRR", 8)} ${pad("table1", 9)} zero`);
    for (const g of [...groups, "overall"]) {
      const a = g === "overall" ? A.overall : A.groups[g], b = g === "overall" ? overall : gm[g];
      if (!a) { console.log(`${pad(g, 12)} (new group)`); continue; }
      console.log(`${pad(g, 12)} ${pad(d(a.hit1, b.hit1, 1), 9)} ${pad(d(a.hit3, b.hit3, 1), 9)} ${pad(d(a.mrr, b.mrr), 8)} ${pad(d(a.tableFirst, b.tableFirst, 1), 9)} ${d(a.zero, b.zero, 1)}`);
    }
    const better = [], worse = [], moved = [];
    for (const r of results) {
      const a = A.cases[r.key]; if (!a) continue;
      if (!a.pass && r.pass) better.push(r); else if (a.pass && !r.pass) worse.push(r);
      else if (a.rank !== r.rank) moved.push(`${r.key}: rank ${a.rank ?? "none"} -> ${r.rank ?? "none"}`);
    }
    console.log(`\nfixed (${better.length}):` + better.map((r) => `\n  + [${r.level}] ${r.key}`).join(""));
    console.log(`broken (${worse.length}):` + worse.map((r) => `\n  - [${r.level}] ${r.key}  ${r.why.join("; ")}`).join(""));
    if (moved.length) console.log(`rank moved, pass unchanged (${moved.length}):` + moved.map((m) => `\n    ${m}`).join(""));
    if (worse.some((r) => r.level === "must")) exitCode = 1;
  }
} catch (e) {
  console.error("test: " + e.message);
  exitCode = 1;
} finally {
  stopAll();
}
// The recency tiebreak needs a modification stamp the sample data lacks: its own small check.
if (!args.length || args.every((a) => a === "--all")) {
  for (const f of ["test-recency.mjs", "test-clicks.mjs", "test-embedtext.mjs"]) {
    const rc = spawnSync(process.execPath, [path.join(ROOT, "scripts", f)], { stdio: "inherit" });
    if (rc.status !== 0) exitCode = 1;
  }
}
process.exit(exitCode);
