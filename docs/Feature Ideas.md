# Feature Ideas

Ideas, not promises. Nothing here gets built without Matt's go. Add new
ones with the date and where they came from. Bugs live on the bug list,
not here. Use cases are in [Use Case Ideas](Use%20Case%20Ideas.md).

## Search results

1. **Signal bars instead of percentages.** Five bars counted from evidence,
   not a score: 5 = every word whole in the name, 4 = all words connect but
   one is a prefix or a close spelling, 3 = all words in the record but not
   all in the name, 2 = only some words, 1 = notes or meaning only. The
   reasons show on hover or tap (a page-drawn popover, so it works on
   FileMaker Go). Matt, 2026-10-14: "A search should only show 2 or less if
   the search just made no good connection at all."
2. **A quieter table label in the one-list layout.** Move it to the right,
   small and gray, so the names line up as a column. (2026-11-23)

## Standalone search sites

3. **Mitos as a website of its own.** Any subset of data, any set of
   users, outside FileMaker. (2026-11-23) Needs:
   - **Per-person sign-in,** and per-person table access, instead of one
     shared site password.
   - **A record page** that's the destination of a click, since there's no
     FileMaker to go back to.
   - **A field allowlist** stricter than "what's searchable", and rate
     limits for a public site.
   - A clear warning that record text goes to the AI provider when the AI
     stages are on.

## FileMaker side

4. **Search-and-land script in the kit.** Goes to the Mitos layout, runs a
   search, leaves the page live. Drafted 2026-11-24. It's a twist on the
   kit's Mitos - Search (Sept 7), which opens a card window with
   `&embed=1`, so it shows results only and has no search box. This one
   goes to a layout and loads the full page.
5. **Run a search without reloading the page.** A small page function a
   script calls with Perform JavaScript in Web Viewer, so a second search
   from FileMaker doesn't reload. (2026-11-24)
6. **WebDirect support.** WebDirect only lets web viewer JavaScript call a
   FileMaker script when the page has the same origin, and the HTML must
   start with `data:text/html,`. So a click on a result can't reach
   Mitos - Go To Record from a Fly page. Needs a different way in.
   (2026-11-24)
7. **The script name in Settings with a Test button,** so a wrong name
   shows up before someone clicks a result. (2026-10)

## Sync and setup

8. **Pythia's sync ladders in Mitos.** Page size, keyset paging, field-name
   encoding, the Data API road switch. Written up in navarre-core
   `filemaker/sync-ladders.md`. Matt, 2026-10-14: "Yeah that's a must."
9. **A Pythia-style model list.** Public picks from navarre.ai first, then
   "Other models from your API key". (2026-10-19)

## Without Fly

10. **Mitos with no Fly app, on live data.** Matt, 2026-11-24: "if we
    connected it DIRECTLY to FileMaker so it used live data what that would
    look like. No Fly app." Two roads:
    - **Mitos on the FileMaker Server machine.** Same code, OData over
      localhost, the kit's Record Changed script keeps it current within
      seconds. Data never leaves the server. Loses "search stays up while
      FileMaker is down".
    - **Mitos Lite, all inside FileMaker.** A web viewer page that asks a
      FileMaker script (ExecuteSQL) on each search and ranks in the page.
      Truly live, no server at all, but no typo matching beyond what the
      page can do with the rows it gets back, no AI stages, and slow on big
      tables. Small files only.

## From the art data (2026-11-24)

11. **More than one title field.** In an art collection the artist's name
    matters as much as the title, but only the first shown field counts as
    the title, so "Pissarro" ranks his paintings at 34-51% as "found in a
    field". Let a table name two title fields (title + artist, product +
    brand).
12. **Text that is really a date.** CMOA's `creation_date` is a text field
    ("1879", "c. 1920"), so year and date searches can't use it. Read years
    and dates out of text fields at index time, like numbers.

## Parked

13. **MCP: Mitos as a search tool for agents.** Parked by Matt, 2026-10-14.
14. **One search across several files or servers,** with the tables kept
    apart. (2026-11-23)
