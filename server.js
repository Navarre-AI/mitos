// Mitos: search sidecar for FileMaker. One field, any table, the right
// record. FileMaker (or the bundled sample data standing in for it) is the
// source of truth: everything displayed comes verbatim from source rows.
// Search is deterministic (search.js). See README.md and RULES.md.

import "./env.js";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { fmConfigured, fmConnection, setConnection, withConnection, checkAuth, listDatabases, fetchSchema, fetchCounts, sampleRows, fmReason } from "./fm.js";
import { indexStats, stageStats, sql, storeExists, ensureIndexTable, vectorSearch, passEstimate, clearEnrichment, freeDiskBytes, totalDiskBytes } from "./store.js";
import { buildIndex, indexManifest, isBuilding, tablesConfig, MITOS_JSON_FIELD, refreshRecords } from "./indexer.js";
import { search } from "./search.js";
import { namingInfo, keyStatus, isOpenAIModel, isEmbeddingModel, askModel, roleModels, PROVIDERS, STAGE_NAMES, STAGE_DEFAULTS, STAGE_LIMITS, stages, stageReady, keyForProvider, providerOf, chat, estimateCost, EMBED_CAP_PER_SYNC } from "./ai.js";
import { vectorKey, embedInfo, embedQuery } from "./embed.js";
import { defaultEnrichPrompt, promptFor, enrichKeyFor, enrichPreview, readPasses } from "./stages.js";
import { understand, clearUnderstandCache } from "./understand.js";
import { rerank } from "./rerank.js";
import { nameTables, namesProvisional } from "./naming.js";
import { displayNamesMap, sortByName } from "./names.js";
import { parseSaxml, mergeHints, hintIndex, matchTable } from "./saxml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Build stamp for the corner of the window. The version comes from
// package.json; the date is the newest source file, which in a container is
// the build. Boot time would be wrong: a scale-to-zero machine reboots often.
const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    let newest = 0;
    for (const f of ["server.js", "search.js", "indexer.js", "store.js", "fm.js", "naming.js", "ai.js", "public/index.html", "public/app.js"]) {
      try { newest = Math.max(newest, fs.statSync(path.join(__dirname, f)).mtimeMs); } catch {}
    }
    return { version: pkg.version, built: newest ? new Date(newest).toISOString().slice(0, 10) : null };
  } catch { return { version: "?", built: null }; }
})();
const PORT = Number(process.env.PORT || 8080);
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Persisted config (data/config.json): { fm, tables, savedAt } ------------
// The fm block seeds the live connection at boot, so a Settings-configured
// install survives restarts with no env vars. Env seeds first (fm.js), the
// stored connection wins over it (it is the more recent intent).
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
// The word a table is sent to FileMaker as: lowercase, letters, digits and
// hyphens, from the display name ("Invoice Line" -> invoice-line). The
// script branches on it, so it is editable per table and never changes on
// its own once saved.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
function slugify(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "table";
}
// The slug of a table from its occurrence name, for when display names
// collide: MET_Artwork and NGA_Artwork are both "Artwork" to a person, and
// met-artwork / nga-artwork to the script.
const slugFromRaw = (raw) => slugify(String(raw || "").replace(/~[A-Za-z]$/, "").replace(/_+/g, " "));
// { raw: word } for every table the scan or the config knows, UNIQUE. A
// saved word is fixed. A proposed word that collides takes the occurrence
// name; only when that collides too does it get -2, -3.
function slugMap() {
  const names = displayNamesMap();
  const cfg = readConfig();
  const tables = cfg.tables || {};
  const raws = sortByName([...new Set([...Object.keys(tables), ...(readScan()?.tables || []).map((t) => t.name)])], names);
  const out = {};
  const taken = new Set();
  for (const n of raws) if (tables[n]?.slug) { out[n] = tables[n].slug; taken.add(tables[n].slug); }
  for (const n of raws) {
    if (out[n]) continue;
    const first = slugify(names[n] || n);
    const collides = taken.has(first) || raws.some((m) => m !== n && !tables[m]?.slug && slugify(names[m] || m) === first);
    let word = collides ? slugFromRaw(n) : first;
    if (taken.has(word)) { const base = word; for (let i = 2; taken.has(word); i++) word = `${base}-${i}`; }
    out[n] = word;
    taken.add(word);
  }
  return out;
}
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; } }
function writeConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
{
  // A saved connection wins over env, INCLUDING a saved blank one: a person
  // who cleared the host in Settings meant "no FileMaker, sample data".
  const stored = readConfig().fm;
  if (stored && typeof stored === "object" && "host" in stored) setConnection(stored);
}
// Apply + persist a FileMaker connection from the UI. A blank password keeps
// the stored one.
function saveFmConnection(fm) {
  setConnection(fm);
  connGen++;
  const cfg = readConfig();
  const prev = cfg.fm || {};
  cfg.fm = { host: fmConnection().host, db: fmConnection().db, user: fmConnection().user,
             pass: (typeof fm.pass === "string" && fm.pass) ? fm.pass : prev.pass };
  cfg.savedAt = new Date().toISOString();
  writeConfig(cfg);
}

const app = express();

// Password gate (same as the sibling apps): if SITE_PASSWORD is set, the whole
// site requires it. Accepted three ways so it works in a browser AND a
// FileMaker web viewer (which cannot answer a Basic-auth prompt):
//   1. ?key=<password> in the URL  -> also drops a cookie for later calls.
//   2. a mitos_auth cookie (set by #1).
//   3. HTTP Basic (browser prompt / curl -u).
if (SITE_PASSWORD) {
  const cookieVal = `mitos_auth=${encodeURIComponent(SITE_PASSWORD)}`;
  app.use((req, res, next) => {
    if (req.query.key === SITE_PASSWORD) {
      const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      res.setHeader("Set-Cookie", `${cookieVal}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${secure}`);
      return next();
    }
    const cookies = req.headers.cookie || "";
    if (cookies.split(";").some((c) => c.trim() === cookieVal)) return next();
    const header = req.headers.authorization || "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      if (decoded.slice(decoded.indexOf(":") + 1) === SITE_PASSWORD) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Mitos"');
    return res.status(401).send("Authentication required. Load with ?key=<password> in a web viewer.");
  });
}

// No caching: FileMaker web viewers cache aggressively.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- The sync job (Pythia's pattern) -----------------------------------------
// EVERY sync - button, auto-sync timer, boot - runs as one server-side job.
// The window only WATCHES: reload mid-sync and it finds the job again, a
// second window can watch the same run, and Cancel stops the work now and
// says what was kept. Events carry a sequence number so a reattaching client
// replays what it missed instead of guessing.
let syncJob = null;
const sseClients = new Set();

function jobEmit(evt) {
  if (!syncJob) return;
  evt.seq = syncJob.events.length;
  evt.at = Date.now();
  syncJob.events.push(evt);
  trackInflight(evt);
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) res.write(line);
}
const broadcast = jobEmit; // auto-sync + boot builds report through the same door

function jobState() {
  if (!syncJob) return { running: false, job: null, lastCrash: lastCrash() };
  return {
    running: !syncJob.done,
    job: {
      id: syncJob.id, startedAt: syncJob.startedAt, done: syncJob.done,
      cancelRequested: syncJob.cancelRequested, origin: syncJob.origin,
      error: syncJob.error || null, events: syncJob.events,
    },
    lastCrash: lastCrash(),
  };
}

// --- The crash report ---------------------------------------------------------
// While a sync runs, a small file says where it is: the table, the rows so
// far, the phase. The job deletes it when it ends. A boot that finds it
// knows the process died mid-sync (the box ran out of memory on a big
// table, 2026-09-09) and writes last-crash.json with the machine's size
// and one sentence a person can act on. The client shows it once; POST
// /api/index/crash/ack clears it.
const INFLIGHT_PATH = path.join(DATA_DIR, "sync-inflight.json");
const CRASH_PATH = path.join(DATA_DIR, "last-crash.json");
let inflightExpected = {};
function trackInflight(evt) {
  const stage = { at: new Date().toISOString() };
  if (evt.type === "start") { inflightExpected = Object.fromEntries((evt.tables || []).map((t) => [t.name, t.expected ?? null])); return; }
  if (evt.type === "pull-start" || evt.type === "pull-rows" || evt.type === "pull-resumed") {
    Object.assign(stage, { table: evt.name, label: evt.label || evt.name, rows: evt.rows ?? evt.fromRow ?? 0, expected: inflightExpected[evt.name] ?? null, phase: "pull" });
  } else if (evt.type === "index-rows" || evt.type === "index-table-start") {
    Object.assign(stage, { table: evt.table, label: evt.label || evt.table, rows: evt.done ?? 0, expected: evt.total ?? evt.rows ?? null, phase: "index" });
  } else if (evt.type === "enrich-progress" || evt.type === "embed-progress" || evt.type === "enrich-start" || evt.type === "embed-start") {
    Object.assign(stage, { table: evt.table || null, label: evt.label || evt.table || null, rows: evt.done ?? 0, expected: evt.total ?? evt.pending ?? null, phase: "stages" });
  } else if (evt.type === "finished" || evt.type === "stopped" || evt.type === "error" || evt.type === "done") {
    try { fs.unlinkSync(INFLIGHT_PATH); } catch {}
    return;
  } else return;
  stage.image = process.env.FLY_IMAGE_REF || null;
  try { fs.writeFileSync(INFLIGHT_PATH, JSON.stringify(stage)); } catch {}
}
const gb = (bytes) => Math.round((Number(bytes) / 1073741824) * 10) / 10;
function machineSize() {
  return { memoryMB: Math.round(os.totalmem() / 1048576), diskGB: gb(totalDiskBytes() || 0), freeDiskGB: gb(freeDiskBytes() || 0) };
}
function crashMessage(c) {
  const name = c.label || c.table || "a table";
  const count = c.expected != null ? `${Number(c.expected).toLocaleString()} records` : `${Number(c.rows || 0).toLocaleString()} records read`;
  const where = c.phase === "stages" ? `while running the AI stages on ${name}` : `on ${name} (${count})`;
  // A deploy restarts the box with a new image: not a crash, say so.
  if (c.image && process.env.FLY_IMAGE_REF && c.image !== process.env.FLY_IMAGE_REF) {
    return `Mitos was updated ${where} and the sync stopped. Finished tables were kept; a table that was being read continues from where it stopped. Sync again to finish.`;
  }
  return `Mitos most likely ran out of memory ${where}. This machine has ${c.memoryMB >= 1024 ? `${Math.round(c.memoryMB / 1024 * 10) / 10} GB` : `${c.memoryMB} MB`} of RAM and ${c.diskGB} GB of disk (${c.freeDiskGB} GB free). ` +
    `Increase the memory in Fly and try again, or leave this table out.`;
}
function noteCrashAtBoot() {
  let inflight = null;
  try { inflight = JSON.parse(fs.readFileSync(INFLIGHT_PATH, "utf8")); } catch { return; }
  try {
    const crash = { ...inflight, ...machineSize() };
    crash.message = crashMessage(crash);
    fs.writeFileSync(CRASH_PATH, JSON.stringify(crash, null, 2));
    console.error("crash report:", crash.message);
  } catch {}
  try { fs.unlinkSync(INFLIGHT_PATH); } catch {}
}
function lastCrash() { try { return JSON.parse(fs.readFileSync(CRASH_PATH, "utf8")); } catch { return null; } }
noteCrashAtBoot();

// The stop flag lives HERE, at module scope, not captured per job. A captured
// flag drifts: a second startSyncJob replaced `syncJob` while the first build
// was still pulling, so Cancel flipped a flag the running build could not see
// and the sync ran on for minutes saying "cancelling" (2026-08-31).
let cancelFlag = false;

function startSyncJob({ origin = "user", full = false, stagesOnly = false } = {}) {
  // Two guards, because they catch different things: an unfinished job record,
  // and an engine that is still running under a job record that already died.
  if ((syncJob && !syncJob.done) || isBuilding()) return syncJob;
  cancelFlag = false;
  syncJob = {
    id: Math.random().toString(36).slice(2, 10),
    startedAt: new Date().toISOString(),
    events: [], cancelRequested: false, done: false, error: null, origin,
  };
  const job = syncJob;
  // Expected record counts from the last scan give the progress bars a
  // denominator. A table without one shows the count read so far.
  const expected = {};
  for (const t of (readScan()?.tables || [])) if (t.rowCount != null) expected[t.name] = t.rowCount;
  buildIndex({ onEvent: jobEmit, shouldStop: () => cancelFlag, expected, full, stagesOnly })
    .then(() => { job.done = true; jobEmit(cancelFlag ? { type: "stopped" } : { type: "finished" }); })
    .catch((e) => {
      job.done = true;
      if (e && e.cancelled) return jobEmit({ type: "stopped" });
      job.error = e.message;
      jobEmit({ type: "error", message: e.message });
    });
  return job;
}

// Live event stream. ?since=<seq> replays everything after that sequence
// number first, so a reload or a dropped connection loses nothing.
app.get("/api/index/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const since = Number(req.query.since);
  const state = jobState();
  res.write(`data: ${JSON.stringify({ type: "hello", ...state })}\n\n`);
  if (syncJob && Number.isFinite(since)) {
    for (const e of syncJob.events.filter((e) => e.seq > since)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  sseClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

// Current job, for a window that just opened.
const BOOT_ID = Math.random().toString(36).slice(2, 10);
app.get("/api/index/job", (_req, res) => res.json({ ...jobState(), cancelFlag, building: isBuilding(), bootId: BOOT_ID }));

// Cancel: the flag is checked between pages of a pull and between tables, and
// it aborts the OData request in the air. A table is kept whole or not at all.
app.post("/api/index/cancel", (_req, res) => {
  if (!syncJob || syncJob.done) return res.json({ idle: true });
  if (!syncJob.cancelRequested) {
    syncJob.cancelRequested = true;
    cancelFlag = true;
    jobEmit({ type: "cancelling" });
  }
  res.json({ ok: true, id: syncJob.id });
});

// The person has read the crash report.
app.post("/api/index/crash/ack", (_req, res) => {
  try { fs.unlinkSync(CRASH_PATH); } catch {}
  res.json({ ok: true });
});

// --- API ----------------------------------------------------------------------

app.get("/api/health", async (_req, res) => {
  const stats = await indexStats().catch(() => ({ tables: [], totalRows: 0 }));
  res.json({
    ok: true,
    app: "mitos",
    ...VERSION,
    fm: fmConfigured(),
    building: isBuilding(),
    indexRows: stats.totalRows,
    naming: namingInfo(),
  });
});

// --- Settings -----------------------------------------------------------------

// Cached schema scan (data/schema-scan.json): the Data Sources structure line
// and the Tables tab render from this instantly; Rescan refreshes it.
const SCAN_PATH = path.join(DATA_DIR, "schema-scan.json");
function readScan() { try { return JSON.parse(fs.readFileSync(SCAN_PATH, "utf8")); } catch { return null; } }

// Current config for the UI. Never a password, never a key.
app.get("/api/config", async (_req, res) => {
  const cfg = readConfig();
  const scan = readScan();
  const stats = await indexStats().catch(() => ({ tables: [], totalRows: 0 }));
  res.json({
    fm: { ...fmConnection(), verifiedAt: cfg.fm?.verifiedAt || null },
    fmConfigured: fmConfigured(),
    version: VERSION,
    tables: cfg.tables || null, // null = running on the shipped sample config
    syncEvery: Number(cfg.syncEvery || 0),
    dateFormat: cfg.dateFormat === "dmy" ? "dmy" : "mdy",
    displayNames: displayNamesMap(),
    slugs: slugMap(),
    savedAt: cfg.savedAt || null,
    scan: scan ? { scannedAt: scan.scannedAt, tableCount: scan.tables.length,
                   fieldCount: scan.tables.reduce((a, t) => a + t.fieldCount, 0), via: "OData" } : null,
    index: { totalRows: stats.totalRows, tables: stats.tables,
             builtAt: indexManifest().builtAt || null, building: isBuilding() },
    ai: { naming: namingInfo(), keys: keyStatus(), hasKey: namingInfo().configured, models: roleModels(),
          providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, chat: p.chat, embed: p.embed }])),
          stages: stagesView(), embedding: embedInfo(),
          coverage: await stageStats(vectorKey()).catch(() => ({ tables: [], totalRows: 0, enriched: 0, embedded: 0 })) },
    enrichPromptDefault: Object.fromEntries(Object.keys(cfg.tables || {}).map((n) => [n, defaultEnrichPrompt(displayNamesMap()[n] || n)])),
    neverSynced: !indexManifest().builtAt && !stats.totalRows,
    hints: hintsSummary(loadHints()),
  });
});

// The stages as the settings screen shows them: the saved values with the
// defaults filled in, plus whether each can run right now and why not.
function stagesView() {
  const s = stages();
  const saved = readConfig().ai?.stages || {};
  const out = {};
  for (const name of STAGE_NAMES) {
    const r = stageReady(name);
    out[name] = { ...s[name], savedModel: saved[name]?.model || "", ready: r.ready, why: r.why || null, provider: s[name].model ? providerOf(s[name].model) : null };
  }
  return out;
}

// Save connection, table config, sync interval, and/or AI keys. Body:
// { fm?: {host,db,user,pass}, tables?: {...}, syncEvery?: minutes,
//   ai?: {anthropicKey, openaiKey, namingModel} } - blank keys keep the stored ones.
app.post("/api/config", async (req, res) => {
  try {
    if (req.body?.fm && typeof req.body.fm === "object") {
      // A NEW login (a password, or a changed host or user) is proven against
      // one real file before it is saved. On 2026-09-09 a password manager
      // filled the Settings form with another account, Save kept it, and every
      // sync after that read nothing and still said "done".
      const fm = req.body.fm;
      const cur = fmConnection();
      const newLogin = (typeof fm.pass === "string" && fm.pass) ||
        (fm.host !== undefined && String(fm.host).trim() && String(fm.host).trim() !== cur.host) ||
        (fm.user !== undefined && String(fm.user).trim() && String(fm.user).trim() !== cur.user);
      if (newLogin && String(fm.host || cur.host).trim()) {
        const candidate = { host: fm.host ?? cur.host, user: fm.user ?? cur.user, pass: fm.pass || "", db: fm.db ?? cur.db };
        const problem = await withConnection(candidate, async () => {
          if (!fmConfigured()) return "Fill in server, username, and password.";
          const wanted = fmConnection().db.split(",").map((s) => s.trim()).filter(Boolean);
          let target = wanted[0];
          if (!target) { try { target = (await listDatabases())[0]; } catch (e) { return `The server did not answer: ${String(e.message || e).slice(0, 160)}`; } }
          if (!target) return "This login can't open any file over OData.";
          try { await checkAuth(target); return null; }
          catch (e) { return `FileMaker refused this login for ${target}: ${fmReason(e.message || e)}. Nothing was saved.`; }
        });
        if (problem) return res.status(400).json({ error: problem });
      }
      saveFmConnection(fm);
      if (newLogin) { const cfg = readConfig(); if (cfg.fm) { cfg.fm.verifiedAt = new Date().toISOString(); writeConfig(cfg); } }
    }
    if (req.body?.dateFormat !== undefined) {
      const cfg = readConfig();
      cfg.dateFormat = req.body.dateFormat === "dmy" ? "dmy" : "mdy";
      writeConfig(cfg);
    }
    if (req.body?.syncEvery !== undefined) {
      const cfg = readConfig();
      cfg.syncEvery = Math.max(0, Number(req.body.syncEvery) || 0);
      writeConfig(cfg);
    }
    if (req.body?.ai && typeof req.body.ai === "object") {
      const cfg = readConfig();
      cfg.ai = cfg.ai || {};
      // Three states per key: blank keeps it, a value sets it, an explicit
      // null forgets the in-app key and the server's env key applies again.
      for (const [name, p] of Object.entries(PROVIDERS)) {
        const v = req.body.ai[p.cfgKey];
        if (v === null) {
          // A forgotten key takes its switch with it: the provider reads as
          // on again only when a key exists again.
          delete cfg.ai[p.cfgKey];
          if (cfg.ai.providers?.[name]) delete cfg.ai.providers[name];
        } else if (v) {
          // A key typed is a key meant to be used: the provider is on.
          cfg.ai[p.cfgKey] = String(v).trim();
          cfg.ai.providers = cfg.ai.providers || {};
          cfg.ai.providers[name] = { enabled: true };
        }
      }
      if (req.body.ai.namingModel) {
        const m = String(req.body.ai.namingModel).trim();
        if (isEmbeddingModel(m)) return res.status(400).json({ error: `"${m}" is an embedding model. Choose a chat model for naming.` });
        cfg.ai.namingModel = m;
      }
      // Provider switches: { anthropic: { enabled: false } }. The key stays.
      if (req.body.ai.providers && typeof req.body.ai.providers === "object") {
        cfg.ai.providers = cfg.ai.providers || {};
        for (const [p, v] of Object.entries(req.body.ai.providers)) {
          if (!PROVIDERS[p] || !v || typeof v !== "object" || v.enabled === undefined) continue;
          cfg.ai.providers[p] = { enabled: Boolean(v.enabled) };
        }
      }
      // The stages: each block merges over what is saved, and only known
      // fields with sane values land. `model: ""` means "the default".
      if (req.body.ai.stages && typeof req.body.ai.stages === "object") {
        cfg.ai.stages = cfg.ai.stages || {};
        for (const [name, patch] of Object.entries(req.body.ai.stages)) {
          if (!STAGE_DEFAULTS[name] || !patch || typeof patch !== "object") continue;
          const cur = { ...(cfg.ai.stages[name] || {}) };
          // An embedding model answers no prompt: only the semantic stage
          // may have one (a test box had text-embedding-3-small saved as the
          // naming model on 2026-09-09).
          if (name !== "semantic" && patch.model && isEmbeddingModel(patch.model)) {
            return res.status(400).json({ error: `"${String(patch.model).trim()}" is an embedding model. Choose a chat model for ${name === "enrich" ? "enrichment" : name}.` });
          }
          for (const [k, v] of Object.entries(patch)) {
            if (!(k in STAGE_DEFAULTS[name])) continue;
            if (k === "on") cur.on = Boolean(v);
            else if (k === "model") cur.model = String(v || "").trim();
            else if (k === "prompt") cur.prompt = String(v || "").trim().slice(0, 4000);
            else if (v === null || v === "") delete cur[k];
            else if (Number.isFinite(Number(v))) {
              const [lo, hi] = STAGE_LIMITS[name]?.[k] || [-Infinity, Infinity];
              cur[k] = Math.min(hi, Math.max(lo, Number(v)));
            }
          }
          cfg.ai.stages[name] = cur;
        }
        clearUnderstandCache(); // a model or prompt change must not serve old plans
      }
      writeConfig(cfg);
    }
    if (req.body?.displayNames && typeof req.body.displayNames === "object") {
      // A rename saves itself (Matt lost one to a closed panel, Pythia
      // 2026-09-04). Into the table's config when it is configured, else
      // into a names map the display layer reads.
      const cfg = readConfig();
      cfg.displayNames = cfg.displayNames || {};
      for (const [raw, name] of Object.entries(req.body.displayNames)) {
        const v = String(name || "").trim();
        if (cfg.tables?.[raw]) { if (v && v !== raw) cfg.tables[raw].displayName = v; else delete cfg.tables[raw].displayName; }
        if (v && v !== raw) cfg.displayNames[raw] = v; else delete cfg.displayNames[raw];
      }
      writeConfig(cfg);
    }
    if (req.body?.tables && typeof req.body.tables === "object") {
      const tables = {};
      const names = displayNamesMap(), proposed = slugMap();
      const wordOf = {}; // slug -> the table that holds it, within this save
      const entries = Object.entries(req.body.tables).filter(([, t]) => t && t.pk && (t.mitosJson || (Array.isArray(t.textFields) && t.textFields.length)));
      // Typed words first, so a word a person chose is never pushed aside by
      // one Mitos made up.
      entries.sort(([, a], [, b]) => Number(Boolean(String(b.slug || "").trim())) - Number(Boolean(String(a.slug || "").trim())));
      for (const [name, t] of entries) {
        if (!Array.isArray(t.textFields)) t.textFields = [];
        // The table word: typed, else the unique proposal (from the display
        // name, or the occurrence name when display names collide).
        // Lower-case letters, digits and hyphens, and its own for each
        // table: the FileMaker script branches on it, and two tables with
        // one word would land every click on the first (2026-09-09).
        const shown = t.displayName || names[name] || name;
        const typed = String(t.slug || "").trim();
        let word = typed;
        if (!word) {
          word = proposed[name] || slugify(shown);
          if (wordOf[word]) word = slugFromRaw(name);
          for (let i = 2; wordOf[word]; i++) word = `${proposed[name] || slugify(shown)}-${i}`;
        }
        if (!SLUG_RE.test(word)) return res.status(400).json({ error: `"${word}" is not a valid word for ${shown}. Use lower-case letters, digits and hyphens.` });
        if (wordOf[word]) return res.status(400).json({ error: `"${word}" is already used by ${wordOf[word]}. Each table needs its own word.` });
        wordOf[word] = shown;
        t.slug = word;
        // Per-table enrichment: a switch and a prompt. A blank prompt means
        // the default for the table's display name, built at run time.
        const prev = readConfig().tables?.[name]?.enrich;
        const enrich = t.enrich && typeof t.enrich === "object"
          ? { on: Boolean(t.enrich.on), ...(String(t.enrich.prompt || "").trim() ? { prompt: String(t.enrich.prompt).trim().slice(0, 4000) } : {}) }
          : prev;
        tables[name] = {
          pk: String(t.pk),
          ...(t.displayName ? { displayName: String(t.displayName) } : {}),
          slug: t.slug,
          ...(t.mitosJson ? { mitosJson: true } : {}),
          textFields: t.textFields.map(String),
          displayFields: (Array.isArray(t.displayFields) && t.displayFields.length ? t.displayFields : t.textFields.slice(0, 4)).map(String),
          ...(enrich ? { enrich } : {}),
        };
      }
      if (!Object.keys(tables).length) return res.status(400).json({ error: "No valid table config: each table needs a pk and at least one text field." });
      const cfg = readConfig();
      cfg.tables = tables;
      cfg.savedAt = new Date().toISOString();
      writeConfig(cfg);
    }
    res.json({ ok: true, fm: fmConnection(), tables: readConfig().tables || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Staged connection test: nothing persists unless the UI saves afterwards.
// The root list proves the server answers, not the login (many servers list
// files to garbage creds); opening one real file is the credential check.
app.post("/api/fm/test", async (req, res) => {
  const candidate = req.body?.fm || {};
  try {
    const result = await withConnection(candidate, async () => {
      if (!fmConfigured()) return { ok: false, error: "Fill in server, username, and password." };
      const databases = await listDatabases();
      const wanted = fmConnection().db.split(",").map((s) => s.trim()).filter(Boolean);
      const missing = wanted.filter((w) => !databases.includes(w));
      const target = wanted.find((w) => databases.includes(w)) || databases[0];
      let verified = false, authError = null;
      if (target) {
        try { await checkAuth(target); verified = true; }
        catch (e) { authError = String(e.message || e).slice(0, 200); }
      }
      return { ok: verified, databases, missing, verified, ...(authError ? { error: authError } : {}) };
    });
    // A blank candidate password means the STORED connection was just proven;
    // stamp it so the status card can say "verified Xm ago" honestly.
    if (result.ok && !candidate.pass) {
      const cfg = readConfig();
      if (cfg.fm) { cfg.fm.verifiedAt = new Date().toISOString(); writeConfig(cfg); }
    }
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

// --- Field hygiene for the proposal -------------------------------------------
// The proposal used to take every String field. That put JSON blobs, prior AI
// output, audit logs, UUIDs and base64 images into the search text and titled
// 30,649 people with a UUID (2026-09-04). Two filters now, by name and by a
// sample of real rows; a field is out when either says so.
const JUNK_FIELD = /json|xml|html|base64|photo|image|blob|\blog\b|log$|audit|histor|response|prompt|enrich|embed|\?ai|^ai[_ ]|token|hash|passw|^z[_A-Z]|^g[A-Z]|uuid|guid|^pk\b|^fk\b|^id$|^id[_ ]|_id$|\bid\b|modif|creat|timestamp|clio|^c[A-Z][a-z]*log/i;
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$|^\d{20,}$/;
const MAX_AVG_CHARS = 1500;

// What a sample of rows says about each String field. Returns
// { field: { avg, json, uuid, empty } } with shares in 0..1, or null when the
// table could not be read (a slow table must not block the scan).
function profileFields(rows, fields) {
  if (!rows || !rows.length) return null;
  const out = {};
  for (const f of fields) {
    let n = 0, len = 0, json = 0, uuid = 0, empty = 0;
    for (const r of rows) {
      const v = r[f.name];
      n++;
      if (v === null || v === undefined || String(v).trim() === "") { empty++; continue; }
      const str = String(v);
      len += str.length;
      if (/^\s*[\[{]/.test(str)) json++;
      if (UUID_RE.test(str.trim())) uuid++;
    }
    const filled = n - empty;
    out[f.name] = { avg: filled ? len / filled : 0, json: filled ? json / filled : 0, uuid: filled ? uuid / filled : 0, empty: n ? empty / n : 1 };
  }
  return out;
}

// Which field names a record. Lower is better; the first display field is
// the result title, so this order decides what a person reads first.
function titleRank(name) {
  const n = name.toLowerCase().replace(/^c_?/, "");
  if (/^(full ?name|name|company|organi[sz]ation|business)$/.test(n)) return 0;
  if (/name/.test(n)) return 1;
  // A title is a short name-like field. A description is a paragraph and
  // makes a bad headline (a product listed by its blurb, 2026-09-09).
  if (/^(title|subject|headline|model|brand|product|item|sku)$/.test(n)) return 2;
  if (/description|notes?$|text$|body|summary|comment/.test(n)) return 8;
  if (/^(first|last|given|surname|family)/.test(n)) return 3;
  if (/email|city/.test(n)) return 4;
  return 9;
}

// --- The scan: a background build the browser polls ---------------------------
// Discover tables over OData and PROPOSE a Mitos config for each: pk, text
// fields, display fields. Pythia's shape: the build runs server-side and
// reports one-line progress; GET /api/fm/tables answers within 20s with the
// result or {building:true}, and /api/fm/scan/progress says what is happening.
// Nothing is saved until POST /api/config. The result is cached to disk so the
// Tables tab opens instantly; ?refresh=1 rescans the server.
let scanBuild = null;   // in-flight build promise
let scanStatus = null;  // one-line progress while a build runs; null when idle
let connGen = 0;        // bumped on every connection save; a stale build sees it and stops

function startScanBuild(refresh) {
  const p = buildScan(refresh);
  scanBuild = p;
  p.finally(() => { if (scanBuild === p) scanBuild = null; }).catch(() => {});
  return p;
}
const withNames = (scan) => ({ ...scan, namesProvisional: namesProvisional(), hasKey: namingInfo().configured });

app.get("/api/fm/tables", async (req, res) => {
  if (!fmConfigured()) return res.status(400).json({ error: "No FileMaker connection configured." });
  const refresh = req.query.refresh === "1";
  if (!refresh) {
    const cached = readScan();
    if (cached && !scanBuild) {
      // Names are a display layer over the cached scan. A scan made before the
      // key was set carries guessed names; once a key exists (or ?rename=1
      // asks), name again with the model. No rescan needed for that.
      // Naming runs only when asked (?rename=1, the "Name tables now" button).
      // It used to run inline on every cached read while names looked
      // provisional: a model call on opening the Tables tab (Matt, 2026-09-08).
      if (req.query.rename === "1") await renameScan(cached, true);
      mergeSaved(cached);
      return res.json(withNames(cached));
    }
  }
  if (!scanBuild) startScanBuild(refresh);
  const result = await Promise.race([scanBuild, new Promise((r) => setTimeout(() => r("__building__"), 20000))]);
  if (result === "__building__") return res.json({ building: true });
  if (!result || result.error) return res.status(500).json({ error: result?.error || "scan failed" });
  mergeSaved(result);
  res.json(withNames(result));
});

// The scan window polls this while /api/fm/tables reports building:true.
app.get("/api/fm/scan/progress", (_req, res) => {
  if (!scanStatus) return res.json({ idle: true });
  if (scanStatus.phase === "file") {
    const secs = Math.floor((Date.now() - scanStatus.t0) / 1000);
    // A file at it for 5+ seconds gets an elapsed count that updates every
    // 5s so the screen visibly moves. No editorializing about why.
    const text = secs < 5 ? `Reading the structure of ${scanStatus.db}...` : `Still reading ${scanStatus.db}, ${Math.floor(secs / 5) * 5}s so far`;
    return res.json({ text });
  }
  res.json(scanStatus);
});

// A saved table's choice and config show without a rescan.
function mergeSaved(scan) {
  const saved = readConfig().tables || {};
  const names = displayNamesMap(), slugs = slugMap();
  for (const t of scan.tables) {
    t.included = Boolean(saved[t.name]);
    if (saved[t.name]) t.proposal = saved[t.name];
    // The one name map and the one word map: what /api/config says, this
    // row says, whether the table is checked or not.
    t.displayName = names[t.name] || t.name;
    if (t.proposal) t.proposal.slug = slugs[t.name] || t.proposal.slug || slugify(t.displayName);
  }
}

// Display names, in order of trust: the saved name, the SaXML name, the
// naming pass, the raw name. Identity (t.name) never changes.
async function renameScan(scan, force) {
  try {
    const naming = await nameTables(scan.tables, { force });
    const byName = new Map(naming.tables.map((n) => [n.name, n]));
    const saved = readConfig().tables || {};
    for (const t of scan.tables) {
      const n = byName.get(t.name);
      if (n) { t.aiName = n.displayName; t.suggestInclude = n.include; t.reason = n.reason; t.titleField = n.titleField || null; }
      t.displayName = saved[t.name]?.displayName || t.saxmlName || t.aiName || t.name;
      // The model's title field leads the display list, when it survived the
      // hygiene filter. A UUID or a JSON blob never becomes a title.
      if (!saved[t.name] && t.titleField && t.proposal?.textFields?.includes(t.titleField)) {
        t.proposal.displayFields = [t.titleField, ...t.proposal.displayFields.filter((f) => f !== t.titleField)].slice(0, 4);
      }
    }
    scan.naming = { source: naming.source || null };
    // Sort the way a person reads it: worth searching first, then A to Z.
    scan.tables.sort((a, b) => (Number(b.suggestInclude) - Number(a.suggestInclude))
      || String(a.displayName || a.name).localeCompare(String(b.displayName || b.name)));
    fs.writeFileSync(SCAN_PATH, JSON.stringify(scan, null, 2));
  } catch (e) { scan.naming = { source: `naming failed: ${String(e.message).slice(0, 80)}` }; }
}

async function buildScan(refresh) {
  const gen = connGen;
  const t0 = Date.now(), timings = {};
  const superseded = () => { if (gen !== connGen) { const e = new Error("superseded by a newer connection"); e.superseded = true; throw e; } };
  scanStatus = { text: "Contacting the server..." };
  try {
    const schema = await fetchSchema(Boolean(refresh), (evt) => {
      superseded();
      if (evt.type === "schema-dbs") scanStatus = { text: `Found ${evt.dbs.length} database file${evt.dbs.length === 1 ? "" : "s"}` };
      if (evt.type === "schema-file-start") scanStatus = { phase: "file", db: evt.db, t0: Date.now() };
      if (evt.type === "schema-file" && !evt.error) scanStatus = { text: `${evt.db}: structure read, ${evt.tables} tables` };
    });
    timings.schemaMs = Date.now() - t0;
    if (!schema.tables.length && (schema.dbErrors || []).length) throw new Error(`No file reachable over OData: ${schema.dbErrors[0].error}`);

    const tCounts = Date.now();
    const counts = await fetchCounts(schema.tables,
      (done, totalN) => { if (gen === connGen) scanStatus = { text: `Counting records, ${done} of ${totalN} tables` }; },
      () => gen !== connGen);
    superseded();
    timings.countsMs = Date.now() - tCounts;
    for (const t of schema.tables) t.rowCount = counts[t.name] ?? null;

    // SaXML ground truth, when uploaded: real names, keys, mod fields,
    // comments, and which calcs store their result.
    applyHints(schema);

    const saved = readConfig().tables || {};
    const tables = schema.tables.map((t) => {
      // PRIMARY KEY CHOICE. Mitos stores this value and hands it back to
      // FileMaker, where a script does an ordinary Find on it. So the key must
      // be a REAL FIELD a Find can search.
      //
      // The key OData declares is NOT always that. Per the Claris OData guide,
      // OData uses a field that is unique and not empty as the primary key,
      // and when a table has none it falls back to the ROWID system field,
      // which holds the same value as Get(RecordID). ROWID is the internal
      // record id: it is not a field, no Find can search it, and it does not
      // survive a migration to a clone. Handing it to FileMaker would give a
      // click that can never land.
      //
      // So: never ROWID. Prefer a field that says UUID, then the declared key
      // when it is a real field, then the conventional names. Overridable per
      // table in Settings, and cMitosJSON "_id" beats all of it.
      const named = (re) => t.fields.find((f) => re.test(f.name))?.name;
      const isRowId = (n) => /^rowid$/i.test(String(n || ""));
      const declared = (t.keys || []).find((k) => !isRowId(k)) || null;
      const pk = named(/uuid|guid/i)
        || declared
        || named(/^id$/i)
        || named(/^pk\b|^id[_ ]/i)
        || null;
      // True when the ONLY thing FileMaker offered was ROWID: the table has no
      // unique, not-empty field at all. Say so plainly; it is a schema fact,
      // not a Mitos limitation.
      const rowIdOnly = Boolean((t.keys || []).length && (t.keys || []).every(isRowId) && !pk);
      if (!pk && t.hintPk && t.fields.some((f) => f.name === t.hintPk)) pk = t.hintPk;
      const modField = t.modField || t.fields.find((f) => f.type === "DateTimeOffset" && /mod/i.test(f.name))?.name || null;
      // Field hygiene by NAME and by METADATA, no rows read: summaries,
      // globals, and calculations that are not known to store their result
      // are the expensive fields; junk names are junk.
      const excluded = [];
      const strings = t.fields.filter((f) => f.type === "String" && f.name !== pk);
      const usable = strings.filter((f) => {
        let why = null;
        if (f.summary) why = "summary";
        else if (f.global) why = "global";
        else if (f.calc && f.storedCalc !== true) why = "unstored calculation";
        else if (JUNK_FIELD.test(f.name)) why = "name";
        if (why) excluded.push({ field: f.name, why });
        return !why;
      });
      const typed = t.fields
        .filter((f) => (f.type === "Decimal" || f.type === "Date" || f.type === "DateTimeOffset") && f.name !== pk)
        .filter((f) => !f.summary && !f.global && !(f.calc && f.storedCalc !== true))
        .filter((f) => !(f.type === "DateTimeOffset" && /creat|mod/i.test(f.name)))
        .filter((f) => !JUNK_FIELD.test(f.name))
        .map((f) => f.name);
      const jsonField = t.fields.find((f) => f.name.toLowerCase() === MITOS_JSON_FIELD.toLowerCase())?.name || null;
      return {
        name: t.name, db: t.db, rowCount: t.rowCount,
        saxmlName: t.saxmlName || null, comment: t.comment || null,
        occurrenceNames: t.occurrences.slice(0, 8),
        fieldCount: t.fields.length, occurrences: t.occurrences.length,
        hasKey: Boolean(pk), hasMod: Boolean(modField), hasMitosJson: Boolean(jsonField),
        pk, modField, rowIdOnly,
        sampled: false, excluded,
        keyCandidates: t.fields.filter((f) => f.type === "String").map((f) => f.name).slice(0, 40),
        fields: t.fields.map((f) => ({ name: f.name, type: f.type, ...(f.calc ? { calc: true } : {}), ...(f.storedCalc ? { stored: true } : {}), ...(f.summary ? { summary: true } : {}), ...(f.global ? { global: true } : {}) })),
        included: Boolean(saved[t.name]),
        _usable: usable.map((f) => f.name), _typed: typed, _schema: t,
        proposal: saved[t.name] || { pk, mitosJson: Boolean(jsonField), textFields: [...usable.slice(0, 12).map((f) => f.name), ...typed.slice(0, 8)], displayFields: usable.slice(0, 12).map((f) => f.name).sort((a, b) => titleRank(a) - titleRank(b)).slice(0, 4) },
      };
    });

    // THE NAMING PASS. One model call turns occurrence names into human
    // names, says which tables are worth searching, and picks the field that
    // names a record. Without it the picker shows D_Org~B and O_Staff.
    const tName = Date.now();
    scanStatus = { text: namingInfo().configured ? `Naming ${tables.length} tables (one AI call)...` : "Naming tables (no AI key: names are guessed)" };
    const scan = { host: schema.host, dbs: schema.dbs, scannedAt: new Date().toISOString(), naming: { source: null }, tables,
                   hints: Boolean(schema.hintsApplied), ...(schema.dbErrors ? { dbErrors: schema.dbErrors } : {}) };
    await renameScan(scan, refresh);
    superseded();
    timings.namingMs = Date.now() - tName;

    // A SMALL sample of real rows, only for tables worth searching, only the
    // fields still in the running: enough to catch JSON blobs, UUIDs and
    // long text that the metadata cannot see. Never every table.
    const tSample = Date.now();
    const toSample = tables.filter((t) => (t.suggestInclude !== false || t.included) && t._usable.length && !t.rowIdOnly);
    let sampled = 0;
    const sampler = async () => {
      while (toSample.length && gen === connGen) {
        const t = toSample.shift();
        try {
          const rows = await sampleRows(t._schema, 8, t._usable);
          const profile = profileFields(rows, t._usable.map((n) => ({ name: n })));
          if (profile) {
            const keep = t._usable.filter((n) => {
              const p = profile[n]; let why = null;
              if (p.empty >= 0.999) why = "empty";
              else if (p.avg > MAX_AVG_CHARS) why = `avg ${Math.round(p.avg)} chars`;
              else if (p.json > 0.5) why = "JSON";
              else if (p.uuid > 0.5) why = "UUID";
              if (why) t.excluded.push({ field: n, why });
              return !why;
            });
            t.sampled = true;
            if (!t.included) {
              t.proposal.textFields = [...keep.slice(0, 12), ...t._typed.slice(0, 8)];
              const title = t.titleField && keep.includes(t.titleField) ? [t.titleField] : [];
              t.proposal.displayFields = [...title, ...keep.slice().sort((a, b) => titleRank(a) - titleRank(b)).filter((f) => !title.includes(f))].slice(0, 4);
            }
          }
        } catch { /* no sample: the metadata filter still applies */ }
        scanStatus = { text: `Reading a sample of rows, ${++sampled} of ${sampled + toSample.length} tables` };
      }
    };
    await Promise.all([sampler(), sampler(), sampler(), sampler()]);
    superseded();
    timings.sampleMs = Date.now() - tSample;
    for (const t of tables) { delete t._usable; delete t._typed; delete t._schema; }

    scan.timings = { ...timings, totalMs: Date.now() - t0 };
    console.log(`scan: ${tables.length} tables in ${scan.timings.totalMs}ms`, JSON.stringify(timings));
    fs.writeFileSync(SCAN_PATH, JSON.stringify(scan, null, 2));
    { const cfg = readConfig(); if (cfg.fm) { cfg.fm.verifiedAt = scan.scannedAt; writeConfig(cfg); } }
    scanStatus = null;
    return scan;
  } catch (e) {
    scanStatus = null;
    if (e && e.superseded) return readScan();
    console.error("scan failed:", e.message);
    return { error: String(e.message || e).slice(0, 300) };
  }
}

// --- SaXML hints (Pythia's File structure card) -----------------------------
// A Save-a-Copy-as-XML export carries what OData cannot say: the real table
// name, the primary key, the modification field, comments, and which calcs
// store their result. Hints only; the live scan still discovers the tables.
const HINTS_PATH = path.join(DATA_DIR, "schema-hints.json");
function loadHints() { try { return JSON.parse(fs.readFileSync(HINTS_PATH, "utf8")); } catch { return null; } }
function saveHints(h) { fs.writeFileSync(HINTS_PATH, JSON.stringify(h, null, 2)); }
function hintsSummary(h) {
  if (!h) return null;
  const up = Object.fromEntries((h.uploads || []).map((u) => [u.file, u]));
  const files = (h.files || []).map((f) => ({
    file: f.file, tables: f.tables.length,
    withPk: f.tables.filter((t) => t.pk).length,
    withMod: f.tables.filter((t) => t.modField).length,
    uploadedAt: up[f.file]?.at || h.savedAt || null,
    uploadName: up[f.file]?.uploadName || null,
  }));
  return { savedAt: h.savedAt, files, totalTables: files.reduce((a, f) => a + f.tables, 0) };
}
function applyHints(schema) {
  const hints = loadHints();
  if (!hints || !schema?.tables?.length) return schema;
  const idx = hintIndex(hints);
  let matched = 0;
  for (const t of schema.tables) {
    const m = matchTable((t.fields || []).map((f) => f.name), idx, { preferFile: t.db });
    if (!m) continue;
    matched++;
    const ht = m.table;
    t.saxmlName = ht.name;
    if (ht.comment) t.comment = ht.comment;
    if (ht.pk) t.hintPk = ht.pk;
    if (ht.modField) t.modField = ht.modField;
    const stored = new Set((ht.fields || []).filter((f) => f.s).map((f) => f.n));
    const calcs = new Set((ht.fields || []).filter((f) => f.k === "Calculated").map((f) => f.n));
    for (const f of t.fields || []) {
      if (stored.has(f.name)) { f.storedCalc = true; f.calc = true; }
      else if (calcs.has(f.name)) { f.calc = true; f.storedCalc = false; }
    }
  }
  schema.hintsApplied = matched;
  return schema;
}
app.post("/api/schema/saxml", express.raw({ type: () => true, limit: "128mb" }), (req, res) => {
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8");
    if (!buf.length) return res.status(400).json({ error: "The file came through empty." });
    const parsed = parseSaxml(buf.toString("utf8"));
    const merged = mergeHints(loadHints(), parsed);
    merged.uploads = (merged.uploads || []).filter((u) => u.file !== parsed.file);
    merged.uploads.push({ file: parsed.file, uploadName: String(req.query.name || "").slice(0, 120) || null, at: new Date().toISOString() });
    saveHints(merged);
    res.json({ ok: true, file: parsed.file, tables: parsed.tables.length, hints: hintsSummary(merged) });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get("/api/schema/hints", (_req, res) => res.json({ hints: hintsSummary(loadHints()) }));
app.delete("/api/schema/hints", (_req, res) => { try { fs.unlinkSync(HINTS_PATH); } catch {} res.json({ ok: true }); });
app.delete("/api/schema/hints/:file", (req, res) => {
  const h = loadHints();
  if (!h) return res.json({ ok: true, hints: null });
  const name = String(req.params.file || "");
  h.files = (h.files || []).filter((f) => f.file !== name);
  h.uploads = (h.uploads || []).filter((u) => u.file !== name);
  if (!h.files.length) { try { fs.unlinkSync(HINTS_PATH); } catch {} }
  else { h.savedAt = new Date().toISOString(); saveHints(h); }
  res.json({ ok: true, hints: h.files.length ? hintsSummary(h) : null });
});
app.get("/api/disk", (_req, res) => {
  try { const st = fs.statfsSync(DATA_DIR); res.json({ freeBytes: Number(st.bavail) * Number(st.bsize) }); }
  catch (e) { res.json({ freeBytes: null, error: String(e.message || e) }); }
});

// Live model lists. Pythia's lesson: a hardcoded list goes stale and the user
// cannot pick a model that exists. Fetch from whichever provider has a key,
// cache for a day, fall back to a static list when offline.
const MODELS_PATH = path.join(DATA_DIR, "models.json");
const FALLBACK_MODELS = [
  { id: "claude-haiku-4-5", provider: "anthropic" },
  { id: "claude-sonnet-5", provider: "anthropic" },
  { id: "claude-opus-5", provider: "anthropic" },
];
// family: the group a model belongs to; rank: low to high power, for ordering.
function modelFamily(id) {
  const m = String(id).toLowerCase();
  if (m.startsWith("claude")) {
    if (/haiku/.test(m)) return { family: "Haiku", rank: 1 };
    if (/sonnet/.test(m)) return { family: "Sonnet", rank: 2 };
    if (/opus/.test(m)) return { family: "Opus", rank: 3 };
    if (/fable|mythos/.test(m)) return { family: "Fable", rank: 4 };
    return null;
  }
  if (/^text-embedding-3-(small|large)$/.test(m)) return { family: "Embedding", rank: 0 };
  if (/^gemini-embedding/.test(m) || /^voyage-/.test(m)) return { family: "Embedding", rank: 0 };
  if (/^gemini-/.test(m)) return { family: "Gemini", rank: /flash-lite/.test(m) ? 1 : /flash/.test(m) ? 2 : 3 };
  // OpenAI chat: Pythia's fixed list of three, nothing else. OpenAI's own
  // list has no "current models" feed worth trusting, so the menu is these.
  const fixed = OPENAI_FIXED.find((f) => f.id === m);
  return fixed ? { family: "OpenAI", rank: fixed.rank } : null;
}
const OPENAI_FIXED = [
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna (cheapest)", rank: 1 },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra (balanced)", rank: 2 },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol (most powerful)", rank: 3 },
];
// Google and Voyage: fixed short lists (docs/research-ai-stages.md), the
// way OpenAI's chat list is fixed. Offered whenever the key exists.
const GOOGLE_FIXED = [
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite (fastest)", kind: "chat" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", kind: "chat" },
  { id: "gemini-embedding-001", name: "gemini-embedding-001", kind: "embedding" },
];
const VOYAGE_FIXED = [
  { id: "voyage-4-lite", name: "voyage-4-lite (cheapest)", kind: "embedding" },
  { id: "voyage-4", name: "voyage-4", kind: "embedding" },
  { id: "voyage-4-large", name: "voyage-4-large", kind: "embedding" },
];
const OPENAI_EMBED_FIXED = [
  { id: "text-embedding-3-large", name: "text-embedding-3-large", kind: "embedding" },
  { id: "text-embedding-3-small", name: "text-embedding-3-small (cheapest)", kind: "embedding" },
];
function curateModels(all) {
  // The OpenAI three are always offered when an OpenAI key exists, with
  // Pythia's labels, whether or not the dump happened to list them.
  const keys = keyStatus();
  if (keys.openai.configured) for (const f of [...OPENAI_FIXED, ...OPENAI_EMBED_FIXED]) if (!all.some((m) => m.id === f.id)) all = [...all, { id: f.id, name: f.name, provider: "openai", kind: f.kind || "chat", created: "" }];
  if (keys.google.configured) for (const f of GOOGLE_FIXED) if (!all.some((m) => m.id === f.id)) all = [...all, { id: f.id, name: f.name, provider: "google", kind: f.kind, created: "" }];
  if (keys.voyage.configured) for (const f of VOYAGE_FIXED) if (!all.some((m) => m.id === f.id)) all = [...all, { id: f.id, name: f.name, provider: "voyage", kind: f.kind, created: "" }];
  all = all.map((m) => { const f = OPENAI_FIXED.find((x) => x.id === m.id); return f ? { ...m, name: f.name } : m; });
  const by = new Map();
  for (const m of all) {
    const f = modelFamily(m.id);
    if (!f) continue;
    const key = m.provider + ":" + f.family;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ ...m, family: f.family, rank: f.rank, version: f.version || 0 });
  }
  const out = [];
  for (const list of by.values()) {
    // newest first: version, then the provider's creation stamp
    list.sort((a, b) => (b.version - a.version) || String(b.created).localeCompare(String(a.created)) || b.id.localeCompare(a.id));
    // Claude: current and one previous. OpenAI, Google and Voyage: the fixed lists, whole.
    out.push(...(list[0]?.provider === "anthropic" ? list.slice(0, 2) : list));
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider) || a.rank - b.rank || (b.version - a.version) || String(b.created).localeCompare(String(a.created)));
  // Every row says what it is: the pickers for naming, understand, rerank
  // and enrichment hide embedding models, the semantic picker shows only them.
  return out.map(({ version, created, ...m }) => ({ ...m, kind: isEmbeddingModel(m.id) ? "embedding" : "chat" }));
}

app.get("/api/ai/models", async (req, res) => {
  try {
    const cached = JSON.parse(fs.readFileSync(MODELS_PATH, "utf8"));
    // Curate on the way out too: a cache written before the curation rule
    // otherwise serves the raw dump for a day.
    if (req.query.refresh !== "1" && Date.now() - Date.parse(cached.at) < 86400000) return res.json({ ...cached, models: curateModels(cached.models || []) });
  } catch {}
  const keys = keyStatus();
  const out = [];
  const errors = [];
  if (keys.anthropic.configured) {
    try {
      const k = readConfig().ai?.anthropicKey || process.env.ANTHROPIC_API_KEY;
      const r = await fetch("https://api.anthropic.com/v1/models?limit=50", {
        headers: { "x-api-key": k, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`Anthropic ${r.status}`);
      for (const m of (await r.json()).data || []) out.push({ id: m.id, name: m.display_name || m.id, provider: "anthropic", kind: "chat", created: m.created_at || "" });
    } catch (e) { errors.push(`Anthropic: ${e.message}`); }
  }
  if (keys.openai.configured) {
    try {
      const k = readConfig().ai?.openaiKey || process.env.OPENAI_API_KEY;
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`OpenAI ${r.status}`);
      for (const m of (await r.json()).data || []) {
        if (!isOpenAIModel(m.id)) continue;
        // Chat models for naming and enrichment; embedding models for the
        // embedding role. Audio, image and the rest are neither.
        if (isEmbeddingModel(m.id)) { out.push({ id: m.id, name: m.id, provider: "openai", kind: "embedding", created: String(m.created || "") }); continue; }
        if (/whisper|tts|audio|image|realtime|search|transcribe/i.test(m.id)) continue;
        out.push({ id: m.id, name: m.id, provider: "openai", kind: "chat", created: String(m.created || "") });
      }
    } catch (e) { errors.push(`OpenAI: ${e.message}`); }
  }
  // CURATE (Pythia's rule): families low to high, each with the current model
  // and one previous. The raw provider dump (dated snapshots, codex, pro,
  // chat-latest, 3.5-turbo) is not a list a person can choose from.
  const models = curateModels(out.length ? out : FALLBACK_MODELS.map((m) => ({ ...m, name: m.id, kind: "chat", created: "" })));
  const payload = { at: new Date().toISOString(), models, source: out.length ? "live" : "fallback", ...(errors.length ? { errors } : {}) };
  try { fs.writeFileSync(MODELS_PATH, JSON.stringify(payload, null, 2)); } catch {}
  res.json(payload);
});

// Prove an AI key works before relying on it: one tiny real call.
app.post("/api/ai/test", async (req, res) => {
  const which = req.body?.which;
  try {
    if (req.body?.key || req.body?.provider) {
      // A key (typed, or the stored one for the named provider): one cheap
      // authenticated call that costs no tokens, or next to none.
      const provider = req.body.provider || (String(req.body.key).startsWith("sk-ant-") ? "anthropic" : "openai");
      if (!PROVIDERS[provider]) return res.json({ ok: false, error: "Unknown provider." });
      const key = String(req.body.key || keyForProvider(provider, { evenIfDisabled: true }).key || "").trim();
      if (!key) return res.json({ ok: false, error: "No key to test for this provider." });
      const r = provider === "anthropic"
        ? await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15000) })
        : provider === "openai"
          ? await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
          : provider === "google"
            ? await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15000) })
            : await fetch("https://api.voyageai.com/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "voyage-4-lite", input: ["ok"], input_type: "query" }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) return res.json({ ok: false, error: r.status === 401 || r.status === 403 || r.status === 400 ? "That key was rejected." : `The provider answered ${r.status}.` });
      // A key that works is a provider that is on. The switch is saved so
      // the AI tab renders it from the server's state alone.
      { const cfg = readConfig(); cfg.ai = cfg.ai || {}; cfg.ai.providers = cfg.ai.providers || {}; cfg.ai.providers[provider] = { enabled: true }; writeConfig(cfg); }
      return res.json({ ok: true, provider });
    }
    if (which === "naming") {
      const r = await askModel("Reply with the single word: ok", "ping", 20);
      return res.json({ ok: Boolean(r), note: `answered (${namingInfo().model})` });
    }
    // One real run of a search stage, timed, so a person can see the stage
    // work and how long its model takes before switching it on for everyone.
    const cfg = readConfig();
    const opts = { tablesCfg: cfg.tables || tablesConfig(), labels: displayNamesMap(), dateFormat: cfg.dateFormat === "dmy" ? "dmy" : "mdy" };
    const q = String(req.body?.q || "").trim() || "people with birthdays in the first half of May";
    if (which === "understand") {
      const r = await understand(q, opts);
      return res.json(r.error ? { ok: false, error: r.error, ms: r.ms } : { ok: true, ms: r.ms, note: `"${q}" read as: ${r.reading || ""} · query: ${r.query} · ${r.ms} ms`, result: r });
    }
    if (which === "semantic") {
      const t0 = Date.now();
      const v = await embedQuery(q);
      return res.json({ ok: true, ms: Date.now() - t0, note: `embedded "${q}" as ${v.length} numbers in ${Date.now() - t0} ms (${embedInfo().model})` });
    }
    if (which === "rerank") {
      const r = await rerank(q, "words", [
        { table: "a", id: "1", label: "Organization", display: { Name: "Acme Systems", City: "Portland" }, why: ["acme in the title"], via: "exact" },
        { table: "a", id: "2", label: "Organization", display: { Name: "Acme Anvils", City: "Tucson" }, why: ["acme in the title"], via: "exact" },
      ]);
      return res.json(r.error ? { ok: false, error: r.error, ms: r.ms } : { ok: true, ms: r.ms, note: `ranked two sample records in ${r.ms} ms (best: ${r.best === null ? "none" : r.best + 1}, confidence ${r.confidence})` });
    }
    if (which === "enrich") {
      const t0 = Date.now();
      const s = stages().enrich;
      const text = await chat({ model: s.model, system: defaultEnrichPrompt("Organization") + "\nPlain text only, at most 6 lines.", user: "Name: Acme Systems\nCity: Portland\nState: OR", maxTokens: 200, timeoutMs: 30000 });
      return res.json({ ok: Boolean(text), ms: Date.now() - t0, note: `sample notes in ${Date.now() - t0} ms: ${String(text).replace(/\s+/g, " ").slice(0, 160)}` });
    }
    res.status(400).json({ error: "which must be naming, understand, semantic, rerank or enrich" });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

// GET so a FileMaker web viewer or Insert From URL can hit it with ?key=.
// A query that still carries %XX escapes was encoded twice on the way in
// (FileMaker's Set Web Viewer encodes the URL itself, so a GetAsURLEncoded in
// the script doubles it; "macon%20iro" tokenized to "20iro", 2026-09-08).
// Decode once more when it is safe; a real search for a literal "%20" is not
// a thing anyone types.
function undouble(q) {
  const t = String(q || "").trim();
  if (!/%[0-9A-Fa-f]{2}/.test(t)) return t;
  try { return decodeURIComponent(t.replace(/\+/g, " ")).trim(); } catch { return t; }
}
// Two phases behind two URLs, so the page can show the exact list at once
// and fill the AI phase in behind it:
//   GET /api/search?q=      phase 1: exact and fuzzy, deterministic, instant.
//                           Carries `stages.pending` when model stages are on.
//   GET /api/search/ai?q=   phase 2: understanding, similar rows, the decision.
//                           Returns the whole result again, so the page can
//                           replace what it has.
// Options on both: `limit`, `tables=raw,names` (a per-user filter, for the
// FileMaker script), `stages=exact,fuzzy,semantic,understand,rerank` (an
// explicit stage set, for the eval and the simulator), `ai=1` on phase 1
// runs both phases in one response (scripts and Insert From URL).
function searchOptions(req) {
  const cfg = readConfig();
  const tables = req.query.tables ? String(req.query.tables).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const stageOverride = req.query.stages !== undefined ? new Set(String(req.query.stages).split(",").map((s) => s.trim()).filter(Boolean)) : null;
  return {
    limit: Math.min(Math.max(Number(req.query.limit) || 5, 1), 20),
    dateFormat: cfg.dateFormat === "dmy" ? "dmy" : "mdy",
    tables: tables && tables.length ? tables : null,
    stageOverride,
    tablesCfg: cfg.tables || tablesConfig(),
    labels: displayNamesMap(),
  };
}
function labelResult(result) {
  const names = displayNamesMap(), slugs = slugMap();
  const tag = (g) => { g.label = names[g.table] || g.table; g.slug = slugs[g.table] || slugify(g.label); };
  for (const g of result.groups || []) tag(g);
  for (const m of result.merged || []) tag(m);
  for (const g of result.similar || []) tag(g);
  for (const m of result.similarMerged || []) tag(m);
  if (result.best) tag(result.best);
  return result;
}
function logSearch(query, result, req) {
  const shown = [...(result.merged || []), ...(result.similarMerged || [])];
  appendLog("searches.jsonl", {
    ts: new Date().toISOString(),
    query,
    phase: result.phase,
    mode: result.mode,
    kind: result.kind,
    searched: result.searched,
    ...(result.rewritten ? { rewritten: result.rewritten } : {}),
    ...(result.reading ? { reading: result.reading } : {}),
    results: shown.length,
    topScore: result.merged?.[0]?.score ?? null,
    tables: (result.groups || []).map((g) => g.table),
    ms: result.timings?.totalMs ?? null,
    timings: result.timings || null,
    stages: result.stages || null,
    best: result.best ? { table: result.best.table, id: result.best.id, confidence: result.best.confidence, by: result.best.by } : null,
    top: shown.slice(0, 3).map((r) => ({ table: r.table, id: r.id, score: r.score, via: r.via })),
    // Every row that was shown, in the order shown: table, id, title, why.
    // This is the record of what the person saw, for reading back later.
    shown: shown.map((r) => ({ table: r.table, label: r.label, id: r.id, title: String(Object.values(r.display || {})[0] ?? ""), score: r.score, via: r.via, why: r.why })),
    ...(req.query.source ? { source: String(req.query.source).slice(0, 80) } : {}),
    ...(req.query.tables ? { tablesFilter: String(req.query.tables).slice(0, 200) } : {}),
    ...(req.query.stages !== undefined ? { stagesOverride: String(req.query.stages).slice(0, 80) } : {}),
  });
}
async function handleSearch(req, res, phase) {
  const query = undouble(req.query.q);
  if (!query) return res.status(400).json({ error: "q is required" });
  try {
    const result = await search(query, { ...searchOptions(req), phase });
    // An empty index is a setup state, not a search result. Say so and do not
    // log it as a miss.
    if (result.empty) return res.json(result);
    labelResult(result);
    logSearch(query, result, req);
    res.json(result);
  } catch (e) {
    appendLog("searches.jsonl", { ts: new Date().toISOString(), query, phase, error: e.message });
    res.status(500).json({ error: e.message });
  }
}
app.get("/api/search", (req, res) => handleSearch(req, res, req.query.ai === "1" ? "all" : "exact"));
app.get("/api/search/ai", (req, res) => handleSearch(req, res, "all"));

// Random index rows, for the simulator and for a person checking what a
// table's records look like once indexed. Display values only: what the
// search would show.
app.get("/api/index/sample", async (req, res) => {
  const n = Math.min(Math.max(Number(req.query.n) || 20, 1), 500);
  const table = req.query.table ? String(req.query.table) : null;
  try {
    const rows = await sql(
      `SELECT src_table, record_id, display, source_text FROM mitos_index` +
      (table ? ` WHERE src_table='${String(table).replace(/'/g, "''")}'` : "") +
      ` ORDER BY random() LIMIT ${n}`
    );
    const names = displayNamesMap();
    res.json({ rows: rows.map((r) => ({ table: r.src_table, label: names[r.src_table] || r.src_table, id: r.record_id, display: JSON.parse(r.display), source_text: r.source_text })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// { full: true } is the Run button from the paid-pass gate: the stages do
// every waiting row instead of stopping at their quiet caps.
app.post("/api/index/sync", (req, res) => {
  if (syncJob && !syncJob.done) return res.json({ ok: true, already: true, id: syncJob.id });
  const job = startSyncJob({ origin: "user", full: Boolean(req.body?.full), stagesOnly: Boolean(req.body?.stagesOnly) });
  res.json({ ok: true, started: true, id: job.id });
});

// What a paid pass would do now: rows waiting for vectors and for notes,
// tokens and dollars, per table. The AI tab shows it before Run.
app.get("/api/ai/estimate", async (_req, res) => {
  try {
    const cfg = readConfig();
    const s = stages();
    const labels = displayNamesMap();
    const tablesCfg = cfg.tables || tablesConfig();
    const enrichKeys = {};
    for (const [name, t] of Object.entries(tablesCfg)) if (t.enrich?.on && s.enrich.on) enrichKeys[name] = enrichKeyFor(s.enrich.model, promptFor(name, t, labels[name]));
    const est = await passEstimate(vectorKey(), enrichKeys);
    // Per table, what the index holds: rows, rows with notes, rows with a
    // current vector. The AI tab's lines ("12,400 of 30,649 records have
    // notes") come from these counts, never from the ledger.
    const held = await stageStats(vectorKey()).catch(() => ({ tables: [] }));
    const heldBy = Object.fromEntries(held.tables.map((r) => [r.src_table, { rows: Number(r.rows || 0), notes: Number(r.enriched || 0), vectors: Number(r.embedded || 0) }]));
    const embedModel = s.semantic.model;
    // `waiting` is the rows the pass would do; `rows` is the table's size.
    const embed = est.embed.map((r) => ({ table: r.table, label: labels[r.table] || r.table, waiting: r.rows, chars: r.chars, rows: heldBy[r.table]?.rows ?? r.rows, vectors: heldBy[r.table]?.vectors ?? 0,
      tokens: Math.round(r.rows * (r.chars / 4 + 8)), cost: estimateCost(embedModel, r.rows, r.chars / 4 + 8) }));
    const waitingBy = Object.fromEntries(est.enrich.map((r) => [r.table, r]));
    const enrich = Object.keys(tablesCfg).map((table) => {
      const w = waitingBy[table] || { rows: 0, chars: 0 };
      return { table, label: labels[table] || table, on: Boolean(tablesCfg[table].enrich?.on), waiting: w.rows, chars: w.chars,
        rows: heldBy[table]?.rows ?? 0, notes: heldBy[table]?.notes ?? 0,
        tokens: Math.round(w.rows * (w.chars / 4 + 60)), cost: estimateCost(s.enrich.model, w.rows, w.chars / 4 + 60, 120) };
    });
    const sum = (a, k) => Math.round(a.reduce((x, r) => x + Number(r[k] || 0), 0) * 100) / 100;
    res.json({
      embed: { on: s.semantic.on && stageReady("semantic").ready, model: embedModel, rows: sum(embed, "waiting"), waiting: sum(embed, "waiting"), cost: sum(embed, "cost"), tables: embed, capPerSync: EMBED_CAP_PER_SYNC },
      enrich: { on: s.enrich.on && stageReady("enrich").ready, model: s.enrich.model, rows: sum(enrich, "waiting"), waiting: sum(enrich, "waiting"), notes: sum(enrich, "notes"), totalRows: sum(enrich, "rows"), cost: sum(enrich, "cost"), tables: enrich, capPerSync: Number(s.enrich.maxRowsPerSync) || 0 },
      passes: readPasses(12),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Forget a table's search notes on purpose. Switching the table or the
// stage off never does this (the notes were paid for); this button does.
app.post("/api/ai/enrich/forget", async (req, res) => {
  const table = String(req.body?.table || "").trim();
  if (!table) return res.status(400).json({ error: "table is required" });
  try {
    const cleared = await clearEnrichment(table);
    res.json({ ok: true, table, cleared });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The kit: the FileMaker script a person pastes into their file. Served as
// XML so a browser offers it as a file, and a Web Viewer can read it.
app.get("/api/kit/beacon.xml", (_req, res) => {
  const file = path.join(__dirname, "filemaker", "Mitos Beacon.xmss.xml");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "The Mitos Beacon script is not part of this build." });
  res.type("text/xml").sendFile(file);
});

// The enrichment window's preview: notes for two sample records per table,
// with the prompt as typed, nothing saved. Costs a few cents.
app.post("/api/ai/enrich-preview", async (req, res) => {
  try {
    const s = stages();
    const model = String(req.body?.model || s.enrich.model || "").trim();
    if (!model) return res.status(400).json({ error: "No enrichment model: add a key on the AI tab." });
    const labels = displayNamesMap();
    const tables = Array.isArray(req.body?.tables) ? req.body.tables.slice(0, 12) : [];
    const n = Math.min(Math.max(Number(req.body?.n) || 2, 1), 5);
    const out = [];
    for (const table of tables) {
      const rows = await sql(`SELECT record_id, source_text FROM mitos_index WHERE src_table='${String(table).replace(/'/g, "''")}' ORDER BY random() LIMIT ${n}`).catch(() => []);
      if (!rows.length) { out.push({ table, label: labels[table] || table, error: "no indexed rows yet" }); continue; }
      const prompt = String(req.body?.prompt || "").trim() || promptFor(table, readConfig().tables?.[table], labels[table]);
      try {
        const r = await enrichPreview({ model, prompt, rows });
        out.push({ table, label: labels[table] || table, ms: r.ms, notes: r.notes });
      } catch (e) { out.push({ table, label: labels[table] || table, error: String(e.message).slice(0, 200) }); }
    }
    res.json({ model, tables: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The per-record beacon from FileMaker's OnWindowTransaction script:
//   { "tables": { "D_Org~B": { "changed": [ids], "deleted": [ids] } } }
// or the flat form { "table": "D_Org~B", "ids": [...], "deleted": [...] }.
// Ids are primary key values. Mitos pulls those rows over OData, indexes
// them, and runs the stages on them. A sync in progress answers 202 and
// the next sync picks the change up by timestamp.
app.post("/api/records/changed", async (req, res) => {
  const b = req.body || {};
  const work = [];
  if (b.tables && typeof b.tables === "object") {
    for (const [table, v] of Object.entries(b.tables)) work.push({ table, ids: [].concat(v?.changed || v?.ids || []), deleted: [].concat(v?.deleted || []) });
  } else if (b.table) work.push({ table: String(b.table), ids: [].concat(b.ids || b.id || []), deleted: [].concat(b.deleted || []) });
  if (!work.length) return res.status(400).json({ error: "send { tables: { <raw name>: { changed: [ids], deleted: [ids] } } }" });
  const configured = readConfig().tables || {};
  const bySlug = Object.fromEntries(Object.entries(slugMap()).filter(([raw]) => configured[raw]).map(([raw, slug]) => [slug, raw]));
  const results = [];
  for (const w of work) {
    const raw = configured[w.table] ? w.table : bySlug[w.table];
    if (!raw) { results.push({ table: w.table, error: "not an indexed table" }); continue; }
    try {
      const r = await refreshRecords({ table: raw, ids: w.ids.map(String).filter(Boolean).slice(0, 500), deleted: w.deleted.map(String).filter(Boolean).slice(0, 500) });
      results.push(r);
      if (r.deferred) return res.status(202).json({ deferred: true, reason: r.reason, results });
    } catch (e) { results.push({ table: raw, error: String(e.message).slice(0, 200) }); }
  }
  appendLog("beacon.jsonl", { ts: new Date().toISOString(), results });
  res.json({ ok: results.every((r) => !r.error), results });
});

app.get("/api/index/status", async (_req, res) => {
  res.json({
    building: isBuilding(),
    ...VERSION,
    manifest: indexManifest(),
    stats: await indexStats().catch(() => ({ tables: [], totalRows: 0 })),
    tables: Object.keys(tablesConfig()),
    lastCrash: lastCrash(),
  });
});

// --- The search log ----------------------------------------------------------
// Every search and every click lands on this box as JSONL. Two files, one line
// per event, append-only: cheap to write, trivial to read back, and the raw
// material for the learning loop (which queries found nothing, which result a
// person actually chose). Nothing here is sent anywhere; it is the operator's own log.
function appendLog(file, obj) {
  fs.appendFile(path.join(DATA_DIR, file), JSON.stringify(obj) + "\n", () => {});
}

app.post("/api/click", (req, res) => {
  const { query, table, record_id, rank, score } = req.body || {};
  if (!table || !record_id) return res.status(400).json({ error: "table and record_id required" });
  appendLog("clicks.jsonl", {
    ts: new Date().toISOString(), query: query || "", table, record_id,
    rank: Number.isFinite(rank) ? rank : null, score: Number.isFinite(score) ? score : null,
  });
  res.json({ ok: true });
});

// Recent activity, newest first. Feeds the Log tab in Settings and, later, the
// learning loop: a query with no click is a query that failed.
app.get("/api/log", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const read = (file) => {
    try {
      return fs.readFileSync(path.join(DATA_DIR, file), "utf8")
        .trim().split("\n").filter(Boolean).slice(-limit)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  const searches = read("searches.jsonl").reverse();
  const clicks = read("clicks.jsonl").reverse();
  // Pair each search with the click it produced, if any: that pairing is the
  // signal. A search with no click is not noise, it is the interesting case.
  const clicksByQuery = new Map();
  for (const c of clicks) {
    if (!clicksByQuery.has(c.query)) clicksByQuery.set(c.query, []);
    clicksByQuery.get(c.query).push(c);
  }
  const rows = searches.map((s) => ({
    ...s,
    clicked: (clicksByQuery.get(s.query) || []).find((c) => Math.abs(Date.parse(c.ts) - Date.parse(s.ts)) < 600000) || null,
  }));
  res.json({ searches: rows, totals: { searches: searches.length, clicks: clicks.length } });
});

// --- Auto-sync (Pythia's pattern) ---------------------------------------------
// A 60s wall-clock tick that checks a DUE TIME derived from the manifest's
// builtAt, not an in-memory timer: a scale-to-zero sleep/wake just means
// "overdue, catch up on the next tick". Honest caveat (from Pythia's field
// experience): on Fly the machine sleeps when idle, so ticks only run while
// awake; an FMS script schedule POSTing /api/index/sync is the reliable clock.
async function autoSyncTick() {
  const every = Number(readConfig().syncEvery || 0);
  if (!every || isBuilding() || !fmConfigured()) return;
  const last = indexManifest().builtAt ? Date.parse(indexManifest().builtAt) : 0;
  if (Date.now() - last < every * 60000) return;
  startSyncJob({ origin: "auto-sync" });
}
setInterval(autoSyncTick, 60000);

// --- Boot ---------------------------------------------------------------------

app.listen(PORT, async () => {
  console.log(`Mitos listening on http://localhost:${PORT}`);
  console.log(`  fm: ${fmConfigured() ? "configured" : "not configured (sample mode)"}`);
  console.log(`  naming: ${JSON.stringify(namingInfo())}`);
  console.log(`  stages: ${STAGE_NAMES.map((n) => `${n}=${stages()[n].on ? (stageReady(n).ready ? "on" : "on, " + stageReady(n).why) : "off"}`).join(", ")}`);
  // BOOT NEVER SYNCS. This used to start a full enrichment run whenever the
  // index was empty and the keys were set. Every deploy reboots the machine,
  // so every deploy relaunched a paid run over whatever tables happened to be
  // configured - unasked (2026-09-04). A sync happens when a person asks, when
  // the auto-sync interval is due, or when FileMaker's schedule calls it.
  try {
    // An index built by an older build lacks the stage columns; the search
    // selects them. Add them at boot, before the first search, not at the
    // next sync (every search 500ed for the gap, review 2026-09-08).
    if (storeExists()) await ensureIndexTable().catch((e) => console.error("index columns:", e.message));
    const stats = await indexStats();
    if (!stats.totalRows) console.log("index is empty. Open Settings, choose tables, and press Sync now.");
  } catch (e) {
    console.error("boot check failed:", e.message);
  }
  // Warm the embedding connection: the first call to a provider pays for
  // TLS and routing (three seconds measured); the ones after do not. One
  // tiny query at boot moves that cost off the first person's search.
  // One vector scan too: it pulls the vector file into the page cache, so
  // the first search after the machine wakes does not pay the cold read
  // (5.6 s measured on the demo box, 1 to 3 s warm).
  if (stageReady("semantic").ready) embedQuery("mitos").then((v) => vectorSearch(v, vectorKey(), { perTable: 1 })).catch(() => {});
  // The same for the fast chat model: a five-token call opens the
  // connection the first search would otherwise wait for (a cold rerank
  // missed its 3-second budget on the demo box, 2026-09-08).
  for (const name of ["understand", "rerank"]) {
    if (!stageReady(name).ready) continue;
    chat({ model: stages()[name].model, system: "Reply with the single word: ok", user: "ok", maxTokens: 5, timeoutMs: 15000 }).catch(() => {});
    break;
  }
});
