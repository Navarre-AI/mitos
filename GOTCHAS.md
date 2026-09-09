# Gotchas

Hard-won platform quirks and their fixes. Each entry: symptom, cause, where it's
handled. Add to this file the moment a quirk costs you more than ten minutes;
future you (and any AI session working on this code) reads this before fm.js.

Client-specific facts (accounts, file lists, credentials) do NOT belong here.
They live in each deployment's NOTES.md, outside this repo.

## FileMaker OData

**External-file TOs are CONDITIONALLY visible.** A TO whose base table lives in
another file is served over OData ONLY when the account can also open that other
file with fmodata there. While the target file lacks access, the TO is silently
omitted from the entity list and querying it returns -1020 "Table not defined" —
so a hub file's exposure GROWS as satellite files gain the privilege (verified:
New-file entity list went 111 → 145 sets the moment satellites came online). The
Data API serves layouts on external TOs regardless, so a solution can look
connected via Data API while OData can't see the data. Two consequences: every
file where data lives needs the account + fmodata even if you only ever query the
hub, and the same base table then surfaces in EVERY file that TOs it — dedup by
full field name:type signature, keep the copy with the most occurrences (handled
in `fetchSchema()`, fm.js). (Not in Claris docs; verified on FMS 26.0.1, 2026-07.)

**Service root = discovery.** `GET /fmi/odata/v4` (Basic auth) lists exactly the
files this account can reach with fmodata. Files missing the account, or missing
the extended privilege, simply don't appear. Handled: `listDatabases()` in fm.js.

**Spaced entity names may need DOUBLE-encoding.** Some deployments (seen on FMS 26
behind nginx) decode the URL path once before the OData parser sees it, so
`/Master%20ID` arrives as a raw space and fails with -1002 "syntax error in URL",
even though the server's own service document advertises the %20 URLs. Those
servers want `%2520`. Other servers want plain %20. The database path segment is
fine single-encoded on both, and so are query strings ($filter). Handled:
`odataGetEntity()` in fm.js detects the -1002 signature once per boot and flips
to double-encoding; occurrence lists sort space-free names first to dodge it.

**`/$count` needs `Accept: */*`.** FMS OData returns 406 "Unexpected internal
OData Provider error" for `/$count` with an explicit `text/plain` accept header.
Handled: `fetchCounts()` in fm.js.

**`$select` support is HOST-DEPENDENT.** Some FMS builds fail to parse
`$select`; a client file's FMS 21 host accepts it (verified live 2026-07-17). Currently
we always fetch all fields and drop unwanted columns client-side
(`fetchAllRows()` `keep` in fm.js). Queued: probe once per boot and use $select
where supported — skips server-side evaluation of unstored calcs/summaries
during sync (a client file: 516 calc fields, 181 summaries).

**Fractional numbers without a leading zero.** FileMaker serializes values in
(-1,1) as `.5` / `-.06`, which is invalid JSON and breaks `res.json()`. Handled:
`parseODataJson()` in fm.js repairs number tokens in value position.

**Raw control characters in row JSON.** FM's OData serializer passes control
characters sitting in field data (tabs, vertical tabs, stray \r pasted into a
field years ago) straight into JSON string literals unescaped; strict JSON.parse
throws "Bad control character in string literal in JSON at position N". Seen on
a client file's first real sync, mid-page of a 1,000-row pull, after one table had
already synced clean. Same disease breaks their Save-as-XML export (control
chars in script comments) — it's FM trusting field bytes, not an OData-only bug.
Handled: `parseODataJson()` in fm.js — on parse failure, re-walk the text and
\u-escape control chars INSIDE string literals only (structural whitespace
between tokens must stay raw). Escape, don't strip: the bytes are client data.
(Verified on FMS 21, 2026-07-17.)

**Failed calcs serialize as a bare `?` in JSON.** When an unstored calc errors
during OData evaluation (`"cRate": ?` on a client file's Species Data — every page),
FMS writes the layout-style error marker straight into the JSON, which is a
syntax error ("Unexpected token '?'"). Killed the sync at table 19/23. Handled:
`parseODataJson()`/`repairODataText()` in fm.js — string-aware walk replaces
`?` tokens OUTSIDE string literals with null (a bare ? is never legal JSON, so
data can't be touched). Same walk escapes in-string control chars and repairs
zero-less fractions. (Verified on FMS 21, 2026-07-17.)

**TO names containing `?` or `~` are unqueryable.** The FMS URL parser 400s with
-1002 "syntax error in URL" on any entity path containing them, encoded or not
(%3F/%7E decode before the parser sees them). Such TOs exist in real files
(`?HAR_Item_Company~Mill`, `CO_Load~hauler`). Handled: occurrence sort in
`fetchSchemaForDb()` puts `?`/`~`-free names first, so `occurrences[0]` — the
$count and sync target — is always a clean name. (Verified on FMS 21, 2026-07-17.)

**`$filter` encoding.** Encode spaces only; colons, dashes, T and Z in ISO
timestamps must stay raw or the parser chokes. Handled: `fetchAllRows()` in fm.js.

**Base-table names are not exposed — anywhere.** $metadata EntityType names are
TO names, and on FMS 21 hosts there are NO com.filemaker.odata annotations for
TableID/FieldID/FMComment at all (FMS 26 hosts do emit them); FileMaker_Tables /
FileMaker_Fields 404 with -1020. The real base-table name exists only inside the
file (Manage Database / Save-as-XML). Handled: FMFID high-word grouping where
annotations exist, field name:type signature grouping where not, then
word-boundary `baseName()` for the derived name and the AI displayName pass on
top (fm.js, server.js — fixed 2026-07-17, validated against a client file's
Save-as-XML). A client's XML export is a validation artifact, never a runtime
dependency.

**Base-table FILE ownership is not exposed — at all.** In a multi-file solution
there is no runtime way to tell which file a base table lives in. Verified dead
ends (FMS 26, 2026-07): FieldID/TableID annotations absent server-wide;
FileMaker_Tables / FileMaker_Fields system tables -1020 over OData; AutoGenerated,
BestRowID, RowVersion, VersionID, Global, MaxRepetitions annotations identical on
the home file's view and every borrowing file's view; Key/nav structure uniform.
Occurrence counts mislead (a hub UI file TOs everything, so it looks like the
home of every table). Consequence: homing a merged table to its real file needs
knowledge from outside OData — AI inference over file/occurrence names with a
user override, or a client-side helper. Display-only concern: any exposed TO
serves identical rows, so sync correctness never depends on the guess.

## FileMaker Data API

**Layouts cannot be created via any API.** Pythia can only detect and report a
missing layout; a human adds it in Pro. Comment in fm.js above `dataApiLayouts()`.

**Per-file auth.** Data API and OData both authenticate against each file
independently. One account name across files is only "one account" if the
password matches in every file.

## DuckDB

**One writer, exclusive lock.** Each `sql()` call is a fresh duckdb CLI process;
a writer holds an exclusive file lock and any concurrent reader dies with
"Conflicting lock". Handled: all calls serialize through one in-process queue
plus retry, in cube.js.

## Environment

**`.env` OVERRIDES ambient env vars** (opposite of Node's `--env-file`). Dev
machines here export ambient FM_* vars, so the repo's .env must
win. Consequence: to run this code against a different server than .env points
at, move .env aside; inline `FM_HOST=... node ...` will NOT beat it. See env.js.

## `$select=ID` is a syntax error to FileMaker's OData parser (2026-09-08)

Two bugs hid behind one six-minute Org pull. First, fetchAllRows only sent
`$select` when every field name matched `^[A-Za-z_][A-Za-z0-9_]*$`, so a
spaced name (`Total Invoiced`) silently dropped the whole field list.
Second, and the real one: FileMaker Server 2026 answers `$select=ID` with
`-1002 parse failure in URL at: 'ID'` (a bare field named ID trips its URL
grammar; `Name`, `RecordID`, `Name,IsVisible` are fine), and the old code
took any -1002 as "this host cannot do $select" and read WHOLE ROWS for
every table with an ID field, which is every table here. Whole rows means
every unstored calculation and summary evaluated per record: Org (10,511
rows, 33 fields, 7 unstored calcs including a cosine similarity) took six
minutes. QUOTED names fix it: `$select=%22ID%22,%22Customer%20Summary%22`
returns 200 with the right keys (verified 2026-09-08 against
a FileMaker Server 2026 host; inside the quotes a spaced name is single-encoded, %2520 gets
8309). With the field list honored the same Org pull takes 8.5 seconds.
Field names now go out quoted, double-encoded on one retry (for the server
family that decodes twice), and whole rows are the fallback only after BOTH
forms are refused; the sync log then says so with the server's message.
The other symptom to know: a change to a table's field picks changes its
column set, and a changed column set is a schema change, so the next sync
is a full pull of that table by design.

## `read_json(maximum_object_size=N)` allocates a 2N buffer

A load with `maximum_object_size=268435456` (256 MiB) made DuckDB ask for
512 MiB in one piece and die under the 174 MB ceiling on the 512 MB demo
box ("failed to allocate data of size 512.0 MiB", 2026-09-08). The value is
per JSON object, and a row is a few kilobytes, so every load uses 16 MiB.
Related: an UPDATE of a FLOAT[512] array column across 95,000 rows is also
too big for that box; vectors live in their own table (mitos_vec) and are
written by delete-and-insert, 500 rows at a time. The write path runs
under `SET memory_limit` (40% of the machine) so a big load spills to
disk instead of getting the process killed.

## Every DuckDB call queues behind the others

Reads too. A search is up to four DuckDB processes (stats, exact, fuzzy,
vector), so four searches at once are sixteen queued processes. The stats
call is cached ten seconds in search.js for that reason. The simulator's
`--concurrency` above 4 measures the queue, not the search.

## DuckDB 1.3+ prints a lambda deprecation WARNING into stdout

`list_filter(xs, x -> x > 1)` still runs, but DuckDB 1.3 and later write a
colored `WARNING: Deprecated lambda arrow (->)` block to stdout BEFORE the
JSON. store.js parses stdout as JSON, so every query with an arrow lambda
failed with "Bad DuckDB output". Use the new form: `lambda x: x > 1`. Any
future DuckDB deprecation will show up the same way; if a query dies with
"Bad DuckDB output: Unexpected token", run it in the CLI and read the
warning.

## A saved login that no longer opens the file made every sync a silent no-op (2026-09-09)

What happened: the Settings form on the demo got a different FileMaker account
(a password manager filled the username and password fields; Save kept them
without a test). From then on `fetchSchema` caught the 401 per file and returned
an empty table list, `syncTables` pulled nothing, the index step ran over the
local copies and the run ended with "done, 0 changed". Edited records never
arrived and nothing said why.

Now:
- A new login (password, changed host or user) is proven with `checkAuth` on one
  real file before `/api/config` saves it. A refused login answers 400 and
  nothing changes.
- The sync throws when a file refused to open (`schema.dbErrors`) or when a
  configured table is not in the schema. The overlay shows the FileMaker reason
  in one line (`fmReason`), for example "(212): Invalid account/password".
- The password fields are `autocomplete="off"` and read-only until focused.

## A whole table in the Node heap killed the 1 GB box (2026-09-09)

What happened: `fetchAllRows` collected every page of a table into one array,
`syncTable` then serialized that array to one JSON file with `JSON.stringify`,
and `indexOneTable` read the whole shadow table back with `SELECT *`. At
446,216 records that is three copies of the table in memory at once. The
machine ran out of memory mid-pull and the sync just vanished.

Now:
- `fetchAllRows` takes `onPage(rows, { skip, size })`; with it, nothing is
  kept in memory. `syncTable` streams each page into the JSON file as it
  arrives and rewrites a checkpoint (`tmp/<table>.pages.json`) after every
  page. The next sync of the same table, same filter, same watermark, continues
  from the checkpoint (`pull-resumed` on the event stream) instead of starting
  over. The checkpoint goes when the table is loaded.
- Before a full pull, free disk is checked against the record count (about
  1.5 KB per record, twice). A table that cannot fit ends the sync with one
  sentence that names the table, the count and the free disk, before any
  page is read.
- `indexOneTable` reads the shadow table in batches of 20,000 rows ordered by
  the primary key and reports `index-rows` per batch. The hash map is small
  (id and hash) and loaded once; the rows that are gone are known after the
  last batch.
- While a sync runs, `data/sync-inflight.json` says where it is. A boot that
  finds the file writes `data/last-crash.json` (table, rows, phase, the
  machine's RAM and disk, one sentence) and the client shows it once.

## Switching a table's notes off deleted paid notes (2026-09-09)

What happened: `enrichStage` cleared the notes of every table whose enrich
switch was off, and of every table when the stage was off, on every sync. A
switch flipped by mistake threw a paid pass away.

Now: a switch off only stops writing and matching. The notes stay. The search
matches `enrich_norm` only for tables whose switch is on while the stage is on
(`termSql` in store.js). `POST /api/ai/enrich/forget { table }` deletes them on
purpose.

## Two tables with one word landed every click on the first (2026-09-09)

What happened: the table word (slug) came from the display name alone.
Three museum files each had an "Artwork" table, so three tables were sent to
FileMaker as `artwork` and the script opened the first one every time.

Now: `slugMap()` in server.js is unique. A saved word is fixed. A proposed
word that collides takes the occurrence name instead (`met-artwork`,
`nga-artwork`), and only when that collides too does it get `-2`, `-3`.
`POST /api/config` refuses a duplicate word, an empty one, or one outside
`[a-z0-9_-]` with 400. New proposals use hyphens; a saved word with an
underscore from an older config still passes.

## Fly suspends a box that gets no web traffic, sync or not (2026-09-09)

`auto_stop_machines = "suspend"` looks only at inbound HTTP through the proxy.
A sync started from a script on the box (or from a browser tab that was then
closed) has no inbound traffic, so the proxy suspends the machine mid-pull and
the pull sleeps until the next request wakes it. A browser tab with the sync
overlay open keeps the event stream alive, so a normal sync is not affected.
Scripted syncs must keep a request loop going from outside.
