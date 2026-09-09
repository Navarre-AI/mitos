# Mitos rules

The living rulebook. These are enforced in code; changes here should be
reflected there.

1. **FileMaker is the source of truth. Zero hallucination on data.** Every
   value a user reads as record data comes verbatim from a source row
   (`display` JSON). No generated text is ever shown as record data.

2. **Search is deterministic.** The same query on the same index returns the
   same list, in the same order, with no model call. Every rank has a reason
   a person can read (which words matched, where). Semantic search is
   parked, not forbidden; when it returns it sits beside this, not instead.

2a. **The type decides the fields.** The whole input is read as one kind of
   thing (words, number, range, date, date range, email, phone) before any
   field is searched, and only fields that can hold that kind are searched.
   The kind is returned with the results and shown to the person. Types are
   never guessed from text at search time: the indexer assigns them per
   field from the column type.

2b. **The AI stages are optional, independent, and never in the way.** Five
   stages sit on top of the exact search: close spellings (no model), similar
   meaning (a vector per record), search notes (a model writes them at sync
   time), reading the search (a model rewrites words into the exact syntax),
   and picking the best (a model reorders the short list). Each has its own
   switch, model and time budget. The exact list is shown before any model
   is asked and is never removed by one. A late or broken stage records an
   error in `stages` and the search still answers. Search notes are searched
   and never shown; a hit through them says so in `why`.

3. **Unchanged rows cost nothing.** The content hash covers the source text
   and the display values. Re-running a build rewrites only what changed.

4. **Balanced results.** No table floods the list. Every table with a hit
   appears. Per-table cap plus round-robin is the whole rule; keep it
   explainable.

5. **You never see the plumbing.** No table occurrence names, UUIDs, SQL, or
   scores presented as facts.

6. **Fewest moving parts.** Express is the only npm dependency. The one AI
   call (schema naming) uses raw fetch. DuckDB is a subprocess, not a native
   module. No frameworks in the frontend.

7. **Nothing runs unasked.** Boot never syncs. A sync starts when a person
   presses the button, when the auto-sync interval is due, or when a
   FileMaker schedule calls the endpoint.

8. **Cancel is immediate.** The stop flag aborts the request in flight and is
   checked between pages and between tables. A table is kept whole or not at
   all.

9. **An empty index is a setup state, not a search result.** It gets its own
   words and its own button; it is never "0 results".
