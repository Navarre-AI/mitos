*For the FileMaker developer adding Mitos to a file. Back to the [README](../README.md).*

# The FileMaker side of Mitos

Mitos works with no change to your file: search in the browser, and a result
opens the record in FileMaker. This folder is for the optional part: search
inside your own layouts, and to refresh a record the moment it is saved.
The timed sync still runs as the safety net either way.

The pieces ship in one small file, **Mitos.fmp12**
(https://navarre.ai/files/Mitos.fmp12). Its `Install` layout shows the
same steps as https://navarre.ai/mitos/start. Open it next to your file and
copy and paste.

## What's in the kit

Three scripts, plus one layout trigger step:

| Script | What it does |
|---|---|
| **Mitos - Search** | Opens the Mitos window (a web viewer pointed at your Mitos address). Takes `{"string": "<the words>"}` so a search field can call it. |
| **Mitos - Go To Record** | Runs when someone clicks a result. Finds that record in your file and shows it. Mitos calls it by name. |
| **Mitos - Record Changed** | Optional, hidden. Tells Mitos a record was just saved, so it refreshes at once. |

*Mitos - Record Changed* isn't part of the install. It has its own page:
[RECORD-UPDATES.md](RECORD-UPDATES.md).

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

Want a saved record in search right away? That's optional and separate:
[RECORD-UPDATES.md](RECORD-UPDATES.md).

## What Mitos sends

A click on a result runs `Mitos - Go To Record` with:

    { "id": "8F3C...", "table": "person", "raw": "O_Staff", "search": "shavon murphy" }

`id` is the value of that table's primary key. `table` is the table word,
`raw` the occurrence name, `search` what was typed. The script enters Find
mode, goes to the layout for that table, puts `id` in the key field and
performs the find. A record deleted since the last sync finds nothing; the
script says so.

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
