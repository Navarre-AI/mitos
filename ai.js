// ai.js - the one door for model calls, and the key bookkeeping behind it.
// Raw fetch, no SDK, provider decided by the model name. Four providers:
// Anthropic and OpenAI for chat, Google for chat and embeddings, Voyage for
// embeddings. Naming (naming.js) uses the chat door; the optional search
// stages (understand.js, rerank.js, enrich.js) use it with a fast model and
// a short timeout; embed.js has its own door for vectors.
//
// The stages are OFF by default and independent of each other. Each one is
// a block under config.ai.stages with its own switch, model and limits, so a
// person can turn one off when it misbehaves and test them one at a time.

import "./env.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));

export const DEFAULT_NAMING_MODEL = process.env.NAMING_MODEL || "claude-sonnet-5";

function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8")).ai || {}; }
  catch { return {}; }
}

// --- Providers and keys ---------------------------------------------------------
export const PROVIDERS = {
  anthropic: { label: "Claude", cfgKey: "anthropicKey", env: "ANTHROPIC_API_KEY", chat: true, embed: false },
  openai: { label: "OpenAI", cfgKey: "openaiKey", env: "OPENAI_API_KEY", chat: true, embed: true },
  google: { label: "Google", cfgKey: "googleKey", env: "GOOGLE_API_KEY", chat: true, embed: true },
  voyage: { label: "Voyage", cfgKey: "voyageKey", env: "VOYAGE_API_KEY", chat: false, embed: true },
};

export function providerOf(model) {
  const m = String(model || "").toLowerCase();
  if (/^gemini/.test(m)) return "google";
  if (/^voyage/.test(m)) return "voyage";
  if (/^(gpt-|o[0-9]|text-embedding)/.test(m)) return "openai";
  return "anthropic";
}
export const isOpenAIModel = (m) => providerOf(m) === "openai";
export const isEmbeddingModel = (m) => /embed/i.test(String(m || ""));

// The key a provider has, switch or no switch: in-app first, then env.
function rawKeyFor(provider) {
  const p = PROVIDERS[provider];
  if (!p) return "";
  return cfg()[p.cfgKey] || process.env[p.env] || "";
}

// A provider can be switched off without losing its key: its models drop
// out of every list and nothing calls it. Saved under config.ai.providers.
// With no saved switch, a provider is on when it has a key and off when it
// has none: the AI tab renders the switches from this alone.
export function providerEnabled(provider) {
  const saved = cfg().providers?.[provider]?.enabled;
  if (saved !== undefined && saved !== null) return Boolean(saved);
  return Boolean(rawKeyFor(provider));
}

// Which key a provider uses, and where it came from. In-app beats env so a
// deployed instance can be configured entirely in the browser. A provider
// switched off reads as having no key.
export function keyForProvider(provider, { evenIfDisabled = false } = {}) {
  const p = PROVIDERS[provider];
  if (!p) return { key: "", source: null };
  if (!evenIfDisabled && !providerEnabled(provider)) return { key: "", source: null, disabled: true };
  const c = cfg();
  const inApp = c[p.cfgKey] || "";
  const key = inApp || process.env[p.env] || "";
  return { key, source: key ? (inApp ? "in-app" : "env") : null };
}
const keyFor = (model) => keyForProvider(providerOf(model));

export const keyStatus = () => Object.fromEntries(Object.keys(PROVIDERS).map((p) => {
  const { key, source } = keyForProvider(p, { evenIfDisabled: true });
  const enabled = providerEnabled(p);
  return [p, { configured: Boolean(key) && enabled, hasKey: Boolean(key), enabled, preview: key ? `${key.slice(0, 8)}...${key.slice(-4)}` : null, source }];
}));

// Providers with a key, in a fixed order of preference for defaults.
export const configuredProviders = () => Object.keys(PROVIDERS).filter((p) => keyForProvider(p).key);

// --- Models per role ---------------------------------------------------------------
export const namingModel = () => cfg().namingModel || DEFAULT_NAMING_MODEL;

// The fast model for the search stages: the cheapest current model of the
// first provider that has a key. Quality matters less than the round trip
// here; every stage has a time budget and falls back to the deterministic
// answer when the model is late.
// Order of preference: Haiku answers a 500-token prompt in well under a
// second; the newest small OpenAI and Google models think first unless told
// not to (docs/research-ai-stages.md, 2026-09-08).
const FAST_CHAT = { anthropic: "claude-haiku-4-5", openai: "gpt-5.6-luna", google: "gemini-2.5-flash-lite" };
export function fastModel() {
  for (const p of ["anthropic", "openai", "google"]) if (keyForProvider(p).key) return FAST_CHAT[p];
  return "";
}
// Cosine floors differ by family: text-embedding-3 scores run low, Gemini
// and Voyage run high. Used when the semantic stage has no floor set.
const SEMANTIC_FLOOR = { openai: 0.40, google: 0.65, voyage: 0.60 };
// The embedding model per provider, in preference order: quality first.
const EMBED_DEFAULT = { google: "gemini-embedding-001", voyage: "voyage-4-lite", openai: "text-embedding-3-large" };
export function defaultEmbedModel() {
  for (const p of ["google", "voyage", "openai"]) if (keyForProvider(p).key) return EMBED_DEFAULT[p];
  return "";
}

// --- The stages -------------------------------------------------------------------
// Every stage: `on`, and what it needs. Saved under config.ai.stages; these
// are the defaults a fresh install runs with. Fuzzy needs no model and no
// key, so it is the one stage on from the start.
export const STAGE_DEFAULTS = {
  // 0.90: Jaro-Winkler is generous to a shared prefix ("marvin cook" scores
  // 0.88 against "macon iro"); a real typo scores 0.95 and up.
  fuzzy: { on: true, minSim: 0.9 },
  // 256 dims: half the file and the scan of 512 for a point or two of
  // recall on short records; the demo box could not hold 512 (2026-09-09).
  // minSim no longer hides rows: semantic search always shows its top rows.
  // It decides the heading only: above it "Semantic matches", below it
  // "Perhaps you meant" (Matt, 2026-09-09).
  semantic: { on: false, model: "", dims: 256, minSim: null },
  // prompt: the one overall rules text (v1); a table's own prompt, when
  // set, wins for that table. maxRowsPerSync is the quiet cap on a plain
  // sync; a full pass comes only from the Run button (the paid-pass gate).
  enrich: { on: false, model: "", prompt: "", maxRowsPerSync: 1000, concurrency: 4 },
  understand: { on: false, model: "", timeoutMs: 3500 },
  rerank: { on: false, model: "", timeoutMs: 4000, candidates: 15, oneThreshold: 0.85 },
};
// A plain sync embeds at most this many new or changed rows; more waits for
// a Run from the paid-pass gate.
export const EMBED_CAP_PER_SYNC = 5000;

// Prices per million tokens, for the estimate a person sees before a paid
// pass (docs/research-ai-stages.md, 2026-09-08). Unknown model: the
// family's typical price.
const PRICES = {
  "text-embedding-3-large": { in: 0.13 }, "text-embedding-3-small": { in: 0.02 },
  "gemini-embedding-001": { in: 0.15 }, "gemini-embedding-2": { in: 0.20 },
  "voyage-4-lite": { in: 0.02 }, "voyage-4": { in: 0.06 }, "voyage-4-large": { in: 0.12 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0 }, "gpt-5.6-luna": { in: 0.2, out: 1.2 }, "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
};
export function priceFor(model) {
  const m = String(model || "").toLowerCase();
  if (PRICES[m]) return PRICES[m];
  if (/embed/.test(m)) return { in: 0.13 };
  if (/haiku/.test(m)) return { in: 1.0, out: 5.0 };
  if (/sonnet/.test(m)) return { in: 3.0, out: 15.0 };
  if (/opus|fable/.test(m)) return { in: 15.0, out: 75.0 };
  return { in: 1.0, out: 4.0 };
}
// Dollars for a pass: rows, average input tokens per row, output tokens
// per row (0 for embeddings).
export function estimateCost(model, rows, tokensIn, tokensOut = 0) {
  const p = priceFor(model);
  return Math.round(((rows * tokensIn * p.in) + (rows * tokensOut * (p.out || 0))) / 1e6 * 100) / 100;
}
export const STAGE_NAMES = Object.keys(STAGE_DEFAULTS);
// What a saved number may be: [min, max]. The page offers the same ranges;
// the server holds the line.
export const STAGE_LIMITS = {
  fuzzy: { minSim: [0.5, 0.99] },
  semantic: { dims: [64, 3072], minSim: [0.05, 0.99] },
  enrich: { maxRowsPerSync: [0, 1000000], concurrency: [1, 16] },
  understand: { timeoutMs: [500, 15000] },
  rerank: { timeoutMs: [500, 15000], candidates: [2, 30], oneThreshold: [0.5, 1] },
};

export function stages() {
  const saved = cfg().stages || {};
  const out = {};
  for (const [name, def] of Object.entries(STAGE_DEFAULTS)) {
    const s = { ...def, ...(saved[name] && typeof saved[name] === "object" ? saved[name] : {}) };
    // A blank model means "the default for the keys I have": resolved at
    // read time, so adding a key later fills it in without a click.
    if ("model" in def && !s.model) s.model = name === "semantic" ? defaultEmbedModel() : fastModel();
    if (name === "semantic" && !(Number(s.minSim) > 0)) s.minSim = SEMANTIC_FLOOR[providerOf(s.model)] ?? 0.4;
    out[name] = s;
  }
  return out;
}
// A stage runs when it is on AND its provider has a key (fuzzy has none).
export function stageReady(name) {
  const s = stages()[name];
  if (!s || !s.on) return { ready: false, why: "off" };
  if (name === "fuzzy") return { ready: true };
  if (!s.model) return { ready: false, why: "no model: add an API key" };
  if (!keyFor(s.model).key) return { ready: false, why: `no ${PROVIDERS[providerOf(s.model)]?.label || ""} key` };
  return { ready: true };
}

export const enrichModel = () => stages().enrich.model;
export const embedModel = () => stages().semantic.model;
export const roleModels = () => ({ naming: namingModel(), enrich: enrichModel(), embed: embedModel() });

export const namingInfo = () => {
  const model = namingModel();
  const { key, source } = keyFor(model);
  return {
    model, provider: providerOf(model),
    configured: Boolean(key),
    keyPreview: key ? `${key.slice(0, 8)}...${key.slice(-4)}` : null,
    keySource: key ? source : null,
  };
};

// --- The chat door --------------------------------------------------------------------
// One call, one answer, one time budget. `json: true` asks the provider for
// a JSON object where it can (OpenAI, Google) and tells the model in words
// everywhere; parseJson() below tolerates a fenced or chatty reply.
async function anthropicChat(model, { system, user, maxTokens, timeoutMs }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": keyFor(model).key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.content || []).map((c) => c.text || "").join("");
}

// OpenAI's chat/completions shape. Newer models take max_completion_tokens
// and reject a temperature, so none is sent.
async function openaiChat(model, { system, user, maxTokens, timeoutMs, json }, fast = true) {
  // The GPT-5 family reasons before answering; for a search stage the
  // lowest setting is the fast one. A model that rejects the field gets
  // one retry without it.
  const reasoning = fast && /^gpt-5/i.test(model) ? { reasoning_effort: "low" } : {};
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${keyFor(model).key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      ...reasoning,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && fast && /reasoning_effort/i.test(text)) return openaiChat(model, { system, user, maxTokens, timeoutMs, json }, false);
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
  }
  const out = await res.json();
  return out.choices?.[0]?.message?.content || "";
}

async function googleChat(model, { system, user, maxTokens, timeoutMs, json }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": keyFor(model).key, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      // Thinking off: a search stage wants the first answer, not a considered one.
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0, thinkingConfig: { thinkingBudget: 0 }, ...(json ? { responseMimeType: "application/json" } : {}) },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  return (out.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

export async function chat({ model, system, user, maxTokens = 8000, timeoutMs = 120000, json = false }) {
  if (!model) throw new Error("No model configured.");
  const provider = providerOf(model);
  if (!keyFor(model).key) throw new Error(`No API key for ${model}. Set the ${PROVIDERS[provider].label} key in Settings, AI tab.`);
  const args = { system, user, maxTokens, timeoutMs, json };
  if (provider === "openai") return openaiChat(model, args);
  if (provider === "google") return googleChat(model, args);
  if (provider === "voyage") throw new Error("Voyage has no chat models.");
  return anthropicChat(model, args);
}

// A JSON object out of a model reply that may carry fences or a sentence.
export function parseJson(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch {}
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

// The schema naming pass calls this.
export async function askModel(system, user, maxTokens = 8000) {
  return chat({ model: namingModel(), system, user, maxTokens });
}
