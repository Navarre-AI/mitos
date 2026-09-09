#!/usr/bin/env node
// simulate.mjs - many lazy users, one search field.
//
// Pulls sample rows from a running Mitos server, works out what each table
// holds (people, companies, products, invoices, notes), and writes the kind
// of queries a person types when they know roughly which record they want:
// one word, a typo, "Last, First", the last four digits of a phone, a price
// range, "angry review about noise". Then it runs those queries and reports
// whether the right record came back, at what rank, and how fast.
//
// Usage:
//   node scripts/simulate.mjs --base http://localhost:8080 --dry-run
//   node scripts/simulate.mjs --base https://your-app.fly.dev --key <site key>
//   node scripts/simulate.mjs --compare "exact,fuzzy" "exact,fuzzy,semantic,understand,rerank"
//   node scripts/simulate.mjs --selftest        (no server: fake rows, prints variants)
//
// Flags:
//   --base URL          server (default http://localhost:8080, or MITOS_URL)
//   --key KEY           site key, sent as ?key= on every request (or MITOS_KEY)
//   --per-table N       sample rows per table (default 40)
//   --limit N           total queries to run (default 400), spread across types; 0 runs every variant
//   --concurrency N     parallel requests (default 4)
//   --stages a,b,c      override the server's stage list (exact, fuzzy, semantic, understand, rerank)
//   --ai                add ai=1 so one response carries the AI phase
//   --compare A B       run the same queries with stages A, then stages B, and diff
//   --seed S            reproducible randomness (default "mitos")
//   --dry-run           print the generated queries, no searches
//   --queries-out FILE  save the generated queries as JSON
//   --queries-in FILE   replay a saved set instead of sampling
//   --out-dir DIR       where sim-<timestamp>.json and .md go (default eval/)
//   --selftest          generate from built-in fake rows, no server
//
// Only Node built-ins. The name table is read from ../names.config.js.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Command line ------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    base: process.env.MITOS_URL || "http://localhost:8080",
    key: process.env.MITOS_KEY || process.env.SITE_PASSWORD || "",
    perTable: 40, limit: 400, concurrency: 4, seed: "mitos",
    stages: null, ai: false, compare: null, dryRun: false,
    queriesOut: null, queriesIn: null, outDir: path.join(__dirname, "..", "eval"),
    selftest: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i++; if (i >= argv.length) throw new Error(`${a} needs a value`); return argv[i]; };
    switch (a) {
      case "--base": o.base = next(); break;
      case "--key": o.key = next(); break;
      case "--per-table": o.perTable = Number(next()); break;
      case "--limit": o.limit = Number(next()); break;
      case "--concurrency": o.concurrency = Number(next()); break;
      case "--stages": o.stages = next(); break;
      case "--ai": o.ai = true; break;
      case "--compare": o.compare = [next(), next()]; break;
      case "--seed": o.seed = next(); break;
      case "--dry-run": o.dryRun = true; break;
      case "--queries-out": o.queriesOut = next(); break;
      case "--queries-in": o.queriesIn = next(); break;
      case "--out-dir": o.outDir = next(); break;
      case "--selftest": o.selftest = true; break;
      case "--help": case "-h": o.help = true; break;
      default: throw new Error(`Unknown flag ${a}. Try --help.`);
    }
  }
  o.base = o.base.replace(/\/+$/, "");
  return o;
}

function usage() {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  // The header comment is the help text; print it once, without the slashes.
  const lines = src.split("\n").slice(1);
  const out = [];
  for (const l of lines) { if (!l.startsWith("//")) break; out.push(l.replace(/^\/\/ ?/, "")); }
  console.log(out.join("\n"));
}

// --- Seeded randomness ---------------------------------------------------------
// Same seed, same queries. That is what makes two runs comparable.
function makeRng(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (arr) => arr[int(arr.length)];
  const shuffle = (arr) => { const c = [...arr]; for (let i = c.length - 1; i > 0; i--) { const j = int(i + 1); [c[i], c[j]] = [c[j], c[i]]; } return c; };
  return { next, int, pick, shuffle };
}

// --- Text helpers (same normalization the server uses) ---------------------------
const stripAccents = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const normalizeText = (s) => stripAccents(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (s) => normalizeText(s).split(" ").filter(Boolean);
const digitsOf = (s) => String(s ?? "").replace(/\D/g, "");

const STOP = new Set(("a an the and or of in on at to for with from by is was were are be this that it its as " +
  "we our you your they their he she his her i my me not no very so too but if then than there here " +
  "have has had do did will would can could should just also about into over under more most some any " +
  "all only one two out up down off again still even ever never always which who whom what when where " +
  "how why range").split(" "));

// --- The name table ---------------------------------------------------------------
async function loadNameGroups() {
  try {
    const mod = await import(path.join(__dirname, "..", "names.config.js"));
    return mod.DEFAULT_NAME_GROUPS || [];
  } catch { return []; }
}
function nameMap(groups) {
  const map = new Map();
  for (const g of groups) {
    const norm = [...new Set(g.map((n) => words(n)[0]).filter(Boolean))];
    for (const n of norm) { const set = map.get(n) || new Set(); for (const o of norm) set.add(o); map.set(n, set); }
  }
  return map;
}

// --- HTTP -------------------------------------------------------------------------
async function getJson(opts, pathname, params = {}) {
  const url = new URL(pathname, opts.base + "/");
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  if (opts.key) url.searchParams.set("key", opts.key);
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs || 90000) }); }
  catch (e) {
    if (e.name === "TimeoutError") throw new Error(`${pathname}: timed out`);
    if (/ECONNREFUSED|fetch failed/.test(`${e.message} ${e.cause?.code || ""}`)) throw new Error(`No server answers at ${opts.base}. Start Mitos (npm start) or pass --base.`);
    throw new Error(`${pathname}: ${e.message}`);
  }
  if (res.status === 401) throw new Error("The server answered 401. Pass --key <site key> (or set MITOS_KEY).");
  if (res.status === 404) throw new Error(`${pathname} is not on this server (404).`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${pathname} answered ${res.status} with non-JSON: ${text.slice(0, 120)}`); }
  if (!res.ok) throw new Error(data.error || `${pathname} answered ${res.status}`);
  return data;
}

// --- Discovery and sampling ---------------------------------------------------------
async function discover(opts) {
  const status = await getJson(opts, "/api/index/status");
  const config = await getJson(opts, "/api/config");
  const total = status.stats?.totalRows || 0;
  if (!total) throw new Error("The index is empty. Press Sync now in the Mitos window, then run again.");
  let tables = (status.stats.tables || [])
    .filter((t) => Number(t.rows) > 0)
    .map((t) => ({ name: t.src_table, rows: Number(t.rows) }));
  // Older status shapes list names only; sample anyway and let the server say.
  if (!tables.length) tables = (status.tables || []).map((name) => ({ name, rows: null }));
  if (!tables.length) throw new Error("The server lists no tables. Check the index status in the Mitos window.");
  for (const t of tables) { t.label = config.displayNames?.[t.name] || t.name; t.cfg = config.tables?.[t.name] || null; }
  return { tables, dateFormat: config.dateFormat === "dmy" ? "dmy" : "mdy" };
}

async function sampleRows(opts, table, n) {
  let data;
  try { data = await getJson(opts, "/api/index/sample", { n, table }); }
  catch (e) {
    if (/404/.test(e.message)) throw new Error("GET /api/index/sample is not on this server. Update Mitos, then run again.");
    throw e;
  }
  return (data.rows || []).map((r) => normalizeRow(r, table));
}

// A sample row -> { table, id, title, fields }. `fields` is parsed back from
// the "Field: value" text the row was indexed from, so queries are built only
// from values the search can actually see.
function normalizeRow(r, table) {
  const fields = parseSourceText(r.source_text);
  const display = r.display || {};
  const title = String(Object.values(display)[0] ?? Object.values(fields)[0] ?? "").trim();
  return { table: r.table || table, id: String(r.id), title, fields, display };
}
function parseSourceText(text) {
  const out = {};
  let last = null;
  for (const line of String(text ?? "").split("\n")) {
    const m = /^([^:\n]{1,64}): ?(.*)$/.exec(line);
    if (m) { last = m[1].trim(); out[last] = m[2]; }
    else if (last !== null) out[last] += "\n" + line;   // a value that spans lines
  }
  return out;
}

// --- Classification ---------------------------------------------------------------
// Field roles from names first, then from value shapes. A person checks the
// printed result; the heuristics only need to be right often enough.
const FIELD_RULES = [
  ["id", /(^|_)id$|uuid|^pk$|primary/i],
  ["first", /\bfirst\b|first_?name|given/i],
  ["last", /\blast\b|last_?name|surname|family/i],
  ["fullName", /full_?name|display_?name|^contact$/i],
  ["email", /e-?mail/i],
  ["phone", /phone|\btel\b|mobile|cell|fax/i],
  ["invoiceNo", /invoice_?(no|num|number|id)|^inv(oice)?$|inv_?no|invoice$/i],
  ["description", /desc/i],
  ["note", /review|note|comment|remark|feedback|body|memo|text$/i],
  ["price", /price|amount|total|cost|rate|balance|fee|salary|revenue|budget/i],
  ["date", /date|since|created|modified|due|\bwhen\b|_at$|birthday|dob/i],
  ["city", /city|town/i],
  ["state", /\bstate\b|region|province|county/i],
  ["country", /country/i],
  ["category", /categor|\btype\b|industry|kind|dept|department|genre|sector/i],
  ["brand", /brand|\bmake\b|manufacturer/i],
  ["model", /model|sku/i],
  ["task", /task|project|subject|summary/i],
  ["status", /status|stage|priority/i],
  ["company", /company|organi[sz]ation|^org\b|vendor|customer|account|client|firm|employer/i],
  ["name", /name|title/i],
];

const looksEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
const looksPhone = (v) => /^[+(]?[\d][\d\s().-]{5,}$/.test(String(v).trim()) && digitsOf(v).length >= 7;
const looksNumber = (v) => /^[-+]?[$€£]?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(String(v).trim());
const looksDate = (v) => parseDateValue(v) !== null;

function roleFromValues(values) {
  const vs = values.filter((v) => v !== "" && v != null);
  if (vs.length < 3) return null;
  const share = (fn) => vs.filter(fn).length / vs.length;
  if (share(looksEmail) >= 0.6) return "email";
  if (share(looksDate) >= 0.6) return "date";
  if (share(looksPhone) >= 0.6) return "phone";
  if (share(looksNumber) >= 0.8) return "number";
  const avg = vs.reduce((a, v) => a + String(v).length, 0) / vs.length;
  if (avg > 80) return "note";
  return null;
}

function classifyTable(table, rows) {
  const fieldNames = [...new Set(rows.flatMap((r) => Object.keys(r.fields)))];
  const roles = {};
  const fieldKinds = {};
  for (const f of fieldNames) {
    const values = rows.map((r) => r.fields[f]).filter((v) => v != null && v !== "");
    const byName = (FIELD_RULES.find(([, re]) => re.test(f)) || [null])[0];
    const byValue = roleFromValues(values);
    // The value shape wins when it is unambiguous (an email is an email
    // whatever the field is called); otherwise the name decides.
    let role = byName;
    if (["email", "phone", "date"].includes(byValue)) role = byValue;
    else if (!role && byValue) role = byValue;
    else if (role === "name" && byValue === "note") role = "note";
    if (!role) role = "text";
    fieldKinds[f] = role;
    (roles[role] ||= []).push(f);
  }
  const titleField = rows.find((r) => r.display && Object.keys(r.display).length)
    ? Object.keys(rows.find((r) => r.display && Object.keys(r.display).length).display)[0]
    : fieldNames[0];
  const has = (r) => Boolean(roles[r]?.length);
  let kind = "generic";
  if ((has("first") && has("last")) || (has("fullName") && (has("email") || has("phone")))) kind = "people";
  else if (has("invoiceNo")) kind = "invoice";
  else if (has("note") && !has("price")) kind = "review";
  else if ((has("price") || has("brand") || has("model")) && (has("name") || has("category") || has("description"))) kind = "product";
  else if (has("task") || (has("status") && has("name"))) kind = "task";
  else if (has("company") || (has("name") && (has("category") || has("city") || has("country")))) kind = "company";
  else if (has("name") && has("email")) kind = "people";
  // Word frequency across the sample: rare words are what a person remembers.
  const df = new Map();
  for (const r of rows) for (const w of new Set(words(Object.values(r.fields).join(" ")))) df.set(w, (df.get(w) || 0) + 1);
  return { table: table.name, label: table.label, rows: table.rows, sampled: rows.length, kind, titleField, roles, fieldKinds, df };
}

function printClassification(classes) {
  console.log("Tables and what they look like:");
  for (const c of classes) {
    console.log(`  ${c.label} (${c.table}): ${c.kind}, ${c.rows} rows, ${c.sampled} sampled, title field "${c.titleField}"`);
    const parts = Object.entries(c.roles).filter(([r]) => r !== "text" && r !== "id").map(([r, fs]) => `${r}=${fs.join("|")}`);
    if (parts.length) console.log(`    ${parts.join("  ")}`);
  }
  console.log("");
}

// --- Value parsing --------------------------------------------------------------------
function parseNumberValue(v) {
  const t = String(v ?? "").trim();
  if (!looksNumber(t)) return null;
  const n = Number(t.replace(/[$€£,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
// ISO first (what OData sends), then m/d/yyyy or d/m/yyyy by the server's setting.
function parseDateValue(v, dateFormat = "mdy") {
  const t = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return check(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t);
  if (m) {
    let a = +m[1], b = +m[2];
    let dmy = dateFormat === "dmy";
    if (a > 12 && b <= 12) dmy = true;
    if (b > 12 && a <= 12) dmy = false;
    return dmy ? check(+m[3], b, a) : check(+m[3], a, b);
  }
  return null;
  function check(y, mo, d) { return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1000 ? { y, m: mo, d } : null; }
}
function fmtDate({ y, m, d }, dateFormat) { return dateFormat === "dmy" ? `${d}/${m}/${y}` : `${m}/${d}/${y}`; }
function shiftDate({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() + days);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// --- Query generation ---------------------------------------------------------------------
// Types whose query carries filler words on purpose. They are AI-expected even
// when every word happens to start a word in the record.
const ALWAYS_AI = new Set(["nl_company", "nl_someone", "nl_the_one", "nl_new_since", "note_sentiment", "product_descriptive"]);
// Types the front door reads as a number, date, phone or email. Deterministic by design.
const TYPED = new Set(["email_full", "email_local_at", "phone_last7", "phone_last4", "phone_dashed", "phone_digits",
  "number_exact", "number_range", "number_gt", "date_exact", "date_month", "date_range", "invoice_number"]);

// Every word of the query must start a word in the record (or be a nickname
// of one). That is exactly the deterministic engine's rule, so it predicts
// whether a miss is a bug or a job for the AI stages.
function prefixMatches(query, row, names) {
  const rowWords = words(Object.values(row.fields).join(" "));
  const qs = words(query);
  if (!qs.length) return false;
  return qs.every((q) => rowWords.some((w) => w.startsWith(q)) || (names.get(q) && rowWords.some((w) => names.get(q).has(w))));
}

const VOWELS = "aeiou";
// Typos land after the first letter: a lazy typist still starts the word right.
function typoSwap(w, rng) { if (w.length < 4) return null; const i = 1 + rng.int(w.length - 2); if (w[i] === w[i + 1]) return null; return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2); }
function typoDrop(w, rng) { if (w.length < 4) return null; const i = 1 + rng.int(w.length - 1); return w.slice(0, i) + w.slice(i + 1); }
function typoDouble(w, rng) { if (w.length < 4) return null; const i = 1 + rng.int(w.length - 1); return w.slice(0, i + 1) + w[i] + w.slice(i + 1); }
function typoVowel(w, rng) {
  if (w.length < 5) return null;
  const spots = [...w].map((c, i) => (i > 0 && VOWELS.includes(c.toLowerCase()) ? i : -1)).filter((i) => i >= 0);
  if (!spots.length) return null;
  const i = rng.pick(spots);
  const other = rng.pick([...VOWELS].filter((v) => v !== w[i].toLowerCase()));
  return w.slice(0, i) + other + w.slice(i + 1);
}
function spaceInside(w, rng) { if (w.length < 4) return null; const i = 2 + rng.int(w.length - 3); return w.slice(0, i) + " " + w.slice(i); }

// The longest word of the title carries the typo; a title with only short
// words gives none, which is also what a person would do.
function longestWord(ws) { return ws.reduce((a, b) => (b.length > a.length ? b : a), ""); }
function replaceWord(title, from, to) { return title.replace(from, to); }

function distinctiveWords(text, cls, n) {
  const seen = new Set();
  const cands = words(text).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOP.has(w) && !seen.has(w) && seen.add(w));
  cands.sort((a, b) => (cls.df.get(a) || 0) - (cls.df.get(b) || 0) || b.length - a.length);
  return cands.slice(0, n);
}

// Sentiment words decide the tone; topic words are what the review is about.
// "angry review about noise", "happy with the breakfast".
const POSITIVE = ["great", "excellent", "wonderful", "lovely", "perfect", "amazing", "fantastic", "friendly", "clean", "comfortable", "delicious", "helpful", "happy", "pleasant", "good", "best", "nice", "enjoyed", "recommend", "quiet", "spotless", "warm"];
const NEGATIVE = ["terrible", "awful", "dirty", "noisy", "noise", "loud", "rude", "cold", "broken", "slow", "bad", "worst", "disappointing", "disappointed", "poor", "smell", "smelly", "late", "angry", "horrible", "refund", "complaint", "problem", "leak", "cockroach", "overpriced", "cramped"];
const NEG_TOPICS = ["noise", "smell", "refund", "leak", "cockroach", "damp", "mold", "traffic", "bar", "wifi", "parking", "shower", "bathroom", "bed", "heating", "elevator", "checkin"];
const POS_TOPICS = ["breakfast", "staff", "view", "pool", "beach", "location", "terrace", "garden", "food", "service", "room", "bed", "spa", "host"];

function firstValue(row, cls, role) {
  for (const f of cls.roles[role] || []) { const v = row.fields[f]; if (v != null && String(v).trim() !== "") return String(v).trim(); }
  return null;
}

// Who is this row about? People rows give first and last; the title gives
// the rest. Company rows use the title as the name.
function personParts(row, cls) {
  let first = firstValue(row, cls, "first"), last = firstValue(row, cls, "last");
  if (!first || !last) {
    const full = firstValue(row, cls, "fullName") || row.title;
    const ws = String(full).trim().split(/\s+/);
    if (ws.length >= 2) { first = first || ws[0]; last = last || ws[ws.length - 1]; }
  }
  return first && last ? { first, last } : null;
}

function priceTier(n) { return n < 100 ? "budget" : n <= 500 ? "mid-range" : "premium"; }

function generateForRow(row, cls, ctx) {
  const { rng, names, dateFormat } = ctx;
  const out = [];
  const add = (type, query) => { if (query && String(query).trim()) out.push({ type, query: String(query).trim() }); };
  const title = row.title;
  const tw = title.split(/\s+/).filter(Boolean);

  // Title: exact and lazy partials.
  if (title) {
    add("title_exact", title);
    // A single word needs three letters to be worth typing ("Co" is not).
    if (tw.length >= 2) {
      if (words(tw[0]).join("").length >= 3) add("title_first_word", tw[0]);
      if (words(tw[tw.length - 1]).join("").length >= 3) add("title_last_word", tw[tw.length - 1]);
    }
    if (tw.length >= 3) { const i = rng.int(tw.length - 1); add("title_two_words", `${tw[i]} ${tw[i + 1]}`); }
    if (title !== title.toLowerCase()) add("title_lower", title.toLowerCase());
    if (stripAccents(title) !== title) add("title_no_accents", stripAccents(title));
    // Typos on the longest word.
    const lw = longestWord(tw);
    if (lw.length >= 4) {
      const s = typoSwap(lw, rng); if (s) add("typo_swap", replaceWord(title, lw, s));
      const d = typoDrop(lw, rng); if (d) add("typo_drop", replaceWord(title, lw, d));
      const b = typoDouble(lw, rng); if (b) add("typo_double", replaceWord(title, lw, b));
      const v = typoVowel(lw, rng); if (v) add("typo_vowel", replaceWord(title, lw, v));
      const sp = spaceInside(lw, rng); if (sp) add("space_inserted", replaceWord(title, lw, sp));
    }
    if (tw.length >= 2) { const i = rng.int(tw.length - 1); add("words_joined", (tw[i] + tw[i + 1]).toLowerCase()); }
  }

  // People.
  const person = cls.kind === "people" ? personParts(row, cls) : null;
  if (person) {
    const { first, last } = person;
    add("person_last_first", `${last}, ${first}`);
    add("person_first_only", first);
    const fw = words(first)[0];
    if (fw && names.has(fw)) {
      const others = [...names.get(fw)].filter((n) => n !== fw && /^[a-z]+$/.test(n));
      if (others.length) { const nick = rng.pick(others); add("person_nickname", `${nick[0].toUpperCase()}${nick.slice(1)} ${last}`); }
    }
    const initial = String.fromCharCode(65 + rng.int(26));
    add("person_honorific_middle", `${rng.pick(["Mr.", "Ms.", "Dr.", "Mrs."])} ${first} ${initial}. ${last}, ${rng.pick(["Esq.", "Jr.", "PhD"])}`);
    add("person_initials", `${first[0].toUpperCase()}. ${last}`);
  }

  // Email and phone, on any table that has them.
  const email = firstValue(row, cls, "email");
  if (email && email.includes("@")) {
    add("email_local", email.split("@")[0]);
    add("email_local_at", email.split("@")[0] + "@");
    add("email_full", email);
  }
  const phone = firstValue(row, cls, "phone");
  const pd = phone ? digitsOf(phone) : "";
  if (pd.length >= 7) {
    const last7 = pd.slice(-7);
    add("phone_last7", last7);
    add("phone_last4", pd.slice(-4));
    add("phone_dashed", `${last7.slice(0, 3)}-${last7.slice(3)}`);
    add("phone_digits", pd);
  }

  // Numbers and amounts.
  const priceRaw = firstValue(row, cls, "price") ?? firstValue(row, cls, "number");
  const price = priceRaw != null ? parseNumberValue(priceRaw) : null;
  // Nobody finds a record by typing "2": small values (a rating, a count)
  // are not how a person remembers a row. Amounts from 10 up are.
  if (price !== null && Math.abs(price) >= 10) {
    add("number_exact", String(price));
    const lo = Math.floor(price * 0.8), hi = Math.ceil(price * 1.2) + (price === 0 ? 1 : 0);
    add("number_range", `${lo}...${hi}`);
    // ">" is strict on the server, so a person who wants this value types a
    // little under it ("over 40" for a 45 dollar item).
    const under = Number.isInteger(price) ? price - 1 : Math.floor(price);
    if (under < price) add("number_gt", `>${under}`);
  }

  // Dates.
  const dateRaw = firstValue(row, cls, "date");
  const date = dateRaw ? parseDateValue(dateRaw, dateFormat) : null;
  if (date) {
    add("date_exact", fmtDate(date, dateFormat));
    add("date_month", `${date.m}/${date.y}`);
    add("date_range", `${fmtDate(shiftDate(date, -7), dateFormat)}...${fmtDate(shiftDate(date, 7), dateFormat)}`);
  }

  // Invoices.
  const invNo = firstValue(row, cls, "invoiceNo");
  if (invNo) {
    const bare = invNo.replace(/^[^\d]*/, "") || invNo;
    add("invoice_inv", `inv ${bare}`);
    add(/^\d+$/.test(bare) ? "invoice_number" : "invoice_code", bare);
  }
  const desc = firstValue(row, cls, "description");
  if (desc && cls.kind === "invoice") { const ws = distinctiveWords(desc, cls, 3); if (ws.length === 3) add("invoice_desc_words", ws.join(" ")); }

  // Products.
  if (cls.kind === "product") {
    const brand = firstValue(row, cls, "brand"), model = firstValue(row, cls, "model");
    if (brand && model) add("product_brand_model", `${brand} ${model}`);
    else if (tw.length >= 2) add("product_brand_model", `${tw[0]} ${tw[1]}`);
    const cat = firstValue(row, cls, "category");
    const tier = price !== null ? priceTier(price) : (firstValue(row, cls, "text") || "").match(/budget|mid-range|premium/i)?.[0] || null;
    if (cat && tier) add("product_descriptive", `${tier} ${cat.toLowerCase()}`);
    else if (cat && desc) { const w = distinctiveWords(desc, cls, 1)[0]; if (w) add("product_descriptive", `${w} ${cat.toLowerCase()}`); }
  }

  // Reviews and long notes.
  const note = firstValue(row, cls, "note");
  if (note && note.length >= 40) {
    const nw = words(note);
    const neg = nw.some((w) => NEGATIVE.includes(w)), pos = nw.some((w) => POSITIVE.includes(w));
    const fallback = distinctiveWords(note, cls, 1)[0];
    if (neg) {
      const topic = nw.find((w) => NEG_TOPICS.includes(w)) || fallback;
      if (topic) add("note_sentiment", `${rng.pick(["angry review about", "complaint about the", "unhappy about the"])} ${topic}`);
    } else if (pos) {
      const topic = nw.find((w) => POS_TOPICS.includes(w)) || fallback;
      if (topic) add("note_sentiment", `${rng.pick(["happy with the", "loved the", "great"])} ${topic}`);
    }
    const three = distinctiveWords(note, cls, 3);
    if (three.length === 3) add("note_three_words", three.join(" "));
  }

  // Natural language, the way a person says it out loud.
  const city = firstValue(row, cls, "city"), state = firstValue(row, cls, "state"), country = firstValue(row, cls, "country");
  const place = state || city || country;
  if (cls.kind === "company" && title) add("nl_company", city ? `a company called ${title} in ${city}` : `a company called ${title}`);
  if (person) add("nl_someone", `someone named ${person.first} ${person.last} or something like that`);
  if (title && place) add("nl_the_one", `${tw[0]} the one in ${place}`);
  const cat = firstValue(row, cls, "category");
  if (cat && date) add("nl_new_since", `new ${cat.toLowerCase()} since ${MONTHS[date.m - 1]} ${date.y}`);

  // Tag each variant with what should answer it.
  return out.map((v) => ({
    table: row.table, id: row.id, title: row.title, query: v.query, type: v.type,
    expect: expectationFor(v, row, names),
  }));
}

function expectationFor(v, row, names) {
  if (ALWAYS_AI.has(v.type)) return "ai";
  if (TYPED.has(v.type)) return "deterministic";
  return prefixMatches(v.query, row, names) ? "deterministic" : "ai";
}

function generateAll(samples, classes, ctx) {
  const all = [];
  for (const cls of classes) for (const row of samples[cls.table] || []) all.push(...generateForRow(row, cls, ctx));
  // Drop exact repeats of one type on one row. Case matters here: the
  // lowercased title is its own variant.
  const seen = new Set();
  return all.filter((q) => { const k = `${q.table}|${q.id}|${q.type}|${q.query}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Spread the budget across types: round-robin over shuffled per-type lists,
// so a rare type (invoice_inv) is not crowded out by a common one.
function pickQueries(all, limit, rng) {
  if (!limit || all.length <= limit) return rng.shuffle(all);
  const byType = new Map();
  for (const q of rng.shuffle(all)) (byType.get(q.type) || byType.set(q.type, []).get(q.type)).push(q);
  const lists = [...byType.values()];
  const out = [];
  while (out.length < limit && lists.some((l) => l.length)) for (const l of lists) { if (out.length >= limit) break; if (l.length) out.push(l.pop()); }
  return out;
}

// --- Running ----------------------------------------------------------------------------
async function runQueries(queries, opts, stages, label) {
  const results = new Array(queries.length);
  let next = 0, done = 0;
  const t0 = Date.now();
  const tick = () => { done++; if (done % 25 === 0 || done === queries.length) process.stderr.write(`  ${label || "run"}: ${done}/${queries.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`); };
  const worker = async () => { while (true) { const i = next++; if (i >= queries.length) return; results[i] = await runOne(queries[i], opts, stages); tick(); } };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return results;
}

async function runOne(q, opts, stages) {
  const t0 = performance.now();
  let data;
  try { data = await getJson(opts, "/api/search", { q: q.query, limit: 5, ai: opts.ai ? 1 : undefined, stages: stages || undefined }); }
  catch (e) {
    if (/401/.test(e.message)) throw e;   // no point in 400 more of these
    return { ...q, error: e.message, wallMs: Math.round(performance.now() - t0) };
  }
  const wallMs = Math.round(performance.now() - t0);
  if (data.empty) return { ...q, error: "index empty", wallMs };
  const merged = data.merged || [];
  const same = (m) => m.table === q.table && String(m.id) === String(q.id);
  const idx = merged.findIndex(same);
  const top = merged[0] ? { table: merged[0].label || merged[0].table, id: merged[0].id, title: String(Object.values(merged[0].display || {})[0] ?? ""), why: merged[0].why } : null;
  const best = data.best ? { table: data.best.table, id: data.best.id, confidence: data.best.confidence ?? null, correct: same(data.best) } : null;
  return { ...q, rank: idx >= 0 ? idx + 1 : null, top, best, kind: data.kind, serverMs: data.timings?.totalMs ?? null, wallMs };
}

// --- Scoring ---------------------------------------------------------------------------------
function percentile(nums, p) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1) + 0.5))];
}
function score(rows) {
  const n = rows.length;
  const errors = rows.filter((r) => r.error).length;
  const hit1 = rows.filter((r) => r.rank === 1).length;
  const hit5 = rows.filter((r) => r.rank && r.rank <= 5).length;
  const miss = rows.filter((r) => !r.error && !r.rank).length;
  const withBest = rows.filter((r) => r.best);
  const bestOk = withBest.filter((r) => r.best.correct).length;
  const s = rows.map((r) => r.serverMs), w = rows.map((r) => r.wallMs);
  return { n, hit1, hit5, miss, errors, withBest: withBest.length, bestOk,
    serverMed: percentile(s, 0.5), serverP90: percentile(s, 0.9), wallMed: percentile(w, 0.5), wallP90: percentile(w, 0.9) };
}
function groupScores(rows, keyOf) {
  const g = new Map();
  for (const r of rows) (g.get(keyOf(r)) || g.set(keyOf(r), []).get(keyOf(r))).push(r);
  return [...g.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rs]) => ({ key, ...score(rs) }));
}
const pct = (a, n) => (n ? `${Math.round((100 * a) / n)}%` : "-");
const ms = (v) => (v == null ? "-" : `${v}`);

function padTo(s, w, right) { s = String(s); return right ? s.padStart(w) : s.padEnd(w); }
function table(headers, rows, rightFrom = 1) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => padTo(c, widths[i], i >= rightFrom)).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
function scoreRows(groups) {
  return groups.map((g) => [g.key, g.n, pct(g.hit1, g.n), pct(g.hit5, g.n), pct(g.miss, g.n), g.withBest ? `${g.bestOk}/${g.withBest}` : "-",
    `${ms(g.serverMed)}/${ms(g.serverP90)}`, `${ms(g.wallMed)}/${ms(g.wallP90)}`, g.errors || ""]);
}
const SCORE_HEADERS = ["", "n", "hit@1", "hit@5", "miss", "best ok", "server ms med/p90", "wall ms med/p90", "err"];

function labelOf(classes, tableName) { return classes.find((c) => c.table === tableName)?.label || tableName; }

function report(results, classes, title) {
  const lines = [];
  lines.push(`${title}`);
  lines.push("");
  lines.push("Overall");
  lines.push(table(SCORE_HEADERS, scoreRows([{ key: "all", ...score(results) }])));
  lines.push("");
  lines.push("By expectation (deterministic = every word starts a word in the record; ai = needs more than that)");
  lines.push(table(SCORE_HEADERS, scoreRows(groupScores(results, (r) => r.expect))));
  lines.push("");
  lines.push("By query type");
  lines.push(table(SCORE_HEADERS, scoreRows(groupScores(results, (r) => r.type))));
  lines.push("");
  lines.push("By table");
  lines.push(table(SCORE_HEADERS, scoreRows(groupScores(results, (r) => labelOf(classes, r.table)))));
  return lines.join("\n");
}

// Deterministic-expected misses first: those are bugs, not AI work.
function worstMisses(results, n = 40) {
  const misses = results.filter((r) => !r.error && r.rank !== 1);
  const order = (r) => (r.expect === "deterministic" ? 0 : 1) * 100 + (r.rank ? 99 - r.rank : 0);
  misses.sort((a, b) => order(a) - order(b));
  return misses.slice(0, n);
}

function compareTable(a, b, labels, keyOf, heading) {
  const ga = new Map(groupScores(a, keyOf).map((g) => [g.key, g])), gb = new Map(groupScores(b, keyOf).map((g) => [g.key, g]));
  const keys = [...new Set([...ga.keys(), ...gb.keys()])].sort();
  const rows = keys.map((k) => {
    const x = ga.get(k) || score([]), y = gb.get(k) || score([]);
    const d = (p, q, n) => (n ? `${Math.round((100 * (q - p)) / n) >= 0 ? "+" : ""}${Math.round((100 * (q - p)) / n)}` : "-");
    return [k, x.n, pct(x.hit1, x.n), pct(y.hit1, y.n), d(x.hit1, y.hit1, x.n), pct(x.hit5, x.n), pct(y.hit5, y.n), d(x.hit5, y.hit5, x.n), ms(x.wallMed), ms(y.wallMed)];
  });
  const [la, lb] = labels;
  return `${heading}\n` + table(["", "n", `hit@1 ${la}`, `hit@1 ${lb}`, "diff", `hit@5 ${la}`, `hit@5 ${lb}`, "diff", `ms ${la}`, `ms ${lb}`], rows);
}

// --- Output files ----------------------------------------------------------------------------
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }

function writeOutputs(opts, payload, consoleText, classes) {
  fs.mkdirSync(opts.outDir, { recursive: true });
  const base = path.join(opts.outDir, `sim-${stamp()}`);
  fs.writeFileSync(base + ".json", JSON.stringify(payload, null, 2));
  const md = [];
  md.push(`# Mitos simulation ${payload.at}`);
  md.push("");
  md.push(`Server: ${payload.base}  ` + `Stages: ${payload.stages || "server default"}  ` + `AI: ${payload.ai ? "yes" : "no"}  ` + `Seed: ${payload.seed}  ` + `Queries: ${payload.queries}`);
  md.push("");
  md.push("## Tables");
  md.push("");
  for (const c of classes) md.push(`- ${c.label} (${c.table}): ${c.kind}, ${c.rows} rows, title "${c.titleField}", ` + Object.entries(c.roles).filter(([r]) => r !== "text" && r !== "id").map(([r, fs]) => `${r}=${fs.join("|")}`).join(", "));
  md.push("");
  md.push("## Scores");
  md.push("");
  md.push("```");
  md.push(consoleText);
  md.push("```");
  const runs = payload.runs || [{ label: payload.stages || "default", results: payload.results }];
  for (const run of runs) {
    const misses = worstMisses(run.results);
    md.push("");
    md.push(`## Worst misses${runs.length > 1 ? ` (${run.label})` : ""}`);
    md.push("");
    if (!misses.length) md.push("None. Every query put the right record first.");
    else {
      md.push("| expect | type | query | wanted | got top-1 | rank | why |");
      md.push("|---|---|---|---|---|---|---|");
      const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 80);
      for (const m of misses) md.push(`| ${m.expect} | ${m.type} | ${cell(m.query)} | ${cell(m.title)} (${labelOf(classes, m.table)}) | ${m.top ? `${cell(m.top.title)} (${cell(m.top.table)})` : "nothing"} | ${m.rank ?? "miss"} | ${cell((m.top?.why || []).join("; "))} |`);
    }
    const errors = run.results.filter((r) => r.error);
    if (errors.length) {
      md.push("");
      md.push(`## Errors (${errors.length})`);
      md.push("");
      for (const e of errors.slice(0, 20)) md.push(`- "${e.query}": ${e.error}`);
    }
  }
  fs.writeFileSync(base + ".md", md.join("\n") + "\n");
  return base;
}

// --- Self test rows (no server) --------------------------------------------------------------
function fakeSamples() {
  const row = (table, id, fields, displayKeys) => ({ table, id, title: String(fields[displayKeys[0]]), fields, display: Object.fromEntries(displayKeys.map((k) => [k, fields[k]])) });
  const people = [
    row("people", "P0001", { first: "Matt", last: "Navarre", full_name: "Matt Navarre", email: "matt.navarre@example.com", phone: "+11 629 773 9565", city: "Athens", country: "Greece", since: "2019-03-04", note: "primary" }, ["full_name", "email", "phone", "city", "since"]),
    row("people", "P0002", { first: "Robert", last: "Whitfield", full_name: "Robert Whitfield", email: "robert.whitfield@example.com", phone: "+1 503 555 0142", city: "Portland", country: "USA", since: "2021-11-30", note: "" }, ["full_name", "email", "phone", "city", "since"]),
    row("people", "P0003", { first: "Siobhán", last: "Murphy", full_name: "Siobhán Murphy", email: "siobhan.murphy@example.com", phone: "+353 1 555 0199", city: "Cork", country: "Ireland", since: "2020-06-15", note: "" }, ["full_name", "email", "phone", "city", "since"]),
  ];
  const orgs = [
    row("organizations", "O0001", { name: "Hank's Used Nuclear Reactor Parts", industry: "Energy", street: "58 Harbor Rd", city: "Rome", country: "Italy" }, ["name", "industry", "city", "country"]),
    row("organizations", "O0002", { name: "Phoenix Cardiac Clinic", industry: "Health", street: "12 Main St", city: "Phoenix", country: "USA" }, ["name", "industry", "city", "country"]),
    row("organizations", "O0003", { name: "Quietwater Maritime Salvage", industry: "Maritime", street: "380 Harbor Rd", city: "Rethymno", country: "Greece" }, ["name", "industry", "city", "country"]),
  ];
  const products = [
    row("products", "PR0001", { name: "Canvas Sneakers", category: "Shoes", price: "45", tier: "budget", description: "Canvas Sneakers, shoes in the budget range." }, ["name", "category", "price", "tier"]),
    row("products", "PR0002", { name: "Canon EOS R6 Mark II", category: "Cameras", price: "2499", tier: "premium", description: "Full-frame mirrorless camera body with in-body stabilization." }, ["name", "category", "price", "tier"]),
    row("products", "PR0003", { name: "Nikon D3500", category: "Cameras", price: "449", tier: "mid-range", description: "Entry level digital SLR with kit lens." }, ["name", "category", "price", "tier"]),
  ];
  const invoices = [
    row("invoices", "I1", { invoice_number: "INV-10042", customer: "Phoenix Cardiac Clinic", description: "Annual maintenance contract for the imaging suite", amount: "12500", invoice_date: "2026-02-14" }, ["invoice_number", "customer", "amount", "invoice_date"]),
    row("invoices", "I2", { invoice_number: "INV-10043", customer: "Quietwater Maritime Salvage", description: "Sonar calibration and dive gear rental", amount: "3200", invoice_date: "2026-03-02" }, ["invoice_number", "customer", "amount", "invoice_date"]),
    row("invoices", "I3", { invoice_number: "INV-10044", customer: "Bluewater Group", description: "Consulting hours for the harbor expansion study", amount: "8750.50", invoice_date: "2026-03-21" }, ["invoice_number", "customer", "amount", "invoice_date"]),
  ];
  const reviews = [
    row("reviews", "R1", { hotel: "Harbor View Inn", rating: "2", review: "The room was noisy all night, traffic noise and a loud bar downstairs. Staff were friendly but we could not sleep at all. Would not stay again." }, ["hotel", "rating"]),
    row("reviews", "R2", { hotel: "Olive Grove Suites", rating: "5", review: "Wonderful stay. The breakfast was delicious and the terrace view over the olive groves was lovely. Very clean rooms and helpful staff." }, ["hotel", "rating"]),
    row("reviews", "R3", { hotel: "Cliffside Retreat", rating: "1", review: "Dirty bathroom, a broken shower and a smell of damp. We asked for a refund and got nowhere. Terrible experience from start to finish." }, ["hotel", "rating"]),
  ];
  const tables = [
    { name: "people", label: "People", rows: 200 }, { name: "organizations", label: "Organizations", rows: 60 },
    { name: "products", label: "Products", rows: 28 }, { name: "invoices", label: "Invoices", rows: 90 }, { name: "reviews", label: "Hotel reviews", rows: 40 },
  ];
  return { tables, samples: { people, organizations: orgs, products, invoices, reviews } };
}

function printQueries(queries) {
  const rows = queries.map((q) => [q.type, q.expect, q.query, `${q.title} [${q.table} ${q.id}]`]);
  console.log(table(["type", "expect", "query", "wants"], rows, 99));
  console.log("");
  const byType = groupScores(queries, (r) => r.type).map((g) => `${g.key} ${g.n}`);
  console.log(`${queries.length} queries: ${byType.join(", ")}`);
}

// --- Main -------------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return 0; }
  const rng = makeRng(opts.seed);
  const names = nameMap(await loadNameGroups());

  let classes, queries, dateFormat = "mdy";
  if (opts.queriesIn) {
    const saved = JSON.parse(fs.readFileSync(opts.queriesIn, "utf8"));
    queries = saved.queries;
    classes = (saved.classification || []).map((c) => ({ ...c, df: new Map() }));
    console.log(`Replaying ${queries.length} queries from ${opts.queriesIn}\n`);
  } else {
    let tables, samples;
    if (opts.selftest) {
      ({ tables, samples } = fakeSamples());
      console.log("Self test: built-in fake rows, no server.\n");
    } else {
      const found = await discover(opts);
      tables = found.tables; dateFormat = found.dateFormat;
      console.log(`${opts.base}: ${tables.length} table(s), ${tables.reduce((a, t) => a + (t.rows || 0), 0)} rows indexed.`);
      samples = {};
      for (const t of tables) {
        samples[t.name] = await sampleRows(opts, t.name, t.rows ? Math.min(opts.perTable, t.rows) : opts.perTable);
        if (t.rows == null) t.rows = samples[t.name].length;
      }
      console.log("");
    }
    classes = tables.map((t) => classifyTable(t, samples[t.name] || []));
    printClassification(classes);
    const all = generateAll(samples, classes, { rng, names, dateFormat });
    queries = pickQueries(all, opts.limit, rng);
    console.log(`Generated ${all.length} query variants, running ${queries.length}.\n`);
  }

  const classificationOut = classes.map(({ df, ...c }) => c);
  if (opts.queriesOut) {
    fs.writeFileSync(opts.queriesOut, JSON.stringify({ at: new Date().toISOString(), seed: opts.seed, classification: classificationOut, queries }, null, 2));
    console.log(`Saved ${queries.length} queries to ${opts.queriesOut}\n`);
  }
  if (opts.dryRun || opts.selftest) { printQueries(queries); return 0; }

  const at = new Date().toISOString();
  let consoleText, payload;
  if (opts.compare) {
    const [a, b] = opts.compare;
    const ra = await runQueries(queries, opts, a, a);
    const rb = await runQueries(queries, opts, b, b);
    const parts = [
      report(ra, classes, `Stages: ${a}`), "", report(rb, classes, `Stages: ${b}`), "",
      `Side by side: A = ${a}, B = ${b} (diff in points of hit rate, B minus A)`,
      compareTable(ra, rb, ["A", "B"], () => "all", "Overall"), "",
      compareTable(ra, rb, ["A", "B"], (r) => r.expect, "By expectation"), "",
      compareTable(ra, rb, ["A", "B"], (r) => r.type, "By query type"), "",
      compareTable(ra, rb, ["A", "B"], (r) => labelOf(classes, r.table), "By table"),
    ];
    consoleText = parts.join("\n");
    payload = { at, base: opts.base, stages: `${a} vs ${b}`, ai: opts.ai, seed: opts.seed, queries: queries.length, classification: classificationOut,
      runs: [{ label: a, summary: score(ra), byType: groupScores(ra, (r) => r.type), results: ra }, { label: b, summary: score(rb), byType: groupScores(rb, (r) => r.type), results: rb }] };
  } else {
    const results = await runQueries(queries, opts, opts.stages, opts.stages || "default");
    consoleText = report(results, classes, `Stages: ${opts.stages || "server default"}${opts.ai ? ", ai=1" : ""}`);
    payload = { at, base: opts.base, stages: opts.stages, ai: opts.ai, seed: opts.seed, queries: queries.length, classification: classificationOut,
      summary: score(results), byExpect: groupScores(results, (r) => r.expect), byType: groupScores(results, (r) => r.type), byTable: groupScores(results, (r) => r.table), results };
  }
  console.log("");
  console.log(consoleText);
  const base = writeOutputs(opts, payload, consoleText, classes);
  console.log("");
  console.log(`Wrote ${base}.json and ${base}.md`);
  const allResults = payload.results || payload.runs.flatMap((r) => r.results);
  return allResults.some((r) => r.error) ? 2 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(`simulate: ${e.message}`); process.exit(1); });
