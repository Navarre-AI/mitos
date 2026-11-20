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

// --- The public model list (navarre.ai/ai-models.json) -------------------------------
// One list for all of Matt's apps: a daily job on navarre.ai keeps it current.
// Each model has a job (reasoning, workhorse, cheap, embedding, rerank), a
// price per million tokens, and a `recommended` flag. This list decides what
// the menus show and what each stage defaults to; the providers' own live
// lists (above) only say which ids a key can reach and cover a model the
// public list does not name. Same loader as Pythia's: a copy on the volume,
// refreshed at most every 12 hours, never waited on when a copy exists,
// backed off after a failure. MITOS_MODEL_LIST_URL picks the file (a path or
// file: URL works too); an empty value turns it off.
const curatedUrl = () => process.env.MITOS_MODEL_LIST_URL ?? "https://navarre.ai/ai-models.json";
const CURATED_PATH = path.join(DATA_DIR, "ai-models.json");
const CURATED_EVERY_MS = 12 * 3600000;
let curated = null; // { list, fetchedAt }
let curatedFailAt = 0, curatedFails = 0, curatedBusy = null, curatedError = "";
// The last refresh's failure, "" when it worked (the Refresh button says so).
export const curatedStatus = () => ({ error: curatedError });
export function loadCurated() {
  if (!curatedUrl()) return null;
  if (!curated) { try { curated = JSON.parse(fs.readFileSync(CURATED_PATH, "utf8")); } catch { /* none yet */ } }
  return curated;
}
export function refreshCurated(force = false) {
  const url = curatedUrl();
  if (!url) return Promise.resolve(null);
  if (curatedBusy) return curatedBusy;
  const have = loadCurated();
  if (!force) {
    if (have && Date.now() - (Date.parse(have.fetchedAt || "") || 0) < CURATED_EVERY_MS) return Promise.resolve(have);
    // Failed recently: wait before the next try (20 s, then 5 minutes after three).
    if (Date.now() - curatedFailAt < (curatedFails > 3 ? 300000 : 20000)) return Promise.resolve(have);
  }
  curatedBusy = (async () => {
    try {
      let list;
      if (/^file:/i.test(url) || url.startsWith("/")) list = JSON.parse(fs.readFileSync(url.replace(/^file:\/\//i, ""), "utf8"));
      else {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`answered ${r.status}`);
        list = await r.json();
      }
      if (!Array.isArray(list?.providers)) throw new Error("no providers in it");
      curated = { list, fetchedAt: new Date().toISOString() };
      curatedFails = 0; curatedError = "";
      try { fs.writeFileSync(CURATED_PATH, JSON.stringify(curated, null, 2)); } catch { /* read-only fs ok */ }
    } catch (e) {
      curatedFailAt = Date.now(); curatedFails++; curatedError = String(e?.message || e).slice(0, 120);
      console.log("[models] public model list not refreshed:", String(e?.message || e).slice(0, 80));
    } finally { curatedBusy = null; }
    return curated || have;
  })();
  return curatedBusy;
}
// Before an answer that shows the list: a copy = no wait (a stale one
// refreshes in the background); no copy = wait up to maxWaitMs for the fetch.
export async function curatedReady(maxWaitMs = 2000) {
  const had = loadCurated();
  const p = refreshCurated();
  if (had) return had;
  let timer;
  await Promise.race([p.catch(() => null), new Promise((r) => { timer = setTimeout(r, maxWaitMs); })]);
  clearTimeout(timer);
  return loadCurated();
}
// Saving a key: the public list (if stale) and the provider lists, now.
export async function refreshAllModels() {
  await Promise.all([refreshCurated(false).catch(() => null), refreshModelList().catch(() => null)]);
}

// The public list, flattened. kind: "embedding" for the embedding job, else
// "chat". Models of the rerank job are left out: Mitos has no reranker client
// (its "AI best match" is a chat model), so nothing could use them.
export function curatedModels() {
  const list = loadCurated()?.list;
  const out = [];
  for (const p of list?.providers || []) {
    if (!PROVIDERS[p?.id]) continue;
    for (const m of p.models || []) {
      if (!m?.id || m.job === "rerank") continue;
      out.push({ id: m.id, name: m.name || m.id, provider: p.id, job: m.job || "workhorse", kind: m.job === "embedding" ? "embedding" : "chat",
        in: Number.isFinite(Number(m.in)) && m.in !== null ? Number(m.in) : null, out: Number.isFinite(Number(m.out)) && m.out !== null ? Number(m.out) : null,
        note: m.note || "", recommended: Boolean(m.recommended), ...(m.added ? { added: m.added } : {}) });
    }
  }
  return out;
}
// A listed id may be written with or without its dated snapshot.
const sameModel = (a, b) => a === b || (a.startsWith(b + "-") && /^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(a.slice(b.length + 1))) || (b.startsWith(a + "-") && /^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(b.slice(a.length + 1)));
export function curatedFind(model) {
  const { provider, id } = splitModel(model);
  return curatedModels().find((m) => m.id === id && (!provider || m.provider === provider)) || curatedModels().find((m) => sameModel(m.id, id) && (!provider || m.provider === provider)) || null;
}

// What GET /api/ai/models serves: the public list with `usable` (the provider
// has a key). A provider with a key whose public section names no embedding
// model gets the ones its own list shows (OpenAI's embedding models are not on
// the public list yet), marked `live`. With no public list at all, the live
// list stands in, with no job.
export function modelsView() {
  const cur = loadCurated();
  const keyed = (p) => Boolean(keyForProvider(p).key);
  const models = curatedModels().map((m) => ({ ...m, usable: keyed(m.provider) }));
  const live = liveModels();
  if (!cur) {
    for (const m of live) models.push({ id: m.id, name: m.name || m.id, provider: m.provider, job: null, kind: m.kind, in: null, out: null, note: "", recommended: false, usable: keyed(m.provider), live: true });
  } else {
    for (const p of Object.keys(PROVIDERS)) {
      if (!keyed(p) || models.some((m) => m.provider === p && m.kind === "embedding")) continue;
      for (const m of live.filter((x) => x.provider === p && x.kind === "embedding")) models.push({ id: m.id, name: m.name || m.id, provider: p, job: "embedding", kind: "embedding", in: null, out: null, note: "", recommended: false, usable: true, live: true });
    }
  }
  return { updated: cur?.list?.updated || null, source: cur ? (cur.list.source || curatedUrl()) : null, fetchedAt: cur?.fetchedAt || null, jobs: cur?.list?.jobs || {}, models, recommended: RECOMMENDED_JOB };
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
  const pub = curatedModels().filter((m) => m.id === id);
  const pubHit = pub.find((m) => keyForProvider(m.provider).key) || pub[0];
  if (pubHit) return pubHit.provider;
  const can = configuredProviders().filter((p) => !kind || (kind === "embedding" ? PROVIDERS[p].embed : PROVIDERS[p].chat));
  return can.length === 1 ? can[0] : "";
}
// "chat", "embedding", or "" when the model is on no list.
export function modelKind(model) {
  const { provider, id } = splitModel(model);
  if (provider && !PROVIDERS[provider].chat) return "embedding";
  if (provider && !PROVIDERS[provider].embed) return "chat";
  const listed = liveModels().filter((m) => m.id === id && (!provider || m.provider === provider));
  return listed[0]?.kind || curatedFind(model)?.kind || "";
}
export const isEmbeddingModel = (m) => modelKind(m) === "embedding";

// --- Jobs ---------------------------------------------------------------------------
// The public list says what each model is for (its job). Each stage has the
// job it works best at (Matt, 2026-11-20): naming and the AI best match the
// workhorse (the best match: "medium to low", so the cheap job is the next
// step down), the reading and the notes the cheap job, semantic search an
// embedding model. Nothing is read from a model's name.
export const RECOMMENDED_JOB = { naming: "workhorse", enrich: "cheap", understand: "cheap", rerank: "workhorse", semantic: "embedding" };
const JOB_DOWN = { reasoning: ["workhorse", "cheap"], workhorse: ["cheap"], cheap: [], embedding: [] };

// The default model for a stage (or "naming"): the `recommended` model of the
// stage's job from a provider with a key, else the first of that job with a
// key, else the next job down. With no public list at all, the first model of
// the right kind on the providers' own lists. "" when there is none: then a
// model must be chosen. `except` skips one id.
export function autoModel(stage, except = "") {
  const job = RECOMMENDED_JOB[stage];
  if (!job) return "";
  const kind = stageKind(stage);
  const skip = modelId(except);
  const usable = curatedModels().filter((x) => x.id !== skip && keyForProvider(x.provider).key);
  for (const j of [job, ...(JOB_DOWN[job] || [])]) {
    const of = usable.filter((x) => x.job === j);
    const m = of.find((x) => x.recommended) || of[0];
    if (m) return m.id;
  }
  // Embedding models the public list lacks (OpenAI's) come from the live list.
  return liveModels().find((x) => x.kind === kind && x.id !== skip && keyForProvider(x.provider).key)?.id || "";
}

// --- Models per role ---------------------------------------------------------------
// Naming: config.ai.namingModel, else NAMING_MODEL from the environment,
// else the live list's pick.
const chosenNamingModel = () => cfg().namingModel || process.env.NAMING_MODEL || "";
export const namingModel = () => chosenNamingModel() || autoModel("naming");

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
  // The plain best-match rule (search.js): marks one record when it is
  // clearly the one meant. No model, no key. Switch it off and no record is
  // ever marked, not even by the AI stage below.
  best: { on: true },
  // The AI best match: reorders the short list, and may name the best match
  // when `best` is on. Its model is the one this stage holds.
  rerank: { on: false, model: "", timeoutMs: 4000, candidates: 15, oneThreshold: 0.85 },
};
// A plain sync embeds at most this many new or changed rows; more waits for
// a Run from the paid-pass gate.
export const EMBED_CAP_PER_SYNC = 5000;
const stageKind = (name) => (name === "semantic" ? "embedding" : "chat");

// Prices per million tokens, for the estimate a person sees before a paid
// pass. They come from the public model list (`in` and `out` per model). A
// price typed in config.ai.prices ({ "<model id>": { in, out } }) wins. A
// model the list has no price for (a typed id, a live-only embedding model)
// gets a typical price for its kind of work.
const TYPICAL_PRICE = { embedding: { in: 0.13 }, chat: { in: 1.0, out: 4.0 } };
export function priceFor(model, kind = "") {
  const prices = cfg().prices || {};
  const p = prices[model] || prices[modelId(model)];
  if (p && Number.isFinite(Number(p.in))) return { in: Number(p.in), out: Number(p.out) || 0 };
  const c = curatedFind(model);
  if (c && c.in !== null) return { in: c.in, out: c.out ?? 0 };
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
    if ("model" in def && !s.model) { s.model = autoModel(name); s.auto = Boolean(s.model); }
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
  if (name === "fuzzy" || name === "best") return { ready: true };
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
  const model = chosen || autoModel("naming");
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

// A model that thinks before it answers spends its max_tokens on the thinking
// first (Claude Haiku 5.5: a 200 token call spent 112 thinking and stopped with
// no text). This is the error for an answer that never started.
const noRoom = (model) => new Error(`${model} used its whole answer allowance before answering. Mitos raised the limit; try again, or pick a different model.`);

// Claude: the lowest thinking the model allows, per request (current Claude API
// docs, checked 2026-11-20). Thinking off is `thinking: {type: "disabled"}`
// (Haiku 5.5 takes it at effort high or below; Opus 5, 4.8, 4.7, Sonnet 5 and
// older models take it). Claude Sonnet 5.5 answers 400 to "disabled" and takes
// `{type: "between_tools"}` instead. Claude Opus 5.5 and the Fable models cannot
// switch thinking off at all: they get no `thinking` field, and the lowest
// `output_config.effort`. Never decided by name: each setting is sent, and a
// 400 that names it makes the call again with the next one down; the model id
// is remembered so the ladder is climbed once per process.
const ANTHROPIC_THINKING = ["disabled", "between_tools"]; // then none
async function anthropicChat(model, key, { system, user, maxTokens, timeoutMs }) {
  for (;;) {
    const no = refusedBy("anthropic", model);
    const mode = ANTHROPIC_THINKING.find((m) => !no.has(`thinking:${m}`)) || null;
    const body = { model, max_tokens: maxTokens + (mode ? 0 : 2000), system, messages: [{ role: "user", content: user }] };
    if (mode) body.thinking = { type: mode };
    if (!no.has("effort")) body.output_config = { effort: "low" };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const json = await res.json();
      const text = (json.content || []).map((c) => (c.type === "text" ? c.text || "" : "")).join("");
      if (!text.trim() && json.stop_reason === "max_tokens") throw noRoom(model);
      if (!text.trim() && json.stop_reason === "refusal") throw new Error(`${model} declined to answer.`);
      return text;
    }
    const text = await res.text();
    if (res.status === 400) {
      // Which setting is the complaint about? Thinking first (its message names
      // "thinking", "disabled" or "between_tools"), then effort.
      if (mode && /thinking|disabled|between_tools|budget_tokens/i.test(text)) { remember("anthropic", model, `thinking:${mode}`); continue; }
      if (body.output_config && /effort|output_config/i.test(text)) { remember("anthropic", model, "effort"); continue; }
    }
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  }
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
      const content = out.choices?.[0]?.message?.content || "";
      if (!content.trim() && out.choices?.[0]?.finish_reason === "length") throw noRoom(model);
      return content;
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
      const content = (out.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      if (!content.trim() && out.candidates?.[0]?.finishReason === "MAX_TOKENS") throw noRoom(model);
      return content;
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
