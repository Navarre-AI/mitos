// store.js - the local DuckDB copy of the shadowed FileMaker data, plus the
// mitos_index table that holds the searchable text per record.
// Adapted from Pythia's cube.js: same DuckDB-CLI-subprocess approach, same
// serialized single-writer queue, same OData sync path. New here: the flat
// search index (one row per source record) and a CSV sample loader.

import "./env.js";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { fetchAllRows, fetchCounts } from "./fm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const DB_PATH = process.env.DUCKDB_PATH || path.join(DATA_DIR, "mitos.duckdb");
// Prefer a bundled binary (postinstall fetches one into ./bin so `npm start`
// works without `brew install duckdb`); else DUCKDB_BIN; else PATH.
const LOCAL_DUCKDB = path.join(__dirname, "bin", process.platform === "win32" ? "duckdb.exe" : "duckdb");
const DUCKDB = process.env.DUCKDB_BIN || (fs.existsSync(LOCAL_DUCKDB) ? LOCAL_DUCKDB : "duckdb");
// DuckDB's memory ceiling on the write path: 40% of the machine, at least
// 128 MB. Node holds the rows being loaded at the same time.
const DUCK_MB = Number(process.env.DUCKDB_MEMORY_MB) || Math.max(128, Math.floor((os.totalmem() / 1048576) * 0.4));
fs.mkdirSync(TMP_DIR, { recursive: true });

const q = (id) => `"${String(id).replace(/"/g, '""')}"`; // quote a SQL identifier
const esc = (s) => String(s).replace(/'/g, "''");        // escape a SQL string literal

// Each sql() shells out to a fresh duckdb process. A write process holds an
// EXCLUSIVE lock on the file, so serialize all invocations through one
// in-process queue plus a short retry (same rationale as Pythia's cube.js).
let dbQueue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runDuckDB(query, allowWrite, dbPath = DB_PATH, safe = true) {
  return new Promise((resolve, reject) => {
    // Read path runs in -safe mode: no filesystem reads, no getenv, no
    // extension installs. The write path needs read_json/read_csv for loads.
    // The vector file's reads run without -safe (no user text reaches that
    // SQL: a vector literal and escaped ids only).
    //
    // The SQL goes in on STDIN, never as an argument. A query is as long as
    // the data it names: a DELETE listing ten thousand record ids passed as
    // `-c query` blew the kernel's argument limit ("spawn E2BIG", live sync,
    // 2026-09-07). Stdin has no such limit.
    const args = allowWrite ? [dbPath, "-json"] : [dbPath, "-readonly", ...(safe ? ["-safe"] : []), "-json"];
    const child = spawn(DUCKDB, args, { stdio: ["pipe", "pipe", "pipe"] });
    // A memory ceiling for the write path: a whole-row load of a big table
    // on a 512 MB box got DuckDB killed by the kernel ("exited null",
    // 2026-09-08). Under the ceiling DuckDB spills to disk instead.
    // The vector file's reads too: a cosine scan over 95,000 vectors with
    // DuckDB's default (80% of the box) got the read process killed next to
    // Node (2026-09-09). Not the -safe path: safe mode locks configuration,
    // and a SET there fails the whole query. Two threads: one shared core.
    const ceiling = (allowWrite || !safe) ? `SET memory_limit='${DUCK_MB}MB'; SET threads=2; ` + (allowWrite ? `SET temp_directory='${esc(TMP_DIR)}'; ` : "") : "";
    const out = [], err = [];
    let size = 0;
    child.stdout.on("data", (b) => { size += b.length; if (size <= 256 * 1024 * 1024) out.push(b); });
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) => reject(new Error(e.message)));
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString();
      if (code !== 0) return reject(new Error((stderr || `duckdb exited ${code}`).slice(0, 500)));
      const stdout = Buffer.concat(out).toString().trim();
      // With -json each statement that returns rows prints one array; the
      // callers here issue one reading statement per call (writes print none).
      try { resolve(stdout ? JSON.parse(stdout) : []); }
      catch (e) { reject(new Error("Bad DuckDB output: " + (stderr || e.message).slice(0, 300))); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(ceiling + (query.endsWith(";") ? query + "\n" : query + ";\n"));
  });
}

export function sql(query, { allowWrite = false } = {}) {
  if (!allowWrite && !/^\s*(select|with|pragma|describe|summarize)\b/i.test(query)) {
    return Promise.reject(new Error("Only SELECT/WITH queries are allowed here."));
  }
  const attempt = async () => {
    for (let i = 0; ; i++) {
      try { return await runDuckDB(query, allowWrite); }
      catch (e) {
        // A write (a sync, a vector pass) holds the file. A write waits its
        // turn for up to 10 s; a read on the search path gives up after 3 s,
        // so a search never stalls behind a pass (30 s, demo 2026-09-09).
        if (i < (allowWrite ? 40 : 12) && /conflicting lock|set lock/i.test(String(e.message))) { await sleep(250); continue; }
        throw e;
      }
    }
  };
  const result = dbQueue.then(attempt, attempt);
  dbQueue = result.then(() => {}, () => {});
  return result;
}

// The vector file's door: same queue, same retry, its own file. A missing
// file on a read means "no vectors yet", not an error.
const VEC_PATH = process.env.DUCKDB_VEC_PATH || path.join(DATA_DIR, "mitos-vec.duckdb");
export function vsql(query, { allowWrite = false } = {}) {
  if (!allowWrite && !fs.existsSync(VEC_PATH)) return Promise.resolve([]);
  const attempt = async () => {
    for (let i = 0; ; i++) {
      try { return await runDuckDB(query, allowWrite, VEC_PATH, false); }
      catch (e) {
        if (i < (allowWrite ? 40 : 12) && /conflicting lock|set lock/i.test(String(e.message))) { await sleep(250); continue; }
        throw e;
      }
    }
  };
  const result = dbQueue.then(attempt, attempt);
  dbQueue = result.then(() => {}, () => {});
  return result;
}

export function storeExists() {
  return fs.existsSync(DB_PATH);
}

// --- FileMaker sync (Pythia's proven path, unchanged in substance) -----------

// Free bytes on the data disk. Null when the platform cannot say.
export function freeDiskBytes() {
  try { const st = fs.statfsSync(DATA_DIR); return Number(st.bavail) * Number(st.bsize); } catch { return null; }
}
export function totalDiskBytes() {
  try { const st = fs.statfsSync(DATA_DIR); return Number(st.blocks) * Number(st.bsize); } catch { return null; }
}
const gb = (bytes) => `${(bytes / 1073741824).toFixed(1)} GB`;
// What one record costs on disk while it is pulled: the JSON page file and
// DuckDB's copy of it, about 1.5 KB each.
const BYTES_PER_ROW = 1536;

// The pull checkpoint: one small file beside the page file, rewritten after
// every page. A crash mid-pull (the box ran out of memory, a deploy) leaves
// both behind; the next sync of the same table with the same filter and
// watermark continues from `skip` instead of starting over.
const pageFileFor = (name) => path.join(TMP_DIR, `${name}.json`);
const checkpointFor = (name) => path.join(TMP_DIR, `${name}.pages.json`);
function readCheckpoint(name) {
  try { return JSON.parse(fs.readFileSync(checkpointFor(name), "utf8")); } catch { return null; }
}
function dropPull(name) {
  for (const f of [checkpointFor(name), pageFileFor(name)]) { try { fs.unlinkSync(f); } catch {} }
}

async function syncTable(table, { onProgress, onNote, onResumed, watermark, select, expected = null, label = null, shouldStop = () => false } = {}) {
  // `select` is the field list this table's config actually needs. Narrowing
  // it is the difference between a pull that finishes and one that times out:
  // the server evaluates only the fields we ask for, and unstored calculations
  // are the expensive ones. The primary key and the modification field are
  // added below, because incremental sync needs them whatever the config says.
  let cols = table.fields.filter((f) => f.type !== "Binary");
  if (select && select.length) {
    const want = new Set(select.map((n) => n.toLowerCase()));
    const pkGuess = table.keys?.[0];
    const modGuess = cols.find((f) => f.type === "DateTimeOffset" && /mod/i.test(f.name))?.name;
    if (pkGuess) want.add(pkGuess.toLowerCase());
    if (modGuess) want.add(modGuess.toLowerCase());
    const narrowed = cols.filter((f) => want.has(f.name.toLowerCase()));
    if (narrowed.length) cols = narrowed;
  }
  const names = cols.map((f) => f.name);
  const typeMap = { Decimal: "DOUBLE", String: "VARCHAR", Date: "DATE", DateTimeOffset: "TIMESTAMP", Boolean: "BOOLEAN" };
  const ddlType = (n) => typeMap[cols.find((c) => c.name === n).type] || "VARCHAR";
  const struct = names.map((n) => `${q(n)}: '${ddlType(n)}'`).join(", ");
  const name = table.name;
  const shown = label || name;

  const pk = table.keys?.[0] || names.find((n) => /^id$/i.test(n)) || null;
  const modField = cols.find((f) => f.type === "DateTimeOffset" && /mod/i.test(f.name))?.name || null;

  let incremental = Boolean(watermark && pk && modField);
  if (incremental) {
    const mainCols = (await sql(`SELECT column_name FROM information_schema.columns WHERE table_name='${esc(name)}' ORDER BY ordinal_position`)).map((r) => r.column_name);
    if (mainCols.length !== names.length || !names.every((n, i) => mainCols[i] === n)) incremental = false;
  }

  const wmOp = watermark && Date.now() - Date.parse(watermark) > 5 * 60 * 1000 ? "gt" : "ge";
  const filter = incremental ? `${modField} ${wmOp} ${watermark}` : null;
  const wm = watermark || null;

  // The page file: one JSON array, written a page at a time, never held in
  // memory. The checkpoint says how far it got.
  const file = pageFileFor(name);
  let ckpt = readCheckpoint(name);
  const resumable = ckpt && ckpt.filter === filter && ckpt.watermark === wm && fs.existsSync(file) && Number(ckpt.skip) > 0;
  if (!resumable) { dropPull(name); ckpt = null; }

  // EARLY FAILURE. A full pull of a big table needs its rows on disk twice
  // (the page file, then DuckDB's copy). Say so before the first page,
  // not after an hour, and name the table, the count and the free disk.
  if (!incremental && !ckpt && Number.isFinite(Number(expected)) && Number(expected) > 0) {
    const free = freeDiskBytes();
    const need = Number(expected) * BYTES_PER_ROW * 2;
    if (free !== null && need > free) {
      throw new Error(`Mitos cannot pull ${shown} (${Number(expected).toLocaleString()} records) with ${gb(free)} of free disk. ` +
        `It needs about ${gb(need)}. Add disk in Fly and try again, or leave this table out.`);
    }
  }

  let count = 0;          // rows written to the page file so far
  let maxMod = wm || "";  // the newest modification stamp seen, per page
  let fd = null;
  if (ckpt) {
    count = Number(ckpt.rows) || 0;
    maxMod = ckpt.maxMod || maxMod;
    // A checkpoint marked done has the whole array on disk: the crash came
    // between the last page and the DuckDB load. Only the load is left.
    if (!ckpt.done) fd = fs.openSync(file, "a");
    onResumed && onResumed(count);
  } else {
    fd = fs.openSync(file, "w");
    fs.writeSync(fd, "[");
  }
  const onPage = (page, { skip, size }) => {
    if (!page.length) return;
    const body = page.map((r) => JSON.stringify(r)).join(",");
    fs.writeSync(fd, (count ? "," : "") + body);
    count += page.length;
    if (modField) for (const r of page) if (r[modField] && r[modField] > maxMod) maxMod = r[modField];
    // The page is on disk before the checkpoint says so: a crash between the
    // two re-reads one page, never skips one.
    fs.writeFileSync(checkpointFor(name), JSON.stringify({ skip: skip + page.length, size, filter, watermark: wm, rows: count, maxMod, at: new Date().toISOString() }));
  };
  const pullStats = {};
  const resumedFrom = ckpt && !ckpt.done ? Number(ckpt.skip) || null : null;
  if (fd !== null) {
    try {
      await fetchAllRows(table.occurrences[0], names, {
        db: table.db, onProgress, onNote, onPage, select: names, shouldStop, stats: pullStats,
        startSkip: ckpt ? Number(ckpt.skip) : 0,
        // No $orderby: FileMaker sorts the whole table for every $skip page,
        // which took a 68,777-row pull from a minute to over twenty (2026-09-09).
        // A resume after a crash accepts the small chance of a shifted row.
        pageSize: ckpt ? Number(ckpt.size) || undefined : undefined,
        filter: filter || undefined,
      });
      fs.writeSync(fd, "]");
      fs.writeFileSync(checkpointFor(name), JSON.stringify({ ...(readCheckpoint(name) || { skip: count, size: 0, filter, watermark: wm }), rows: count, maxMod, done: true }));
    } catch (e) {
      // A cancel drops the half pull: a table is kept whole or not at all. Any
      // other failure keeps the page file and the checkpoint for a resume.
      fs.closeSync(fd);
      if (e && e.cancelled) dropPull(name);
      throw e;
    }
    fs.closeSync(fd);
  }
  const newWatermark = modField ? maxMod : null;

  let removed = 0;
  if (incremental) {
    if (count) {
      await sql(
        `CREATE TEMP TABLE _delta AS SELECT * FROM read_json('${esc(file)}', columns={${struct}}, format='array', maximum_object_size=16777216);` +
        `DELETE FROM ${q(name)} WHERE ${q(pk)} IN (SELECT ${q(pk)} FROM _delta);` +
        `INSERT INTO ${q(name)} SELECT * FROM _delta;`,
        { allowWrite: true }
      );
    }
    // DELETIONS. An incremental pull only sees rows that changed; a record
    // deleted in FileMaker never comes back in it, so its copy (and its index
    // row) would live on. One $count per sync tells whether anything is
    // missing; only then are the primary keys pulled (a narrow, fast read)
    // and the copies whose key is gone removed.
    try {
      const remote = (await fetchCounts([table], () => {}, shouldStop))[name];
      const local = Number((await sql(`SELECT count(*) c FROM ${q(name)}`))[0]?.c ?? 0);
      if (Number.isFinite(remote) && remote < local) {
        onNote && onNote(`${local - remote} record(s) were deleted in FileMaker since the last sync; checking which`);
        const keys = await fetchAllRows(table.occurrences[0], [pk], { db: table.db, select: [pk], shouldStop, onNote });
        const kfile = path.join(TMP_DIR, `${name}.keys.json`);
        fs.writeFileSync(kfile, JSON.stringify(keys.map((r) => ({ k: r[pk] }))));
        const before = local;
        await sql(
          `DELETE FROM ${q(name)} WHERE ${q(pk)} NOT IN (SELECT k FROM read_json('${esc(kfile)}', columns={k: '${ddlType(pk)}'}, format='array'))`,
          { allowWrite: true }
        );
        fs.unlinkSync(kfile);
        removed = before - Number((await sql(`SELECT count(*) c FROM ${q(name)}`))[0]?.c ?? 0);
      }
    } catch (e) {
      if (e && e.cancelled) throw e;
      onNote && onNote(`could not check for deleted records: ${String(e.message || e).slice(0, 120)}`);
    }
  } else {
    const load = count
      ? `CREATE OR REPLACE TABLE ${q(name)} AS SELECT * FROM read_json('${esc(file)}', columns={${struct}}, format='array', maximum_object_size=16777216);`
      : `CREATE OR REPLACE TABLE ${q(name)} (${names.map((n) => `${q(n)} ${ddlType(n)}`).join(", ")});`;
    await sql(load, { allowWrite: true });
  }
  // The rows are in DuckDB: the page file and the checkpoint have done
  // their work, and a big table's file is not left on a small disk.
  dropPull(name);
  const total = (await sql(`SELECT count(*) c FROM ${q(name)}`))[0]?.c ?? count;
  // The method in words, for the log line: "over OData, 9 fields by
  // $select, 1,000 a page" or "over OData, whole rows (the field list was
  // refused)". Empty when nothing was read (an incremental pull with no
  // changes still made one request, so the stats are there).
  const method = pullStats.pageSize
    ? `over OData, ${pullStats.wholeRows ? "whole rows (the field list was refused)" : `${pullStats.fields} fields by $select`}, ${Number(pullStats.pageSize).toLocaleString()} a page`
    : "over OData";
  return { name, db: table.db, rows: total, changed: count, removed, mode: incremental ? "incremental" : "full", watermark: newWatermark, columns: names,
    method, since: incremental ? wm : null, resumedFrom };
}

// The per-record beacon's write: a few rows replaced in the local copy by
// primary key, or removed. The local copy must already exist with the
// same columns (a table synced at least once).
export async function upsertShadowRows(name, pk, rows) {
  if (!rows.length) return 0;
  const cols = (await sql(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='${esc(name)}' ORDER BY ordinal_position`));
  if (!cols.length) throw new Error(`no local copy of ${name} yet; sync first`);
  const struct = cols.map((c) => `${q(c.column_name)}: '${c.data_type}'`).join(", ");
  const file = path.join(TMP_DIR, `beacon-${name.replace(/[^\w.-]+/g, "_")}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c) => [c.column_name, r[c.column_name] ?? null])))));
  await sql(
    `CREATE TEMP TABLE _b AS SELECT * FROM read_json('${esc(file)}', columns={${struct}}, format='array', maximum_object_size=16777216);` +
    `DELETE FROM ${q(name)} WHERE ${q(pk)} IN (SELECT ${q(pk)} FROM _b);` +
    `INSERT INTO ${q(name)} SELECT * FROM _b;`,
    { allowWrite: true }
  );
  fs.unlinkSync(file);
  return rows.length;
}
export async function deleteShadowRows(name, pk, keys) {
  if (!keys.length) return 0;
  await sql(`DELETE FROM ${q(name)} WHERE CAST(${q(pk)} AS VARCHAR) IN (${keys.map((k) => `'${esc(k)}'`).join(",")})`, { allowWrite: true });
  return keys.length;
}

export async function syncTables(tables, names, log = () => {}, onEvent = () => {}, { selects = {}, labels = {}, expected = {}, shouldStop = () => false } = {}) {
  // Sync in the ORDER GIVEN (the caller passes display order), not schema
  // order, so the screen and the work agree about what happens next.
  const wanted = new Map(tables.map((t) => [t.name, t]));
  const absent = names.filter((n) => !wanted.has(n));
  if (absent.length) throw new Error(`Not in the FileMaker schema: ${absent.join(", ")}. Nothing was pulled.`);
  const chosen = names.map((n) => wanted.get(n));
  const prior = Object.fromEntries((storeManifest().tables || []).map((t) => [t.name, t]));
  const results = [];
  for (const t of chosen) {
    if (shouldStop()) break;
    log(`syncing ${t.name}...`);
    onEvent({ type: "pull-start", name: t.name });
    const started = Date.now();
    // A cancel mid-table abandons THAT table whole: the local copy keeps
    // whatever it had before, finished tables stay, later tables are untouched.
    let r;
    try {
      r = await syncTable(t, {
      watermark: prior[t.name]?.watermark || null,
      select: selects[t.name],
      expected: expected[t.name] ?? null,
      label: labels[t.name] || null,
      shouldStop,
      onNote: (note) => { log(`  ${note}`); onEvent({ type: "note", name: t.name, note }); },
      onProgress: (n) => { log(`  ${t.name}: ${n} rows`); onEvent({ type: "pull-rows", name: t.name, rows: n }); },
      onResumed: (fromRow) => { log(`  ${t.name}: continuing from row ${fromRow}`); onEvent({ type: "pull-resumed", name: t.name, fromRow }); },
      });
    } catch (e) {
      if (e && e.cancelled) {
        log(`  ${t.name}: stopped; nothing kept for this table`);
        onEvent({ type: "pull-cancelled", name: t.name });
        break;
      }
      throw e;
    }
    log(`  ${t.name}: ${r.mode} ${r.method}${r.since ? ` since ${r.since}` : ""}${r.resumedFrom ? ` resumed at row ${r.resumedFrom}` : ""} / ${r.changed} changed / ${r.removed || 0} removed / ${r.rows} total`);
    onEvent({ type: "pull-done", name: t.name, rows: r.rows, changed: r.changed, removed: r.removed || 0, mode: r.mode, ms: Date.now() - started,
      method: r.method, since: r.since || null, resumedFrom: r.resumedFrom || null });
    results.push(r);
  }
  const manifest = storeManifest();
  const byName = Object.fromEntries((manifest.tables || []).map((t) => [t.name, t]));
  for (const r of results) byName[r.name] = r;
  const merged = Object.values(byName);
  const out = { db: DB_PATH, syncedAt: new Date().toISOString(), host: os.hostname(), tables: merged, totalRows: merged.reduce((a, b) => a + b.rows, 0) };
  fs.writeFileSync(path.join(DATA_DIR, "store-manifest.json"), JSON.stringify(out, null, 2));
  // This run's tables alone, for the sync summary (the file holds every table).
  return { ...out, pulled: results };
}

export function storeManifest() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "store-manifest.json"), "utf8")); }
  catch { return { syncedAt: null, tables: [], totalRows: 0 }; }
}

// --- Bundled sample data ------------------------------------------------------
// Out-of-box play: when no FileMaker connection is configured, load the
// bundled fictional dataset (sample-data/*.csv) so a fresh clone works with
// just the two AI keys. The first real FM sync replaces these tables.
const SAMPLE_DIR = path.join(__dirname, "sample-data");

export function sampleAvailable() {
  if (process.env.LOAD_SAMPLE === "0" || process.env.LOAD_SAMPLE === "false") return false;
  try { return fs.readdirSync(SAMPLE_DIR).some((f) => f.endsWith(".csv")); } catch { return false; }
}

// The newest CSV's mtime, so a changed sample file gets reloaded.
export function sampleUpdatedAt() {
  try {
    return Math.max(...fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".csv")).map((f) => fs.statSync(path.join(SAMPLE_DIR, f)).mtimeMs));
  } catch { return 0; }
}

export async function loadSampleData(log = () => {}) {
  const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".csv")).sort();
  const tables = [];
  for (const f of files) {
    const name = f.replace(/\.csv$/, "");
    const file = esc(path.join(SAMPLE_DIR, f));
    await sql(`CREATE OR REPLACE TABLE ${q(name)} AS SELECT * FROM read_csv('${file}', header=true)`, { allowWrite: true });
    const rows = (await sql(`SELECT count(*) c FROM ${q(name)}`))[0]?.c ?? 0;
    log(`sample: loaded ${name} (${rows} rows)`);
    tables.push({ name, rows, changed: rows, mode: "sample", watermark: null, columns: [] });
  }
  const out = { db: DB_PATH, syncedAt: new Date().toISOString(), host: os.hostname(), sample: true, tables, totalRows: tables.reduce((a, b) => a + b.rows, 0) };
  fs.writeFileSync(path.join(DATA_DIR, "store-manifest.json"), JSON.stringify(out, null, 2));
  return out;
}

// --- The search index ---------------------------------------------------------
// One flat table, one row per source record. `display` is verbatim source
// data, `source_text` is the "field: value" text the record was indexed from,
// and `search_text` / `title_text` are the normalized forms the search runs
// on. No vectors: search is deterministic (see search.js).

// Normalization, applied identically to indexed text and to queries: lower
// case, accents stripped, everything that is not a letter or digit becomes a
// space, padded with one space each side so "% word%" is a word-start match
// and "% word %" is a whole-word match in SQL LIKE.
export function normalizeText(s) {
  const flat = String(s ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return flat ? ` ${flat} ` : "";
}
export const tokenize = (normalized) => normalized.split(" ").filter(Boolean);

// Typed columns beside the text. Search never guesses a type from the text:
// the indexer decides per field (number, date, email, phone) and the query
// parser decides per query; a number query meets number values, a date
// range meets date values. `nums` and `dates` are lists because a record can
// hold several of each; `emails` and `digits` are space-padded strings like
// search_text, so LIKE '% x %' is a whole-value match.
const INDEX_COLUMNS = {
  src_table: "VARCHAR", record_id: "VARCHAR", display: "VARCHAR", source_text: "VARCHAR",
  search_text: "VARCHAR", title_text: "VARCHAR",
  nums: "DOUBLE[]", dates: "DATE[]", emails: "VARCHAR", digits: "VARCHAR",
  content_hash: "VARCHAR",
};
// Filled by the optional stages after the deterministic index is written.
// A row that changes is deleted and re-inserted without them, which is the
// whole invalidation rule: new content, new enrichment, new vector.
//   enrich_text  what the enrichment model wrote (searched, never shown)
//   enrich_norm  the same, normalized like search_text
//   enrich_key   model + prompt that wrote it; a different key re-enriches
// Vectors live in their OWN DuckDB file (mitos-vec.duckdb), one table
// mitos_vec (src_table, record_id, vec_key, vec FLOAT[dims]), no primary
// key, written by delete-and-insert in batches of thousands. Three reasons,
// all from the 512 MB demo box (2026-09-08/09): an UPDATE of an array
// column across 95,000 rows asked for 512 MiB at once; inserting through a
// primary key slowed to 500 rows a minute as the table grew; and the
// vectors inside the index file took it from 83 MB to 645 MB, which broke
// the page cache for the exact search. In their own file a change of size
// is a file delete. vec_key is provider/model/size, see embed.js.
const STAGE_COLUMNS = { enrich_text: "VARCHAR", enrich_norm: "VARCHAR", enrich_key: "VARCHAR" };
const VEC_DDL = (dims) => `CREATE TABLE IF NOT EXISTS mitos_vec (src_table VARCHAR, record_id VARCHAR, vec_key VARCHAR, vec FLOAT[${Number(dims)}])`;

export async function ensureIndexTable() {
  // An index built by an older pipeline (embedding column, or no typed
  // columns) cannot be reused: drop it and start clean. The next build
  // rewrites every row anyway, because the hash inputs changed.
  const cols = await sql(`SELECT column_name FROM information_schema.columns WHERE table_name='mitos_index'`).catch(() => []);
  const names = cols.map((c) => c.column_name);
  if (names.length && (names.includes("embedding") || !names.includes("nums"))) {
    await sql(`DROP TABLE mitos_index`, { allowWrite: true });
  }
  const ddl = Object.entries(INDEX_COLUMNS).map(([c, t]) => `${c} ${t}`).join(", ");
  await sql(
    `CREATE TABLE IF NOT EXISTS mitos_index (${ddl}, indexed_at TIMESTAMP, PRIMARY KEY (src_table, record_id))`,
    { allowWrite: true }
  );
  // The stage columns arrive on an index built before the stages existed.
  const have = new Set((await sql(`SELECT column_name FROM information_schema.columns WHERE table_name='mitos_index'`).catch(() => [])).map((c) => c.column_name));
  const missing = Object.entries(STAGE_COLUMNS).filter(([c]) => !have.has(c));
  // (An index from the one build that put a `vec` column on this table
  // keeps it, all NULL: dropping it would rewrite the table on a small box.
  // The next full rebuild loses it.)
  if (missing.length) {
    await sql(missing.map(([c, t]) => `ALTER TABLE mitos_index ADD COLUMN ${c} ${t};`).join(" "), { allowWrite: true });
  }
  // The one build that kept vectors inside this file left a table behind;
  // dropping it frees its blocks for reuse (the file itself never shrinks:
  // delete mitos.duckdb and sync to get a compact one).
  if (have.size && (await sql(`SELECT 1 FROM information_schema.tables WHERE table_name='mitos_vec'`).catch(() => [])).length) {
    await sql(`DROP TABLE mitos_vec`, { allowWrite: true }).catch(() => {});
  }
}

// The vector file's column is FLOAT[dims]: fixed size, so
// array_cosine_similarity works without an extension. A change of size
// deletes the file; the vectors are rebuilt on the next sync.
export async function ensureVectorTable(dims) {
  const n = Math.max(8, Math.min(4096, Number(dims) || 256));
  const cols = await vsql(`SELECT data_type FROM information_schema.columns WHERE table_name='mitos_vec' AND column_name='vec'`).catch(() => []);
  const want = `FLOAT[${n}]`;
  if (cols.length && String(cols[0].data_type).toUpperCase() === want) return false;
  for (const f of [VEC_PATH, VEC_PATH + ".wal"]) { try { fs.unlinkSync(f); } catch {} }
  await vsql(VEC_DDL(n), { allowWrite: true });
  return true;
}
export const vectorFileSize = () => { try { return fs.statSync(VEC_PATH).size; } catch { return 0; } };

// --- Enrichment rows (index time) -------------------------------------------------------
// Rows of one table whose enrichment is missing or was written by another
// model or prompt. `key` is per table (model + prompt); a row's content
// change already cleared its enrichment through the upsert.
export async function rowsNeedingEnrichment(srcTable, key, limit) {
  return sql(
    `SELECT record_id, source_text FROM mitos_index
     WHERE src_table='${esc(srcTable)}' AND enrich_key IS DISTINCT FROM '${esc(key)}'
     ORDER BY record_id LIMIT ${Number(limit) || 1000}`
  );
}
// rows: [{ record_id, enrich_text, enrich_norm }]. Writing new enrichment
// also clears the row's vector: the vector must include the new text.
export async function writeEnrichment(srcTable, key, rows) {
  if (!rows.length) return 0;
  const file = path.join(TMP_DIR, `enrich-${srcTable.replace(/[^\w.-]+/g, "_")}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(rows.map((r) => ({ record_id: String(r.record_id), enrich_text: r.enrich_text, enrich_norm: r.enrich_norm }))));
  await sql(
    `CREATE TEMP TABLE _en AS SELECT * FROM read_json('${esc(file)}', columns={record_id: 'VARCHAR', enrich_text: 'VARCHAR', enrich_norm: 'VARCHAR'}, format='array', maximum_object_size=16777216);` +
    `UPDATE mitos_index SET enrich_text = _en.enrich_text, enrich_norm = _en.enrich_norm, enrich_key = '${esc(key)}' ` +
    `FROM _en WHERE mitos_index.src_table='${esc(srcTable)}' AND mitos_index.record_id = _en.record_id;`,
    { allowWrite: true }
  );
  // Their vectors were made without the new text: gone, rebuilt next sync.
  await dropVectorsFromFile(srcTable, file, "record_id");
  fs.unlinkSync(file);
  return rows.length;
}
// Forget a table's notes on purpose (POST /api/ai/enrich/forget). Switching
// a table or the stage off no longer calls this: the notes were paid for,
// and the search simply stops matching them while off.
export async function clearEnrichment(srcTable) {
  const n = Number((await sql(`SELECT count(*) c FROM mitos_index WHERE src_table='${esc(srcTable)}' AND enrich_key IS NOT NULL`))[0]?.c || 0);
  if (n) {
    await sql(`UPDATE mitos_index SET enrich_text = NULL, enrich_norm = NULL, enrich_key = NULL WHERE src_table='${esc(srcTable)}' AND enrich_key IS NOT NULL`, { allowWrite: true });
    await vsql(`DELETE FROM mitos_vec WHERE src_table='${esc(srcTable)}'`, { allowWrite: true }).catch(() => {});
  }
  return n;
}
// Delete the vectors of the ids listed in a JSON file (the same file a
// main-index write just loaded), in the vector file.
async function dropVectorsFromFile(srcTable, file, idColumn) {
  if (!fs.existsSync(VEC_PATH)) return;
  await vsql(
    `CREATE TEMP TABLE _ids AS SELECT ${idColumn} AS record_id FROM read_json('${esc(file)}', columns={${idColumn}: 'VARCHAR'}, format='array', maximum_object_size=16777216);` +
    `DELETE FROM mitos_vec WHERE src_table='${esc(srcTable)}' AND record_id IN (SELECT record_id FROM _ids);`,
    { allowWrite: true }
  ).catch(() => {});
}

// --- Vector rows (index time) ---------------------------------------------------------------
// Rows across all tables whose vector is missing or was made by another
// model or size. The index file's writer attaches the vector file read-only
// for the join. The text embedded is the source text plus the enrichment.
const attachVec = () => `ATTACH '${esc(VEC_PATH)}' AS vdb (READ_ONLY);`;
const NEEDS_VEC = (vecKey, tables) =>
  (fs.existsSync(VEC_PATH)
    ? `FROM mitos_index i LEFT JOIN vdb.mitos_vec v ON v.src_table = i.src_table AND v.record_id = i.record_id WHERE v.vec_key IS DISTINCT FROM '${esc(vecKey)}'`
    : `FROM mitos_index i WHERE true`) +
  (tables && tables.length ? ` AND i.src_table IN (${tables.map((n) => `'${esc(n)}'`).join(",")})` : "");
export async function rowsNeedingVectors(vecKey, limit, tables) {
  return sql(
    (fs.existsSync(VEC_PATH) ? attachVec() : "") +
    `SELECT i.src_table, i.record_id, i.source_text || coalesce(chr(10) || i.enrich_text, '') AS text ${NEEDS_VEC(vecKey, tables)}
     ORDER BY i.src_table, i.record_id LIMIT ${Number(limit) || 1000}`,
    { allowWrite: true }
  );
}
export async function countNeedingVectors(vecKey) {
  const r = await sql((fs.existsSync(VEC_PATH) ? attachVec() : "") + `SELECT count(*) c ${NEEDS_VEC(vecKey)}`, { allowWrite: true }).catch(() => [{ c: 0 }]);
  return Number(r[0]?.c || 0);
}
// rows: [{ src_table, record_id, vec: number[] }]. Delete then insert, in
// the vector file. No UPDATE of an array column, ever.
export async function writeVectors(vecKey, dims, rows) {
  if (!rows.length) return 0;
  const file = path.join(TMP_DIR, `vec-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(rows.map((r) => ({ src_table: r.src_table, record_id: String(r.record_id), vec: r.vec }))));
  await vsql(
    `CREATE TEMP TABLE _v AS SELECT * FROM read_json('${esc(file)}', columns={src_table: 'VARCHAR', record_id: 'VARCHAR', vec: 'FLOAT[]'}, format='array', maximum_object_size=16777216);` +
    `DELETE FROM mitos_vec WHERE (src_table, record_id) IN (SELECT src_table, record_id FROM _v);` +
    `INSERT INTO mitos_vec SELECT src_table, record_id, '${esc(vecKey)}', vec::FLOAT[${Number(dims)}] FROM _v;`,
    { allowWrite: true }
  );
  fs.unlinkSync(file);
  return rows.length;
}
// Vectors of rows that left the index (deleted, or a table no longer
// configured). One statement per sync, with the index attached read-only.
export async function pruneVectors() {
  if (!fs.existsSync(VEC_PATH)) return;
  await vsql(
    `ATTACH '${esc(DB_PATH)}' AS m (READ_ONLY); DELETE FROM mitos_vec WHERE NOT EXISTS (SELECT 1 FROM m.mitos_index i WHERE i.src_table = mitos_vec.src_table AND i.record_id = mitos_vec.record_id)`,
    { allowWrite: true }
  ).catch(() => {});
}

// What the stages have covered, for the settings screen and the log.
// What a paid pass would cost: rows without a current vector (or notes)
// and their average text size, per table.
export async function passEstimate(vecKey, enrichKeys = {}) {
  const need = await sql(
    (fs.existsSync(VEC_PATH) ? attachVec() : "") +
    `SELECT i.src_table, count(*) AS rows, avg(length(i.source_text) + coalesce(length(i.enrich_text), 0)) AS chars ${NEEDS_VEC(vecKey)} GROUP BY i.src_table`,
    { allowWrite: true }
  ).catch(() => []);
  const enrich = [];
  for (const [table, key] of Object.entries(enrichKeys)) {
    const r = await sql(`SELECT count(*) AS rows, avg(length(source_text)) AS chars FROM mitos_index WHERE src_table='${esc(table)}' AND enrich_key IS DISTINCT FROM '${esc(key)}'`).catch(() => [{ rows: 0, chars: 0 }]);
    enrich.push({ table, rows: Number(r[0]?.rows || 0), chars: Number(r[0]?.chars || 0) });
  }
  return { embed: need.map((r) => ({ table: r.src_table, rows: Number(r.rows), chars: Number(r.chars || 0) })), enrich };
}

export async function stageStats(vecKey) {
  const rows = await sql(
    `SELECT src_table, count(*) AS rows, count(*) FILTER (WHERE enrich_key IS NOT NULL) AS enriched
     FROM mitos_index GROUP BY src_table ORDER BY src_table`
  ).catch(() => []);
  const vec = await vsql(`SELECT src_table, count(*) AS embedded FROM mitos_vec WHERE vec_key = '${esc(vecKey || "")}' GROUP BY src_table`).catch(() => []);
  const embeddedBy = Object.fromEntries(vec.map((r) => [r.src_table, Number(r.embedded)]));
  const out = rows.map((r) => ({ ...r, embedded: Math.min(Number(r.rows), embeddedBy[r.src_table] || 0) }));
  const sum = (k) => out.reduce((a, r) => a + Number(r[k] || 0), 0);
  return { tables: out, totalRows: sum("rows"), enriched: sum("enriched"), embedded: sum("embedded"), vectorFileBytes: vectorFileSize() };
}

// Existing (record_id -> content_hash) map for one table, for the diff step.
export async function indexHashes(srcTable) {
  const rows = await sql(`SELECT record_id, content_hash FROM mitos_index WHERE src_table='${esc(srcTable)}'`).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.record_id, r.content_hash]));
}

// Upsert index rows (delete-then-insert by PK, one DuckDB command). Rows go
// through a temp JSON file: a table's worth of text is too big for a literal.
export async function upsertIndexRows(srcTable, rows) {
  if (!rows.length) return 0;
  const file = path.join(TMP_DIR, `index-${srcTable.replace(/[^\w.-]+/g, "_")}.json`);
  fs.writeFileSync(file, JSON.stringify(rows));
  const struct = Object.entries(INDEX_COLUMNS).map(([c, t]) => `${c}: '${t}'`).join(", ");
  const cols = Object.keys(INDEX_COLUMNS).join(", ");
  await sql(
    `CREATE TEMP TABLE _idx AS SELECT * FROM read_json('${esc(file)}', columns={${struct}}, format='array', maximum_object_size=16777216);` +
    `DELETE FROM mitos_index WHERE src_table='${esc(srcTable)}' AND record_id IN (SELECT record_id FROM _idx);` +
    `INSERT INTO mitos_index (${cols}, indexed_at) SELECT ${cols}, now() FROM _idx;`,
    { allowWrite: true }
  );
  // A changed row's vector was made from the old text: gone, rebuilt next.
  await dropVectorsFromFile(srcTable, file, "record_id");
  fs.unlinkSync(file);
  return rows.length;
}

// Ids go through a temp JSON file: a table can lose tens of thousands of
// rows at once, and a literal list that long is the wrong shape for SQL.
export async function deleteIndexRows(srcTable, recordIds) {
  if (!recordIds.length) return 0;
  const file = path.join(TMP_DIR, `gone-${srcTable.replace(/[^\w.-]+/g, "_")}.json`);
  fs.writeFileSync(file, JSON.stringify(recordIds.map((id) => ({ record_id: String(id) }))));
  await sql(
    `DELETE FROM mitos_index WHERE src_table='${esc(srcTable)}' AND record_id IN (SELECT record_id FROM read_json('${esc(file)}', columns={record_id: 'VARCHAR'}, format='array'))`,
    { allowWrite: true }
  );
  fs.unlinkSync(file);
  return recordIds.length;
}

export async function indexStats() {
  const rows = await sql(
    `SELECT src_table, count(*) AS rows, max(indexed_at) AS last_indexed,
            count(*) FILTER (WHERE len(nums) > 0) AS with_numbers,
            count(*) FILTER (WHERE len(dates) > 0) AS with_dates
     FROM mitos_index GROUP BY src_table ORDER BY src_table`
  ).catch(() => []);
  return { tables: rows, totalRows: rows.reduce((a, b) => a + Number(b.rows), 0) };
}

// --- The typed search ------------------------------------------------------------
// One query per search, whatever the kind. Takes the parsed plan from
// query.js and returns the per-table top-k with the columns search.js needs
// to explain each hit. Every WHERE and every score below is a plain rule.

const like = (w) => esc(w).replace(/[%_\\]/g, (c) => "\\" + c);
const L = (col, pattern) => `${col} LIKE '${pattern}' ESCAPE '\\'`;
// 3 whole word, 2 word start, 1 contains, 0 none.
const level = (col, w) =>
  `(CASE WHEN ${L(col, `% ${like(w)} %`)} THEN 3 WHEN ${L(col, `% ${like(w)}%`)} THEN 2 WHEN ${L(col, `%${like(w)}%`)} THEN 1 ELSE 0 END)`;
const num = (n) => { const v = Number(n); if (!Number.isFinite(v)) throw new Error("bad number"); return String(v); };
const date = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Error("bad date"); return `DATE '${d}'`; };
const between = (list, lo, hi, cast) => {
  const conds = [];
  if (lo !== null && lo !== undefined) conds.push(`x >= ${cast(lo)}`);
  if (hi !== null && hi !== undefined) conds.push(`x <= ${cast(hi)}`);
  return `list_filter(${list}, lambda x: ${conds.join(" AND ") || "true"})`;
};

// A text term as a WHERE clause and a score expression, honoring its mode
// and its name-table alternatives (the best alternative counts). A term
// may also match the enrichment text (coalesced to '' so a NULL never
// swallows the row); that counts one point, below the record's own text.
// Only for the tables in `enrichTables`: notes of a table whose switch is
// off, or of every table when the stage is off, stay stored but never
// match (they were paid for; 0.4.1 stops deleting them).
const enrichExpr = (enrichTables) => enrichTables && enrichTables.length
  ? `(CASE WHEN src_table IN (${enrichTables.map((n) => `'${esc(n)}'`).join(",")}) THEN coalesce(enrich_norm, '') ELSE '' END)`
  : "''";
function termSql(t, enrichTables) {
  const ENRICH = enrichExpr(enrichTables);
  const words = [t.word, ...t.also];
  const where = (w) => {
    const l = like(w);
    if (t.mode === "whole") return `(${L("search_text", `% ${l} %`)} OR ${L(ENRICH, `% ${l} %`)})`;
    if (t.mode === "contains") return `(${L("search_text", `%${l}%`)} OR ${L(ENRICH, `%${l}%`)})`;
    return `(${L("search_text", `% ${l}%`)} OR ${L(ENRICH, `% ${l}%`)})`; // start, and phrase (words in order, last one word-start)
  };
  const score = (w) => `(${level("search_text", w)} + 2 * ${level("title_text", w)} + (CASE WHEN ${L(ENRICH, `% ${like(w)}%`)} THEN 1 ELSE 0 END))`;
  return {
    where: `(${words.map(where).join(" OR ")})`,
    score: words.length === 1 ? score(words[0]) : `greatest(${words.map(score).join(", ")})`,
  };
}

const tableFilter = (tables) => tables && tables.length ? ` AND src_table IN (${tables.map((n) => `'${esc(n)}'`).join(",")})` : "";

export async function textSearch(plan, { perTable = 5, tables, enrichTables = null } = {}) {
  let where, score, hits = "NULL", order = "";
  switch (plan.kind) {
    case "text": {
      const parts = plan.terms.map((t) => termSql(t, enrichTables));
      where = parts.map((p) => p.where).join(" AND ");
      const phrase = like(plan.terms.map((t) => t.word).join(" "));
      score = parts.map((p) => p.score).join(" + ") + ` + (CASE WHEN ${L("title_text", ` ${phrase}%`)} THEN 4 ELSE 0 END)`;
      break;
    }
    case "number": {
      // Exact on number fields; whole word in the text (an id stored as text);
      // a year reaches into date fields; a long digit run is also a phone.
      const alts = [`list_contains(nums, ${num(plan.value)})`, L("search_text", `% ${like(plan.text.join(" "))} %`)];
      let s = `(CASE WHEN list_contains(nums, ${num(plan.value)}) THEN 3 WHEN ${L("search_text", `% ${like(plan.text.join(" "))} %`)} THEN 2 ELSE 0 END)`;
      hits = `list_filter(nums, lambda x: x = ${num(plan.value)})`;
      if (plan.year) {
        alts.push(`len(${between("dates", plan.year.from, plan.year.to, date)}) > 0`);
        s += ` + (CASE WHEN len(${between("dates", plan.year.from, plan.year.to, date)}) > 0 THEN 1 ELSE 0 END)`;
        hits = `list_concat(list_transform(${hits}, lambda x: x::VARCHAR), list_transform(${between("dates", plan.year.from, plan.year.to, date)}, lambda x: x::VARCHAR))`;
      }
      if (plan.digits) {
        alts.push(L("digits", `%${like(plan.digits)}%`));
        s += ` + ${level("digits", plan.digits)}`;
      }
      where = alts.join(" OR ");
      score = s;
      break;
    }
    case "range": {
      const f = between("nums", plan.from, plan.to, num);
      where = `len(${f}) > 0`;
      score = "3";
      hits = f;
      order = `${f}[1], `;
      break;
    }
    case "date":
    case "daterange": {
      const f = between("dates", plan.from, plan.to, date);
      where = `len(${f}) > 0`;
      score = "3";
      hits = f;
      order = `${f}[1], `;
      break;
    }
    case "month": {
      // Any year: a birthday in March is a March date whatever the year.
      const m = Math.max(1, Math.min(12, Number(plan.month) || 1));
      const f = `list_filter(dates, lambda x: month(x) = ${m})`;
      where = `len(${f}) > 0`;
      score = "3";
      hits = f;
      order = `day(${f}[1]), `;
      break;
    }
    case "email": {
      where = L("emails", `%${like(plan.value)}%`);
      score = level("emails", plan.value);
      break;
    }
    case "phone": {
      where = L("digits", `%${like(plan.digits)}%`);
      // 3 the whole number, 2 the end of a number (the local part typed
      // without the country code), 1 somewhere inside.
      score = `(CASE WHEN ${L("digits", `% ${like(plan.digits)} %`)} THEN 3 WHEN ${L("digits", `%${like(plan.digits)} %`)} THEN 2 ELSE 1 END)`;
      break;
    }
    default:
      return [];
  }
  return sql(
    `SELECT src_table, record_id, display, search_text, title_text, emails, digits, ${enrichExpr(enrichTables)} AS enrich_norm,
            ${hits} AS hits, ${score} AS score
     FROM mitos_index
     WHERE (${where})${tableFilter(tables)}
     QUALIFY row_number() OVER (PARTITION BY src_table ORDER BY score DESC, ${order}length(title_text), record_id) <= ${Number(perTable)}
     ORDER BY src_table, score DESC, ${order}length(title_text), record_id`
  );
}

// --- The fuzzy search (stage: fuzzy) -------------------------------------------------------
// For names typed wrong: a swapped pair, a dropped letter, a space in the
// wrong place. Jaro-Winkler on the record's title, two ways: the whole title
// against the whole query, and each query word against its closest title
// word (so word order does not matter, and "smith john" finds John Smith).
// Titles only: a name is short, and Jaro-Winkler means nothing on a
// paragraph. Rows are 0..1; the caller sets the floor.
// words: one entry per query word, each a list of spellings to try (the
// word itself first, then its name-table forms: bob, robert, rob).
export async function fuzzySearch(words, { perTable = 5, minSim = 0.86, tables } = {}) {
  // At most four spellings per word: the name table can list a dozen, and
  // each one is a Jaro-Winkler over every title.
  const groups = words.map((alts) => (Array.isArray(alts) ? alts : [alts]).map((w) => esc(String(w))).filter(Boolean).slice(0, 4)).filter((g) => g.length);
  if (!groups.length) return [];
  const ws = groups.map((g) => g[0]);
  // A cheap gate before the string math: some word in the title starts
  // with the first letter of one of the query's spellings. Jaro-Winkler
  // itself rewards a shared prefix, so a name that fails this is not a
  // close spelling anyway. Cuts 95,000 rows to a few thousand ("john
  // smith" took five seconds without it, 2026-09-09).
  const gate = groups.map((g) => `(${[...new Set(g.map((w) => w[0]))].map((c) => L("title_text", `% ${like(c)}%`)).join(" OR ")})`).join(" AND ");
  const packedGate = L("replace(title_text, ' ', '')", `${like(ws.join("").slice(0, 2))}%`);
  const whole = `jaro_winkler_similarity(trim(title_text), '${ws.join(" ")}')`;
  // The space-free forms too: "Ac me" and "acmesystems" are the same name.
  const packed = `jaro_winkler_similarity(replace(title_text, ' ', ''), '${ws.join("")}')`;
  // Per word: the best match among the title's words for any of its
  // spellings; the row scores its WEAKEST word. Every word typed has to be
  // close to some word in the name ("macon iron" is not "marco dixon").
  // A word under four letters must match a title word exactly: "inn"
  // against "in" scores 0.93 on Jaro-Winkler and means nothing.
  const best = (w) => w.length < 4
    ? `(CASE WHEN list_contains(string_split(trim(title_text), ' '), '${w}') THEN 1.0 ELSE 0.0 END)`
    : `list_max(list_transform(string_split(trim(title_text), ' '), lambda t: jaro_winkler_similarity(t, '${w}')))`;
  const perWord = groups.map((g) => (g.length === 1 ? best(g[0]) : `greatest(${g.map(best).join(", ")})`));
  const tokens = ws.length === 1 ? perWord[0] : `least(${perWord.join(", ")})`;
  const sim = `greatest(${whole}, ${packed}, ${tokens})`;
  return sql(
    `SELECT src_table, record_id, display, title_text, ${sim} AS sim
     FROM mitos_index
     WHERE length(title_text) > 2 AND ((${gate}) OR ${packedGate}) AND ${sim} >= ${Number(minSim)}${tableFilter(tables)}
     QUALIFY row_number() OVER (PARTITION BY src_table ORDER BY sim DESC, length(title_text), record_id) <= ${Number(perTable)}
     ORDER BY src_table, sim DESC, length(title_text), record_id`
  );
}

// --- The vector search (stage: semantic) ----------------------------------------------------
// Cosine between the query vector and every row that has a vector from the
// current model. Brute force in DuckDB: tens of thousands of rows answer in
// tens of milliseconds, which is the whole index at sidecar scale.
export async function vectorSearch(vec, vecKey, { perTable = 5, minSim = 0.3, tables } = {}) {
  const dims = vec.length;
  const lit = `[${vec.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]::FLOAT[${dims}]`;
  // Top-k per table in the vector file, then the display of those few rows
  // from the index. Two small processes instead of one join across files.
  const hits = await vsql(
    `SELECT src_table, record_id, array_cosine_similarity(vec, ${lit}) AS sim
     FROM mitos_vec
     WHERE vec_key = '${esc(vecKey)}'${tableFilter(tables)}
     QUALIFY row_number() OVER (PARTITION BY src_table ORDER BY sim DESC, record_id) <= ${Number(perTable)}
     AND sim >= ${Number(minSim)}
     ORDER BY src_table, sim DESC, record_id`
  );
  if (!hits.length) return [];
  const keys = hits.map((h) => `('${esc(h.src_table)}', '${esc(h.record_id)}')`).join(",");
  const rows = await sql(`SELECT src_table, record_id, display, title_text FROM mitos_index WHERE (src_table, record_id) IN (${keys})`);
  const byKey = new Map(rows.map((r) => [`${r.src_table} ${r.record_id}`, r]));
  return hits.map((h) => ({ ...byKey.get(`${h.src_table} ${h.record_id}`), src_table: h.src_table, record_id: h.record_id, sim: h.sim })).filter((r) => r.display);
}
