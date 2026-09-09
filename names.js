// names.js - THE display name map. One function, read by the server (GET
// /api/config displayNames, GET /api/fm/tables rows, result labels) and by
// the indexer (event labels, the sync plan order), so no two screens can
// disagree about what a table is called. The raw occurrence name stays the
// identity everywhere; this is presentation only.
//
// Per table, in order of trust:
//   1. the saved rename (config.displayNames[raw]), written by Rename
//   2. the saved per-table name (config.tables[raw].displayName)
//   3. the real table name from an uploaded SaXML (the scan's saxmlName)
//   4. the naming pass's proposal (naming.json)
//   5. the occurrence name with its prefix letters and ~B suffix gone
//   6. the raw name
// Every scanned table and every configured table gets an entry.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { proposedDisplayNames } from "./naming.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")); } catch { return null; } };

// C__Container -> Container, IL_Product -> Product, D_Org~B -> Org. Only
// when neither the naming pass nor a person gave a name.
export function humanize(raw) {
  let s = String(raw || "").replace(/~[A-Za-z]$/, "").replace(/^[A-Z]{1,4}_+/, "").replace(/_+/g, " ");
  s = s.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s && s !== raw ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : raw;
}

// { raw: displayName } for every table the scan or the config knows.
export function displayNamesMap() {
  const cfg = readJson("config.json") || {};
  const scan = readJson("schema-scan.json");
  const proposed = proposedDisplayNames();
  const out = {};
  for (const t of scan?.tables || []) out[t.name] = t.saxmlName || proposed[t.name] || t.name;
  for (const n of Object.keys(cfg.tables || {})) if (!out[n]) out[n] = proposed[n] || humanize(n);
  for (const [n, t] of Object.entries(cfg.tables || {})) if (t && t.displayName) out[n] = t.displayName;
  // The rename map wins: Rename writes it every time, while a table's saved
  // displayName can be a stale label carried back by a later Tables save
  // (a test box, 2026-09-09: Met_Object saved as "Artwork" after its rename to
  // "Met Artwork").
  for (const [n, v] of Object.entries(cfg.displayNames || {})) if (v) out[n] = v;
  return out;
}

// The one order everywhere: display name A to Z, case-insensitive, then the
// raw name. The Tables tab, the wizard and the sync plan all sort this way.
export function sortByName(names, map) {
  const key = (n) => String(map[n] || n).toLowerCase();
  return [...names].sort((a, b) => key(a).localeCompare(key(b)) || a.localeCompare(b));
}
