// indexer.js - the index pipeline: source refresh -> per-record source text ->
// diff against stored hashes (unchanged rows cost nothing) -> upsert into
// mitos_index. Incremental by content hash of the source text, so only rows
// whose text changed are rewritten. No model calls, no embeddings: the index
// is the records' own text, normalized for deterministic search.

import "./env.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { fmConfigured, fetchSchema, fetchRowsByKeys, fmReason } from "./fm.js";
import {
  sql, syncTables, loadSampleData, sampleAvailable, sampleUpdatedAt, storeManifest,
  ensureIndexTable, indexHashes, upsertIndexRows, deleteIndexRows, indexStats, normalizeText,
  upsertShadowRows, deleteShadowRows, passEstimate,
} from "./store.js";
import { DEFAULT_TABLES } from "./tables.config.js";
import { parseNumber, parseDate } from "./query.js";
import { displayNamesMap, sortByName } from "./names.js";
import { enrichStage, embedStage, enrichKeyFor, promptFor } from "./stages.js";
import { stages, stageReady } from "./ai.js";
import { vectorKey } from "./embed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const esc = (s) => String(s).replace(/'/g, "''");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// Table config: ship defaults for the sample data; a real install writes the
// same shape (per table: pk, textFields, displayFields, optionally textJoin
// or mitosJson) to data/config.json under a "tables" key.
export function tablesConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8"));
    if (cfg.tables && Object.keys(cfg.tables).length) return cfg.tables;
  } catch {}
  return DEFAULT_TABLES;
}

let building = false;
export const isBuilding = () => building;

// Build (or incrementally refresh) the whole index.
export async function buildIndex({ onEvent = () => {}, shouldStop = () => false, expected = {}, full = false, stagesOnly = false } = {}) {
  if (building) throw new Error("index build already running");
  building = true;
  try {
    return await doBuild(onEvent, shouldStop, expected, full, stagesOnly);
  } finally {
    building = false;
  }
}

// THE cMitosJSON CONVENTION. A table can carry one unstored calculation field
// named cMitosJSON that returns a JSON object. When it exists, Mitos reads
// THAT ONE FIELD instead of guessing at a field list: the developer decides
// what the record means, including related data a single table read could
// never reach. Keys starting with "_" are reserved:
//   _display  an object copied verbatim into the result row
//   _id       overrides the record id
// Every other key is search text.
export const MITOS_JSON_FIELD = "cMitosJSON";
export const usesMitosJson = (t) => Boolean(t?.mitosJson);

function parseMitosJson(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// The display name of every configured table, from the one map in names.js
// (the same map GET /api/config and GET /api/fm/tables serve).
export function tableLabels(cfg = tablesConfig()) {
  const names = displayNamesMap();
  return Object.fromEntries(Object.keys(cfg).map((n) => [n, names[n] || n]));
}

// How the client weights the main bar: records pulled are most of the
// work, the index step a third of that, the stages the rest.
const PLAN = { pullShare: 0.6, indexShare: 0.3, stagesShare: 0.1 };

// The `done` event's summary: what the sync did, in the numbers the end
// line needs ("Sync complete · 1,058 records changed · 5,000 vectors built ·
// 90,377 waiting for Run"). `pulled` is this run's pull results, `tables`
// the index step's per-table summary, `stageSummary` the stages'.
async function buildSummary({ pulled = [], tables = [], stageSummary = {}, cfg, labels, t0 }) {
  const sum = (list, k) => list.reduce((a, r) => a + Number(r[k] || 0), 0);
  const embed = stageSummary.embed || {};
  const enrich = stageSummary.enrich || {};
  // Notes still waiting, counted in the index (the ledger cannot know).
  let notesWaiting = 0;
  try {
    const s = stages();
    const keys = {};
    if (s.enrich.on && stageReady("enrich").ready) {
      for (const [name, t] of Object.entries(cfg)) if (t.enrich?.on) keys[name] = enrichKeyFor(s.enrich.model, promptFor(name, t, labels[name]));
    }
    if (Object.keys(keys).length) notesWaiting = sum((await passEstimate(vectorKey(), keys)).enrich, "rows");
  } catch { /* the count is a nicety */ }
  const stopped = [];
  if (embed.stopped) stopped.push(embed.stopped);
  for (const text of enrich.stopped || []) stopped.push(text);
  return {
    pulledChanged: sum(pulled, "changed"),
    pulledTables: pulled.length,
    indexed: sum(tables, "changed"),
    unchanged: sum(tables, "total") - sum(tables, "changed"),
    vectorsBuilt: Number(embed.done || 0),
    vectorsWaiting: Number(embed.pending || 0),
    notesWritten: Number(enrich.done || 0),
    notesWaiting,
    stopped,
    ms: Date.now() - t0,
  };
}

async function doBuild(emit, shouldStop = () => false, expected = {}, full = false, stagesOnly = false) {
  const t0 = Date.now();
  const cfg = tablesConfig();
  const labels = tableLabels(cfg);
  // The Run button from the AI tab: the paid stages alone, no pull, no
  // index step. The index must already exist.
  if (stagesOnly) {
    const onEvent = (e) => { const n = e.name ?? e.table; emit(n !== undefined ? { ...e, label: labels[n] || n } : e); };
    onEvent({ type: "start", tables: [], stagesOnly: true, plan: { pullShare: 0, indexShare: 0, stagesShare: 1 } });
    await ensureIndexTable();
    const stageSummary = await runStages({ cfg, labels, onEvent, shouldStop, full });
    const stats = await indexStats();
    const prior = indexManifest();
    const result = { ...prior, builtAt: prior.builtAt || new Date().toISOString(), lastRunAt: new Date().toISOString(), index: stats, stages: stageSummary };
    fs.writeFileSync(path.join(DATA_DIR, "index-manifest.json"), JSON.stringify(result, null, 2));
    onEvent({ type: "done", ...result, summary: await buildSummary({ stageSummary, cfg, labels, t0 }) });
    return result;
  }
  // One order everywhere: display name, A to Z, case-insensitive, then the
  // raw name. The picker shows it, the progress list shows it, and the
  // work runs in it.
  const names = sortByName(Object.keys(cfg), labels);
  // Every event that names a table also carries its display name.
  const onEvent = (e) => { const n = e.name ?? e.table; emit(n !== undefined ? { ...e, label: labels[n] || n } : e); };
  onEvent({ type: "start", tables: names.map((n) => ({ name: n, label: labels[n], expected: expected[n] ?? null })), plan: PLAN });
  let pulled = [];

  // 1. Source refresh: OData sync when FileMaker is configured, else sample.
  if (fmConfigured()) {
    onEvent({ type: "phase", phase: "schema" });
    const schema = await fetchSchema();
    // A file that refused to open is a failed sync, not an empty one. Until
    // 2026-09-09 a refused login (wrong account saved by a password manager)
    // left the schema empty, nothing was pulled, and the run still said
    // "done, 0 changed". The same for a configured table the schema no
    // longer has: say so, do not skip it in silence.
    if (schema.dbErrors?.length) {
      throw new Error(schema.dbErrors.map((d) => `FileMaker could not open "${d.db}": ${fmReason(d.error)}`).join("; ") +
        ". Check the server address, the account and the password in Settings, FileMaker tab. Nothing was changed.");
    }
    const inSchema = new Set(schema.tables.map((t) => t.name));
    const missing = names.filter((n) => !inSchema.has(n));
    if (missing.length) {
      throw new Error(`These tables are configured but FileMaker did not list them: ${missing.map((n) => labels[n] || n).join(", ")}. ` +
        `Scan the database again in Settings, Tables tab, or remove them. Nothing was changed.`);
    }
    // Ask each table only for the fields its config actually uses. With a
    // cMitosJSON field that is ONE field, which is the whole point.
    const selects = {};
    for (const name of names) {
      const t = cfg[name];
      selects[name] = usesMitosJson(t)
        ? [MITOS_JSON_FIELD, t.pk].filter(Boolean)
        : [...new Set([t.pk, ...(t.textFields || []), ...(t.displayFields || [])])].filter(Boolean);
    }
    pulled = (await syncTables(schema.tables, names, () => {}, onEvent, { selects, labels, expected, shouldStop })).pulled || [];
  } else if (sampleAvailable()) {
    const m = storeManifest();
    if (!m.sample || !m.totalRows || sampleUpdatedAt() > Date.parse(m.syncedAt || 0)) pulled = (await loadSampleData()).tables || [];
    onEvent({ type: "sample-loaded", totalRows: storeManifest().totalRows });
  } else {
    throw new Error("No FileMaker connection configured and no sample data available");
  }

  await ensureIndexTable();
  // A config change can leave index rows for tables that are no longer
  // configured. Remove them: search only ever shows configured tables.
  const nameList = names.map((n) => `'${esc(n)}'`).join(",");
  const stale = await sql(`SELECT DISTINCT src_table FROM mitos_index WHERE src_table NOT IN (${nameList})`).catch(() => []);
  if (stale.length) {
    await sql(`DELETE FROM mitos_index WHERE src_table NOT IN (${nameList})`, { allowWrite: true });
    onEvent({ type: "index-pruned", tables: stale.map((s) => s.src_table) });
  }
  const summary = [];

  // 2. Per table: build source text + display, diff, upsert. A cancel between
  // tables stops here; the index step itself is local and takes seconds, so a
  // table that reached it is finished whole.
  for (const table of names) {
    if (shouldStop()) { onEvent({ type: "cancelled", at: table }); break; }
    await indexOneTable(table, cfg[table], onEvent, summary);
  }
  const stageSummary = await runStages({ cfg, labels, onEvent, shouldStop, full });

  const stats = await indexStats();
  const result = { builtAt: new Date().toISOString(), tables: summary, index: stats, stages: stageSummary };
  fs.writeFileSync(path.join(DATA_DIR, "index-manifest.json"), JSON.stringify(result, null, 2));
  onEvent({ type: "done", ...result, summary: await buildSummary({ pulled, tables: summary, stageSummary, cfg, labels, t0 }) });
  return result;
}

// 3. The optional stages, after the index is whole: enrichment (a model
// writes search notes per record) and embedding (a vector per record).
// Each is off unless switched on, each is incremental, and a cancel
// between batches keeps what was written. `full` is the Run button; a
// plain sync stops at each stage's quiet cap.
async function runStages({ cfg, labels, onEvent, shouldStop, full = false, tables = null }) {
  const stageSummary = {};
  if (!shouldStop()) {
    onEvent({ type: "phase", phase: "enrich" });
    const tablesCfg = tables ? Object.fromEntries(tables.filter((n) => cfg[n]).map((n) => [n, cfg[n]])) : cfg;
    stageSummary.enrich = await enrichStage({ tablesCfg, labels, onEvent, shouldStop, full });
  }
  if (!shouldStop()) {
    onEvent({ type: "phase", phase: "embed" });
    stageSummary.embed = await embedStage({ labels, onEvent, shouldStop, full, tables });
  }
  return stageSummary;
}

// The per-record beacon (POST /api/records/changed): a few rows of one
// table pulled by primary key, written into the local copy, re-indexed,
// and put through the stages. Deleted ids leave the copy and the index.
// A sync in progress wins; the caller is told to try later (the next
// sync picks the change up by timestamp anyway).
export async function refreshRecords({ table, ids = [], deleted = [], onEvent = () => {} }) {
  if (building) return { deferred: true, reason: "a sync is running" };
  const cfg = tablesConfig();
  const t = cfg[table];
  if (!t) throw new Error(`${table} is not an indexed table`);
  building = true;
  try {
    const labels = tableLabels(cfg);
    const schema = await fetchSchema();
    const st = (schema.tables || []).find((x) => x.name === table);
    if (!st) throw new Error(`${table} is not in the schema scan`);
    const cols = (await sql(`SELECT column_name FROM information_schema.columns WHERE table_name='${esc(table)}' ORDER BY ordinal_position`)).map((c) => c.column_name);
    if (!cols.length) throw new Error(`no local copy of ${table} yet; sync first`);
    let updated = 0;
    if (ids.length) {
      const numericKey = (st.fields || []).find((f) => f.name === t.pk)?.type === "Decimal";
      const rows = await fetchRowsByKeys(st.occurrences[0], cols, t.pk, ids, { db: st.db, select: cols, numericKey });
      updated = await upsertShadowRows(table, t.pk, rows);
      // An id that came back empty is gone in FileMaker.
      const seen = new Set(rows.map((r) => String(r[t.pk])));
      for (const id of ids) if (!seen.has(String(id))) deleted.push(id);
    }
    if (deleted.length) {
      await deleteShadowRows(table, t.pk, deleted.map(String));
      await deleteIndexRows(table, deleted.map(String));
    }
    await ensureIndexTable();
    const summary = [];
    if (ids.length) await indexOneTable(table, t, onEvent, summary, { onlyIds: ids.map(String) });
    const stageSummary = await runStages({ cfg, labels, onEvent, shouldStop: () => false, full: false, tables: [table] });
    return { table, updated, deleted: deleted.length, index: summary[0] || null, stages: stageSummary };
  } finally {
    building = false;
  }
}

// One table's index rows: build the text and typed columns per record,
// diff against what is indexed, write only what changed. `onlyIds`: the
// beacon's case, those records alone, no deletion check.
//
// In BATCHES of INDEX_BATCH rows, ordered by the primary key. The whole
// table used to come out of DuckDB as one array; 446,216 rows of it in the
// Node heap is what killed the 1 GB demo box (2026-09-09). The hash map of
// what is indexed (id and hash only) is small and loaded once; the rows
// that are gone are known only after the last batch.
const INDEX_BATCH = 20000;
async function indexOneTable(table, t, onEvent, summary, { onlyIds = null } = {}) {
    // A table the pull skipped (cancelled, or never synced) has no local copy.
    const where = onlyIds ? ` WHERE CAST(${q(t.pk)} AS VARCHAR) IN (${onlyIds.map((id) => `'${esc(id)}'`).join(",")})` : "";
    const counted = await sql(`SELECT count(*) AS c FROM ${q(table)}${where}`).catch(() => null);
    if (!counted) { onEvent({ type: "note", name: table, note: "no local copy of this table yet; not indexed" }); return; }
    const total = Number(counted[0]?.c || 0);
    onEvent({ type: "index-table-start", table, rows: total, source: usesMitosJson(t) ? MITOS_JSON_FIELD : "fields" });

    // Column types decide how a value is indexed. A DuckDB number column is
    // a number, a DATE or TIMESTAMP column is a date, everything else is
    // text (and text is still looked at for an email or a phone number).
    // With cMitosJSON every value is a string, so the type is read from the
    // value itself: "45" is a number, "2026-01-15" is a date.
    const colTypes = Object.fromEntries(
      (await sql(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='${esc(table)}'`).catch(() => []))
        .map((c) => [c.column_name, kindOfType(c.data_type)])
    );

    // Optional one-to-many text join (e.g. employee names into their org).
    let joined = {};
    if (t.textJoin) {
      const j = t.textJoin;
      const jr = await sql(
        `SELECT ${q(j.localKey)} AS k, string_agg(${q(j.remoteField)}, ', ') AS v FROM ${q(j.table)} GROUP BY 1`
      ).catch(() => []);
      joined = Object.fromEntries(jr.map((r) => [String(r.k), r.v]));
    }

    const toItem = (row) => {
      let id = String(row[t.pk] ?? "");
      const typed = { text: [], nums: [], dates: [], emails: [], digits: [] };
      let record = {}, display = {};
      if (usesMitosJson(t)) {
        // One field decides everything. A row whose calc is empty or failed
        // (FileMaker serializes a failed calc as a bare `?`, repaired to null
        // upstream) is SKIPPED and counted, never half-indexed.
        const j = parseMitosJson(row[MITOS_JSON_FIELD]);
        if (!j) return "nojson";
        if (j._id) id = String(j._id);
        for (const [k, v] of Object.entries(j)) {
          if (k.startsWith("_")) continue;
          if (v === null || v === undefined || v === "") continue;
          const s = typeof v === "object" ? JSON.stringify(v) : String(v);
          record[k] = s;
          addValue(typed, v, typeof v === "number" ? "number" : "infer");
        }
        display = j._display && typeof j._display === "object" && !Array.isArray(j._display)
          ? j._display
          : Object.fromEntries(Object.entries(record).slice(0, 4));
      } else {
        for (const f of t.textFields) {
          const v = row[f];
          if (v === null || v === undefined || v === "") continue;
          record[f] = String(v);
          addValue(typed, v, colTypes[f] || "text");
        }
        if (t.textJoin && joined[id]) { record[t.textJoin.label || "related"] = joined[id]; typed.text.push(joined[id]); }
        for (const f of t.displayFields) display[f] = row[f] ?? "";
      }
      if (!id) return null;
      const sourceText = Object.entries(record).map(([k, v]) => `${k}: ${v}`).join("\n");
      const title = String(Object.values(display)[0] ?? "");
      return {
        id, display, sourceText,
        searchText: normalizeText(Object.values(record).join(" ")),
        titleText: normalizeText(title),
        nums: [...new Set(typed.nums)],
        dates: [...new Set(typed.dates)],
        emails: pad(typed.emails),
        digits: pad(typed.digits),
        hash: md5(sourceText + "|" + JSON.stringify(display) + "|v2"),
      };
    };

    const existing = await indexHashes(table);
    const liveIds = new Set();
    let skippedNoJson = 0, items = 0, changed = 0, withNums = 0, withDates = 0, done = 0;
    for (let offset = 0; offset < total; offset += INDEX_BATCH) {
      const rows = await sql(`SELECT * FROM ${q(table)}${where} ORDER BY ${q(t.pk)} LIMIT ${INDEX_BATCH} OFFSET ${offset}`);
      const batch = [];
      for (const row of rows) {
        const it = toItem(row);
        if (it === "nojson") { skippedNoJson++; continue; }
        if (!it) continue;
        items++;
        liveIds.add(it.id);
        if (it.nums.length) withNums++;
        if (it.dates.length) withDates++;
        if (existing[it.id] !== it.hash) batch.push(it);
      }
      if (batch.length) {
        changed += batch.length;
        await upsertIndexRows(table, batch.map((it) => ({
          src_table: table,
          record_id: it.id,
          display: JSON.stringify(it.display),
          source_text: it.sourceText,
          search_text: it.searchText,
          title_text: it.titleText,
          nums: it.nums,
          dates: it.dates,
          emails: it.emails,
          digits: it.digits,
          content_hash: it.hash,
        })));
      }
      done += rows.length;
      onEvent({ type: "index-rows", table, done, total });
      if (rows.length < INDEX_BATCH) break;
    }
    if (skippedNoJson) onEvent({ type: "note", name: table, note: `${skippedNoJson} record(s) skipped: ${MITOS_JSON_FIELD} was empty or did not return JSON` });

    const gone = onlyIds ? [] : Object.keys(existing).filter((id) => !liveIds.has(id));
    if (gone.length) await deleteIndexRows(table, gone);
    onEvent({ type: "index-diff", table, total: items, changed, deleted: gone.length });
    summary.push({ table, total: items, changed, deleted: gone.length, withNums, withDates });
    onEvent({ type: "index-table-done", table, total: items, changed, withNums, withDates });
}

export function indexManifest() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "index-manifest.json"), "utf8")); }
  catch { return { builtAt: null, tables: [] }; }
}

// --- Typing values at index time ----------------------------------------------------
// DuckDB column type -> how the indexer treats the column.
function kindOfType(dataType) {
  const t = String(dataType || "").toUpperCase();
  if (/INT|DOUBLE|FLOAT|DECIMAL|NUMERIC|REAL/.test(t)) return "number";
  if (/^DATE$|TIMESTAMP/.test(t)) return "date";
  if (/BOOL/.test(t)) return "skip";
  return "text";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+(]?\d[\d\s().\-]{5,}$/;

// Put one value into the typed buckets. `kind` is the column's kind, or
// "infer" for cMitosJSON values, where the string itself is read.
function addValue(typed, v, kind) {
  if (kind === "skip") return;
  const s = String(v).trim();
  if (!s) return;
  if (kind === "number") {
    const n = Number(s);
    if (Number.isFinite(n)) typed.nums.push(n);
    typed.text.push(s);
    return;
  }
  if (kind === "date") {
    const d = isoDay(s);
    if (d) { typed.dates.push(d); typed.text.push(d); }
    return;
  }
  if (kind === "infer") {
    const n = parseNumber(s);
    if (n !== null && /^[-+]?\d/.test(s)) { typed.nums.push(n); typed.text.push(s); return; }
    const d = isoDay(s) || (parseDate(s)?.from === parseDate(s)?.to ? parseDate(s)?.from : null);
    if (d && /\d{4}/.test(s)) { typed.dates.push(d); typed.text.push(d); return; }
  }
  typed.text.push(s);
  if (EMAIL_RE.test(s)) typed.emails.push(s.toLowerCase());
  else if (PHONE_RE.test(s)) {
    const digits = s.replace(/\D/g, "");
    if (digits.length >= 7 && !isoDay(s)) typed.digits.push(digits);
  }
}

// "2019-03-04" or "2026-09-04 09:04:41.168" -> "2019-03-04"; else null.
function isoDay(s) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/.exec(String(s));
  return m ? m[1] : null;
}

const pad = (list) => (list.length ? ` ${[...new Set(list)].join(" ")} ` : "");
