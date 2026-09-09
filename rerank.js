// rerank.js - the decision stage. A fast model reads the query and the short
// list the other stages produced, reorders it, and says whether ONE record
// is clearly the answer, with a confidence. Fellegi-Sunter's rule in a
// prompt: above the threshold the one record is shown first as the best
// match; below it the list stands as the answer.
//
// The model sees only what the person sees (titles and display values),
// answers with ids from the list, and anything it makes up is dropped.

import crypto from "crypto";
import { chat, parseJson, stages, stageReady } from "./ai.js";

const SYSTEM = `You are ranking search results from a business database for a person who typed a short search. Answer with ONE JSON object and nothing else.

You get the search, what it was read as, and a numbered list of candidate records (table, title, other fields, and why the engine matched each one).

Return: {"order": [numbers, best first], "best": number or null, "confidence": 0.0 to 1.0, "why": "at most 12 words"}

Rules:
- "order" lists EVERY candidate number exactly once, best first. Prefer the record that IS the thing typed (a name that matches the title) over a record that merely mentions it. A person, company or product named in the search outranks a record that contains those words in a note.
- "best" is the one record the person is looking for, only when the search names one specific thing and one candidate clearly is it. When the search asks for a set (a range, a category, "people with..."), or two candidates fit equally, "best" is null.
- "confidence" is your probability that "best" is right. Be honest: two similar names means low confidence.
- Never invent a number that is not in the list.`;

const cache = new Map();
const CACHE_MAX = 500;
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// candidates: [{ table, id, label, display, why, via }], in the engine's order.
// Returns { order: [index...], best: index|null, confidence, why, cached, ms }
// or { error }. Never throws.
export async function rerank(query, reading, candidates) {
  const t0 = Date.now();
  const s = stages().rerank;
  const ready = stageReady("rerank");
  if (!ready.ready) return { error: ready.why, ms: 0 };
  const n = Math.max(2, Math.min(30, Number(s.candidates) || 15));
  const list = candidates.slice(0, n);
  if (list.length < 2) return { error: "fewer than two candidates", ms: 0 };
  const key = md5(`${s.model}|${String(query).trim().toLowerCase()}|${list.map((c) => `${c.table}:${c.id}`).join(",")}`);
  if (cache.has(key)) return { ...cache.get(key), cached: true, ms: Date.now() - t0 };
  const lines = list.map((c, i) => {
    const vals = Object.entries(c.display || {});
    const title = String(vals[0]?.[1] ?? c.id);
    const rest = vals.slice(1).map(([k, v]) => `${k}: ${v}`).filter((x) => !/: $/.test(x)).join("; ").slice(0, 240);
    return `${i + 1}. [${c.label || c.table}] ${title}${rest ? ` | ${rest}` : ""} | matched: ${(c.why || []).join("; ") || c.via || "?"}`;
  });
  const user = `Search: ${query}\nRead as: ${reading || "words"}\n\nCandidates:\n${lines.join("\n")}`;
  try {
    const raw = await chat({ model: s.model, system: SYSTEM, user, maxTokens: 200, timeoutMs: Number(s.timeoutMs) || 3000, json: true });
    const j = parseJson(raw);
    if (!j || !Array.isArray(j.order)) return { error: "no JSON in the answer", ms: Date.now() - t0 };
    const seen = new Set();
    const order = [];
    for (const v of j.order) { const i = Number(v) - 1; if (Number.isInteger(i) && i >= 0 && i < list.length && !seen.has(i)) { seen.add(i); order.push(i); } }
    for (let i = 0; i < list.length; i++) if (!seen.has(i)) order.push(i); // anything the model forgot keeps its place at the end
    const bi = Number(j.best) - 1;
    const best = Number.isInteger(bi) && bi >= 0 && bi < list.length ? bi : null;
    const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
    const out = { order, best, confidence, why: typeof j.why === "string" ? j.why.trim().slice(0, 120) : "" };
    cache.set(key, out);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { ...out, cached: false, ms: Date.now() - t0 };
  } catch (e) {
    const timed = /timeout|abort/i.test(String(e.message));
    return { error: timed ? `no answer in ${s.timeoutMs} ms` : String(e.message).slice(0, 160), ms: Date.now() - t0 };
  }
}
