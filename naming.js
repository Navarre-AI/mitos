// naming.js - the schema naming pass (Pythia's relevance-pass pattern, aimed
// at search instead of reporting).
//
// OData gives table OCCURRENCE names: D_Org~B, O_Staff, HR__Hotel Review.
// Those are developer artifacts. A person searching does not know them, and a
// list of them is unreadable, so one model call turns the schema into human
// names, a judgment about which tables are worth searching, and the one field
// that names a record (the result title).
//
// One call per schema, cached to disk by a signature of the schema itself, so
// it costs nothing until the schema changes.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { askModel, namingInfo, chat, fastModel, isEmbeddingModel } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const CACHE = path.join(DATA_DIR, "naming.json");

const sig = (tables) =>
  crypto.createHash("md5")
    .update(tables.map((t) => `${t.name}:${t.fields.map((f) => f.name).join(",")}`).sort().join("|"))
    .digest("hex");

const SYSTEM = `You name FileMaker tables for a search product.

You get the tables of one FileMaker solution. The names are table OCCURRENCE
names, which are developer shorthand: prefixes, suffixes, underscores and
tildes are noise (D_Org~B is Organization, O_Staff is Person, HR__Hotel Review
is Hotel Review, IL_Product is Product).

For each table return:
- displayName: what a person would call it. Singular, title case, no prefixes,
  no underscores. Use the field names as evidence when the table name is
  cryptic.
- include: true if a person might SEARCH for a record in this table by typing
  a name, a title, a description or a place. False for join tables, logs,
  settings, queues, audit trails, message tables and anything whose rows have
  no human-readable identity.
- reason: at most 12 words, why.
- titleField: the ONE field a person would call a record by (a name, a title,
  a full name, a company name). Must be one of the field names given. Never an
  ID, a UUID, a JSON field, a log, a timestamp. "" if there is no such field.

Reply with ONLY a JSON object: {"tables":[{"name":"<the name given to you>","displayName":"...","include":true,"reason":"...","titleField":"..."}]}
No commentary, no markdown fences. Every table you were given must appear.`;

export function readNaming() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return null; }
}

// Heuristic fallback: used when there is no API key, or the call fails. Never
// leaves the user with raw occurrence names.
function heuristic(tables) {
  const clean = (n) => {
    let s = String(n).replace(/~.*$/, "").replace(/^[A-Z]{1,4}[_]{1,2}/, "").replace(/[_]+/g, " ").trim();
    if (!s) s = String(n);
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  };
  const junk = /log|audit|queue|setting|pref|session|message|temp|import|sync|dashboard|globals?$/i;
  return {
    source: "heuristic (set an API key for AI naming)",
    tables: tables.map((t) => ({
      name: t.name,
      displayName: clean(t.name),
      include: !junk.test(t.name) && t.fields.length >= 3,
      reason: junk.test(t.name) ? "looks like a system table" : "",
      titleField: "",
    })),
  };
}

// tables: [{ name, fields:[{name,type,comment}], rowCount, occurrences }]
export async function nameTables(tables, { force = false } = {}) {
  const signature = sig(tables);
  const cached = readNaming();
  // A heuristic naming carries guessed names. Once a key exists, that cache
  // is stale by definition (Pythia's rule): name again with the model.
  const staleHeuristic = cached && String(cached.source || "").startsWith("heuristic") && namingInfo().configured;
  if (!force && cached?.signature === signature && !staleHeuristic) return cached;

  if (!namingInfo().configured) {
    const out = { ...heuristic(tables), signature, at: new Date().toISOString() };
    fs.writeFileSync(CACHE, JSON.stringify(out, null, 2));
    return out;
  }

  // Keep the payload small: the model needs shape, not data.
  const summary = tables.map((t) => ({
    name: t.name,
    occurrences: (t.occurrenceNames || []).slice(0, 6),
    rows: t.rowCount ?? null,
    fields: t.fields.slice(0, 18).map((f) => f.name),
    comments: t.fields.map((f) => f.comment).filter(Boolean).slice(0, 4),
  }));

  try {
    // The chosen naming model may be refused by the key ("not allowed to
    // sample", a 403 or 404 on the model). Then the provider's fast model
    // names the tables instead, and the cache says which one did.
    let usedModel = namingInfo().model;
    let reply;
    const fast = fastModel();
    const payload = JSON.stringify({ tables: summary });
    // An embedding model cannot name anything (a test box had
    // text-embedding-3-small saved as the naming model on 2026-09-09): go
    // straight to the fast model.
    if (isEmbeddingModel(usedModel) && fast) {
      usedModel = fast;
      reply = await chat({ model: fast, system: SYSTEM, user: payload, maxTokens: 8000 });
    } else {
      try { reply = await askModel(SYSTEM, payload, 8000); }
      catch (e) {
        // Any refusal of the chosen model (403 "not allowed to sample", 404,
        // "not a chat model", a bad request) still names the tables, with the
        // provider's fast model.
        if (!fast || fast === usedModel) throw e;
        usedModel = fast;
        reply = await chat({ model: fast, system: SYSTEM, user: payload, maxTokens: 8000 });
      }
    }
    const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
    const parsed = JSON.parse(reply.slice(start, end + 1));
    const byName = new Map((parsed.tables || []).map((t) => [t.name, t]));
    const merged = tables.map((t) => {
      const a = byName.get(t.name);
      const fb = heuristic([t]).tables[0];
      return {
        name: t.name,
        displayName: a?.displayName || fb.displayName,
        include: typeof a?.include === "boolean" ? a.include : fb.include,
        reason: a?.reason || fb.reason,
        titleField: t.fields.some((f) => f.name === a?.titleField) ? a.titleField : "",
      };
    });
    const out = { source: `ai (${usedModel})${usedModel !== namingInfo().model ? ` after ${namingInfo().model} was refused` : ""}`, signature, at: new Date().toISOString(), tables: merged };
    fs.writeFileSync(CACHE, JSON.stringify(out, null, 2));
    return out;
  } catch (e) {
    const out = { ...heuristic(tables), source: `heuristic (AI naming failed: ${String(e.message).slice(0, 80)})`, signature, at: new Date().toISOString() };
    fs.writeFileSync(CACHE, JSON.stringify(out, null, 2));
    return out;
  }
}

// Raw table name -> display name, from the cache. Empty when nothing is named.
export function proposedDisplayNames() {
  const c = readNaming();
  return Object.fromEntries((c?.tables || []).filter((t) => t.displayName && t.displayName !== t.name).map((t) => [t.name, t.displayName]));
}
export const namesProvisional = () => { const c = readNaming(); return !c || String(c.source || "").startsWith("heuristic"); };
