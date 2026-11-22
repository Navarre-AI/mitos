// test-ai.mjs - `npm run test:ai`. Needs OPENAI_API_KEY; costs a few cents. Starts Mitos on
// the sample data with semantic search and the reranker on, runs 25 searches with the AI
// phase, and fails on any broken promise: an exact hit lost, a % that rises down a list,
// a semantic row the reranker joined sitting above an exact row. Key goes to the child only.
if (!process.env.OPENAI_API_KEY) { console.log("test:ai needs OPENAI_API_KEY in the environment; skipped."); process.exit(0); }
import fs from "fs"; import os from "os"; import net from "net"; import path from "path"; import { spawn } from "child_process"; import { fileURLToPath } from "url";
import { DEFAULT_TABLES } from "../tables.config.js";
const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)), ".."); const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
// ---- start a Mitos (same shape as scripts/test.mjs) ----------------------------------------------
const kids = [];
function stopAll() { for (const k of kids) { try { k.child.kill("SIGKILL"); } catch {} try { fs.rmSync(k.dir, { recursive: true, force: true }); } catch {} } }
process.on("SIGINT", () => { stopAll(); process.exit(130); });
process.on("SIGTERM", () => { stopAll(); process.exit(143); });

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });

function cleanEnv(port, dataDir, withOpenAI) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(FM_|EMBED_|ANTHROPIC|OPENAI|GEMINI|GOOGLE|NAMING|SITE_PASSWORD|MITOS_|FLY_|DUCKDB_(PATH|VEC_PATH)|LOAD_SAMPLE|DATA_DIR|PORT)/i.test(k)) continue;
    if (/(_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i.test(k)) continue;
    env[k] = v;
  }
  if (withOpenAI) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return { ...env, PORT: String(port), DATA_DIR: dataDir, ...(withOpenAI ? {} : { MITOS_MODEL_LIST_URL: "" }) };
}

async function startMitos({ ai }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-bench-"));
  if (ai) {
    const tables = Object.fromEntries(Object.entries(DEFAULT_TABLES).map(([n, t]) => [n, { ...t, semantic: true }]));
    // columnsMigrated: a 1.2 config, so the boot migration leaves the per-table semantic switches alone.
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ tables, columnsMigrated: "1.2", ai: { stages: { rerank: { on: true }, ...(process.env.BENCH_DIMS ? { semantic: { dims: Number(process.env.BENCH_DIMS) } } : {}) } } }, null, 2));
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "", exited = false;
  const child = spawn(process.execPath, ["--import", path.join(ROOT, "scripts", "test-preload.mjs"), path.join(ROOT, "server.js")], { cwd: ROOT, env: cleanEnv(port, dir, ai), stdio: ["ignore", "pipe", "pipe"] });
  kids.push({ child, dir });
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  child.on("exit", () => { exited = true; });
  const j = async (url, init) => { const r = await fetch(base + url, { ...init, signal: AbortSignal.timeout(60000) }); return r.json(); };
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error("Mitos exited at start:\n" + log.slice(-800));
    try { const h = await j("/api/health"); if (h.ok) { if (h.fm) throw new Error("FileMaker is configured in the bench server. Refusing to go on."); break; } } catch (e) { if (/FileMaker/.test(e.message)) throw e; }
    await sleep(100);
  }
  // The boot lines come after the model list loads, which takes a moment with a key set.
  for (let i = 0; i < 150 && !/\bfm: /.test(log); i++) await sleep(100);
  if (!/sample mode/.test(log)) throw new Error("Mitos did not report sample mode:\n" + log.slice(-800));
  await j("/api/index/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  for (let i = 0; i < (ai ? 1200 : 300); i++) {
    if (exited) throw new Error("Mitos exited while indexing:\n" + log.slice(-800));
    const st = await j("/api/index/job");
    if (st.job && st.job.done) { if (st.job.error) throw new Error("sync failed: " + st.job.error); break; }
    await sleep(150);
  }
  const h = await j("/api/health");
  if (!h.indexRows) throw new Error("sample did not index:\n" + log.slice(-800));
  return { base, j, rows: h.indexRows, version: h.version };
}


const srv = await startMitos({ ai: true });
const qs = ["cheap coffee","Matt","Navarre","Bob Whitfield","iphone","gaming laptop","heart clinic","boat salvage company","luxury shoes","john costa","Atlas","running shoes","noise cancelling headphones","coffee","Greek Matt","earphones","bike for commuting","Matt Navarre","Hank","shoes","laptop","cardiac","find Bob Whitfield please","electric bicycle","healthcare company in Portland","george maraki","乔治"];
let bad = 0, joined = 0;
for (const qq of qs) {
  const e = await srv.j(`/api/search?q=${encodeURIComponent(qq)}&limit=5`);
  const r = await srv.j(`/api/search?q=${encodeURIComponent(qq)}&ai=1&stages=exact,fuzzy,semantic,rerank`);
  const have = new Set(r.groups.flatMap(g => g.results.map(x => g.table + x.id)));
  for (const g of e.groups) for (const x of g.results) if (x.via === "exact" && !have.has(g.table + x.id)) { bad++; console.log("LOST exact", qq, g.table, x.id); }
  for (const g of [...r.groups, ...(r.similar||[])]) { let prev = 101; for (const x of g.results) { if (x.pct > prev) { bad++; console.log("PCT RISES", qq, g.table, g.results.map(y=>y.pct).join(",")); } prev = x.pct; if (x.joined) joined++; } }
  // an exact row never sits below a joined semantic row in the same table
  for (const g of r.groups) { const ji = g.results.findIndex(x => x.joined); if (ji >= 0 && g.results.slice(ji).some(x => x.via === "exact")) { bad++; console.log("BURIED", qq, g.table); } }
  console.log(qq, "| rerank", r.stages?.rerank?.ran ? "ran " + r.stages.rerank.ms + "ms" : JSON.stringify(r.stages?.rerank), "| total", r.timings?.totalMs, "ms");
}
console.log("violations:", bad, "joined rows:", joined);
stopAll(); process.exit(bad ? 1 : 0);
