# The FileMaker side of Mitos

Mitos works with no change to your file: search in the browser, and a result
opens the record in FileMaker. This folder is for the optional part: search
inside your own layouts. Records update on the timed sync; that is the one
update path in 1.0.

The pieces ship in one small file, **Mitos.fmp12**
(https://navarre.ai/files/Mitos.fmp12). Its `Install` layout shows the
same steps as https://navarre.ai/mitos/start. `Mitos Kit.xml` here is the
two scripts as a clipboard snippet, for people who prefer to paste.

## Install

1. In your file, make a layout named **Mitos** and paste the web viewer
   from the kit's `Mitos` layout onto it. The web viewer is named `mitos`
   and has **Allow JavaScript to perform FileMaker scripts** on. Without
   that, a click on a result does nothing and there is no error to see.
2. Copy the two scripts from the kit into your file. Keep their names:
   Mitos calls **Mitos - Go To Record** by name.
3. In **Mitos - Search**, paste your Mitos address (the one the installer
   printed, with `?key=`) into the first `Set Variable` line. If your
   layout is not named Mitos, change the layout in the `New Window` step.
   The script takes `{"string": "<the words>"}` as its parameter, so a
   global search field with an OnObjectSave trigger can call it.
4. In **Mitos - Go To Record**, fill in one branch per table you search:
   the table word, the layout to land on, and the primary key field to
   find on. The table words are in Mitos under Settings, Tables ("sent to
   FileMaker as"): lowercase letters, digits, hyphens or underscores, unique
   per table.

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
`https://your-mitos.fly.dev/api/index/sync?key=YOUR_KEY`, POST, empty body)
wakes it and starts the sync.

## Limiting a user's search

Add `&tables=D_Org~B,O_Staff` (raw occurrence names, comma separated) to the
address to limit one user's search to the tables they may see.

## One field per table instead of many

A table can expose one `cMitosJSON` calculation field that decides what a
record means to search; see [cMitosJSON.md](cMitosJSON.md).
