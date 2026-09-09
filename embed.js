// embed.js - text in, vectors out. Three providers behind one function, raw
// fetch, batched, retried, and every vector cut to the configured size and
// normalized to unit length, so cosine similarity is a dot product and a
// vector from any provider compares the same way in DuckDB.
//
// Two kinds of text: a "document" (an index row) and a "query" (what a person
// typed). Gemini and Voyage embed the two differently on purpose and want to
// be told which is which; OpenAI does not care.

import "./env.js";
import { keyForProvider, providerOf, stages } from "./ai.js";

// Batch sizes under each provider's request limit, with room to spare.
const BATCH = { openai: 200, google: 100, voyage: 128 };
// Short records; a long note is cut so no provider's token limit is hit.
const MAX_CHARS = 2000;

export function embedInfo() {
  const s = stages().semantic;
  const provider = s.model ? providerOf(s.model) : null;
  return { provider, model: s.model || "", dims: Number(s.dims) || 256, configured: Boolean(provider && keyForProvider(provider).key) };
}

// The vector key marks what produced a vector: provider, model and size. A
// row whose stored key differs is re-embedded on the next sync.
export const vectorKey = () => { const i = embedInfo(); return i.model ? `${i.provider}/${i.model}/${i.dims}` : ""; };

function normalize(v, dims) {
  const out = v.slice(0, dims);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] = out[i] / n;
  while (out.length < dims) out.push(0);
  return out;
}

async function post(url, headers, body, timeoutMs) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function embedBatch(texts, { provider, model, dims, kind, timeoutMs }) {
  const { key } = keyForProvider(provider);
  if (!key) throw new Error(`No ${provider} key for embeddings.`);
  if (provider === "openai") {
    const out = await post("https://api.openai.com/v1/embeddings", { Authorization: `Bearer ${key}` },
      { model, input: texts, dimensions: dims }, timeoutMs);
    return out.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  if (provider === "google") {
    const taskType = kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const out = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`, { "x-goog-api-key": key },
      { requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType, outputDimensionality: dims })) }, timeoutMs);
    return (out.embeddings || []).map((e) => e.values);
  }
  if (provider === "voyage") {
    const out = await post("https://api.voyageai.com/v1/embeddings", { Authorization: `Bearer ${key}` },
      { model, input: texts, input_type: kind === "query" ? "query" : "document", output_dimension: dims }, timeoutMs);
    return out.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  throw new Error(`No embedding provider for ${model}.`);
}

// Retry the transient failures (rate limit, server error, timeout) with a
// growing pause; give up on anything else at once.
async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const transient = e.status === 429 || e.status >= 500 || /timeout|abort|fetch failed|ECONNRESET/i.test(String(e.message));
      if (!transient || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, i)));
    }
  }
  throw last;
}

// texts: string[]. Returns number[][] in the same order, one unit vector per
// text, `dims` long. onProgress(doneCount) after each batch.
export async function embedTexts(texts, { kind = "document", concurrency = 3, onProgress, shouldStop = () => false, timeoutMs = 60000, tries = 4 } = {}) {
  const info = embedInfo();
  if (!info.configured) throw new Error("Semantic search has no embedding model with a key.");
  const { provider, model, dims } = info;
  const clean = texts.map((t) => String(t ?? "").slice(0, MAX_CHARS) || " ");
  const out = new Array(clean.length);
  const size = BATCH[provider] || 100;
  const batches = [];
  for (let i = 0; i < clean.length; i += size) batches.push([i, clean.slice(i, i + size)]);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < batches.length) {
      if (shouldStop()) { const e = new Error("cancelled during embedding"); e.cancelled = true; throw e; }
      const [start, batch] = batches[next++];
      const vecs = await withRetry(() => embedBatch(batch, { provider, model, dims, kind, timeoutMs }), tries);
      if (vecs.length !== batch.length) throw new Error(`${provider} returned ${vecs.length} vectors for ${batch.length} texts`);
      for (let j = 0; j < vecs.length; j++) out[start + j] = normalize(vecs[j], dims);
      done += batch.length;
      if (onProgress) onProgress(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return out;
}

// The query side: one text, cached by provider, model, size and text, so a
// retyped or repeated search never pays the round trip twice.
const queryCache = new Map();
const QUERY_CACHE_MAX = 500;
export async function embedQuery(text, opts = {}) {
  const k = `${vectorKey()}|${String(text).trim().toLowerCase()}`;
  if (queryCache.has(k)) { const v = queryCache.get(k); queryCache.delete(k); queryCache.set(k, v); return v; }
  // A query embedding is on the search path: one try, five seconds, and the
  // search goes on without vectors (a 30 second stall, demo 2026-09-09, was
  // the document-side retry ladder running on a query).
  const [v] = await embedTexts([text], { kind: "query", timeoutMs: 5000, tries: 1, ...opts });
  queryCache.set(k, v);
  if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
  return v;
}
