*For the FileMaker developer adding Mitos to a file. Back to the [README](../README.md).*

# The FileMaker side of Mitos

Mitos works with no change to your file: search in the browser, and a result
opens the record in FileMaker. This folder is for the optional part: search
inside your own layouts, and to refresh a record the moment it is saved.
The timed sync still runs as the safety net either way.

The pieces ship in one small file, **Mitos.fmp12**
(https://navarre.ai/files/Mitos.fmp12). Its `Install` layout shows the
same steps as https://navarre.ai/mitos/start. `Mitos Kit.xml` here is the
scripts as a clipboard snippet, for people who prefer to paste (check that
it includes **Mitos - Record Changed**, since the XML here has the first two only; the file is the reference).

## What's in the kit

Three scripts, plus one layout trigger step:

| Script | What it does |
|---|---|
| **Mitos - Search** | Opens the Mitos window (a web viewer pointed at your Mitos address). Takes `{"string": "<the words>"}` so a search field can call it. |
| **Mitos - Go To Record** | Runs when someone clicks a result. Finds that record in your file and shows it. Mitos calls it by name. |
| **Mitos - Record Changed** | Optional, hidden. Tells Mitos a record was just saved, so it refreshes at once. |

The **OnRecordCommit** layout trigger, on each layout whose table Mitos
searches, is what runs *Mitos - Record Changed* (step 5 below).

## Install

1. In your file, make a layout named **Mitos** and paste the web viewer
   from the kit's `Mitos` layout onto it. The web viewer is named `mitos`
   and has **Allow JavaScript to perform FileMaker scripts** on. Without
   that, a click on a result does nothing and there is no error to see.
2. Copy the scripts from the kit into your file. Keep their names:
   Mitos calls **Mitos - Go To Record** by name.
3. In **Mitos - Search**, paste your Mitos address (the one the installer
   printed, with the site password in the URL as `?key=`) into the first `Set Variable` line. If your
   layout is not named Mitos, change the layout in the `New Window` step.
   The script takes `{"string": "<the words>"}` as its parameter, so a
   global search field with an OnObjectSave trigger can call it.
4. In **Mitos - Go To Record**, fill in one branch per table you search:
   the table word, the layout to land on, and the primary key field to
   find on. The table words are in Mitos under Settings, Tables ("sent to
   FileMaker as"): lowercase letters, digits, hyphens or underscores, unique
   per table.
5. **Record by record (optional).** Copy **Mitos - Record Changed** (hidden
   in the kit) into your file and keep its name. Paste your Mitos address
   into the `$url` line, in the `/api/records/changed?key=` form (the site password again). On each
   layout whose table Mitos searches, add an **OnRecordCommit** layout
   trigger that runs it, with the parameter
   `JSONSetElement ( "{}" ; [ "id" ; Table::PrimaryKey ; JSONString ] )`.
   Or leave the parameter empty and edit the `$id` line to your key field.

## What Mitos sends

A click on a result runs `Mitos - Go To Record` with:

    { "id": "8F3C...", "table": "person", "raw": "O_Staff", "search": "shavon murphy" }

`id` is the value of that table's primary key. `table` is the table word,
`raw` the occurrence name, `search` what was typed. The script enters Find
mode, goes to the layout for that table, puts `id` in the key field and
performs the find. A record deleted since the last sync finds nothing; the
script says so.

## Record Changed: what it does

`POST /api/records/changed` with `{ "table": "<table word>", "id": "<primary key>" }`.
Mitos answers 202 at once and refreshes that record behind, so FileMaker
never waits. Hosted on FileMaker Server, the script hands itself to the
server (Perform Script on Server, wait off), so users never see
"Transferring URL". Not hosted, it posts in place and the dialog may show.
The server-side script runs with the account's privileges, so **Insert from
URL has to be allowed** for that account. Unknown tables and records
FileMaker no longer has show in red in the Log tab, under Record updates.

## Hourly sync while Mitos sleeps

On Fly, Mitos suspends after a few idle minutes, and a suspended box cannot
wake itself for the hourly sync. A FileMaker Server schedule that runs a
one-step script (Insert from URL to
`https://your-mitos.fly.dev/api/index/sync?key=YOUR_SITE_PASSWORD`, POST, empty body)
wakes it and starts the sync.

## Limiting a user's search

Add `&tables=D_Org~B,O_Staff` (raw occurrence names, comma separated) to the
address to limit one user's search to the tables they may see.

## One field per table instead of many

A table can expose one `cMitosJSON` calculation field that decides what a
record means to search; see [cMitosJSON.md](cMitosJSON.md).

Stuck? See [TROUBLESHOOTING.md](../TROUBLESHOOTING.md). The routes the scripts call are in [API.md](../API.md).
