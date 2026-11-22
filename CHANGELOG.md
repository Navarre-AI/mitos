# Changelog

Newest first. The commit log has the detail; this is the story.

## 1.2 (in progress)

- **Most-words fallback.** When every word must match and nothing does, Mitos drops filler words ("find Bob Whitfield please"), then falls back to records with at least half the words, ranked by how many. Only on an empty answer.
- **Find more.** Month names read as dates ("March 4, 2019", "4 March 2019", "May 2026" as a month range); a slip inside an email address finds the close address; Mathieu joins Matt and Shivawn joins Siobhan in the name list; `==exact title` and `W*field` (letters inside one word) join `=`, `*` and "phrase". Word-start prefixes and plain-typed accents already worked and now have test cases. A general phonetic matcher was not built: no small dependency-free rule gets Siobhan right, so the name list carries those spellings.

- **Field weights and recency.** The title weight is named and tested (a title match beats a notes-only match). Records that tie on score and title length now list the most recently modified first, only for tables with a modification timestamp the sync already uses; `npm test` checks it in `scripts/test-recency.mjs`.

- **AI re-ranking over exact and semantic rows.** With the reranker on, the vector pool is 20 per table and one fast-model call sees the exact rows plus the 10 nearest semantic ones. It picks which semantic rows join the main list, the table order and the Best match; exact hits are never removed or put under a semantic row, and a late or failed call changes nothing. `npm run bench` now turns the reranker on for its AI run (AI cases: first in the list 94% to 100% for meaning cases, found 100%). `npm run test:ai` checks the promises with a key.

- **Greek and Chinese.** The sample gains three people (P0201 Γιώργος Μαράκης, P0202 乔治·陈, P0203 George Martin). Greek final sigma (ς) is the same letter as σ on both sides, so a word typed either way finds the record; accents and capitals already worked. A Chinese name finds by its characters, and one character (乔) finds the name it starts. The name table now spans scripts (george = γιώργος = 乔治; john = γιάννης = 约翰), and the semantic query is embedded with those other forms added, since a vector model rarely knows 乔治 is George. A semantic row's cut-off no longer takes its bar from an exact hit's own vector. "george maraki" with Enrichment, Vectors and the reranker on lists Γιώργος Μαράκης (best), George Martin (close spelling) and 乔治·陈 (semantic, well down the list); vectors alone keep 乔治·陈 far from that query.

## 1.1.0, 2026-11-20

The first release Matt calls finished. There is no 1.0: it went from 0.9.4 straight here.

- **Sign-in page.** The bare address asks for the site password and keeps a session cookie (only its hash is stored). Five wrong passwords pause sign-in for a minute. A page opened with the site password in the URL (`?key=`) signs itself in, so a FileMaker web viewer still works with one URL.
- **General tab**, last: Preferences (theme, date order, auto-sync), About (machine, memory, disk, copy size, last sync, version and build), and the **Danger zone**: reset, drop a synced copy, rebuild the index, forget AI notes, sign everyone out.
- **Record by record.** `POST /api/records/changed` answers at once and works behind. The kit's "Mitos - Record Changed" script sends it after a commit through Perform Script on Server, so FileMaker shows no "Transferring URL". The Log tab's Record updates list puts unknown tables and missing records on top, in red.
- **Duplicate primary keys never stop a sync.** Mitos re-reads the twins, keeps the newer one, and says which ID to fix in FileMaker. Unticking a table removes its copy too, after a confirm that names it.
- **One sync builds everything.** Three phases in order: data, Enrichment, Vectors, every pending record, with three small progress bars. The Run button, the paid-pass list and the per-sync caps are gone. `maxRowsPerSync` is an optional ceiling, off by default. `POST /api/ai/estimate` gives a what-if cost.
- **Enrichment and Semantic search per table.** Two switches in each table's panel on the Tables tab, no global ones; old settings carry over at boot. Switching one on shows the count and price; Later keeps it on and the next sync builds it. Turning semantic search off warns first, then deletes that table's vectors.
- **Tabs and names.** Connection (was Data Sources), Tables, AI (Keys, Models, While searching), Log, General. "While searching" was Search stages; "Understand the question" was Enhanced search; "Let AI pick the best match" was Use AI to determine best match; "Not selected" was Not indexed; "Save and sync". A model gone from the list keeps working and shows a warning.
- **Models come from navarre.ai/ai-models.json**, the same list Pythia and Clio read, refreshed every 12 hours and whenever an API key is saved. Menus are grouped by job, with a recommended pick per stage.
- **Best match by the gap.** Every typed word has to match, and the next result has to be well behind. "Let AI pick the best match" is a switch under it. No "why" line under results any more.
- **Thinking models fit their budget.** A Claude model that thinks first no longer runs out of answer and fails the enrichment test; when one does, the message says so.
- The Tables tab's Records column shows FileMaker's count at the last sync, not the last scan. Vectors go when their records go.
- Keep working while a sync runs, with a strip at the top. The deletion check shows progress. Changing a table's fields warns that it re-reads the table.
- Docs rebuilt: a short README, INSTALL, HOW-IT-WORKS, API, and RECORD-UPDATES for the optional one-record script. "Site password" throughout; "API key" means an AI provider's key.
- Fixes from the review: the sign-in redirect stays on the site, a record refresh can't collide with a sync, the manifest is written after each table.

## 0.9.4, 2026-10-19 (demo box)

- Model lists come live from each provider's own list, cached a day. No model name is hardcoded or guessed from its shape.
- A match percentage at the right of each result row (on trial; signal bars are planned in its place).
- Node 26 (Node 20 ended 30 April 2026) and DuckDB 1.5.6. An index written by 1.5.3 opens as is.
- Express and its query parser patched (npm audit).
- The four-language search screen from 14 October is removed. It was a class demo.

## 2026-09-13, MIT

- Mitos is MIT licensed. The custom Mitos License (attribution, no resale) is withdrawn. Use it, change it, ship it, sell it; keep the copyright notice.

## 0.9.3, 2026-09-10 (on the release box first)

- BM25: a full-text index over titles, search text and notes, built at the end of every sync (DuckDB's fts extension, baked into the image). The exact phase still finds candidates by prefix, so "nav" still finds Navarre; BM25 weighs them by term rarity and length.
- Reciprocal rank fusion replaces the fixed rank bands when exact, close-spelling and semantic lists merge. Weighted, so an exact hit still outranks a look-alike.

## 0.9.2, 2026-09-10

- The sync log says how it read: fields by $select or whole rows, the page size, the watermark of an incremental pull, the resume row after a crash.
- Enrichment sits above Semantic search everywhere the stages are listed: the cheaper, deterministic one first.
- Every model picker has Other..., a typed model id, and the wizard's picker is the live list from the provider.
- The setup step is called API key, and its text no longer claims search makes no AI call.
- The beacon leaves 1.0. Records update on the timed sync; the record-by-record route stays in the code for later.

## 0.9.1, 2026-09-10

- No model call while a person types. The exact search follows every keystroke; the AI phase (Enhanced search, Semantic search, Pick the best) waits for Return, and the results line says so.

## 0.9.0, 2026-09-09

- Deterministic, type-aware search: the whole input is read as one kind (words, number, range, date, date range, month, email, phone) and only the fields that can hold that kind are searched. Every hit carries a reason in words. Results are balanced across tables.
- The name table (Bob finds Robert) and close spellings by Jaro-Winkler, both without a model.
- Five optional AI stages, each with its own switch, model and time budget: close spellings, similar meaning (vectors in their own DuckDB file), search notes written at sync time, reading the search into the engine's syntax, and picking the best match. A late or broken stage never removes an exact hit.
- Two-phase search: `GET /api/search` answers in tens of milliseconds; `GET /api/search/ai` fills in the model stages behind it. Four providers (Anthropic, OpenAI, Google, Voyage), raw fetch, API keys in Settings.
- The eight-step setup wizard: Connect (tested before it is saved), Files, API key, Scan with progress, Tables, AI stages, Sync, Add to your file. Save a Copy as XML hints for real names and keys.
- Streaming sync: pages go to disk as they arrive with a checkpoint per page and resume after a crash; the index step reads 20,000 rows a batch; a crash report names the table and the machine size; free disk is checked before a full pull.
- Quoted `$select` so FileMaker Server 2026 honors a field list (a full 10,511-row pull went from six minutes to 8.5 seconds); whole rows only after both encodings are refused.
- The paid-pass gate: switching semantic search or enrichment on shows the count and the price first; a plain sync caps at 5,000 vectors and 1,000 notes; a ledger of every paid pass.
- The kit: the FileMaker beacon script (OnWindowTransaction to `POST /api/records/changed`), the go-to-record scripts, the `cMitosJSON` convention, one unique table word per table.
- The eval (`npm run eval`, 29 deterministic cases) and the simulator (`npm run simulate`, hundreds of generated searches, stage sets compared).
