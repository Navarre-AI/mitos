// stages.js - the two index-time stages, run after the deterministic index
// is written and only when switched on: enrichment (a fast model writes
// search notes per record) and embedding (a vector per record). Both are
// incremental: a row is touched once per content, model and prompt, and a
// sync with nothing new costs nothing. Both stop on the cancel flag between
// batches, and both report through the same events as the sync itself.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chat, parseJson, stages, stageReady, estimateCost, EMBED_CAP_PER_SYNC, PROVIDERS } from "./ai.js";
import { embedTexts, embedInfo, vectorKey } from "./embed.js";
import {
  normalizeText, rowsNeedingEnrichment, writeEnrichment,
  ensureVectorTable, rowsNeedingVectors, countNeedingVectors, writeVectors, pruneVectors,
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// The ledger: one line per paid pass, so the money is visible afterwards.
export function appendPass(entry) {
  try { fs.appendFileSync(path.join(DATA_DIR, "passes.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); } catch {}
}
export function readPasses(limit = 20) {
  try {
    return fs.readFileSync(path.join(DATA_DIR, "passes.jsonl"), "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-limit).reverse();
  } catch { return []; }
}
const tokensOf = (s) => Math.ceil(String(s || "").length / 4);

// --- Enrichment -----------------------------------------------------------------------
// What every table's prompt gets on top: the format, and the one rule that
// keeps rule 1 honest (nothing invented). The text is searched, never shown.
const ENRICH_RULES = `
Output rules: plain text only, one item per line, at most 12 lines, no labels, no headers, no commentary, no markdown.
Use only facts that are in the record. Never invent names, numbers, dates, places or products.
Do not repeat the record itself; write what a person might TYPE to find it.`;

// The default prompt for a table, written from its display name. A person
// edits it per table on the Tables tab (the product prompt wants price
// tiers and colour words; the person prompt wants nicknames).
export function defaultEnrichPrompt(label) {
  return `You write search notes for one ${label || "record"}. Give the alternate names, spellings and abbreviations people might type for it, "Last, First" for a person, common nicknames, and one plain-language line saying what it is.`;
}

export const enrichKeyFor = (model, prompt) => md5(`${model}|${String(prompt || "").trim()}|v1`);

// Several records per call: one prompt, one round trip, one JSON back with
// the notes keyed by record id. A record missing from the answer is left
// for the next sync; nothing is ever attributed to the wrong record.
const ENRICH_BATCH = 10;
const BATCH_RULES = `
You get several records, each under a line "### <id>". Answer with ONE JSON object: {"<id>": "<notes for that record, lines separated by \\n>", ...}, one key per record id given, nothing else.`;
async function enrichBatch(model, prompt, rows, timeoutMs) {
  const user = rows.map((r) => `### ${r.record_id}\n${r.source_text}`).join("\n\n");
  const raw = await chat({ model, system: `${prompt.trim()}\n${ENRICH_RULES}\n${BATCH_RULES}`, user, maxTokens: 220 * rows.length + 200, timeoutMs, json: true });
  const j = parseJson(raw);
  if (!j || typeof j !== "object") throw new Error("no JSON in the enrichment answer");
  const out = new Map();
  for (const r of rows) {
    const v = j[r.record_id];
    const text = Array.isArray(v) ? v.map(String).join("\n") : typeof v === "string" ? v : "";
    const clean = text.replace(/^\s*[-*•]\s*/gm, "").replace(/\n{2,}/g, "\n").trim();
    if (clean) out.set(r.record_id, clean);
  }
  return out;
}

// The prompt for a table: its own, else the overall rules, else the default.
export function promptFor(table, t, label) {
  const s = stages().enrich;
  return (t?.enrich?.prompt || "").trim() || (s.prompt || "").trim() || defaultEnrichPrompt(label || table);
}

// tablesCfg: the saved per-table config (needs .enrich = { on, prompt }).
// `full`: the Run button; a plain sync stops at the quiet cap.
export async function enrichStage({ tablesCfg, labels = {}, onEvent = () => {}, shouldStop = () => false, full = false }) {
  const s = stages().enrich;
  const ready = stageReady("enrich");
  const summary = { ran: false, done: 0, failed: 0, cleared: 0, tables: [], tokens: 0, cost: 0, stopped: [] };
  // A table switched off, or the stage switched off, KEEPS its notes. They
  // were paid for; the search stops matching them while off (store.js
  // termSql), and POST /api/ai/enrich/forget deletes them on purpose. Until
  // 0.4.1 this loop cleared them on every sync, so a switch flipped by
  // mistake threw a paid pass away.
  if (!ready.ready) {
    if (s.on) onEvent({ type: "note", note: `search notes not written this sync: ${ready.why}` });
    return summary;
  }
  summary.ran = true;
  let budget = full ? Infinity : (Math.max(0, Number(s.maxRowsPerSync) || 0) || Infinity);
  const concurrency = Math.max(1, Math.min(16, Number(s.concurrency) || 4));
  for (const [table, t] of Object.entries(tablesCfg)) {
    if (!t.enrich?.on) continue;
    if (shouldStop()) break;
    if (budget <= 0) { onEvent({ type: "note", name: table, note: `enrichment stopped at this sync's cap; press Run on the AI tab for the rest` }); break; }
    const prompt = promptFor(table, t, labels[table]);
    const key = enrichKeyFor(s.model, prompt);
    const rows = await rowsNeedingEnrichment(table, key, Math.min(budget, 100000));
    if (!rows.length) continue;
    onEvent({ type: "enrich-start", table, pending: rows.length, model: s.model });
    let tokens = 0;
    let done = 0, failed = 0, next = 0, buf = [], calls = 0, badCalls = 0;
    const t0 = Date.now();
    const batches = [];
    for (let i = 0; i < rows.length; i += ENRICH_BATCH) batches.push(rows.slice(i, i + ENRICH_BATCH));
    // One writer at a time: the workers share a buffer, and two writes in
    // flight would race on the temp file and the lock.
    let writing = Promise.resolve();
    const flush = () => { const chunk = buf; buf = []; if (!chunk.length) return writing; writing = writing.then(() => writeEnrichment(table, key, chunk)); return writing; };
    const worker = async () => {
      while (next < batches.length) {
        if (shouldStop()) return;
        const batch = batches[next++];
        calls++;
        try {
          const notes = await enrichBatch(s.model, prompt, batch, 45000);
          tokens += batch.reduce((a, r) => a + tokensOf(r.source_text), 0) + tokensOf(prompt);
          for (const r of batch) {
            const text = notes.get(r.record_id);
            // A record the model left out gets the key with no text, so it
            // is not paid for again every sync; a new prompt redoes it.
            if (text) { buf.push({ record_id: r.record_id, enrich_text: text, enrich_norm: normalizeText(text) }); done++; }
            else { buf.push({ record_id: r.record_id, enrich_text: "", enrich_norm: "" }); failed++; }
          }
        } catch (e) {
          failed += batch.length; badCalls++;
          if (badCalls <= 3) onEvent({ type: "note", name: table, note: `enrichment call failed: ${String(e.message).slice(0, 120)}` });
          if (badCalls >= 5 && badCalls * 2 > calls) {
            next = batches.length;
            onEvent({ type: "note", name: table, note: `enrichment stopped for this table: too many failures` });
            summary.stopped.push(`Search notes stopped on ${labels[table] || table}: too many failed calls.`);
          }
        }
        if (buf.length >= 50) await flush();
        onEvent({ type: "enrich-progress", table, done, failed, total: rows.length, ms: Date.now() - t0, cost: estimateCost(s.model, 1, tokens, done * 120) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    await flush();
    budget -= done + failed; // a failure costs a call too
    const cost = estimateCost(s.model, 1, tokens, done * 120);
    summary.done += done; summary.failed += failed; summary.tokens += tokens; summary.cost += cost;
    summary.tables.push({ table, done, failed, pending: rows.length - done, cost });
    onEvent({ type: "enrich-done", table, done, failed, pending: rows.length - done, ms: Date.now() - t0, cost });
    if (done) appendPass({ kind: "enrich", table, label: labels[table] || table, rows: done, failed, ms: Date.now() - t0, model: s.model, tokens, cost });
  }
  return summary;
}

// The enrichment window's preview: notes for a few sample records of a
// table, written by the model with the given prompt, nothing saved.
export async function enrichPreview({ model, prompt, rows }) {
  const t0 = Date.now();
  const notes = await enrichBatch(model, prompt, rows, 45000);
  return { ms: Date.now() - t0, notes: rows.map((r) => ({ record_id: r.record_id, source_text: r.source_text, notes: notes.get(r.record_id) || "" })) };
}

// --- Embedding ----------------------------------------------------------------------------
// What gets embedded: one plain line per record, the table's name first,
// then the values without their field labels, then the enrichment. A
// sentence embeds better than "Field: value" lines (docs/research-ai-stages.md).
export function embedText(label, sourceText) {
  const lines = String(sourceText || "").split("\n").map((l) => l.replace(/^[^:\n]{1,40}:\s*/, "").trim()).filter(Boolean);
  return `${label ? label + ": " : ""}${lines.join(". ")}`;
}

// Why the embedding pass stopped early, as one plain sentence for the
// screen. The raw error goes into a note; this is what the person reads.
//   quota    the key is fine, the account is out of credit or over its limit
//   auth     the key was refused
//   network  the provider did not answer
//   other    anything else, with the error's first words
export function classifyEmbedError(e, provider) {
  const status = Number(e?.status || 0);
  const msg = String(e?.message || e || "");
  const label = PROVIDERS[provider]?.label || provider || "The provider";
  const project = provider === "google" ? "Enable billing on the Google AI project" : `Add credit to the ${label} account`;
  if (status === 429 || /quota|resource.?exhausted|insufficient_quota|rate.?limit|billing/i.test(msg)) {
    return { reason: "quota", text: `${label} refused this key: quota exceeded. ${project}, then Run again.` };
  }
  if (status === 401 || status === 403 || /invalid.?api.?key|unauthori[sz]ed|permission|api key not valid|authentication/i.test(msg)) {
    return { reason: "auth", text: `${label} refused this key. Check the key on the AI tab, then Run again.` };
  }
  if (/fetch failed|timeout|timed out|abort|ECONN|ENOTFOUND|EAI_AGAIN|network|socket/i.test(msg)) {
    return { reason: "network", text: `${label} did not answer. Check the connection, then Run again.` };
  }
  return { reason: "other", text: `Semantic search stopped: ${msg.replace(/\s+/g, " ").slice(0, 80)}. Run again to continue.` };
}

// `full`: the Run button; a plain sync embeds at most EMBED_CAP_PER_SYNC
// rows (new and changed ones) and leaves the rest for a Run.
// `tables`: the beacon's case, only those tables' rows.
export async function embedStage({ labels = {}, onEvent = () => {}, shouldStop = () => false, full = false, tables = null }) {
  const ready = stageReady("semantic");
  const summary = { ran: false, done: 0, failed: 0, pending: 0, tokens: 0, cost: 0, stopped: null, stoppedReason: null };
  if (!ready.ready) return summary;
  const info = embedInfo();
  const key = vectorKey();
  summary.ran = true;
  const recreated = await ensureVectorTable(info.dims);
  if (recreated) onEvent({ type: "note", note: `vectors set to ${info.dims} numbers; every record is re-embedded` });
  await pruneVectors();
  const total = await countNeedingVectors(key);
  if (!total) return summary;
  const cap = full ? Infinity : EMBED_CAP_PER_SYNC;
  if (total > cap) onEvent({ type: "note", note: `${total.toLocaleString()} records need vectors; this sync does ${cap.toLocaleString()}, press Run on the AI tab for the rest` });
  onEvent({ type: "embed-start", pending: Math.min(total, cap), model: info.model, provider: info.provider });
  const t0 = Date.now();
  let done = 0, tokens = 0;
  for (;;) {
    if (shouldStop() || done >= cap) break;
    const rows = await rowsNeedingVectors(key, Math.min(2000, cap - done), tables);
    if (!rows.length) break;
    try {
      const texts = rows.map((r) => embedText(labels[r.src_table] || r.src_table, r.text));
      const vecs = await embedTexts(texts, { kind: "document", shouldStop, onProgress: () => {} });
      await writeVectors(key, info.dims, rows.map((r, i) => ({ src_table: r.src_table, record_id: r.record_id, vec: vecs[i] })));
      done += rows.length;
      tokens += texts.reduce((a, s) => a + tokensOf(s), 0);
      onEvent({ type: "embed-progress", done, total: Math.min(total, cap), ms: Date.now() - t0, cost: estimateCost(info.model, 1, tokens) });
    } catch (e) {
      if (e && e.cancelled) break;
      summary.failed = total - done;
      const why = classifyEmbedError(e, info.provider);
      summary.stopped = why.text;
      summary.stoppedReason = why.reason;
      onEvent({ type: "note", note: `embedding stopped: ${String(e.message).slice(0, 160)}` });
      onEvent({ type: "embed-stopped", reason: why.reason, provider: info.provider, text: why.text });
      break;
    }
  }
  summary.done = done;
  summary.tokens = tokens;
  summary.cost = estimateCost(info.model, 1, tokens);
  summary.pending = Math.max(0, total - done);
  onEvent({ type: "embed-done", done, pending: summary.pending, ms: Date.now() - t0, cost: summary.cost });
  if (done) appendPass({ kind: "embed", rows: done, pending: summary.pending, ms: Date.now() - t0, model: info.model, dims: info.dims, tokens, cost: summary.cost });
  return summary;
}
