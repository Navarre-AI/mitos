# Extending Mitos

Mitos is meant to be forked. It is small on purpose: one runtime dependency,
no build step, a UI in two files, DuckDB as a subprocess. You and an AI
coding tool can read the whole thing in one sitting and change it with
confidence. This doc maps the seams and says where to start for the changes
people want most.

## The principle that must survive every change

**FileMaker is the source of truth, and the exact search never waits for a
model.**

Two halves, both load-bearing:

1. **Nothing shown as record data is generated.** Display values are copied
   verbatim from source rows. A model may write text that is SEARCHED
   (search notes), rewrite a query, or reorder a list. It never writes a
   value a person reads as data. `RULES.md` rule 1 and rule 5.
2. **Phase 1 is deterministic and instant; every stage is optional.** The
   same query on the same index returns the same list, in the same order,
   with a reason per rank. A stage has its own switch, its own model and its
   own time budget; a late or broken stage records an error in `stages` and
   the search still answers. Exact rows are never removed by a stage.
   `RULES.md` rules 2, 2a, 2b.

Break either and Mitos becomes a chatbot that guesses.

## The map

| File | Owns |
|---|---|
| `server.js` | The Express app. Every route, the password gate, the sync job (`startSyncJob`, `jobEmit`, the SSE feed), the crash report, the scan and its field proposal (`buildScan`, `JUNK_FIELD`, `titleRank`), SaXML hints, the model lists (`curateModels`), the search log, auto-sync, boot. |
| `search.js` | `search()`: phase 1 (`runExact`), the balance rule (`balance`, `mergeGroups`), the fuzzy stage, phase 2 (`runAi`, `AI_BUDGET_MS`), the deterministic best-match rule (`deterministicBest`), the reasons (`explain`). |
| `query.js` | `parseQuery()`: the type-detection front door. `describePlan()`: the plan in words. The name table (`nameGroups`). |
| `store.js` | DuckDB. `sql()` and `vsql()` (one queue, one writer), `syncTables` and the streamed page pull with checkpoints, `INDEX_COLUMNS` and the typed columns, `textSearch` (one `case` per kind), `fuzzySearch`, `vectorSearch`, the vector file. |
| `indexer.js` | `buildIndex()`: schema check, pull, `indexOneTable` (source text, typed values, hash diff, upsert), `runStages`, `refreshRecords` for the beacon. The `cMitosJSON` convention. |
| `fm.js` | Every FileMaker call. Nothing else opens a connection. Read `GOTCHAS.md` before editing it. |
| `ai.js` | `PROVIDERS`, `providerOf`, the keys, `chat()` (one door, three providers), `STAGE_DEFAULTS`, `STAGE_LIMITS`, `stages()`, `stageReady()`, `PRICES`. |
| `embed.js` | `embedTexts()` and `embedQuery()`: three providers, batched, retried, unit vectors. |
| `stages.js` | `enrichStage()`, `embedStage()`, `classifyEmbedError()`, the paid-pass ledger. |
| `understand.js`, `rerank.js` | The two search-time model stages, each a prompt, a parser and a cache. |
| `naming.js`, `names.js` | The naming pass and the one display-name map. |
| `public/app.js` | The page: the two-phase fetch with `AbortController`, the result rows, Settings, the stage rows (`stageList`, `wizStages`), the sync overlay, the wizard. |

**Data flow, one search.** Page, 200 ms after the last keystroke, `GET
/api/search?q=` → `parseQuery` → `textSearch` (one DuckDB query, a window
function per table) → `balance` → rows on screen. 500 ms after the words
stand still, `GET /api/search/ai?q=` → `understand` and `embedQuery` start
together → phase 1 runs again on the rewrite → `rerank` on the exact rows
runs beside `vectorSearch` → the page fills in `reading`, `similar`, `best`.

**Data flow, one sync.** `POST /api/index/sync` → `startSyncJob` →
`buildIndex` → `fetchSchema` → `syncTables` (streamed pages into
`tmp/<table>.json`, then one `read_json` load) → `indexOneTable` per table →
`enrichStage` → `embedStage` → `done`. The window only watches.

## Extension recipes

Each names the goal, the seam, and the cost.

### Add a stage

The five stages share one shape, and a sixth follows it.

1. **Config.** Add a block to `STAGE_DEFAULTS` in `ai.js` with `on: false`,
   a `model: ""` if it needs one (a blank model resolves to the fast model
   of the first provider with a key), and its numbers. Add the allowed
   ranges to `STAGE_LIMITS`; `POST /api/config` clamps to them. `stages()`
   and `stageReady()` then know it; `STAGE_NAMES` lists it; the boot line
   prints it.
2. **Where it runs.** A search-time stage goes in `runAi()` in `search.js`:
   give it a place inside `AI_BUDGET_MS` (`left()` says how much is left),
   catch every error into `info.<name> = { ran: true, error }`, and never
   remove an exact row. `activeStages()` decides whether it runs
   (`?stages=` overrides the switches for the eval and the simulator). An
   index-time stage goes in `runStages()` in `indexer.js`, follows
   `enrichStage()` (incremental by a key, capped on a plain sync, stops on
   `shouldStop()` between batches, reports through `onEvent`), and appends
   to the ledger with `appendPass()` when it costs money.
3. **The screen.** `public/app.js` renders one row per stage from the
   server's `stages` with a switch that saves itself, a model picker, a
   "?" help text, and a Test button that calls `POST /api/ai/test` with
   `which=<name>`; add the case there in `server.js`. A stage that costs
   money on a sync goes behind the paid-pass gate (`/api/ai/estimate`).
4. **Say what it is not.** A new stage may add rows below the exact list,
   reorder rows, or annotate them. It may not invent display values.

About a day, most of it in the page.

### Add a provider

`ai.js` decides the provider from the model name (`providerOf`), so a
provider is a name pattern, a key, and a door.

1. `PROVIDERS`: label, the config key, the env variable, `chat` and `embed`
   flags. `providerOf()`: the model-name pattern. `FAST_CHAT`,
   `EMBED_DEFAULT` and `SEMANTIC_FLOOR` if it should be a default.
2. `chat()` in `ai.js`: one branch with a raw `fetch`, a timeout, a JSON
   mode, and an error that carries the status. No SDK.
3. `embedBatch()` in `embed.js` if it embeds, and a `BATCH` size under the
   provider's request limit. Return vectors in input order; `normalize()`
   does the rest.
4. `server.js`: `POST /api/ai/test` needs a cheap authenticated call for
   the key check; `GET /api/ai/models` needs either a live list or a fixed
   list (`GOOGLE_FIXED` is the pattern) and a `modelFamily()` entry so
   `curateModels()` keeps it. `PRICES` for the estimate.
5. `public/app.js`: the provider chip on the AI tab.

Half a day. The key stays in `config.json` like the others; document it in
`SECURITY.md`.

### Add a query kind

The type decides the fields (`RULES.md` 2a), so a kind is a parser branch, a
typed column, and a `case` in the search.

1. **Parse.** A branch in `parseQuery()` in `query.js`, tested in the order
   the file comments give, returning `{ kind, ... }`. A line in
   `describePlan()` so the page can say "read as".
2. **Index.** If the kind needs its own column, add it to `INDEX_COLUMNS`
   in `store.js` and fill it in `indexOneTable()` in `indexer.js`, where the
   column type of the field decides (a number field gives `nums`, a date
   field gives `dates`); never guess a type from text at search time.
   `ensureIndexTable()` drops an index that lacks the typed columns; a new
   column means every row is rewritten on the next sync, by design.
3. **Search.** A `case` in `textSearch()` in `store.js`: a `where`, a
   `score`, the `hits` list the reasons come from, and the `order` within
   equal scores. Then a branch in `explain()` in `search.js` so each hit
   says why in words.
4. **Prove it.** A case in `eval/cases.json` with the `kind`, the record,
   and the `notTables` that must not be searched. Teach the `understand`
   prompt the new syntax if a person should be able to say it in words.

The `month:3` kind (a month in any year) is the worked example: one branch
in `query.js`, one `case` in `store.js`, one line in the prompt.

### Teach the search a name

No code. `names.config.js` is the name table; `data/names.json` as an array
of arrays replaces it. Keep entries lower case.

### Change what a record means

No code either. A `cMitosJSON` calculation on the table decides its search
text and its display (`filemaker/cMitosJSON.md`). Related data, a parent
name, a list of child items: anything a calculation can reach.

### Write back to FileMaker

Not built, on purpose. Mitos reads. If you add it: the Data API creates,
updates and deletes records, and FileMaker's `Execute FileMaker Data API`
script step does the same inside a script. Put the call in `fm.js` next to
the reads, behind a new route, with a confirm step in the UI and a separate
account that has write privilege. Never the read-only account.

## The eval cases

`eval/cases.json` is the machine form; `eval/_search_test_cases.md` is the
same list for reading. One case:

```json
{ "section": "dates", "query": "3/2019", "kind": "date",
  "table": "people", "expectAny": ["Matt Navarre"],
  "notTables": ["products"], "why": "a month" }
```

`section` groups the report; `kind` is what the front door must detect;
`table` and `expectAny` name the record that must appear in that table's
results; `notTables` lists the tables that must NOT be searched; `why` is
for the reader. A case passes at rank N when any `expectAny` string appears
in the expected table's results within the top N.

To add one: pick a record from `sample-data/`, write the case, run the
server, `npm run eval`. Exit 2 means a kind or a table check failed. The
cases run against the bundled sample, so a case needs a sample record; add
one to the CSV if the shape you are proving does not exist yet.

For behavior on real data and for the model stages, `npm run simulate --
--base <url> --key <key> --compare "exact,fuzzy"
"exact,fuzzy,semantic,understand,rerank" --ai` on a running instance. The
report lands in `eval/sim-*.md`. Read the misses before trusting the number;
the handoff notes explain which "misses" are duplicate titles.

## Working style

- **Run the eval.** `npm run eval` before and after. A changed line in its
  output is the point.
- **Prefer a new file over a new dependency.** Express is the one runtime
  dependency. DuckDB stays a subprocess. AI providers stay raw fetch.
- **Keep the UI in its two files.** No framework, no bundler.
- **Keep FileMaker inside `fm.js`.** Every quirk it handles is a real server
  that did not work until that code existed. Move a quirk, do not delete
  it. `GOTCHAS.md` says where each one is handled.
- **Say what a thing is not.** A stage, a kind or a provider that promises
  more than it does costs the next person a day.
- **Read `SECURITY.md` before touching auth or a provider call.** It lists
  what leaves the machine and when; keep it true.

License: see `LICENSE`. Attribution required, no resale without permission.
© 2026 Navarre AI (Fermata Software LLC), created by Matt Navarre
(www.navarre.ai).
