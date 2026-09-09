// query.js - the type-detection front door (fmSearchResults' first move).
// Read the whole input, decide what KIND of thing it is, and hand back a
// plan: which typed columns to search and how. Nothing here calls a model;
// the same input always yields the same plan, and the plan is returned to
// the caller so the UI can say "searched as a date range".
//
// Kinds, in the order they are tested:
//   number     45   $5,000   -12.5        number fields (exact), plus text
//   range      100...200  >100  <=45     number fields, in range
//   date       1/15/2026  15.1.2026  2026-01-15  1/2026 (a month)
//   daterange  1/1/2026...3/31/2026  >1/1/2026  <=2026-06-30
//   email      anything with an @ and no spaces
//   phone      mostly digits with phone punctuation, 6+ digits
//   text       words; each must start a word.  "a phrase"  =wholeword  *contains
//
// A plain 4-digit number in 1900..2100 is also a year: it searches number
// fields for that value AND date fields for that year, and says so.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeText, tokenize } from "./store.js";
import { DEFAULT_NAME_GROUPS } from "./names.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

// --- Numbers ------------------------------------------------------------------
// Currency signs and thousands separators are ignored: $5,000 is 5000.
const NUM = String.raw`[-+]?[$€£]?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[-+]?[$€£]?\s?\.\d+`;
const NUM_RE = new RegExp(`^(?:${NUM})$`);
export function parseNumber(s) {
  const t = String(s).trim();
  if (!NUM_RE.test(t)) return null;
  const n = Number(t.replace(/[$€£,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// --- Dates --------------------------------------------------------------------
// Numeric forms only: ISO (2026-01-15), slash or dot with a full year
// (1/15/2026, 15.1.2026), and month-only (1/2026, 2026-01). Two-digit years
// are read as 20xx. Order of day and month follows `dateFormat` ("mdy" or
// "dmy"); when one part is over 12 the order is decided by the data.
const DATE_RE = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$|^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$|^(\d{1,2})[/.](\d{4})$/;
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m) && y >= 1000 && y <= 9999;

// Returns { from, to, label } (ISO dates, inclusive) or null.
export function parseDate(s, { dateFormat = "mdy", today = new Date() } = {}) {
  const t = String(s).trim();
  const m = DATE_RE.exec(t);
  if (!m) return null;
  let y, mo, d;
  if (m[1]) {                       // ISO: yyyy-mm(-dd)
    y = +m[1]; mo = +m[2]; d = m[3] ? +m[3] : null;
  } else if (m[7]) {                // month-only: m/yyyy
    mo = +m[7]; y = +m[8]; d = null;
  } else {                          // m/d(/y) or d/m(/y)
    let a = +m[4], b = +m[5];
    y = m[6] ? +m[6] : today.getFullYear();
    if (m[6] && m[6].length === 2) y += 2000;
    let dmy = dateFormat === "dmy";
    if (a > 12 && b <= 12) dmy = true;
    if (b > 12 && a <= 12) dmy = false;
    [mo, d] = dmy ? [b, a] : [a, b];
  }
  if (d === null) {
    if (mo < 1 || mo > 12) return null;
    return { from: iso(y, mo, 1), to: iso(y, mo, daysIn(y, mo)), label: `${y}-${pad(mo)}` };
  }
  if (!valid(y, mo, d)) return null;
  return { from: iso(y, mo, d), to: iso(y, mo, d), label: iso(y, mo, d) };
}

// --- The name table -------------------------------------------------------------
let nameGroupsCache = null;
export function nameGroups() {
  if (nameGroupsCache) return nameGroupsCache;
  let groups = DEFAULT_NAME_GROUPS;
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "names.json"), "utf8"));
    if (Array.isArray(custom) && custom.length) groups = custom;
  } catch {}
  const map = new Map();
  for (const g of groups) {
    const norm = [...new Set(g.map((n) => tokenize(normalizeText(n))[0]).filter(Boolean))];
    for (const n of norm) {
      const set = map.get(n) || new Set();
      for (const other of norm) set.add(other);
      map.set(n, set);
    }
  }
  nameGroupsCache = map;
  return map;
}
export const resetNameGroups = () => { nameGroupsCache = null; };

// --- Range operators --------------------------------------------------------------
const RANGE_RE = /^(.+?)\s*(?:\.\.\.|\.\.|…)\s*(.+)$/;
const OP_RE = /^(>=|<=|≥|≤|>|<)\s*(.+)$/;

// --- The plan -----------------------------------------------------------------------
// Returns one of:
//  { kind:"number", value, text:[...words], year?: {from,to} }
//  { kind:"range", from, to, label }                (from/to may be null = open)
//  { kind:"date", from, to, label }
//  { kind:"daterange", from, to, label }
//  { kind:"email", value }
//  { kind:"phone", digits }
//  { kind:"text", terms:[{ word, mode:"start"|"whole"|"contains"|"phrase", also:[...] }] }
//  { kind:"empty" }
export function parseQuery(raw, opts = {}) {
  const q = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!q) return { kind: "empty" };

  // Ranges and operators, numbers first then dates.
  const range = RANGE_RE.exec(q);
  if (range) {
    const [a, b] = [parseNumber(range[1]), parseNumber(range[2])];
    if (a !== null && b !== null) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return { kind: "range", from: lo, to: hi, label: `${lo} to ${hi}` };
    }
    const [da, db] = [parseDate(range[1], opts), parseDate(range[2], opts)];
    if (da && db) {
      const [lo, hi] = da.from <= db.from ? [da, db] : [db, da];
      return { kind: "daterange", from: lo.from, to: hi.to, label: `${lo.label} to ${hi.label}` };
    }
  }
  const op = OP_RE.exec(q);
  if (op) {
    const sym = op[1].replace("≥", ">=").replace("≤", "<=");
    const n = parseNumber(op[2]);
    if (n !== null) {
      // Open-ended bounds. Strict > and < step past the value by the
      // smallest unit a person typed (whole numbers step 1; decimals step
      // at the last decimal place), so ">100" excludes 100 the way it reads.
      const dec = /\.(\d+)$/.exec(op[2].trim());
      const step = dec ? Math.pow(10, -dec[1].length) : 1;
      if (sym === ">=") return { kind: "range", from: n, to: null, label: `${n} or more` };
      if (sym === "<=") return { kind: "range", from: null, to: n, label: `${n} or less` };
      if (sym === ">") return { kind: "range", from: n + step, to: null, label: `over ${n}` };
      return { kind: "range", from: null, to: n - step, label: `under ${n}` };
    }
    const d = parseDate(op[2], opts);
    if (d) {
      if (sym === ">=") return { kind: "daterange", from: d.from, to: null, label: `${d.label} or later` };
      if (sym === "<=") return { kind: "daterange", from: null, to: d.to, label: `${d.label} or earlier` };
      if (sym === ">") return { kind: "daterange", from: shiftDay(d.to, 1), to: null, label: `after ${d.label}` };
      return { kind: "daterange", from: null, to: shiftDay(d.from, -1), label: `before ${d.label}` };
    }
  }

  // A month in any year: "month:3" or "month:march" (the understand stage
  // writes this for "birthdays in March"; a person can type it too).
  const mo = /^month:\s*([a-z]+|\d{1,2})$/i.exec(q);
  if (mo) {
    const names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const v = mo[1].toLowerCase();
    const n = /^\d+$/.test(v) ? Number(v) : names.findIndex((m) => m.startsWith(v.slice(0, 3))) + 1;
    if (n >= 1 && n <= 12) return { kind: "month", month: n, label: names[n - 1][0].toUpperCase() + names[n - 1].slice(1) };
  }

  // One date (a day or a month).
  const d = parseDate(q, opts);
  if (d) return { kind: "date", from: d.from, to: d.to, label: d.label };

  // One number. A plausible year also reaches into date fields.
  const n = parseNumber(q);
  if (n !== null) {
    const out = { kind: "number", value: n, text: tokenize(normalizeText(q)) };
    if (Number.isInteger(n) && n >= 1900 && n <= 2100 && /^\d{4}$/.test(q)) out.year = { from: `${n}-01-01`, to: `${n}-12-31` };
    // A long run of digits is also a phone number typed without punctuation.
    if (/^\d{7,}$/.test(q)) out.digits = q;
    return out;
  }

  // Email: an @ with no spaces.
  if (/^\S+@\S*$/.test(q)) return { kind: "email", value: normalizeEmail(q) };

  // Phone: digits with phone punctuation only, at least 6 digits.
  if (/^[+\d][\d\s().\-]*$/.test(q)) {
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 6) return { kind: "phone", digits };
  }

  // Text. Quoted phrases stay together; =word is whole word; *word is contains.
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  const groups = nameGroups();
  while ((m = re.exec(q))) {
    if (m[1] !== undefined) {
      const words = tokenize(normalizeText(m[1]));
      if (words.length) terms.push({ word: words.join(" "), mode: "phrase", also: [] });
      continue;
    }
    let tok = m[2], mode = "start";
    if (tok.startsWith("=")) { mode = "whole"; tok = tok.slice(1); }
    else if (tok.startsWith("*")) { mode = "contains"; tok = tok.slice(1); }
    const words = tokenize(normalizeText(tok));
    if (!words.length) continue;
    // A token like "555-1234" normalizes to two words; each must match.
    for (const w of words) {
      const also = groups.has(w) ? [...groups.get(w)].filter((x) => x !== w) : [];
      terms.push({ word: w, mode, also });
    }
  }
  if (!terms.length) return { kind: "empty" };
  return { kind: "text", terms };
}

export const normalizeEmail = (s) => String(s).trim().toLowerCase();

function shiftDay(isoDate, days) {
  const t = new Date(isoDate + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

// One line a person can read, for the UI and the log.
export function describePlan(p) {
  switch (p.kind) {
    case "number": return p.year ? `number ${p.value}, or a date in ${p.value}` : p.digits ? `number ${p.value}, or a phone number` : `number ${p.value}`;
    case "range": return `number range: ${p.label}`;
    case "date": return p.from === p.to ? `date ${p.label}` : `month ${p.label}`;
    case "daterange": return `date range: ${p.label}`;
    case "month": return `${p.label}, any year`;
    case "email": return `email address`;
    case "phone": return `phone number`;
    case "text": {
      const parts = p.terms.map((t) => {
        const w = t.mode === "phrase" ? `"${t.word}"` : t.mode === "whole" ? `=${t.word}` : t.mode === "contains" ? `*${t.word}` : t.word;
        return t.also.length ? `${w} (also ${t.also.slice(0, 4).join(", ")}${t.also.length > 4 ? ", ..." : ""})` : w;
      });
      return `words: ${parts.join(", ")}`;
    }
    default: return "";
  }
}
