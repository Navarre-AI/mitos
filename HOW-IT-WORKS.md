# How Mitos works

How a search is read, what the optional AI stages add, how the index gets
built, and the one rule that never bends. Start with [README.md](README.md)
if you haven't met Mitos yet. To set it up, see [INSTALL.md](INSTALL.md).

## Search, in two parts

### How search works (deterministic and type-aware first)

Mitos reads the whole input first and decides what kind of thing it is. Then
it searches only the fields where that kind of thing can live. This is the
front door the original fmSearchResults had, and it is the reason a number
does not drown in text hits.

| You type | Read as | Searched where |
|---|---|---|
| `Murphy`, `matt nav` | words | every word must start a word in the record |
| `"cardiac clinic"` | a phrase | the words, in that order |
| `=matt`, `*arre`, `w*field` | whole word, contains, letters inside one word | text |
| `==Matt Navarre` | the title is exactly this (no name table, no look-alikes) | the title |
| `Bob Whitfield` | words, with the name table | `bob` also matches `robert`, `rob`, `bobby` |
| `45`, `$5,000` | a number | number fields (exact), plus the text as a whole word |
| `100...200`, `>100`, `<=45` | a number range | number fields |
| `1/15/2026`, `15.1.2026`, `2026-01-15` | a date | date fields |
| `1/2026`, `May 2026` | a month | date fields |
| `March 4, 2019`, `4 March 2019` | a date, month named in words | date fields (a name with no year stays a word) |
| `1/1/2026...3/31/2026`, `>1/1/2026` | a date range | date fields |
| `2019` | a number, or a year | number fields, and dates in 2019 |
| `matt.navarre@` | an email | email values |
| `773-9565`, `+11 629 773 9565` | a phone | phone digits (the end of a number matches) |

Text is normalized on both sides (lower case, accents stripped, punctuation
ignored), so `Navarré` finds `navarre`. A word scores higher as a whole word
than as a word start, and highest in the record's title (the first display
field). Ties break on title length and record id, so the same query always
returns the same list. Every hit carries a reason in words in the API and
the search log (`bob as robert in the title`, `number 65 in range`, `phone
ends with it`). The page doesn't print it under each result.

When every word must match and nothing does, Mitos asks again with less, and
says so in the "searched" line: first without filler words (`find`, `please`,
`the`, `contact`...), then records that carry at least half the words (two at
least), ranked by how many. It only runs on an empty answer, so it can never
bury a real hit. A mistyped email address that matched nothing is compared
whole to each stored address (Jaro-Winkler) and listed as a close spelling.

Weights are visible in `store.js` (`TITLE_WEIGHT`): a word in the title (the
first shown field) scores on top of the same word anywhere in the record, so
a title match always outranks a match only in a notes or description field.
Recency is a tiebreak and nothing more: when two records tie on score and
title length, the one modified last lists first. It needs a modification
timestamp Mitos already knows (the field the sync uses for incremental
pulls); the index stores it as `modified`, filled as records are re-indexed.
Tables without one are untouched.

Day and month order follows the **Date format** setting (month first by
default). When one part cannot be a month, the data decides.

The name table ships with common English nicknames plus some Greek and other
European forms (`names.config.js`). Write `data/names.json` as an array of
arrays to replace it.

### The stages (switches on top of the exact search)

The exact search above always runs first and shows at once. Five stages sit
on top of it, plus a plain Best match rule, each with its own switch on the
AI tab in Settings. Each stage has its own model and time budget, and each
can be off while the others run. A stage that is late or broken records an
error in the response's `stages` and the search still answers.

| Stage (its switch) | What it does | Model | When it runs |
|---|---|---|---|
| Close spellings | Jaro-Winkler on record names: `Murpy`, `whitfeild`, `Ac me systems`, `bob whitfeld` (the name table applies) | none | with the exact search, in about 20 ms |
| Enrichment | During sync, a fast model writes notes per record: other spellings, `Last, First`, nicknames, plain words for what it is. Searched, never shown; a hit through them says "in the search notes" in the API | a fast chat model, ten records per call | at sync, only for rows without notes, on tables where it is switched on (top right of the table's panel on the Tables tab) |
| Semantic search | A vector per record; `mid-range digital SLR` lists the cameras below the exact hits. Switched per table, in the table's panel, with the vector count and size | a vector model: OpenAI text-embedding-3, Gemini, or Voyage | vectors are built during sync; the query is embedded at search time and cached |
| Understand the question | `people with birthdays in the first half of May` becomes `5/1/2026...5/15/2026`; `inv 2216` becomes `2216`; `someone named bob whitfeld or something` becomes `bob whitfeld`. The rewrite runs through the exact search again | a fast chat model | only for two or more words; skipped for one word, a number, a date, an email, a phone |
| Best match | A plain rule, no model, no API key. One record is marked best when every word you typed matches it and the next result is well behind (or an email, phone or number only one record has). Switch it off and no record is marked | none | with every word search |
| Let AI pick the best match | Sits under Best match. A fast model reorders the short list and names one best match when it is sure. Below its confidence the list is the answer | a fast chat model | only for word searches with two or more candidates |

The page shows the exact list in tens of milliseconds, then asks for the AI
phase once the words stand still, and fills it in behind: a "read as" line,
the "Semantic matches" section (or "Perhaps you meant" when even the best
is weak; semantic search always shows its nearest rows), and the best match
on top. A FileMaker card window does the same, with the words still in the
field to edit.

Two screens: the plain page is the search with one Settings button, and
`?embed=1&q=...` is the card window (results only). Settings has five tabs:
**Connection**, **Tables**, **AI**, **Log** and **General**. AI holds the keys,
the models and the While searching list (the stage rows above). General has
the preferences (light or dark, which follows the system unless you pick;
date order; auto-sync), About (this machine, its memory and disk, the
version) and the Danger zone. Escape backs out of Settings one level at a
time.

**One sync does it all.** A sync runs three phases in order: your data,
Enrichment, Vectors. It builds every pending record, no caps, and three small
progress bars show where it is. There is no Run button and no separate paid
pass. Enrichment and Semantic search are switched per table, in the table's
panel on the Tables tab (two switches, top right). A feature is on when any
table has it on. Switching one on shows the count and the price first, then Sync now or Later; Later
keeps it on and the next sync builds it. If you want a safety ceiling,
`maxRowsPerSync` in the stage's config limits the rows per sync (off by
default). Every stage row has a "?" that explains it in full.
Enrichment rules stack: the shared rules (AI tab) always apply, and a table's
own rules are added after them ("Shared rules", then "Rules for this table").
The built-in default is used only when both are empty, and the output rules
("use only facts") are always added. Each box holds up to 4,000 characters.
Turning Semantic search off on a table warns first, then deletes its vectors
to free disk.

**Models come from a public list.** The menus read
https://navarre.ai/ai-models.json, the same list Pythia and Clio use. It is
refreshed every 12 hours and whenever you save an API key, grouped by job, with a
recommended pick per stage. A stage you haven't set takes the recommended
model of the first provider that has an API key. API keys for four providers live on
the AI tab. A model that has dropped off the list keeps working; the AI tab
shows a warning so you can pick a current one when you get to it.

The one other AI call is the schema naming pass at scan time (D_Org~B becomes
Organization), and it is optional too.

Measured on the bundled sample (100 simulated searches, `npm run simulate`):
the exact search alone finds the right record first 76% of the time and in
the top five 88%; with every stage on, 85% and 98%. The natural-language
searches go from 0% to 67-100%. The exact phase answers in about 60 ms; the
AI phase adds one to three seconds with Haiku.


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
reads as record data is generated. See [RULES.md](RULES.md) (the full list, for people changing the code).
