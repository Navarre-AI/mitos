// Mitos: search sidecar for FileMaker. One field, any table, the right
// record. FileMaker (or the bundled sample data standing in for it) is the
// source of truth: everything displayed comes verbatim from source rows.
// Search is deterministic (search.js). See README.md and RULES.md.

import "./env.js";
import express from "express";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { fmConfigured, fmConnection, setConnection, resetConnection, withConnection, checkAuth, listDatabases, fetchSchema, fetchCounts, sampleRows, fmReason } from "./fm.js";
import { normalizeText, indexStats, stageStats, sql, storeExists, ensureIndexTable, vectorSearch, passEstimate, clearEnrichment, freeDiskBytes, totalDiskBytes, storeManifest, dropTableCopies, wipeCopies, wipeIndex, wipeNotes, wipeAllLocalData, deleteAllVectors, deleteTableVectors, vectorTotals } from "./store.js";
import { buildIndex, indexManifest, isBuilding, isRefreshing, tablesConfig, MITOS_JSON_FIELD, refreshRecords } from "./indexer.js";
import { semanticOn, semanticTables, semanticDefault } from "./semantic.js";
import { search, forgetSearchCache } from "./search.js";
import { setHouseWords } from "./query.js";
import { namingInfo, keyStatus, isEmbeddingModel, askModel, roleModels, PROVIDERS, STAGE_NAMES, STAGE_DEFAULTS, STAGE_LIMITS, stages, stageReady, keyForProvider, providerOf, modelId, chat, estimateCost, modelListCache, refreshModelList, ensureModelList, RECOMMENDED_JOB, autoModel, modelsView, curatedReady, refreshCurated, curatedStatus, refreshAllModels } from "./ai.js";
import { vectorKey, vectorKeyFor, embedInfo, embedQuery } from "./embed.js";
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
const GATE = Boolean(SITE_PASSWORD); // false: no sign-in, no sessions, no Sign out
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

// Password gate: if SITE_PASSWORD is set, the whole site requires it.
//
// People sign in on a page: the bare address shows one key field, and a
// right key gets a session cookie holding a random token (never the key).
// People type the key on the sign-in page and it never sits in a URL for
// them; the session cookie holds a random token, not the key. A web viewer
// or a machine call (a FileMaker script, a schedule, curl) does put the site
// password in the URL (?key=) or an HTTP Basic header, so it lives in that
// script and layout, and a Save as XML or a DDR of the FileMaker file will
// show it. Treat the file like a password store.
//
// Machines (a FileMaker Server schedule waking the sync, Insert from URL,
// curl, the eval scripts) may still use ?key= or HTTP Basic on /api/.
// A page load with the right ?key= signs in like the sign-in page does, and
// the page loads at that address, key and all.
// Danger zone, "Sign everyone out": the gate below fills this in. With no
// SITE_PASSWORD there are no sessions and it is a no-op.
let wipeSessions = () => 0;
if (SITE_PASSWORD) {
  const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
  const SESSION_DAYS = 30;
  const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
  // { sha256(token): createdAtMs }. Only hashes are stored, so the file is no
  // use to someone who reads the volume.
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8")); } catch {}
  const saveSessions = () => {
    const cutoff = Date.now() - SESSION_DAYS * 864e5;
    for (const [h, t] of Object.entries(sessions)) if (t < cutoff) delete sessions[h];
    try { fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions)); } catch {}
  };
  const keyMatches = (given) => {
    const a = crypto.createHash("sha256").update(String(given ?? "")).digest();
    const b = crypto.createHash("sha256").update(SITE_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const readCookie = (req, name) => {
    for (const c of (req.headers.cookie || "").split(";")) {
      const i = c.indexOf("=");
      if (i > 0 && c.slice(0, i).trim() === name) return decodeURIComponent(c.slice(i + 1).trim());
    }
    return "";
  };
  const sessionOk = (req) => {
    const t = readCookie(req, "mitos_session");
    if (!t) return false;
    const at = sessions[hashToken(t)];
    return !!at && at > Date.now() - SESSION_DAYS * 864e5;
  };
  const isHttps = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
  // Only a same-site path may be the place to land after signing in.
  const safeNext = (n) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\")) ? n : "/";
  // Wrong keys: five in ten minutes from one address, then that address
  // waits a minute after its last wrong key (and again after each one more).
  const misses = new Map();
  const tooMany = (ip) => {
    const now = Date.now();
    const list = (misses.get(ip) || []).filter((t) => t > now - 10 * 60e3);
    misses.set(ip, list);
    return list.length >= 5 && now - list[list.length - 1] < 60e3;
  };
  const missKey = (ip) => { if (!misses.has(ip)) misses.set(ip, []); misses.get(ip).push(Date.now()); };
  const TOO_MANY = "Too many tries. Wait a minute and try again.";
  // A signed-in session: a random token in a cookie, only its hash on disk.
  const startSession = (req, res) => {
    const token = crypto.randomBytes(32).toString("base64url");
    sessions[hashToken(token)] = Date.now();
    saveSessions();
    res.setHeader("Set-Cookie", `mitos_session=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax; HttpOnly${isHttps(req) ? "; Secure" : ""}`);
  };
  wipeSessions = (req, res) => {
    const n = Object.keys(sessions).length;
    sessions = {};
    saveSessions();
    res.setHeader("Set-Cookie", `mitos_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${isHttps(req) ? "; Secure" : ""}`);
    return n;
  };
  const clientIp = (req) => String(req.headers["fly-client-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const signinPage = (next, message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mitos</title>
<style>
  :root { --bg:#f6f7f8; --panel:#ffffff; --text:#1c2328; --dim:#5f6b76; --accent:#b8821f; --on-accent:#1c2328; --line:#d9dee3; --warn:#c2621f; color-scheme:light; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101418; --panel:#1a2027; --text:#e6e9ec; --dim:#8b96a0; --accent:#d9a441; --on-accent:#101418; --line:#2a323b; --warn:#d98041; color-scheme:dark; }
  }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px;
         background:var(--bg); color:var(--text); font:15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  form { width:100%; max-width:340px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:24px; }
  h1 { margin:0 0 4px; font-size:20px; font-weight:600; }
  p { margin:0 0 16px; color:var(--dim); }
  input { width:100%; padding:10px 12px; font:inherit; color:var(--text); background:var(--bg); border:1px solid var(--line); border-radius:6px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { margin-top:12px; width:100%; padding:10px; font:inherit; font-weight:600; color:var(--on-accent); background:var(--accent); border:0; border-radius:6px; cursor:pointer; }
  .msg { margin:12px 0 0; color:var(--warn); }
</style></head>
<body>
<form method="post" action="/signin">
  <h1>Mitos</h1>
  <p>Enter the site password to search.</p>
  <input type="password" name="key" autocomplete="current-password" aria-label="Site password" autofocus required>
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">Sign in</button>
  ${message ? `<p class="msg" role="alert">${esc(message)}</p>` : ""}
</form>
</body></html>`;

  const signinHeaders = (res) => res.set({ "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });

  app.get("/signin", (req, res) => signinHeaders(res).send(signinPage(safeNext(req.query.next), "")));
  app.post("/signin", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    const ip = clientIp(req);
    const next = safeNext(req.body?.next);
    if (tooMany(ip)) return signinHeaders(res).status(429).send(signinPage(next, TOO_MANY));
    if (!keyMatches(req.body?.key)) {
      missKey(ip);
      return signinHeaders(res).status(401).send(signinPage(next, "That password didn't work."));
    }
    misses.delete(ip);
    startSession(req, res);
    return res.redirect(303, next);
  });
  app.get("/signout", (req, res) => {
    const t = readCookie(req, "mitos_session");
    if (t) { delete sessions[hashToken(t)]; saveSessions(); }
    res.setHeader("Set-Cookie", `mitos_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${isHttps(req) ? "; Secure" : ""}`);
    return res.redirect(303, "/signin");
  });

  app.use((req, res, next) => {
    const isApi = req.path.startsWith("/api/");
    // A page load with the right ?key= signs in, the same as the sign-in
    // page, and the page loads with the key still in the address. (An old address
    // with the key in it, a bookmark, a FileMaker web viewer URL.) A wrong
    // key counts like a wrong key on the sign-in page.
    if (!isApi && req.query.key !== undefined) {
      const u = new URL(req.originalUrl, "http://x");
      u.searchParams.delete("key");
      const here = u.pathname + u.search;
      const ip = clientIp(req);
      if (tooMany(ip)) return signinHeaders(res).status(429).send(signinPage(safeNext(here), TOO_MANY));
      if (keyMatches(req.query.key)) {
        misses.delete(ip);
        if (!sessionOk(req)) startSession(req, res);
        return next(); // the page loads with the key still in the address
      }
      if (sessionOk(req)) return next(); // already signed in; a stale key in the address changes nothing
      missKey(ip);
      return signinHeaders(res).status(401).send(signinPage(safeNext(here), "That password didn't work."));
    }
    if (sessionOk(req)) return next();
    if (isApi) {
      // A key in ?key= or in Basic auth, from a script. Wrong ones count like
      // wrong keys on the sign-in page, and the same pause applies.
      let given;
      if (req.query.key !== undefined) given = req.query.key;
      else {
        const header = req.headers.authorization || "";
        if (header.startsWith("Basic ")) {
          const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
          given = decoded.slice(decoded.indexOf(":") + 1);
        }
      }
      if (given !== undefined) {
        const ip = clientIp(req);
        if (tooMany(ip)) return res.status(429).json({ error: TOO_MANY });
        if (keyMatches(given)) { misses.delete(ip); return next(); }
        missKey(ip);
      }
      return res.status(401).json({ error: "Not signed in.", signin: "/signin" });
    }
    // A page: send the person to sign in, then back to where they were going.
    // A ?key= on the address is dropped from where they land.
    const u = new URL(req.originalUrl, "http://x");
    u.searchParams.delete("key");
    return res.redirect(303, `/signin?next=${encodeURIComponent(u.pathname + u.search)}`);
  });
}

// No site password, no sign-in: the sign-in and sign-out addresses go home.
if (!SITE_PASSWORD) app.get(["/signin", "/signout"], (_req, res) => res.redirect(303, "/"));

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
// True while a sync (or a one-record refresh) holds the local data. The wipes
// and drops refuse then; `wiping` also keeps a sync from starting under one.
let wiping = false;
const syncRunning = () => Boolean((syncJob && !syncJob.done) || isBuilding());
const SYNC_BUSY = "A sync is running. Cancel it first.";

function startSyncJob({ origin = "user", full = false, stagesOnly = false, rebuild = false, fromScratch = false } = {}) {
  // Two guards, because they catch different things: an unfinished job record,
  // and an engine that is still running under a job record that already died.
  if (isRefreshing()) return null; // a record refresh holds the data: the caller says so
  if ((syncJob && !syncJob.done) || isBuilding()) return syncJob;
  if (wiping) return syncJob;
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
  buildIndex({ onEvent: jobEmit, shouldStop: () => cancelFlag, expected, full, stagesOnly, rebuild, fromScratch })
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
    gate: GATE,
    indexRows: stats.totalRows,
    naming: namingInfo(),
  });
});

// What this machine is, for Settings, Settings tab. Memory and disk in bytes.
function memoryNow() {
  const num = (f) => { try { const t = fs.readFileSync(f, "utf8").trim(); return t === "max" ? null : Number(t); } catch { return null; } };
  let used = null, total = null;
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (k) => Number((mi.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")) || [])[1] || 0);
    if (kb("MemTotal") && kb("MemAvailable")) { used = (kb("MemTotal") - kb("MemAvailable")) * 1024; total = kb("MemTotal") * 1024; }
  } catch { /* not linux */ }
  if (used === null) used = process.memoryUsage().rss;
  const limit = num("/sys/fs/cgroup/memory.max") ?? num("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  // A cgroup limit below the machine's memory is the real ceiling.
  if (limit && limit < 1e15 && (!total || limit < total)) total = limit;
  return { memUsed: used, memTotal: total || os.totalmem() };
}
app.get("/api/about", (_req, res) => {
  let diskUsed = null, diskTotal = null;
  try { const st = fs.statfsSync(DATA_DIR); diskTotal = Number(st.blocks) * Number(st.bsize); diskUsed = (Number(st.blocks) - Number(st.bfree)) * Number(st.bsize); } catch {}
  const sm = storeManifest();
  res.json({
    version: VERSION.version, built: VERSION.built,
    gate: GATE,
    region: process.env.FLY_REGION || null,
    machine: process.env.FLY_MACHINE_ID || null,
    image: process.env.FLY_IMAGE_REF || null,
    ...memoryNow(),
    cpus: os.cpus().length,
    diskUsed, diskTotal,
    copyRows: Number(sm.totalRows || 0),
    copyTables: (sm.tables || []).length,
    lastSync: indexManifest().builtAt || sm.syncedAt || null,
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
    gate: GATE,
    version: VERSION,
    // null = running on the shipped sample config. Each table's `semantic` is the switch IN EFFECT (the saved one, else the default for its fields).
    tables: cfg.tables ? Object.fromEntries(Object.entries(cfg.tables).map(([n, t]) => [n, { ...t, semantic: semanticOn(n, t) }])) : null,
    syncEvery: Number(cfg.syncEvery || 0),
    dateFormat: cfg.dateFormat === "dmy" ? "dmy" : "mdy",
    houseWords: String(cfg.houseWords || ""),
    displayNames: displayNamesMap(),
    slugs: slugMap(),
    savedAt: cfg.savedAt || null,
    scan: scan ? { scannedAt: scan.scannedAt, tableCount: scan.tables.length,
                   fieldCount: scan.tables.reduce((a, t) => a + t.fieldCount, 0), via: "OData" } : null,
    index: { totalRows: stats.totalRows, tables: stats.tables,
             builtAt: indexManifest().builtAt || null, building: isBuilding() },
    ai: { naming: namingInfo(), keys: keyStatus(), hasKey: namingInfo().configured, models: roleModels(),
          recommended: RECOMMENDED_JOB,
          defaults: { naming: autoModel("naming"), enrich: autoModel("enrich"), understand: autoModel("understand"),
                      rerank: autoModel("rerank"), semantic: autoModel("semantic") },
          providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, chat: p.chat, embed: p.embed }])),
          stages: stagesView(), embedding: embedInfo(),
          coverage: await coverageView(cfg) },
    enrichPromptDefault: Object.fromEntries(Object.keys(cfg.tables || {}).map((n) => [n, defaultEnrichPrompt(displayNamesMap()[n] || n)])),
    neverSynced: !indexManifest().builtAt && !stats.totalRows,
    hints: hintsSummary(loadHints()),
  });
});

// Per table: rows, notes, vectors (`vectors`, `vectorBytes` estimated), and the
// table's semantic switch in effect.
async function coverageView(cfg) {
  const c = await stageStats(vectorKey(), embedInfo().dims).catch(() => ({ tables: [], totalRows: 0, enriched: 0, embedded: 0, vectors: 0 }));
  const tcfg = cfg.tables || tablesConfig();
  return { ...c, tables: c.tables.map((r) => ({ ...r, semantic: semanticOn(r.src_table, tcfg[r.src_table]) })) };
}

// The stages as the settings screen shows them: the saved values with the
// defaults filled in, plus whether each can run right now and why not.
function stagesView() {
  const s = stages();
  const saved = readConfig().ai?.stages || {};
  const out = {};
  for (const name of STAGE_NAMES) {
    const r = stageReady(name);
    out[name] = { ...s[name], savedModel: saved[name]?.model || "", ready: r.ready, why: r.why || null,
      ...(name in RECOMMENDED_JOB ? { recommendedJob: RECOMMENDED_JOB[name], defaultModel: autoModel(name) } : {}),
      // semantic: is there an embedding model with a key to switch it on with
      ...(name === "semantic" ? { available: Boolean(s.semantic.model && providerOf(s.semantic.model, "embedding") && keyForProvider(providerOf(s.semantic.model, "embedding")).key) } : {}),
      provider: s[name].model ? providerOf(s[name].model, name === "semantic" ? "embedding" : "chat") || null : null };
  }
  return out;
}

// Save connection, table config, sync interval, and/or AI keys. Body:
// { fm?: {host,db,user,pass}, tables?: {...}, syncEvery?: minutes,
//   ai?: {anthropicKey, openaiKey, namingModel} } - blank keys keep the stored ones.
// A table entry the save accepts: a key and at least one text field.
const validTable = (t) => t && t.pk && (t.mitosJson || (Array.isArray(t.textFields) && t.textFields.length));
// A table sent without its cMitosJSON flag keeps the saved one (the Tables tab
// does not always send it); an explicit true or false wins.
const withSavedFlags = (t, prev) => (t && t.mitosJson === undefined && prev?.mitosJson ? { ...t, mitosJson: true } : t);
app.post("/api/config", async (req, res) => {
  try {
    // A table that was chosen and is not chosen now loses its local copy. That
    // cannot happen under a running sync: refuse before anything is saved.
    let dropNow = [];
    let vecOff = []; // tables whose semantic switch goes off in this save: their vectors go
    const savedTables = readConfig().tables || {};
    const beforeTables = readConfig().tables || tablesConfig(); // what was in effect: a sample install has the shipped tables
    if (req.body?.tables && typeof req.body.tables === "object") {
      // A table sent with settings that cannot work is an error naming the
      // table, never a table that quietly counts as unselected (and loses its copy).
      const shownName = displayNamesMap();
      for (const [n, t] of Object.entries(req.body.tables)) {
        if (!validTable(withSavedFlags(t, savedTables[n]))) return res.status(400).json({ error: `${shownName[n] || savedTables[n]?.displayName || n} has settings Mitos cannot use: it needs a key field and at least one field to search. Fix it in Settings, Tables, or untick it.` });
      }
      const keep = new Set(Object.keys(req.body.tables));
      if (keep.size) dropNow = Object.keys(savedTables).filter((n) => !keep.has(n));
      vecOff = Object.entries(req.body.tables).filter(([n, t]) => t && t.semantic === false && !dropNow.includes(n) && semanticOn(n, beforeTables[n])).map(([n]) => n);
      if ((dropNow.length || vecOff.length) && (syncRunning() || wiping)) return res.status(409).json({ error: SYNC_BUSY });
      // A table's Semantic switch cannot go on with no vector model to run it.
      const newlySemantic = Object.entries(req.body.tables).filter(([n, t]) => t && t.semantic === true && !semanticOn(n, beforeTables[n]));
      if (newlySemantic.length) {
        const m = stages().semantic.model || autoModel("semantic");
        const p = m ? providerOf(m, "embedding") : "";
        if (!p || !keyForProvider(p).key) return res.status(400).json({ error: "Semantic search needs a Google, OpenAI or Voyage key. Add one on the AI tab." });
      }
    }
    let dropped = [];
    let vectorsDeleted = {};
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
    if (req.body?.houseWords !== undefined) {
      const cfg = readConfig();
      const text = String(req.body.houseWords || "").replace(/\r\n?/g, "\n").slice(0, 20000).trim();
      if (text) cfg.houseWords = text; else delete cfg.houseWords;
      writeConfig(cfg);
      setHouseWords(text);
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
          // may have one (a test box had an embedding model saved as the
          // naming model on 2026-09-09). The kind comes from the live list.
          if (name !== "semantic" && patch.model && isEmbeddingModel(patch.model)) {
            return res.status(400).json({ error: `"${String(patch.model).trim()}" is an embedding model. Choose a chat model for ${name === "enrich" ? "enrichment" : name}.` });
          }
          for (const [k, v] of Object.entries(patch)) {
            if (!(k in STAGE_DEFAULTS[name])) continue;
            // Enrichment and semantic search have no switch of their own: a
            // table's own switch decides, and the stage is on when any table is.
            if (k === "on" && (name === "enrich" || name === "semantic")) continue;
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
      // A key just saved or forgotten: the model lists are read again at once
      // (the public list if it is stale, the provider lists always), so the
      // menus and the semantic row are right when the page asks next.
      if (Object.values(PROVIDERS).some((p) => req.body.ai[p.cfgKey] !== undefined && req.body.ai[p.cfgKey] !== "")) {
        let timer;
        await Promise.race([refreshAllModels(), new Promise((r) => { timer = setTimeout(r, 12000); })]);
        clearTimeout(timer);
      }
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
      const entries = Object.entries(req.body.tables).map(([n, t]) => [n, withSavedFlags(t, savedTables[n])]);
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
          ...(typeof t.semantic === "boolean" ? { semantic: t.semantic } : typeof savedTables[name]?.semantic === "boolean" ? { semantic: savedTables[name].semantic } : {}),
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
      if (dropNow.length) { dropped = await dropTableCopies(dropNow); forgetSearchCache(); }
      for (const n of vecOff) vectorsDeleted[n] = (await deleteTableVectors([n])).deleted;
    }
    res.json({ ok: true, fm: fmConnection(), tables: readConfig().tables || null, dropped, vectorsDeleted });
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
  // FileMaker's count as the last sync saw it beats the scan's, which is only
  // as fresh as the last scan (months old on a long-running box).
  const synced = Object.fromEntries((storeManifest().tables || []).map((m) => [m.name, m.remoteCount]));
  for (const t of scan.tables) {
    if (Number.isFinite(Number(synced[t.name])) && synced[t.name] !== null) t.rowCount = Number(synced[t.name]);
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
      let pk = named(/uuid|guid/i)
        || declared
        || named(/^id$/i)
        || named(/^pk\b|^id[_ ]/i)
        || null;
      // True when the ONLY thing FileMaker offered was ROWID: the table has no
      // unique, not-empty field at all. Say so plainly; it is a schema fact,
      // not a Mitos limitation.
      // The SaXML hint comes first: a key the export names is a key, so a table
      // whose only OData key is ROWID is not "rowIdOnly" when the hint has one.
      if (!pk && t.hintPk && t.fields.some((f) => f.name === t.hintPk)) pk = t.hintPk;
      const rowIdOnly = Boolean((t.keys || []).length && (t.keys || []).every(isRowId) && !pk);
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

// The model list: navarre.ai/ai-models.json (ai.js), kept current by a daily
// job on his site. It decides what the menus show, each model's job and its
// price, and what each stage defaults to. Each model says whether its provider
// has a key (`usable`). The providers' own live lists only fill in what the
// public list lacks (OpenAI's embedding models) and say which ids a key can
// reach. A copy on the volume is never waited on; with none, the first answer
// waits up to 2 seconds for the fetch. ?refresh=1 reads both lists now.
app.get("/api/ai/models", async (req, res) => {
  const errors = [];
  try {
    if (req.query.refresh === "1") {
      const r = await Promise.all([refreshCurated(true).catch((e) => { errors.push(String(e.message || e)); return null; }), refreshModelList().catch((e) => { errors.push(String(e.message || e)); return null; })]);
      if (!r[0] || curatedStatus().error) errors.push(`The public model list could not be read (${curatedStatus().error || "no answer"}); showing the last copy.`);
      if (r[1]?.errors) errors.push(...r[1].errors);
    } else {
      await curatedReady(2000);
      const live = modelListCache();
      if (!live || Date.now() - Date.parse(live.at) > 86400000) refreshModelList().catch(() => {}); // for Other... and the embedding fill-in, not waited on
    }
  } catch (e) { errors.push(String(e.message || e)); }
  res.json({ ...modelsView(), ...(errors.length ? { errors } : {}) });
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
      const sem = stages().semantic.model;
      const voyageModel = provider === "voyage" && sem && providerOf(sem, "embedding") === "voyage" ? modelId(sem) : "";
      const r = provider === "anthropic"
        ? await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15000) })
        : provider === "openai"
          ? await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
          : provider === "google"
            ? await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15000) })
            : await fetch("https://api.voyageai.com/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ ...(voyageModel ? { model: voyageModel } : {}), input: ["ok"], input_type: "query" }), signal: AbortSignal.timeout(15000) });
      // Voyage has no free call and no model list. With a Voyage model
      // chosen, one tiny embedding; without one, the call names no model:
      // a refused key answers 401 or 403, a good one is told the model is
      // missing (400 or 422).
      const voyageUnnamed = provider === "voyage" && !voyageModel && (r.status === 400 || r.status === 422);
      if (!r.ok && !voyageUnnamed) return res.json({ ok: false, error: r.status === 401 || r.status === 403 || r.status === 400 ? "That key was rejected." : `The provider answered ${r.status}.` });
      // A key that works is a provider that is on. The switch is saved so
      // the AI tab renders it from the server's state alone.
      { const cfg = readConfig(); cfg.ai = cfg.ai || {}; cfg.ai.providers = cfg.ai.providers || {}; cfg.ai.providers[provider] = { enabled: true }; writeConfig(cfg); }
      return res.json({ ok: true, provider });
    }
    if (which === "naming") {
      const r = await askModel("Reply with the single word: ok", "ping", 200);
      return res.json(r && r.trim() ? { ok: true, note: `answered (${namingInfo().model})` } : { ok: false, error: `${namingInfo().model} answered with nothing. Try again, or pick a different model.` });
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
      const text = await chat({ model: s.model, system: defaultEnrichPrompt("Organization") + "\nPlain text only, at most 6 lines.", user: "Name: Acme Systems\nCity: Portland\nState: OR", maxTokens: 1000, timeoutMs: 30000 });
      if (!String(text || "").trim()) return res.json({ ok: false, ms: Date.now() - t0, error: `${s.model} answered with nothing. Try again, or pick a different model.` });
      return res.json({ ok: true, ms: Date.now() - t0, note: `sample notes in ${Date.now() - t0} ms: ${String(text).replace(/\s+/g, " ").slice(0, 160)}` });
    }
    res.status(400).json({ error: "which must be naming, understand, semantic, rerank or enrich" });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e).slice(0, 300) });
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
  setHouseWords(cfg.houseWords || "");
  const tables = req.query.tables ? String(req.query.tables).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const stageOverride = req.query.stages !== undefined ? new Set(String(req.query.stages).split(",").map((s) => s.trim()).filter(Boolean)) : null;
  return {
    limit: Math.min(Math.max(Number(req.query.limit) || 5, 1), 20),
    dateFormat: cfg.dateFormat === "dmy" ? "dmy" : "mdy",
    tables: tables && tables.length ? tables : null,
    stageOverride,
    tablesCfg: cfg.tables || tablesConfig(),
    labels: displayNamesMap(),
    clicks: clicksFor(String(req.query.q || "")),
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
// The first search after a boot warms the paid connections: a TLS handshake
// to the provider costs seconds the first time (a cold best match missed its
// budget, 2026-09-08), and one scan of the vectors pulls the vector file into
// the page cache (5.6 s cold, 2026-09-09). Started beside the search, once.
let warmed = false;
function warmOnFirstSearch() {
  if (warmed) return;
  warmed = true;
  if (stageReady("semantic").ready) embedQuery("mitos").then((v) => vectorSearch(v, vectorKey(), { perTable: 1 })).catch(() => {});
  for (const name of ["understand", "rerank"]) {
    if (!stageReady(name).ready) continue;
    chat({ model: stages()[name].model, system: "Reply with the single word: ok", user: "ok", maxTokens: 20, timeoutMs: 15000 }).catch(() => {});
    break;
  }
}
async function handleSearch(req, res, phase) {
  const query = undouble(req.query.q);
  if (!query) return res.status(400).json({ error: "q is required" });
  warmOnFirstSearch();
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
const REFRESHING = "Mitos is updating some records. Try again in a moment.";
app.post("/api/index/sync", (req, res) => {
  if (isRefreshing()) return res.status(409).json({ error: REFRESHING });
  if (syncJob && !syncJob.done) return res.json({ ok: true, already: true, id: syncJob.id });
  if (wiping) return res.status(409).json({ error: "A wipe is running. Try again in a moment." });
  // { rebuild: true } makes the search index again from the local copies and
  // reads nothing from FileMaker. { rebuild: true, fromScratch: true } empties
  // the index first (its search notes and vectors go too).
  const rebuild = Boolean(req.body?.rebuild);
  const job = startSyncJob({ origin: "user", full: Boolean(req.body?.full), stagesOnly: rebuild ? false : Boolean(req.body?.stagesOnly), rebuild, fromScratch: rebuild && Boolean(req.body?.fromScratch) });
  if (!job) return res.status(409).json({ error: REFRESHING });
  if (job.done) return res.status(409).json({ error: "Mitos is busy. Try again in a moment." });
  res.json({ ok: true, started: true, id: job.id, ...(rebuild ? { rebuild: true } : {}) });
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
    const semTables = semanticTables(tablesCfg);
    const est = await passEstimate(vectorKey(), enrichKeys, semTables);
    // Per table, what the index holds: rows, rows with notes, rows with a
    // current vector. The AI tab's lines ("12,400 of 30,649 records have
    // notes") come from these counts, never from the ledger.
    const held = await stageStats(vectorKey(), embedInfo().dims).catch(() => ({ tables: [], vectors: 0 }));
    const heldBy = Object.fromEntries(held.tables.map((r) => [r.src_table, { rows: Number(r.rows || 0), notes: Number(r.enriched || 0), vectors: Number(r.embedded || 0) }]));
    const embedModel = s.semantic.model;
    // Every record of the covered tables, at the average size, for the rebuild price.
    const coveredRows = held.tables.filter((r) => semTables.includes(r.src_table)).reduce((a, r) => a + Number(r.rows || 0), 0);
    const avgChars = (await sql(`SELECT avg(length(source_text) + coalesce(length(enrich_text), 0)) AS c FROM mitos_index`).catch(() => [{ c: 0 }]))[0]?.c || 0;
    const rebuildCost = embedModel ? estimateCost(embedModel, coveredRows, Number(avgChars) / 4 + 8) : 0;
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
      // `rows`/`waiting`: records that need a vector now (0 = nothing to build:
      // the switch just turns on). `totalRows`: records in the tables semantic
      // search covers. `vectors`/`vectorBytes`: what is stored now. `rebuildCost`:
      // what building every vector from nothing would cost (the switch-off warning).
      embed: { on: s.semantic.on && stageReady("semantic").ready, model: embedModel, rows: sum(embed, "waiting"), waiting: sum(embed, "waiting"), cost: sum(embed, "cost"), tables: embed,
        upToDate: sum(embed, "waiting") === 0, totalRows: coveredRows, vectors: held.vectors || 0, vectorBytes: held.vectorFileBytes || 0, rebuildCost },
      enrich: { on: s.enrich.on && stageReady("enrich").ready, model: s.enrich.model, rows: sum(enrich, "waiting"), waiting: sum(enrich, "waiting"), notes: sum(enrich, "notes"), totalRows: sum(enrich, "rows"), cost: sum(enrich, "cost"), tables: enrich },
      passes: readPasses(12),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// What the NEXT sync would also build, as the Tables form stands (`tables`,
// not saved yet) and/or with a different model (`enrichModel`, `embedModel`;
// "" = the default). A table not yet in the index counts at its scanned size.
// Body: { tables?: {raw: {semantic, enrich:{on,prompt}}}, enrichModel?, embedModel? }
app.post("/api/ai/estimate", async (req, res) => {
  try {
    const cfg = readConfig();
    const s = stages();
    const labels = displayNamesMap();
    const body = req.body || {};
    const tablesCfg = body.tables && typeof body.tables === "object" && Object.keys(body.tables).length ? body.tables : (cfg.tables || tablesConfig());
    const eModel = body.enrichModel !== undefined ? (String(body.enrichModel || "").trim() || autoModel("enrich")) : s.enrich.model;
    const mModel = body.embedModel !== undefined ? (String(body.embedModel || "").trim() || autoModel("semantic")) : s.semantic.model;
    const dims = Number(s.semantic.dims) || 256;
    const mProv = mModel ? providerOf(mModel, "embedding") : "";
    const vecKeyNow = mProv && mModel ? vectorKeyFor(mProv, modelId(mModel), dims) : "";
    const enrichKeys = {};
    for (const [name, t] of Object.entries(tablesCfg)) if (t?.enrich?.on) enrichKeys[name] = enrichKeyFor(eModel, promptFor(name, t, labels[name]));
    const semTables = Object.keys(tablesCfg).filter((n) => tablesCfg[n]?.semantic === true);
    const est = await passEstimate(vecKeyNow, enrichKeys, semTables);
    const held = await stageStats(vectorKey(), dims).catch(() => ({ tables: [] }));
    const indexed = new Set(held.tables.map((r) => r.src_table));
    const scanRows = Object.fromEntries((readScan()?.tables || []).map((t) => [t.name, Number(t.rowCount) || 0]));
    const avgChars = Number((await sql(`SELECT avg(length(source_text)) AS c FROM mitos_index`).catch(() => [{ c: 0 }]))[0]?.c) || 200;
    let nRows = 0, nCost = 0, vRows = 0, vCost = 0;
    for (const r of est.enrich) { nRows += r.rows; nCost += estimateCost(eModel, r.rows, r.chars / 4 + 60, 120); }
    for (const r of est.embed) { vRows += r.rows; vCost += estimateCost(mModel, r.rows, r.chars / 4 + 8); }
    // Ticked tables that are not in the index yet: their scanned size.
    for (const name of Object.keys(tablesCfg)) {
      if (indexed.has(name) || !scanRows[name]) continue;
      if (enrichKeys[name]) { nRows += scanRows[name]; nCost += estimateCost(eModel, scanRows[name], avgChars / 4 + 60, 120); }
      if (semTables.includes(name)) { vRows += scanRows[name]; vCost += estimateCost(mModel, scanRows[name], avgChars / 4 + 8); }
    }
    const readyFor = (model, kind) => { const p = model ? providerOf(model, kind) : ""; return Boolean(p && keyForProvider(p).key); };
    const r2 = (n) => Math.round(n * 100) / 100;
    res.json({
      notes: { rows: nRows, cost: r2(nCost), model: eModel, ready: readyFor(eModel, "chat") },
      vectors: { rows: vRows, cost: r2(vCost), model: mModel, ready: readyFor(mModel, "embedding") },
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

// Switching semantic search OFF deletes the vectors: they take room on the Fly
// volume (Matt, 2026-11-20). The stage is saved off first, then the vector file
// is removed. Turning it back on rebuilds them (the estimate says what that costs).
app.post("/api/ai/semantic/off", async (_req, res) => {
  if (syncRunning() || wiping) return res.status(409).json({ error: SYNC_BUSY });
  wiping = true;
  try {
    const cfg = readConfig();
    cfg.ai = cfg.ai || {};
    cfg.ai.stages = cfg.ai.stages || {};
    cfg.ai.stages.semantic = { ...(cfg.ai.stages.semantic || {}), on: false };
    writeConfig(cfg);
    const r = await deleteAllVectors();
    res.json({ ok: true, deleted: r.deleted, bytesFreed: r.bytesFreed });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { wiping = false; }
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
      const prompt = promptFor(table, readConfig().tables?.[table], labels[table], typeof req.body?.prompt === "string" ? req.body.prompt : undefined);
      try {
        const r = await enrichPreview({ model, prompt, rows });
        out.push({ table, label: labels[table] || table, ms: r.ms, notes: r.notes });
      } catch (e) { out.push({ table, label: labels[table] || table, error: String(e.message).slice(0, 200) }); }
    }
    res.json({ model, tables: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The per-record beacon from FileMaker (Mitos - Record Changed):
//   { "table": "<raw name or table word>", "id": "<primary key>" }
// or { table, ids: [...], deleted: [...] } or
//   { "tables": { "<raw name>": { "changed": [ids], "deleted": [ids] } } }
// It answers AT ONCE, 202 { queued: true, id }, so the person's commit never
// waits on the pull, the index step or the stages. The work runs one request
// at a time after that. Ids for a table that arrive while it is still queued
// join the same run. A request that arrives during a sync waits for the sync
// to end. What happened goes to a log (records.jsonl): GET /api/records/log.
const REC_LOG = "records.jsonl";
const RECORDS_PER_RUN = 500;
const recPending = new Map(); // table key -> { table, ids:Set, deleted:Set, reqs:Set }
let recWorking = false;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const logRecords = (entry) => { try { fs.appendFileSync(path.join(DATA_DIR, REC_LOG), JSON.stringify(entry) + "\n"); } catch {} };
// The raw table name for a name or a table word, or null.
function resolveTable(name) {
  const configured = readConfig().tables || tablesConfig();
  if (configured[name]) return name;
  const bySlug = Object.entries(slugMap()).find(([raw, slug]) => configured[raw] && slug === name);
  return bySlug ? bySlug[0] : null;
}
function queueRecords(work, reqId) {
  for (const w of work) {
    const key = resolveTable(w.table) || w.table;
    if (!recPending.has(key)) recPending.set(key, { table: key, ids: new Set(), deleted: new Set(), reqs: new Set() });
    const p = recPending.get(key);
    for (const id of w.ids) p.ids.add(id);
    for (const id of w.deleted) p.deleted.add(id);
    p.reqs.add(reqId);
  }
  recWork();
}
async function recWork() {
  if (recWorking) return;
  recWorking = true;
  try {
    while (recPending.size) {
      if (syncRunning() || wiping) { await sleepMs(1500); continue; }
      const [key, w] = recPending.entries().next().value;
      recPending.delete(key);
      const ids = [...w.ids].slice(0, RECORDS_PER_RUN), deleted = [...w.deleted].slice(0, RECORDS_PER_RUN);
      // What does not fit in one run goes back to the queue.
      const restIds = [...w.ids].slice(RECORDS_PER_RUN), restDel = [...w.deleted].slice(RECORDS_PER_RUN);
      if (restIds.length || restDel.length) { const p = { table: key, ids: new Set(restIds), deleted: new Set(restDel), reqs: new Set(w.reqs) }; recPending.set(key, p); }
      const entry = { at: new Date().toISOString(), table: key, ids: [...ids, ...deleted.filter((d) => !ids.includes(d))], updated: 0, deleted: 0, notFound: [], error: null, requests: [...w.reqs] };
      const raw = resolveTable(key);
      if (!raw) entry.error = `Mitos doesn't search a table called ${key}`;
      else {
        try {
          const r = await refreshRecords({ table: raw, ids, deleted });
          if (r.deferred) {
            // A sync began between the check and the start: wait for it.
            const p = recPending.get(key) || { table: key, ids: new Set(), deleted: new Set(), reqs: new Set() };
            for (const id of ids) p.ids.add(id);
            for (const id of deleted) p.deleted.add(id);
            for (const q of w.reqs) p.reqs.add(q);
            recPending.set(key, p);
            await sleepMs(1500);
            continue;
          }
          entry.updated = r.updated; entry.deleted = r.deleted; entry.notFound = r.notFound || [];
        } catch (e) { entry.error = String(e.message || e).slice(0, 300); }
      }
      logRecords(entry);
      if (!entry.error) forgetSearchCache();
    }
  } finally { recWorking = false; }
}
app.post("/api/records/changed", (req, res) => {
  const b = req.body || {};
  const work = [];
  const listOf = (v) => (v === undefined || v === null ? [] : [].concat(v)).map((x) => (typeof x === "number" ? String(x) : x));
  const bad = (m) => res.status(400).json({ error: m });
  if (b.tables && typeof b.tables === "object" && !Array.isArray(b.tables)) {
    for (const [table, v] of Object.entries(b.tables)) {
      if (!table.trim() || !v || typeof v !== "object") return bad(`tables.${table}: send { changed: [ids], deleted: [ids] }`);
      work.push({ table: table.trim(), ids: listOf(v.changed ?? v.ids ?? v.id), deleted: listOf(v.deleted) });
    }
  } else if (typeof b.table === "string" && b.table.trim()) {
    work.push({ table: b.table.trim(), ids: listOf(b.ids ?? b.id), deleted: listOf(b.deleted) });
  } else return bad('send { "table": "<table>", "id": "<primary key>" } (or ids / deleted lists, or { tables: { <table>: { changed, deleted } } })');
  for (const w of work) {
    if (![...w.ids, ...w.deleted].every((x) => typeof x === "string" && x.trim())) return bad(`${w.table}: ids must be non-empty text or numbers`);
    w.ids = w.ids.map((x) => x.trim()); w.deleted = w.deleted.map((x) => x.trim());
  }
  if (!work.some((w) => w.ids.length || w.deleted.length)) return bad("no record id was sent");
  const id = Math.random().toString(36).slice(2, 10);
  queueRecords(work, id);
  res.status(202).json({ queued: true, id });
});
// Newest first. { at, table, ids, updated, deleted (records removed from Mitos),
// notFound (ids FileMaker no longer has), error, requests }.
app.get("/api/records/log", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  try {
    res.json(fs.readFileSync(path.join(DATA_DIR, REC_LOG), "utf8").trim().split("\n").filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse());
  } catch { res.json([]); }
});

app.get("/api/index/status", async (_req, res) => {
  res.json({
    building: isBuilding(),
    ...VERSION,
    manifest: indexManifest(),
    stats: await indexStats().catch(() => ({ tables: [], totalRows: 0 })),
    tables: Object.keys(tablesConfig()),
    lastCrash: lastCrash(),
    flyApp: process.env.FLY_APP_NAME || null,
  });
});

// --- Danger zone ---------------------------------------------------------------
// Everything here is Mitos's own copy and settings. FileMaker is never
// touched. All of it refuses while a sync runs.
const RESET_ITEMS = ["index", "copies", "notes", "config", "keys", "logs", "sessions"];
const RESET_DEFAULT = ["index", "copies"]; // what a reset always meant
app.post("/api/reset", async (req, res) => {
  if (syncRunning() || wiping) return res.status(409).json({ error: SYNC_BUSY });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  let items = body.items;
  if (items === undefined || (Array.isArray(items) && !items.length)) items = RESET_DEFAULT;
  if (!Array.isArray(items) || !items.every((k) => typeof k === "string" && RESET_ITEMS.includes(k))) {
    return res.status(400).json({ error: `items must be a list of: ${RESET_ITEMS.join(", ")}.` });
  }
  const want = new Set(items);
  wiping = true;
  try {
    // Local data first. Index and copies together leave an empty database
    // file, which is deleted so the disk comes back.
    if (want.has("index") && want.has("copies")) await wipeAllLocalData();
    else {
      if (want.has("index")) await wipeIndex();
      if (want.has("copies")) await wipeCopies();
    }
    if (want.has("notes") && !want.has("index")) await wipeNotes();
    if (want.has("index") || want.has("copies") || want.has("notes")) { forgetSearchCache(); clearUnderstandCache(); }
    const keptOnServer = [];
    if (want.has("config")) {
      const cfg = readConfig();
      delete cfg.fm; delete cfg.tables; delete cfg.displayNames; delete cfg.savedAt;
      writeConfig(cfg);
      // What the scan, the hints and the naming cache hold is the old server's.
      for (const f of ["schema-scan.json", "schema-hints.json", "naming.json"]) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch {} }
      connGen++; scanBuild = null; scanStatus = null;
      resetConnection();
      if (fmConfigured() || process.env.FM_HOST) keptOnServer.push("config");
    }
    if (want.has("keys")) {
      const cfg = readConfig();
      if (cfg.ai) {
        for (const p of Object.values(PROVIDERS)) delete cfg.ai[p.cfgKey];
        delete cfg.ai.providers;
        writeConfig(cfg);
      }
      try { fs.unlinkSync(path.join(DATA_DIR, "models.json")); } catch {}
      if (Object.values(PROVIDERS).some((p) => process.env[p.env])) keptOnServer.push("keys");
    }
    if (want.has("logs")) {
      for (const f of ["searches.jsonl", "clicks.jsonl", "beacon.jsonl", REC_LOG]) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch {} }
      clearUnderstandCache(); // the typed searches it remembers
    }
    if (want.has("sessions")) wipeSessions(req, res);
    res.json({ ok: true, wiped: items, needsSetup: want.has("config"), keptOnServer });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally { wiping = false; }
});

// Drop Mitos's copy of one table and untick it, so the next sync does not
// bring it back. Same code as unticking the table when saving the Tables tab.
app.post("/api/tables/drop", async (req, res) => {
  const table = String(req.body?.table || "").trim();
  if (!table) return res.status(400).json({ error: "table is required" });
  if (syncRunning() || wiping) return res.status(409).json({ error: SYNC_BUSY });
  const cfg = readConfig();
  const known = Boolean(cfg.tables?.[table]) || (storeManifest().tables || []).some((t) => t.name === table);
  if (!known) return res.status(404).json({ error: "Mitos has no copy of that table." });
  wiping = true;
  try {
    await dropTableCopies([table]);
    forgetSearchCache();
    if (cfg.tables && cfg.tables[table]) { delete cfg.tables[table]; cfg.savedAt = new Date().toISOString(); writeConfig(cfg); }
    res.json({ ok: true, dropped: table });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { wiping = false; }
});

// --- The search log ----------------------------------------------------------
// Every search and every click lands on this box as JSONL. Two files, one line
// per event, append-only: cheap to write, trivial to read back, and the raw
// material for the learning loop (which queries found nothing, which result a
// person actually chose). Nothing here is sent anywhere; it is the operator's own log.
function appendLog(file, obj) {
  fs.appendFile(path.join(DATA_DIR, file), JSON.stringify(obj) + "\n", () => {});
}

// Reads the last `max` lines of a JSONL log (whole file is fine at this scale).
function readJsonl(file, max = 50000) {
  try {
    return fs.readFileSync(path.join(DATA_DIR, file), "utf8").trim().split("\n").filter(Boolean).slice(-max)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const queryKey = (q) => normalizeText(q).trim();

// Click boost (R4): for one typed query, how many times each record was clicked
// after that same query. The search uses it as a tiebreak only: it can order two
// records that score the same, never lift one above a better match. Cached by
// the file's size and time, so a search does not re-read the log.
let clickCache = { sig: "", byQuery: new Map() };
function clicksFor(query) {
  let sig = "";
  try { const st = fs.statSync(path.join(DATA_DIR, "clicks.jsonl")); sig = st.size + ":" + st.mtimeMs; } catch { return null; }
  if (sig !== clickCache.sig) {
    const byQuery = new Map();
    for (const c of readJsonl("clicks.jsonl", 20000)) {
      if (!c.table || !c.record_id) continue;
      const k = queryKey(c.query);
      if (!k) continue;
      if (!byQuery.has(k)) byQuery.set(k, new Map());
      const m = byQuery.get(k), id = `${c.table}\u0000${c.record_id}`;
      m.set(id, (m.get(id) || 0) + 1);
    }
    clickCache = { sig, byQuery };
  }
  return clickCache.byQuery.get(queryKey(query)) || null;
}

// Failed searches (R4), newest first with counts: searches that found nothing
// and, only once clicks are being recorded, searches that found something
// nobody clicked. A search the person kept typing on (the next one, seconds
// later, starts with it or is it with letters taken off) is not a failure, and
// the page's two calls per search (exact, then AI) count once.
function failedSearches() {
  const searches = readJsonl("searches.jsonl").filter((s) => !s.error && s.query && !s.stagesOverride);
  const clicks = readJsonl("clicks.jsonl", 20000);
  const clicking = clicks.length > 0;
  const quick = 20000, clickWindow = 600000;
  const by = new Map(); // key -> { query, zero, noClick, last, tables }
  for (let i = 0; i < searches.length; i++) {
    const s = searches[i], k = queryKey(s.query), t = Date.parse(s.ts);
    if (!k || !Number.isFinite(t)) continue;
    let moved = false;
    for (let j = i + 1; j < searches.length; j++) {
      const n = searches[j], tj = Date.parse(n.ts);
      if (tj - t > quick) break;
      const kj = queryKey(n.query);
      if (kj !== k && (kj.startsWith(k) || k.startsWith(kj))) { moved = true; break; }
      if (kj === k) { moved = true; break; } // the same search again a moment later: counted at its last call
    }
    if (moved) continue;
    const zero = !(s.results > 0);
    let noClick = false;
    if (!zero && clicking) noClick = !clicks.some((c) => queryKey(c.query) === k && Date.parse(c.ts) >= t - 5000 && Date.parse(c.ts) - t < clickWindow);
    if (!zero && !noClick) continue;
    const e = by.get(k) || { query: s.query, zero: 0, noClick: 0, last: s.ts };
    if (zero) e.zero++; else e.noClick++;
    if (s.ts > e.last) { e.last = s.ts; e.query = s.query; }
    by.set(k, e);
  }
  const rows = [...by.values()].sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, 200);
  return { rows, clicking, totals: { zero: rows.reduce((a, r) => a + r.zero, 0), noClick: rows.reduce((a, r) => a + r.noClick, 0) } };
}
app.get("/api/log/failed", (_req, res) => res.json(failedSearches()));

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
  if (!every || isBuilding() || wiping || !fmConfigured()) return;
  const last = indexManifest().builtAt ? Date.parse(indexManifest().builtAt) : 0;
  if (Date.now() - last < every * 60000) return;
  startSyncJob({ origin: "auto-sync" });
}
setInterval(autoSyncTick, 60000);

// --- Boot ---------------------------------------------------------------------

// One-time config move (1.2): the global Enrichment and Semantic switches are
// gone; each table holds its own. What was on stays on: a global ON becomes
// the per-table values (semantic: the table's saved switch, else the old
// default; enrichment: the table's own tick), a global OFF turns every table's
// switch off. The old global `on` flags are removed. A sample install (no
// saved tables) just loses the flags.
function migrateColumns() {
  try {
    const cfg = readConfig();
    if (cfg.columnsMigrated) return;
    const st = cfg.ai?.stages || {};
    const semG = st.semantic?.on === true, enG = st.enrich?.on === true;
    for (const [n, t] of Object.entries(cfg.tables || {})) {
      t.semantic = semG ? (typeof t.semantic === "boolean" ? t.semantic : semanticDefault(n, t)) : false;
      if (!enG && t.enrich) t.enrich = { ...t.enrich, on: false };
    }
    if (st.semantic) delete st.semantic.on;
    if (st.enrich) delete st.enrich.on;
    cfg.columnsMigrated = "1.2";
    writeConfig(cfg);
    console.log(`  config: AI switches moved to the tables (semantic was ${semG ? "on" : "off"}, enrichment ${enG ? "on" : "off"})`);
  } catch (e) { console.error("config migration:", e.message); }
}

app.listen(PORT, async () => {
  migrateColumns();
  console.log(`Mitos listening on http://localhost:${PORT}`);
  // The providers' model lists, read once when there is no cached one: which
  // provider serves a model and the default picks come from them (ai.js).
  await ensureModelList().catch((e) => console.error("model list:", e.message));
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
  // No AI calls at boot (a boot is not a request, and every deploy reboots the
  // box). The public model list is read in the background (a free GET); the
  // providers' models are warmed on the first search instead (warmOnFirstSearch).
  refreshCurated().catch(() => {});
});
