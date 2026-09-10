# Mitos, explained to an AI agent

You are probably an AI coding agent. Someone wants Mitos installed, run,
tested, or changed. Read this first; it is written for you.

## What this is

A search sidecar for FileMaker. One search field, any table, the right
record. Mitos copies the fields a person chooses into a local DuckDB index
and answers with deterministic, type-aware search. Five optional AI stages
sit on top, each with its own switch. FileMaker is the source of truth;
nothing a person reads as record data is generated (`RULES.md`).

Node 20 or later, ESM, one npm dependency (express). DuckDB runs as a CLI
subprocess, not a native module. AI providers are called with raw fetch, no
SDK. The UI is two files, `public/index.html` and `public/app.js`, with no
build step.

What it is not: a chatbot, a report tool (that is Pythia), or a log service
(that is Clio). It never writes to FileMaker.

## How to behave

- **Fewest commands.** Every command may cost the person an approval. The
  Fly install is one script run as one command. Do not re-implement its
  steps. Do not check for tools the script installs itself.
- **Never probe the FileMaker server.** Use exactly the host, account and
  password the person gives you. Do not enumerate file names or try
  credentials you were not given.
- **Never invent the Fly app name.** The app is theirs. Do not default to
  "mitos", "navarre" or a name taken from this repo.
- **Never commit or print secrets.** `.env`, `data/` and `fly.toml` are
  gitignored. Keep them that way. Do not echo keys or passwords.
- **No deploy unless the person says so.** A past deploy is not standing
  permission. `fly deploy` only on an explicit instruction, each time.
- **On failure, diagnose.** `TROUBLESHOOTING.md` lists the real failures and
  their fixes. Do not loop the same failing command.

## Install for a person (Fly.io, one command)

Mac or Linux:

```bash
curl -fsSL https://navarre.ai/get/mitos | sh
```

Windows, plain PowerShell:

```powershell
irm https://navarre.ai/get/mitos.ps1 | iex
```

`README.md` says the installer installs the Fly CLI if needed, asks for a
name and a region, builds Mitos in Fly's cloud, and opens the browser with
the site password. The installer script itself is not in this repo, so its
flags are unverified here. What this repo does show:

- `fly.template.toml` is the shape of the `fly.toml` it writes: the app
  name, the region, a `shared-cpu-1x` machine with 512 MB, a volume named
  `mitos_data` mounted at `/data`, `force_https`, and
  `auto_stop_machines = "suspend"` with `min_machines_running = 0`.
- The site password is read from the `SITE_PASSWORD` environment variable
  (`server.js`). With it set, every request needs `?key=<password>`, the
  cookie that `?key=` drops, or HTTP Basic auth.
- `Dockerfile` builds from `node:20-slim` and installs the DuckDB CLI 1.5.3.

Everything after the install happens in the browser: an eight-step wizard
(Connect, Files, AI key, Scan, Tables, AI stages, Sync, Add to your file).
The same steps live in Settings afterwards.

Before connecting, the person's FileMaker Server needs OData on (Admin
Console, Connectors) and an account whose privilege set has the `fmodata`
extended privilege in each file to search. `README.md` also names the Data
API and `fmrest`. Use a read-only account.

## Run it locally (sample mode, no FileMaker, no key)

```bash
npm install     # postinstall fetches the DuckDB CLI into ./bin (Mac, Linux)
npm start       # http://localhost:8080
```

Then press **Sync now** in the browser, or `POST /api/index/sync`. The
bundled sample is fictional: 200 people, 60 organizations, 28 products
(`sample-data/`). Windows: install DuckDB yourself; the postinstall script
says so and does not fail.

Facts that matter when you run it:

- `env.js` loads `.env` with OVERRIDE semantics: a value in `.env` beats the
  shell. If the shell exports `FM_HOST`, `FM_USER` or `FM_PASS`, put blank
  values for them in `.env` to get sample mode. Sample mode is "no host,
  user and password", nothing else.
- `DATA_DIR=<dir>` moves every data file (the index, the config, the logs).
  Use a scratch directory for experiments. `PORT` sets the port (8080).
- Boot never syncs. Boot prints four lines: the URL, `fm: configured` or
  `not configured (sample mode)`, the naming model and key source, and one
  `on`/`off`/`on, no <provider> key` per stage. An empty index prints
  `index is empty. Open Settings, choose tables, and press Sync now.`
- With no AI key everything deterministic works: the exact search, the
  fuzzy stage, the name table. Tables are named by a heuristic.

## Test it

There is no unit test suite. `npm test` does not exist. The checks are:

- `npm run eval`: runs the 29 cases in `eval/cases.json` against a running
  server (`MITOS_URL`, `SITE_PASSWORD` when set). Each case names the query,
  the kind the front door must detect, the table and record that must
  appear, and the tables that must NOT appear. Prints PASS, `@N`, MISS or
  ERR per case and hit@1 / hit@3 per section. Exit code 2 on any error.
  The last recorded result is 28 of 29 at hit@1 (`HANDOFF-2026-09-09.md`,
  not re-run for this document).
- `npm run simulate -- --base http://localhost:8080`: samples rows from a
  running server, generates the queries a lazy person types (one word, a
  typo, "Last, First", a phone tail, a price range), runs them, and writes
  `eval/sim-<timestamp>.json` and `.md`. `--compare "exact,fuzzy"
  "exact,fuzzy,semantic,understand,rerank" --ai` diffs two stage sets.
  `--selftest` needs no server. `--dry-run` prints the queries only.
  `--concurrency` above 4 measures the DuckDB queue, not the search.
- `node scripts/check-order.mjs`: proves the one display-name map. Prints
  PASS or FAIL.
- `curl "$URL/api/health?key=$KEY"` for liveness.

## The API, one line each

All routes sit behind the site password. `GET` routes work from a FileMaker
web viewer or `Insert from URL` with `?key=<password>`.

| Route | What it does |
|---|---|
| `GET /api/health` | Liveness. |
| `GET /api/search?q=` | Phase 1: exact and fuzzy, instant. `limit`, `tables=raw,names`, `stages=...`, `ai=1` runs both phases. |
| `GET /api/search/ai?q=` | Phase 2: the model stages; returns the whole result again with `reading`, `rewritten`, `similar`, `best`. |
| `GET /api/index/sample?n=&table=` | Random indexed rows (display values). |
| `POST /api/index/sync` | Start a sync job. `{ full: true }` runs the paid passes past their caps; `{ stagesOnly: true }` runs only the stages. |
| `GET /api/index/stream?since=` | SSE progress feed with replay. |
| `GET /api/index/job` | The current or last job and its events. |
| `POST /api/index/cancel` | Stop the running job. A table is kept whole or not at all. |
| `GET /api/index/status` | Counts, version, manifest, last crash. |
| `POST /api/index/crash/ack` | Clear the crash report. |
| `POST /api/records/changed` | Record-by-record refresh (not used in 1.0; records update on the timed sync): `{ tables: { "<raw>": { changed: [ids], deleted: [ids] } } }`. 202 while a sync runs. |
| `GET /api/config` / `POST /api/config` | Read or save the connection, table choice, display names, table words, sync interval, date format, AI keys and stage switches. A new login is tested before it is saved. |
| `POST /api/fm/test` | Test a connection without saving it. |
| `GET /api/fm/tables` | The cached scan, or `{ building: true }`. `?refresh=1` rescans; `?rename=1` re-runs the naming pass. |
| `GET /api/fm/scan/progress` | One line of scan progress. |
| `POST /api/schema/saxml` | Upload a Save a Copy as XML export (hints: real names, keys, mod fields, stored calcs). |
| `GET` / `DELETE /api/schema/hints[/:file]` | Read or forget those hints. |
| `GET /api/disk` | Free bytes on the data volume. |
| `GET /api/ai/models` | Curated model lists per provider with a key. `?refresh=1`. |
| `POST /api/ai/test` | Prove a key, or run one stage once and time it (`which`: naming, understand, semantic, rerank, enrich). |
| `GET /api/ai/estimate` | What a paid Run would do and cost, plus the ledger of past passes. |
| `POST /api/ai/enrich-preview` | Sample search notes for a few records, nothing saved. |
| `POST /api/ai/enrich/forget` | Delete a table's search notes on purpose. |
| `POST /api/click` | Record which result a person clicked. |
| `GET /api/log?limit=` | Recent searches paired with their clicks. |

The search response: `{ query, kind, searched, plan, groups, merged, best,
stages, timings }`, or `{ empty: true }` when nothing is indexed. Every hit
carries `why` (words) and `via` (exact, fuzzy, semantic).

## The file map

| File | Owns |
|---|---|
| `server.js` | The Express app: every route, the password gate, the sync job and its SSE feed, the crash report, the scan and the field proposal, SaXML hints, model lists, the search log, auto-sync, boot. |
| `search.js` | The two-phase search: the front door, the balance rule (no table floods the list), the fuzzy stage, the AI phase with its 6 s budget, the deterministic best-match rule. |
| `query.js` | The type-detection front door: number, range, date, date range, month, email, phone, text. No model. |
| `store.js` | DuckDB: the local copy of each table, the `mitos_index` table with typed columns, the streamed page pull with checkpoints, `textSearch`, `fuzzySearch`, `vectorSearch`, the vector file. |
| `indexer.js` | The index pipeline: schema check, sync, per-record source text, hash diff, upsert, the beacon's per-record refresh, then the stages. |
| `fm.js` | All FileMaker I/O. OData discovery, `$metadata`, counts, adaptive paging, the quoted `$select` and its fallbacks. Read `GOTCHAS.md` first. |
| `ai.js` | The one door for chat calls, the four providers and their keys, the stage defaults, limits and readiness, prices. |
| `embed.js` | Text in, unit vectors out, for OpenAI, Google and Voyage. |
| `stages.js` | The two index-time stages: enrichment (search notes) and embedding, incremental, capped, with the paid-pass ledger. |
| `understand.js` | The query-understanding stage: a fast model rewrites words into the engine's syntax. Cached on disk. |
| `rerank.js` | The decision stage: reorders the short list and may name one best match. |
| `naming.js` | The schema naming pass (one call per schema, cached) and its heuristic fallback. |
| `names.js` | The one display-name map, in order of trust. |
| `names.config.js` | The name table (Bob finds Robert). `data/names.json` replaces it. |
| `tables.config.js` | The table config for the sample data; a real install writes the same shape to `data/config.json`. |
| `saxml.js` | Reader for a Save a Copy as XML export. Hints only. |
| `env.js` | `.env` loader with override semantics. |
| `public/index.html`, `public/app.js` | The whole UI: search, the card window (`?embed=1`), Settings (`?settings=1`), the wizard, the sync overlay. |
| `filemaker/` | The FileMaker side: the kit file, the search and go-to-record scripts, `cMitosJSON.md`. |
| `scripts/` | `eval.mjs`, `simulate.mjs`, `check-order.mjs`, `fetch-duckdb.mjs`. |
| `eval/` | `cases.json`, its readable twin, and simulator reports. |
| `sample-data/` | The fictional CSVs. |

## The rules and the gotchas

`RULES.md` is the contract. In short: FileMaker is the source of truth and
nothing shown as data is generated (1); search is deterministic with a
reason per rank (2); the type decides the fields (2a); the AI stages are
optional, independent and never in the way (2b); unchanged rows cost
nothing (3); results are balanced across tables (4); no plumbing on screen
(5); fewest moving parts (6); nothing runs unasked, boot never syncs (7);
cancel is immediate (8); an empty index is a setup state (9). Keep every
change inside them.

`GOTCHAS.md` is the list of FileMaker, OData, DuckDB and Fly behaviors this
code guards against, each with its symptom and where it is handled. Read it
before touching `fm.js` or `store.js`. The defensive code there looks odd
until you have met the server that needed it.

## Change it

`EXTENDING.md` maps the seams: a stage, a provider, a query kind, an eval
case. Keep Express as the only dependency, keep the UI in its two files, and
keep every FileMaker call inside `fm.js`.
