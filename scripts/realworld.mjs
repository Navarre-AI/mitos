// realworld.mjs - `npm run bench`. Real-world search benchmark: Mitos against a
// model of a standard FileMaker search (eval/fm-baseline.mjs), on the bundled
// sample data. Cases are in eval/realworld-suite.mjs.
//
// Mitos runs the same way `npm test` runs it: a throwaway DATA_DIR, a free
// port, every FM_* and AI key removed, so it never touches FileMaker and never
// calls a model. The only exception is the optional AI run below.
//
//   npm run bench                    run, print a table, write eval/realworld-report.md
//   npm run bench -- --group phones  only groups whose name contains this text
//   npm run bench -- --no-ai         never try the AI run, even with a key
//
// AI run: when OPENAI_API_KEY is in the environment, a second Mitos starts with
// semantic search on and the cases marked `ai` are run against it too. The key
// goes to that child process only and is never printed. Without a key those
// cases are reported "needs AI, not run" (FileMaker's result is still shown).
// The AI path could not be exercised where this was written (no key); treat it
// as untested until it has run once.
//
// Exit code: 0 when the benchmark ran, 1 when Mitos could not start. A bad
// score never fails the run: this is a report, not a gate.

import fs from "fs";
import os from "os";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { loadData, fmFind, titleOf } from "../eval/fm-baseline.mjs";
import { DEFAULT_TABLES } from "../tables.config.js";
import { CASES } from "../eval/realworld-suite.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ONLY = opt("--group");
const NO_AI = args.includes("--no-ai");
const HAVE_KEY = Boolean(process.env.OPENAI_API_KEY) && !NO_AI;
const REPORT = path.join(ROOT, "eval", "realworld-report.md");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- start a Mitos (same shape as scripts/test.mjs) ----------------------------------------------
const kids = [];
function stopAll() { for (const k of kids) { try { k.child.kill("SIGKILL"); } catch {} try { fs.rmSync(k.dir, { recursive: true, force: true }); } catch {} } }
process.on("SIGINT", () => { stopAll(); process.exit(130); });
process.on("SIGTERM", () => { stopAll(); process.exit(143); });

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });

function cleanEnv(port, dataDir, withOpenAI) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FM_|EMBED_|ANTHROPIC|OPENAI|GEMINI|GOOGLE|NAMING|SITE_PASSWORD|MITOS_|FLY_|DUCKDB_(PATH|VEC_PATH)|LOAD_SAMPLE|DATA_DIR|PORT)/i.test(k)) continue;
    if (/(_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i.test(k)) continue;
    env[k] = v;
  }
  if (withOpenAI) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return { ...env, PORT: String(port), DATA_DIR: dataDir, ...(withOpenAI ? {} : { MITOS_MODEL_LIST_URL: "" }) };
}

async function startMitos({ ai }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-bench-"));
  if (ai) {
    const tables = Object.fromEntries(Object.entries(DEFAULT_TABLES).map(([n, t]) => [n, { ...t, semantic: true }]));
    // columnsMigrated: a 1.2 config, so the boot migration leaves the per-table semantic switches alone.
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ tables, columnsMigrated: "1.2", ai: { stages: { rerank: { on: true } } } }, null, 2));
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "", exited = false;
  const child = spawn(process.execPath, ["--import", path.join(ROOT, "scripts", "test-preload.mjs"), path.join(ROOT, "server.js")], { cwd: ROOT, env: cleanEnv(port, dir, ai), stdio: ["ignore", "pipe", "pipe"] });
  kids.push({ child, dir });
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  child.on("exit", () => { exited = true; });
  const j = async (url, init) => { const r = await fetch(base + url, { ...init, signal: AbortSignal.timeout(60000) }); return r.json(); };
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error("Mitos exited at start:\n" + log.slice(-800));
    try { const h = await j("/api/health"); if (h.ok) { if (h.fm) throw new Error("FileMaker is configured in the bench server. Refusing to go on."); break; } } catch (e) { if (/FileMaker/.test(e.message)) throw e; }
    await sleep(100);
  }
  // The boot lines come after the model list loads, which takes a moment with a key set.
  for (let i = 0; i < 150 && !/\bfm: /.test(log); i++) await sleep(100);
  if (!/sample mode/.test(log)) throw new Error("Mitos did not report sample mode:\n" + log.slice(-800));
  await j("/api/index/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  for (let i = 0; i < (ai ? 1200 : 300); i++) {
    if (exited) throw new Error("Mitos exited while indexing:\n" + log.slice(-800));
    const st = await j("/api/index/job");
    if (st.job && st.job.done) { if (st.job.error) throw new Error("sync failed: " + st.job.error); break; }
    await sleep(150);
  }
  const h = await j("/api/health");
  if (!h.indexRows) throw new Error("sample did not index:\n" + log.slice(-800));
  return { base, j, rows: h.indexRows, version: h.version };
}

// ---- run one case ---------------------------------------------------------------------------------
const q = (s) => encodeURIComponent(s);
const titleMitos = (m) => Object.values(m.display || {})[0] ?? m.id;

async function runMitos(srv, c, extra = "") {
  // limit 20: where the wanted record is at all, and its place in the merged list.
  // default limit (5 per table): the list a person is actually shown.
  const wide = await srv.j(`/api/search?q=${q(c.q)}&limit=20${extra}`);
  const shown = await srv.j(`/api/search?q=${q(c.q)}${extra}`);
  if (wide.error) return { error: wide.error };
  // Semantic matches come back as a second list (similarMerged), shown under the exact ones, as on screen.
  const merged = [...(wide.merged || []), ...(wide.similarMerged || [])];
  const want = new Set(c.ids);
  const pos = merged.findIndex((m) => m.table === c.table && want.has(m.id));
  const got = new Set(merged.filter((m) => m.table === c.table).map((m) => m.id));
  return {
    rank: pos < 0 ? null : pos + 1,
    inTable: (() => { const g = (wide.groups || []).find((x) => x.table === c.table); const i = g ? g.results.findIndex((r) => want.has(r.id)) : -1; return i < 0 ? null : i + 1; })(),
    size: (shown.merged || []).length + (shown.similarMerged || []).length,
    complete: c.set ? c.ids.filter((id) => got.has(id)).length / c.ids.length : null,
    top: merged.slice(0, 3).map((m) => ({ title: titleMitos(m), id: m.id, table: m.table, ok: m.table === c.table && want.has(m.id) })),
    kind: wide.kind,
  };
}

function runFm(data, c) {
  const found = fmFind(data, c);
  const want = new Set(c.ids);
  const i = found.findIndex((id) => want.has(id));
  // The sample's note column once held the benchmark's own queries ("search 'Bob Whitfield' should find"),
  // removed 2026-11-21. Still flag a FileMaker hit that exists only because of the note column.
  const j = fmFind(data, c, ["note"]).findIndex((id) => want.has(id));
  return {
    viaNote: i >= 0 && j < 0,
    rank: i < 0 ? null : i + 1,
    size: found.length,
    complete: c.set ? c.ids.filter((id) => found.includes(id)).length / c.ids.length : null,
    top: found.slice(0, 3).map((id) => ({ title: titleOf(data, c.table, id), id, ok: want.has(id) })),
  };
}

// ---- metrics ---------------------------------------------------------------------------------------
const frac = (n, d) => (d ? n / d : null);
function metrics(rows, side) {
  const r = rows.map((x) => x[side]).filter(Boolean);
  const hit = (k) => frac(r.filter((x) => x.rank && x.rank <= k).length, r.length);
  const nonEmpty = r.filter((x) => x.size > 0);
  const sets = r.filter((x) => x.complete !== null);
  return {
    n: r.length,
    found: frac(r.filter((x) => x.rank).length, r.length),
    at1: hit(1), at3: hit(3), at10: hit(10),
    t1: side === "mitos" || side === "mitosAi" ? frac(r.filter((x) => x.inTable === 1).length, r.length) : null,
    viaNote: r.filter((x) => x.viaNote).length,
    zero: frac(r.filter((x) => x.size === 0).length, r.length),
    size: nonEmpty.length ? nonEmpty.reduce((a, x) => a + x.size, 0) / nonEmpty.length : null,
    complete: sets.length ? sets.reduce((a, x) => a + x.complete, 0) / sets.length : null,
  };
}
const better = (m, f) => (m.rank ?? Infinity) < (f.rank ?? Infinity) ? "win" : (m.rank ?? Infinity) > (f.rank ?? Infinity) ? "loss" : "tie";

const pc = (x) => (x === null ? "  - " : String(Math.round(x * 100)).padStart(3) + "%");
const pcs = (x) => (x === null ? "-" : Math.round(x * 100) + "%");
const f1 = (x) => (x === null ? "-" : x.toFixed(1));
const pad = (s, n) => String(s).padEnd(n);

// ---- main --------------------------------------------------------------------------------------------
const t0 = Date.now();
let code = 0;
try {
  const data = loadData();
  const cases = CASES.filter((c) => !ONLY || c.group.includes(ONLY));
  const srv = await startMitos({ ai: false });
  console.log(`Mitos ${srv.version || ""} on the sample data (${srv.rows} rows), deterministic: no FileMaker, no AI. ${cases.length} cases.`);

  // AI run (optional)
  let aiSrv = null, aiNote = "needs AI, not run (no OPENAI_API_KEY in the environment)";
  if (NO_AI) aiNote = "needs AI, not run (--no-ai)";
  if (HAVE_KEY) {
    try { aiSrv = await startMitos({ ai: true }); aiNote = "run with semantic search on (OpenAI)"; }
    catch (e) { aiNote = "needs AI, not run (AI server did not start: " + String(e.message).split("\n")[0].replace(/sk-[\w-]+/g, "***") + ")"; console.error("AI server log:\n" + String(e.message).replace(/sk-[\w-]+/g, "***")); }
  }

  const rows = [];
  for (const c of cases) {
    const fm = runFm(data, c);
    const mitos = await runMitos(srv, c);
    const row = { c, fm, mitos: mitos.error ? { rank: null, size: 0, complete: null, top: [], error: mitos.error } : mitos };
    if (c.ai && aiSrv) {
      const a = await runMitos(aiSrv, c, `&ai=1&stages=${process.env.BENCH_AI_STAGES || "exact,fuzzy,semantic,rerank"}`);
      row.mitosAi = a.error ? { rank: null, size: 0, complete: null, top: [], error: a.error } : a;
    }
    row.outcome = better(row.mitosAi || row.mitos, fm);
    rows.push(row);
  }

  // metric tables
  const groups = [...new Set(rows.map((r) => r.c.group))];
  const gm = groups.map((g) => { const rs = rows.filter((r) => r.c.group === g); return { g, rs, fm: metrics(rs, "fm"), mitos: metrics(rs, "mitos"), ai: rs.some((r) => r.mitosAi) ? metrics(rs.map((r) => ({ mitosAi: r.mitosAi || r.mitos })), "mitosAi") : null, w: rs.filter((r) => r.outcome === "win").length, t: rs.filter((r) => r.outcome === "tie").length, l: rs.filter((r) => r.outcome === "loss").length }; });
  const plain = rows.filter((r) => !r.c.ai);
  const overall = { all: { fm: metrics(rows, "fm"), mitos: metrics(rows, "mitos") }, plain: { fm: metrics(plain, "fm"), mitos: metrics(plain, "mitos") } };
  const tally = (rs) => ({ w: rs.filter((r) => r.outcome === "win").length, t: rs.filter((r) => r.outcome === "tie").length, l: rs.filter((r) => r.outcome === "loss").length });

  // terminal
  const head = `${pad("group", 24)} ${pad("n", 3)} ${pad("who", 7)} found  @1   @3   @10  zero  set   complete  @1 in own table`;
  console.log("\n" + head + "\n" + "-".repeat(head.length));
  const line = (label, n, who, m) => console.log(`${pad(label, 24)} ${pad(n, 3)} ${pad(who, 7)} ${pc(m.found)} ${pc(m.at1)} ${pc(m.at3)} ${pc(m.at10)} ${pc(m.zero)} ${pad(f1(m.size), 5)} ${pad(pcs(m.complete), 8)} ${m.t1 === null ? "" : pcs(m.t1)}`);
  for (const x of gm) {
    line(x.g, x.rs.length, "FM", x.fm); line("", "", "Mitos", x.mitos);
    if (x.ai) line("", "", "MitosAI", x.ai);
    console.log(`${pad("", 24)} ${pad("", 3)} Mitos wins ${x.w}, ties ${x.t}, loses ${x.l}`);
  }
  console.log("-".repeat(head.length));
  line("ALL cases", rows.length, "FM", overall.all.fm); line("", "", "Mitos", overall.all.mitos);
  line("without AI cases", plain.length, "FM", overall.plain.fm); line("", "", "Mitos", overall.plain.mitos);
  const T = tally(plain);
  console.log(`\nWithout the AI cases: Mitos wins ${T.w}, ties ${T.t}, loses ${T.l} of ${plain.length}.  AI cases: ${aiNote}.`);
  console.log("set = mean found-set size when something is found (FileMaker: the whole found set; Mitos: rows shown, 5 per table). complete = share of a range's records found.");

  // worst Mitos misses
  const misses = rows.filter((r) => !r.c.ai || r.mitosAi).filter((r) => { const m = r.mitosAi || r.mitos; return !m.rank || m.rank > 3; })
    .sort((a, b) => ((b.mitosAi || b.mitos).rank ?? 999) - ((a.mitosAi || a.mitos).rank ?? 999) || (a.fm.rank ?? 999) - (b.fm.rank ?? 999));
  console.log(`\nWorst Mitos misses (not in the first 3): ${misses.length}`);
  for (const r of misses.slice(0, 25)) { const m = r.mitosAi || r.mitos; console.log(`  [${r.c.group}] "${r.c.q}" -> Mitos ${m.rank ? "#" + m.rank : "not found"}, FileMaker ${r.fm.rank ? "#" + r.fm.rank + " of " + r.fm.size : "not found"}`); }

  // ---- report ----------------------------------------------------------------------------------------
  const L = [];
  const row = (label, m) => `| ${label} | ${pcs(m.found)} | ${pcs(m.at1)} | ${pcs(m.at3)} | ${pcs(m.at10)} | ${pcs(m.zero)} | ${f1(m.size)} | ${m.t1 === null ? "n/a" : pcs(m.t1)} |`;
  const tblHead = "| | Found | Position 1 | Top 3 | Top 10 | Zero results | Mean found set | Position 1 in its own table |\n|---|---|---|---|---|---|---|---|";
  L.push("# Mitos against a standard FileMaker search", "");
  L.push(`Mitos ${srv.version || ""}, run ${new Date().toISOString().slice(0, 10)}, on the bundled sample data (${srv.rows} records: people, organizations, products). ${rows.length} cases, ${plain.length} of them answerable without AI. Generated by \`npm run bench\`.`, "");
  L.push("## What is being compared", "");
  L.push("- **FileMaker, Quick Find:** every word must match the start of a word in some field, accents and case ignored, all words required, results in record order with no ranking, one table at a time. A typo finds nothing.");
  L.push("- **FileMaker, developer-built find** (used for ranges, dates, `==`, `*`): `900...1500`, `>=`, partial dates like `5/2019`, wildcards. It needs the right field and the right syntax.");
  L.push("- **Mitos:** the deterministic search (exact words, close spelling, name list, typed numbers, ranges, dates, phones, emails). No AI unless noted.");
  L.push("- **A favour to FileMaker:** every case is given the correct table. A real user on the wrong layout finds nothing. Mitos searches all tables and has to put the right one up front.");
  L.push("- **Position** means: for FileMaker, the place in the unsorted found set; for Mitos, the place in the merged list across all tables (up to 20 rows read). Mitos shows 5 rows per table by default.");
  L.push("- The FileMaker side is a model written from the Claris Help pages, not FileMaker itself. See the open questions at the end.", "");
  L.push("## How FileMaker was set up (read this first)", "");
  L.push("FileMaker got the best case a developer could set up, every time:", "");
  L.push("- **The right table.** Each search ran on the one table that holds the answer. A real user has to be on the right layout first; on the wrong one, FileMaker finds nothing. Mitos searched every table at once.");
  L.push("- **The right field and syntax** for ranges, dates and operators (`900...1500` in price, `5/2019` in a date field, `==` in full_name). A real user has to know both.");
  L.push("- **No ranking needed.** With 288 records most found sets are one or two records, so FileMaker's record order rarely costs it anything here. In a real file it would.", "");
  L.push("So FileMaker's numbers below are a ceiling, and Mitos's are what a user gets typing into one box.", "");
  L.push("## Headline", "");
  L.push(`Cases answerable without AI (${plain.length}):`, "", tblHead, row("FileMaker", overall.plain.fm), row("Mitos", overall.plain.mitos), "");
  L.push(`Per case, Mitos vs FileMaker: **wins ${T.w}, ties ${T.t}, loses ${T.l}** (a win means the wanted record sits higher, or FileMaker did not find it at all).`, "");
  L.push(`All ${rows.length} cases, including the ${rows.length - plain.length} that need AI (Mitos without AI):`, "", tblHead, row("FileMaker", overall.all.fm), row("Mitos", overall.all.mitos), "");
  L.push(`AI cases: ${aiNote}.`, "");
  L.push("## By group", "");
  L.push("| Group | Cases | FM found | Mitos found | FM at 1 | Mitos at 1 | Mitos at 1 in own table | FM top 3 | Mitos top 3 | FM zero | Mitos zero | FM set | Mitos set | Mitos W/T/L |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const x of gm) L.push(`| ${x.g}${x.rs.some((r) => r.c.ai) ? " *" : ""} | ${x.rs.length} | ${pcs(x.fm.found)} | ${pcs(x.mitos.found)} | ${pcs(x.fm.at1)} | ${pcs(x.mitos.at1)} | ${pcs(x.mitos.t1)} | ${pcs(x.fm.at3)} | ${pcs(x.mitos.at3)} | ${pcs(x.fm.zero)} | ${pcs(x.mitos.zero)} | ${f1(x.fm.size)} | ${f1(x.mitos.size)} | ${x.w}/${x.t}/${x.l} |`);
  L.push("", "\\* the group holds cases marked as needing AI; Mitos is shown without AI unless an AI run is reported above. \"Set\" is the mean number of records a person must scan when something comes back. W/T/L counts the cases where Mitos puts the right record higher / the same / lower than FileMaker.", "");
  const sets = gm.filter((x) => x.fm.complete !== null);
  if (sets.length) {
    L.push("Ranges and months, share of the wanted records that came back (a range lists every match in FileMaker; Mitos shows 5 rows per table):", "");
    for (const x of sets) L.push(`- ${x.g}: FileMaker ${pcs(x.fm.complete)}, Mitos ${pcs(x.mitos.complete)}`);
    L.push("");
  }

  L.push("## Examples by group", "", "Each shows what was typed, what FileMaker returned (first three, with the size of the found set), and what Mitos returned (first three of the merged list). The wanted record is marked with `*`.", "");
  const fmtTop = (t) => (t.top.length ? t.top.map((x) => (x.ok ? "**" + x.title + "** *" : x.title)).join("; ") : "nothing");
  for (const x of gm) {
    const pick = [];
    for (const o of ["win", "loss", "tie"]) { const r = x.rs.find((r) => r.outcome === o && !pick.includes(r)); if (r) pick.push(r); }
    for (const r of x.rs) { if (pick.length >= 3) break; if (!pick.includes(r) && r.outcome !== "tie") pick.push(r); }
    L.push(`### ${x.g}`, "");
    for (const r of pick) {
      const m = r.mitosAi || r.mitos;
      L.push(`- \`${r.c.q}\` (${r.outcome === "win" ? "Mitos better" : r.outcome === "loss" ? "FileMaker better" : "same"}${r.c.ai ? ", needs AI" : ""}${r.c.fm !== undefined ? ", FileMaker used a find in the " + r.c.fm.field + " field" : ""})`);
      L.push(`  - FileMaker: ${r.fm.size} found. ${fmtTop(r.fm)}`);
      L.push(`  - Mitos${r.mitosAi ? " (AI)" : ""}: ${m.rank ? "right record at #" + m.rank : "right record not found"}. ${fmtTop(m)}`);
      if (r.c.why) L.push(`  - note: ${r.c.why}`);
    }
    L.push("");
  }

  // wins, ties, losses summary
  const byGroup = (o) => gm.filter((x) => x[o === "win" ? "w" : o === "tie" ? "t" : "l"] > 0).map((x) => `${x.g} (${x[o === "win" ? "w" : o === "tie" ? "t" : "l"]}/${x.rs.length})`).join(", ");
  L.push("## Where Mitos wins, ties and loses", "");
  L.push(`- **Wins:** ${byGroup("win") || "none"}. These are the cases FileMaker cannot do at all: typos, nicknames, a wrong or extra word, phones and dates typed in another style, and queries that need meaning.`);
  L.push(`- **Ties:** ${byGroup("tie") || "none"}. For exact names, word starts, and well-formed emails or phones, Quick Find already finds the record. The difference is order: FileMaker gives record order, Mitos puts the best record first.`);
  L.push(`- **Loses:** ${byGroup("loss") || "none"}. See the work list below.`, "");
  L.push("Things to keep in mind when reading the numbers:", "");
  L.push("- FileMaker was handed the right table and the right field for ranges. Real users are not.");
  L.push("- This sample has 288 records. A found set of 40 in a real 100,000 record file is far larger, so FileMaker's \"found set size\" here is flattering to it and Mitos's \"position 1\" is the number that scales.");
  L.push("- Mitos's Position 1 is measured in the merged list across tables. Where the right person is first in their own table but an organization (matched through an employee's name) sits above, Position 1 loses and \"Position 1 in its own table\" does not. This is the known table-order issue from `npm test`.");
  L.push("- Many FileMaker \"found\" cases land far down an unsorted list. Compare Position 1 and Top 3, not Found alone.");
  L.push("- The cases were written by one person (the author of the benchmark) who knows Mitos. Typos were picked as a real user might make them, not tuned to Mitos, but expect some bias toward what Mitos does.");
  if (overall.all.fm.viaNote) L.push(`- ${overall.all.fm.viaNote} of FileMaker's hits come only from the sample's note column. Check sample-data for query text left in notes.`);
  L.push("- The sample holds Greek, Cyrillic and Chinese records (P0002, P0003, P0201, P0202).", "");

  L.push("## Worst Mitos misses (ranking work list)", "", "Cases where the right record was not in Mitos's first 3 (AI cases only when an AI run happened), worst first.", "");
  if (!misses.length) L.push("None.");
  for (const r of misses) {
    const m = r.mitosAi || r.mitos;
    L.push(`- [${r.c.group}] \`${r.c.q}\` wants ${r.c.table} ${r.c.ids.slice(0, 3).join("/")}${r.c.ids.length > 3 ? "..." : ""}: Mitos ${m.rank ? "#" + m.rank : "not found"}${m.inTable ? ` (#${m.inTable} within its table)` : ""}, FileMaker ${r.fm.rank ? "#" + r.fm.rank + " of " + r.fm.size : "not found"}. Mitos gave: ${fmtTop(m)}`);
  }
  L.push("");
  L.push("## FileMaker model: open questions", "");
  L.push("- Word breaks: apostrophes, dots and @ are treated as word separators (so `Hank` finds `Hank's` and `matt.navarre@example.com` splits into four words). FileMaker's index rules vary by field language; not checked against a live file.");
  L.push("- A typed value with several parts (`773-9565`, an email) is matched generously: each part must start some word in the record. Real FileMaker may be stricter or looser.");
  L.push("- Quick Find on a date field with a bare year (`2019`) is modelled as matching that whole year. The Help describes partial dates for Find mode; Quick Find's handling was not confirmed.");
  L.push("- Quick Find on a number field is modelled as an exact number match (`45` finds price 45, not 450).");
  L.push("- Dates are read month first with `/`, `-` or `.` separators; `19.3.2019` and month names find nothing. A system set to day first would read some of them differently.");
  L.push("- No related-table text in Quick Find (Mitos joins employee names into organizations). A layout with a portal could change that.");
  L.push("- Position in the found set is record creation order (CSV order here). A real layout may have a saved sort.");
  L.push("");
  fs.writeFileSync(REPORT, L.join("\n"));
  console.log(`\nReport: eval/realworld-report.md  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.error("bench: " + e.message);
  code = 1;
} finally {
  stopAll();
}
process.exit(code);
