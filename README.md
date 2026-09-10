# Mitos

**The thread through your database. One field, any table, the right record.**

Search for FileMaker. Named for Ariadne's thread: one thin line through a
tangled structure, straight to the thing at the center.

Point Mitos at a FileMaker Server over OData, choose the tables and fields to
search, and give your users a single search field that finds the right record
in any table. Results are balanced across tables: search "Canon" and you get
Canon cameras from Products, Canonical Systems from Companies, and Mary Cannon
from People, without one table drowning out the others.

Sibling of [Pythia](https://github.com/Navarre-AI/pythia) (reports) and
[Clio](https://github.com/Navarre-AI/clio) (logs). Runs in your own cloud account, on your bill, under your
control.

## How search works (deterministic and type-aware first)

Mitos reads the whole input first and decides what kind of thing it is. Then
it searches only the fields where that kind of thing can live. This is the
front door the original fmSearchResults had, and it is the reason a number
does not drown in text hits.

| You type | Read as | Searched where |
|---|---|---|
| `Murphy`, `matt nav` | words | every word must start a word in the record |
| `"cardiac clinic"` | a phrase | the words, in that order |
| `=matt`, `*arre` | whole word, contains | text |
| `Bob Whitfield` | words, with the name table | `bob` also matches `robert`, `rob`, `bobby` |
| `45`, `$5,000` | a number | number fields (exact), plus the text as a whole word |
| `100...200`, `>100`, `<=45` | a number range | number fields |
| `1/15/2026`, `15.1.2026`, `2026-01-15` | a date | date fields |
| `1/2026` | a month | date fields |
| `1/1/2026...3/31/2026`, `>1/1/2026` | a date range | date fields |
| `2019` | a number, or a year | number fields, and dates in 2019 |
| `matt.navarre@` | an email | email values |
| `773-9565`, `+11 629 773 9565` | a phone | phone digits (the end of a number matches) |

Text is normalized on both sides (lower case, accents stripped, punctuation
ignored), so `Navarré` finds `navarre`. A word scores higher as a whole word
than as a word start, and highest in the record's title (the first display
field). Ties break on title length and record id, so the same query always
returns the same list, and every hit carries a reason in words: `bob as
robert in the title`, `number 65 in range`, `phone ends with it`.

Day and month order follows the **Date format** setting (month first by
default). When one part cannot be a month, the data decides.

The name table ships with common English nicknames plus some Greek and other
European forms (`names.config.js`). Write `data/names.json` as an array of
arrays to replace it.

## The stages (five switches on top of the exact search)

The exact search above always runs first and shows at once. Five stages sit
on top of it, each with its own switch on the AI tab in Settings, its own
model and time budget, and each can be off while the others run. A stage
that is late or broken records an error in the response's `stages` and the
search still answers.

| Stage | What it does | Model | When it runs |
|---|---|---|---|
| Close spellings | Jaro-Winkler on record names: `Murpy`, `whitfeild`, `Ac me systems`, `bob whitfeld` (the name table applies) | none | with the exact search, in about 20 ms |
| Similar meaning | A vector per record; `mid-range digital SLR` lists the cameras below the exact hits under "Similar" | an embedding model: OpenAI text-embedding-3, Gemini, or Voyage | vectors are built during sync; the query is embedded at search time and cached |
| Search notes | During sync, a fast model writes notes per record: other spellings, `Last, First`, nicknames, plain words for what it is. Searched, never shown; a hit through them says "in the search notes" | a fast chat model, ten records per call | at sync, only for rows without notes, per table (switch and prompt on the Tables tab), capped per sync |
| Read the search | `people with birthdays in the first half of May` becomes `5/1/2026...5/15/2026`; `inv 2216` becomes `2216`; `someone named bob whitfeld or something` becomes `bob whitfeld`. The rewrite runs through the exact search again, so every hit still has a reason | a fast chat model | only for two or more words; skipped for one word, a number, a date, an email, a phone |
| Pick the best | Reorders the short list and names one best match when it is sure, shown on top as "Best match". Below the confidence floor the list is the answer. Without this stage, one clear answer is still named when exactly one record carries every word in its name | a fast chat model | only for word searches with two or more candidates |

The page shows the exact list in tens of milliseconds, then asks for the AI
phase once the words stand still, and fills it in behind: a "read as" line,
the "Semantic matches" section (or "Perhaps you meant" when even the best
is weak; semantic search always shows its nearest rows), the best match on
top with its reason. A FileMaker card window does the same, with the words
still in the field to edit.

Two screens: the plain page is the search with one Settings button;
`?settings=1` opens Settings with the search behind it as a test;
`?embed=1&q=...` is the card window. Escape backs out of Settings one level
at a time. Light or dark follows the system, with a switch bottom right.

**Paid passes are a formal step.** Switching Semantic search on shows the
record count and the price first, then Run now or Later. Switching
Enrichment on opens a window: the model, the rules, the tables, a live
preview of the notes on two records per table, the price, then Run now or
Later. A plain sync stays under a quiet cap (5,000 vectors, 1,000 notes);
the rest waits for Run on the AI tab, which shows what is waiting and a
ledger of what has run. Every stage row has a "?" that explains it in full.

Every stage's model defaults to the cheapest current model of the first
provider with a key (Claude Haiku, then GPT, then Gemini; embeddings: Gemini,
then Voyage, then OpenAI). Keys for four providers live on the AI tab.

The one other AI call is the schema naming pass at scan time (D_Org~B becomes
Organization), and it is optional too.

Measured on the bundled sample (100 simulated searches, `npm run simulate`):
the exact search alone finds the right record first 76% of the time and in
the top five 88%; with every stage on, 85% and 98%. The natural-language
searches go from 0% to 67-100%. The exact phase answers in about 60 ms; the
AI phase adds one to three seconds with Haiku.

## Install (one line)

Mitos runs on Fly.io, in your own account. Mac, in Terminal:

```bash
curl -fsSL https://navarre.ai/get/mitos | sh
```

Windows, in PowerShell (no WSL):

```powershell
irm https://navarre.ai/get/mitos.ps1 | iex
```

It installs the Fly CLI if needed, asks for a name and a region, builds Mitos
in the cloud, and opens it in your browser with its password. Nothing is left
on your machine but Fly's own tool. The setup screens do the rest. The whole
walk-through, with the FileMaker side: https://navarre.ai/mitos/start

## Before you install

- On FileMaker Server, turn on **OData** and the **Data API** (Admin Console,
  Connectors).
- In each file, make a **read-only account** for Mitos with a privilege set
  that has only `fmodata` and `fmrest` (Extended Privileges). Nothing else.
- Create a **Fly.io** account. Mitos runs there as one small machine.
- Get **one API key**. A Google AI key covers everything (naming, the search
  stages and semantic search). A Claude or OpenAI key covers everything but
  embeddings; add a Google or Voyage key for those.

## Run it on your own machine (no FileMaker required)

Ships with a fictional sample dataset (200 people, 60 organizations, 28
products).

```
cp .env.example .env     # optional: ANTHROPIC_API_KEY for table naming
npm install              # postinstall fetches the DuckDB CLI into ./bin
npm start
open http://localhost:8080
```

Press **Sync now**, then try `Murphy`, `Bob Whitfield`, `40...70`, `3/2019`,
`matt.navarre@`, `773-9565`, `Murpy`. With a key on the AI tab, switch the
stages on and try `someone named bob whitfeld or something`, `people since
2019`, `cheap shoes`. Then run `npm run eval`, and `npm run simulate --
--compare "exact,fuzzy" "exact,fuzzy,semantic,understand,rerank" --ai` to
measure the stages against each other on a few hundred simulated searches.

## Connecting FileMaker

The first run opens an eight-step setup, one screen each: **Connect**
(server and the read-only login, tested before it is saved), **Files** (the
ones that login can open, one or more), **AI key** (checked the moment you
paste it; it names your tables), **Scan** (reads tables, fields and record
counts, with progress you can watch; no data is copied), **Tables** (the
ones worth searching are pre-checked; Select all and Deselect all), **AI
stages** (the five switches, before any sync), **Sync**, then **Add to your
file** (the kit file and the page that walks the FileMaker side). The same
steps live in Settings afterwards.

The scan runs on the server and reports progress; the window polls it, so a
slow FileMaker Server never leaves a blank screen. For each table Mitos
proposes a primary key, the search fields (text, number and date fields), and
the display fields. Summary fields, globals, and calculations that are not
known to store their result are left out from the metadata alone; a small
sample of rows from the tables worth searching then drops JSON blobs, UUIDs
and very long text.

**Save a Copy as XML** (optional, recommended): OData cannot tell Mitos a
table's real name, its primary key, its modification-timestamp field, or
which calculations are stored. A `File > Save a Copy As > XML` export can.
Upload it on the Data Sources tab and rescan.

The primary key must be a real, findable field: Mitos hands it back to
FileMaker, where a script does an ordinary Find on it (see `filemaker/`). A
table can instead expose one `cMitosJSON` calculation field that decides what
a record means; see [filemaker/cMitosJSON.md](filemaker/cMitosJSON.md).

Sync is a modal that watches a server-side job: reload the page mid-sync and
it reattaches. Tables sync A to Z by display name, incrementally where the
table has a primary key and a modification timestamp. A record deleted in
FileMaker is noticed by a record count check on each sync and removed from
the copy and the index.

## API

- `GET /api/search?q=...&limit=5` returns `{ query, kind, searched, plan,
  groups, merged, best, stages, timings }`, or `{ empty: true }` when nothing
  is indexed yet. `kind` is what the input was read as (text, number, range,
  date, daterange, email, phone); `searched` says it in words; each result
  carries `why` and `via` (exact, fuzzy, semantic). `stages.pending` lists
  the model stages still to run. Display data is copied verbatim from source
  rows. GET so a FileMaker web viewer or Insert From URL can call it with
  `?key=<password>`. Options: `tables=raw,names` limits the search to those
  tables (a per-user filter the FileMaker script can send); `stages=exact,
  fuzzy,semantic,understand,rerank` runs an explicit stage set; `ai=1` runs
  both phases in one response.
- `GET /api/search/ai?q=...` is the second phase: the same result with
  `reading`, `rewritten`, `similar` and `similarMerged` (rows from the
  vector stage, not in the list above), and `best` from the pick stage.
- `GET /api/index/sample?n=20&table=` returns random indexed rows.
- `POST /api/records/changed` with `{ tables: { "<raw name>": { changed:
  [ids], deleted: [ids] } } }` pulls those records by primary key, indexes
  them and runs the stages on them. Not used in 1.0, where records update
  on the timed sync; kept for a later record-by-record path. 202 while a
  sync runs.
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
- `POST /api/click` records the query, the table, the record id, the rank and the score to a JSONL log.
- `GET /api/health`

## How indexing works

Sync (OData, incremental by modification timestamp) or sample load, then per
table: build a "field: value" text from the search fields, hash it with the
display values, skip every record whose hash is unchanged, and upsert the
rest into a flat DuckDB table. Beside the normalized text, each row carries
typed columns: the record's numbers, its dates, its email values, and the
digits of its phone values. The column type decides (a FileMaker number
field arrives as a number, a date field as a date); with `cMitosJSON` the
value itself is read. Search is one query over that table with a window
function per table, which is plenty at sidecar scale (tens of thousands of
rows answer in tens of milliseconds).

Cancel is honored between pages of a pull and between tables, and it aborts
the OData request in flight. A table is kept whole or not at all.

With the semantic stage on, a second file, `data/mitos-vec.duckdb`, holds
one vector per index row (256 numbers by default). It is built at the end of
a sync, only for rows without a current vector, and it is deleted and
rebuilt when the model or the size changes. Deleting it by hand is the
reset: the next sync rebuilds it.

## Rules

FileMaker is the source of truth. Zero hallucination on data: nothing a user
reads as record data is generated. See RULES.md.

## More

- [AGENTS.md](AGENTS.md): how an AI agent installs, runs, tests and extends Mitos.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md): the failures people hit, with the exact words Mitos prints.
- [SECURITY.md](SECURITY.md): what Mitos stores, where, who can read it, what leaves and when.
- [EXTENDING.md](EXTENDING.md): a stage, a provider, a query kind, an eval case.
- [CHANGELOG.md](CHANGELOG.md), [GOTCHAS.md](GOTCHAS.md), [RULES.md](RULES.md), [filemaker/README.md](filemaker/README.md).
