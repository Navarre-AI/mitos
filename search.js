// search.js - the search, in two phases.
//
// Phase 1, "exact": deterministic and instant. The query goes through the
// type-detection front door (query.js), one DuckDB query returns the
// per-table top-k, the tables are balanced, and every hit carries a reason.
// The fuzzy stage (Jaro-Winkler on titles, no model) runs here too when it
// is on: it is as fast as the exact search and needs no key.
//
// Phase 2, "ai": the optional model stages, each with its own switch and
// time budget, each falling back to nothing when late or broken:
//   understand  rewrites the typed words into the engine's syntax, then
//               phase 1 runs again on the rewrite
//   semantic    embeds the query and adds "similar" rows below the list
//   rerank      reorders the short list and may name ONE best match
// Exact hits are never removed by phase 2 and never wait for it. The page
// shows phase 1 at once and fills phase 2 in behind.
//
// The balance rule (the "Canon" behavior): every table with a hit appears,
// no table floods the list. Cap each table at `limit`, order tables by their
// best score, interleave round-robin.

import "./env.js";
import { textSearch, fuzzySearch, fuzzyEmailSearch, vectorSearch, indexStats, normalizeText } from "./store.js";
import { parseQuery, describePlan } from "./query.js";
import { stages, STAGE_NAMES, keyForProvider, providerOf } from "./ai.js";
import { embedQuery, vectorKey } from "./embed.js";
import { understand } from "./understand.js";
import { rerank } from "./rerank.js";
import { semanticTables } from "./semantic.js";

// Which stages run for this search: the saved switches, or an explicit list
// (the simulator and the eval compare stage sets this way). A model stage
// still needs its key either way.
function activeStages(override) {
  const on = {};
  const cfg = stages();
  for (const name of STAGE_NAMES) {
    // `best` is not a search stage an explicit list names (the simulator and
    // the eval pass exact,fuzzy,...): it keeps its saved switch unless named.
    const wanted = override ? (override.has(name) || (name === "best" && cfg.best.on)) : cfg[name].on;
    if (!wanted) { on[name] = false; continue; }
    if (name === "fuzzy" || name === "best") { on[name] = true; continue; }
    on[name] = Boolean(cfg[name].model && keyForProvider(providerOf(cfg[name].model)).key);
  }
  return on;
}

// The "is anything indexed" check is one DuckDB process per search, and
// every DuckDB call queues behind the others. Ten seconds of memory is
// plenty: an index goes from empty to full once.
let statsCache = { at: 0, value: null };
async function cachedStats() {
  if (statsCache.value && Date.now() - statsCache.at < 10000 && statsCache.value.totalRows) return statsCache.value;
  statsCache = { at: Date.now(), value: await indexStats() };
  return statsCache.value;
}

// After a wipe or a drop: the "is anything indexed" answer must be read again.
export function forgetSearchCache() { statsCache = { at: 0, value: null }; }

export async function search(query, opts = {}) {
  const { limit = 5, dateFormat = "mdy", tables = null, stageOverride = null, phase = "exact", tablesCfg = {}, labels = {} } = opts;
  const t0 = Date.now();
  const on = activeStages(stageOverride);
  const stats = await cachedStats();
  const base = { query, mode: "exact", phase };
  if (!stats.totalRows) return { ...base, empty: true, kind: "empty", groups: [], merged: [], timings: { totalMs: Date.now() - t0 } };

  // Which tables' search notes may match: the stage on, and the table's
  // own switch on. Notes of the others stay stored and stay quiet.
  const enrichTables = stages().enrich.on ? Object.keys(tablesCfg || {}).filter((n) => tablesCfg[n]?.enrich?.on) : [];
  const exact = await runExact(query, { limit, dateFormat, tables, fuzzy: on.fuzzy, stageCfg: stages(), enrichTables });
  // Which model stages have anything to do here. A typed number, date,
  // email or phone is already understood and is a set, not a pick; one
  // plain word needs no reading. Those skip the round trips.
  const plainWords = exact.plan?.kind === "text";
  const several = plainWords && exact.plan.terms.length >= 2;
  const pending = ["understand", "semantic", "rerank"].filter((n) => on[n] && (n === "understand" ? several : n === "rerank" ? plainWords : true));
  let result = { ...base, ...exact.out, stages: { fuzzy: exact.fuzzyInfo, ...(pending.length ? { pending } : {}) } };
  if (phase === "exact" || !pending.length) {
    result.timings = { ...exact.timings, totalMs: Date.now() - t0 };
    finishPct(result);
    result.best = on.best ? await deterministicBest(result) : null;
    return result;
  }
  const ai = await runAi(query, exact, { limit, dateFormat, tables, on: { ...on, understand: pending.includes("understand"), rerank: pending.includes("rerank"), semantic: pending.includes("semantic") }, tablesCfg, labels });
  result = { ...result, ...ai.out, stages: { ...result.stages, ...ai.stages, pending: [] } };
  result.timings = { ...exact.timings, ...ai.timings, totalMs: Date.now() - t0 };
  return result;
}

// --- Phase 1 --------------------------------------------------------------------------------
// Words that ask for a search and are not part of any name. Used only by the
// fallback for a query that found nothing, to drop them and try again.
const FILLER = new Set(["find", "please", "the", "a", "an", "contact", "show", "me", "for", "of", "to", "with", "and", "my", "get", "search", "look", "up", "lookup", "about", "info", "record", "records", "who", "is", "i", "want", "need", "where"]);

async function runExact(query, { limit, dateFormat, tables, fuzzy, stageCfg, enrichTables = [] }) {
  const t0 = Date.now();
  let plan = parseQuery(query, { dateFormat });
  const out = { kind: plan.kind, searched: describePlan(plan), plan: publicPlan(plan), words: plan.kind === "text" ? plan.terms.map((t) => t.word) : [] };
  if (plan.kind === "empty") return { out: { ...out, groups: [], merged: [] }, timings: { searchMs: 0 }, fuzzyInfo: { ran: false } };
  let raw = await textSearch(plan, { perTable: limit, tables, enrichTables });
  // R3: every word must match, and that found nothing. Say the same search
  // again with fewer demands, never with more: first without filler words
  // ("find Bob Whitfield please"), then records with most of the words,
  // ranked by how many they have. Only runs on an empty answer, so it can
  // never push down or remove an exact hit.
  if (!raw.length && plan.kind === "text" && plan.terms.length >= 2) {
    const content = plan.terms.filter((t) => t.mode !== "phrase" ? !FILLER.has(t.word) : true);
    if (content.length && content.length < plan.terms.length) {
      const stripped = { ...plan, terms: content, fallback: "filler" };
      raw = await textSearch(stripped, { perTable: limit, tables, enrichTables });
      if (raw.length) { plan = stripped; out.words = content.map((t) => t.word); }
    }
    if (!raw.length && content.length >= 3) {
      const most = { ...plan, terms: content, need: Math.max(2, Math.ceil(content.length / 2)), fallback: "most" };
      raw = await textSearch(most, { perTable: limit, tables, enrichTables });
      if (raw.length) { plan = most; out.words = content.map((t) => t.word); }
    }
    if (raw.length) { out.searched = describePlan(plan); out.plan = publicPlan(plan); }
  }
  const tSearch = Date.now();
  const byTable = new Map();
  const seen = new Set();
  let ord = 0;
  for (const r of raw) {
    if (!byTable.has(r.src_table)) byTable.set(r.src_table, []);
    const why = explain(plan, r);
    seen.add(`${r.src_table}\u0000${r.record_id}`);
    byTable.get(r.src_table).push({
      id: r.record_id, score: Number(r.score), via: "exact",
      where: why.some((w) => w.endsWith("in the title")) ? "title" : "fields",
      why,
      display: JSON.parse(r.display),
      _title: r.title_text || "",
      _tw: why.filter((w) => w.endsWith("in the title")).length, // query words found in the record's title
      _ord: ord++, // the SQL's order: score, then the matched value (a range lists lowest first), then title length
    });
  }
  // The fuzzy stage: names typed wrong. Only for words, only when the exact
  // search left room in the list, and never above an exact hit.
  let fuzzyInfo = { ran: false };
  // Each query word with its name-table forms, so "bob whitfeld" is tried
  // as robert too. A phrase term contributes each of its words.
  // Two-letter words count: "Ac me systems" only finds Acme Systems when
  // "ac" and "me" are part of the comparison (the space-free form).
  const words = plan.kind === "text"
    ? plan.terms.filter((t) => t.mode !== "wild").flatMap((t) => t.mode === "phrase" ? t.word.split(" ").map((w) => [w]) : [[t.word, ...(t.also || [])]]).filter((g) => g[0].length >= 2)
    : [];
  if (fuzzy && plan.kind === "email" && !raw.length) {
    const tf = Date.now();
    try {
      const fz = await fuzzyEmailSearch(plan.value, { perTable: limit, minSim: Math.max(0.93, Number(stageCfg.fuzzy.minSim) || 0), tables });
      for (const r of fz) {
        if (!byTable.has(r.src_table)) byTable.set(r.src_table, []);
        const sim = Number(r.sim);
        byTable.get(r.src_table).push({ id: r.record_id, score: Math.round(sim * 100) / 100, via: "fuzzy", where: "fields", sim,
          why: [`email looks like ${r.email} (${Math.round(sim * 100)}%)`], display: JSON.parse(r.display), _title: r.title_text || "" });
      }
      fuzzyInfo = { ran: true, hits: fz.length, ms: Date.now() - tf };
    } catch (e) { fuzzyInfo = { ran: true, error: String(e.message).slice(0, 120), ms: Date.now() - tf }; }
  }
  if (fuzzy && words.length && !plan.exact) {
    const tf = Date.now();
    try {
      const minSim = Number(stageCfg.fuzzy.minSim) || 0.9;
      const fz = await fuzzySearch(words, { perTable: limit, minSim, tables });
      let added = 0;
      for (const r of fz) {
        const k = `${r.src_table}\u0000${r.record_id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!byTable.has(r.src_table)) byTable.set(r.src_table, []);
        const list = byTable.get(r.src_table);
        if (list.length >= limit && !(Number(r.sim) >= 0.95 && list.length < limit * 2)) continue;
        const sim = Number(r.sim);
        list.push({ id: r.record_id, score: Math.round(sim * 100) / 100, via: "fuzzy", where: "title", sim,
          why: [`${sim >= 0.92 ? "almost" : "looks like"} "${String(JSON.parse(r.display)[Object.keys(JSON.parse(r.display))[0]] ?? "").trim()}" (${Math.round(sim * 100)}%)`],
          display: JSON.parse(r.display), _title: r.title_text || "" });
        added++;
      }
      fuzzyInfo = { ran: true, hits: added, ms: Date.now() - tf };
    } catch (e) { fuzzyInfo = { ran: true, error: String(e.message).slice(0, 120), ms: Date.now() - tf }; }
  }
  const groups = balance(byTable, limit);
  return { out: { ...out, groups: groups.map(publicGroup), merged: mergeGroups(groups) }, timings: { searchMs: tSearch - t0, exactMs: Date.now() - t0 }, fuzzyInfo, plan, groups };
}

// Order tables by their best result, exact rows before fuzzy rows within a
// table, then cap. Exact rows keep the SQL's order (it already sorted by
// score and by the matched value); fuzzy and similar rows sort by their
// similarity.
// Reciprocal rank fusion (Cormack, Clarke and Buettcher, 2009): each list
// votes by rank, 1 / (k + rank), and a record near the top of two lists
// beats one that tops a single list. Weighted, so an exact hit always
// outranks a look-alike: a 95% "Cantón" once sat above the exact "Eduma
// Canon" under the old fixed bands (2026-09-09), and any new list (a
// rewrite, a note match) joins the vote without a new band.
const RRF_K = 60;
const RRF_WEIGHT = { exact: 1.0, near: 0.55, weak: 0.25, semantic: 0.5 };
const listOf = (r) => (r.via === "exact" ? "exact" : r.via === "fuzzy" ? ((r.sim || 0) >= 0.95 ? "near" : "weak") : "semantic");
function balance(byTable, limit) {
  const tie = (a, b) => (a._ord !== undefined && b._ord !== undefined ? a._ord - b._ord : 0) || a._title.length - b._title.length || String(a.id).localeCompare(String(b.id));
  const within = (a, b) => (a.via === "exact" ? (b.score - a.score) || tie(a, b) : ((b.sim || 0) - (a.sim || 0)) || tie(a, b));
  return [...byTable.entries()]
    .map(([table, results]) => {
      const lists = new Map();
      for (const r of results) { const l = listOf(r); if (!lists.has(l)) lists.set(l, []); lists.get(l).push(r); }
      const fused = new Map();
      for (const [name, rows] of lists) {
        rows.sort(within);
        rows.forEach((r, i) => fused.set(r, (fused.get(r) || 0) + (RRF_WEIGHT[name] || 0.3) / (RRF_K + i + 1)));
      }
      const sorted = results.slice().sort((a, b) => (fused.get(b) - fused.get(a)) || tie(a, b));
      const near = sorted.filter((r) => listOf(r) === "near").length;
      return { table, best: fused.get(sorted[0]) || 0, titleWords: sorted[0]?._tw || 0, results: sorted.slice(0, Math.min(limit * 2, limit + near)) };
    })
    // Two tables whose best rows are both exact hits tie on the fused score.
    // The one whose best row has more of the query in its title goes first:
    // "Robert Whitfield" is the person, not the company he works for (R1,
    // 2026-11-21). The table name is the last resort, not the first.
    .sort((a, b) => b.best - a.best || b.titleWords - a.titleWords || a.table.localeCompare(b.table));
}
function mergeGroups(groups) {
  const merged = [];
  for (let i = 0; ; i++) {
    let any = false;
    for (const g of groups) if (g.results[i]) { merged.push({ table: g.table, ...publicRow(g.results[i]) }); any = true; }
    if (!any) break;
  }
  return merged;
}
const publicRow = ({ _title, _ord, _tw, ...r }) => r;
const publicGroup = (g) => ({ table: g.table, results: g.results.map(publicRow) });

// The % at the right of each row, and the order of the rows, are one number.
// An exact row is measured against the strongest exact row of the search (the
// top one is 100%); a close spelling or a semantic row shows its own
// similarity, never 100%. Each list is then sorted by that shown number
// (stable: ties keep the order the search and the AI gave), so the % never
// goes up as you read down a table's list. The AI can still pick the Best
// match and the order of the tables; inside a list the shown % rules.
function finishPct(out) {
  const lists = [...(out.groups || []), ...(out.similar || [])];
  let topExact = 0;
  for (const g of lists) for (const r of g.results) if (r.via === "exact") topExact = Math.max(topExact, Number(r.score) || 0);
  for (const g of lists) {
    for (const r of g.results) {
      const sc = Number(r.score) || 0;
      r.pct = r.via === "exact" ? (topExact > 0 ? Math.max(1, Math.round((100 * sc) / topExact)) : 100) : Math.max(1, Math.min(99, Math.round(100 * (r.sim ?? sc))));
    }
    g.results = g.results.map((r, i) => [r, i]).sort((a, b) => (b[0].pct - a[0].pct) || (a[1] - b[1])).map(([r]) => r);
  }
  out.merged = mergeGroups(out.groups || []);
  if (out.similar) out.similarMerged = mergeGroups(out.similar);
  return out;
}

// --- Phase 2 --------------------------------------------------------------------------------
// The AI phase has one time budget. Whatever has not answered when it runs
// out is skipped, and the search answers with what it has.
const AI_BUDGET_MS = 6000;

async function runAi(query, exact, { limit, dateFormat, tables, on, tablesCfg, labels }) {
  const timings = {};
  const info = {};
  const cfg = stages();
  const t0 = Date.now();
  const left = () => t0 + AI_BUDGET_MS - Date.now();
  // The two model calls that depend only on the typed words start together.
  const pUnderstand = on.understand ? understand(query, { tablesCfg, labels, dateFormat }) : Promise.resolve(null);
  const pVec = on.semantic ? embedQuery(query).then((v) => ({ v })).catch((e) => ({ error: String(e.message).slice(0, 160) })) : Promise.resolve(null);

  let current = exact;
  let rewritten = null, reading = "", semanticPhrase = null, hintTables = [];
  const u = await pUnderstand;
  if (u) {
    info.understand = u.error ? { ran: true, error: u.error, ms: u.ms } : { ran: true, ms: u.ms, cached: Boolean(u.cached), reading: u.reading, query: u.query, tables: u.tables, one: u.one };
    timings.understandMs = u.ms;
    if (!u.error) {
      reading = u.reading || "";
      semanticPhrase = u.semantic;
      hintTables = u.tables || [];
      const changed = u.query.trim().toLowerCase() !== query.trim().toLowerCase();
      if (changed || hintTables.length) {
        // A set query (a range, a date) restricted to the tables named; a
        // name query runs everywhere, and the named tables come first. The
        // rows phase 1 already showed stay, ahead of what the rewrite adds:
        // a person never watches a result vanish.
        try {
          const plan = parseQuery(u.query, { dateFormat });
          const restrict = hintTables.length && plan.kind !== "text" ? hintTables : tables;
          const enrichTables = cfg.enrich.on ? Object.keys(tablesCfg || {}).filter((n) => tablesCfg[n]?.enrich?.on) : [];
          const again = await runExact(u.query, { limit, dateFormat, tables: restrict, fuzzy: on.fuzzy, stageCfg: cfg, enrichTables });
          if (changed) rewritten = u.query;
          // The same record found by both keeps its stronger row: an exact
          // hit on the rewrite beats a close spelling on the typed words.
          const rank = (r) => (r.via === "exact" ? 1000 + r.score : r.via === "fuzzy" ? 100 + (r.sim || 0) : (r.sim || 0));
          const bestOf = new Map();
          const keepFrom = plan.kind === "text" ? exact.groups : exact.groups.map((g) => ({ ...g, results: g.results.filter((r) => r.via === "exact") }));
          for (const g of [...keepFrom, ...again.groups]) {
            for (const r of g.results) {
              const k = `${g.table} ${r.id}`;
              if (!bestOf.has(k) || rank(r) > rank(bestOf.get(k).r)) bestOf.set(k, { table: g.table, r });
            }
          }
          const byTable = new Map();
          for (const { table, r } of bestOf.values()) {
            if (!byTable.has(table)) byTable.set(table, []);
            byTable.get(table).push(r);
          }
          const groups = balance(byTable, limit);
          if (hintTables.length && plan.kind === "text") {
            const pref = new Set(hintTables);
            groups.sort((a, b) => Number(pref.has(b.table)) - Number(pref.has(a.table)) || b.best - a.best);
          }
          current = { ...again, groups, out: { ...again.out, groups: groups.map(publicGroup), merged: mergeGroups(groups) } };
          timings.rewriteMs = again.timings.exactMs;
        } catch (e) {
          info.understand.error = `rewrite failed: ${String(e.message).slice(0, 120)}`;
          rewritten = null;
        }
      }
    }
  }

  // The reranker needs only the exact and rewritten rows, so it starts now
  // and runs while the semantic step runs, instead of after it (three model
  // calls in series took 7 to 9 s on the demo, 2026-09-09).
  const tr = Date.now();
  const candidates = on.rerank ? current.out.merged.slice(0, Number(cfg.rerank.candidates) || 15).map((c) => ({ ...c, label: labels[c.table] || c.table })) : [];
  const pRerank = !on.rerank ? null
    : left() < 1500 ? Promise.resolve({ skipped: "no time left" })
    : candidates.length < 2 ? Promise.resolve({ skipped: "one candidate" })
    : rerank(query, reading || current.out.searched, candidates).catch((e) => ({ error: String(e.message).slice(0, 160), ms: Date.now() - tr }));

  // Similar rows: embed the meaning phrase when the model gave one, else the
  // typed words. Rows already in the list are not repeated.
  let similar = [];
  const vec0 = await pVec;
  // A date or number range has no meaning to embed: "birthdays in May"
  // rewritten to a range is answered by the range, and "similar" rows for
  // it would be noise. Only a phrase from the reading, or plain words, go
  // to the vector search.
  const currentKind = current.plan?.kind || exact.plan?.kind;
  if (vec0 && !semanticPhrase && currentKind && currentKind !== "text") info.semantic = { ran: false, skipped: `a ${currentKind} has no meaning to embed` };
  else if (vec0) {
    const ts = Date.now();
    try {
      let v = vec0.v;
      if (vec0.error) throw new Error(vec0.error);
      const phrase = semanticPhrase || rewritten;
      // The phrase's own vector only when there is time for it; else the
      // typed words' vector, which is already here.
      if (phrase && phrase.trim().toLowerCase() !== query.trim().toLowerCase() && left() > 1500) v = await embedQuery(phrase);
      // No floor: the nearest rows always come back (Matt, 2026-09-09). The
      // floor only says whether they are "Semantic matches" or "Perhaps
      // you meant", and that flag rides along as `weak`.
      const floor = Number(cfg.semantic.minSim) || 0.4;
      // Only the tables whose semantic switch is on (the others have no vectors,
      // or none worth searching), inside the person's own tables filter.
      const semTables = semanticTables(tablesCfg);
      const vecTables = tables ? tables.filter((t) => semTables.includes(t)) : semTables;
      const rows = vecTables.length ? await vectorSearch(v, vectorKey(), { perTable: limit, minSim: 0, tables: vecTables }) : [];
      const shown = new Set(current.out.merged.map((m) => `${m.table}\u0000${m.id}`));
      const top = rows.reduce((a, r) => Math.max(a, Number(r.sim)), 0);
      const byTable = new Map();
      for (const r of rows) {
        const sim = Number(r.sim);
        // When the best is a real match, rows far behind it are clutter
        // from other tables; when everything is weak, all the nearest show.
        if (top >= floor && top - sim > 0.15) continue;
        if (shown.has(`${r.src_table}\u0000${r.record_id}`)) continue;
        if (!byTable.has(r.src_table)) byTable.set(r.src_table, []);
        const list = byTable.get(r.src_table);
        if (list.length >= limit) continue;
        list.push({ id: r.record_id, score: Math.round(sim * 100) / 100, via: "semantic", sim, where: "meaning",
          why: [`similar meaning (${Math.round(sim * 100)}%)`], display: JSON.parse(r.display), _title: r.title_text || "" });
      }
      similar = balance(byTable, limit);
      info.semantic = { ran: true, hits: similar.reduce((a, g) => a + g.results.length, 0), ms: Date.now() - ts, phrase: phrase || query, top: Math.round(top * 100) / 100, weak: top < floor };
    } catch (e) { info.semantic = { ran: true, error: String(e.message).slice(0, 160), ms: Date.now() - ts }; }
    timings.semanticMs = info.semantic.ms;
  }

  const out = {
    ...current.out,
    ...(rewritten ? { rewritten } : {}),
    ...(reading ? { reading } : {}),
    similar: similar.map(publicGroup),
    similarMerged: mergeGroups(similar),
    similarWeak: Boolean(info.semantic?.weak),
  };

  // The decision: reorder the short list, and name one best match only when
  // the model is sure. Without the stage, the deterministic rule decides.
  // The plain rule runs only while the Best match switch is on; with it off
  // the AI stage may still reorder the list, but no record is ever marked.
  finishPct(out);
  let best = on.best ? await deterministicBest(out) : null;
  if (pRerank) {
    const r = await pRerank;
    if (r.skipped) info.rerank = { ran: false, skipped: r.skipped };
    else if (r.error) info.rerank = { ran: true, error: r.error, ms: r.ms };
    else {
      const ordered = r.order.map((i) => candidates[i]);
      // Rebuild the groups in the reranked order: tables by their best
      // position, rows inside a table by position.
      const pos = new Map(ordered.map((c, i) => [`${c.table}\u0000${c.id}`, i]));
      const rankOf = (t, id) => pos.has(`${t}\u0000${id}`) ? pos.get(`${t}\u0000${id}`) : 1e6;
      for (const g of out.groups) g.results.sort((a, b) => rankOf(g.table, a.id) - rankOf(g.table, b.id));
      out.groups.sort((a, b) => rankOf(a.table, a.results[0]?.id) - rankOf(b.table, b.results[0]?.id));
      out.merged = out.merged.slice().sort((a, b) => rankOf(a.table, a.id) - rankOf(b.table, b.id));
      const threshold = Number(cfg.rerank.oneThreshold) || 0.85;
      if (on.best && r.best !== null && r.confidence >= threshold) {
        const c = candidates[r.best];
        best = { table: c.table, id: c.id, confidence: Math.round(r.confidence * 100) / 100, why: r.why || "the model is confident", by: "rerank" };
      } else if (on.best && r.best !== null && best && (best.table !== candidates[r.best].table || best.id !== candidates[r.best].id)) {
        best = null; // the two rules disagree: no single answer
      }
      info.rerank = { ran: true, ms: r.ms, cached: Boolean(r.cached), best: r.best !== null ? { table: candidates[r.best].table, id: candidates[r.best].id } : null, confidence: r.confidence, why: r.why };
    }
    timings.rerankMs = Date.now() - tr;
  }
  finishPct(out); // the rerank above reordered the lists; the shown % sorts them again
  out.best = best;
  return { out, stages: info, timings };
}

// The best match is a clear gap, not a word rule (Matt, 2026-11-20): for words,
// the top result is the best match when every typed word matches it (a word
// START counts: "ram" matches "Ramen") and it stands clear of the pack: there
// is no second result, or the second scores under BEST_GAP of the first. Or
// one name is the typed words with a slip and nothing else comes close. For an
// identifier (email, phone, a number): exactly one record carries it. A tie
// means a list, never a guess. Every answer says who picked it: `by`.
export const BEST_GAP = 0.7;
export async function deterministicBest(result) {
  const merged = result.merged || [];
  if (!merged.length) return null;
  const exact = merged.filter((m) => m.via === "exact");
  if (result.kind === "text") {
    const phrase = (result.words || []).join(" ");
    if (!phrase || phrase.length < 3) return null;
    // Nothing exact, but one name is the typed words with a slip ("Ac me
    // systems", "whitfeild") and nothing else comes close: that is it.
    if (!exact.length) {
      const fz = merged.filter((m) => m.via === "fuzzy").sort((a, b) => (b.sim || 0) - (a.sim || 0));
      if (fz.length && (fz[0].sim || 0) >= 0.97 && (!fz[1] || (fz[1].sim || 0) <= (fz[0].sim || 0) - 0.05)) {
        return { table: fz[0].table, id: fz[0].id, confidence: 0.85, why: "the one name that is what you typed with a slip", by: "fuzzy" };
      }
      return null;
    }
    const top = exact.slice().sort((a, b) => b.score - a.score);
    const first = top[0], second = top[1];
    // Every typed word (or its name-table form) starts a word of what the
    // record shows. A word typed with = must be a whole word, one with * may
    // sit inside a word.
    const shown = normalizeText(Object.values(first.display || {}).join(" "));
    const title = normalizeText(String(Object.values(first.display || {})[0] ?? ""));
    const terms = result.plan?.terms || [];
    const matches = (t) => [t.word, ...(t.also || [])].some((w) => (t.mode === "wild" ? new RegExp(` ${w.split("*").join("[^ ]*")}`).test(shown) : t.mode === "whole" ? shown.includes(` ${w} `) : t.mode === "contains" ? shown.includes(w) : shown.includes(` ${w}`)));
    if (terms.length ? !terms.every(matches) : !(result.words || []).every((w) => shown.includes(` ${w}`))) return null;
    // A name is short. A record whose "title" is a paragraph (a product
    // listed by its blurb) carries any two words, and that is no answer.
    if (title.split(" ").filter(Boolean).length > 8) return null;
    if (second && !(second.score < BEST_GAP * first.score)) return null;
    const starts = title.trim() === phrase || title.trim().startsWith(phrase + " ");
    return { table: first.table, id: first.id, confidence: starts ? 0.9 : 0.8,
      why: second ? `every word matches, and the next record scores under ${Math.round(BEST_GAP * 100)}% of it` : "every word matches, and no other record does", by: "exact" };
  }
  if (["email", "phone", "number"].includes(result.kind) && exact.length === 1 && merged.length === 1) {
    return { table: exact[0].table, id: exact[0].id, confidence: 0.9, why: `the only record with that ${result.kind === "number" ? "number" : result.kind}`, by: "exact" };
  }
  return null;
}

// The plan as the API shows it: the kind and its bounds, nothing internal.
function publicPlan(p) {
  switch (p.kind) {
    case "text": return { kind: p.kind, terms: p.terms, ...(p.fallback ? { fallback: p.fallback } : {}) };
    case "number": return { kind: p.kind, value: p.value, ...(p.year ? { year: p.year } : {}), ...(p.digits ? { phone: true } : {}) };
    case "range": case "date": case "daterange": return { kind: p.kind, from: p.from, to: p.to };
    case "month": return { kind: p.kind, month: p.month };
    case "email": return { kind: p.kind, value: p.value };
    case "phone": return { kind: p.kind, digits: p.digits };
    default: return { kind: p.kind };
  }
}

// Why this row is here, one short phrase per matched thing. Computed from
// the same normalized columns the SQL matched on, so it cannot disagree.
function explain(plan, r) {
  const out = [];
  const st = r.search_text || "", tt = r.title_text || "", en = r.enrich_norm || "";
  const has = (text, w, mode) => {
    if (mode === "wild") return new RegExp(` ${w.split("*").join("[^ ]*")}`).test(text);
    if (mode === "whole") return text.includes(` ${w} `);
    if (mode === "contains") return text.includes(w);
    return text.includes(` ${w}`);
  };
  const levelOf = (text, w) => w.includes("*") ? "pattern" : text.includes(` ${w} `) ? "whole word" : text.includes(` ${w}`) ? "word start" : text.includes(w) ? "inside a word" : null;
  switch (plan.kind) {
    case "text":
      for (const t of plan.terms) {
        const cands = [t.word, ...t.also];
        const inTitle = cands.find((w) => has(tt, w, t.mode));
        const inText = inTitle || cands.find((w) => has(st, w, t.mode));
        const inEnrich = inText || cands.find((w) => has(en, w, t.mode));
        const w = inTitle || inText || inEnrich;
        if (!w) continue;
        const label = t.mode === "phrase" ? `"${t.word}"` : t.word;
        const via = w !== t.word ? ` as ${w}` : "";
        out.push(inTitle ? `${label}${via} in the title` : inText ? `${label}${via}: ${levelOf(st, w)}` : `${label}${via} in the search notes`);
      }
      break;
    case "number": {
      const hits = Array.isArray(r.hits) ? r.hits : [];
      const asNum = hits.filter((h) => /^-?\d+(\.\d+)?$/.test(String(h)));
      const asDate = hits.filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(String(h)));
      if (asNum.length) out.push(`number field = ${asNum[0]}`);
      if (asDate.length) out.push(`date ${asDate[0]} in ${plan.value}`);
      if (!asNum.length && !asDate.length && st.includes(` ${plan.text.join(" ")} `)) out.push(`${plan.value} as a whole word`);
      if (plan.digits) {
        const m = (r.digits || "").split(" ").filter(Boolean).find((d) => d.includes(plan.digits));
        if (m) out.push(m === plan.digits ? "phone, exact" : m.endsWith(plan.digits) ? "phone ends with it" : "phone contains it");
      }
      break;
    }
    case "range":
      out.push(`number ${Array.isArray(r.hits) && r.hits.length ? r.hits[0] : ""} in range`.replace("  ", " "));
      break;
    case "date":
    case "month":
    case "daterange":
      out.push(`date ${Array.isArray(r.hits) && r.hits.length ? r.hits[0] : ""}`.trim());
      break;
    case "email": {
      const m = (r.emails || "").split(" ").filter(Boolean).find((e) => e.includes(plan.value));
      out.push(m ? `email ${m}` : "email");
      break;
    }
    case "phone": {
      const m = (r.digits || "").split(" ").filter(Boolean).find((d) => d.includes(plan.digits));
      out.push(m === plan.digits ? "phone, exact" : m && m.endsWith(plan.digits) ? "phone ends with it" : "phone contains it");
      break;
    }
  }
  return out;
}

export { normalizeText };
