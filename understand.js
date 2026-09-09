// understand.js - the query understanding stage. A fast model reads what a
// person typed and rewrites it in Mitos's own deterministic syntax, plus a
// few hints the other stages use. The engine then runs the rewrite exactly
// as it runs a typed query, so the plan shape never changes and every hit
// still carries a reason in words.
//
// The model is never trusted with the data: it sees the table and field
// names, today's date and the query, and it answers with a small JSON. A
// late or broken answer leaves the typed query as it was.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chat, parseJson, stages, stageReady } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const CACHE_PATH = path.join(DATA_DIR, "understand-cache.json");

const SYSTEM = `You turn a search typed into a FileMaker database into a precise query for a search engine, plus hints. Answer with ONE JSON object and nothing else.

The engine's query syntax (deterministic):
- words: every word must start a word in the record, any order. Example: matt nav
- "a phrase": words in that order. Example: "cardiac clinic"
- =word: whole word only. *word: anywhere inside a word.
- number: 45 or $5,000. Number range: 100...200, >100, <=45
- date: {DATEFMT}. Month of a year: {MONTHFMT}. A month in any year: month:3. Date range: {DATEFMT}...{DATEFMT}, >{DATEFMT}, <={DATEFMT}
- email: text with @. Phone: digits with dashes or spaces.
Only ONE kind per query. A range cannot be mixed with words.

Rules:
1. Keep an identifier, invoice number, phone, email, amount or date exactly as typed; only strip a label word such as "inv", "invoice", "phone", "ref", "#".
2. For a natural-language sentence, keep only the words that identify the record (names, places, products). Drop filler like "a guy called", "I think", "or something", "the one".
3. Fix obvious spelling of ordinary words; never change a proper name.
4. Every time word becomes an explicit date or date range in the syntax, using today's date. "since July" -> >={FIRSTJULY}. "since 2019" -> >=1/1/2019 written in the date order below. "in the first half of May" -> the 1st to the 15th of May this year. Never leave a word like "since", "after", "before", "last", "this" in the query.
4b. A month with no year, or a birthday, anniversary or "born in" month, is any year: "march birthdays" -> month:3, "people born in May" -> month:5. Use month:<number> for those; a year-bound range only when a year is meant.
5. When a query mixes words and a date or number, the query holds the date or number range and "semantic" holds the words, because one query is one kind.
6. "tables": the raw names of the tables the person means, or [] when unsure. Pick from the list; never invent one.
7. "semantic": the whole thing the person wants, in plain words, for a meaning search, when the query describes a thing rather than naming it (a category, a quality, a price tier, a sentiment, a job); else null. Keep the noun: "mid-range digital camera", not "mid-range".
8. "names": the proper-name words in the query (people, companies), for a spelling-tolerant name search; [] if none.
9. "one": true when the person clearly wants one specific record (a name, an id, an invoice number), false for a set (a range, a category, "people with...").
10. "reading": at most 12 words, what you understood, in plain words.

Examples (today {TODAY}):
- "A spanish guy I think his name was juan valencia or something" -> {"query": "juan valencia", "tables": [], "semantic": null, "names": ["juan", "valencia"], "one": true, "reading": "a person named Juan Valencia"}
- "inv 2216" -> {"query": "2216", "tables": [], "semantic": null, "names": [], "one": true, "reading": "invoice number 2216"}
- "John R. Smith, Esq." -> {"query": "john smith", "tables": [], "semantic": null, "names": ["john", "smith"], "one": true, "reading": "a person named John Smith"}
- "Ac me systems" -> {"query": "acme systems", "tables": [], "semantic": null, "names": ["acme", "systems"], "one": true, "reading": "a company named Acme Systems"}
- "Mid-range digital SLR" -> {"query": "digital slr", "tables": [], "semantic": "mid-range digital SLR camera", "names": [], "one": false, "reading": "mid-priced digital SLR cameras"}
- "New computers since July" -> {"query": ">={FIRSTJULY}", "tables": [], "semantic": "computers", "names": [], "one": false, "reading": "computers added since July 1"}
- "People with birthdays in first half of May" -> {"query": "month:5", "tables": [], "semantic": null, "names": [], "one": false, "reading": "birthdays in May, any year"}
- "march birthdays" -> {"query": "month:3", "tables": [], "semantic": null, "names": [], "one": false, "reading": "birthdays in March, any year"}
- "8675309" -> {"query": "8675309", "tables": [], "semantic": null, "names": [], "one": true, "reading": "a phone number or an id"}
(fill "tables" from the list below when a table clearly fits)

Tables and their searched fields:
{TABLES}

Today is {TODAY}. Dates are typed {DATEWORDS}.

Return: {"query": "<rewritten query in the syntax above, or the original>", "tables": [], "semantic": null, "names": [], "one": false, "reading": "..."}`;

// A small cache in memory and on disk: the same words come back many times,
// and the box reboots often. Keyed by the normalized query plus the schema.
let cache = null;
const CACHE_MAX = 2000;
function loadCache() {
  if (cache) return cache;
  cache = new Map();
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")))) cache.set(k, v); } catch {}
  return cache;
}
let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const c = loadCache();
      while (c.size > CACHE_MAX) c.delete(c.keys().next().value);
      fs.writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(c)));
    } catch {}
  }, 500);
}
export function clearUnderstandCache() { cache = new Map(); try { fs.unlinkSync(CACHE_PATH); } catch {} }

function tableLines(tablesCfg, labels) {
  return Object.entries(tablesCfg).map(([raw, t]) => {
    const fields = [...new Set([...(t.textFields || []), ...(t.displayFields || [])])].slice(0, 12).join(", ");
    return `- ${raw} ("${labels[raw] || raw}"): ${fields}`;
  }).join("\n");
}

const fmt = (d, dateFormat) => { const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate(); return dateFormat === "dmy" ? `${day}/${m}/${y}` : `${m}/${day}/${y}`; };

// Returns { query, tables, semantic, names, one, reading, cached, ms } or
// { error } when the stage could not answer in time. Never throws.
export async function understand(query, { tablesCfg = {}, labels = {}, dateFormat = "mdy", today = new Date() } = {}) {
  const t0 = Date.now();
  const s = stages().understand;
  const ready = stageReady("understand");
  if (!ready.ready) return { error: ready.why, ms: 0 };
  const known = new Set(Object.keys(tablesCfg));
  const key = `${s.model}|${[...known].sort().join(",")}|${dateFormat}|${today.toISOString().slice(0, 10)}|${String(query).trim().toLowerCase()}`;
  const c = loadCache();
  if (c.has(key)) return { ...c.get(key), cached: true, ms: Date.now() - t0 };
  const y = today.getFullYear();
  const d = (m, day) => fmt(new Date(y, m - 1, day), dateFormat);
  const system = SYSTEM
    .replace(/\{DATEFMT\}/g, dateFormat === "dmy" ? "15/1/2026" : "1/15/2026")
    .replace(/\{MONTHFMT\}/g, "1/2026")
    .replace("{TABLES}", tableLines(tablesCfg, labels) || "- (no tables configured)")
    .replace(/\{TODAY\}/g, fmt(today, dateFormat))
    .replace(/\{FIRSTJULY\}/g, d(7, 1)).replace(/\{MAY1\}/g, d(5, 1)).replace(/\{MAY15\}/g, d(5, 15))
    .replace("{DATEWORDS}", dateFormat === "dmy" ? "day/month/year" : "month/day/year");
  try {
    const raw = await chat({ model: s.model, system, user: String(query), maxTokens: 300, timeoutMs: Number(s.timeoutMs) || 2500, json: true });
    const j = parseJson(raw);
    if (!j || typeof j !== "object") return { error: "no JSON in the answer", ms: Date.now() - t0 };
    const out = {
      query: typeof j.query === "string" && j.query.trim() ? j.query.trim() : String(query),
      tables: Array.isArray(j.tables) ? j.tables.filter((t) => known.has(t)) : [],
      semantic: typeof j.semantic === "string" && j.semantic.trim() ? j.semantic.trim() : null,
      names: Array.isArray(j.names) ? j.names.map((n) => String(n).trim()).filter(Boolean).slice(0, 6) : [],
      one: Boolean(j.one),
      reading: typeof j.reading === "string" ? j.reading.trim().slice(0, 120) : "",
    };
    c.set(key, out); saveCache();
    return { ...out, cached: false, ms: Date.now() - t0 };
  } catch (e) {
    const timed = /timeout|abort/i.test(String(e.message));
    return { error: timed ? `no answer in ${s.timeoutMs} ms` : String(e.message).slice(0, 160), ms: Date.now() - t0 };
  }
}
