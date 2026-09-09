# What Mitos holds, and who can see it

A security note, written plainly. The limits are in here too, because a
story you cannot poke at is not one. Every claim below is checked against
the code in this repo; `grep -n "fetch(" *.js` shows every outbound call.

## What Mitos stores

Mitos keeps a copy. That is the design: search runs on a local DuckDB
index, not on your server. Everything lives under one directory, `DATA_DIR`
(`/data` on Fly, `./data` locally):

| File | What is in it |
|---|---|
| `mitos.duckdb` | One table per synced FileMaker table, holding ONLY the fields you chose (the key, the search fields, the display fields), plus `mitos_index`: one row per record with its normalized text, its display values as JSON, its numbers, dates, emails and phone digits, a content hash, and the search notes when enrichment is on. |
| `mitos-vec.duckdb` | One vector per index row when semantic search is on. A vector is not the text, but it is derived from it. |
| `config.json` | The FileMaker host, file list, account and **password**, the table config, display names, the sync interval, the date format, the AI keys per provider, and the stage switches. **Plain text.** |
| `searches.jsonl` | Every search: the query text, what it was read as, the model's rewrite and reading when those stages ran, timings, and every row that was shown (table, id, title, why). |
| `clicks.jsonl`, `beacon.jsonl` | Which result a person clicked, with the query; what the FileMaker beacon sent. |
| `schema-scan.json`, `naming.json`, `schema-hints.json` | The structure of your files: table and field names, counts, the proposed names, and the facts read from an uploaded Save a Copy as XML export. |
| `understand-cache.json`, `models.json`, `passes.jsonl`, `index-manifest.json`, `store-manifest.json` | The rewrite cache (query text in, rewrite out), the provider model lists, the ledger of paid passes, and the sync manifests. |
| `tmp/` | Page files and checkpoints while a table is being pulled; deleted when the table is loaded. |

What is not stored: fields you did not choose, containers, any record from
a table you did not check, and anything from a file the account cannot open.

## Where

On Fly, on the volume `mitos_data`, in your own Fly account, in the region
you chose. One machine, one volume. There is no multi-tenant anything and no
copy anywhere else. Fly's volume snapshots are your backup; a lost volume is
a lost index, and the index rebuilds from FileMaker on the next sync.

Locally, in `./data`, which is gitignored.

## Who can read it

One site password, `SITE_PASSWORD`. When it is set, every route needs it:
`?key=<password>` in the URL (which also drops a cookie for 30 days, marked
`HttpOnly`, and `Secure` over HTTPS), that cookie, or HTTP Basic auth. When
it is not set, the site is open. Fly forces HTTPS.

Anyone with the password can search everything, read the search log
(`GET /api/log`), read the scan, change the table choice, start a sync, and
set keys. The API never returns the FileMaker password or a full AI key
(`GET /api/config` returns `hasPass: true` and a key preview of the first 8
and last 4 characters). The files on the volume do hold them in plain text;
anyone with `fly ssh console` on your app can read them.

The `tables=` filter on a search is a hint the FileMaker script sends to
narrow one person's results. It is not a permission: someone with the
password can drop it.

## What Mitos sends to AI providers, and when

Nothing, unless a key is set AND the stage that uses it is on. Then:

| Call | When | What leaves your machine |
|---|---|---|
| Naming pass | Once per schema scan, cached until the schema changes | Table names, up to 6 occurrence names each, record counts, up to 18 field names per table, up to 4 field comments. No record data. |
| Read the search (`understand`) | At search time, for two or more words | The raw table names and their display names, up to 12 field names per table, today's date, the query text. No record data. |
| Pick the best (`rerank`) | At search time, for word searches with two or more candidates | The query, the reading, and up to 15 candidates: table label, title, the other display values (cut to 240 characters), and why each matched. **Display values are record data.** |
| Search notes (`enrich`) | At sync time, only for tables switched on, ten records per call | The prompt and each record's source text: the values of its search fields. **Record data.** |
| Similar meaning (`semantic`) | At sync time for new or changed rows; at search time for the query | One line per record: the table's display name, the values of its search fields, and its search notes when present, cut to 2,000 characters. **Record data.** At search time, the query text. |
| Key test, model list | When you paste a key, or open a model picker | The key, to that provider's own endpoint. |

The providers, and the only hosts the code calls: `api.anthropic.com`,
`api.openai.com`, `generativelanguage.googleapis.com`, `api.voyageai.com`.
Each is called only with the key you gave for it, and only for its own
role. Voyage has no chat models and is never sent a prompt.

Nothing phones home. No telemetry, no usage ping, no update check, no
report to Matt or anyone. The one other download is the DuckDB CLI from
`github.com/duckdb/duckdb/releases`, at `npm install` on your machine and in
the Docker build, never at runtime.

## What Mitos never does

- **Write to FileMaker.** Every FileMaker call in `fm.js` reads: OData
  discovery, `$metadata`, `$count`, and paged row reads. `fm.js` also
  carries a Data API login for a layout inventory, inherited from Pythia,
  that nothing in Mitos calls today. There is no create, update or delete
  anywhere in the code. Give the account a read-only privilege set and the
  server enforces it too.
- **Show generated text as record data.** Display values are copied
  verbatim from source rows (`RULES.md` rule 1). Search notes are searched
  and never shown; a hit through them says so.
- **Run a paid pass unasked.** Boot never syncs. A plain sync caps at 5,000
  vectors and 1,000 notes; the rest waits for the Run button, which shows
  the count and the price first.
- **Let search text reach the database as code.** Query words are escaped
  into `LIKE` patterns; the read path runs the DuckDB CLI in `-safe`
  mode (no file access, no environment) and accepts only `SELECT`.

## The honest limits

- **One password, one role.** There are no user accounts, no per-user
  scoping, no audit of who searched what. The search log tells you what was
  searched, not by whom. If different people may see different tables, that
  needs the FileMaker script's `tables=` filter, and it is advisory.
- **The copy is as wide as the account.** What the Mitos account can read
  over OData, Mitos can copy. Scope the account, not Mitos.
- **Secrets on disk in plain text.** The FileMaker password and the AI keys
  sit in `config.json` on the volume. That is what makes a browser-only
  setup possible. Treat the volume like a config file with secrets in it.
- **Queries are data.** Every search, including the ones people type by
  mistake, is in `searches.jsonl` in plain text, and a search with the
  model stages on is sent to a provider. Do not type secrets into the
  search field.
- **No rate limit, no lockout.** A wrong password gets a 401 and can try
  again at once.
- **Vectors are derived data.** A vector cannot be read back as text, but it
  is built from the record and it lives beside it. Deleting
  `mitos-vec.duckdb` is the reset.
- **The record log outlives the record.** A deleted FileMaker record leaves
  the index on the next sync (a count check finds it), but its title stays
  in `searches.jsonl` wherever it was shown.
- **Not a security product.** No SIEM, no compliance stamp. It is a search
  index in your own cloud account that reads one FileMaker account's view
  and never writes back.
