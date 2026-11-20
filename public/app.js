// app.js: the Mitos page. Split out of index.html so the markup paints
// before this file arrives (a card window is not white while it loads).

const $ = (id) => document.getElementById(id);
let timer = null, lastQuery = "";

// The ONE door for API JSON (navarre-core ui/web-viewer.md): in a FileMaker
// web viewer (WebKit), res.json() on a non-JSON body throws "The string did
// not match the expected pattern." Read text, parse ourselves, retry briefly
// across a server restart, and say something true.
async function apiJson(path, opts, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(path, opts);
      // Any 401 means signed out: go to the sign-in page before reading the body.
      if (r.status === 401) {
        location.href = "/signin?next=" + encodeURIComponent(location.pathname + location.search);
        throw Object.assign(new Error("Not signed in."), { noRetry: true });
      }
      const txt = await r.text();
      try { return JSON.parse(txt); }
      catch { throw new Error("Mitos restarted or the connection dropped mid-request."); }
    } catch (e) {
      last = e;
      if (e.noRetry || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}
const postJson = (path, body) => apiJson(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---- Search page --------------------------------------------------------------
// ?q=... runs a search on load; ?embed=1 shows results only. This is how a
// FileMaker script drives Mitos from a native global field: build the URL,
// open a card window, point its web viewer here.
const urlParams = new URLSearchParams(location.search);
if (urlParams.get("embed") === "1") document.body.classList.add("embed");

// Two phases. Phase 1 (exact and fuzzy) fires 200 ms after the last
// keystroke and lands in tens of milliseconds. Phase 2 (the AI stages) is
// asked for only once the words have stood still a moment longer, and its
// answer is dropped if the words changed meanwhile. The FileMaker card
// window (?embed=1) does the same with its ?q=.
const urlTables = urlParams.get("tables") ? "&tables=" + encodeURIComponent(urlParams.get("tables")) : "";
// A FileMaker web viewer hands an arrow key to the field as a private-use
// character (U+F700 and friends) instead of moving the caret. Only normal
// text stays in the field.
const JUNK = /[\x00-\x1f\x7f-\x9f\ue000-\uf8ff]/g;
$("q").addEventListener("input", () => {
  if (JUNK.test($("q").value)) { const pos = $("q").selectionStart; $("q").value = $("q").value.replace(JUNK, ""); try { $("q").setSelectionRange(Math.max(0, pos - 1), Math.max(0, pos - 1)); } catch {} }
  clearTimeout(timer); clearTimeout(aiTimer); if ($("q").value.trim().length < 2 && $("q").value.trim().length) return; timer = setTimeout(run, 200);
});
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); run({ aiNow: true }); } });
let aiTimer = null, aiAbort = null, inFlight = null, aiNowFlag = false, renderedQuery = "", renderedPending = false;

async function run(opts = {}) {
  const query = $("q").value.trim();
  lastQuery = query;
  // Enter while the same words are already on their way: no second phase 1,
  // just ask for the AI phase as soon as it lands.
  if (inFlight === query) { if (opts.aiNow) aiNowFlag = true; return; }
  // Return on words already searched: straight to the AI phase, no second
  // exact search.
  if (opts.aiNow && renderedQuery === query && renderedPending) { runAi(query); return; }
  if (aiAbort) { aiAbort.abort(); aiAbort = null; }
  if (!query) { $("results").innerHTML = ""; $("meta").textContent = ""; $("expanded").style.display = "none"; return; }
  $("meta").textContent = "searching...";
  inFlight = query; aiNowFlag = Boolean(opts.aiNow);
  try {
    const data = await apiJson("/api/search?q=" + encodeURIComponent(query) + urlTables);
    if (query !== lastQuery) return; // stale response
    if (data.error) { $("meta").textContent = data.error; return; }
    render(data);
    renderedQuery = query; renderedPending = Boolean(data.stages?.pending?.length);
    // No model call while a person types (Matt, 2026-09-10). The exact list
    // follows every keystroke; the AI phase waits for Return.
    if (renderedPending) {
      if (aiNowFlag) runAi(query);
      else $("meta").textContent += " · press return for the AI search";
    }
  } catch (e) {
    $("meta").textContent = "search failed: " + e.message;
  } finally { if (inFlight === query) inFlight = null; }
}
async function runAi(query) {
  if (query !== lastQuery) return;
  const ctrl = new AbortController(); aiAbort = ctrl;
  const m = $("meta");
  const think = document.createElement("span"); think.className = "think"; think.textContent = " · thinking...";
  m.appendChild(think);
  try {
    const data = await apiJson("/api/search/ai?q=" + encodeURIComponent(query) + urlTables, { signal: ctrl.signal }, 1);
    if (query !== lastQuery || ctrl.signal.aborted) return;
    if (data.error) { think.textContent = " · " + data.error; return; }
    render(data, { ai: true });
  } catch (e) {
    if (ctrl.signal.aborted) return;
    think.textContent = " · AI stages failed: " + e.message;
  } finally { if (aiAbort === ctrl) aiAbort = null; }
}

// FileMaker navigation. Inside a web viewer, window.FileMaker exists and
// FileMaker.PerformScript(name, parameter) runs a script in the file (the web
// viewer must have "Allow JavaScript to perform FileMaker scripts" checked).
// Outside one - a plain browser - there is nothing to navigate, so the click
// is logged and the row says so instead of failing silently.
// Verified against Claris Pro Help "Scripting with JavaScript in web viewers".
const inFileMaker = () => typeof window.FileMaker !== "undefined" && typeof window.FileMaker.PerformScript === "function";
// The FileMaker contract, set by the script in the file:
//   script: Mitos Go To Record
//   parameter: { "id": <primary key>, "table": <the lowercase word set per table in Settings, e.g. "organization">,
//                "raw": <the raw table name>, "search": <typed query> }
// Key names match the script's JSONGetElement calls. Do not rename them here
// without renaming them there.
// The kit file ships the script as "Mitos - Go To Record". The name is the
// one hard link between Mitos and the file: keep both the same.
const FM_SCRIPT = "Mitos - Go To Record";

function goToFileMaker(payload, script) {
  if (!inFileMaker()) return false;
  try { window.FileMaker.PerformScript(script, JSON.stringify(payload)); return true; }
  catch { return false; }
}

function render(data, opts = {}) {
  $("expanded").style.display = "none";
  if (data.empty) {
    $("results").innerHTML = "";
    $("meta").textContent = "";
    showFirstRun(true);
    return;
  }
  const t = data.timings;
  const nSim = (data.similarMerged || []).length;
  // Say how the input was read only when it is not obvious: a date range, a
  // number range, an email, a phone. Plain words are plain words. When the
  // AI read the words into something else, say that instead.
  const how = data.reading ? " · read as: " + data.reading : (data.searched && data.kind !== "text" ? " · " + data.searched : "");
  const n = data.merged.length;
  $("meta").textContent = (n ? n + " result" + (n === 1 ? "" : "s") : "No exact match") + how +
    (nSim ? " · " + nSim + " semantic" : "") + " (" + t.totalMs + "ms)";
  const frag = document.createDocumentFragment();
  const allRows = [...data.merged, ...(data.similarMerged || [])];
  const rankOf = (table, id) => allRows.findIndex((m) => m.table === table && m.id === id) + 1;
  // Relative quality, at the right of each row. An exact row is measured
  // against the strongest exact row of this search (the top one is 100%); a
  // close spelling or a semantic row shows its own similarity, never 100%.
  const topExact = Math.max(0, ...allRows.filter((m) => m.via === "exact").map((m) => Number(m.score) || 0));
  const pctOf = (res) => {
    const sc = Number(res.score) || 0;
    if (res.via === "exact") return topExact > 0 ? Math.max(1, Math.round((100 * sc) / topExact)) : 100;
    return Math.max(1, Math.min(99, Math.round(100 * (res.sim ?? sc))));
  };
  const makeRow = (g, res, extra = {}) => {
    const fields = Object.entries(res.display);
    const row = el("div", "row" + (extra.best ? " best" : ""));
    const main = el("div", "main");
    if (extra.best) {
      const b = el("div", "bestlbl"); b.textContent = "Best match";
      // Who picked it: the plain rule says nothing, the model says so.
      if (data.best?.by === "rerank") { const by = el("span", "tagv"); by.textContent = "picked by AI"; b.appendChild(by); }
      main.appendChild(b);
    }
    const title = el("div", "title");
    title.textContent = String(fields[0]?.[1] ?? res.id);
    // A row from the fuzzy or semantic stage says so, in two words, so a
    // person knows it is not what they typed.
    if (res.via === "fuzzy") { const tg = el("span", "tagv"); tg.textContent = "close spelling"; title.appendChild(tg); }
    else if (res.via === "semantic") { const tg = el("span", "tagv"); tg.textContent = "semantic"; title.appendChild(tg); }
    const sub = el("div", "sub");
    sub.textContent = fields.slice(1).map(([k, v]) => v).filter(Boolean).join(" · ");
    main.appendChild(title); main.appendChild(sub);
    // No reason line under any row, the best match included: the reason stays
    // in the API (`why`) and the search log; the row does not explain itself.
    row.appendChild(main);
    const pc = el("div", "pct"); pc.textContent = pctOf(res) + "%"; row.appendChild(pc);
    const rank = rankOf(g.table, res.id);
    row.addEventListener("click", () => {
      postJson("/api/click", { query: data.query, table: g.table, record_id: res.id, rank, score: res.score, via: res.via, best: Boolean(extra.best) }).catch(() => {});
      row.style.borderColor = "var(--accent)";
      if (!goToFileMaker({ id: res.id, table: g.slug || g.table, raw: g.table, search: data.query }, FM_SCRIPT)) {
        $("meta").textContent = "Open this record from a FileMaker web viewer to jump to it (" + g.table + " · " + res.id + ")";
      }
    });
    return row;
  };
  // One clear answer sits on top, once, and is not repeated below.
  const best = data.best && allRows.find((m) => m.table === data.best.table && m.id === data.best.id);
  if (best) {
    const g = [...data.groups, ...(data.similar || [])].find((x) => x.table === best.table);
    const div = el("div", "group");
    div.appendChild(makeRow(g || { table: best.table }, best, { best: true }));
    frag.appendChild(div);
  }
  const renderGroups = (groups) => {
    for (const g of groups) {
      const results = g.results.filter((r) => !(best && best.table === g.table && best.id === r.id));
      if (!results.length) continue;
      const div = el("div", "group");
      const h = document.createElement("h2");
      h.textContent = g.label || friendly(g.table);
      div.appendChild(h);
      for (const res of results) div.appendChild(makeRow(g, res));
      frag.appendChild(div);
    }
  };
  renderGroups(data.groups);
  if (nSim) {
    // Strong matches are "Semantic matches"; when even the best is weak the
    // heading says so, and the rows still show (nearest, not near).
    const h = el("div", "simhead"); h.textContent = data.similarWeak ? "Perhaps you meant" : "Semantic matches";
    frag.appendChild(h);
    renderGroups(data.similar || []);
  }
  $("results").innerHTML = "";
  $("results").appendChild(frag);
}

// The first-run card: an empty index is a setup state, not a search with no
// results, so it gets its own words and its own button.
function showFirstRun(on) { $("firstRun").style.display = on ? "" : "none"; }
$("firstRunSetup").addEventListener("click", () => openWizard(true));
$("firstRunSample").addEventListener("click", () => runSync(null, { sample: true }));

let flyApp = null; // FLY_APP_NAME, when Mitos runs on Fly (GET /api/index/status)
async function refreshStatus() {
  try {
    const s = await apiJson("/api/index/status");
    flyApp = s.flyApp || null;
    $("dzDeleteRow").style.display = flyApp ? "" : "none";
    if (s.version) $("buildVer").textContent = "v" + s.version + (s.built ? " · " + s.built : "");
    const rows = s.stats.totalRows || 0;
    showFirstRun(!rows && !s.building);
    // Sample data is the no-FileMaker path: offer it only when no server is set.
    if (!rows && !s.building) {
      const fmOn = Boolean(cfg?.fmConfigured);
      $("firstRunSample").style.display = fmOn ? "none" : "";
      $("firstRunText").textContent = fmOn ? "Pick the tables to search in Settings, then sync." : "Connect your FileMaker server, pick the tables to search, and sync. Or try the bundled sample data.";
    }
    setSyncButtons(Boolean(s.building));
    $("statusText").textContent = s.building
      ? "building index..."
      : rows
        ? rows.toLocaleString() + " records indexed across " + (s.stats.tables?.length || 0) + " table" + (s.stats.tables?.length === 1 ? "" : "s") + (s.manifest.builtAt ? " (built " + s.manifest.builtAt.slice(0, 16).replace("T", " ") + ")" : "")
        : "nothing indexed yet";
  } catch { $("statusText").textContent = "server unreachable"; }
}


// ---- Settings state -----------------------------------------------------------
let cfg = null;          // last /api/config
let scannedTables = null; // last /api/fm/tables
let loadedFm = { host: "", db: "", user: "", hasPass: false };
let hasKeyNow = false;
let syncedSet = new Set(); // tables in the index right now (removal candidates)
const postJsonQuiet = (path, body) => postJson(path, body).catch(() => null);

// One sync at a time, and the buttons say so (Pythia's syncBtn gate).
function setSyncButtons(running) {
  for (const id of ["syncBtn"]) {
    const b = $(id); if (!b) continue;
    b.disabled = running;
    if (running) { b.dataset.label = b.dataset.label || b.innerHTML; b.textContent = "Syncing..."; }
    else if (b.dataset.label) b.innerHTML = b.dataset.label;
  }
}

// ---- Sync: confirm first, then a modal that watches a server-side job --------
// The job lives on the server; this window only WATCHES it. Reloading the page
// mid-sync re-attaches. Cancel asks the server to stop now.
// Before anything is saved: what will sync, what goes away with its local copy,
// and which table re-reads because its fields changed. OK saves, then syncs;
// Cancel leaves the form as it is and saves nothing.
const byFriendly = (a, b) => friendly(a).localeCompare(friendly(b));
const sameSet = (a, b) => { const x = new Set(a || []), y = new Set(b || []); return x.size === y.size && [...x].every((v) => y.has(v)); };
// Tables whose searched or shown fields differ from what is saved: a field
// change re-reads the whole table at the next sync. The count is the scan's.
function fieldChanges(tables) {
  const out = [];
  for (const [raw, t] of Object.entries(tables || {})) {
    const old = cfg?.tables?.[raw];
    if (!old) continue;
    if (sameSet(old.textFields, t.textFields) && sameSet(old.displayFields, t.displayFields)) continue;
    const rows = (scannedTables?.tables || []).find((x) => x.name === raw)?.rowCount;
    out.push({ raw, rows: rows == null ? null : Number(rows) });
  }
  return out.sort((a, b) => byFriendly(a.raw, b.raw));
}
const nameList = (arr) => arr.length < 3 ? arr.join(" and ") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
function confirmSyncSave(tables) {
  const inc = Object.keys(tables || {}).sort(byFriendly);
  const before = new Set([...Object.keys(cfg?.tables || {}), ...syncedSet]);
  const drops = [...before].filter((n) => !inc.includes(n)).sort(byFriendly);
  const changes = fieldChanges(tables);
  // Two different tables can carry the same display name. When a label is
  // ambiguous, show the real key so the two are visibly different.
  const seen = {};
  for (const n of [...inc, ...drops]) (seen[friendly(n)] ||= new Set()).add(n);
  const label = (n) => seen[friendly(n)].size > 1 ? `${friendly(n)}  (${n})` : friendly(n);
  const li = (arr) => arr.map((n) => `<div style="padding:2px 0 2px 8px">&bull; ${esc(label(n))}</div>`).join("");
  const syncWords = inc.length === 1 ? "this table" : `these ${inc.length} tables`;
  const question = `Sync ${syncWords}` + (drops.length ? ` and remove ${drops.length > 3 ? drops.length + " tables" : nameList(drops.map(friendly))} from Mitos` : "") + "?";
  $("syncConfirmOverlay").querySelector(".p-head strong").textContent = "Ready to sync";
  $("syncConfirmBody").innerHTML =
    `<div style="font-weight:600;margin-bottom:8px">${esc(question)}</div>` +
    `<div><strong>${inc.length}</strong> table${inc.length === 1 ? "" : "s"} will sync from FileMaker:</div>${li(inc)}` +
    (drops.length
      ? `<div style="margin-top:10px;color:var(--warn)"><strong>${drops.length}</strong> will be removed from Mitos, local copy included (your FileMaker data is untouched):</div>${li(drops)}`
      : "") +
    changes.map((c) => `<div style="margin-top:10px;color:var(--warn)">Changing fields re-reads all ${c.rows == null ? "" : esc(c.rows.toLocaleString()) + " "}${esc(friendly(c.raw))} records.</div>`).join("");
  $("syncConfirmOverlay").classList.add("open");
  $("syncConfirmCancel").textContent = "Cancel";
  $("syncConfirmGo").textContent = "OK";
  $("syncConfirmLater").style.display = "none";
  return new Promise((resolve) => {
    $("syncConfirmCancel").onclick = () => { $("syncConfirmOverlay").classList.remove("open"); resolve(false); };
    $("syncConfirmGo").onclick = () => { $("syncConfirmOverlay").classList.remove("open"); resolve(true); };
  });
}
function setSub(t, rot) {
  const su = $("syncSub");
  su.classList.toggle("rot", Boolean(rot));
  su.textContent = String(t || "").replace(/[.…]+\s*$/, "");
}
function setLogOpen(on) {
  const t = $("syncLogToggle"), L = $("syncLog");
  t.classList.toggle("open", Boolean(on));
  L.style.display = on ? "" : "none";
  if (on) L.scrollTop = L.scrollHeight;
}
$("syncLogToggle").onclick = () => setLogOpen(!$("syncLogToggle").classList.contains("open"));
const nowState = { table: "", status: "", prog: "" };
function paintNow(patch) {
  Object.assign(nowState, patch || {});
  $("syncNowTable").textContent = nowState.table;
  $("syncNowStatus").textContent = nowState.status;
  $("syncNowProg").textContent = nowState.prog;
  paintStrip();
}
function setNowLine(msg, cls) {
  const s = $("syncNowLine");
  s.className = "sn-line " + (cls || "");
  s.textContent = msg; s.title = msg;
}

// ---- The strip: a sync is the server's job and goes on when its window is
// closed. A thin line across the top says how far it got, then that it
// finished (or failed, in plain words), with a link to open the log.
const syncStrip = { state: "idle", stopping: false, counts: () => ({ done: 0, total: 0 }), finTitle: "", finSub: "" };
function paintStrip() {
  const strip = $("syncStrip"); if (!strip) return;
  const open = $("syncOverlay").classList.contains("open");
  const st = syncStrip.state;
  const show = st !== "idle" && !open && !document.body.classList.contains("embed");
  strip.classList.toggle("on", show);
  strip.classList.toggle("ok", st === "ok"); strip.classList.toggle("bad", st === "bad");
  document.body.classList.toggle("has-strip", show);
  if (!show) return;
  let line;
  if (st === "running") {
    const { done, total } = syncStrip.counts();
    line = syncStrip.stopping ? "Stopping the sync" : "Syncing" + (nowState.table ? " · " + nowState.table : "") + (nowState.status === "checking deletions" ? " · checking deletions" : "") + (nowState.prog ? " · " + nowState.prog : "") + (total ? " · " + done + " of " + total + " tables" : "");
  } else line = syncStrip.finTitle + (syncStrip.finSub ? " · " + syncStrip.finSub : "");
  $("syncStripText").textContent = line; strip.title = line;
  $("syncStripLink").textContent = st === "running" ? "Watch" : wiz.finishing && st === "ok" ? "Finish setup" : "Open the log";
  $("syncStripOk").style.display = st === "running" ? "none" : "";
  $("syncStripFill").style.width = st === "running" ? $("syncOverall").style.width || "0%" : "0%";
}
function openSyncWindow(withLog) {
  syncStrip.state = syncStrip.state === "running" ? "running" : "idle";
  $("syncOverlay").classList.add("open");
  if (withLog) setLogOpen(true);
  paintStrip();
}
$("syncStrip").addEventListener("click", (e) => { if (e.target.id === "syncStripOk") return; openSyncWindow(syncStrip.state !== "running"); });
$("syncStripOk").addEventListener("click", (e) => { e.stopPropagation(); syncStrip.state = "idle"; paintStrip(); });
$("syncKeepWorking").addEventListener("click", () => { $("syncOverlay").classList.remove("open"); $("q").focus(); });
new MutationObserver(paintStrip).observe($("syncOverlay"), { attributes: true, attributeFilter: ["class"] });

// The modal opens FIRST; the stream connects once the job exists.
async function runSync(tables, opts = {}) {
  const w = attachSync(tables, { deferConnect: true });
  w.log("Contacting the server...");
  if (opts.dropped?.length) w.log("Removed the local copy of: " + opts.dropped.map(fname2).join(", "));
  try {
    // A Run from the AI tab is the paid phase alone: no pull, no index step.
    const r = await postJson("/api/index/sync", { ...(opts.full ? { full: true } : {}), ...(opts.stagesOnly ? { stagesOnly: true } : {}), ...(opts.rebuild ? { rebuild: true } : {}) });
    if (r.error) { w.log("Could not start the sync: " + r.error, "warn"); finishAvailable(); return; }
    if (r.already) w.log("A sync is already running; watching it.");
  } catch (e) { w.log("Could not start the sync: " + (e.message || e), "warn"); finishAvailable(); return; }
  w.connect(-1);
}
function finishAvailable() {
  syncStrip.state = "idle"; paintStrip(); setSyncButtons(false);
  $("syncBackgroundNote").style.display = "none"; $("syncSpin").style.display = "none";
  const cbtn = $("syncCancel"); cbtn.textContent = "Close"; cbtn.disabled = false; cbtn.onclick = () => $("syncOverlay").classList.remove("open");
}
let currentSync = null;
// tables may be null when re-attaching after a reload: the buffered start
// event carries the list, so the display rebuilds itself from the replay.
function attachSync(tables, opts = {}) {
  if (currentSync) currentSync.teardown();
  $("settings").classList.remove("open");
  $("syncOverlay").classList.add("open");
  setSyncButtons(true);
  syncStrip.state = "running"; syncStrip.stopping = false;
  $("syncBackgroundNote").style.display = "";
  $("syncTitle").style.display = "none";
  $("syncDone").style.display = "none";
  $("syncActions").style.display = "none";
  const cbtn = $("syncCancel");
  cbtn.style.display = ""; cbtn.disabled = false; cbtn.textContent = "Cancel sync";
  cbtn.onclick = async () => {
    cbtn.disabled = true; cbtn.textContent = "Stopping...";
    try { await fetch("/api/index/cancel", { method: "POST" }); } catch {}
  };
  $("syncRetry").textContent = "Try again";
  $("syncRetry").onclick = () => { $("syncOverlay").classList.remove("open"); runSync(null); };
  $("syncToSettings").onclick = () => { $("syncOverlay").classList.remove("open"); openSettings(); };
  // The subtitle rotates slowly while the work runs; real states own it.
  const ROT = [
    "Reading your schema...", "Politely asking FileMaker for another 500 records...",
    "Reading, reading, reading...", "Normalizing text, so Navarré finds navarre...",
    "Building the typed columns: numbers, dates, emails, phones...",
    "Big tables take the longest. This is one.", "Short wait now, instant search real soon...",
    "Asking OData nicely. It is thinking about it.",
    "Counting records. Twice, to be sure.",
    "Lowercasing everything. Case is not a clue.",
    "Stripping accents, so café and cafe are the same word.",
    "Reading phone numbers. Ignoring the dashes, dots and brackets.",
    "Dates go in as dates. Not as text that looks like a date.",
    "Emails go in whole, and split, so a domain search works.",
    "Nothing is written back to FileMaker. Not one field.",
    "The index lives here. Your data stays there.",
    "Skipping empty fields. Nobody searches for nothing.",
    "Container fields stay home. Search does not need the photo.",
    "Summary fields are skipped. They summarize, they do not identify.",
    "This is the slow part. Search is the fast part.",
    "Another page of 500. FileMaker is being very patient.",
    "Records with no key are skipped. A click has to land somewhere.",
    "Global fields have one value. Not worth a column.",
    "Unstored calcs are read once, here, then never again.",
    "Modification timestamps are the trick. Next sync reads only what changed.",
    "The first sync reads everything. The next one reads almost nothing.",
    "Still faster than a Find in a 40-field layout.",
    "Building the typed index. Exact search first, always.",
    "Did you know? Mitos is Greek for thread. Ariadne's thread led Theseus out of the labyrinth. This one leads to the record.",
    "Did you know? Pythia, Mitos's sister app, is named for the oracle at Delphi.",
    "Did you know? Hecate, another sister app, is the goddess of keys and crossroads.",
    "Did you know? Clio, another sister app, is the muse of history.",
    "A coffee takes about this long. Coincidence.",
    "The progress bar is honest. Mostly.",
    "Nearly. Or not. The bar knows better than this line.",
  ];
  let subLocked = false, lastRot = "";
  const rotPick = () => { let l; do { l = ROT[Math.floor(Math.random() * ROT.length)]; } while (l === lastRot && ROT.length > 1); return (lastRot = l); };
  $("syncSpin").style.display = "";
  let saidHalf = false, saidAlmost = false;
  const rotTimer = setInterval(() => {
    if (subLocked || !$("syncOverlay").classList.contains("open")) return;
    const frac = total ? done / total : 0;
    if (!saidHalf && frac >= 0.5 && frac < 0.85) { saidHalf = true; setSub("Halfway there", true); return; }
    if (!saidAlmost && frac >= 0.85) { saidAlmost = true; setSub("Almost done", true); return; }
    setSub(rotPick(), true);
  }, 8000);
  setSub("Pulling fresh data from FileMaker");
  $("syncOverall").style.width = "0%";
  $("syncEll").classList.add("ell");
  $("syncTables").innerHTML = "";
  paintNow({ table: "", status: "", prog: "" }); setNowLine("");
  setLogOpen(false);
  const rows = {};
  let total = (tables || []).length, done = 0, sumChanged = 0, sumTotal = 0, failCount = 0, syncFinished = false;
  // A table finishes once: count NAMES, not events (replays hit twice).
  const doneNames = new Set();
  const dupTables = new Set(); // tables FileMaker still holds repeated IDs for
  syncStrip.counts = () => ({ done, total });
  const markDone = (n) => { if (doneNames.has(n)) return false; doneNames.add(n); done = doneNames.size; return true; };
  let lastSeq = -1;
  // Finished rows fold into one line at the top; active and waiting stay below.
  const dh = el("div", "sync-done-h"); dh.innerHTML = `<span class="dt">&#9656;</span><span class="txt"></span>`; dh.style.display = "none";
  const dbody = el("div", "sync-done-b");
  dh.onclick = () => dh.classList.toggle("open");
  $("syncTables").append(dh, dbody);
  let folded = 0, foldedRows = 0;
  const foldDone = (r, rowsN) => {
    if (r.folded) return;
    r.folded = true; folded++; foldedRows += Number(rowsN || 0);
    dbody.appendChild(r.el);
    dh.style.display = "";
    dh.querySelector(".txt").textContent = `${folded} table${folded === 1 ? "" : "s"} done · ${Number(foldedRows).toLocaleString()} records`;
  };
  const rowFor = (name, label) => {
    if (rows[name]) { if (label) { rows[name].nm.textContent = label; } return rows[name]; }
    const r = el("div", "sync-t");
    const fn = label || friendly(name);
    r.innerHTML = `<div class="nm" title="${esc(fn)}${fn !== name ? " (" + esc(name) + ")" : ""}">${esc(fn)}</div><div class="track"><div></div></div><div class="st">waiting</div>`;
    $("syncTables").appendChild(r);
    return (rows[name] = { el: r, nm: r.querySelector(".nm"), bar: r.querySelector(".track > div"), st: r.querySelector(".st"), expected: null });
  };
  // The list shows at once, from the set the caller was given (the saved
  // tables); the server's start event then fills in counts and names.
  for (const t of tables || []) rowFor(t);
  $("syncLog").innerHTML = "";
  const logLine = (msg, cls) => {
    const L = $("syncLog");
    const stick = L.scrollTop + L.clientHeight >= L.scrollHeight - 8;
    const d = el("div", cls || "");
    d.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span>${esc(msg)}`;
    L.appendChild(d);
    while (L.childNodes.length > 800) L.removeChild(L.firstChild);
    if (stick) L.scrollTop = L.scrollHeight;
    setNowLine(msg, cls);
    if (cls === "warn") setLogOpen(true);
  };
  const num = (n) => Number(n || 0).toLocaleString();
  const fmtDur = (ms) => { const s = Math.round((ms || 0) / 1000); return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m"; };
  // The paid phase (Enrichment, or Semantic search vectors) takes the panel.
  // The stages as a whole are weighed by pending records: what earlier
  // passes finished plus the pass under way, so the bar never falls back
  // when the next pass starts.
  let phase = null, plan = null, stagesOnly = false, endLine = "";
  const stageSum = { done: 0, total: 0 };
  const phaseStart = (name, total, table) => {
    phase = { name, total: Number(total) || 0, table, done: 0 };
    subLocked = true;
    setSub(name === "enrich" ? "Enrichment" : "Semantic search: building vectors");
    paintNow({ table: name === "enrich" ? "Enrichment: " + friendly(table) : "Semantic search", status: "0%", prog: "0 / " + num(total) });
    if (Object.keys(rows).length) dh.querySelector(".txt").textContent = `${folded} table${folded === 1 ? "" : "s"} read and indexed · ${num(foldedRows)} records`;
    overall();
  };
  const phaseProgress = (d, t, ms, cost, failed, table) => {
    if (!phase) return;
    phase.done = Number(d) || 0; phase.total = Number(t) || phase.total;
    const frac = phase.total ? phase.done / phase.total : 0;
    const left = phase.done && ms ? (ms / phase.done) * (phase.total - phase.done) : 0;
    paintNow({
      table: phase.name === "enrich" ? "Enrichment: " + friendly(table || phase.table) : "Semantic search",
      status: Math.round(frac * 100) + "% · " + fmtDur(ms) + (left ? " · about " + fmtDur(left) + " left" : "") + (cost ? " · " + money(cost) + " so far" : ""),
      prog: num(phase.done) + " / " + num(phase.total) + (failed ? " (" + num(failed) + " failed)" : ""),
    });
    overall();
  };
  const phaseEnd = (doneN) => {
    if (phase) { stageSum.done += Number(doneN ?? phase.done) || 0; stageSum.total += phase.total; }
    phase = null;
    overall();
  };
  // The main bar. With a plan (shares per phase) and expected counts, the
  // pull is weighed by rows read of rows expected per table, the index step
  // by its batches per table, the stages by their records. Without them,
  // tables count as before. 99 at most until the server says done.
  const stageFrac = () => {
    const d = stageSum.done + (phase ? phase.done : 0), t = stageSum.total + (phase ? phase.total : 0);
    return t ? Math.min(1, d / t) : 0;
  };
  const overall = () => {
    let frac;
    const list = Object.values(rows).filter((x) => !x.el.classList.contains("dropped"));
    const expSum = list.reduce((a, x) => a + (Number(x.expected) || 0), 0);
    if (stagesOnly || (!list.length && phase)) frac = stageFrac();
    else if (plan && expSum > 0) {
      const mean = expSum / Math.max(1, list.filter((x) => Number(x.expected) > 0).length);
      const w = (x) => Number(x.expected) > 0 ? Number(x.expected) : mean;
      const wSum = list.reduce((a, x) => a + w(x), 0) || 1;
      const pull = list.reduce((a, x) => a + w(x) * (x.pullDone ? 1 : Number(x.expected) > 0 ? Math.min(1, (x.pullRows || 0) / Number(x.expected)) : 0), 0) / wSum;
      const index = list.reduce((a, x) => a + w(x) * (x.indexed ? 1 : x.indexTotal ? Math.min(1, (x.indexDone || 0) / x.indexTotal) : 0), 0) / wSum;
      frac = (Number(plan.pullShare) || 0) * pull + (Number(plan.indexShare) || 0) * index + (Number(plan.stagesShare) || 0) * stageFrac();
    } else {
      const inFlight = list.reduce((a, x) => a + (x.el.classList.contains("done") ? 0 : (x.frac || 0)), 0);
      frac = (done + inFlight) / Math.max(1, total);
      if (phase) frac = stageFrac();
    }
    $("syncOverall").style.width = Math.min(99, Math.round(frac * 100)) + "%";
    paintStrip();
  };
  // The one end line, from the server's summary when it sends one.
  const summaryLine = (s) => {
    const parts = [];
    const changed = Number(s.pulledChanged) || 0, unchanged = Number(s.unchanged) || 0;
    // A Run from the AI tab pulls nothing, so it says nothing about the pull.
    if (stagesOnly) { /* stages only */ }
    else if (!changed) parts.push("nothing new from FileMaker" + (unchanged ? " · " + num(unchanged) + " unchanged" : ""));
    else parts.push(num(changed) + " record" + (changed === 1 ? "" : "s") + " changed" + (unchanged ? " · " + num(unchanged) + " unchanged" : ""));
    if (Number(s.vectorsBuilt)) parts.push(num(s.vectorsBuilt) + " vector" + (Number(s.vectorsBuilt) === 1 ? "" : "s") + " built");
    if (Number(s.vectorsWaiting)) parts.push(num(s.vectorsWaiting) + " waiting for Run");
    if (Number(s.notesWritten)) parts.push(num(s.notesWritten) + " note" + (Number(s.notesWritten) === 1 ? "" : "s") + " written");
    if (Number(s.notesWaiting)) parts.push(num(s.notesWaiting) + " notes waiting for Run");
    for (const t of s.stopped || []) if (t) parts.push(String(t).replace(/[.\s]+$/, ""));
    if (!parts.length) parts.push("nothing to do");
    return parts.join(" · ");
  };
  let es = null;
  const connect = (since) => {
    es = new EventSource("/api/index/stream?since=" + since);
    es.onmessage = onMessage;
    es.onerror = onError;
  };
  const onMessage = (e) => {
    const ev = JSON.parse(e.data);
    if (typeof ev.seq === "number") lastSeq = ev.seq;
    const lbl = ev.label;
    switch (ev.type) {
      case "hello": break;
      case "start": {
        total = (ev.tables || []).length;
        plan = ev.plan && typeof ev.plan === "object" ? ev.plan : null;
        stagesOnly = Boolean(ev.stagesOnly);
        for (const t of ev.tables || []) {
          if (typeof t === "string") rowFor(t);
          else { if (t.label) displayNames[t.name] = t.label; const r = rowFor(t.name, t.label); r.expected = t.expected || null; }
        }
        logLine(stagesOnly ? "Run: the AI stages only, no pull, no index step" : "Sync plan: " + total + " table" + (total === 1 ? "" : "s"));
        setSub(stagesOnly ? "Starting the AI stages" : "Pulling fresh data from FileMaker");
        break;
      }
      case "phase":
        if (ev.phase === "schema") { logLine("Reading the FileMaker schema over OData..."); setSub("Reading the FileMaker schema"); }
        else if (ev.phase === "rebuild") { logLine("Rebuilding the search index from the local copies. Nothing is read from FileMaker."); setSub("Rebuilding the search index"); }
        break;
      // The optional stages after the index: search notes and vectors. They
      // report on the now-line and in the log; the table rows are done.
      // A paid phase owns the bar once it starts: the sync's tables are
      // read and indexed, and the bar now says how far the phase is, with
      // elapsed, remaining and spend, so 100% never sits above a running job.
      case "enrich-start": phaseStart("enrich", ev.pending, ev.table); logLine("Enrichment: " + fname2(ev.table) + ", " + num(ev.pending) + " records with " + ev.model); break;
      case "enrich-progress": phaseProgress(ev.done, ev.total, ev.ms, ev.cost, ev.failed, ev.table); break;
      case "enrich-done": phaseEnd(ev.done); logLine("Enrichment: " + fname2(ev.table) + ", " + num(ev.done) + " enriched" + (ev.failed ? ", " + num(ev.failed) + " failed" : "") + (ev.pending ? ", " + num(ev.pending) + " waiting for Run" : "") + " (" + fmtDur(ev.ms) + (ev.cost ? ", " + aboutMoney(ev.cost) : "") + ")", ev.failed && !ev.done ? "warn" : "ok"); break;
      case "embed-start": phaseStart("embed", ev.pending, null); logLine("Semantic search: embedding " + num(ev.pending) + " records with " + ev.model + " (" + ev.provider + ")"); break;
      case "embed-progress": phaseProgress(ev.done, ev.total, ev.ms, ev.cost, 0, null); break;
      // The pass stopped early (quota, a bad key, the network). One plain
      // sentence on the panel line; the raw error is in a note event.
      case "embed-stopped": { const txt = ev.text || "Semantic search stopped early" + (ev.reason ? ": " + ev.reason : "") + "."; logLine(txt, "warn"); paintNow({ status: "stopped" }); break; }
      case "embed-done": phaseEnd(ev.done); logLine("Semantic search: vectors built for " + num(ev.done) + " records" + (ev.pending ? ", " + num(ev.pending) + " waiting for Run" : "") + " (" + fmtDur(ev.ms) + (ev.cost ? ", " + aboutMoney(ev.cost) : "") + ")", ev.pending && !ev.done ? "warn" : "ok"); break;
      case "sample-loaded": logLine("Sample data loaded (" + num(ev.totalRows) + " rows). No FileMaker connection is configured."); break;
      case "pull-start": { const r = rowFor(ev.name, lbl); r.st.textContent = "reading"; r.t0 = Date.now(); paintNow({ table: friendly(ev.name), status: "reading from FileMaker", prog: r.expected ? "0 / " + num(r.expected) : "" }); logLine(fname2(ev.name) + ": reading from FileMaker"); break; }
      case "pull-resumed": { const r = rowFor(ev.name, lbl); r.st.textContent = "resuming"; logLine(fname2(ev.name) + ": continuing from row " + num(ev.fromRow) + " after the restart"); break; }
      case "pull-rows": {
        const r = rowFor(ev.name, lbl);
        // The deletion check reads the keys again: it says how far it is on
        // the line, and never draws the table's bar going backwards.
        if (ev.phase === "deletions") {
          const txt = ev.text || "checking which records were deleted: " + num(ev.rows) + (ev.of ? " of " + num(ev.of) : "");
          r.st.textContent = "checking deletions";
          paintNow({ table: friendly(ev.name), status: "checking deletions", prog: num(ev.rows) + (ev.of ? " / " + num(ev.of) : "") });
          setNowLine(fname2(ev.name) + ": " + txt);
          break;
        }
        r.pullRows = Number(ev.rows) || 0;
        r.st.textContent = num(ev.rows) + (r.expected ? " / " + num(r.expected) : "");
        paintNow({ table: friendly(ev.name), status: "reading", prog: r.st.textContent });
        if (r.expected) { r.bar.classList.remove("pulse"); r.bar.style.width = Math.min(99, ev.rows / r.expected * 100) + "%"; r.frac = Math.min(0.99, ev.rows / r.expected); }
        else { r.bar.style.width = "100%"; r.bar.classList.add("pulse"); }
        overall();
        break;
      }
      case "pull-done": {
        const r = rowFor(ev.name, lbl); r.bar.classList.remove("pulse"); r.pullDone = true;
        if (Number(ev.duplicatesTotal) > 0 || (ev.duplicates || []).length) dupTables.add(ev.name);
        // The server says how it read the table (method), from when (since,
        // incremental only) and whether it resumed after a crash (resumedFrom).
        // Without a method (an older server) the plain line stands.
        const secs = " (" + Math.round((ev.ms || 0) / 100) / 10 + "s)";
        const resumed = ev.resumedFrom != null ? ", resumed at row " + num(ev.resumedFrom) : "";
        if (!ev.method) logLine(fname2(ev.name) + ": " + ev.mode + " pull, " + num(ev.changed) + " row(s) changed of " + num(ev.rows) + secs);
        else if (ev.mode === "incremental" || ev.since) logLine(fname2(ev.name) + ": incremental " + ev.method + (ev.since ? " since " + whenShort(ev.since) : "") + ", " + num(ev.changed) + " rows changed, " + num(ev.removed) + " removed" + resumed + secs);
        else logLine(fname2(ev.name) + ": full pull " + ev.method + ", " + num(ev.rows) + " rows" + resumed + secs);
        if (ev.changed != null && Number(ev.changed) === 0 && !Number(ev.removed)) {
          // Nothing changed: this table is finished. Full bar, done styling.
          r.el.classList.add("done"); r.bar.style.width = "100%"; r.frac = 1; r.indexed = true; r.unchanged = true;
          r.st.textContent = "done · " + num(ev.rows) + " records, nothing changed";
          paintNow({ table: friendly(ev.name), status: "done", prog: num(ev.rows) + " records, nothing changed" });
          if (markDone(ev.name)) sumTotal += Number(ev.rows || 0);
          setTimeout(() => { if (!r.el.classList.contains("err")) foldDone(r, ev.rows); }, 1500);
        } else {
          // Read, and waiting for the index step that runs once every table is read.
          r.st.textContent = "read"; r.frac = 0.95;
        }
        overall();
        break;
      }
      case "note": {
        // A note may already open with the table's name (the repeated-ID one
        // does); the name is not said twice.
        const note = String(ev.note || "");
        const named = ev.name && (note.startsWith(friendly(ev.name) + ":") || note.startsWith(ev.name + ":") || (lbl && note.startsWith(lbl + ":")));
        const dup = /share ID|repeated IDs?/.test(note);
        if (dup && ev.name) dupTables.add(ev.name);
        logLine((ev.name && !named ? fname2(ev.name) + ": " : "") + note, /share ID/.test(note) ? "warn" : "");
        break;
      }
      case "index-pruned": for (const n of ev.tables || []) { const r = rowFor(n); r.el.classList.add("dropped"); r.st.textContent = "removed"; } logLine("Removed from the index (no longer selected): " + (ev.tables || []).map(fname2).join(", ")); break;
      // A table that pulled nothing new is finished already; its row stays done.
      case "index-table-start": { const r = rowFor(ev.table, lbl); if (r.unchanged) break; r.st.textContent = "indexing"; paintNow({ table: friendly(ev.table), status: "indexing", prog: num(ev.rows) + " records" }); if (ev.source && ev.source !== "fields") logLine(fname2(ev.table) + ": reading " + ev.source); break; }
      // The index step runs in batches and says how far it is.
      case "index-rows": {
        const r = rowFor(ev.table, lbl);
        if (r.unchanged) break;
        r.indexDone = Number(ev.done) || 0; r.indexTotal = Number(ev.total) || 0;
        r.st.textContent = "indexing " + num(r.indexDone) + (r.indexTotal ? " / " + num(r.indexTotal) : "");
        if (r.indexTotal) { r.bar.style.width = Math.min(99, r.indexDone / r.indexTotal * 100) + "%"; r.frac = Math.min(0.99, r.indexDone / r.indexTotal); }
        paintNow({ table: friendly(ev.table), status: "indexing", prog: num(r.indexDone) + (r.indexTotal ? " / " + num(r.indexTotal) : "") });
        overall();
        break;
      }
      case "index-diff":
        if (ev.changed) logLine(fname2(ev.table) + ": " + num(ev.changed) + " of " + num(ev.total) + " changed" + (ev.deleted ? ", " + num(ev.deleted) + " removed" : ""));
        break;
      case "index-table-done": {
        const r = rowFor(ev.table, lbl); r.el.classList.add("done"); r.bar.classList.remove("pulse"); r.bar.style.width = "100%"; r.frac = 1; r.indexed = true; r.pullDone = true;
        r.st.textContent = num(ev.total) + " records";
        paintNow({ table: friendly(ev.table), status: "done", prog: r.st.textContent });
        setTimeout(() => { if (!r.el.classList.contains("err")) foldDone(r, ev.total); }, 1500);
        if (markDone(ev.table)) { sumChanged += Number(ev.changed || 0); sumTotal += Number(ev.total || 0); }
        logLine(fname2(ev.table) + ": done, " + num(ev.total) + " records in the index" + (ev.changed ? "" : " (unchanged)"), "ok");
        overall();
        break;
      }
      case "cancelling": syncStrip.stopping = true; paintStrip(); logLine("Cancel requested, stopping now.", "warn"); subLocked = true; setSub("Stopping"); $("syncCancel").disabled = true; $("syncCancel").textContent = "Stopping..."; break;
      case "pull-cancelled": { const r = rowFor(ev.name, lbl); r.el.classList.add("err"); r.st.textContent = "stopped, nothing kept"; r.bar.classList.remove("pulse"); r.bar.style.width = "0%"; break; }
      case "cancelled": logLine("Stopped at " + friendly(ev.at) + ". Finished tables were kept.", "warn"); break;
      case "stopped": finish("Sync stopped", `${done} of ${total} tables finished; the rest are unchanged.`, false); logLine("Sync stopped.", "warn"); break;
      // done carries the server's summary; finished closes the job. The end
      // line comes from the summary when there is one.
      case "done":
        if (ev.summary && typeof ev.summary === "object") endLine = summaryLine(ev.summary);
        // A run that had nothing to build says so.
        if (ev.upToDate || ev.summary?.upToDate) endLine = "Already up to date";
        break;
      case "finished": {
        $("syncOverall").style.width = "100%";
        let summary = endLine;
        if (!summary && stagesOnly) summary = stageSum.total ? num(stageSum.done) + " of " + num(stageSum.total) + " records done" : "nothing to do";
        if (!summary) { const unchanged = Math.max(0, sumTotal - sumChanged); summary = num(sumChanged) + " record" + (sumChanged === 1 ? "" : "s") + " indexed · " + num(unchanged) + " unchanged"; }
        if (dupTables.size) summary += " · " + dupTables.size + " table" + (dupTables.size === 1 ? " has" : "s have") + " IDs that repeat in FileMaker (see the log)";
        finish(stagesOnly ? "Run complete" : "Sync complete", summary, false);
        logLine((stagesOnly ? "Run complete · " : "Sync complete · ") + summary, "ok");
        break;
      }
      case "error": finish("Sync problem", ev.message, true); logLine("ERROR: " + ev.message, "warn"); break;
    }
  };
  function finish(title, sub, showActions) {
    syncFinished = true;
    subLocked = true; clearInterval(rotTimer);
    if (es) es.close();
    $("syncSpin").style.display = "none";
    $("syncTitle").style.display = ""; $("syncTitle").textContent = title;
    $("syncSub").classList.remove("rot");
    $("syncEll").classList.remove("ell");
    setSub(sub);
    paintNow({ table: title, status: "", prog: total ? `${done} / ${total} tables` : "" });
    setNowLine(sub || title, showActions ? "warn" : "ok");
    $("syncCancel").style.display = "none";
    $("syncBackgroundNote").style.display = "none";
    // Finished with the window closed: the strip says so, in plain words,
    // until OK. A person who was watching sees the window instead.
    syncStrip.stopping = false;
    syncStrip.finTitle = showActions ? (title === "Sync problem" ? "Sync failed" : title) : title.replace(/ complete$/, " finished");
    syncStrip.finSub = sub || "";
    syncStrip.state = $("syncOverlay").classList.contains("open") ? "idle" : (showActions ? "bad" : "ok");
    paintStrip();
    const go = $("syncDone");
    go.style.display = "";
    // Inside the wizard the sync is step 7 of 8: the last step, adding the
    // scripts to the file, comes next.
    go.textContent = wiz.finishing ? "Continue →" : "Done";
    go.onclick = () => {
      $("syncOverlay").classList.remove("open");
      if (wiz.finishing) { wiz.finishing = false; $("wizOverlay").classList.add("open"); wizGo(8); return; }
      $("q").focus();
    };
    if (showActions) $("syncActions").style.display = "flex";
    setSyncButtons(false);
    refreshStatus(); loadConfig().catch(() => {});
  }
  let reconnects = 0;
  async function onError() {
    es.close();
    if (syncFinished) return;
    if (reconnects++ >= 20) { finish("Lost contact with Mitos", "Mitos did not come back. Close and open Mitos again, then try again.", true); return; }
    // The job runs server-side and buffers its events: a reconnect replays
    // what was missed. If the job is gone, the server restarted.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const st = await apiJson("/api/index/job");
      if (!st.job) {
        // The server's own account of the crash, when it left one.
        const why = st.lastCrash?.message;
        if (why) { crashSeen = st.lastCrash.at || why; postJson("/api/index/crash/ack", {}).catch(() => {}); }
        finish("Sync interrupted", why || "Mitos restarted during the sync. Finished tables were kept; sync again to finish the rest.", true);
        return;
      }
      connect(lastSeq);
    } catch { setTimeout(onError, 2000); }
  }
  const teardown = () => { clearInterval(rotTimer); if (es) es.close(); };
  currentSync = { teardown };
  if (!opts.deferConnect) connect(-1);
  return { log: logLine, connect, replay: (events) => { for (const ev of events) onMessage({ data: JSON.stringify(ev) }); } };
}

// Reattach to a job already running when this window opened, and replay it.
(async () => {
  if (urlParams.get("embed") === "1") return; // a card window shows results, never a sync
  try {
    const st = await apiJson("/api/index/job");
    if (st.job && !st.job.done) {
      const w = attachSync(null, { deferConnect: true });
      w.replay(st.job.events);
      w.connect(st.job.events.length - 1);
    }
  } catch {}
})();

refreshStatus();
if (urlParams.get("q")) {
  // Tolerate a query encoded twice on the way in (FileMaker encodes the
  // Web Viewer URL itself; a GetAsURLEncoded in the script doubles it).
  let q0 = urlParams.get("q");
  if (/%[0-9A-Fa-f]{2}/.test(q0)) { try { q0 = decodeURIComponent(q0.replace(/\+/g, " ")); } catch {} }
  $("q").value = q0; run();
}

// ---- Settings ---------------------------------------------------------------------
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
// The display name of a table (Pythia's friendly()). Raw names are identity;
// people see these. Filled from /api/config, refined by the sync events.
let displayNames = {};
const friendly = (raw) => displayNames[raw] || raw;
// Log lines speak the user's names, with the raw occurrence in parentheses.
const fname2 = (raw) => { const f = friendly(raw); return f !== raw ? f + " (" + raw + ")" : raw; };
const fmtNum = (n) => n == null ? "?" : Number(n).toLocaleString();
// A time in words: "37 minutes ago", "at 6:05 am", "yesterday at 9:40 pm",
// "Tuesday", "12 Aug". The same words everywhere a time is shown.
// A short local date-time: "Sep 9 4:54 PM". For a point in time that a
// sentence names, where "37 minutes ago" would read wrong.
const whenShort = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};
const ago = (iso) => {
  if (!iso) return null;
  const d = new Date(iso), now = new Date();
  const m = Math.round((now - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
  const clock = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return "at " + clock;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "yesterday at " + clock;
  if (now - d < 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
};


// Four tabs. Landing is decided per state on a fresh open; reopens keep the tab.
let activeTab = null;
const TABS = ["fm", "tables", "ai", "log", "settings"];
function showTab(t) {
  for (const k of TABS) {
    $("tab-" + k).style.display = k === t ? "" : "none";
    $("tabbtn-" + k).classList.toggle("on", k === t);
  }
  activeTab = t;
  // Data Sources saves itself (Connect persists, file picks persist), so its
  // bar only closes; Tables and AI have a Save.
  $("saveAll").style.display = t === "fm" || t === "log" || t === "settings" ? "none" : "";
  if (t === "log") { loadSearchLog(); loadRecordLog(); }
  if (t === "settings") loadAbout();
  // The Tables tab paints its list whenever it is shown and the list is
  // empty (the wizard filled scannedTables without painting) or stale (a
  // newer scan on the server than the one in hand).
  if (t === "tables" && cfg?.fmConfigured) {
    const painted = Boolean($("tblList").querySelector(".trow"));
    const stale = Boolean(scannedTables && cfg?.scan?.scannedAt && scannedTables.scannedAt && scannedTables.scannedAt !== cfg.scan.scannedAt);
    if (!scannedTables || stale) loadTables().catch(() => {});
    else if (!painted) renderScanned();
  }
}
for (const k of TABS) $("tabbtn-" + k).onclick = () => showTab(k);
$("goDataSources").onclick = () => showTab("fm");

// A table's semantic switch: its saved choice, else what the server proposes, else on.
// A table that is not in the saved set (not indexed) is never semantic-on.
const semOn = (raw) => (cfg?.tables && !(raw in cfg.tables)) ? false : (cfg?.tables?.[raw]?.semantic ?? (cfg?.ai?.coverage?.tables || []).find((t) => t.src_table === raw)?.semantic ?? true);

async function openSettings(tab) {
  const wasOpen = $("settings").classList.contains("open");
  $("settings").classList.add("open");
  $("saveNote").textContent = "";
  const tabBefore = activeTab;
  await loadConfig();
  const fresh = !cfg?.fmConfigured || !cfg?.scan;
  // A tab picked while the config loaded wins.
  if (activeTab === tabBefore) showTab(tab || (wasOpen && activeTab ? activeTab : fresh ? "fm" : "tables"));
  checkCrash().catch(() => {});
  // Record updates with a problem show as a count on the Log tab, whatever tab is open.
  loadRecordLog();
  loadAbout();
  clearInterval(recTimer);
  recTimer = setInterval(() => { if ($("settings").classList.contains("open")) loadRecordLog(); else clearInterval(recTimer); }, 30000);
}
let recTimer = null;
// ---- Crash report: a sync that took Mitos down leaves a note on the server.
// Shown once per note, when the page or Settings opens. Both buttons clear it.
let crashSeen = null;
async function checkCrash(st) {
  const job = st || await apiJson("/api/index/job").catch(() => null);
  const c = job?.lastCrash;
  if (!c || !c.message || crashSeen === (c.at || c.message)) return;
  if (job?.job && !job.job.done) return; // a sync is running now; not the moment
  crashSeen = c.at || c.message;
  $("crashBody").textContent = c.message;
  $("crashOverlay").classList.add("open");
  const ack = () => postJson("/api/index/crash/ack", {}).catch(() => {});
  $("crashClose").onclick = async () => { $("crashOverlay").classList.remove("open"); await ack(); };
  $("crashRetry").onclick = async () => { $("crashOverlay").classList.remove("open"); await ack(); runSync(null); };
}
$("openSettings").addEventListener("click", () => openSettings());
$("closeSettings").addEventListener("click", () => { $("settings").classList.remove("open"); clearInterval(recTimer); });
// Escape backs out one level: the providers screen, a help window, an
// enrichment window, then Settings itself.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const id of ["askOverlay", "destroyOverlay", "helpOverlay", "dropOverlay", "resetOverlay", "provOverlay", "enrichOverlay", "syncConfirmOverlay", "crashOverlay"]) {
    const o = $(id); if (!o || !o.classList.contains("open")) continue;
    e.preventDefault();
    // A question that waits for an answer gets "no", so nothing stays pending.
    if (id === "askOverlay") $("askNo").click();
    else if (id === "syncConfirmOverlay") $("syncConfirmCancel").click();
    else o.classList.remove("open");
    return;
  }
  if ($("settings").classList.contains("open") && !document.querySelector(".overlay.open:not(#settings)")) {
    // An open table row on the Tables tab folds first; Settings closes on
    // the next Escape.
    if (openRow) { closeOpenRow(); e.preventDefault(); return; }
    $("settings").classList.remove("open"); e.preventDefault();
  }
});
// Light or dark: the system's choice unless a person picked one on the AI
// tab. Remembered per browser.
const themeChoice = () => { try { return localStorage.getItem("mitos_theme") || "system"; } catch { return "system"; } };
const applyTheme = (choice) => {
  const light = choice === "light" || (choice === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  if (light) document.documentElement.setAttribute("data-theme", "light"); else document.documentElement.removeAttribute("data-theme");
  for (const b of document.querySelectorAll("#themeOpt button")) b.classList.toggle("on", b.dataset.theme === choice);
};
applyTheme(themeChoice());
document.querySelectorAll("#themeOpt button").forEach((b) => { b.onclick = () => { try { localStorage.setItem("mitos_theme", b.dataset.theme); } catch {} applyTheme(b.dataset.theme); }; });
if (window.matchMedia) window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme(themeChoice()));

// Password managers fill a password field on sight, with whichever account
// they like. A field that is read-only until a person clicks into it gets
// no such fill. Read-only again when it is left empty.
for (const id of ["fmPass", "wizPass"]) {
  const p = $(id);
  p.addEventListener("focus", () => p.removeAttribute("readonly"));
  p.addEventListener("blur", () => { if (!p.value) p.setAttribute("readonly", ""); });
}
function showFmForm(on) {
  $("fmForm").style.display = on ? "" : "none";
  $("fmView").style.display = on ? "none" : "";
  $("fmEditBtn").textContent = on ? "Close" : "Edit";
  if (on) { $("fmCancelBtn").textContent = "Cancel"; $("fmDbPicker").style.display = "none"; }
}
$("fmEditBtn").onclick = () => { const on = $("fmForm").style.display === "none"; showFmForm(on); if (on) $("fmHost").focus(); };

async function loadConfig() {
  try {
    cfg = await apiJson("/api/config");
    if (cfg.displayNames) displayNames = { ...displayNames, ...cfg.displayNames };
    hasKeyNow = Boolean(cfg.ai?.hasKey);
    syncedSet = new Set((cfg.index?.tables || []).map((t) => t.src_table));
    $("setSub").textContent = cfg.fm.db || (cfg.fmConfigured ? "all visible files" : "sample data");
    // Connection card: green means proven, at a time we can name.
    const fm = cfg.fm;
    loadedFm = { host: fm.host || "", db: fm.db || "", user: fm.user || "", hasPass: Boolean(fm.hasPass) };
    $("fmHost").value = fm.host || ""; $("fmUser").value = fm.user || ""; $("fmDb").value = fm.db || ""; $("fmPass").value = "";
    $("fmPass").placeholder = fm.hasPass ? "••••••••" : "";
    $("fmTestStatus").textContent = fm.hasPass ? "password set" : (fm.host ? "no password yet" : "");
    const dot = $("fmDot");
    dot.classList.toggle("on", Boolean(fm.host && fm.verifiedAt));
    dot.classList.toggle("warn", Boolean(fm.host && !fm.verifiedAt));
    $("fmSummary").textContent = fm.host
      ? fm.host + " · " + (fm.db || "all files") + " · " + fm.user + (fm.hasPass ? "" : " · no password") + (fm.verifiedAt ? " · verified " + ago(fm.verifiedAt) : " · not verified")
      : "Not connected yet. Running on sample data.";
    showFmForm(!fm.host);
    // Structure line and the scan gate
    if (cfg.scan) {
      $("structRow").style.display = "";
      $("structInfo").textContent = "Structure: " + cfg.scan.tableCount + " tables · " + Number(cfg.scan.fieldCount).toLocaleString() + " fields · scanned " + ago(cfg.scan.scannedAt) + " · via OData";
      $("scanGate").style.display = "none";
      $("scanFirstNote").style.display = "none"; $("cardTables").style.display = "";
    } else {
      $("structRow").style.display = "none";
      $("scanGate").style.display = cfg.fmConfigured ? "" : "none";
      $("scanFirstNote").style.display = cfg.fmConfigured ? "" : "none";
      $("cardTables").style.display = cfg.fmConfigured ? "none" : "";
      $("tblNote").textContent = cfg.fmConfigured ? "" : "Running on the bundled sample data. Connect a FileMaker server on the Data Sources tab to search your own tables.";
    }
    scannedAtKnown = cfg.scan?.scannedAt || null;
    renderSaxHints(cfg.hints);
    paintSemCells();
    $("syncEvery").value = String(cfg.syncEvery || 0);
    $("dateFormat").value = cfg.dateFormat === "dmy" ? "dmy" : "mdy";
    $("lastSync").textContent = cfg.index.builtAt ? "last synced " + ago(cfg.index.builtAt) : "";
    $("lastSync").title = cfg.index.builtAt ? new Date(cfg.index.builtAt).toLocaleString() : "";
    // AI tab: the switch scopes the card; it opens on the naming model's provider.
    renderProviders();
    await fillModels();
    applyGate();
  } catch (e) { $("saveNote").textContent = e.message; }
}

// ---- Connect: test, then persist on success; files are DISCOVERED, not typed -----
const readFmFields = () => ({ host: $("fmHost").value.trim(), db: $("fmDb").value.trim(), user: $("fmUser").value.trim(), pass: $("fmPass").value });
const fmSelectedDbs = () => $("fmDb").value.split(",").map((s) => s.trim()).filter(Boolean);
// One or more files on the server: checkboxes.
function fmDbRow(name, { checked, onToggle }) {
  const row = document.createElement("label");
  row.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13.5px;cursor:pointer;color:var(--text);margin:0";
  const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = checked; cb.style.cssText = "width:16px;height:16px;accent-color:var(--accent)";
  cb.onchange = () => onToggle(cb.checked);
  const text = document.createElement("span"); text.textContent = name;
  row.append(cb, text);
  return row;
}
function renderDbPicker(databases) {
  const box = $("fmDbPicker");
  box.innerHTML = ""; box.style.display = "";
  const head = document.createElement("div");
  head.style.cssText = "font-weight:600;font-size:13px;margin-bottom:6px";
  head.textContent = "Files to search";
  box.appendChild(head);
  if (!databases.length) {
    const p = document.createElement("p");
    p.style.cssText = "color:var(--warn);font-size:13px;margin:0";
    p.textContent = "Connected, but this login can't open any files. The account has to exist inside each file with the fmodata extended privilege before it appears here.";
    box.appendChild(p);
    return;
  }
  const selected = fmSelectedDbs();
  for (const name of databases) {
    box.appendChild(fmDbRow(name, {
      checked: selected.includes(name),
      onToggle: async (on) => {
        const next = new Set(fmSelectedDbs());
        on ? next.add(name) : next.delete(name);
        $("fmDb").value = [...next].join(",");
        renderDbPicker(databases);
        // A file choice persists on the click; there is no Save for it. A
        // refusal (the login does not open that file) shows on the status line.
        const st = $("fmTestStatus");
        try {
          const saved = await postJson("/api/config", { fm: { host: $("fmHost").value.trim(), user: $("fmUser").value.trim(), db: $("fmDb").value } });
          if (saved && saved.error) { st.style.color = "var(--warn)"; st.textContent = saved.error; return; }
        } catch (e) { st.style.color = "var(--warn)"; st.textContent = e.message || String(e); return; }
        loadedFm.db = $("fmDb").value;
        scannedTables = null;
      },
    }));
  }
}
$("fmTestBtn").onclick = async () => {
  const st = $("fmTestStatus"); st.style.color = "var(--dim)";
  const fm = readFmFields();
  if (!fm.host || !fm.user) { st.style.color = "var(--warn)"; st.textContent = "A server and username are needed to connect."; return; }
  st.textContent = "Connecting...";
  $("fmTestBtn").disabled = true;
  try {
    const r = await postJson("/api/fm/test", { fm });
    if (!r.ok) { st.style.color = "var(--warn)"; st.textContent = "Failed: " + (r.error || "check the server address and login"); $("fmDbPicker").style.display = "none"; return; }
    // Proven: persist now, then stamp it verified (a blank-password test
    // against the stored connection is how the server records the proof).
    const dbs = r.databases || [];
    if (dbs.length === 1) fm.db = dbs[0];
    // The server refuses a login that does not open the file. Say why, in
    // the same line, and leave the fields as typed.
    const saved = await postJson("/api/config", { fm });
    if (saved && saved.error) { st.style.color = "var(--warn)"; st.textContent = saved.error; $("fmDbPicker").style.display = "none"; return; }
    await postJsonQuiet("/api/fm/test", { fm: {} });
    st.style.color = dbs.length ? "var(--ok)" : "var(--warn)";
    st.textContent = dbs.length ? `Connected as ${fm.user} · ${dbs.length} file${dbs.length === 1 ? "" : "s"} visible · saved` : `Connected as ${fm.user}, but no files are visible to this login · saved`;
    loadedFm = { host: fm.host, db: fm.db, user: fm.user, hasPass: true };
    $("fmPass").value = ""; $("fmPass").placeholder = "••••••••";
    scannedTables = null;
    // Connect means connect (Matt, 2026-09-07). It stops here, in green. The
    // scan is its own button. Several files means a picker to choose from.
    $("fmCancelBtn").textContent = "Done";
    renderDbPicker(dbs); $("fmDbPicker").style.display = "";
  } catch (e) { st.style.color = "var(--warn)"; st.textContent = "Failed: " + (e.message || e); }
  finally { $("fmTestBtn").disabled = false; }
};
// Cancel walks away untouched. After a successful Connect it reads "Done"
// and closes the edit; the summary line then shows the verified connection
// and the Scan button is the next step. Nothing runs by itself.
$("fmCancelBtn").onclick = async () => {
  const saved = $("fmCancelBtn").textContent === "Done";
  $("fmHost").value = loadedFm.host; $("fmDb").value = loadedFm.db; $("fmUser").value = loadedFm.user; $("fmPass").value = "";
  $("fmTestStatus").textContent = ""; $("fmDbPicker").style.display = "none";
  showFmForm(false);
  if (saved) await loadConfig();
};
const keyStepDone = async () => {
  $("keyStepNote").style.display = "none";

  await loadConfig();
  await runScan();
  if (scanState === "done") $("scanClose").click();
};
$("keyStepContinue").onclick = keyStepDone;
$("keyStepSkip").onclick = keyStepDone;

// ---- The scan window: progress you can watch, a build you can leave ---------------
const scanLogLine = (msg, cls) => {
  const d = el("div", cls || "");
  d.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span>${esc(msg)}`;
  $("scanLog").appendChild(d);
  $("scanLog").parentElement.scrollTop = 1e9;
};
let scanAbort = false;
let scanState = "idle"; // running | done | failed
function scanButton(state) {
  scanState = state;
  const b = $("scanClose");
  if (state === "running") { b.textContent = "Cancel"; b.classList.remove("primary"); }
  else if (state === "done") { b.textContent = "Done"; b.classList.add("primary"); }
  else { b.textContent = "Close"; b.classList.remove("primary"); }
}
async function runScan() {
  $("scanLog").innerHTML = ""; scanAbort = false;
  scanButton("running");
  $("scanPulseTrack").style.display = "";
  $("scanOverlay").classList.add("open");
  try {
    scanLogLine(`Connecting to ${loadedFm.host || $("fmHost").value.trim() || "your server"} as ${loadedFm.user || $("fmUser").value.trim() || "?"}...`);
    const t = await postJson("/api/fm/test", { fm: {} });
    if (scanAbort) return;
    if (!t.ok) {
      scanLogLine("Connection failed: " + (t.error || "check server, database, and login"), "warn");
      scanLogLine("Fix the connection (Edit on the Data Sources tab), then scan again.");
      return;
    }
    scanLogLine(`Connected. ${t.databases.length} database file${t.databases.length === 1 ? "" : "s"} visible.`, "ok");
    // Choose BEFORE the deep scan: reading every file's structure costs up to
    // a minute per file. Several files and no choice yet means pick first.
    if (!loadedFm.db && t.databases.length > 1) {
      scanLogLine("Which files should Mitos look at? Pick below, then continue.");
      const pickBox = el("div", "");
      pickBox.style.cssText = "margin:8px 0 4px;display:flex;flex-direction:column;gap:5px;max-height:200px;overflow-y:auto";
      for (const dbn of t.databases) {
        const lab = el("label", "");
        lab.style.cssText = "display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:0;color:var(--text)";
        lab.innerHTML = `<input type="checkbox" value="${esc(dbn)}" style="width:15px;height:15px;accent-color:var(--accent)"> ${esc(dbn)}`;
        pickBox.appendChild(lab);
      }
      const goBtn = el("button", "btn primary"); goBtn.type = "button"; goBtn.textContent = "Scan selected files";
      goBtn.style.cssText = "margin:6px 0 2px;align-self:flex-start";
      pickBox.appendChild(goBtn);
      $("scanLog").appendChild(pickBox);
      const picked = await new Promise((resolve) => {
        goBtn.onclick = () => {
          const v = [...pickBox.querySelectorAll("input:checked")].map((i) => i.value);
          if (!v.length) { scanLogLine("Pick at least one file.", "warn"); return; }
          resolve(v);
        };
        const watch = setInterval(() => { if (scanAbort || !$("scanOverlay").classList.contains("open")) { clearInterval(watch); resolve(null); } }, 400);
      });
      if (!picked || scanAbort) return;
      pickBox.remove();
      const allPicked = picked.length === t.databases.length;
      await postJson("/api/config", { fm: { host: loadedFm.host, user: loadedFm.user, db: allPicked ? "" : picked.join(",") } });
      loadedFm.db = allPicked ? "" : picked.join(",");
      scanLogLine(`Scanning ${picked.length} file${picked.length === 1 ? "" : "s"}: ${picked.join(", ")}`, "ok");
    }
    if (t.missing && t.missing.length) {
      scanLogLine(`This login can't open ${t.missing.map((s) => `"${s}"`).join(", ")}. It can open: ${t.databases.join(", ") || "nothing"}. The account needs the fmodata extended privilege in that file.`, "warn");
      return;
    }
    scanLogLine("Reading tables and fields...");
    // The build reports its own progress; poll it while the slow read runs.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tblPromise = (async () => {
      let r = await apiJson("/api/fm/tables?refresh=1");
      while (r.building && !scanAbort) { await sleep(2000); r = await apiJson("/api/fm/tables"); }
      return r;
    })();
    let building = true; tblPromise.finally(() => { building = false; });
    let lastTxt = "";
    while (building && !scanAbort) {
      try {
        const p = await apiJson("/api/fm/scan/progress");
        if (p.text && p.text !== lastTxt) {
          const L = $("scanLog");
          const inPlace = (a, b, pre) => a.startsWith(pre) && b.startsWith(pre);
          if ((inPlace(p.text, lastTxt, "Counting records") || inPlace(p.text, lastTxt, "Still reading") || inPlace(p.text, lastTxt, "Reading a sample") ||
               (p.text.startsWith("Still reading") && lastTxt.startsWith("Reading the structure"))) && L.lastChild)
            L.lastChild.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span>${esc(p.text)}`;
          else scanLogLine(p.text);
          lastTxt = p.text;
        }
      } catch { /* progress is best-effort */ }
      await sleep(900);
    }
    const tbl = await tblPromise;
    if (scanAbort) return;
    if (tbl.error) { scanLogLine("Schema read failed: " + tbl.error, "warn"); return; }
    scannedTables = tbl;
    const tm = tbl.timings ? ` in ${Math.round((tbl.timings.totalMs || 0) / 1000)}s` : "";
    scanLogLine(`Scan complete${tm}: ${(tbl.tables || []).length} tables found${tbl.naming?.source ? ", named by " + tbl.naming.source : ""}. Pick the ones Mitos should search.`, "ok");
    $("scanPulseTrack").style.display = "none";
    scanButton("done");
  } catch (e) { scanLogLine("Error: " + (e.message || e), "warn"); }
  finally {
    $("scanPulseTrack").style.display = "none";
    if (scanState === "running") scanButton("failed");
  }
}
$("scanBtn").onclick = async () => {
  // No key yet: offer it once, before the first scan, so tables come out named.
  if (!hasKeyNow && !sessionStorage.getItem("keyStepSeen")) {
    sessionStorage.setItem("keyStepSeen", "1");
    showTab("ai"); $("keyStepNote").style.display = ""; openProviders();
    return;
  }
  $("scanGate").style.display = "none"; runScan();
};
$("rescanBtn").onclick = runScan;
$("scanClose").onclick = async () => {
  // Inside the wizard the scan is one step of seven: hand control back to it.
  if (wiz.waitingScan) {
    if (scanState === "running") { scanAbort = true; scanButton("failed"); }
    $("scanOverlay").classList.remove("open");
    $("wizOverlay").classList.add("open");
    await wizScanFinished(scanState === "done");
    return;
  }
  if (scanState === "running") { scanAbort = true; scanButton("failed"); $("scanOverlay").classList.remove("open"); openSettings("fm"); return; }
  $("scanOverlay").classList.remove("open");
  if (scanState === "done") { await openSettings("tables"); renderScanned(); }
  else openSettings();
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (!$("scanOverlay").classList.contains("open") || scanState === "running") return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  e.preventDefault();
  $("scanClose").click();
});

// The Tables tab reads the cached scan; a rescan goes through the scan window.
async function loadTables() {
  $("tblNote").textContent = "loading...";
  try {
    let r = await apiJson("/api/fm/tables");
    if (r.building) { $("tblNote").textContent = "A scan is running. Open it from the Data Sources tab, or wait here."; while (r.building) { await new Promise((x) => setTimeout(x, 2000)); r = await apiJson("/api/fm/tables"); } }
    if (r.error) { $("tblNote").textContent = r.error; throw new Error(r.error); }
    scannedTables = r;
    renderScanned();
    await loadConfig();
  } catch (e) { $("tblNote").textContent = e.message; throw e; }
}
function renderScanned() {
  const r = scannedTables; if (!r) return;
  renderTables(r.tables);
  $("tblNote").textContent = "";
  showNameBanner(r);
  $("tblHead").style.display = "flex";
  $("scanFirstNote").style.display = "none"; $("cardTables").style.display = "";
}
// Naming state is DECLARED, never silent. A scan made before the key was set
// shows guessed names; say so, and offer the fix in place.
function showNameBanner(r) {
  const nb = $("nameBanner");
  if (!r.namesProvisional) { nb.style.display = "none"; return; }
  nb.style.display = "";
  nb.innerHTML = r.hasKey
    ? 'Table names are guessed. <button class="btn" id="nameNowBtn" type="button" style="margin-left:8px">Name tables now</button> <span class="note" id="nameNowSt" style="margin-left:8px">one AI call, no rescan</span>'
    : 'Table names are guessed from the occurrence names. Mitos names them properly once your API key is set. <button class="btn" id="nameKeyBtn" type="button" style="margin-left:8px">Set the API key</button>';
  const now = $("nameNowBtn"), key = $("nameKeyBtn");
  if (key) key.onclick = () => { showTab("ai"); openProviders(); };
  if (now) now.onclick = async () => {
    now.disabled = true; $("nameNowSt").textContent = "asking the AI... (10-30s)";
    try {
      const rr = await apiJson("/api/fm/tables?rename=1");
      if (rr.error) { $("nameNowSt").textContent = rr.error; now.disabled = false; return; }
      scannedTables = rr; renderScanned(); await loadConfig();
    } catch (e) { $("nameNowSt").textContent = String(e.message || e); now.disabled = false; }
  };
}

// ---- SaXML upload (Pythia's File structure card) ------------------------------------
let saxHints = null, scannedAtKnown = null;
const saxDate = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function renderSaxHints(h) {
  saxHints = h;
  const box = $("saxFiles"); box.innerHTML = "";
  if (!h || !h.files || !h.files.length) { $("saxClearBtn").style.display = "none"; renderSaxStatus(); return; }
  $("saxClearBtn").style.display = "";
  const groups = new Map();
  for (const f of h.files) { const k = f.uploadName || f.file; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
  for (const [name, fs] of groups) {
    const tables = fs.reduce((a, f) => a + f.tables, 0);
    const withPk = fs.reduce((a, f) => a + f.withPk, 0);
    const withMod = fs.reduce((a, f) => a + f.withMod, 0);
    const noKey = tables - withPk;
    const at = fs.map((f) => f.uploadedAt).filter(Boolean).sort().pop();
    const row = el("div", "upfile");
    row.style.cssText = "align-items:flex-start;padding:8px 10px";
    row.innerHTML = `<div style="flex:1;min-width:0">` +
      `<div class="nm" title="${esc(name)}">${esc(name)}</div>` +
      `<div class="note" style="margin-top:2px">${fs.length === 1 ? "FileMaker file" : "FileMaker files"}: ${esc(fs.map((f) => f.file).join(", "))}${at ? ` · uploaded ${esc(saxDate(at))}` : ""}</div>` +
      `<div class="note" style="margin-top:3px">${tables} table${tables === 1 ? "" : "s"} · ${withPk} with a primary key · ${withMod} with a modification field` +
      (noKey > 0 ? ` <span style="color:var(--warn)" title="Tables without a primary key sync as a full pull every time.">· ${noKey} table${noKey === 1 ? "" : "s"} lack a key: full pull each sync</span>` : "") +
      `</div></div>` +
      `<button class="rm" title="Remove this upload" type="button">&#10005;</button>`;
    row.querySelector(".rm").onclick = async () => {
      if (!await askOnce("Remove this upload?", `Mitos falls back to auto-detected names for its tables at the next rescan.\n\n${name}`, "Remove", "Cancel")) return;
      let last = null;
      for (const f of fs) { try { last = await fetch("/api/schema/hints/" + encodeURIComponent(f.file), { method: "DELETE" }).then((x) => x.json()); } catch {} }
      renderSaxHints(last ? last.hints : null);
      $("saxStatus").textContent = `Removed ${name}. Rescan to apply.`;
    };
    box.appendChild(row);
  }
  renderSaxStatus();
}
function renderSaxStatus() {
  const t = $("saxTimes");
  const files = (saxHints && saxHints.files) || [];
  const xmlAt = files.map((f) => f.uploadedAt).filter(Boolean).sort().pop() || null;
  const scanTxt = scannedAtKnown ? "last scan " + saxDate(scannedAtKnown) : "not scanned yet";
  if (!xmlAt) { t.textContent = `No XML uploaded yet · ${scanTxt}`; t.style.color = ""; return; }
  const verdict = !scannedAtKnown ? "XML is newer: scan to apply"
    : Date.parse(scannedAtKnown) >= Date.parse(xmlAt) ? "scan is newer than the XML" : "XML is newer: rescan to apply";
  t.textContent = `XML uploaded ${saxDate(xmlAt)} · ${scanTxt} · ${verdict}`;
  t.style.color = /newer: /.test(verdict) ? "var(--accent)" : "";
}
function uploadSax(f, row) {
  const mb = (n) => (n / 1048576).toFixed(1) + " MB";
  const bar = row.querySelector(".bar"), meta = row.querySelector(".meta");
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/schema/saxml?name=" + encodeURIComponent(f.name));
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { const pct = e.lengthComputable ? Math.round(e.loaded / e.total * 100) : 0; bar.style.width = pct + "%"; meta.textContent = e.lengthComputable ? `${pct}% of ${mb(e.total)}` : `${mb(e.loaded)} sent`; };
    xhr.upload.onload = () => { bar.style.width = "100%"; meta.innerHTML = `reading the structure<span class="ell"></span>`; };
    xhr.onload = () => {
      let r = null; try { r = JSON.parse(xhr.responseText); } catch {}
      if (!r || r.error) { meta.style.color = "var(--warn)"; meta.textContent = (r && r.error) || `upload failed (${xhr.status})`; resolve(null); return; }
      meta.style.color = "var(--ok)"; meta.textContent = `${r.tables} table${r.tables === 1 ? "" : "s"} read`;
      resolve(r);
    };
    xhr.onerror = () => { meta.style.color = "var(--warn)"; meta.textContent = "upload failed: the connection dropped"; resolve(null); };
    xhr.send(f);
  });
}
$("saxBtn").onclick = () => $("saxFile").click();
$("wizSax").onclick = () => $("saxFile").click();
$("saxFile").onchange = async () => {
  const files = [...$("saxFile").files]; if (!files.length) return;
  const st = $("saxStatus"); st.textContent = "";
  const prog = $("saxProgress"); prog.innerHTML = "";
  let done = 0, last = null;
  for (const f of files) {
    const row = el("div", "upfile");
    row.innerHTML = `<span class="nm" title="${esc(f.name)}">${esc(f.name)}</span>` +
      `<span style="display:inline-block;width:120px;height:5px;border-radius:3px;background:var(--line);flex:none"><span class="bar" style="display:block;width:0;height:100%;border-radius:3px;background:var(--accent)"></span></span>` +
      `<span class="meta">0%</span>`;
    prog.appendChild(row);
    const r = await uploadSax(f, row);
    if (r) { done++; last = r.hints; }
  }
  if (last) renderSaxHints(last);
  st.textContent = done ? `${done} file${done === 1 ? "" : "s"} read · ${last ? last.totalTables : 0} tables mapped. Rescan to apply the real names and keys.` : "Nothing was uploaded.";
  if (wiz.open) $("wizSaxNote").textContent = st.textContent;
  $("saxFile").value = "";
};
$("saxClearBtn").onclick = async () => {
  if (!await askOnce("Remove every uploaded XML?", "Mitos falls back to auto-detected names at the next rescan.", "Remove all", "Cancel")) return;
  await fetch("/api/schema/hints", { method: "DELETE" }).catch(() => {});
  $("saxProgress").innerHTML = ""; renderSaxHints(null);
  $("saxStatus").textContent = "Cleared. Rescan to fall back to auto-detected names.";
};

// ---- Table picker (kept), Save, Sync now ---------------------------------------------
// The field picker: one line per field, like the table picker. Search says
// the field is indexed; Show says it appears in the result line; Title is the
// one field that names a record (first shown). Fields the scan left out are
// dim with the reason, still selectable. Binary fields never appear.
const TYPE_LABEL = { String: "text", Decimal: "number", Date: "date", DateTimeOffset: "timestamp", Boolean: "boolean" };
function fieldListHtml(t, p) {
  const search = new Set(p.textFields || []), show = new Set(p.displayFields || []);
  const title = (p.displayFields || [])[0] || "";
  const why = Object.fromEntries((t.excluded || []).map((x) => [x.field, x.why]));
  const rows = (t.fields || []).filter((f) => f.type !== "Binary").map((f) => {
    const dim = why[f.name] && !search.has(f.name);
    const kind = f.summary ? "summary" : f.global ? "global" : f.calc ? (f.stored ? "stored calc" : "calculation") : (TYPE_LABEL[f.type] || f.type);
    return `<div class="frw${dim ? " dim" : ""}" data-f="${esc(f.name)}">` +
      `<span class="fc"><input type="checkbox" class="f-search" ${search.has(f.name) ? "checked" : ""}></span>` +
      `<span class="fc"><input type="checkbox" class="f-show" ${show.has(f.name) ? "checked" : ""}></span>` +
      `<span class="fc"><input type="radio" name="title-${esc(t.name)}" class="f-title" ${title === f.name ? "checked" : ""}></span>` +
      `<span class="fnm">${esc(f.name)}${f.name === p.pk ? ' <span class="note" style="display:inline">key</span>' : ""}</span>` +
      `<span class="fty">${esc(kind)}${why[f.name] ? " · left out: " + esc(why[f.name]) : ""}</span></div>`;
  }).join("");
  return `<div class="flist"><div class="frw fhead"><span class="fc">Search</span><span class="fc">Show</span><span class="fc">Title</span><span class="fnm">Field <button type="button" class="helpbtn f-help" title="What these mean">?</button></span><span class="fty"></span></div>${rows}</div>`;
}
// The "?" on a field list explains Search, Show, Title, the key and the
// dim rows; one listener for every row that opens.
$("tblList").addEventListener("click", (e) => {
  if (e.target.classList && e.target.classList.contains("f-help")) { e.stopPropagation(); showHelp("fields", "Fields"); }
});
// Select all / Deselect all: every include box that can be ticked. Save
// persists the picks, the same as one click at a time.
const setAllTables = (on) => { for (const cb of $("tblList").querySelectorAll(".trow > input[type=checkbox]:not(:disabled)")) cb.checked = on; };
$("tblSelAll").onclick = () => setAllTables(true);
$("tblSelNone").onclick = () => setAllTables(false);
const slugify = (n) => String(n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "table";
// The one order everywhere (the sync plan, the Tables tab, the wizard's
// list): display name A to Z, case-insensitive, then the raw name.
const tableName = (t) => String(displayNames[t.name] || t.displayName || t.name);
const byDisplayName = (a, b) => tableName(a).localeCompare(tableName(b), undefined, { sensitivity: "base" }) || String(a.name).localeCompare(String(b.name));
// The table word (slug) rule, checked as the person types. The server
// enforces the same rule and answers 400 with the reason when it differs.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const slugErrors = new Set();
function slugProblem(raw, word) {
  if (!word) return "A word is needed: your script branches on it.";
  if (word !== word.toLowerCase()) return "Lowercase only.";
  if (!SLUG_RE.test(word)) return "Letters, digits and hyphens only: met-artwork.";
  // Every other table's word: what the other checked rows say right now,
  // and the saved map from the server for tables that are not on the list.
  const taken = {}, onList = {};
  for (const row of $("tblList").querySelectorAll(".trow")) {
    onList[row.dataset.table] = true;
    if (row.dataset.table === raw || !row._exp || !row.querySelector("input[type=checkbox]")?.checked) continue;
    const v = row._exp.querySelector(".cfg-slug")?.value.trim();
    if (v) taken[v] = row.dataset.table;
  }
  for (const [r, s] of Object.entries(cfg?.slugs || {})) if (r !== raw && s && !onList[r]) taken[s] = r;
  if (taken[word]) return `"${word}" is already used by ${fname2(taken[word])}. Each table needs its own word.`;
  return "";
}
// ---- Per-table semantic search: the vectors each table holds, from the config's coverage.
const semanticStageOn = () => Boolean(cfg?.ai?.stages?.semantic?.on);
function semVectorsOf(raw) {
  const c = (cfg?.ai?.coverage?.tables || []).find((x) => x.src_table === raw);
  return { n: Number(c?.vectors ?? c?.embedded ?? 0), bytes: Number(c?.vectorBytes || 0), rows: Number(c?.rows || 0) };
}
function paintSemCells() {
  const list = $("tblList");
  list.classList.toggle("sem-on", semanticStageOn());
  for (const cell of list.querySelectorAll(".trow .tsem")) {
    const sw = cell.querySelector(".tsem-sw"), v = semVectorsOf(cell.dataset.raw);
    const included = cell.closest(".trow")?.querySelector("input[type=checkbox]")?.checked;
    // Only a table that is kept (indexed) has a semantic switch; the cell stays, empty, for alignment.
    cell.style.visibility = included ? "" : "hidden";
    const nEl = cell.querySelector(".tsem-n");
    nEl.textContent = !included ? "" : !sw.checked ? "off" : v.n ? v.n.toLocaleString() + (v.bytes ? " · " + fmtBytes(v.bytes) : "") : "none yet";
    // Apples to apples: vectors are counted against what Mitos holds, while the Records column is FileMaker's count from the last scan.
    nEl.title = included && v.rows ? `${v.n.toLocaleString()} vectors for ${v.rows.toLocaleString()} records in Mitos. The Records column is FileMaker's count at the last sync.` : "";
  }
}
function renderTables(tables) {
  const indexed = new Set((cfg?.index?.tables || []).map((t) => t.src_table));
  const list = $("tblList");
  list.innerHTML = "";
  slugErrors.clear();
  // Pythia's order: included first, then the one order (display name A to
  // Z, then raw name). The naming pass decides what is pre-checked on a
  // first scan; the person chooses.
  const inc = (t) => (cfg?.tables ? t.included : (t.included || t.suggestInclude === true));
  tables = tables.slice().sort((a, b) => (Number(inc(b)) - Number(inc(a))) || byDisplayName(a, b));
  if (!tables.length) return;
  const th = el("div", "thead");
  th.innerHTML = `<span class="cb"></span><span class="fill"></span><span class="tnum">Records</span><span class="tnum f">Fields</span><span class="tsem">Semantic</span><span class="tdotw"></span>`;
  list.classList.toggle("sem-on", semanticStageOn());
  list.appendChild(th);
  let sepDone = false;
  openRow = null;
  for (const t of tables) {
    // A quiet divider where the included block ends and the rest begins.
    if (!sepDone && !inc(t) && inc(tables[0])) {
      const d = el("div", "tgroup");
      d.innerHTML = `Not indexed <span>${tables.filter((x) => !inc(x)).length}</span>`;
      list.appendChild(d); sepDone = true;
    }
    const fname = tableName(t);
    const slow = !t.hasKey || !t.hasMod;
    const dot = t.rowIdOnly ? ["err", "No findable key: FileMaker reports no unique, not-empty field, so a click could never land. Add a UUID field, or a cMitosJSON field with an _id key."]
      : indexed.has(t.name) && slow ? ["slow", "Indexed. Full pull each sync: no " + (t.hasKey ? "" : "primary key ") + (!t.hasKey && !t.hasMod ? "and no " : "") + (t.hasMod ? "" : "modification timestamp")]
      : indexed.has(t.name) ? ["ok", "Indexed, incremental sync"]
      : ["off", "Not indexed"];
    const row = el("div", "trow"); row.dataset.table = t.name;
    row.innerHTML = `<input type="checkbox" ${inc(t) ? "checked" : ""}${t.rowIdOnly ? " disabled" : ""}>` +
      `<span class="tlabel" title="${esc(fname)}${fname !== t.name ? " (" + esc(t.name) + ")" : ""}"><span class="fn">${esc(fname)}</span><span class="rn">${fname !== t.name ? esc(t.name) : ""}</span></span>` +
      `<span class="tnum">${t.rowCount == null ? "&ndash;" : Number(t.rowCount).toLocaleString()}</span>` +
      `<span class="tnum f">${t.fieldCount ?? ""}</span>` +
      `<span class="tsem" data-raw="${esc(t.name)}"><input type="checkbox" class="sw tsem-sw" title="Semantic search for this table"${semOn(t.name) === false ? "" : " checked"}><span class="tsem-n"></span></span>` +
      `<span class="tdotw"><span class="tdot ${dot[0]}" title="${esc(dot[1])}"></span></span>`;
    row.querySelector("input").addEventListener("click", (e) => e.stopPropagation());
    row.querySelector("input").addEventListener("change", paintSemCells);
    // The per-table semantic switch. Off with vectors in place asks first: the
    // vectors for this table are deleted when Save is pressed.
    const tsw = row.querySelector(".tsem-sw");
    row.querySelector(".tsem").addEventListener("click", (e) => e.stopPropagation());
    tsw.addEventListener("change", async () => {
      tsw.dataset.touched = "1";
      paintSemCells();
      if (tsw.checked) return;
      const n = semVectorsOf(t.name).n;
      if (!n) return;
      if (!await askOnce("Turn off semantic search for " + fname + "?", `Deletes ${n.toLocaleString()} vector${n === 1 ? "" : "s"} for ${fname}. They go when you save, and turning it back on rebuilds them.`, "Turn off", "Cancel")) { tsw.checked = true; paintSemCells(); }
    });
    // A tick makes a table's word count; every word is checked again.
    row.querySelector("input").addEventListener("change", () => { for (const r of list.querySelectorAll(".trow")) r._exp?._checkSlug?.(); });
    // Disclosure row: click expands the table's own settings in place. One
    // open at a time. Nothing runs from here.
    const exp = el("div", "texp"); exp.style.display = "none";
    const p = t.proposal || {};
    exp.innerHTML =
      `<div class="texp-rename"><button type="button" class="texp-fold" title="Fold this row (Escape does the same)">&#9662;</button><input class="tname" value="${esc(fname)}" data-real="${esc(t.name)}"><button type="button" class="btn rename-btn" style="font-size:12px;padding:4px 10px">Rename</button><span class="note rename-st"></span></div>` +
      `<div class="texp-grid">` +
        `<span class="tk">sent to FileMaker as</span><span><input type="text" class="cfg-slug" value="${esc(p.slug || cfg?.slugs?.[t.name] || slugify(fname))}" style="max-width:260px" autocomplete="off" spellcheck="false"><div class="note slug-note">the word your script branches on; lowercase, its own for each table</div></span>` +
        // The primary key comes from a list of the fields that can be one
        // (text or number, stored, not a calc, summary or global), with
        // type-ahead; a typed name that is not in the list is refused.
        `<span class="tk">primary key</span><span><input type="text" class="cfg-pk" list="pk-${esc(t.name)}" value="${esc(p.pk || "")}" style="max-width:260px" autocomplete="off"><datalist id="pk-${esc(t.name)}">${keyCandidates(t).map((f) => `<option value="${esc(f)}">`).join("")}</datalist><div class="note pk-note">the field FileMaker finds the record by; pick from the list</div></span>` +
        `<span class="tk">occurrences</span><span>${esc((t.occurrenceNames || []).join(", ") || t.name)}</span>` +
      `</div>` +
      fieldListHtml(t, p) +
      `<div class="texp-done"><button type="button" class="btn row-done">Done</button></div>`;
    // The table word is checked as it is typed; Save waits while any is wrong.
    const slugInp = exp.querySelector(".cfg-slug"), slugNote = exp.querySelector(".slug-note");
    const SLUG_HINT = slugNote.textContent;
    const checkSlug = () => {
      const why = slugProblem(t.name, slugInp.value.trim());
      if (why) { slugErrors.add(t.name); slugNote.style.color = "var(--warn)"; slugNote.textContent = why; }
      else { slugErrors.delete(t.name); slugNote.style.color = ""; slugNote.textContent = SLUG_HINT; }
      if (!slugErrors.size && /word/.test($("saveNote").textContent)) $("saveNote").textContent = "";
    };
    slugInp.addEventListener("input", checkSlug);
    exp._checkSlug = checkSlug;
    // Refuse a key that is not a field of this table.
    const pkInp = exp.querySelector(".cfg-pk"), pkNote = exp.querySelector(".pk-note");
    pkInp.addEventListener("change", () => {
      const ok = keyCandidates(t).includes(pkInp.value.trim());
      if (!ok && pkInp.value.trim()) { pkNote.style.color = "var(--warn)"; pkNote.textContent = `"${pkInp.value.trim()}" is not a key field of this table; pick from the list`; pkInp.value = p.pk || ""; }
      else { pkNote.style.color = ""; pkNote.textContent = "the field FileMaker finds the record by; pick from the list"; }
    });
    // A typed rename saves itself on Enter, on the button, or on blur.
    const inp = exp.querySelector(".tname"), rst = exp.querySelector(".rename-st");
    const doRename = async () => {
      const v = inp.value.trim();
      if (v === (t.displayName || t.name)) return;
      try {
        await postJson("/api/config", { displayNames: { [t.name]: v } });
        t.displayName = v || t.name; displayNames[t.name] = v || t.name;
        row.querySelector(".fn").textContent = v || t.name;
        row.querySelector(".rn").textContent = v && v !== t.name ? t.name : "";
        row.dataset.display = v && v !== t.name ? v : "";
        rst.textContent = "saved";
      } catch (e) { rst.textContent = e.message; }
    };
    exp.querySelector(".rename-btn").onclick = doRename;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doRename(); } });
    inp.addEventListener("blur", doRename);
    row.dataset.display = fname !== t.name ? fname : "";
    row.addEventListener("click", () => {
      const open = exp.style.display !== "none";
      if (openRow && openRow !== exp) openRow.style.display = "none";
      exp.style.display = open ? "none" : "";
      openRow = open ? null : exp;
    });
    exp.addEventListener("click", (e) => e.stopPropagation());
    // The triangle at the top, Done at the bottom, and Escape all fold the row.
    exp.querySelector(".row-done").onclick = closeOpenRow;
    exp.querySelector(".texp-fold").onclick = closeOpenRow;
    row._exp = exp;
    list.appendChild(row); list.appendChild(exp);
  }
  // Every word checked once the whole list is in place, so a saved
  // duplicate shows before anyone types.
  for (const row of list.querySelectorAll(".trow")) row._exp._checkSlug();
  paintSemCells();
}

// Search notes (the enrichment stage) per table: a switch and the prompt a
// fast model follows for each record of this table. The notes are searched,
// never shown. The stage's own switch on the AI tab gates all of them.
// Fields that can be a primary key: text or number, stored, not a
// summary, a global, or an unstored calculation. The scan's proposal first.
function keyCandidates(t) {
  const ok = (t.fields || []).filter((f) => ["String", "Decimal"].includes(f.type) && !f.summary && !f.global && !(f.calc && !f.stored)).map((f) => f.name);
  const pk = t.proposal?.pk;
  return pk && ok.includes(pk) ? [pk, ...ok.filter((n) => n !== pk)] : ok;
}
function enrichBlockHtml(raw) {
  const e = cfg?.tables?.[raw]?.enrich || {};
  const def = cfg?.enrichPromptDefault?.[raw] || "";
  const cov = (cfg?.ai?.coverage?.tables || []).find((t) => t.src_table === raw);
  const stageOn = Boolean(cfg?.ai?.stages?.enrich?.on);
  const st = cov ? `${Number(cov.enriched).toLocaleString()} of ${Number(cov.rows).toLocaleString()} records have notes` : "";
  return `<div class="texp-enrich">` +
    `<label style="display:flex;align-items:center;gap:8px;margin:0;font-size:13px;color:var(--text)"><input type="checkbox" class="en-on" ${e.on ? "checked" : ""} style="width:15px;height:15px;accent-color:var(--accent);margin:0"> Write search notes for this table with AI` +
    `<span class="note" style="margin-left:auto">${esc(st)}${!stageOn ? (st ? " · " : "") + "stage is off on the AI tab" : ""}</span></label>` +
    `<textarea class="en-prompt" placeholder="${esc(def)}" spellcheck="false">${esc(e.prompt || "")}</textarea>` +
    `<div class="note">What the model is told for each record. Blank uses the text shown. The output rules (plain text, nothing invented) are added for you. Notes are written on the next sync.</div>` +
    `</div>`;
}

// The one open table row on the Tables tab. Escape closes it (the Settings
// Escape handler above checks it first); the triangle at the top left and
// the Done button at the bottom of the row do the same.
let openRow = null;
function closeOpenRow() {
  if (!openRow) return;
  openRow.style.display = "none";
  openRow = null;
}

function collectTables() {
  if (!scannedTables) return null;
  const tables = {};
  // Select the table rows explicitly. The list also holds a "not worth
  // searching" divider, and iterating every child meant querySelector returned
  // null for it and the save died on cb.checked (2026-08-31). Anything that is
  // not a .tbl row is not a table.
  for (const row of $("tblList").querySelectorAll(".trow")) {
    const cb = row.querySelector("input[type=checkbox]");
    if (!cb || !cb.checked) continue;
    const box = row._exp;
    const displayName = row.dataset.display;
    const frows = [...box.querySelectorAll(".flist .frw[data-f]")];
    const textFields = frows.filter((r) => r.querySelector(".f-search").checked).map((r) => r.dataset.f);
    const titleRow = frows.find((r) => r.querySelector(".f-title").checked);
    const title = titleRow ? titleRow.dataset.f : null;
    const shown = frows.filter((r) => r.querySelector(".f-show").checked).map((r) => r.dataset.f).filter((f) => f !== title);
    tables[row.dataset.table] = {
      ...(displayName ? { displayName } : {}),
      slug: box.querySelector(".cfg-slug").value.trim(),
      pk: box.querySelector(".cfg-pk").value.trim(),
      textFields,
      displayFields: [...(title ? [title] : []), ...shown],
      enrich: { on: Boolean(box.querySelector(".en-on")?.checked), prompt: box.querySelector(".en-prompt")?.value.trim() || "" },
    };
    // The semantic switch goes along once it is saved or touched; an untouched
    // new table keeps the server's own default.
    const tsw = row.querySelector(".tsem-sw");
    if (tsw && (tsw.dataset.touched || cfg?.tables?.[row.dataset.table]?.semantic !== undefined)) tables[row.dataset.table].semantic = tsw.checked;
  }
  return tables;
}

// Saves the form. The table picks go only when asked (the Tables tab): an
// AI-tab Save must never change which tables are kept. Returns the server's
// answer; `tables` in it is the saved set.
async function saveAll(opts = {}) {
  const body = { syncEvery: Number($("syncEvery").value), dateFormat: $("dateFormat").value };
  if (opts.tables) { const tables = opts.tablesObj || collectTables(); if (tables && Object.keys(tables).length) body.tables = tables; }
  body.ai = collectAi();
  const r = await postJson("/api/config", body);
  if (r.error) throw new Error(r.error);
  return r;
}


// Save on the Tables tab: Pythia's Apply. The confirm says what will sync, what
// goes, and what re-reads; OK saves and syncs, Cancel saves nothing. On the AI
// tab, Save saves and closes. A wrong table word blocks Save and opens the row
// that carries it. The server's own refusal (400, or 409 while a sync runs)
// lands under the same field, or in the note.
function slugsBlockSave() {
  const rows = [...$("tblList").querySelectorAll(".trow")];
  for (const row of rows) row._exp?._checkSlug?.();
  // Only a checked table is saved, so only a checked table's word blocks.
  const raw = rows.find((r) => slugErrors.has(r.dataset.table) && r.querySelector("input[type=checkbox]")?.checked)?.dataset.table;
  if (!raw) return false;
  const row = rows.find((r) => r.dataset.table === raw);
  if (row && openRow !== row._exp) row.click();
  $("saveNote").textContent = `Fix the table word for ${fname2(raw)}, then Save.`;
  return true;
}
function showSlugRefusal(msg) {
  const m = /"([^"]+)" is already used/.exec(msg || "");
  if (!m) return false;
  for (const row of $("tblList").querySelectorAll(".trow")) {
    const inp = row._exp?.querySelector(".cfg-slug");
    if (!inp || inp.value.trim() !== m[1]) continue;
    const note = row._exp.querySelector(".slug-note");
    note.style.color = "var(--warn)"; note.textContent = msg;
    slugErrors.add(row.dataset.table);
    if (openRow !== row._exp) row.click();
    return true;
  }
  return false;
}
async function saveTablesAndSync(verb) {
  if (slugsBlockSave()) return;
  $("saveNote").textContent = "";
  try {
    // The sample data has no FileMaker behind it: save and load it.
    if (!cfg?.fmConfigured) {
      $("saveNote").textContent = "saving...";
      await saveAll({ tables: true });
      await loadConfig(); $("saveNote").textContent = ""; refreshStatus();
      runSync(null, { sample: true });
      return;
    }
    // A form that was never painted has no picks to send: the saved ones stand.
    const tables = collectTables();
    const chosen = tables ? tables : Object.fromEntries(Object.entries(cfg?.tables || {}).map(([k, v]) => [k, v]));
    if (!Object.keys(chosen).length) { $("saveNote").textContent = `Pick at least one table, then ${verb}.`; return; }
    if (!await confirmSyncSave(chosen)) return;
    $("saveNote").textContent = "saving...";
    const r = await saveAll({ tables: true, tablesObj: tables && Object.keys(tables).length ? tables : null });
    await loadConfig();
    $("saveNote").textContent = "";
    refreshStatus();
    // The sync plan is the SAVED set, as the server answered, not the form.
    const saved = r.tables && Object.keys(r.tables).length ? Object.keys(r.tables) : Object.keys(chosen);
    runSync(saved, { dropped: r.dropped || [] });
  } catch (e) { $("saveNote").textContent = e.message; showSlugRefusal(e.message); }
}
$("saveAll").addEventListener("click", async () => {
  if (activeTab === "tables") return saveTablesAndSync("Save");
  $("saveNote").textContent = "saving...";
  try {
    await saveAll();
    await loadConfig();
    $("saveNote").textContent = "";
    refreshStatus();
    $("settings").classList.remove("open");
  } catch (e) { $("saveNote").textContent = e.message; }
});
// Sync now: the same flow as Save on the Tables tab.
$("syncBtn").addEventListener("click", () => saveTablesAndSync("Sync"));

// ===== The setup wizard (Pythia's, 2026-09-05) ========================================
// Seven steps, one screen each; the screen under the lit step is that step's
// own work; every step confirms what just happened; nothing advances without
// a click. Settings itself stays the four tabs for everyone past setup.
// Connect proves the login. Files lists what that login can open (that is a
// list, not a scan). Scan reads the structure of the chosen files. The AI
// stages are set before the first sync, so the sync builds what was chosen.
const WIZ_LABELS = ["Connect", "Files", "API key", "Scan", "Tables", "AI stages", "Sync", "Add to your file"];
const WIZ_STEPS = WIZ_LABELS.length;
const wiz = { open: false, step: 1, prov: "anthropic", connOk: false, filesOk: false, keyOk: false, keySkipped: false, scanOk: false,
              stagesSeen: false, tables: [], picked: new Set(), saved: [], busy: false, waitingScan: false, finishing: false };
const wizLine = (id, msg, on) => { const e = $(id); e.textContent = msg || ""; e.classList.toggle("on", Boolean(on !== undefined ? on : msg)); };
function wizPaint() {
  const done = [wiz.connOk, wiz.filesOk, wiz.keyOk || wiz.keySkipped, wiz.scanOk, wiz.picked.size > 0, wiz.stagesSeen, wiz.step === 8, false];
  $("wizRail").innerHTML = WIZ_LABELS.map((l, i) => {
    const n = i + 1, cls = n === wiz.step ? "wr cur" : (done[i] ? "wr done" : "wr");
    return `<div class="${cls}"><span class="wn">${done[i] && n !== wiz.step ? "&#10003;" : n}</span><span class="wl">${esc(l)}</span></div>`;
  }).join("");
  document.querySelectorAll("#wizOverlay .wiz-body").forEach((b) => { b.style.display = Number(b.dataset.wstep) === wiz.step ? "" : "none"; });
  const act = $("wizAct");
  act.disabled = wiz.busy;
  $("wizSkipKey").style.display = wiz.step === 3 && !wiz.keyOk ? "" : "none";
  $("wizBack").style.display = wiz.step > 1 && wiz.step < 8 ? "" : "none";
  $("wizLater").style.display = wiz.step < 8 ? "" : "none";
  $("wizHeadSub").textContent = `Step ${wiz.step} of ${WIZ_STEPS}`;
  if (wiz.busy) return;
  if (wiz.step === 1) act.textContent = wiz.connOk ? "Continue →" : "Connect";
  else if (wiz.step === 2) { act.textContent = "Continue →"; act.disabled = !wiz.filesOk; }
  else if (wiz.step === 3) act.textContent = wiz.keyOk ? "Continue →" : "Check the key";
  else if (wiz.step === 4) act.textContent = wiz.scanOk ? "Continue →" : "Scan the files";
  else if (wiz.step === 5) { act.textContent = `Continue with ${wiz.picked.size} table${wiz.picked.size === 1 ? "" : "s"} →`; act.disabled = wiz.picked.size === 0; }
  else if (wiz.step === 6) act.textContent = "Continue →";
  else if (wiz.step === 7) act.textContent = "Start the sync";
  else act.textContent = "Done";
}
function wizGo(n) {
  wiz.step = n;
  if (n === 5) wizFillTables();
  if (n === 6) renderStages($("wizStages"));
  if (n === 7) wizFillPlan();
  wizPaint();
  const first = document.querySelector(`#wizOverlay .wiz-body[data-wstep="${n}"] input:not([type=hidden])`);
  if (first && (n === 1 || n === 3)) setTimeout(() => { try { first.focus(); } catch {} }, 30);
}
function wizBusy(on, label) { wiz.busy = on; if (on && label) $("wizAct").textContent = label; wizPaint(); }

// step 1: connect. Only a verified login (ok === true from the server)
// moves on to the file list; anything else stays here with the reason.
async function wizConnect() {
  const fm = { host: $("wizHost").value.trim(), user: $("wizUser").value.trim(), pass: $("wizPass").value, db: "" };
  wizLine("wizConnErr", ""); wizLine("wizConnOk", "");
  if (!fm.host || !fm.user) return wizLine("wizConnErr", "Fill in the server address and the username.");
  wizBusy(true, "Connecting...");
  try {
    const t = await postJson("/api/fm/test", { fm });
    if (t.ok !== true) { wiz.connOk = false; wizLine("wizConnErr", t.error || "The server did not answer."); }
    else {
      wiz.connOk = true;
      wizLine("wizConnOk", `✓ Connected to ${fm.host} as ${fm.user}`);
      wizBusy(false);
      wizGo(2);
      await wizPickFile(fm, t.databases || []);
      return;
    }
  } catch (e) { wiz.connOk = false; wizLine("wizConnErr", String(e.message || e).slice(0, 300)); }
  wizBusy(false);
}
// step 2: files. The files this login can open, listed from the server
// itself, one or more to pick. A stored file name that is not in the list
// is never trusted: it is dropped, and with nothing left the first visible
// file is picked and saved. A pick saves on the click.
async function wizPickFile(fm, dbs) {
  const box = $("wizDbPicker"); box.innerHTML = "";
  wizLine("wizFilesErr", ""); wizLine("wizFilesOk", "");
  wiz.filesOk = false;
  if (!dbs.length) {
    wizLine("wizFilesErr", "Connected, but this login can't open any file over OData. Give the account the fmodata extended privilege in the file, then connect again.");
    wizPaint(); return;
  }
  const stored = String(loadedFm.db || fm.db || "").split(",").map((s) => s.trim()).filter((s) => dbs.includes(s));
  let picked = new Set(stored.length ? stored : [dbs[0]]);
  const save = async () => {
    const db = [...picked].join(",");
    fm.db = db;
    wizLine("wizFilesErr", "");
    try {
      const saved = await postJson("/api/config", { fm: { host: fm.host, user: fm.user, pass: fm.pass || "", db } });
      if (saved && saved.error) throw new Error(saved.error);
    } catch (e) {
      wiz.filesOk = false; wizLine("wizFilesOk", "");
      wizLine("wizFilesErr", String(e.message || e).slice(0, 300));
      wizPaint(); return;
    }
    loadedFm = { host: fm.host, db, user: fm.user, hasPass: true };
    scannedTables = null; wiz.scanOk = false;
    wizLine("wizFilesOk", picked.size ? `✓ Searching ${picked.size} file${picked.size === 1 ? "" : "s"}: ${[...picked].join(", ")}` : "");
    wiz.filesOk = picked.size > 0; wizPaint();
  };
  const head = document.createElement("div"); head.style.cssText = "font-weight:600;font-size:13px;margin-bottom:4px";
  head.textContent = dbs.length === 1 ? "This login can open one file:" : `This login can open ${dbs.length} files. Pick the ones to search:`;
  box.appendChild(head);
  for (const name of dbs) box.appendChild(fmDbRow(name, { checked: picked.has(name), onToggle: (on) => { on ? picked.add(name) : picked.delete(name); save(); } }));
  await save();
}

// step 3: the API key, tested the moment it is pasted
function wizPaintProvider() {
  document.querySelectorAll(".wizprov").forEach((b) => b.classList.toggle("on", b.dataset.prov === wiz.prov));
  $("wizKeyLabel").textContent = wiz.prov === "anthropic" ? "Anthropic API key" : "OpenAI API key";
  wizFillModels(false);
  wiz.keyOk = false; wizLine("wizKeyOk", ""); wizLine("wizKeyErr", "");
  wizPaint();
}
// The same list the AI tab shows (GET /api/ai/models), this provider's chat
// models only: an embedding model cannot name a table. Other... is always there.
function wizFillModels(keep) {
  const sel = $("wizModel");
  const cur = keep ? pickedModel(sel) : "";
  sel.innerHTML = "";
  // Not filtered by "usable": the key for this provider is what is being entered.
  const models = (modelList?.models || []).filter((m) => m.provider === wiz.prov && isChatModel(m));
  addJobOptions(sel, models, "naming");
  $("wizModelHint").textContent = recHint("naming");
  // A pick after the key already passed saves the way the key check does.
  modelPicker(sel, (id) => { if (wiz.keyOk && id) postJson("/api/config", { ai: { namingModel: id } }).catch(() => {}); });
  if (cur) setPicked(sel, cur);
  else if (models.length) sel.value = recommendedPick(models, "naming");
}
let wizKeyTimer = null;
async function wizTestKey(manual) {
  const key = $("wizKey").value.trim();
  wizLine("wizKeyErr", ""); wizLine("wizKeyOk", "");
  if (!key) { if (manual) wizLine("wizKeyErr", "Paste a key first, or choose Skip for now."); return; }
  wizBusy(true, "Checking...");
  try {
    const r = await postJson("/api/ai/test", { key, provider: wiz.prov });
    if (!r.ok) wizLine("wizKeyErr", r.error || "That key was rejected.");
    else {
      const sel = $("wizModel");
      const ai = {};
      ai[wiz.prov === "anthropic" ? "anthropicKey" : "openaiKey"] = key;
      if (pickedModel(sel)) ai.namingModel = pickedModel(sel);
      await postJson("/api/config", { ai });
      // Now that a key exists the provider's live list can be read: fetch it
      // again and refill, keeping the pick. A list that was empty gets one.
      await fillModels(true);
      wizFillModels(true);
      const model = pickedModel(sel);
      if (model && model !== ai.namingModel) await postJson("/api/config", { ai: { namingModel: model } });
      wiz.keyOk = true; wiz.keySkipped = false; hasKeyNow = true;
      wizLine("wizKeyOk", `✓ The key works. Mitos will name tables with ${model ? (sel.selectedOptions[0] || {}).textContent || model : "its default model"}.`);
    }
  } catch (e) { wizLine("wizKeyErr", String(e.message || e).slice(0, 200)); }
  wizBusy(false);
}

// step 4: scan (hands off to the scan window, comes back here)
function wizScan() {
  wiz.waitingScan = true;
  wizLine("wizScanErr", ""); wizLine("wizScanOk", ""); $("wizScanOk").style.color = "";
  $("wizOverlay").classList.remove("open");
  runScan();
}
async function wizScanFinished(ok) {
  wiz.waitingScan = false;
  if (!ok) { wizLine("wizScanErr", "The scan did not finish. Fix what the scan window reported, then scan again."); wizPaint(); return; }
  try {
    const sc = scannedTables || await apiJson("/api/fm/tables");
    const tables = sc.tables || [];
    wiz.tables = tables;
    const fields = tables.reduce((a, t) => a + (t.fieldCount || 0), 0);
    wiz.scanOk = true;
    $("wizScanOk").style.color = "";
    const dbs = (sc.dbs || []).join(", ") || String(loadedFm.db || "").split(",").map((s) => s.trim()).filter(Boolean).join(", ");
    wizLine("wizScanOk", `✓ ${tables.length} table${tables.length === 1 ? "" : "s"} found · ${fields.toLocaleString()} fields${dbs ? " · " + dbs : ""}`);
  } catch { wiz.scanOk = true; $("wizScanOk").style.color = ""; wizLine("wizScanOk", "✓ Structure read."); }
  wizPaint();
}

// step 5: pick tables
function wizFillTables() {
  const box = $("wizTables");
  const rows = (wiz.tables || []).slice().sort(byDisplayName);
  if (!rows.length) { box.innerHTML = `<div style="padding:14px;color:var(--dim);font-size:13px">No tables were found. Go back and scan again.</div>`; return; }
  // Pre-checked: what the naming pass called worth searching, and anything
  // already saved. Never a table with no findable key.
  if (!wiz.picked.size) for (const t of rows) if ((t.suggestInclude === true || t.included) && !t.rowIdOnly && t.rowCount !== 0) wiz.picked.add(t.name);
  box.innerHTML = rows.map((t) => {
    const n = esc(t.name), f = esc(tableName(t));
    const count = t.rowCount == null ? "" : Number(t.rowCount).toLocaleString() + " rec";
    return `<label><input type="checkbox" value="${n}"${wiz.picked.has(t.name) ? " checked" : ""}${t.rowIdOnly ? " disabled" : ""}>` +
           `<span class="wnm">${f}${f !== n ? ` <span class="note" style="display:inline">${n}</span>` : ""}${t.rowIdOnly ? ' <span class="note" style="display:inline;color:var(--warn)">no findable key</span>' : ""}</span>` +
           `<span class="wct">${count}</span></label>`;
  }).join("");
  box.querySelectorAll("input").forEach((i) => { i.onchange = () => { i.checked ? wiz.picked.add(i.value) : wiz.picked.delete(i.value); wizPickSum(); wizPaint(); }; });
  wizPickSum();
}
// Select all / Deselect all: every box that can be ticked, through the same
// handler a click runs, so wiz.picked and the summary follow.
const wizSetAll = (on) => { for (const i of $("wizTables").querySelectorAll("input[type=checkbox]:not(:disabled)")) { i.checked = on; i.onchange(); } };
$("wizSelAll").onclick = () => wizSetAll(true);
$("wizSelNone").onclick = () => wizSetAll(false);
function wizPickSum() {
  const rows = wiz.tables.filter((t) => wiz.picked.has(t.name));
  const recs = rows.reduce((a, t) => a + (Number(t.rowCount) || 0), 0);
  $("wizPickSum").textContent = `${rows.length} table${rows.length === 1 ? "" : "s"} · ${recs.toLocaleString()} records selected`;
}
// Saves the picks and answers with the SAVED set (the server's word, not the
// local list). An error stays on the screen and the wizard does not move on.
// A save that would remove tables asks first, as Save on the Tables tab does.
// The same list is asked once (the sync step saves the picks again).
async function wizConfirmDrops() {
  const before = new Set([...Object.keys(cfg?.tables || {}), ...syncedSet]);
  const drops = [...before].filter((n) => !wiz.picked.has(n)).sort(byFriendly);
  const key = drops.join("\u0000");
  if (!drops.length || wiz.askedDrops === key) return true;
  const names = drops.length > 3 ? drops.length + " tables" : nameList(drops.map(friendly));
  const ok = await askOnce("Remove " + (drops.length === 1 ? "this table?" : "these tables?"), `Saving this choice removes ${names} from Mitos, local copy included. Your FileMaker data is untouched.`, "Remove", "Cancel");
  if (ok) wiz.askedDrops = key;
  return ok;
}
async function wizSaveTables(errId) {
  if (!await wizConfirmDrops()) throw new Error("Nothing was saved. Tick the tables to keep, or choose Remove.");
  const tables = {};
  for (const t of wiz.tables) if (wiz.picked.has(t.name)) tables[t.name] = { ...t.proposal, ...(t.displayName && t.displayName !== t.name ? { displayName: t.displayName } : {}) };
  const r = await postJson("/api/config", { tables });
  if (r.error) throw new Error(r.error);
  const saved = r.tables ? Object.keys(r.tables) : [];
  if (!saved.length) throw new Error("Mitos saved no tables. Go back and pick at least one.");
  wiz.saved = saved;
  return r;
}
async function wizSavePicks() {
  wizLine("wizPickErr", "");
  wizBusy(true, "Saving...");
  try {
    // Each picked table saves with its proposed fields; Settings can adjust them.
    await wizSaveTables();
    await loadConfig();
    wizBusy(false); wizGo(6);
  } catch (e) { wizBusy(false); wizLine("wizPickErr", "Could not save the table choice: " + String(e.message || e).slice(0, 300)); }
}

// step 6: the AI stages, the same switches the AI tab shows, rendered into
// the wizard by renderStages($("wizStages")) from wizGo.

// step 7: sync
function wizFillPlan() {
  const rows = wiz.tables.filter((t) => wiz.picked.has(t.name));
  const recs = rows.reduce((a, t) => a + (Number(t.rowCount) || 0), 0);
  const mins = recs / 45000;
  const time = recs < 20000 ? "under a minute" : mins < 2 ? "a minute or two" : `about ${Math.ceil(mins)} minutes`;
  $("wizPlan").innerHTML =
    `<div><b>${rows.length}</b> table${rows.length === 1 ? "" : "s"}</div>` +
    `<div><b>${recs.toLocaleString()}</b> records to read</div>` +
    `<div>Roughly <b>${time}</b> on a normal connection.</div>` +
    `<div style="margin-top:6px">You can watch every table as it lands, and cancel at any point.</div>`;
}
// The first sync reads exactly the tables the server saved: the picks are
// saved once more here, the answer is awaited, and its set is the plan.
async function wizStartSync() {
  if (!wiz.picked.size) return;
  wizLine("wizPlanErr", "");
  wizBusy(true, "Saving...");
  let r;
  try { r = await wizSaveTables(); }
  catch (e) { wizBusy(false); wizLine("wizPlanErr", "The table choice was not saved, so nothing was synced: " + String(e.message || e).slice(0, 300)); return; }
  wizBusy(false);
  wiz.finishing = true;
  $("wizOverlay").classList.remove("open");
  runSync(wiz.saved);
}

async function openWizard(fromStart) {
  wiz.open = true; wiz.busy = false;
  $("settings").classList.remove("open");
  $("wizOverlay").classList.add("open");
  wizGo(1);
  try {
    const c = await Promise.race([apiJson("/api/config"), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 6000))]);
    cfg = c;
    if (c.fm) {
      $("wizHost").value = c.fm.host || "";
      $("wizUser").value = c.fm.user || "";
      $("wizPass").placeholder = c.fm.hasPass ? "•••••••• (kept)" : "";
      if (c.fm.host && c.fm.verifiedAt) {
        loadedFm = { host: c.fm.host, db: c.fm.db || "", user: c.fm.user || "", hasPass: Boolean(c.fm.hasPass) };
        wiz.connOk = true;
        wizLine("wizConnOk", `✓ Connected to ${c.fm.host} as ${c.fm.user || ""}`);
        wizLine("wizFilesOk", "Listing the files this login can open...", true);
        // Even a saved connection lists its files here, so the file picked
        // is one this login can open today, not a name saved earlier. A
        // login that no longer works sends the wizard back to Connect.
        const fm = { host: c.fm.host, user: c.fm.user, pass: "", db: c.fm.db || "" };
        postJson("/api/fm/test", { fm })
          .then((t) => {
            if (t.ok !== true) { wiz.connOk = false; wizLine("wizFilesOk", ""); wizLine("wizConnErr", t.error || "The saved login did not connect."); wizGo(1); return; }
            return wizPickFile(fm, t.databases || []);
          })
          .catch((e) => { wiz.connOk = false; wizLine("wizFilesOk", ""); wizLine("wizConnErr", String(e.message || e).slice(0, 200)); wizGo(1); });
      }
    }
    if (!modelList) { try { modelList = await apiJson("/api/ai/models"); } catch {} }
    wiz.prov = c.ai?.naming?.provider === "openai" ? "openai" : "anthropic";
    wizPaintProvider();
    if (c.ai?.hasKey) { wiz.keyOk = true; hasKeyNow = true; wizLine("wizKeyOk", "✓ A key is already saved. You can replace it below, or continue."); }
    // A prior scan is information, not a pass: the wizard always scans again,
    // so the tables it offers are today's. The line says when, in dim.
    if (c.scan) {
      wiz.scanOk = false;
      wizLine("wizScanOk", `Last scan ${ago(c.scan.scannedAt)}: ${c.scan.tableCount} table${c.scan.tableCount === 1 ? "" : "s"} found.`, true);
      $("wizScanOk").style.color = "var(--dim)";
      try { scannedTables = await apiJson("/api/fm/tables"); wiz.tables = scannedTables.tables || []; } catch {}
    }
  } catch {}
  wizPaint();
  // A saved, verified connection lands on Files, with the list filling in.
  wizGo(fromStart ? 1 : (wiz.connOk ? 2 : 1));
}
function closeWizard(toSettings) { wiz.open = false; $("wizOverlay").classList.remove("open"); if (toSettings) openSettings(); }
$("wizAct").onclick = () => {
  if (wiz.busy) return;
  if (wiz.step === 1) return wiz.connOk ? wizGo(2) : wizConnect();
  if (wiz.step === 2) return wiz.filesOk ? wizGo(3) : undefined;
  if (wiz.step === 3) return wiz.keyOk ? wizGo(4) : wizTestKey(true);
  if (wiz.step === 4) return wiz.scanOk ? wizGo(5) : wizScan();
  if (wiz.step === 5) return wizSavePicks();
  if (wiz.step === 6) { wiz.stagesSeen = true; return wizGo(7); }
  if (wiz.step === 7) return wizStartSync();
  closeWizard(false); $("q").focus();
};
$("wizSkipKey").onclick = () => {
  wiz.keySkipped = true; wiz.keyOk = false;
  wizLine("wizKeyOk", "Skipped. Table names will be guessed until a key is added in Settings.", true);
  $("wizKeyOk").style.color = "var(--dim)";
  wizGo(4);
};
$("wizBack").onclick = () => { if (wiz.step > 1) wizGo(wiz.step - 1); };
$("wizLater").onclick = () => { try { sessionStorage.setItem("wizLater", "1"); } catch {} closeWizard(true); };
document.querySelectorAll(".wizprov").forEach((b) => { b.onclick = () => { wiz.prov = b.dataset.prov; wizPaintProvider(); }; });
$("wizKey").oninput = () => {
  wiz.keyOk = false; wizLine("wizKeyOk", ""); wizLine("wizKeyErr", ""); wizPaint();
  clearTimeout(wizKeyTimer);
  if ($("wizKey").value.trim().length < 20) return;
  wizKeyTimer = setTimeout(() => wizTestKey(false), 700);
};
$("wizHost").onkeydown = $("wizUser").onkeydown = $("wizPass").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("wizAct").click(); } };
$("wizKey").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(wizKeyTimer); wizTestKey(true); } };

// ---- Boot: the wizard for a brand-new install, Settings when something is missing ----
(async () => {
  if (urlParams.get("embed") === "1") return; // no wizard, no settings, in a card
  try {
    const c = await apiJson("/api/config");
    cfg = c;
    const job = await apiJson("/api/index/job").catch(() => ({}));
    const running = Boolean(job.job && !job.job.done);
    if (running) return;
    // A sync that took Mitos down says so first.
    if (job.lastCrash) { checkCrash(job).catch(() => {}); return; }
    // ?settings=1: the settings screen, with the search behind it as a test.
    if (urlParams.get("settings") === "1") { openSettings(urlParams.get("tab") || undefined); return; }
    // With an index, the page opens on search, always (mitos-big opened
    // Settings on every load, 2026-09-09). Setup is one click away.
    if (!c.neverSynced) return;
    if (!sessionStorage.getItem("wizLater")) openWizard();
  } catch {}
})();

async function loadSearchLog() {
  $("logTotals").textContent = "loading...";
  try {
    const d = await apiJson("/api/log?limit=200");
    $("logTotals").textContent = d.totals.searches + " searches · " + d.totals.clicks + " clicks";
    const box = $("logRows");
    box.innerHTML = "";
    if (!d.searches.length) { box.innerHTML = '<p class="intro">No searches yet.</p>'; return; }
    for (const s of d.searches) {
      const r = el("div", "prow");
      const q = el("span", "pname"); q.style.width = "220px";
      q.textContent = s.query; q.title = s.query;
      const mid = el("span"); mid.style.flex = "1"; mid.style.color = "var(--dim)";
      mid.textContent = s.error ? "error: " + s.error
        : (s.results + " results · " + (s.searched || s.mode || "?") + " · " + (s.ms ?? "?") + "ms");
      const right = el("span"); right.style.width = "230px"; right.style.textAlign = "right";
      if (s.clicked) { const b = el("span", "badge sync"); b.textContent = "clicked #" + (s.clicked.rank ?? "?") + " " + s.clicked.table; right.appendChild(b); }
      else if (!s.error) { const b = el("span", "badge warnb"); b.textContent = s.results ? "no click" : "no results"; right.appendChild(b); }
      r.appendChild(q); r.appendChild(mid); r.appendChild(right);
      box.appendChild(r);
    }
  } catch (e) { $("logTotals").textContent = e.message; }
}
$("logRefresh").addEventListener("click", () => { loadSearchLog(); loadRecordLog(); });

// ---- Record updates: what FileMaker told Mitos about, one record at a time
// (POST /api/records/changed, answered at once, worked off in a queue). Rows
// with an error, or ids FileMaker no longer has, are red and sit on top; the
// count shows on the Log tab.
const idList = (ids) => { const a = (ids || []).map(String); return a.length > 6 ? a.slice(0, 6).join(", ") + " and " + (a.length - 6) + " more" : a.join(", "); };
async function loadRecordLog() {
  let d;
  try { d = await apiJson("/api/records/log?limit=100"); }
  catch { return; }
  const list = Array.isArray(d) ? d : (d?.log || d?.entries || d?.items || []);
  const bad = (e) => Boolean(e.error) || (e.notFound || []).length > 0;
  const rows = list.filter(bad).concat(list.filter((e) => !bad(e)));
  const n = list.filter(bad).length;
  const badge = $("logBadge");
  badge.style.display = n ? "" : "none"; badge.textContent = n ? String(n) : "";
  const box = $("recRows"); box.innerHTML = "";
  if (!rows.length) { box.innerHTML = '<p class="intro" style="margin:0">No record updates yet. They show here when FileMaker tells Mitos a record changed.</p>'; return; }
  for (const e of rows) {
    const r = el("div", "rrow" + (bad(e) ? " bad" : ""));
    const when = el("span", "rwhen"); when.textContent = ago(e.at) || ""; when.title = e.at ? new Date(e.at).toLocaleString() : "";
    const what = el("div", "rwhat");
    const head = el("div");
    const tbl = e.table ? friendly(e.table) : "";
    if (e.error) head.textContent = e.error;
    else head.textContent = `${tbl}: ${Number(e.updated || 0).toLocaleString()} updated, ${Number(e.deleted || 0).toLocaleString()} deleted`;
    what.appendChild(head);
    if (e.error && tbl) { const sub = el("div", "rsub"); sub.textContent = tbl + (e.ids?.length ? " · " + e.ids.length + " record" + (e.ids.length === 1 ? "" : "s") : ""); what.appendChild(sub); }
    if ((e.notFound || []).length) { const sub = el("div", "rsub"); sub.textContent = `FileMaker no longer has ${e.notFound.length === 1 ? "this record" : "these " + e.notFound.length + " records"}: ${idList(e.notFound)}. Mitos removed ${e.notFound.length === 1 ? "it" : "them"} too.`; what.appendChild(sub); }
    r.append(when, what);
    box.appendChild(r);
  }
}

// ---- Settings tab: where this Mitos runs and what it holds (GET /api/about),
// and the gate: without a site password there is nothing to sign out of.
let aboutInfo = null;
const gateOff = () => aboutInfo?.gate === false || cfg?.gate === false;
function applyGate() {
  const row = $("dzSignout")?.closest(".dz-row");
  if (row) row.style.display = gateOff() ? "none" : "";
}
const mbOf = (n) => { const v = Number(n) || 0; return v > 1e6 ? v / 1048576 : v; };
const sizeOf = (n) => { const mb = mbOf(n); return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb).toLocaleString() + " MB"; };
async function loadAbout() {
  try { aboutInfo = await apiJson("/api/about"); } catch { aboutInfo = aboutInfo || null; }
  applyGate();
  const d = aboutInfo;
  const grid = $("aboutGrid");
  if (!d || d.error) { grid.innerHTML = '<span class="k">&nbsp;</span><span class="v">' + esc(d?.error || "The server did not say.") + "</span>"; return; }
  const rows = [];
  const add = (k, v, extra) => { if (v !== null && v !== undefined && v !== "") rows.push([k, String(v), extra || ""]); };
  add("Region", d.region); add("Machine", d.machine);
  if (d.memTotal) {
    const tight = d.memUsed && Number(d.memUsed) / Number(d.memTotal) > 0.7;
    add("Memory", (d.memUsed ? sizeOf(d.memUsed) + " used of " : "") + sizeOf(d.memTotal), tight ? "tight for large tables" : "");
  }
  if (d.cpus) add("CPU", d.cpus + (Number(d.cpus) === 1 ? " core" : " cores"));
  if (d.diskTotal) add("Disk", (d.diskUsed != null ? sizeOf(d.diskUsed) + " used of " : "") + sizeOf(d.diskTotal));
  add("Mitos's copy", `${Number(d.copyRows || 0).toLocaleString()} record${Number(d.copyRows) === 1 ? "" : "s"} in ${Number(d.copyTables || 0).toLocaleString()} table${Number(d.copyTables) === 1 ? "" : "s"}`);
  if (d.lastSync) add("Last sync", ago(d.lastSync));
  if (d.version) add("Mitos", d.version + (d.built ? " · built " + (/^\d{4}-\d\d-\d\d$/.test(d.built) ? new Date(d.built + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : /^\d{4}-\d\d-\d\d/.test(d.built) ? whenShort(d.built) : d.built) : ""));
  add("Build", d.image);
  grid.innerHTML = rows.map(([k, v, x]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}${x ? ` · <span class="tight">${esc(x)}</span>` : ""}</span>`).join("");
}

// ---- AI providers. Any number can be configured at once. The card shows a
// chip per provider (configured, off, or no key); Edit opens a screen with
// one row each: a switch, the key, and what it is used for. A key is tested
// the moment it is entered and saved when it works; no Test button.
const PROVIDERS = {
  anthropic: { label: "Claude", keyLabel: "Anthropic API key", cfgKey: "anthropicKey", uses: "reads the search, picks the best, writes search notes, names tables" },
  openai: { label: "OpenAI", keyLabel: "OpenAI API key", cfgKey: "openaiKey", uses: "the same, plus embeddings for similar meaning" },
  google: { label: "Google", keyLabel: "Google AI (Gemini) API key", cfgKey: "googleKey", uses: "the same, plus embeddings for similar meaning" },
  voyage: { label: "Voyage", keyLabel: "Voyage API key", cfgKey: "voyageKey", uses: "embeddings for similar meaning only" },
};
let modelList = null;
// The card shows only the providers that are on: the name and a dot. Green
// means the key answered just now, red means it did not. Everything else
// (keys, switches, the providers that are off) lives on the Edit screen.
function renderProviders() {
  const box = $("provSummary"); box.innerHTML = "";
  const keys = cfg?.ai?.keys || {};
  const on = Object.entries(PROVIDERS).filter(([p]) => keys[p]?.configured);
  if (!on.length) { const n = el("span", "note"); n.textContent = "none yet"; box.appendChild(n); return; }
  for (const [p, P] of on) {
    const chip = el("span", "provchip");
    chip.innerHTML = `<span class="dot"></span>${P.label}`;
    chip.style.cursor = "pointer"; chip.title = "checking the key...";
    chip.onclick = openProviders;
    box.appendChild(chip);
    postJson("/api/ai/test", { provider: p })
      .then((r) => { chip.classList.add(r.ok ? "on" : "bad"); chip.title = r.ok ? "the key works" : (r.error || "the key did not work"); })
      .catch((e) => { chip.classList.add("bad"); chip.title = e.message; });
  }
}
$("provEdit").onclick = () => openProviders();
$("provDone").onclick = () => { $("provOverlay").classList.remove("open"); loadConfig().catch(() => {}); };
function openProviders() {
  $("provOverlay").classList.add("open");
  renderProviderRows();
}
function renderProviderRows() {
  const box = $("provRows"); box.innerHTML = "";
  const keys = cfg?.ai?.keys || {};
  for (const [p, P] of Object.entries(PROVIDERS)) {
    const k = keys[p] || {};
    const row = el("div", "prv");
    // The switch shows the server's state and nothing else: off until a key
    // passed its test or the switch was set by hand.
    const enabledNow = () => { const e = cfg?.ai?.providers?.[p]?.enabled; return e !== undefined ? Boolean(e) : cfg?.ai?.keys?.[p]?.enabled === true; };
    const sw = document.createElement("input"); sw.type = "checkbox"; sw.className = "sw"; sw.checked = enabledNow(); sw.title = "On or off. The key stays.";
    const body = el("div", "body");
    const nm = el("div", "nm"); nm.textContent = P.label;
    const ds = el("div", "ds"); ds.textContent = "Used for: " + P.uses + ".";
    const inp = document.createElement("input"); inp.type = "password"; inp.autocomplete = "off"; inp.spellcheck = false;
    inp.placeholder = k.hasKey ? "new key replaces the saved one" : P.keyLabel;
    const st = el("div", "st");
    const paintStatus = () => {
      st.className = "st" + (k.configured ? " ok" : k.hasKey ? " warn" : "");
      st.textContent = k.hasKey ? `${k.preview} (${k.source})${k.enabled === false ? " · off" : ""}` : "no key";
      if (k.hasKey && k.source === "in-app") {
        const fg = el("button", "link"); fg.type = "button"; fg.style.marginLeft = "10px"; fg.style.fontSize = "12px";
        fg.textContent = "forget this key" + (k.source === "in-app" ? " (use the server's, if any)" : "");
        fg.onclick = async () => {
          if (!await askOnce("Forget this key?", "Mitos forgets the " + P.label + " key saved here. Add it again any time.", "Forget the key", "Cancel")) return;
          await postJsonQuiet("/api/config", { ai: { [P.cfgKey]: null } });
          await fillModels(true);
          await loadConfig(); renderProviderRows();
        };
        st.appendChild(fg);
      }
    };
    paintStatus();
    // The key tests itself: a pause in typing, Enter, or leaving the field.
    let timer = null, testing = false, lastTried = "";
    const tryKey = async () => {
      const v = inp.value.trim();
      if (!v || v === lastTried || testing || v.length < 16) return;
      testing = true; lastTried = v;
      st.className = "st"; st.textContent = "checking the key...";
      try {
        const r = await postJson("/api/ai/test", { provider: p, key: v });
        if (!r.ok) { st.className = "st warn"; st.textContent = r.error || "That key was rejected."; return; }
        // The server switches the provider on when a key passes. Re-read
        // and paint what it says.
        await postJson("/api/config", { ai: { [P.cfgKey]: v } });
        inp.value = "";
        // A new key opens that provider's models: the lists load again at once.
        await fillModels(true);
        await loadConfig();
        Object.assign(k, cfg?.ai?.keys?.[p] || {});
        sw.checked = enabledNow();
        paintStatus(); st.textContent = "Key works, saved · " + st.textContent;
        $("provNote").textContent = "";
      } catch (e) { st.className = "st warn"; st.textContent = e.message; }
      finally { testing = false; }
    };
    inp.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(tryKey, 700); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); tryKey(); } });
    inp.addEventListener("blur", () => { clearTimeout(timer); tryKey(); });
    sw.onchange = async () => {
      sw.disabled = true;
      try {
        await postJson("/api/config", { ai: { providers: { [p]: { enabled: sw.checked } } } });
        await loadConfig(); Object.assign(k, cfg?.ai?.keys?.[p] || {}); sw.checked = enabledNow(); paintStatus();
      } catch (e) { st.className = "st warn"; st.textContent = e.message; }
      sw.disabled = false;
    };
    body.append(nm, ds, inp, st);
    row.append(sw, body);
    box.appendChild(row);
  }
}
function collectAi() {
  return { namingModel: pickedModel($("namingModelSel")), stages: collectStages() };
}

// ---- The search stages: one row each, one switch each. A switch saves
// itself the moment it is flipped; the model and the numbers save with the
// ---- The search stages: one row each, one switch each. No numbers on the
// page (the best values live in the code); the one choice left is how
// tight Close spellings is. A switch saves itself. Switching on a paid
// stage is a formal step: it shows what it would cost first.
const FUZZY_STEPS = [["Very tight", 0.96], ["Tight", 0.93], ["Normal", 0.90], ["Loose", 0.87], ["Very loose", 0.84]];
const STAGES = [
  { name: "fuzzy", label: "Close spellings", desc: "Names typed wrong: a swapped pair, a missing letter, a space in the wrong place. No model, no key, runs with the exact search." },
  { name: "enrich", label: "Enrichment", desc: "During sync, a fast model writes search notes for each record: other spellings, nicknames, plain words for what it is. Searched, never shown.", model: "chat", paid: true },
  { name: "semantic", label: "Semantic search", desc: "A vector per record, so a description finds the thing. Semantic matches are listed below the exact ones. Vectors are built during sync.", model: "embedding", paid: true },
  { name: "understand", label: "Enhanced search: Interpret meaning", desc: "A model turns a sentence like \"new computers since July\" into an exact search: a date range, the word computers, the Product table.", model: "chat" },
  // Best match is its own switch (a plain rule, no model, no key). AI best
  // match is the rerank stage, shown under it and only while Best match is on.
  { name: "best", label: "Best match", desc: "Marks one record as the best match when it's clearly the one you meant. No model, no key." },
  { name: "rerank", label: "Use AI to determine best match", desc: "A fast model reads the short list and names one best match when it is sure. Below its confidence the list stands as the answer.", model: "chat", sub: "best" },
];
const HELP = {
  fuzzy: `<h4>What it does</h4><p>The exact search wants each word you type to start a word in the record. Close spellings runs beside it and compares your words to record names with Jaro-Winkler, a string similarity from record-linkage work: a number from 0 to 1 that rewards a shared beginning. It is arithmetic, not AI: the same words give the same answer every time.</p>
<p>It tries three views: your whole phrase against the whole name, the space-free forms ("acmesystems"), and each of your words against its nearest word in the name, with the name table applied ("bob" is tried as "robert"). A record scores its weakest word, so every word you typed has to be close to something. Names above the floor join the list, tagged "close spelling", below any exact hit.</p>
<h4>The setting</h4><p>How close a name must be. Examples: "murpy" against "murphy" scores 0.97; "whitfeild" against "whitfield" 0.98; "macon iro" against "marvin cook" 0.88, which is junk. Normal (0.90) keeps the first two and drops the third. Looser shows more and wronger; tighter shows only near-exact slips.</p>
<h4>Speed and cost</h4><p>DuckDB runs the comparison as a compiled function over the whole column, on all cores, after a first-letter gate cuts the candidates: about 80 milliseconds across 95,000 records. Nothing is paid for.</p>
<h4>FileMaker</h4><p>FileMaker has no Levenshtein or Jaro-Winkler function. A custom function can do it, but it evaluates per record and cannot be used by a Find, so it loops: seconds to minutes on a big table. This is one of the things Mitos brings that the file cannot.</p>`,
  semantic: `<h4>What it does</h4><p>During sync, every record is turned into a vector: a list of numbers that stands for its meaning, made by an embedding model. When you search, your words become a vector the same way, and the records whose vectors point the same direction are listed under "Semantic matches", below the exact ones. That is how "mid-range digital SLR" finds a camera whose description never says those words.</p>
<h4>What it shows</h4><p>It always shows its nearest records. When even the nearest is a weak match, the heading says "Perhaps you meant" instead, so you know you are looking at nearest, not near.</p>
<h4>Cost and time</h4><p>One embedding call per record, once. About 75 cents per 100,000 records, and a few minutes. A plain sync embeds only new and changed records, up to 5,000; a bigger job waits for Run on this tab, which shows the count and the price first. Changing the model rebuilds every vector.</p>
<h4>Where the vectors live</h4><p>In their own file next to the index (mitos-vec.duckdb). Deleting it is the reset; the next sync rebuilds it.</p>`,
  enrich: `<h4>What it does</h4><p>During sync, a fast model reads each record and writes search notes for it: other spellings, "Last, First" for a person, nicknames, abbreviations, plain words for what it is. The notes are searched, never shown, and a hit through them says "in the search notes". They also feed the vector, so semantic search sees them too.</p>
<h4>The rules</h4><p>One overall rules text tells the model what to write. Deeper per-table rules come in a later version. The output rules (plain text, nothing invented) are added for you.</p>
<h4>Cost and time</h4><p>One model call per ten records, once per record. With Claude Haiku about 30 dollars per 100,000 records. Switching it on opens a window that shows sample notes for your tables and the price before anything runs. A plain sync writes notes for up to 1,000 new records; more waits for Run.</p>`,
  understand: `<h4>What it does</h4><p>A fast model reads what you typed and rewrites it in the exact search's own syntax: "people with birthdays in the first half of May" becomes a date range, "inv 2216" becomes 2216, "someone named bob whitfeld or something" becomes bob whitfeld. The exact search then runs again on the rewrite, so every hit still has a reason. Rows you already saw never disappear.</p>
<h4>When it runs</h4><p>Only for two or more words. A single word, a number, a date, an email or a phone is already understood. About a second with Claude Haiku; the exact list never waits for it. The same words are read once and remembered.</p>
<h4>Cost</h4><p>A fraction of a cent per search.</p>`,
  best: `<h4>What it does</h4><p>Mitos names one record as the best match, on top of the list, when it is clearly the one you meant. No model and no key: it is a plain rule, so the same words give the same answer every time.</p>
<h4>The rule</h4><p>For words: every word you typed matches the top record (the start of a word counts, so "ram" matches "Ramen"), and the next record scores well below it. Or an email, phone or number that only one record has. A close spelling can also win when it is far ahead of the rest.</p>
<h4>When it is off</h4><p>No record is marked as the best match. The list is the answer. AI best match goes with it, since it hangs on this switch.</p>`,
  rerank: `<h4>What it does</h4><p>A fast model reads your search and the short list, reorders it, and names one best match when it is sure. That record is shown on top as "Best match, picked by AI". Below its confidence the list stands as the answer, and a tie means a list, never a guess.</p>
<h4>Without it</h4><p>Mitos still names a best match by rule (the Best match switch above): every word you typed matches the top record and the next one is well behind, or an email, phone or number that only one record has.</p>
<h4>When it runs</h4><p>Only for word searches with two or more candidates. About a second with Claude Haiku. A fraction of a cent per search.</p>`,
  fields: `<h4>Search</h4><p>The field's values go into the searchable text and the typed columns (numbers, dates, emails, phones), so what you type can match them.</p>
<h4>Show</h4><p>The field's value appears on the result row, in this order, copied exactly from the record. Nothing generated is ever shown.</p>
<h4>Title</h4><p>The one field that is the record's name: the headline of the result row, the field that scores highest (a word in the title counts double), and the field Close spellings compares against. Pick a short name-like field, not a description.</p>
<h4>Left out</h4><p>Dim fields are summaries, globals, unstored calculations, containers, or fields the scan judged unsearchable (UUIDs, JSON blobs, very long text). Turning one on is allowed; the reason is a warning, not a lock.</p>
<h4>Primary key</h4><p>The field Mitos hands back to FileMaker so a script can find the record. It must be a real, stored, unique field. The list offers the fields that can be one.</p>`,
};
function showHelp(key, title) {
  $("helpTitle").textContent = title;
  $("helpBody").innerHTML = HELP[key] || "";
  $("helpOverlay").classList.add("open");
}
$("helpDone").onclick = () => $("helpOverlay").classList.remove("open");
const helpBtn = (key, title) => { const b = el("button", "helpbtn"); b.type = "button"; b.textContent = "?"; b.title = "What this does"; b.onclick = (e) => { e.stopPropagation(); showHelp(key, title); }; return b; };

// ---- Models by job. The list comes from navarre.ai (the server passes it on):
// every model has a job (reasoning, workhorse, cheap, embedding, rerank), and
// the file describes each job in a line. Menus group by job, the stage's
// recommended job first, recommended models marked.
const JOB_ORDER = ["reasoning", "workhorse", "cheap", "embedding", "rerank"];
const jobName = (j) => String(j || "").charAt(0).toUpperCase() + String(j || "").slice(1);
const jobHead = (j) => j === "other" ? "Models" : jobName(j) + (modelList?.jobs?.[j] ? ": " + modelList.jobs[j] : "");
const recJob = (stage) => modelList?.recommended?.[stage] || "";
// Matt's words for the AI best match: medium to low.
function recHint(stage) {
  if (stage === "rerank") return "Recommended: medium to low";
  const j = recJob(stage);
  return j ? "Recommended: " + j : "";
}
// "default (id)": the server's own pick for the stage.
function defaultLabel(stage, s) {
  const id = s?.defaultModel || cfg?.ai?.defaults?.[stage] || "";
  return "default" + (id ? " (" + id + ")" : "");
}
// Chat models can run a stage; embedding and rerank models cannot.
const isChatModel = (m) => m.kind !== "embedding" && m.job !== "embedding" && m.job !== "rerank";
// Adds the models to a select, grouped by job: the stage's recommended job
// first, then the rest in the file's order. Only models whose provider has a key.
function addJobOptions(sel, models, stage) {
  const rec = recJob(stage);
  // A model with no job (the public list could not be loaded) goes in one plain group.
  models = models.map((m) => (m.job ? m : { ...m, job: "other" }));
  const have = new Set(models.map((m) => m.job));
  const order = [rec, ...JOB_ORDER, ...[...have].filter((j) => !JOB_ORDER.includes(j))].filter((j, i, a) => j && have.has(j) && a.indexOf(j) === i);
  const multi = new Set(models.map((m) => m.provider)).size > 1;
  for (const job of order) {
    const g = document.createElement("optgroup"); g.label = jobHead(job);
    for (const m of models.filter((x) => x.job === job)) {
      const o = document.createElement("option"); o.value = m.id;
      o.textContent = (multi ? (PROVIDERS[m.provider]?.label || m.provider) + " · " : "") + (m.name || m.id) + (m.recommended ? " (recommended)" : "");
      const price = m.in != null && m.out != null ? "$" + m.in + " in, $" + m.out + " out per million tokens" : "";
      o.title = [m.note, price].filter(Boolean).join(" · ");
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
}
// The model a menu should land on when nothing is saved: the stage's
// recommended model, else the first one shown.
const recommendedPick = (models, stage) => (models.find((m) => m.recommended && m.job === recJob(stage)) || models.find((m) => m.recommended) || models[0] || {}).id || "";
// An embedding model that can be called now: its provider has a key.
const hasEmbedModel = () => (modelList?.models || []).some((m) => m.kind === "embedding" && m.usable);

// The AI tab's stage list by default; the wizard's AI stages step passes its
// own container. The paid-passes card belongs to the AI tab only.
function renderStages(target) {
  const box = target || $("stageList"); box.innerHTML = "";
  const inTab = box === $("stageList");
  const st = cfg?.ai?.stages || {};
  const cov = cfg?.ai?.coverage || {};
  const all = modelList?.models || [];
  const keys = cfg?.ai?.keys || {};
  const post = async (patch) => { await postJson("/api/config", { ai: { stages: patch } }); await loadConfig(); };
  for (const S of STAGES) {
    // AI best match hangs under Best match: no switch, no row.
    if (S.sub && !st[S.sub]?.on) continue;
    const s = st[S.name] || {};
    const row = el("div", "stg" + (S.sub ? " sub" : ""));
    const sw = document.createElement("input"); sw.type = "checkbox"; sw.className = "sw"; sw.checked = Boolean(s.on); sw.dataset.stage = S.name;
    const body = el("div", "body");
    const nm = el("div", "nm"); nm.textContent = S.label; nm.appendChild(helpBtn(S.name, S.label));
    const ds = el("div", "ds"); ds.textContent = S.desc;
    const ctl = el("div", "ctl");
    // Semantic search needs a provider that offers embeddings. Without a key
    // for one: say so, offer the way in, no menu, and the switch stays off.
    const needsKey = S.name === "semantic" && !hasEmbedModel();
    if (needsKey) {
      sw.disabled = !s.on;
      const msg = el("span"); msg.textContent = "No embedding model found. Add a Google, OpenAI or Voyage key, or refresh the model list.";
      const add = el("button", "btn"); add.type = "button"; add.textContent = "Add a key"; add.style.fontSize = "12px"; add.style.padding = "4px 10px";
      add.onclick = openProviders;
      const rf = el("button", "btn"); rf.type = "button"; rf.textContent = "Refresh the list"; rf.style.fontSize = "12px"; rf.style.padding = "4px 10px";
      rf.onclick = async () => { rf.disabled = true; rf.textContent = "Refreshing..."; await fillModels(true); };
      ctl.append(msg, add, rf);
    } else if (S.model) {
      const sel = document.createElement("select"); sel.dataset.stage = S.name; sel.dataset.field = "model";
      const usable = all.filter((m) => (S.model === "embedding" ? m.kind === "embedding" : isChatModel(m)) && (m.usable ?? keys[m.provider]?.configured));
      // default (id): the server's own pick for this stage, by tier.
      const o0 = document.createElement("option"); o0.value = ""; o0.textContent = defaultLabel(S.name, s); sel.appendChild(o0);
      addJobOptions(sel, usable, S.name);
      const lab = el("span"); lab.textContent = "model"; ctl.append(lab, sel);
      // A model change on a paid stage is a rebuild: say so, and save only on a yes.
      modelPicker(sel, async (id) => {
        if (S.paid && s.on) {
          const est = await apiJson("/api/ai/estimate").catch(() => null);
          const n = S.name === "semantic" ? (cov.totalRows || 0) : (est?.enrich?.rows || 0);
          if (!await askOnce("Change the model?", `Changing the model rebuilds ${S.name === "semantic" ? "every vector" : "the notes"}: ${Number(n).toLocaleString()} records on the next Run.`, "Change it", "Cancel")) { setPicked(sel, s.savedModel || ""); return; }
        }
        await postJson("/api/config", { ai: { stages: { [S.name]: { model: id } } } });
        await loadConfig();
      });
      setPicked(sel, s.savedModel || "");
      const hint = recHint(S.name);
      if (hint) { const h = el("div", "rec"); h.textContent = hint; ctl.appendChild(h); }
    }
    if (S.name === "fuzzy") {
      const sel = document.createElement("select");
      for (const [label, v] of FUZZY_STEPS) { const o = document.createElement("option"); o.value = String(v); o.textContent = label; sel.appendChild(o); }
      const cur = Number(s.minSim) || 0.9;
      sel.value = String(FUZZY_STEPS.reduce((best, [, v]) => (Math.abs(v - cur) < Math.abs(best - cur) ? v : best), 0.9));
      sel.onchange = async () => { await postJson("/api/config", { ai: { stages: { fuzzy: { minSim: Number(sel.value) } } } }); await loadConfig(); };
      const lab = el("span"); lab.textContent = "how close"; ctl.append(lab, sel);
    }
    if (S.model && !needsKey) {
      const tb = el("button", "btn"); tb.type = "button"; tb.textContent = "Test"; tb.style.fontSize = "12px"; tb.style.padding = "4px 10px";
      tb.onclick = async () => {
        status.className = "st"; status.textContent = "testing...";
        try {
          const r = await postJson("/api/ai/test", { which: S.name });
          status.className = "st " + (r.ok ? "ok" : "warn"); status.textContent = r.ok ? r.note : (r.error || "failed");
        } catch (e) { status.className = "st warn"; status.textContent = e.message; }
      };
      ctl.appendChild(tb);
    }
    // The status line only when it says something the switch does not.
    const status = el("div", "st");
    if (s.on && !s.ready && !needsKey) { status.className = "st warn"; status.textContent = "on, but cannot run: " + (s.why || "no key") + ". Add the key under Providers."; }
    else if (s.on && S.name === "semantic") {
      const sv = semCounts();
      status.className = "st ok";
      status.textContent = sv.vectors >= sv.rows ? "Every record already has a vector." : `${sv.vectors.toLocaleString()} of ${sv.rows.toLocaleString()} records have vectors (see Paid passes below)`;
    }
    else if (s.on && S.name === "enrich") { status.className = "st ok"; status.textContent = `${Number(cov.enriched || 0).toLocaleString()} records have notes`; }
    sw.onchange = async () => {
      // Off is always one click. On is a formal step for the paid stages.
      if (S.name === "semantic" && !sw.checked) { sw.checked = true; semanticOff(status, sw); return; }
      if (!sw.checked || !S.paid) {
        sw.disabled = true;
        try {
          // Best match off takes AI best match with it: a model must not go on
          // reading the list, and being paid for, behind a hidden switch.
          if (S.name === "best" && !sw.checked) await post({ best: { on: false }, rerank: { on: false } });
          else await post({ [S.name]: { on: sw.checked } });
        }
        catch (e) { status.className = "st warn"; status.textContent = e.message; sw.disabled = false; }
        return;
      }
      sw.checked = false;
      if (S.name === "semantic") semanticOn(status, sw);
      else openEnrichWindow();
    };
    body.append(nm, ds, ctl, status);
    row.append(sw, body);
    box.appendChild(row);
  }
  if (inTab) renderPasses();
}
function collectStages() { return {}; }

// ---- The paid-pass gate. Switching Semantic search on shows the count and
// the price, then Run now or Later. Later saves the switch and leaves a
// banner; a plain sync stays under its cap.
// A pass cost: under one cent says so; otherwise dollars, two decimals.
const money = (n) => { const v = Number(n) || 0; return v > 0 && v < 0.01 ? "less than 1¢" : "$" + v.toFixed(2); };
const aboutMoney = (n) => { const m = money(n); return m.startsWith("less") ? m : "about " + m; };
const fmtBytes = (n) => { const b = Number(n) || 0; return b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : b >= 1048576 ? Math.round(b / 1048576).toLocaleString() + " MB" : Math.max(1, Math.round(b / 1024)).toLocaleString() + " KB"; };
// What the vectors cover right now: only tables with semantic search on count.
function semCounts() {
  const cov = cfg?.ai?.coverage || {};
  const ts = (cov.tables || []).filter((t) => semOn(t.src_table) !== false);
  if (!ts.length) return { rows: Number(cov.totalRows || 0), vectors: Number(cov.embedded || 0), bytes: 0 };
  return { rows: ts.reduce((a, t) => a + Number(t.rows || 0), 0), vectors: ts.reduce((a, t) => a + Number(t.vectors ?? t.embedded ?? 0), 0), bytes: ts.reduce((a, t) => a + Number(t.vectorBytes || 0), 0) };
}
const allVectors = () => {
  const cov = cfg?.ai?.coverage || {};
  const ts = cov.tables || [];
  return { n: ts.length ? ts.reduce((a, t) => a + Number(t.vectors ?? t.embedded ?? 0), 0) : Number(cov.embedded || 0), bytes: ts.reduce((a, t) => a + Number(t.vectorBytes || 0), 0) };
};
async function setSemantic(on) { await postJson("/api/config", { ai: { stages: { semantic: { on } } } }); await loadConfig(); }
// Switching ON: with nothing to build the switch just turns on; otherwise the
// gate shows the count and the price first. The count is the estimate's, never
// the total row count.
async function semanticOn(status, sw) {
  status.className = "st"; status.textContent = "checking...";
  const est = await apiJson("/api/ai/estimate").catch(() => null);
  if (!est?.embed) { status.className = "st warn"; status.textContent = "Could not read the price. Try again."; return; }
  if (!Number(est.embed.rows)) {
    try { await setSemantic(true); } catch (e) { status.className = "st warn"; status.textContent = e.message; }
    return;
  }
  status.textContent = "";
  openSemanticGate(est);
}
// Switching OFF deletes the vectors (they take room on the disk): ask first,
// with the server's numbers.
async function semanticOff(status, sw) {
  const v = allVectors();
  const est = await apiJson("/api/ai/estimate").catch(() => null);
  const cost = Number(est?.embed?.rebuildCost) || (Number(est?.embed?.rows) > 0 ? Number(est.embed.cost) / Number(est.embed.rows) * v.n : 0);
  const text = v.n
    ? `Turning off semantic search deletes all ${v.n.toLocaleString()} vectors${v.bytes ? " (" + fmtBytes(v.bytes) + ")" : ""}. Turning it back on rebuilds them${cost ? ", " + aboutMoney(cost) : ""}.`
    : "Semantic search turns off. There are no vectors to delete.";
  if (!await askOnce("Turn off semantic search?", text, v.n ? "Turn off and delete" : "Turn off", "Cancel")) { sw.checked = true; return; }
  sw.disabled = true; status.className = "st"; status.textContent = "Deleting the vectors...";
  const r = await dzPost("/api/ai/semantic/off", {});
  if (r.error) { status.className = "st warn"; status.textContent = dzSaid(r); sw.checked = true; sw.disabled = false; return; }
  await loadConfig();
  const st2 = document.querySelector('#stageList .stg input[data-stage="semantic"]')?.closest(".stg")?.querySelector(".st");
  if (st2) { st2.className = "st ok"; st2.textContent = `Deleted ${Number(r.deleted || 0).toLocaleString()} vector${Number(r.deleted) === 1 ? "" : "s"}${r.bytesFreed ? ", freed " + fmtBytes(r.bytesFreed) : ""}.`; }
}
async function openSemanticGate(est) {
  const model = est.embed.model || cfg?.ai?.stages?.semantic?.model || "the default model";
  const need = Number(est.embed.rows) || 0, cost = Number(est.embed.cost) || 0;
  $("syncConfirmBody").innerHTML =
    `<div><strong>Semantic search</strong> builds one vector per record with <strong>${esc(model)}</strong>.</div>` +
    `<div style="margin-top:10px">${need.toLocaleString()} record${need === 1 ? "" : "s"} need${need === 1 ? "s" : ""} vectors, <strong>${aboutMoney(cost)}</strong> and a few minutes.</div>` +
    `<div class="note" style="margin-top:10px">Run now builds them all. Later switches the stage on and builds up to 5,000 per sync; the rest waits for Run on the AI tab.</div>`;
  $("syncConfirmOverlay").querySelector(".p-head strong").textContent = "Semantic search";
  $("syncConfirmOverlay").classList.add("open");
  $("syncConfirmCancel").textContent = "Cancel";
  $("syncConfirmGo").textContent = "Run now";
  const later = $("syncConfirmLater"); later.style.display = ""; later.textContent = "Later";
  $("syncConfirmCancel").onclick = () => { $("syncConfirmOverlay").classList.remove("open"); };
  later.onclick = async () => { $("syncConfirmOverlay").classList.remove("open"); await setSemantic(true); };
  $("syncConfirmGo").onclick = async () => { $("syncConfirmOverlay").classList.remove("open"); await setSemantic(true); runSync(null, { full: true, stagesOnly: true }); };
}
async function renderPasses() {
  const box = $("passList"); if (!box) return;
  box.innerHTML = '<div class="note">checking...</div>';
  const est = await apiJson("/api/ai/estimate").catch(() => null);
  box.innerHTML = "";
  if (!est) { box.innerHTML = '<div class="note">could not read the estimate</div>'; return; }
  const line = (k, v, run) => {
    const d = el("div", "pass");
    const kk = el("span", "k"); kk.textContent = k;
    const vv = el("span"); vv.textContent = v; vv.style.flex = "1";
    d.append(kk, vv);
    if (run) { const b = el("button", "btn primary"); b.type = "button"; b.textContent = "Run"; b.style.fontSize = "12px"; b.style.padding = "4px 12px"; b.onclick = run; d.appendChild(b); }
    box.appendChild(d);
  };
  const e = est.embed, n = est.enrich;
  const runStages = () => runSync(null, { full: true, stagesOnly: true });
  // Enrichment counts come from the index itself (tables[].notes of
  // tables[].rows), never from the ledger. Without them, the pending count.
  const nt = (n.tables || []).filter((t) => t.notes != null);
  const notes = nt.reduce((a, t) => a + Number(t.notes || 0), 0), rows = nt.reduce((a, t) => a + Number(t.rows || 0), 0);
  const pending = nt.length ? Math.max(0, rows - notes) : Number(n.rows || 0);
  let enrichTxt;
  if (!n.on) enrichTxt = "off";
  else if (nt.length) enrichTxt = `${notes.toLocaleString()} of ${rows.toLocaleString()} records have notes` + (pending ? ` · ${aboutMoney(n.cost)} for the rest · ${n.model}` : "");
  else enrichTxt = pending ? `${pending.toLocaleString()} records need notes · ${aboutMoney(n.cost)} · ${n.model}` : "every chosen record has notes";
  line("Enrichment", enrichTxt, n.on && pending ? runStages : null);
  line("Semantic search", !e.on ? "off" : !hasEmbedModel() ? "no embedding model found" : e.rows ? `${Number(e.rows).toLocaleString()} records need vectors · ${aboutMoney(e.cost)} · ${e.model}` : "every record has a vector", e.on && e.rows && hasEmbedModel() ? runStages : null);
  const led = el("div", "ledger");
  if (!est.passes?.length) led.textContent = "No paid pass has run yet.";
  else for (const p of est.passes) { const d = el("div"); d.textContent = `${ago(p.at)} · ${p.kind === "embed" ? "vectors" : "notes for " + (p.label || p.table)} · ${Number(p.rows).toLocaleString()} records · ${Math.round((p.ms || 0) / 1000)}s · ${money(p.cost)} · ${p.model}`; led.appendChild(d); }
  box.appendChild(led);
}

// ---- The enrichment window: model, the overall rules, the tables, a live
// preview on sample records, the price, then Run now or Later.
async function openEnrichWindow() {
  const o = $("enrichOverlay");
  o.classList.add("open");
  const s = cfg?.ai?.stages?.enrich || {};
  const all = (modelList?.models || []).filter((m) => isChatModel(m) && (m.usable ?? cfg?.ai?.keys?.[m.provider]?.configured));
  const sel = $("enModel"); sel.innerHTML = "";
  const o0 = document.createElement("option"); o0.value = ""; o0.textContent = defaultLabel("enrich", s); sel.appendChild(o0);
  addJobOptions(sel, all, "enrich");
  $("enHint").textContent = recHint("enrich");
  modelPicker(sel, () => {}); // read at Later or Run now
  setPicked(sel, s.savedModel || "");
  $("enPrompt").value = s.prompt || "";
  $("enPrompt").placeholder = "Blank uses the built-in rules: other spellings and abbreviations people might type, Last, First for a person, nicknames, one plain line saying what it is.";
  const tl = $("enTables"); tl.innerHTML = "";
  for (const [raw, t] of Object.entries(cfg?.tables || {})) {
    const lab = document.createElement("label"); lab.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px;color:var(--text)";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = raw; cb.checked = Boolean(t.enrich?.on); cb.style.cssText = "width:15px;height:15px;accent-color:var(--accent);margin:0";
    const cov = (cfg?.ai?.coverage?.tables || []).find((x) => x.src_table === raw);
    lab.append(cb, document.createTextNode(friendly(raw) + (cov ? ` (${Number(cov.rows).toLocaleString()} records)` : "")));
    tl.appendChild(lab);
  }
  $("enPreview").innerHTML = ""; $("enEstimate").textContent = "";
  const picked = () => [...tl.querySelectorAll("input:checked")].map((c) => c.value);
  const estimate = async () => {
    const rows = picked().reduce((a, raw) => a + Number((cfg?.ai?.coverage?.tables || []).find((x) => x.src_table === raw)?.rows || 0), 0);
    // The price per million tokens comes from the model list: about 150 tokens
    // in and 120 out for each record.
    const mid = pickedModel(sel) || s.defaultModel || cfg?.ai?.defaults?.enrich || "";
    const mm = (modelList?.models || []).find((m) => m.id === mid);
    const per = mm && mm.in != null && mm.out != null ? (150 * mm.in + 120 * mm.out) / 1e6 : 0.0003;
    $("enEstimate").textContent = rows ? `${rows.toLocaleString()} records, ${aboutMoney(rows * per)} with ${mm?.name || mid || "the default model"}, one call per ten records.` : "Pick at least one table.";
  };
  tl.onchange = estimate; sel.addEventListener("change", estimate); estimate();
  $("enPreviewBtn").onclick = async () => {
    const tables = picked(); if (!tables.length) { $("enPreview").innerHTML = '<div class="note">Pick a table first.</div>'; return; }
    $("enPreview").innerHTML = '<div class="note">writing sample notes... (a few cents)</div>';
    try {
      const r = await postJson("/api/ai/enrich-preview", { tables, prompt: $("enPrompt").value, model: pickedModel(sel) });
      if (r.error) { $("enPreview").innerHTML = `<div class="note" style="color:var(--warn)">${esc(r.error)}</div>`; return; }
      const box = $("enPreview"); box.innerHTML = "";
      for (const t of r.tables) {
        const h = el("div"); h.style.cssText = "font-weight:600;margin:10px 0 4px"; h.textContent = t.label + (t.error ? ": " + t.error : ` (${t.ms} ms)`); box.appendChild(h);
        for (const n of t.notes || []) {
          const d = el("div"); d.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:6px 0;border-top:1px solid var(--line);font-size:12.5px";
          const a = el("div"); a.style.whiteSpace = "pre-wrap"; a.style.color = "var(--dim)"; a.textContent = n.source_text.slice(0, 400);
          const b = el("div"); b.style.whiteSpace = "pre-wrap"; b.textContent = n.notes || "(nothing written)";
          d.append(a, b); box.appendChild(d);
        }
      }
    } catch (e) { $("enPreview").innerHTML = `<div class="note" style="color:var(--warn)">${esc(e.message)}</div>`; }
  };
  const save = async (on) => {
    const tables = {};
    for (const [raw, t] of Object.entries(cfg?.tables || {})) tables[raw] = { ...t, enrich: { on: on && picked().includes(raw), prompt: t.enrich?.prompt || "" } };
    await postJson("/api/config", { tables, ai: { stages: { enrich: { on, model: pickedModel(sel), prompt: $("enPrompt").value } } } });
    await loadConfig();
  };
  $("enCancel").onclick = () => o.classList.remove("open");
  $("enLater").onclick = async () => { o.classList.remove("open"); await save(true); };
  $("enRun").onclick = async () => { o.classList.remove("open"); await save(true); runSync(null, { full: true, stagesOnly: true }); };
}
// ---- "Other...": every model picker ends with it. Chosen, it shows a small
// text box next to the select; the typed id is added to the list, selected,
// and handed to the same apply(id) a picked option goes through. apply is
// what saving means for that picker: a POST for the stage rows, nothing for
// the pickers whose value is read at Save.
const OTHER = "__other__";
function setPicked(sel, id) {
  // Select id, adding it (above Other...) when the list does not have it.
  if (id && ![...sel.options].some((o) => o.value === id)) {
    const o = document.createElement("option"); o.value = id; o.textContent = id;
    const other = [...sel.options].find((x) => x.value === OTHER);
    sel.insertBefore(o, other && other.parentNode === sel ? other : null);
  }
  sel.value = id || "";
}
function modelPicker(sel, apply) {
  const o = document.createElement("option"); o.value = OTHER; o.textContent = "Other..."; sel.appendChild(o);
  let inp = sel.nextElementSibling;
  if (!inp || !inp.classList.contains("other-id")) {
    inp = document.createElement("input"); inp.type = "text"; inp.className = "other-id"; inp.placeholder = "model id";
    inp.autocomplete = "off"; inp.spellcheck = false; inp.style.display = "none";
    sel.insertAdjacentElement("afterend", inp);
  }
  let prev = sel.value;
  const commit = () => {
    const id = inp.value.trim();
    inp.style.display = "none"; inp.value = "";
    if (!id) { sel.value = prev; return; }
    setPicked(sel, id); prev = id; apply(id);
  };
  inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { inp.value = ""; commit(); } };
  inp.onblur = commit;
  sel.onchange = () => {
    if (sel.value !== OTHER) { prev = sel.value; apply(sel.value); return; }
    inp.style.display = ""; inp.focus();
  };
}
// The picker's value for saving: a real id, never the Other... marker.
const pickedModel = (sel) => (sel.value && sel.value !== OTHER ? sel.value : "");
function fillSelect(sel, models, current, allowNone, noneLabel, stage) {
  sel.innerHTML = "";
  if (allowNone) { const o = document.createElement("option"); o.value = ""; o.textContent = noneLabel || "not set"; sel.appendChild(o); }
  addJobOptions(sel, models, stage || "naming");
  const seen = [...sel.options].some((o) => o.value === current);
  if (current) {
    if (seen) sel.value = current;
    // The configured model may belong to the other provider or be gone from
    // the list. Keep it visible rather than silently switching.
    else { const o = document.createElement("option"); o.value = current; o.textContent = current; o.selected = true; sel.insertBefore(o, sel.firstChild); }
  }
}
function fillModelSelects() {
  const all = modelList?.models || [];
  const keys = cfg?.ai?.keys || {};
  // Every enabled provider's chat models, grouped by provider.
  const chat = all.filter((m) => isChatModel(m) && (m.usable ?? keys[m.provider]?.configured));
  const cur = cfg?.ai?.models || {};
  fillSelect($("namingModelSel"), chat, cur.naming || cfg?.ai?.naming?.model, false, "", "naming");
  $("namingHint").textContent = recHint("naming");
  modelPicker($("namingModelSel"), () => {}); // read at Save
  renderStages();
  // A switch flipped inside the wizard reloads config; its list follows.
  if (wiz.open && wiz.step === 6) renderStages($("wizStages"));
}
// The model list is navarre.ai's, passed on by the server. Never a list baked
// into this file.
async function fillModels(refresh) {
  try { modelList = await apiJson("/api/ai/models" + (refresh ? "?refresh=1" : "")); } catch { modelList = modelList || { models: [] }; }
  fillModelSelects();
}

// ---- Danger zone (Settings tab, the last card). Everything that
// deletes, in one place; each asks once. FileMaker is never touched by any of
// it. Pythia's pattern.
// Reset keys, as the server knows them. Ticked at first: what a reset has
// always wiped (the index and the copies).
const RESET_ITEMS = [
  ["index", "Search index and vectors", "Search comes back empty until the next sync."],
  ["copies", "Local copies of your tables", "What Mitos synced from FileMaker. Sync again to get it back."],
  ["notes", "AI search notes", "The notes a model wrote for each record. Written again on a sync."],
  ["config", "FileMaker connection and table choice", "Mitos goes back to the setup wizard."],
  ["keys", "Saved AI keys", "Mitos cannot use AI until you add a key again."],
  ["logs", "Search and click log", "The list on the Log tab."],
  ["sessions", "Sign-ins", "Everyone is signed out, you too."],
];
const RESET_TICKED = ["index", "copies"];
// Every call the Danger zone makes. A page that is not JSON (a proxy's 502)
// or no answer at all comes back as { error }, said plainly, with the status;
// a JSON answer, a 409 included, comes back as the server wrote it.
async function dzCall(path, opts) {
  let r, txt;
  try { r = await fetch(path, opts); txt = await r.text(); }
  catch { return { error: "the server did not answer. Try again.", status: 0 }; }
  let j = null; try { j = JSON.parse(txt); } catch {}
  if (r.status === 401) { location.href = "/signin?next=" + encodeURIComponent(location.pathname + location.search); return { error: "You are signed out. Sign in again.", status: 401 }; }
  if (!j || typeof j !== "object") return { error: `the server answered ${r.status}, and it was not a Mitos answer. Try again.`, status: r.status };
  if (!r.ok && !j.error) j.error = `the server answered ${r.status}. Try again.`;
  return { ...j, status: r.status };
}
const dzPost = (path, body) => dzCall(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const dzSaid = (r) => (r.status >= 400 && r.status < 500 ? r.error : "Not done: " + r.error);
function askOnce(title, text, verb, noLabel = "Close") {
  $("askTitle").textContent = title; $("askText").textContent = text;
  $("askYes").textContent = verb; $("askNo").textContent = noLabel;
  $("askOverlay").classList.add("open");
  return new Promise((resolve) => {
    const done = (v) => { $("askOverlay").classList.remove("open"); resolve(v); };
    $("askYes").onclick = () => done(true); $("askNo").onclick = () => done(false);
  });
}
const resetTicked = () => [...$("resetList").querySelectorAll("input:checked")].map((i) => i.value);
function paintResetGo() {
  const n = resetTicked().length, all = n === $("resetList").querySelectorAll("input").length;
  $("resetGo").disabled = n === 0;
  $("resetGo").textContent = all ? "Wipe everything" : "Wipe what is ticked";
  $("resetLead").textContent = all
    ? "This is a total wipe. Mitos goes back to a fresh install, with no connection and no keys."
    : n === 0 ? "Tick at least one thing to wipe." : "Tick what to wipe. The boxes ticked already are what a reset has always wiped.";
  $("resetLead").style.color = all ? "var(--warn)" : "var(--dim)";
}
$("dzReset").onclick = () => {
  const list = $("resetList"); list.innerHTML = "";
  for (const [key, name, line] of RESET_ITEMS) {
    if (key === "sessions" && gateOff()) continue;
    const row = el("label", "rs-row");
    row.innerHTML = `<input type="checkbox" value="${key}"${RESET_TICKED.includes(key) ? " checked" : ""}><div><div class="rs-n">${esc(name)}</div><div class="rs-d">${esc(line)}</div></div>`;
    row.querySelector("input").onchange = paintResetGo;
    list.appendChild(row);
  }
  $("resetMsg").textContent = "";
  paintResetGo();
  $("resetOverlay").classList.add("open");
};
$("resetAll").onclick = () => { $("resetList").querySelectorAll("input").forEach((i) => { i.checked = true; }); paintResetGo(); };
$("resetCancel").onclick = () => $("resetOverlay").classList.remove("open");
// The page's own memory of what was wiped: nothing may remember an old server
// or an old key (the wizard would offer them again).
function forgetWiped(items) {
  if (items.includes("copies") || items.includes("index")) syncedSet = new Set();
  if (items.includes("config")) {
    for (const id of ["fmHost", "fmUser", "fmDb", "fmPass", "wizHost", "wizUser", "wizPass"]) $(id).value = "";
    $("fmPass").placeholder = ""; $("wizPass").placeholder = ""; $("fmTestStatus").textContent = "";
    loadedFm = { host: "", db: "", user: "", hasPass: false };
    scannedTables = null; $("tblList").innerHTML = ""; activeTab = null; displayNames = {};
    Object.assign(wiz, { connOk: false, filesOk: false, scanOk: false, keySkipped: false, stagesSeen: false, tables: [], picked: new Set(), saved: [], finishing: false });
    wizLine("wizConnOk", ""); wizLine("wizFilesOk", ""); wizLine("wizScanOk", "");
  }
  if (items.includes("keys")) { hasKeyNow = false; wiz.keyOk = false; $("wizKey").value = ""; wizLine("wizKeyOk", ""); }
}
$("resetGo").onclick = async () => {
  const items = resetTicked(); if (!items.length) return;
  // The red button asks once more, in the app's own panel.
  const sure = items.length === $("resetList").querySelectorAll("input").length
    ? await askOnce("Wipe everything?", "Mitos goes back to a fresh install, with no connection and no keys. Nothing in FileMaker changes.", "Wipe everything")
    : await askOnce(items.length === 1 ? "Wipe this one thing?" : `Wipe these ${items.length} things?`,
      RESET_ITEMS.filter(([k]) => items.includes(k)).map(([, n]) => "· " + n).join("\n") + "\n\nNothing in FileMaker changes.", "Wipe what is ticked");
  if (!sure) return;
  $("resetGo").disabled = true; $("resetMsg").style.color = "var(--dim)"; $("resetMsg").textContent = "Wiping...";
  const r = await dzPost("/api/reset", { items });
  // A refusal (a sync running) is said as the server says it.
  if (r.error) { $("resetMsg").style.color = "var(--warn)"; $("resetMsg").textContent = dzSaid(r); paintResetGo(); return; }
  $("resetOverlay").classList.remove("open");
  const wiped = Array.isArray(r.wiped) ? r.wiped : items;
  forgetWiped(wiped);
  // Signed out means signed out: the sign-in page is the next screen.
  if (wiped.includes("sessions")) { location.href = "/signin"; return; }
  await loadConfig(); refreshStatus();
  // A wipe of the connection goes back to the setup wizard, at step 1.
  const kept = (r.keptOnServer || []).map((k) => k === "config" ? "its FileMaker connection" : k === "keys" ? "its AI keys" : k);
  $("dzMsg").textContent = `Wiped ${wiped.length} thing${wiped.length === 1 ? "" : "s"}. Nothing in FileMaker changed.` +
    (kept.length ? ` The server still has ${kept.join(" and ")} of its own, set outside Mitos, so Mitos still uses ${kept.length === 1 && /connection/.test(kept[0]) ? "it" : "them"}.` : "");
  if (r.needsSetup || wiped.includes("config")) { await openWizard(true); return; }
};
// Delete the local copy of one table. The server unticks it as well.
$("dzDrop").onclick = () => {
  const sel = $("dropPick"); sel.innerHTML = "";
  $("dropMsg").textContent = "";
  const synced = (cfg?.index?.tables || []).slice().sort((a, b) => byFriendly(a.src_table, b.src_table));
  for (const t of synced) {
    const o = document.createElement("option"); o.value = t.src_table;
    const n = Number(t.rows ?? t.n ?? t.count);
    o.textContent = friendly(t.src_table) + (friendly(t.src_table) !== t.src_table ? ` (${t.src_table})` : "") + (Number.isFinite(n) ? `, ${n.toLocaleString()} records` : "");
    sel.appendChild(o);
  }
  if (!synced.length) { const o = document.createElement("option"); o.value = ""; o.textContent = "Nothing is synced yet"; sel.appendChild(o); }
  $("dropGo").disabled = !synced.length;
  $("dropOverlay").classList.add("open");
};
$("dropCancel").onclick = () => $("dropOverlay").classList.remove("open");
$("dropGo").onclick = async () => {
  const raw = $("dropPick").value; if (!raw) return;
  const label = friendly(raw);
  $("dropGo").disabled = true; $("dropMsg").style.color = "var(--dim)"; $("dropMsg").textContent = "Deleting...";
  const r = await dzPost("/api/tables/drop", { table: raw });
  if (r.error) { $("dropMsg").style.color = "var(--warn)"; $("dropMsg").textContent = dzSaid(r); $("dropGo").disabled = false; return; }
  $("dropOverlay").classList.remove("open");
  syncedSet.delete(raw); scannedTables = null;
  await loadConfig(); refreshStatus();
  $("dzMsg").textContent = `Deleted Mitos's local copy of ${label}. Your FileMaker data is untouched. Tick it again on the Tables tab and sync to bring it back.`;
};
$("dzRebuild").onclick = async () => {
  if (!await askOnce("Rebuild the search index?", "Mitos builds the index again from its local copies. Nothing is read from FileMaker. Search is thin until it is done.", "Rebuild", "Close")) return;
  runSync(null, { rebuild: true });
};
$("dzSignout").onclick = async () => {
  if (!await askOnce("Sign everyone out?", "Everyone who is signed in, you too, has to sign in again. Nothing is deleted.", "Sign out all")) return;
  const r = await dzPost("/api/reset", { items: ["sessions"] });
  if (r.error) { $("dzMsg").textContent = dzSaid(r); return; }
  location.href = "/signin";
};
// Delete this Mitos: wipe everything, then the one command Mitos cannot run
// itself. Only on Fly, where the server says its app name.
$("dzDelete").onclick = async () => {
  if (!flyApp) return;
  if (!await askOnce("Delete this Mitos?", "Mitos wipes everything it holds: the index, the copies, the notes, the connection, the keys, the logs and every sign-in. Nothing in FileMaker changes. Then it shows the one command that removes the server itself.", "Wipe everything")) return;
  const r = await dzPost("/api/reset", { items: RESET_ITEMS.map(([k]) => k) });
  if (r.error) { $("dzMsg").textContent = dzSaid(r); return; }
  $("settings").classList.remove("open");
  $("destroyCmd").textContent = "fly apps destroy " + flyApp;
  $("destroyNote").textContent = "";
  $("destroyOverlay").classList.add("open");
};
$("destroyClose").onclick = () => { $("destroyOverlay").classList.remove("open"); location.href = "/signin"; };
$("destroyCopy").onclick = async () => {
  const txt = $("destroyCmd").textContent;
  let ok = false;
  try { await navigator.clipboard.writeText(txt); ok = true; } catch {}
  if (!ok) {
    // A web viewer may refuse the clipboard API: select the text and copy.
    try { const rg = document.createRange(); rg.selectNodeContents($("destroyCmd")); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(rg); ok = document.execCommand("copy"); } catch {}
  }
  $("destroyNote").textContent = ok ? "Copied." : "Copy did not work here. Select the command and copy it by hand.";
};
