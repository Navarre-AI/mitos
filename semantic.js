// semantic.js - which tables take part in semantic search.
// Each table has a switch, config.tables.<raw>.semantic. With none saved, the
// default is on for a table that has real text in its searched fields and off
// for one whose searched fields are only numbers and dates (invoice lines).
// The field types come from the saved scan (schema-scan.json), read again
// only when the file changes. Without a scan the answer is on.

import "./env.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const SCAN_PATH = path.join(DATA_DIR, "schema-scan.json");

let memo = { mtime: -1, types: new Map() };
function scanTypes() {
  try {
    const mtime = fs.statSync(SCAN_PATH).mtimeMs;
    if (mtime !== memo.mtime) {
      const scan = JSON.parse(fs.readFileSync(SCAN_PATH, "utf8"));
      memo = { mtime, types: new Map((scan.tables || []).map((t) => [t.name, new Map((t.fields || []).map((f) => [f.name, f.type]))])) };
    }
  } catch { memo = { mtime: -1, types: new Map() }; }
  return memo.types;
}

// The default for a table with no saved switch.
export function semanticDefault(raw, t) {
  if (t?.mitosJson) return true;
  const fields = Array.isArray(t?.textFields) ? t.textFields : [];
  if (!fields.length) return false;
  const types = scanTypes().get(raw);
  if (!types) return true;
  return fields.some((f) => !types.has(f) || types.get(f) === "String");
}
// The switch in effect: on only when the table's Semantic switch is on. There
// is no global switch and no default-on: a table with no saved switch is off
// (Matt, 2026-11-20). semanticDefault stays for the one-time config migration
// from 1.1.0, which turned the default on for tables with real text.
export const semanticOn = (raw, t) => t?.semantic === true;
// The tables (raw names) semantic search covers.
export const semanticTables = (tablesCfg) => Object.keys(tablesCfg || {}).filter((n) => semanticOn(n, tablesCfg[n]));
