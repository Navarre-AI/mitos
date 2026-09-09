# Research memo: the five optional AI stages

Date: 2026-09-08. API facts were checked against vendor docs on this date. Latency numbers are third-party and change monthly; measure before you trust them.

## A. Embedding input for short structured records

**Format.** Write each row as one short natural sentence. Not `Field: value` lines, not JSON. Embedding models are trained on prose; key names and punctuation pull the vector off centre. One study reports +19% Recall@10 and +27% MRR after converting JSON records to sentences ([Towards Data Science](https://towardsdatascience.com/optimizing-vector-search-why-you-should-flatten-structured-data/)). Example: `Company Acme Systems at 12 Main St, Portland, Oregon.` Strip newlines.

**Table name.** Include it once as a plain word at the start. Do not repeat field names.

**Prefixes.**
- OpenAI text-embedding-3: none. Same call for query and document.
- Gemini `gemini-embedding-001`: `taskType` `RETRIEVAL_DOCUMENT` at index time, `RETRIEVAL_QUERY` at search time. `gemini-embedding-2` does not accept taskType; state the task in the text ([Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings)).
- Voyage: `input_type` `document` / `query`. Voyage prepends its own instruction, so add none ([Voyage FAQ](https://docs.voyageai.com/docs/faq)).

**512 dims and normalization.** All three families are Matryoshka-trained, so a 512 prefix is safe. Request the size from the API; do not cut locally.
- OpenAI `dimensions: 512`: output is already length 1 ([guide](https://developers.openai.com/api/docs/guides/embeddings)).
- Gemini 001 `outputDimensionality: 512`: **you must L2-normalize**; only 3072 comes normalized. Embedding-2 normalizes for you.
- Voyage `output_dimension: 512`: length 1.
Apply one `normalize()` in Mitos to every vector regardless of provider. Then `array_cosine_similarity` equals the dot product.

**Cutoff.** No universal number. Text-embedding-3 scores run low; the community rule of thumb is about 0.45 for "related" ([OpenAI forum](https://community.openai.com/t/rule-of-thumb-cosine-similarity-thresholds/693670)). Gemini and Voyage run higher (0.6 to 0.8). Store a per-provider floor (OpenAI 0.40, Gemini 0.65, Voyage 0.60) plus a relative rule: keep hits within 0.10 of the top semantic score, cap 15. Tune on `eval/cases.json`.

## B. Fusion

RRF with k=60 is a consensus vote. `1/(60+rank)` is nearly flat at the top, so a document that is #1 in one list and absent elsewhere loses to one that is mediocre in two lists ([RRF and k=60](https://dev.to/ji_ai/reciprocal-rank-fusion-why-k60-buries-your-best-hit-525c)). That breaks the Mitos promise: exact stays on top, every rank has a reason.

**Use tiered concatenation.**
1. Exact hits, existing order, existing reasons.
2. Fuzzy hits not already shown, by similarity: "Name is close to 'Acme Systems' (0.93)".
3. Semantic hits not already shown, by cosine: "Similar meaning to '...'".
4. Rerank may reorder inside tiers 2 and 3 and may promote one item to a "best answer" slot. It never demotes an exact hit.

RRF is fine only as a candidate generator for the reranker (union of the lists, depth 15 to 30). Skip weighted RRF and score normalization; both need labeled data.

## C. Fuzzy names with Jaro-Winkler

**Thresholds.** Patient-matching studies: JW at 0.9+ gives very high link quality; it degrades at 0.8 ([PubMed](https://pubmed.ncbi.nlm.nih.gov/15360771/), [IJPDS](https://ijpds.org/article/view/855)). Common practice: 0.95+ confident, 0.85 to 0.94 probable, below 0.85 noise. Mitos: show at 0.85, mark "likely" at 0.92+.

**Normalize first.** Lowercase, strip accents and punctuation, drop honorifics and suffixes (Mr, Dr, Esq, Jr, III, Inc, LLC, Ltd, GmbH), collapse spaces. Also compare the space-free form (`acmesystems`) so "Ac me systems" keeps its prefix bonus.

**Per token, then combine.** Whole-string JW is order sensitive. Compute three scores and take the max:
- Sorted tokens joined, JW (handles "Smith John").
- Best-pair token JW: each query token against its best record token, averaged (handles "juan valencia" vs "Juan Carlos Valencia").
- Whole-string JW.
Initials: a one-letter query token matches any record token with that first letter at 0.9. Nicknames: a small static map (bill/william, bob/robert, mike/michael), expanded on the query side; enrichment writes them on the record side.

DuckDB: `jaro_winkler_similarity` as the score, `damerau_levenshtein` only as a tie-break for short tokens. Pre-filter by first letter or length band.

## D. Query understanding prompts

**Constrain the output.**
- OpenAI Responses API: `text.format = { type: "json_schema", strict: true, schema }`, `additionalProperties: false`, all properties `required` ([docs](https://developers.openai.com/api/docs/guides/structured-outputs)).
- Anthropic: `output_config.format = { type: "json_schema", schema }`. GA, no beta header; `output_format` is deprecated. No `minimum` or `maxLength` in the schema ([docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).
- Google: `generationConfig.responseMimeType: "application/json"` plus `responseSchema` ([docs](https://ai.google.dev/api/generate-content)).

**Prompt shape.** Cached system prompt: the engine syntax in one table (words, "phrase", =whole, *contains, 100...200, >100, date...date, email, phone); the tables with typed columns and one example value each; 6 to 8 few-shot pairs; rules: never invent a field or value, unknown is null. User turn: `today: 2026-09-08 (Tuesday)` then the raw query. Relative dates only work with the date in the prompt; the model then writes `7/1/2026...9/8/2026` itself. Never accept "since July" as output.

**Settings.** temperature 0, max_tokens 200 to 300, reasoning off (OpenAI lowest `reasoning.effort`, Gemini thinking budget 0, Haiku without thinking). Plan: `{ tables:[], syntax:"", semantic:"", fuzzy_names:[], drop:[] }`. Validate against the real table list; fall back to the raw query on any mismatch.

**Latency.** March 2026 third-party numbers on 200 to 500 token prompts: Haiku 4.5 TTFT about 0.6 s, Gemini 2.5 Flash about 0.45 s ([benchmark](https://www.kunalganglani.com/blog/llm-api-latency-benchmarks-2026)). Newer small models are slow with reasoning on: GPT-5.6 Luna low effort about 1.7 s TTFT, Gemini 3.5 Flash-Lite 6 to 11 s ([Artificial Analysis](https://artificialanalysis.ai/models/gpt-5-6-luna-low/providers)). Budget 0.5 to 1.5 s per plan call with reasoning off. Measure per provider in `scripts/eval.mjs`.

## E. Rerank and decision

**Prompt.** Listwise, one call, 15 candidates max as `[id] one-line rendering` (the same sentence you embedded). Return JSON `{ order: [ids], best: id|null, confidence: 0..1, why: "" }`. Ids only, schema-enforced.

**Pitfalls.** Position bias is strong: late items are rarely moved to the top ([positional bias](https://arxiv.org/abs/2604.03642), [preference consistency](https://arxiv.org/abs/2608.03091)). Mitigations: send candidates in deterministic-score order (the bias then helps), drop any returned id not in the input, append missing ids in original order.

**Confidence.** A self-reported 0.8 is not calibrated; treat it as one vote. Fellegi-Sunter gives the frame (link above upper, review between, non-link below) but you set the thresholds ([overview](https://www.zingg.ai/post/fellegi-sunter-model-limitations-modern-entity-resolution)). Rule: declare ONE answer only when (a) #1 beats #2 by a clear gap (sole exact hit, JW gap >= 0.08, or cosine gap >= 0.10) AND (b) the reranker names the same id with confidence >= 0.8. Otherwise show the list. Below the floor show "no close match".

**Cheap alternative first.** Rule (a) needs no model call. Ship it first; add the LLM vote only if the eval shows it changes outcomes.

## F. Perceived speed

Two phases. Phase 1 (deterministic + fuzzy in DuckDB) must land inside the typing rhythm: under 100 ms feels instant, over 300 ms feels laggy ([typeahead design](https://sujeet.pro/articles/design-search-autocomplete)). Phase 2 (plan, embedding, rerank) appends below a thin "Looking wider..." line and never reorders what is on screen.

- Debounce 200 ms, minimum 2 characters. That cuts requests about 70% with no visible loss; 100 ms doubles cost for under 40 ms gain ([OneUptime](https://oneuptime.com/blog/post/2026-02-06-monitor-search-autocomplete-typeahead-opentelemetry/view)).
- Phase 2 fires only after a longer pause (500 to 700 ms) or Enter.
- `AbortController` on every request; drop stale phase-2 results.
- Cache query embeddings and plans by normalized query (in-memory LRU).
- Keep phase 2 under about 1 s to feel like the same search. Past 2 s users have moved on.

## G. Enrichment prompts

Request searchable text, not knowledge. Fixed fields per record: `name_variants` (nicknames, "Last, First", initials, no-space form), `abbreviations`, `plain_description` (one sentence in the record's own words), plus per kind: `price_words` for products (budget, mid-range, premium, from the stored price), `sentiment_words` for reviews and notes. Forbid any fact, number, or guess not in the record. Under 60 words per record. Enforce with a JSON schema of string arrays ([Vespa enrichment](https://blog.vespa.ai/document-enrichment-llm/)). Index it as a separate text column, searched but never shown; keep it out of the main vector.

**Cost.** Batch 10 to 20 records per call, each tagged with its id; the schema returns `[{id, ...}]`. Validate ids, retry only the missing. Use batch APIs (50% off on Anthropic and OpenAI). 100k rows at 150 tokens each is about 15M input tokens: a few dollars. Re-enrich only when the row hash changes.

## Verified API shapes and ids (2026-09-08)

**OpenAI embeddings.** `POST /v1/embeddings` `{ model: "text-embedding-3-small" | "text-embedding-3-large", input: string | string[], dimensions: 512, encoding_format: "float" }`. Max 2048 inputs and 300k tokens per request, 8192 per input ([reference](https://developers.openai.com/api/docs/api-reference/embeddings/create)).

**Gemini embeddings.** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent` `{ model: "models/gemini-embedding-001", content: { parts: [{ text }] }, taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 512 }`. Batch: `:batchEmbedContents` with `{ requests: [ ...same objects... ] }`, response `embeddings[].values`. The reference now nests `taskType` and `outputDimensionality` inside `embedContentConfig`; top-level is deprecated but works ([reference](https://ai.google.dev/api/embeddings)). Models: `gemini-embedding-001` (text, $0.15/M, manual normalization below 3072), `gemini-embedding-2` (multimodal, $0.20/M text, auto-normalized, no taskType).

**Voyage.** `POST https://api.voyageai.com/v1/embeddings` `{ model: "voyage-4-lite", input: string[], input_type: "document" | "query", output_dimension: 512 }`. Family: `voyage-4-lite` ($0.02/M), `voyage-4` ($0.06/M), `voyage-4-large` ($0.12/M); shared vector space, 200M tokens free ([docs](https://docs.voyageai.com/docs/embeddings), [pricing](https://docs.voyageai.com/docs/pricing)).

**Fast cheap chat models.**
- OpenAI: `gpt-5.6-luna`, $0.20 / $1.20. Smallest current model; set reasoning to the lowest level ([models](https://developers.openai.com/api/docs/models)).
- Anthropic: `claude-haiku-4-5` (pinned `claude-haiku-4-5-20251001`), $1 / $5. Retirement not before 2026-10-15, so keep the id in config ([models](https://platform.claude.com/docs/en/about-claude/models/overview)).
- Google: `gemini-2.5-flash-lite` $0.10 / $0.40, cheapest and fastest with thinking off. `gemini-3.1-flash-lite` $0.25 / $1.50 and `gemini-3.5-flash-lite` $0.30 / $2.50 are smarter, slower ([pricing](https://ai.google.dev/gemini-api/docs/pricing)).
