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
returns the same list. Every hit carries a reason in words in the API and
the search log (`bob as robert in the title`, `number 65 in range`, `phone
ends with it`). The page doesn't print it under each result.

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
| Enrichment | During sync, a fast model writes notes per record: other spellings, `Last, First`, nicknames, plain words for what it is. Searched, never shown; a hit through them says "in the search notes" in the API | a fast chat model, ten records per call | at sync, only for rows without notes, per table (switch and prompt on the Tables tab), capped per sync |
| Semantic search | A vector per record; `mid-range digital SLR` lists the cameras below the exact hits. It has a switch per indexed table too, with the vector count and size | an embedding model: OpenAI text-embedding-3, Gemini, or Voyage | vectors are built during sync; the query is embedded at search time and cached |
| Enhanced search: Interpret meaning | `people with birthdays in the first half of May` becomes `5/1/2026...5/15/2026`; `inv 2216` becomes `2216`; `someone named bob whitfeld or something` becomes `bob whitfeld`. The rewrite runs through the exact search again | a fast chat model | only for two or more words; skipped for one word, a number, a date, an email, a phone |
| Best match | A plain rule, no model, no API key. One record is marked best when every word you typed matches it and the next result is well behind (or an email, phone or number only one record has). Switch it off and no record is marked | none | with every word search |
| Use AI to determine best match | Sits under Best match. A fast model reorders the short list and names one best match when it is sure. Below its confidence the list is the answer | a fast chat model | only for word searches with two or more candidates |

The page shows the exact list in tens of milliseconds, then asks for the AI
phase once the words stand still, and fills it in behind: a "read as" line,
the "Semantic matches" section (or "Perhaps you meant" when even the best
is weak; semantic search always shows its nearest rows), and the best match
on top. A FileMaker card window does the same, with the words still in the
field to edit.

Two screens: the plain page is the search with one Settings button, and
`?embed=1&q=...` is the card window (results only). Settings has five tabs:
**Data Sources**, **Tables**, **AI**, **Log** and **Settings** (this
machine, its memory and disk, the version, and the Danger zone). Escape backs
out of Settings one level at a time. Light or dark follows the system, with a
switch if you want to override it.

**Paid passes are a formal step.** Switching Semantic search on shows the
record count and the price first, then Run now or Later. Switching
Enrichment on opens a window: the model, the rules, the tables, a live
preview of the notes on two records per table, the price, then Run now or
Later. A plain sync stays under a quiet cap (5,000 vectors, 1,000 notes);
the rest waits for Run on the AI tab, which shows what is waiting and a
ledger of what has run. Every stage row has a "?" that explains it in full.
Turning Semantic search off warns first, then deletes the vectors to free
disk.

**Models come from a public list.** The menus read
https://navarre.ai/ai-models.json, the same list Pythia and Clio use. It is
refreshed every 12 hours and whenever you save an API key, grouped by job, with a
recommended pick per stage. A stage you haven't set takes the recommended
model of the first provider that has an API key. API keys for four providers live on
the AI tab.

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
