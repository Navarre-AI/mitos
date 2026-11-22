// fm-baseline.mjs - a model of what a FileMaker user gets today, over the same
// sample data Mitos indexes (sample-data/*.csv). Pure JS, no server, no AI.
//
// Two behaviours are modelled.
//
// (a) QUICK FIND (the search box in the status toolbar, Browse mode)
//   - Searches every field enabled for quick find on the CURRENT layout. We
//     enable the same fields Mitos indexes (tables.config.js textFields).
//   - Several words: the record must have ALL of them (AND). A word matches
//     when it is the START of a word in some field (words that start with the
//     typed characters). Case and accent insensitive.
//   - Only operator: "double quotes" = match phrase (from a word start).
//     No ranges, no wildcards, no nicknames, no fuzzy: a typo finds nothing.
//   - Number and date fields match as numbers and dates, not as text.
//   - ONE table at a time (the layout's table). We give FileMaker the correct
//     table for every case, as a favour: a real user who picks the wrong layout
//     finds nothing at all. Mitos has to find the table itself.
//   - Result order = the found set in record creation order (here CSV row
//     order). No ranking. "Position" below is the place in that unsorted set.
//   - No related-table text: Mitos joins employee names into an organization's
//     text; a quick find on the organizations layout does not see them.
//
// (b) DEVELOPER-BUILT FIND in one named field (a Find layout or a script that
//     sets a field and performs the find)
//   - Number fields: `900...1500`, `<`, `<=`, `>`, `>=`, exact number.
//   - Date fields: `1/1/2024...3/31/2024`, partial dates (`5/2019` is all of
//     May 2019, `3/*/2019`), the same comparison operators. Dates are read in
//     the US system order (month/day/year) with / - . separators; ISO
//     yyyy-mm-dd also parses. Month names ("March 2019") are NOT understood.
//   - Text fields: words-start matching as above, `==Exact Field Content`,
//     `*` wildcard (`Whit*`), `"phrase"`.
//
// What is NOT modelled: FileMaker's per-field index language rules (we use a
// generic unicode word split), related fields in quick find, stored-vs-
// unstored field limits, portals, performance.
//
// Sources (Claris FileMaker Pro Help, current 2026 edition, read from the
// local help pages carried by the filemaker-help skill):
//   Quick find:  https://help.claris.com/en/pro-help/content/performing-a-quick-find.html
//                (all words must match; only operator is "phrase"; searches
//                fields enabled for quick find on the current layout)
//   Text find:   https://help.claris.com/en/pro-help/content/finding-text.html
//                (words that START with the characters; not case sensitive;
//                accents ignored unless quoted; == whole field; * wildcard)
//   Ranges:      https://help.claris.com/en/pro-help/content/finding-ranges.html
//                (... and .. ranges for numbers and dates; < <= > >=; 5/2019
//                = all of May 2019)
// Note: help.claris.com paths without ".html" ids (quick-find.html) 404; the
// URLs above are the ones named in the current help pages themselves.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DEFAULT_TABLES } from "../tables.config.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Field types the sample data has. Everything else is text.
export const FIELD_TYPES = { people: { since: "date" }, products: { price: "number" } };

// ---- CSV ------------------------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

export function loadData(dir = path.join(ROOT, "sample-data")) {
  const data = {};
  for (const [table, cfg] of Object.entries(DEFAULT_TABLES)) {
    const rows = parseCsv(fs.readFileSync(path.join(dir, `${table}.csv`), "utf8"));
    data[table] = { cfg, rows: rows.map((r) => ({ id: r[cfg.pk], row: r })) };
  }
  return data;
}

// ---- text helpers -----------------------------------------------------------------------
export const fold = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const startsAWord = (wordList, w) => wordList.some((x) => x.startsWith(w));

// ---- numbers and dates ------------------------------------------------------------------
const toNum = (s) => { const t = String(s).trim().replace(/^[$€£]/, "").replace(/,/g, ""); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null; };
const yy = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
// A date as typed or stored -> { lo, hi } day numbers (a span for a partial date), or null.
const dayNo = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function parseDate(s) {
  s = String(s).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { const [y, mo, d] = [+m[1], +m[2], +m[3]]; if (mo < 1 || mo > 12 || d < 1 || d > monthEnd(y, mo)) return null; return { lo: dayNo(y, mo, d), hi: dayNo(y, mo, d) }; }
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/))) { const [mo, d, y] = [+m[1], +m[2], yy(m[3])]; if (mo < 1 || mo > 12 || d < 1 || d > monthEnd(y, mo)) return null; return { lo: dayNo(y, mo, d), hi: dayNo(y, mo, d) }; }
  let mo = null, y = null;
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{4})$/))) { mo = +m[1]; y = +m[2]; }
  else if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) { y = +m[1]; mo = +m[2]; }
  if (mo !== null) { if (mo < 1 || mo > 12) return null; return { lo: dayNo(y, mo, 1), hi: dayNo(y, mo, monthEnd(y, mo)) }; }
  if (/^\d{4}$/.test(s)) { const y = +s; if (y < 1000) return null; return { lo: dayNo(y, 1, 1), hi: dayNo(y, 12, 31) }; }
  return null;
}
const storedDay = (iso) => { const p = parseDate(iso); return p ? p.lo : null; };

// ---- QUICK FIND ---------------------------------------------------------------------------
// Split a quick-find request into words and "phrases".
function tokens(q) {
  const out = []; const re = /"([^"]*)"|(\S+)/g; let m;
  while ((m = re.exec(q))) out.push(m[1] !== undefined ? { phrase: m[1] } : { word: m[2] });
  return out;
}
const phraseHit = (fieldText, phrase) => {
  const f = fold(fieldText), p = fold(phrase).trim();
  if (!p) return false;
  let i = -1;
  while ((i = f.indexOf(p, i + 1)) >= 0) if (i === 0 || !/[\p{L}\p{N}]/u.test(f[i - 1])) return true;
  return false;
};

function wordHitsRecord(table, rec, w, skip = []) {
  const { cfg } = table; const types = FIELD_TYPES[table.name] || {};
  const typed = String(w);
  const d = parseDate(typed); const n = toNum(typed);
  const sub = words(typed); // "773-9565" -> 773, 9565
  for (const f of cfg.textFields) {
    if (skip.includes(f)) continue;
    const val = rec.row[f];
    const t = types[f];
    if (t === "date") { const sd = storedDay(val); if (d && sd !== null && sd >= d.lo && sd <= d.hi) return true; continue; }
    if (t === "number") { if (n !== null && toNum(val) === n) return true; continue; }
    const wl = words(val);
    if (sub.length && sub.every((x) => startsAWord(wl, x))) return true;
  }
  // A word made of several parts (an email, a phone with dashes) must have every part
  // start a word in the record, possibly in different fields: be generous.
  if (sub.length > 1) {
    const all = cfg.textFields.filter((f) => !types[f] && !skip.includes(f)).flatMap((f) => words(rec.row[f]));
    if (sub.every((x) => startsAWord(all, x))) return true;
  }
  return false;
}

export function quickFind(data, tableName, q, skip = []) {
  const table = { ...data[tableName], name: tableName };
  const toks = tokens(q);
  if (!toks.length) return [];
  return table.rows.filter((rec) => toks.every((t) => {
    if (t.phrase !== undefined) return table.cfg.textFields.some((f) => !skip.includes(f) && !(FIELD_TYPES[tableName] || {})[f] && phraseHit(rec.row[f], t.phrase));
    return wordHitsRecord(table, rec, t.word, skip);
  })).map((r) => r.id);
}

// ---- DEVELOPER-BUILT FIND IN ONE FIELD ---------------------------------------------------
export function fieldFind(data, tableName, field, q) {
  const table = data[tableName]; const type = (FIELD_TYPES[tableName] || {})[field] || "text";
  q = String(q).trim();
  const pick = (test) => table.rows.filter((r) => test(r.row[field])).map((r) => r.id);
  if (type === "number") {
    let m;
    if ((m = q.match(/^(.+?)\.{2,3}(.+)$/))) { const a = toNum(m[1]), b = toNum(m[2]); if (a === null || b === null) return []; return pick((v) => { const x = toNum(v); return x !== null && x >= a && x <= b; }); }
    if ((m = q.match(/^(<=|>=|≤|≥|<|>)\s*(.+)$/))) { const a = toNum(m[2]); if (a === null) return []; const op = m[1]; return pick((v) => { const x = toNum(v); return x !== null && (op === "<" ? x < a : op === ">" ? x > a : op === "<=" || op === "≤" ? x <= a : x >= a); }); }
    const a = toNum(q.replace(/^==/, "")); return a === null ? [] : pick((v) => toNum(v) === a);
  }
  if (type === "date") {
    let m;
    if ((m = q.match(/^(.+?)\.{2,3}(.+)$/)) && !/^\d{1,2}\.\d/.test(q)) { const a = parseDate(m[1]), b = parseDate(m[2]); if (!a || !b) return []; return pick((v) => { const x = storedDay(v); return x !== null && x >= a.lo && x <= b.hi; }); }
    if ((m = q.match(/^(<=|>=|≤|≥|<|>)\s*(.+)$/))) { const a = parseDate(m[2]); if (!a) return []; const op = m[1]; return pick((v) => { const x = storedDay(v); return x !== null && (op === "<" ? x < a.lo : op === ">" ? x > a.hi : op === "<=" || op === "≤" ? x <= a.hi : x >= a.lo); }); }
    const a = parseDate(q); return !a ? [] : pick((v) => { const x = storedDay(v); return x !== null && x >= a.lo && x <= a.hi; });
  }
  // text
  if (q.startsWith("==")) { const want = fold(q.slice(2)).trim(); return pick((v) => fold(v).trim() === want); }
  const toks = tokens(q);
  if (!toks.length) return [];
  return pick((v) => {
    const wl = words(v);
    return toks.every((t) => {
      if (t.phrase !== undefined) return phraseHit(v, t.phrase);
      const w = fold(t.word);
      if (w.includes("*")) { const re = new RegExp("^" + w.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "u"); return wl.some((x) => re.test(x)); }
      const sub = words(w); return sub.length > 0 && sub.every((x) => startsAWord(wl, x));
    });
  });
}

// One entry point for the runner. mode: "quick" or { field }.
export function fmFind(data, c, skip = []) {
  const mode = c.fm || "quick";
  return mode === "quick" ? quickFind(data, c.table, c.q, skip) : fieldFind(data, c.table, mode.field, c.q);
}

export const titleOf = (data, table, id) => {
  const t = data[table]; const r = t.rows.find((x) => x.id === id);
  return r ? r.row[t.cfg.displayFields[0]] : id;
};
