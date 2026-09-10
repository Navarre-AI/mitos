# When Mitos does not work

Every entry here is a failure that happened, with the words Mitos prints and
what to do. Read the first section before you install; it prevents most of
them.

## Before you start: what you need, and what you do not

You need three things:

1. **A Fly.io account.** Signup wants a card. A Mitos machine runs a few
   dollars a month, on your card, in your account.
2. **A hosted FileMaker file with OData on**, and an account for Mitos whose
   privilege set has the `fmodata` extended privilege in each file to search.
   Read-only. No file handy? Skip it; Mitos runs on sample data.
3. **One AI key, optional.** Without it the exact search, close spellings and
   the name table all work. A key adds table naming and the model stages.

You do not need Docker, Node, git or a copy of this repo to install on Fly.
Those are for running Mitos on your own machine.

## The install lines

Mac or Linux, in a terminal:

```bash
curl -fsSL https://navarre.ai/get/mitos | sh
```

Windows, in PowerShell:

```powershell
irm https://navarre.ai/get/mitos.ps1 | iex
```

The installer is not part of this repo. `README.md` says it installs the
Fly CLI if needed, asks a name and a region, builds in the cloud, and opens
the browser with your password. Save the password.

Using an AI tool? Point it at `AGENTS.md`. The install is one command; a
good run needs a handful of approvals, not dozens.

## FileMaker refused this login

**What you see.** On Save in Settings: `FileMaker refused this login for
<file>: (212): Invalid account/password. Nothing was saved.` During a sync:
`FileMaker could not open "<file>": (212): Invalid account/password. Check
the server address, the account and the password in Settings, FileMaker
tab.`

**Cause.** The account or the password is wrong for that file, or a password
manager filled the form with another account. FileMaker's code 212 means
exactly "invalid account or password".

**Fix.** Enter the right account and press Save. Since 0.4.1 a new login is
tested against one real file before it is saved, so a refused login cannot
become a silent sync that reports "done, 0 changed".

## No file reachable over OData, or a file is missing from the list

**What you see.** `No file reachable over OData: ...`, or the Files step
does not list the file you expect.

**Cause.** `GET /fmi/odata/v4` lists only the files this account can open
with the `fmodata` extended privilege. OData off on the server, no account in
that file, or no `fmodata` on its privilege set, and the file is simply
absent.

**Fix.** Admin Console, Connectors: turn OData on. In the file: give the
Mitos account a privilege set with `fmodata`. Test from any machine:

```bash
curl -u user:pass "https://HOST/fmi/odata/v4/DBNAME/\$metadata"
```

XML back means good. An error here is the error Mitos sees.

## The server refused a field list ($select rejected)

**What you see.** In the sync log: `<table>: this server refused a field
list in both encodings; reading whole rows instead (...)`. That table's pull
is slow.

**Cause.** FileMaker's OData parser rejects some `$select` forms. A bare
field named `ID` fails with `-1002 parse failure`. Mitos sends every name
quoted (`$select=%22ID%22,...`), retries once with double encoding for the
server family that decodes twice, and only then reads whole rows. Whole rows
means every unstored calculation is evaluated per record.

**Fix.** Usually none: the quoted form works on FileMaker Server 2026 and the
note means this server is different. If the table is slow because of it,
give it a `cMitosJSON` field (`filemaker/cMitosJSON.md`) so Mitos reads one
field. Details in `GOTCHAS.md`.

## A table did not answer in 60 seconds

**What you see.** `<table> did not answer in 60 seconds even at 25 records a
page. That table is expensive to read (usually unstored calculations
evaluated per record). Give it a cMitosJSON field so Mitos reads one field
instead of all of them, or exclude it.` Before that, notes like `<table>:
slow to answer, retrying 250 records at a time`.

**Cause.** A page is a unit of server work. Mitos starts at 1,000 rows a
page, shrinks by four on each timeout, and gives up at 25. A table that
cannot deliver 25 rows in 60 seconds is evaluating unstored calculations or
summaries for every row it serves.

**Fix.** Either. Add `cMitosJSON` to the table so the server evaluates one
calculation per record, or uncheck the table on the Tables tab. Changing
`FM_TIMEOUT_MS` does not help here; the page timeout is fixed at 60 seconds.

## The sync vanished, or "Mitos most likely ran out of memory"

**What you see.** The next visit shows: `Mitos most likely ran out of memory
on <table> (N records). This machine has 512 MB of RAM and 1 GB of disk (0.7
GB free). Increase the memory in Fly and try again, or leave this table
out.` Or the sync overlay went away with no end line.

**Cause.** The process died mid-sync. Since 0.4.1 rows stream to disk a page
at a time and the index step reads 20,000 rows a batch, so a plain pull no
longer holds a table in memory. What still needs room: DuckDB's load of a
big table (capped at 40% of the machine, spilling to disk), and the vector
scan for semantic search.

**Fix.** More memory on the Fly machine:

```bash
fly scale memory 1024 -a <app>
```

What has been measured, not a promise: a 512 MB machine held 95,378 vectors
at 256 dimensions; a 446,216-record table killed a 1 GB machine before the
streamed pull existed; a `shared-cpu-2x` machine with 4 GB indexed 484,956
rows in 13 seconds. A table that was being read continues from its
checkpoint on the next sync. Finished tables are kept.

Disk is separate. Before a full pull Mitos checks free disk against the
record count (about 1.5 KB per record, twice) and stops with `Mitos cannot
pull <table> (N records) with X GB of free disk. It needs about Y GB.` Grow
the volume in Fly (`fly volumes extend`) and sync again.

## Semantic search stopped: quota exceeded

**What you see.** At the end of a sync: `<Provider> refused this key: quota
exceeded. Add credit to the <Provider> account, then Run again.` For Google:
`Enable billing on the Google AI project, then Run again.`

**Cause.** The embedding provider answered 429 or a quota message. The key is
fine; the account is out of credit or over its limit. Mitos gives a 429 up
to four attempts with a growing pause, then stops the pass and keeps every
vector already written.

**Fix.** Add credit, then AI tab, Paid passes, **Run**. A plain sync embeds
at most 5,000 new rows; Run does the rest. A refused key (401, 403) says
`refused this key. Check the key on the AI tab`; a silent provider says
`did not answer. Check the connection`.

## The hourly sync does not run

**What you see.** Auto-sync is set to an interval and the index is stale.
Or a scripted sync stopped part way with no error.

**Cause.** Fly suspends the machine when no HTTP traffic comes through its
proxy. The auto-sync timer ticks only while the machine is awake, and a
sync started with no browser watching has no inbound traffic, so the proxy
suspends the machine mid-pull. A browser tab with the sync overlay open
keeps the event stream alive, so a sync you watch is not affected.

**Fix.** Pick one:

- Keep a tab open on the sync overlay while it runs.
- Let FileMaker Server be the clock: a script schedule with one `Insert from
  URL` step, `POST https://<app>.fly.dev/api/index/sync?key=<password>`, and
  a loop that reads `GET /api/index/job?key=<password>` until `running` is
  false. The requests keep the machine awake and the overdue timer catches
  up on the next tick.
- Set `min_machines_running = 1` in your `fly.toml` and deploy. The machine
  never sleeps; it costs more.

## Lost the site password

The password is the `SITE_PASSWORD` environment variable on the Fly machine.
Read it back:

```bash
fly ssh console -a <app> -C 'printenv SITE_PASSWORD'
```

Or set a new one (this restarts the machine):

```bash
fly secrets set SITE_PASSWORD=<new> -a <app>
```

That the installer stores it as a Fly secret is what `README.md` implies;
the installer is not in this repo, so check with `fly secrets list -a <app>`.

## Tables have odd names, or "names are guessed"

**What you see.** The Tables tab shows `Org` for `D_Org~B`, or the scan
status said `Naming tables (no AI key: names are guessed)`. `GET
/api/fm/tables` reports `naming.source: heuristic`.

**Cause.** No chat key was set when the scan ran, or the naming model was
refused. The heuristic strips prefixes and underscores and guesses which
tables are worth searching from the name alone. It never picks a title
field.

**Fix.** Add a key on the AI tab, then **Name tables now** on the Tables tab
(`GET /api/fm/tables?rename=1`). A key added after a heuristic scan also
re-names on the next scan. Rename any table by hand on its row; a saved name
always wins. Upload a Save a Copy as XML export for the real table names.

## A table shows "no findable key" and cannot be checked

**What you see.** On the Tables tab: `No findable key: FileMaker reports no
unique, not-empty field, so a click could never land. Add a UUID field, or a
cMitosJSON field with an _id key.`

**Cause.** OData's key for that table is `ROWID`, the internal record id. It
is not a field, no Find can search it, and it does not survive a clone.
Mitos never uses it.

**Fix.** Add a UUID primary key to the table (auto-enter `Get(UUID)`), or a
`cMitosJSON` field whose `_id` key returns a findable value. Rescan.

## "is already used by" when saving a table word

**What you see.** `"artwork" is already used by <table>. Each table needs
its own word.` Or `"invoice_line" is not a valid word for <table>. Use
lower-case letters, digits and hyphens.`

**Cause.** The word a table is sent to FileMaker as (`table` in the click
payload) must be unique, and it uses hyphens now. Three files with an
"Artwork" table once all sent `artwork`, and the FileMaker script opened the
first one every time.

**Fix.** Give each table its own word on its row (`met-artwork`,
`nga-artwork`). A word saved with an underscore fails on its next save;
pick a new one and update the branch in `Mitos - Go To Record`.

## The web viewer says "Not signed in - reload with your ?key link"

**Cause.** The page was loaded without `?key=<password>` and without the
cookie it drops, or the cookie (30 days) expired. A FileMaker web viewer
cannot answer a Basic auth prompt.

**Fix.** Point the web viewer at `https://<app>.fly.dev/?key=<password>`.
For a card window, add `&embed=1&q=<the words>`; do not URL-encode the
words in the script, Set Web Viewer encodes the URL itself.

## A click on a result does nothing in FileMaker

**Cause.** The web viewer does not have **Allow JavaScript to perform
FileMaker scripts** ticked, so the call is dropped with no error. Or the
script was renamed: Mitos calls `Mitos - Go To Record` by name. Or that
script has no branch for the table word that was clicked.

**Fix.** Tick the option in the web viewer setup. Keep the script names from
the kit. Fill in one branch per searched table in `Mitos - Go To Record`:
the table word, the layout, the primary key field. Steps in
`filemaker/README.md`.

## `POST /api/records/changed` answers 202

**Cause.** The request arrived while a sync was running. Mitos does not
index single records during a sync. (Not used in 1.0; records update on the
timed sync.)

**Fix.** Nothing. The next sync picks the change up by timestamp.

## "Bad DuckDB output: Unexpected token"

**Cause.** DuckDB printed a warning into stdout before the JSON. DuckDB 1.3
and later do this for a deprecated lambda arrow; a future deprecation will
look the same.

**Fix.** Run the query in the DuckDB CLI and read the warning. The bundled
CLI is `./bin/duckdb` locally and `/usr/local/bin/duckdb` in the image.

## Every search fails right after a deploy

**Cause.** An index built by an older build lacked the stage columns. Since
0.4 they are added at boot, before the first search.

**Fix.** Restart the machine (`fly machine restart`). If it persists, delete
`data/mitos.duckdb` and sync again; the index rebuilds from FileMaker.

## Running locally: it connects to the wrong server, or will not use sample data

**Cause.** `env.js` loads `.env` with override semantics, so a value in
`.env` beats the shell. But a shell that exports `FM_HOST`, `FM_USER` and
`FM_PASS` with no `.env` entry for them makes Mitos "configured".

**Fix.** Put blank `FM_HOST=`, `FM_USER=`, `FM_PASS=` lines in `.env` for
sample mode. To run against a different server than `.env` names, edit
`.env`; `FM_HOST=... node server.js` will not win.

## The escape hatch

Stuck anywhere for more than ten minutes? Stop burning your time. Book a
free 15-minute call and we finish it together:
https://scheduler.zoom.us/navarre-ai/
