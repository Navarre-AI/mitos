// fm.js — FileMaker client for Pythia. OData side: metadata, counts.
// The OData $metadata carries more than the docs advertise: per-entity
// com.filemaker.odata.TableID (FMTID) annotations let us group table
// occurrences back to their BASE TABLE, NavigationProperty elements carry
// the relationships graph, and FMComment annotations carry developer
// field comments. We lean on all three.

import "./env.js";

// Live connection (Pythia's pattern). Seeded from env, but the in-app Settings
// can overwrite it at runtime (the server persists it to data/config.json), so
// a fresh deploy needs no FM_* env vars: connect in the browser. Env stays as
// the headless fallback.
const conn = {
  host: process.env.FM_HOST || "",
  // one file, a comma-separated list, or BLANK to auto-discover every file
  // this account can reach over OData (same creds, with fmodata, in each).
  dbs: (process.env.FM_DB || "").split(",").map((s) => s.trim()).filter(Boolean),
  user: process.env.FM_USER || "",
  pass: process.env.FM_PASS || "",
};
const FM_TIMEOUT_MS = Number(process.env.FM_TIMEOUT_MS || 15000);

export function fmConfigured() { return Boolean(conn.host && conn.user && conn.pass); }
// What the UI may read back - never the password. db is the WIRE FORM of the
// file selection ("" = every file the login can see, else a comma list).
export function fmConnection() { return { host: conn.host, db: conn.dbs.join(","), user: conn.user, hasPass: Boolean(conn.pass) }; }
// Apply a connection. A blank password keeps the current one.
export function setConnection({ host, db, user, pass } = {}) {
  if (host !== undefined) conn.host = String(host || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (db !== undefined) conn.dbs = String(db || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (user !== undefined) conn.user = String(user || "").trim();
  if (pass !== undefined && pass !== "") conn.pass = String(pass);
  discoveredDbs = null; // a connection change invalidates discovery
}
// Run fn() against a candidate connection WITHOUT persisting it (Settings'
// "Test connection" stages; only Save commits). Single-user app: the short
// window where other requests see the candidate is acceptable.
export async function withConnection(candidate, fn) {
  const prev = { host: conn.host, dbs: [...conn.dbs], user: conn.user, pass: conn.pass };
  try {
    setConnection(candidate);
    return await fn();
  } finally {
    conn.host = prev.host; conn.dbs = prev.dbs; conn.user = prev.user; conn.pass = prev.pass;
    discoveredDbs = null;
  }
}

const odataBase = (db) =>
  `https://${conn.host}/fmi/odata/v4/${encodeURIComponent(db)}`;

const authHeader = () =>
  "Basic " + Buffer.from(`${conn.user}:${conn.pass}`).toString("base64");

// The one line a person needs out of a FileMaker OData error: the code and
// message, out of the XML or JSON wrapper. "OData 401 on AI Demo DB/$metadata:
// <?xml ...><m:code>212</m:code><m:message>(212): Invalid account/password
// </m:message>" becomes "(212): Invalid account/password".
export function fmReason(raw) {
  const s = String(raw || "");
  const m = s.match(/<m:message>([^<]*)<\/m:message>/i) || s.match(/"message"\s*:\s*"([^"]*)"/);
  if (m) return m[1].trim();
  const t = s.match(/<title>([^<]*)<\/title>/i);
  if (t) return t[1].trim();
  return s.replace(/\s+/g, " ").slice(0, 160);
}

// Server errors often arrive as whole HTML error pages. Keep the useful part.
function errText(raw) {
  const title = String(raw).match(/<title>([^<]*)<\/title>/i)?.[1];
  return (title || String(raw).replace(/\s+/g, " ").slice(0, 220)).trim();
}

// The service ROOT answers without valid credentials on many servers (verified
// live on FMS: garbage creds still get the full file list), so listing
// databases proves nothing about the login. A specific file's service document
// DOES enforce auth - that is the credential check.
export async function checkAuth(db) {
  const res = await fetch(odataBase(db), {
    headers: { Authorization: authHeader(), Accept: "application/json;charset=utf-8" },
    signal: AbortSignal.timeout(FM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OData ${res.status} opening ${db}: ${errText(await res.text())}`);
}

async function odataGet(db, pathAndQuery, timeoutMs = FM_TIMEOUT_MS, accept = "application/json;charset=utf-8", signal) {
  const res = await fetch(`${odataBase(db)}${pathAndQuery}`, {
    headers: { Authorization: authHeader(), Accept: accept },
    signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`OData ${res.status} on ${db}${pathAndQuery}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// The OData service root lists every database the account can see (verified on
// FMS 2025: files without this account, or without fmodata on its privilege
// set, simply don't appear). That makes discovery the interface: grant the
// account in a file and the file shows up on the next refresh.
export async function listDatabases() {
  // Discovery is the front door for everything; ride out transient engine
  // stalls with a couple of retries before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`https://${conn.host}/fmi/odata/v4`, {
        headers: { Authorization: authHeader(), Accept: "application/json;charset=utf-8" },
        signal: AbortSignal.timeout(Math.max(FM_TIMEOUT_MS, 30000)),
      });
      if (!res.ok) throw new Error(`OData ${res.status} listing databases: ${(await res.text()).slice(0, 300)}`);
      return ((await res.json()).value || []).map((v) => v.name);
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
}

// The file list for this instance: pinned by FM_DB, else discovered (cached
// per boot; pass refresh=true to re-discover).
let discoveredDbs = null;
export async function resolveDbs(refresh = false) {
  if (conn.dbs.length) return conn.dbs;
  if (!discoveredDbs || refresh) discoveredDbs = await listDatabases();
  return discoveredDbs;
}

// --- $metadata parsing ------------------------------------------------------
// The EDMX is machine-generated and regular; a targeted regex parse is fine
// and keeps us dependency-free.

function parseEntityType(block) {
  const fields = [];
  const propRe = /<Property Name="([^"]+)" Type="([^"]+)"[^>]*>(.*?)<\/Property>|<Property Name="([^"]+)" Type="([^"]+)"[^>]*\/>/gs;
  let m;
  while ((m = propRe.exec(block))) {
    const name = m[1] ?? m[4];
    const type = (m[2] ?? m[5]).replace(/^Edm\./, "");
    const inner = m[3] || "";
    const comment = inner.match(/Term="com\.filemaker\.odata\.FMComment" String="([^"]*)"/)?.[1];
    const indexed = /Term="com\.filemaker\.odata\.Index" Bool="true"/.test(inner);
    const fieldId = inner.match(/Term="com\.filemaker\.odata\.FieldID" String="([^"]+)"/)?.[1];
    // Where the server emits them, flag calc/summary/global fields so the
    // proposal and the pull can skip them without reading a single row:
    // summaries are found-set aggregates, globals are one value per file, and
    // calc chains (stored or not is not distinguishable here; SaXML can say)
    // are the expensive serialization that wedges OData engines.
    const calc = /Term="com\.filemaker\.odata\.Calculation"/.test(inner);
    const summary = /Term="com\.filemaker\.odata\.Summary"/.test(inner);
    const global = /Term="com\.filemaker\.odata\.Global"/.test(inner);
    fields.push({ name: decodeXml(name), type, fieldId, comment: comment ? decodeXml(comment) : undefined, indexed, calc, summary, global });
  }
  const keys = [...block.matchAll(/<PropertyRef Name="([^"]+)"/g)].map((k) => decodeXml(k[1]));
  const tableId = block.match(/Term="com\.filemaker\.odata\.TableID" String="([^"]+)"/)?.[1] || null;
  const navs = [...block.matchAll(/<NavigationProperty Name="([^"]+)"/g)].map((n) => decodeXml(n[1]));
  return { fields, keys, tableId, navs };
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// Base-table display name for a group of occurrence names: the longest common
// suffix across the group, e.g. {C__Company, I_Company, P_Join_Company} ->
// "Company" — but only where the suffix starts on a word boundary in EVERY
// occurrence name. A raw character suffix can start mid-word ({RL_Report,
// REP_ort} -> "ort"; a Person Join group -> "n"), so fragments under 3 chars
// or mid-word are rejected and the shortest whole occurrence name wins
// instead. Single-occurrence groups keep their name. Real base-table names
// are NOT exposed over OData (verified: no TableID/name annotations on FMS
// 21 hosts), so this stays a heuristic; the AI naming pass proposes the
// friendly name on top.
function wordStart(name, p) {
  if (p <= 0) return true;
  if (/[_~\s.:-]/.test(name[p - 1])) return true;
  return /[a-z0-9]/.test(name[p - 1]) && /[A-Z]/.test(name[p]); // camelCase seam
}

export function baseName(names) {
  if (names.length === 1) return names[0];
  let suffix = names[0];
  for (const n of names.slice(1)) {
    while (suffix && !n.endsWith(suffix)) suffix = suffix.slice(1);
  }
  for (let k = 0; k < suffix.length; k++) {
    if (/[_~\s]/.test(suffix[k])) continue; // never start on a separator
    const cand = suffix.slice(k);
    if (cand.length < 3) break;
    if (names.every((n) => wordStart(n, n.length - cand.length))) return cand;
  }
  return names.slice().sort((a, b) => a.length - b.length)[0];
}

// Schema across every configured/discovered file, merged. Each table carries
// its `db`; table names are unique across the whole set (collisions get a
// " (filename)" suffix) so the rest of Pythia — cube, config, display names —
// keeps working on a flat table namespace.
export async function fetchSchema(refresh = false, onEvent = () => {}) {
  const dbs = await resolveDbs(refresh);
  if (!dbs.length) throw new Error("No databases visible to this account over OData.");
  onEvent({ type: "schema-dbs", dbs });
  const parts = [];
  for (const db of dbs) {
    const t0 = Date.now();
    try {
      // A slow link makes each file's structure read take a minute or more;
      // without a line at the START of each file the scan looks hung.
      onEvent({ type: "schema-file-start", db });
      parts.push(await fetchSchemaForDb(db));
      onEvent({ type: "schema-file", db, tables: parts[parts.length - 1].tables.length, ms: Date.now() - t0 });
    } catch (e) {
      if (e && e.superseded) throw e;
      parts.push({ db, error: String(e.message || e), version: null, tables: [], edges: [] });
      onEvent({ type: "schema-file", db, error: String(e.message || e).slice(0, 200), ms: Date.now() - t0 });
    }
  }

  // Resolve edges to table OBJECT references first, so the dedup and rename
  // passes below flow into them without name bookkeeping.
  const allEdges = [];
  for (const p of parts) {
    const byName = new Map(p.tables.map((t) => [t.name, t]));
    for (const e of p.edges) {
      const a = byName.get(e.from), b = byName.get(e.to);
      if (a && b) allEdges.push([a, b]);
    }
  }

  // Cross-file dedup: the same base table surfaces in EVERY file whose graph
  // holds a TO of it, because an external TO is served over OData once its
  // home file is API-accessible to the account (see GOTCHAS.md). Merge tables
  // whose full field name:type signature matches; the copy with the most
  // occurrences wins — a table's home file typically holds many TOs of it, a
  // borrowing file one or two. Tables under 4 fields are exempt: generic
  // globals/utility tables could false-merge on a tiny signature.
  const sig = (t) => (t.fields.length >= 4 ? t.fields.map((f) => `${f.name}:${f.type}`).sort().join("|") : null);
  const bestBySig = new Map();
  for (const p of parts) for (const t of p.tables) {
    const s = sig(t);
    if (s && (!bestBySig.has(s) || t.occurrences.length > bestBySig.get(s).occurrences.length)) bestBySig.set(s, t);
  }
  const replaced = new Map();
  for (const p of parts) {
    p.tables = p.tables.filter((t) => {
      const win = sig(t) && bestBySig.get(sig(t));
      if (!win || win === t) return true;
      // Remember the losing copy's occurrences under its file: OData can't say
      // which file a table LIVES in (see GOTCHAS.md), so the AI pass proposes a
      // home from these candidates and re-homes the table after the fact.
      win.occByDb = win.occByDb || { [win.db]: win.occurrences };
      win.occByDb[t.db] = t.occurrences;
      replaced.set(t, win);
      return false;
    });
  }
  for (const p of parts) for (const t of p.tables) {
    if (!t.occByDb) t.occByDb = { [t.db]: t.occurrences };
  }
  for (const pair of allEdges) {
    if (replaced.has(pair[0])) pair[0] = replaced.get(pair[0]);
    if (replaced.has(pair[1])) pair[1] = replaced.get(pair[1]);
  }

  // Cross-file name collisions among survivors: qualify with the file name.
  const tables = parts.flatMap((p) => p.tables);
  const nameCount = new Map();
  for (const t of tables) nameCount.set(t.name, (nameCount.get(t.name) || 0) + 1);
  for (const t of tables) if (nameCount.get(t.name) > 1) t.name = `${t.name} (${t.db})`;

  const edgeKeys = new Map();
  for (const [a, b] of allEdges) {
    if (a === b) continue;
    const k = a.name < b.name ? `${a.name} ${b.name}` : `${b.name} ${a.name}`;
    if (!edgeKeys.has(k)) edgeKeys.set(k, { from: a.name, to: b.name });
  }
  const edges = [...edgeKeys.values()];
  const errors = parts.filter((p) => p.error).map((p) => ({ db: p.db, error: p.error }));
  return {
    db: dbs.join(", "), dbs, host: conn.host,
    version: parts.find((p) => p.version)?.version || "unknown",
    fetchedAt: new Date().toISOString(), tables, edges,
    ...(errors.length ? { dbErrors: errors } : {}),
  };
}

// $metadata for a big file can take minutes to stream. A fixed timeout
// killed reads that were still receiving bytes; this one resets on every
// chunk (30s of silence is a stall) with a hard cap of five minutes.
async function fetchMetadataStallAware(db, stallMs = 30000, capMs = 300000) {
  const ctrl = new AbortController();
  let stall = setTimeout(() => ctrl.abort(new Error("timeout: the server stopped sending data")), stallMs);
  const cap = setTimeout(() => ctrl.abort(new Error("timeout")), capMs);
  try {
    const res = await fetch(`${odataBase(db)}/$metadata`, { headers: { Authorization: authHeader(), Accept: "application/xml" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`OData ${res.status} on ${db}/$metadata: ${errText(await res.text())}`);
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(new Error("timeout: the server stopped sending data")), stallMs);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } finally { clearTimeout(stall); clearTimeout(cap); }
}

async function fetchSchemaForDb(db) {
  const xml = await fetchMetadataStallAware(db);
  const version = xml.match(/Term="Org\.OData\.Core\.V1\.SchemaVersion" String="([^"]+)"/)?.[1] || "unknown";

  // EntitySet name -> EntityType name
  const setToType = new Map(
    [...xml.matchAll(/<EntitySet Name="([^"]+)" EntityType="[^"]*?\.([^".]+)"/g)]
      .map((m) => [decodeXml(m[1]), decodeXml(m[2])])
  );

  // EntityType blocks
  const types = new Map();
  const typeRe = /<EntityType Name="([^"]+)">(.*?)<\/EntityType>/gs;
  let m;
  while ((m = typeRe.exec(xml))) types.set(decodeXml(m[1]), parseEntityType(m[2]));

  // Occurrences (entity sets) with their parsed type info
  const occurrences = [...setToType.entries()].map(([setName, typeName]) => {
    const t = types.get(typeName) || { fields: [], keys: [], tableId: null, navs: [] };
    return { name: setName, ...t };
  });

  // Group occurrences into BASE TABLES. Both TableID and FieldID annotations
  // are occurrence-scoped, but an FMFID decomposes as
  //   (base-table field number << 32) | occurrence id
  // (verified: Phone's FMFIDs all end in its FMTID 1065096, and Person /
  // D_Person / P__Person share high words 6,8,9,12,13). Occurrences of the
  // same base table therefore share the high-word set; combined with field
  // names and types that's the grouping signature.
  const groups = new Map();
  for (const occ of occurrences) {
    const key =
      occ.fields
        .map((f) => `${f.fieldId ? BigInt(f.fieldId.replace("FMFID:", "")) >> 32n : "?"}:${f.name}:${f.type}`)
        .sort()
        .join("|") || `no-fields:${occ.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(occ);
  }
  const tables = [...groups.values()].map((occs) => ({
    name: baseName(occs.map((o) => o.name)),
    db,
    // occurrences[0] is the canonical query target for $count and row sync,
    // so sort the safest name first: `?`/`~` in a TO name is a hard 400
    // ("syntax error in URL", even encoded — verified against FMS 21), spaced
    // names hit the entity-encoding quirk (see odataGetEntity), and shorter
    // is tidier. Every occurrence serves the same base table.
    occurrences: occs.map((o) => o.name).sort((a, b) =>
      (/[?~]/.test(a) - /[?~]/.test(b)) || (/\s/.test(a) - /\s/.test(b)) || (a.length - b.length)),
    fields: occs[0].fields,
    keys: occs[0].keys,
  }));
  // Derived names can collide (two unrelated join tables both reduce to
  // "Join"); disambiguate with the shortest occurrence name.
  const seen = new Map();
  for (const t of tables) {
    if (seen.has(t.name)) {
      const other = seen.get(t.name);
      other.name = other.occurrences.slice().sort((a, b) => a.length - b.length)[0];
      t.name = t.occurrences.slice().sort((a, b) => a.length - b.length)[0];
      if (t.name === other.name) t.name += " 2";
      seen.set(other.name, other);
    }
    seen.set(t.name, t);
  }

  // Relationship edges from NavigationProperties, collapsed occurrence->base.
  const occToBase = new Map();
  for (const t of tables) for (const o of t.occurrences) occToBase.set(o, t.name);
  const edgeSet = new Set();
  for (const occ of occurrences) {
    for (const nav of occ.navs) {
      const a = occToBase.get(occ.name);
      const b = occToBase.get(nav);
      if (!a || !b || a === b) continue;
      edgeSet.add(a < b ? `${a} ${b}` : `${b} ${a}`);
    }
  }
  const edges = [...edgeSet].map((e) => {
    const [from, to] = e.split(" ");
    return { from, to };
  });

  return { db, version, tables, edges };
}

// --- Layout inventory + base-table matching ---------------------------------
// For each layout, its NATIVE fields (fieldMetaData names without "::") belong
// to one base table; related fields are prefixed "TO::field". Matching the
// native field-name set against each base table's field names tells us which
// base table a layout sits on, hence how many layouts reference each table.
// A layout referenced by many layouts is almost always a real entity; utility
// tables have few or none. Returns { counts, layoutsByTable, aiLayouts }.

async function dataApiToken(db) {
  const login = await fetch(`${dataApiBase(db)}/sessions`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(FM_TIMEOUT_MS),
  });
  if (!login.ok) throw new Error(`Data API login ${login.status}: ${(await login.text()).slice(0, 200)}`);
  return (await login.json()).response.token;
}

// Layout stats across every file. Field-set matching is deliberately blind to
// which file a layout lives in: a layout in the UI file sitting on a TO of an
// EXTERNAL table still matches that table's field set, so a hub-and-spokes
// solution (layouts in one file, data in ten) credits the right base tables.
// A file that rejects the Data API login (no fmrest there) is skipped.
export async function layoutStats(tables) {
  const dbs = await resolveDbs();
  const fieldSets = tables.map((t) => ({ name: t.name, set: new Set(t.fields.map((f) => f.name)) }));
  const counts = Object.fromEntries(tables.map((t) => [t.name, 0]));
  const layoutsByTable = Object.fromEntries(tables.map((t) => [t.name, []]));
  const aiLayouts = [];
  let totalLayouts = 0;

  for (const db of dbs) {
    let token;
    try { token = await dataApiToken(db); } catch { continue; } // no fmrest in this file
    const bearer = { Authorization: `Bearer ${token}` };
    try {
      const listRes = await fetch(`${dataApiBase(db)}/layouts`, { headers: bearer, signal: AbortSignal.timeout(FM_TIMEOUT_MS) });
      const listJson = await listRes.json();
      const flat = [];
      (function walk(items, folder) {
        for (const it of items || []) {
          if (it.isFolder) walk(it.folderLayoutNames, it.name);
          else flat.push({ name: it.name, folder: folder || null });
        }
      })(listJson.response.layouts, null);
      totalLayouts += flat.length;

      // Fetch each layout's metadata with light concurrency.
      const queue = flat.slice();
      async function worker() {
        while (queue.length) {
          const lay = queue.shift();
          try {
            const md = await fetch(`${dataApiBase(db)}/layouts/${encodeURIComponent(lay.name)}`, {
              headers: bearer,
              signal: AbortSignal.timeout(FM_TIMEOUT_MS),
            });
            const j = await md.json();
            const native = (j.response.fieldMetaData || [])
              .map((f) => f.name)
              .filter((n) => !n.includes("::"));
            if (native.length < 1) continue;
            let best = null, bestScore = 0;
            for (const fs of fieldSets) {
              const hits = native.filter((n) => fs.set.has(n)).length;
              const score = hits / native.length;
              if (score > bestScore) { bestScore = score; best = fs.name; }
            }
            if (best && bestScore >= 0.4) {
              counts[best]++;
              layoutsByTable[best].push(lay.name);
            }
          } catch { /* skip unreadable layout */ }
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      for (const l of flat) if (l.folder === "ai_layouts") aiLayouts.push(l.name);
    } finally {
      fetch(`${dataApiBase(db)}/sessions/${token}`, { method: "DELETE" }).catch(() => {});
    }
  }
  return { counts, layoutsByTable, aiLayouts, totalLayouts };
}

// --- Data API: layout inventory --------------------------------------------
// Used at config-save time to report which chosen tables lack a layout.
// (Verified against current Claris docs: NO API can CREATE layouts on a
// hosted file, so Pythia detects and reports; a human creates them in Pro.)

const dataApiBase = (db) =>
  `https://${conn.host}/fmi/data/vLatest/databases/${encodeURIComponent(db)}`;

export async function dataApiLayouts() {
  const dbs = await resolveDbs();
  const flat = [];
  for (const db of dbs) {
    let token;
    try { token = await dataApiToken(db); } catch { continue; } // no fmrest in this file
    try {
      const res = await fetch(`${dataApiBase(db)}/layouts`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Data API layouts ${res.status}`);
      const json = await res.json();
      const walk = (items, folder) => {
        for (const it of items || []) {
          if (it.isFolder) walk(it.folderLayoutNames, it.name);
          else flat.push({ name: it.name, folder: folder || null, db });
        }
      };
      walk(json.response.layouts, null);
    } finally {
      fetch(`${dataApiBase(db)}/sessions/${token}`, { method: "DELETE" }).catch(() => {});
    }
  }
  return flat;
}

// --- Entity-segment encoding quirk ------------------------------------------
// Some deployments (seen on FMS 26 behind nginx) decode the URL path once
// before the OData parser sees it, so a space in an ENTITY name arrives raw
// and trips "-1002 syntax error in URL". Those servers need the entity segment
// DOUBLE-encoded (%2520) — while correctly-behaved servers want plain %20.
// Detect on first failure and remember for the rest of the boot. The database
// segment is unaffected either way (single-encoded works on both).
let doubleEncodeEntities = false;
const encodeEntity = (name) =>
  doubleEncodeEntities ? encodeURIComponent(encodeURIComponent(name)) : encodeURIComponent(name);

async function odataGetEntity(db, entity, suffix, timeoutMs, accept, signal) {
  // Remember which encoding THIS call went out with: parallel callers race on
  // the flag, and a request that launched single-encoded must retry itself
  // even if a sibling already flipped the mode.
  const usedDouble = doubleEncodeEntities;
  try {
    return await odataGet(db, `/${encodeEntity(entity)}${suffix}`, timeoutMs, accept, signal);
  } catch (e) {
    if (!usedDouble && /\s/.test(entity) && /syntax error in URL/i.test(String(e.message))) {
      doubleEncodeEntities = true;
      return odataGet(db, `/${encodeEntity(entity)}${suffix}`, timeoutMs, accept, signal);
    }
    throw e;
  }
}

// Pull every row of one table occurrence over OData, paging until exhausted.
// This FMS OData build rejects $select (parse error), so we fetch all fields
// and let the caller drop unwanted (e.g. binary/container) columns via `keep`.
// FileMaker OData serializes fractional values in (-1,1) without a leading
// zero ("-.06", ".5"), which is invalid JSON that res.json() rejects. Repair
// number tokens in value position (after : , or [) before parsing. Strings are
// untouched because their content never sits directly after :/,/[ .
//
// It ALSO emits two other invalid-JSON constructs, both seen on real hosts:
//  - raw control characters in field data passed straight into string literals
//    (tabs, vertical tabs, stray \r pasted into fields decades ago), which
//    strict JSON.parse rejects ("Bad control character in string literal");
//  - a failed calc evaluation serialized as a BARE `?` in value position
//    (`"cRate": ?`) — the layout-style error marker, dumped into JSON.
// On parse failure, re-walk the text with string-literal awareness: inside
// strings, \u-escape control chars (escape, don't strip — the bytes are the
// client's data); outside strings, replace `?` tokens with null (a bare ? is
// never legal JSON, so this can't touch real data) and repair zero-less
// fractions. Structural whitespace stays raw.
function repairODataText(text) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      const code = ch.charCodeAt(0);
      out += code < 0x20 ? "\\u" + code.toString(16).padStart(4, "0") : ch;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === "?") { out += "null"; continue; }
    if (ch === "." && /\d/.test(text[i + 1] || "") && !/\d/.test(out.slice(-1))) { out += "0."; continue; }
    out += ch;
  }
  return out;
}

function parseODataJson(text) {
  const fast = text.replace(/([:,\[]\s*)(-?)\.(\d)/g, "$1$20.$3");
  try { return JSON.parse(fast); }
  catch { return JSON.parse(repairODataText(text)); } // walk the ORIGINAL, not `fast`
}

// $select is all-or-nothing (navarre-core filemaker/odata-and-data-api.md):
// a field list the server cannot parse fails the whole request, it never
// trims. Field names go out percent-encoded, the way Pythia sends them; a
// server family that decodes twice gets them double-encoded on a retry. Only
// when BOTH encodings fail does an occurrence fall back to whole rows.
//
// This used to be a regex gate: any name with a space (Total Invoiced) made
// Mitos drop $select silently and read whole rows, so a full pull of Org
// evaluated seven unstored calculations for 10,511 records and took six
// minutes where Pythia took seconds (2026-09-08).
const noSelect = new Set(); // occurrences where both encodings were refused
const selectDouble = new Set(); // occurrences whose host decodes $select names twice
const SELECT_REJECTED = /syntax error|-1002|8309|\b400\b|invalid|not found|unknown/i;

// A cancel that waits for the current network call is not a cancel
// (navarre-core filemaker/sync-doctrine.md). So the stop flag is checked
// between pages AND aborts the request that is in the air: a 60-second page
// read on a big table must not hold Cancel hostage for a minute.
export class Cancelled extends Error {
  constructor(where) { super(`cancelled during ${where}`); this.cancelled = true; }
}

// A few rows by primary key: the per-record beacon's read. Keys go in
// batches of 40 as an OR filter; text keys quoted, numeric keys bare.
export async function fetchRowsByKeys(occurrence, keep, pk, keys, { db, select, numericKey = false } = {}) {
  const out = [];
  const enc = (n) => `%22${encodeURIComponent(n)}%22`;
  for (let i = 0; i < keys.length; i += 40) {
    const batch = keys.slice(i, i + 40);
    const lit = (k) => numericKey ? String(Number(k)) : `'${encodeURIComponent(String(k).replace(/'/g, "''"))}'`;
    const filter = batch.map((k) => `${enc(pk)}%20eq%20${lit(k)}`).join("%20or%20");
    const rows = await fetchAllRows(occurrence, keep, { db, select, filter, pageSize: 100 });
    out.push(...rows);
  }
  return out;
}

// Two ways to take the rows. With no `onPage` the rows come back as one
// array. With `onPage(batchRows, { skip, size })` each page is handed over
// as it arrives and NOTHING is kept here: a 446,216-record table read whole
// into the Node heap is what killed the 1 GB demo box (2026-09-09). The
// promise then resolves to the row count. `startSkip` continues a pull
// from a checkpoint (store.js keeps one per page). `onProgress` reports
// rows from the start of the table, so a resumed pull counts from where it
// left off.
export async function fetchAllRows(occurrence, keep, { pageSize, onProgress, onNote, onPage, startSkip = 0, filter, orderBy, db, select, stats, shouldStop = () => false } = {}) {
  const fromDb = db || (await resolveDbs())[0];
  const keepSet = keep && keep.length ? new Set(keep) : null;
  // OData filter: encode spaces only (colons/dashes/T/Z must stay raw for this
  // FMS build). e.g. filter = "z_ModifiedTS ge 2026-03-01T00:00:00Z".
  // A filter arrives either as "field op value" with spaces (the incremental
  // pull) or already encoded (the beacon's key list, which carries %20).
  const filterQ = filter ? `&$filter=${/%20/.test(filter) ? filter : filter.replace(/ /g, "%20")}` : "";
  // A streamed pull can resume at a $skip after a crash. $skip without an
  // order is whatever the server feels like, so a resumable pull orders by
  // the primary key (quoted, like $select names).
  const orderQ = orderBy ? `&$orderby=%22${encodeURIComponent(orderBy)}%22` : "";
  // $select earns its keep on wide or calc-heavy tables: the server never
  // evaluates a field we did not ask for. Unstored calculations are the
  // expensive ones, and asking for all of them is what wedges a pull.
  const wantSelect = Boolean(select && select.length) && !noSelect.has(occurrence);
  // Every name QUOTED: FileMaker's OData parser rejects a bare field named
  // "ID" ("parse failure in URL at: 'ID'"), and takes "ID" in quotes. Verified
  // on FileMaker Server 2026, 2026-09-08: %22ID%22 200, ID 400; a spaced
  // name inside quotes goes single-encoded (%22Customer%20Summary%22 200,
  // %2520 8309). The double-encoded form stays as the retry for the server
  // family that decodes twice.
  const encField = (n) => `%22${selectDouble.has(occurrence) ? encodeURIComponent(encodeURIComponent(n)) : encodeURIComponent(n)}%22`;
  const selectQ = () => (wantSelect ? `&$select=${select.map(encField).join(",")}` : "");
  const rows = [];
  let skip = Number(startSkip) || 0;
  let count = skip; // rows handed over so far, counted from the table's start
  // ADAPTIVE PAGE SIZE. A page is a unit of server work, not of network: 1000
  // rows of a table with unstored calcs can exceed any timeout while 100 rows
  // of the same table answer fine. Start at 1000 (Pythia's size), shrink on
  // timeout, and keep the size that worked for the rest of the table.
  let size = pageSize || 1000;
  let triedDouble = false;
  for (;;) {
    if (shouldStop()) throw new Cancelled(occurrence);
    let res;
    for (let attempt = 0; ; attempt++) {
      // One controller per attempt, aborted the moment the stop flag goes up.
      const ctrl = new AbortController();
      const watch = setInterval(() => { if (shouldStop()) ctrl.abort(); }, 250);
      try {
        res = await odataGetEntity(fromDb, occurrence, `?$top=${size}&$skip=${skip}${filterQ}${orderQ}${selectQ()}`, 60000, undefined, ctrl.signal);
        break;
      } catch (e) {
        if (shouldStop()) throw new Cancelled(occurrence);
        const msg = String(e.message);
        // The host rejected the field list. First flip the name encoding
        // once (some server families decode twice); if that fails too, drop
        // $select for this occurrence and take whole rows. Never trim the
        // list (that lands NULL columns and reports success).
        if (wantSelect && SELECT_REJECTED.test(msg) && !triedDouble) {
          triedDouble = true;
          if (selectDouble.has(occurrence)) selectDouble.delete(occurrence); else selectDouble.add(occurrence);
          continue;
        }
        if (wantSelect && SELECT_REJECTED.test(msg) && !noSelect.has(occurrence)) {
          noSelect.add(occurrence);
          selectDouble.delete(occurrence);
          if (onNote) onNote(`${occurrence}: this server refused a field list in both encodings; reading whole rows instead (${msg.replace(/\s+/g, " ").slice(0, 160)})`);
          // Pass EVERY option through. Dropping shouldStop here meant the
          // retry ran with the default "never stop", so Cancel worked on the
          // first page of a table and silently stopped working after any
          // $select refusal (2026-08-31). `select` is the one thing left out,
          // deliberately: refusing it is why we are here.
          // `startSkip: skip` too: the pages before this one are already
          // delivered, and a streamed pull must not hand them over twice.
          return fetchAllRows(occurrence, keep, { pageSize: size, onProgress, onNote, onPage, startSkip: skip, filter, orderBy, db, stats, shouldStop });
        }
        if (/timeout|504/i.test(msg) && size > 25) {
          size = Math.max(25, Math.floor(size / 4));
          if (onNote) onNote(`${occurrence}: slow to answer, retrying ${size} records at a time`);
          continue;
        }
        // Check the stop flag inside the retry wait too, in short slices.
        if (attempt < 2) {
          for (let i = 0; i < (attempt + 1) * 20; i++) {
            if (shouldStop()) throw new Cancelled(occurrence);
            await new Promise((r) => setTimeout(r, 250));
          }
          continue;
        }
        if (/timeout|504/i.test(msg)) {
          throw new Error(`${occurrence} did not answer in 60 seconds even at ${size} records a page. ` +
            `That table is expensive to read (usually unstored calculations evaluated per record). ` +
            `Give it a cMitosJSON field so Mitos reads one field instead of all of them, or exclude it.`);
        }
        throw e;
      } finally {
        clearInterval(watch);
      }
    }
    if (shouldStop()) throw new Cancelled(occurrence);
    const batch = parseODataJson(await res.text()).value || [];
    const page = [];
    for (const r of batch) {
      if (!keepSet) { page.push(r); continue; }
      const o = {};
      for (const k of keep) if (k in r) o[k] = r[k];
      page.push(o);
    }
    count += page.length;
    if (onPage) await onPage(page, { skip, size });
    else rows.push(...page);
    // No progress line for the empty page that ends a table whose last
    // page was full: the count did not move.
    if (onProgress && page.length) onProgress(count);
    if (batch.length < size) break;
    skip += size;
  }
  // How the read went, for the sync log: the log says the method, not
  // only the count (Matt, 2026-09-10, as Pythia's does).
  if (stats) { stats.pageSize = size; stats.fields = wantSelect ? select.length : 0; stats.wholeRows = !wantSelect; }
  return onPage ? count : rows;
}

// A few real rows of one base table, for the field proposal to look at. One
// page, no paging, short timeout: a table that cannot answer quickly just has
// no sample. Fields with unsafe names force a whole-row read, same as sync.
export async function sampleRows(table, n = 25, fieldNames = null) {
  const fromDb = table.db || (await resolveDbs())[0];
  const strings = fieldNames || table.fields.filter((f) => f.type === "String").map((f) => f.name);
  const selectQ = strings.length && strings.every((s) => SAFE_NAME.test(s)) ? `&$select=${strings.join(",")}` : "";
  const res = await odataGetEntity(fromDb, table.occurrences[0], `?$top=${n}${selectQ}`, 20000);
  return parseODataJson(await res.text()).value || [];
}

// Record counts per base table (via its first occurrence). Parallel, tolerant:
// a table whose count fails just reports null.
// At most FOUR counts in flight. Every table at once turned N requests with
// a 15s timeout into a self-inflicted queue on a busy server.
export async function fetchCounts(tables, onProgress = () => {}, shouldStop = () => false) {
  const counts = {};
  let next = 0, done = 0;
  const worker = async () => {
    while (next < tables.length && !shouldStop()) {
      const t = tables[next++];
      counts[t.name] = null;
      // One occurrence refusing to count is not a table with no count: walk
      // the first few occurrences until one answers with a real number.
      for (const occ of t.occurrences.slice(0, 3)) {
        try {
          // Quirk: FMS OData 22 returns "406 Unexpected internal OData Provider
          // error" for /$count unless Accept is */* (explicit text/plain fails).
          const res = await odataGetEntity(t.db || (await resolveDbs())[0], occ, "/$count", FM_TIMEOUT_MS, "*/*");
          const v = Number((await res.text()).trim());
          if (Number.isFinite(v)) { counts[t.name] = v; break; }
        } catch { /* try the next occurrence */ }
      }
      onProgress(++done, tables.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return counts;
}
