// ai.js - the one door for model calls, and the key bookkeeping behind it.
// Raw fetch, no SDK. No model is named in this file and none is guessed from
// the shape of its name: which provider serves a model, and what the model
// is for, come from explicit configuration or the providers' own live lists
// (the model-list section below). Four providers:
// Anthropic and OpenAI for chat, Google for chat and embeddings, Voyage for
// embeddings. Naming (naming.js) uses the chat door; the optional search
// stages (understand.js, rerank.js, enrich.js) use it with a short timeout;
// embed.js has its own door for vectors.
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

export const keyStatus = () => Object.fromEntries(Object.keys(PROVIDERS).map((p) => {
  const { key, source } = keyForProvider(p, { evenIfDisabled: true });
  const enabled = providerEnabled(p);
  return [p, { configured: Boolean(key) && enabled, hasKey: Boolean(key), enabled, preview: key ? `${key.slice(0, 8)}...${key.slice(-4)}` : null, source }];
}));

// Providers with a key, in a fixed order of preference for defaults.
export const configuredProviders = () => Object.keys(PROVIDERS).filter((p) => keyForProvider(p).key);

// --- The live model list ------------------------------------------------------------
// Which models exist, who serves each and what each is for (chat or
// embedding) come from the providers' own lists, read with the keys and
// cached for a day in data/models.json. A hardcoded list goes stale, and a
// guess from a name breaks on the next family (Pythia, 2026-09-29).
const MODELS_PATH = path.join(DATA_DIR, "models.json");
const LIST_VERSION = 2;
let listMemo = { mtime: -1, list: null };
export function modelListCache() {
  try {
    const mtime = fs.statSync(MODELS_PATH).mtimeMs;
    if (mtime !== listMemo.mtime) listMemo = { mtime, list: JSON.parse(fs.readFileSync(MODELS_PATH, "utf8")) };
  } catch { listMemo = { mtime: -1, list: null }; }
  // A cache from an older build carries no kinds: read it as no list.
  return listMemo.list?.v === LIST_VERSION ? listMemo.list : null;
}
export const liveModels = () => modelListCache()?.models || [];

// OpenAI's list is ids only, no capability data. The one reading done on it
// is for capability words the ids spell out, never a model or family name:
// "embedding" goes to the semantic picker, a model that makes sound or
// pictures is left out, the rest is offered for chat. Other... takes any id.
const OPENAI_EMBEDDING = /embedding/i;
const OPENAI_NOT_TEXT = /audio|image|realtime|transcribe|tts|moderation/i;

// Every enabled provider's list, fetched now. A provider that fails keeps
// its models from the last good list; the errors ride along for the page.
export async function refreshModelList() {
  const out = [], errors = [], failed = new Set();
  const get = async (provider, url, headers) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  };
  const tryProvider = async (provider, fn) => {
    const { key } = keyForProvider(provider);
    if (!key) return;
    try { await fn(key); } catch (e) { failed.add(provider); errors.push(`${PROVIDERS[provider].label}: ${e.message}`); }
  };
  await tryProvider("anthropic", async (key) => {
    // Anthropic serves chat models only.
    for (const m of (await get("anthropic", "https://api.anthropic.com/v1/models?limit=1000", { "x-api-key": key, "anthropic-version": "2023-06-01" })).data || []) {
      out.push({ id: m.id, name: m.display_name || m.id, provider: "anthropic", kind: "chat", created: Date.parse(m.created_at || "") || 0 });
    }
  });
  await tryProvider("openai", async (key) => {
    for (const m of (await get("openai", "https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` })).data || []) {
      const kind = OPENAI_EMBEDDING.test(m.id) ? "embedding" : OPENAI_NOT_TEXT.test(m.id) ? "" : "chat";
      if (kind) out.push({ id: m.id, name: m.id, provider: "openai", kind, created: Number(m.created || 0) * 1000 });
    }
  });
  await tryProvider("google", async (key) => {
    // Google says what each model does: generateContent is chat, an
    // embed method is embeddings. Anything else (images, video) is skipped.
    for (const m of (await get("google", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { "x-goog-api-key": key })).models || []) {
      const how = m.supportedGenerationMethods || [];
      const kind = how.includes("generateContent") ? "chat" : how.some((x) => /embed/i.test(x)) ? "embedding" : "";
      const id = String(m.name || "").replace(/^models\//, "");
      if (kind && id) out.push({ id, name: m.displayName || id, provider: "google", kind, created: 0 });
    }
  });
  // Voyage publishes no model list: a Voyage model is typed with Other...
  // and resolved by providerOf below.
  const order = Object.keys(PROVIDERS);
  const kept = liveModels().filter((m) => failed.has(m.provider));
  // Per provider, newest first where the provider says when; otherwise the
  // provider's own order.
  const models = [...out, ...kept]
    .map((m, i) => ({ ...m, i }))
    .sort((a, b) => (order.indexOf(a.provider) - order.indexOf(b.provider)) || ((b.created || 0) - (a.created || 0)) || (a.i - b.i))
    .map(({ i, ...m }) => m);
  const payload = { v: LIST_VERSION, at: new Date().toISOString(), models, source: out.length ? "live" : "none", ...(errors.length ? { errors } : {}) };
  if (out.length) {
    try { fs.writeFileSync(MODELS_PATH, JSON.stringify(payload, null, 2)); } catch {}
    listMemo = { mtime: -1, list: null };
  }
  return payload;
}
// Fetch the list once when there is none yet (a fresh box, or a cache from
// an older build). Cheap to call before anything that needs a model.
export async function ensureModelList() {
  if (!modelListCache() && configuredProviders().length) await refreshModelList();
}

// An id may name its provider outright, "voyage:<model id>": explicit
// configuration beats every lookup. Needed for a provider that publishes no
// list (Voyage) or an id two providers both list.
function splitModel(model) {
  const s = String(model || "").trim();
  const i = s.indexOf(":");
  const p = i > 0 ? s.slice(0, i).toLowerCase() : "";
  return PROVIDERS[p] ? { provider: p, id: s.slice(i + 1).trim() } : { provider: "", id: s };
}
// The id the provider's API wants: without any "provider:" in front.
export const modelId = (model) => splitModel(model).id;

// Which provider serves a model: the one the configuration names, else the
// one whose live list has it, else the only provider with a key that can do
// this kind of work ("chat" or "embedding"). Otherwise "" : the caller says
// a model or provider must be chosen. Never read from the name.
export function providerOf(model, kind = "") {
  const { provider, id } = splitModel(model);
  if (provider) return provider;
  if (!id) return "";
  const listed = liveModels().filter((m) => m.id === id);
  const hit = listed.find((m) => keyForProvider(m.provider).key) || listed[0];
  if (hit) return hit.provider;
  const can = configuredProviders().filter((p) => !kind || (kind === "embedding" ? PROVIDERS[p].embed : PROVIDERS[p].chat));
  return can.length === 1 ? can[0] : "";
}
// "chat", "embedding", or "" when the model is on no list.
export function modelKind(model) {
  const { provider, id } = splitModel(model);
  if (provider && !PROVIDERS[provider].chat) return "embedding";
  if (provider && !PROVIDERS[provider].embed) return "chat";
  const listed = liveModels().filter((m) => m.id === id && (!provider || m.provider === provider));
  return listed[0]?.kind || "";
}
export const isEmbeddingModel = (m) => modelKind(m) === "embedding";

// With nothing configured: the first model of that kind on the live list
// from a provider with a key (newest first, where the provider dates them).
// The pick is shown wherever the choice is made ("default (id)"), never
// hidden. "" when there is no list: then a model must be chosen.
export function autoModel(kind = "chat", except = "") {
  const m = liveModels().find((x) => x.kind === kind && x.id !== modelId(except) && keyForProvider(x.provider).key);
  return m ? m.id : "";
}

// --- Models per role ---------------------------------------------------------------
// Naming: config.ai.namingModel, else NAMING_MODEL from the environment,
// else the live list's pick.
const chosenNamingModel = () => cfg().namingModel || process.env.NAMING_MODEL || "";
export const namingModel = () => chosenNamingModel() || autoModel("chat");

// Cosine floors differ by provider: OpenAI scores run low, Google and
// Voyage run high. Used when the semantic stage has no floor set.
const SEMANTIC_FLOOR = { openai: 0.40, google: 0.65, voyage: 0.60 };

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
const stageKind = (name) => (name === "semantic" ? "embedding" : "chat");

// Prices per million tokens, for the estimate a person sees before a paid
// pass. No price list lives in the code (it names models and goes stale):
// config.ai.prices may hold { "<model id>": { in, out } }. Without one the
// estimate uses a typical price for the kind of work.
const TYPICAL_PRICE = { embedding: { in: 0.13 }, chat: { in: 1.0, out: 4.0 } };
export function priceFor(model, kind = "") {
  const prices = cfg().prices || {};
  const p = prices[model] || prices[modelId(model)];
  if (p && Number.isFinite(Number(p.in))) return { in: Number(p.in), out: Number(p.out) || 0 };
  return TYPICAL_PRICE[modelKind(model) || kind || "chat"];
}
// Dollars for a pass: rows, average input tokens per row, output tokens
// per row (0 for embeddings).
export function estimateCost(model, rows, tokensIn, tokensOut = 0) {
  const p = priceFor(model, tokensOut ? "chat" : "embedding");
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
    // A blank model means "the live list's pick for the keys I have":
    // resolved at read time, so adding a key later fills it in without a
    // click. `auto` says the model was picked, not chosen.
    if ("model" in def && !s.model) { s.model = autoModel(stageKind(name)); s.auto = Boolean(s.model); }
    if (name === "semantic" && !(Number(s.minSim) > 0)) s.minSim = SEMANTIC_FLOOR[providerOf(s.model, "embedding")] ?? 0.4;
    out[name] = s;
  }
  return out;
}
// A stage runs when it is on AND its model has a provider with a key
// (fuzzy has none).
export function stageReady(name) {
  const s = stages()[name];
  if (!s || !s.on) return { ready: false, why: "off" };
  if (name === "fuzzy") return { ready: true };
  if (!s.model) return { ready: false, why: "no model: choose one (or add an API key)" };
  const provider = providerOf(s.model, stageKind(name));
  if (!provider) return { ready: false, why: `no provider for ${s.model}: pick it from the list, or write it as provider:model-id` };
  if (!keyForProvider(provider).key) return { ready: false, why: `no ${PROVIDERS[provider]?.label || ""} key` };
  return { ready: true };
}

export const enrichModel = () => stages().enrich.model;
export const embedModel = () => stages().semantic.model;
export const roleModels = () => ({ naming: namingModel(), enrich: enrichModel(), embed: embedModel() });

export const namingInfo = () => {
  const chosen = chosenNamingModel();
  const model = chosen || autoModel("chat");
  const provider = providerOf(model, "chat");
  // No model resolved yet (no list fetched): a key for any chat provider
  // still counts as configured; the list is read before the first call.
  const { key, source } = provider ? keyForProvider(provider) : keyForProvider(configuredProviders().find((p) => PROVIDERS[p].chat) || "");
  return {
    model, provider: provider || null, auto: !chosen && Boolean(model),
    configured: Boolean(key),
    keyPreview: key ? `${key.slice(0, 8)}...${key.slice(-4)}` : null,
    keySource: key ? source : null,
  };
};

// --- The chat door --------------------------------------------------------------------
// One call, one answer, one time budget. `json: true` asks the provider for
// a JSON object where it can (OpenAI, Google) and tells the model in words
// everywhere; parseJson() below tolerates a fenced or chatty reply.
//
// Request knobs are never gated by the model's name. A knob is sent until a
// model rejects it as unsupported; then the call is retried without it and
// that model id is remembered, so the knob is not sent to it again while
// this process runs.
const refused = new Map(); // "provider:model" -> Set of knob names
const refusedBy = (provider, model) => refused.get(`${provider}:${model}`) || new Set();
function remember(provider, model, knob) {
  const k = `${provider}:${model}`;
  if (!refused.has(k)) refused.set(k, new Set());
  refused.get(k).add(knob);
}
// The knob a 400 names, among those still being sent; null when none.
const knobIn = (status, text, knobs, sent) => (status === 400 ? knobs.find(([k, re]) => sent.includes(k) && re.test(text))?.[0] || null : null);

async function anthropicChat(model, key, { system, user, maxTokens, timeoutMs }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.content || []).map((c) => c.text || "").join("");
}

// OpenAI's chat/completions shape. No temperature is sent (many models
// reject one). reasoning_effort "low": a model that reasons before answering
// does least of it, the fast setting for a search stage. max_completion_tokens
// is the current limit field; a model that refuses it gets max_tokens.
const OPENAI_KNOBS = [
  ["reasoning_effort", /reasoning_effort|reasoning\.effort/i],
  ["max_completion_tokens", /max_completion_tokens/i],
  ["response_format", /response_format/i],
];
async function openaiChat(model, key, { system, user, maxTokens, timeoutMs, json }) {
  for (;;) {
    const no = refusedBy("openai", model);
    const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    body[no.has("max_completion_tokens") ? "max_tokens" : "max_completion_tokens"] = maxTokens;
    if (!no.has("reasoning_effort")) body.reasoning_effort = "low";
    if (json && !no.has("response_format")) body.response_format = { type: "json_object" };
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const out = await res.json();
      return out.choices?.[0]?.message?.content || "";
    }
    const text = await res.text();
    const knob = knobIn(res.status, text, OPENAI_KNOBS, Object.keys(body));
    if (!knob) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
    remember("openai", model, knob);
  }
}

// Thinking off and temperature 0: a search stage wants the first answer,
// not a considered one. A model that cannot turn thinking off (or refuses
// another knob) says so in a 400 and is asked again without it.
const GOOGLE_KNOBS = [
  ["thinkingConfig", /thinking/i],
  ["temperature", /temperature/i],
  ["responseMimeType", /response_?mime_?type/i],
];
async function googleChat(model, key, { system, user, maxTokens, timeoutMs, json }) {
  for (;;) {
    const no = refusedBy("google", model);
    const gen = { maxOutputTokens: maxTokens };
    if (!no.has("temperature")) gen.temperature = 0;
    if (!no.has("thinkingConfig")) gen.thinkingConfig = { thinkingBudget: 0 };
    if (json && !no.has("responseMimeType")) gen.responseMimeType = "application/json";
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: gen,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const out = await res.json();
      return (out.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    }
    const text = await res.text();
    const knob = knobIn(res.status, text, GOOGLE_KNOBS, Object.keys(gen));
    if (!knob) throw new Error(`Google ${res.status}: ${text.slice(0, 200)}`);
    remember("google", model, knob);
  }
}

export async function chat({ model, system, user, maxTokens = 8000, timeoutMs = 120000, json = false }) {
  if (!model) throw new Error("No model chosen. Choose one in Settings, AI tab.");
  let provider = providerOf(model, "chat");
  // Not on the cached list: read the lists again once, then decide.
  if (!provider) { await refreshModelList().catch(() => {}); provider = providerOf(model, "chat"); }
  if (!provider) throw new Error(`Mitos cannot tell which provider serves "${model}". Pick it from the list in Settings, AI tab, or write it as provider:model-id.`);
  if (!PROVIDERS[provider].chat) throw new Error(`${PROVIDERS[provider].label} has no chat models.`);
  const { key } = keyForProvider(provider);
  if (!key) throw new Error(`No API key for ${model}. Set the ${PROVIDERS[provider].label} key in Settings, AI tab.`);
  const id = modelId(model);
  const args = { system, user, maxTokens, timeoutMs, json };
  if (provider === "openai") return openaiChat(id, key, args);
  if (provider === "google") return googleChat(id, key, args);
  return anthropicChat(id, key, args);
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

// The schema naming pass calls this. With no model chosen, the live list is
// read first so its pick can answer.
export async function askModel(system, user, maxTokens = 8000) {
  if (!namingModel()) await ensureModelList().catch(() => {});
  return chat({ model: namingModel(), system, user, maxTokens });
}
