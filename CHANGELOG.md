# Changelog

Newest first. The commit log has the detail; this is the story.

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
- Two-phase search: `GET /api/search` answers in tens of milliseconds; `GET /api/search/ai` fills in the model stages behind it. Four providers (Anthropic, OpenAI, Google, Voyage), raw fetch, keys in Settings.
- The eight-step setup wizard: Connect (tested before it is saved), Files, AI key, Scan with progress, Tables, AI stages, Sync, Add to your file. Save a Copy as XML hints for real names and keys.
- Streaming sync: pages go to disk as they arrive with a checkpoint per page and resume after a crash; the index step reads 20,000 rows a batch; a crash report names the table and the machine size; free disk is checked before a full pull.
- Quoted `$select` so FileMaker Server 2026 honors a field list (a full 10,511-row pull went from six minutes to 8.5 seconds); whole rows only after both encodings are refused.
- The paid-pass gate: switching semantic search or enrichment on shows the count and the price first; a plain sync caps at 5,000 vectors and 1,000 notes; a ledger of every paid pass.
- The kit: the FileMaker beacon script (OnWindowTransaction to `POST /api/records/changed`), the go-to-record scripts, the `cMitosJSON` convention, one unique table word per table.
- The eval (`npm run eval`, 29 deterministic cases) and the simulator (`npm run simulate`, hundreds of generated searches, stage sets compared).
