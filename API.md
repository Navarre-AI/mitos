# API

The routes Mitos answers, for people calling it from a script, a FileMaker
web viewer or `Insert from URL`. The site password is the `SITE_PASSWORD`
secret on your Fly app; see the [README](README.md#the-site-password).


Every route needs the site password: a signed-in session cookie, the site
password in the URL (`?key=<site password>`), or HTTP Basic auth (any user
name, the site password as the password). Without one, `/api/` answers 401
`Not signed in.` and pages go to `/signin`.

- `GET /api/search?q=...&limit=5` returns `{ query, kind, searched, plan,
  groups, merged, best, stages, timings }`, or `{ empty: true }` when nothing
  is indexed yet. `kind` is what the input was read as (text, number, range,
  date, daterange, email, phone); `searched` says it in words; each result
  carries `why` and `via` (exact, fuzzy, semantic). `stages.pending` lists
  the model stages still to run. Display data is copied verbatim from source
  rows. GET so a FileMaker web viewer or Insert From URL can call it with
  `?key=` (the site password). Options: `tables=raw,names` limits the search to those
  tables (a per-user filter the FileMaker script can send); `stages=exact,
  fuzzy,semantic,understand,rerank` runs an explicit stage set; `ai=1` runs
  both phases in one response.
- `GET /api/search/ai?q=...` is the second phase: the same result with
  `reading`, `rewritten`, `similar` and `similarMerged` (rows from the
  vector stage, not in the list above), and `best` from the pick stage.
- `GET /api/index/sample?n=20&table=` returns random indexed rows.
- `POST /api/records/changed` with `{ "table": "<raw name>", "id": "<primary key>" }`
  (or `ids` / `deleted` lists, or `{ tables: { "<raw name>": { changed: [ids],
  deleted: [ids] } } }`) refreshes those records right after a commit. It
  answers 202 at once and does the work behind, so FileMaker never waits.
  The kit's "Mitos - Record Changed" script sends it from an OnRecordCommit
  trigger through Perform Script on Server, so no "Transferring URL" shows.
  Unknown tables and records FileMaker no longer has show in the Log tab
  under Record updates. The timed sync still runs as the safety net.
- `POST /api/index/sync` with `{ full: true }` runs the paid passes without
  their per-sync caps. `GET /api/ai/estimate` says what a Run would do and
  cost, and lists past passes. `POST /api/ai/enrich-preview` writes sample
  notes for a few records without saving.
- `POST /api/index/sync` starts a build; `GET /api/index/stream` is the SSE
  progress feed; `POST /api/index/cancel` stops it; `GET /api/index/status`
  shows counts.
- `GET /api/fm/tables` returns the cached scan, or `{ building: true }` while
  a scan runs (`?refresh=1` starts one; `GET /api/fm/scan/progress` reports
  it); `?rename=1` re-runs the naming pass. `POST /api/config` saves the
  table choice. `POST /api/schema/saxml` uploads a Save-a-Copy-as-XML file.
- `GET /api/records/log` lists what the record-by-record route did, newest
  first. `GET /api/about` describes this machine (Settings tab).
- `POST /api/reset` (`items`: any of index, copies, notes, config, keys,
  logs, sessions), `POST /api/tables/drop` (`{ table }`) and `POST
  /api/ai/semantic/off` are the Danger zone's calls.
- `POST /api/click` records the query, the table, the record id, the rank and the score to a JSONL log.
- `GET /api/health`
