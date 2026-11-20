# Installing Mitos

About ten minutes, mostly waiting on a cloud build. You need a Fly.io
account, a FileMaker Server with OData, and one AI provider API key (optional if
the exact search is all you want, but you'll want it).

## Before you install

- On FileMaker Server, turn on **OData** (Admin Console, Connectors). The
  Data API isn't needed.
- In each file, make a **read-only account** for Mitos with a privilege set
  that has the `fmodata` extended privilege. Nothing else. Mitos only reads,
  but a read-only account makes the server enforce that too.
- Create a **Fly.io** account. Mitos runs there as one small machine.
- Get **one API key** from an AI provider. A Google AI key covers everything
  (naming, the search stages and semantic search). A Claude or OpenAI key
  covers everything but embeddings; add a Google or Voyage key for those.

## Install (Fly.io)

Mitos runs on Fly.io, in your own account. Mac, in Terminal:

```bash
curl -fsSL https://navarre.ai/get/mitos | sh
```

Windows, in PowerShell (no WSL):

```powershell
irm https://navarre.ai/get/mitos.ps1 | iex
```

It installs the Fly CLI if needed, asks for a name and a region, builds Mitos
in the cloud, and opens it in your browser with its site password. Nothing
is left on your machine but Fly's own tool. Save the site password; it's
the `SITE_PASSWORD` secret on your Fly app. The whole walk-through, with the
FileMaker side: https://navarre.ai/mitos/start

Using an AI coding tool? Point it at [AGENTS.md](AGENTS.md).

## Connecting FileMaker

The first run opens an eight-step setup, one screen each: **Connect**
(server and the read-only login, tested before it is saved), **Files** (the
ones that login can open, one or more), **API key** (checked the moment you
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
FileMaker, where a script does an ordinary Find on it (see
[filemaker/README.md](filemaker/README.md)). A table can instead expose one
`cMitosJSON` calculation field that decides what a record means; see
[filemaker/cMitosJSON.md](filemaker/cMitosJSON.md).

Sync is a modal that watches a server-side job: reload the page mid-sync and
it reattaches. Tables sync A to Z by display name, incrementally where the
table has a primary key and a modification timestamp. A record deleted in
FileMaker is noticed by a record count check on each sync and removed from
the copy and the index. The Records column on the Tables tab shows
FileMaker's count as of the last sync. Duplicate primary keys never stop a
sync: Mitos keeps the newer twin and names the ID to fix in FileMaker.
Unticking a table removes its copy too, after a confirm that names it.

## The kit and the web viewer

Mitos works with no change to your file: search in the browser, and a result
opens the record in FileMaker. The kit (**Mitos.fmp12**, three scripts and a
web viewer) puts the search inside your own layouts. The web viewer opens Mitos with the site password in
the URL, so there's no sign-in screen to answer. The steps are in
[filemaker/README.md](filemaker/README.md). Refreshing a record the moment it's
saved is optional and separate: [filemaker/RECORD-UPDATES.md](filemaker/RECORD-UPDATES.md).

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
`matt.navarre@`, `773-9565`, `Murpy`. With an API key on the AI tab, switch
the stages on and try `someone named bob whitfeld or something`, `people
since 2019`, `cheap shoes`. Then run `npm run eval`, and `npm run simulate --
--compare "exact,fuzzy" "exact,fuzzy,semantic,understand,rerank" --ai` to
measure the stages against each other on a few hundred simulated searches.

## Updating to a new version

Mitos has no update check and never phones home, so nothing tells you a new
version is out. Settings, Settings tab shows the version you're running;
[CHANGELOG.md](CHANGELOG.md) lists what changed.

An update is a redeploy of the new code to the same Fly app. Your data
(the copy, the index, the vectors, the settings and the AI keys) lives on
the Fly volume, not in the image, so it survives. If a sync is running when
the machine restarts, Mitos says so; finished tables are kept, and the next
sync picks up where the table stopped. Run the redeploy from a checkout of
the repo that holds your `fly.toml`:

```bash
fly deploy -a <your-app>
```

The installer script isn't in this repo, so how it handles a second run
isn't documented here. If you installed with it, the `fly.toml` it wrote
for your app is what `fly deploy` needs.
