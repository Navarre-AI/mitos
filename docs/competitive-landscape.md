# FileMaker search landscape: is anyone already doing Mitos?

Research date: 2026-07-23. Every claim below is web-verified; sources at the end.
Short answer: nobody ships an enrichment-first, cross-table-balanced, hosted
semantic search for FileMaker. The closest things are a free Beezwax demo
technique (in-file, no enrichment, admits its own scale problems) and Claris's
fast-moving but single-table native features.

## The Beezwax answer first

Your memory is right: the product is **LOgiCATOR** (their capitalization),
by Mark Scott at Beezwax. It is a modular, rule-based **lexical** search UI:
a self-contained .fmp12 module wired in with one external data source and two
scripts, Boolean any/all/none groups, saved searches. Free. Built for
FileMaker 16 in 2017; the product page still exists and says "FileMaker Pro 17
or newer," with no sign of development since. No AI, no embeddings. It
supplements Find mode; it is not in Mitos's lane.

The Beezwax work that IS in the lane: a three-part semantic search blog series
(June 2024, part 3 updated December 2025) ending in **bzUnifiedSearch-FM**, a
free Claris Marketplace demo: cross-table semantic search via one shared
Embedding table, one Perform Semantic Find, cosine ranking. Two things worth
noting: their own write-up flags performance walls at scale with the shared
table, and it makes no attempt to balance results across tables. No enrichment
pass. In-file only, free demo, not a maintained product.

One correction to the collective memory: no "bElastic" Elasticsearch product
or blog series from Beezwax appears to exist.

## Claris native (the moving target)

- **FM 2024 (21):** Configure AI Account, Insert Embedding (+ in Found Set),
  Perform Semantic Find, CosineSimilarity. The foundation fmSR AI builds on.
- **FM 2025 (22):** Perform Find by Natural Language, image embeddings,
  Cohere support, the open-source AI Model Server bundled with FMS (local
  embedding models, no cloud), early RAG features.
- **FM 2026 (26, June 24, 2026):** Gemini provider, RAG spaces, embedding
  caches that sync across servers, JSONL inputs, batched faster embedding.
  Agentic coding not in 26.0; previews promised "later this summer."
- **Claris MCP (Dec 2025, FMS 22.0.2+):** FileMaker Server as an MCP server,
  auto-generated per-table data tools plus script tools. Natural-language data
  access, not ranked search.

Native limits that define the gap: Perform Semantic Find targets one field in
one table per call, all vectors from one model, no enrichment pipeline, no
cross-table balancing. Cross-table means the Beezwax-style shared-table
workaround, with its scale ceiling.

## Everything else found

| Product | Maker | What it is | Status |
|---|---|---|---|
| fmSearchResults 7 | Matt / Direct Impact Solutions | Lexical, type-aware, multi-table, one field. The incumbent (yours) | Free; note: FileMakerProGurus' tag page calls it "no longer available," worth tidying the distribution story |
| LOgiCATOR | Beezwax | Lexical rule-builder UI | Free, dormant since ~FM17 |
| bzUnifiedSearch-FM | Beezwax | Cross-table semantic demo, shared embedding table | Free demo, June 2024 |
| Empowered_GPT | Empowered Data Solutions | Chat + semantic search demo; the only found FileMaker + external vector store (Pinecone) pairing | Marketplace demo, mid-2024 |
| ProofChat | Proof+Geist | AI chat embedded in FM apps: NL queries, charts, deep links, record updates. Chat-with-your-data, not ranked retrieval. Closest commercial adjacent product (competes more with Pythia than Mitos) | Active, freemium, self-hosted, BYO key |
| SeedCode | SeedCode | Old System-Wide Quick Search technique (archived); company now all-in on DayBack calendars | Out of the search game |
| 360Works | 360Works | No search or AI search product. MirrorSync 6 syncs FM to SQL/Salesforce/DynamoDB, no vector or search-engine target | Active, different lane |
| MBS Plugin | MonkeyBread | Local LLM plumbing (llama.cpp, Apple FoundationModels). Chat-focused; no embedding/vector functions documented | Active, different lane |
| Community techniques | Ian Jempson, Soliant | Hybrid lexical-prefilter-then-semantic re-rank (a good idea worth stealing), on-prem LLM semantic search | Blog posts, not products |

Not found anywhere, marked unverifiable or nonexistent: "fmESQL" as a product,
any Algolia/Typesense/Weaviate/pgvector productized FileMaker integration, any
hosted FileMaker search service. The sidecar plumbing exists in pieces (CData
JDBC for Elasticsearch, a Logstash gist, n8n connectors, MirrorSync) but
nobody has assembled sync-out, enrich, embed, serve-ranked-results-back.

## Gap analysis: what nobody else is doing

1. **Enrichment before embedding.** Everyone embeds raw field text. Nobody
   runs a generative expansion pass first. This is the moat, and it is why
   the demo cases (Shavon Murphy, cheap shoes, Cyrillic names) work.
2. **Balanced cross-table results.** The only cross-table player explicitly
   does not balance and admits scale limits. Native is one table per call.
3. **A hosted sidecar, at all.** Zero productized offerings. Mitos would be
   the first "search service for FileMaker."
4. **Search-quality engineering as product.** Hybrid lexical+semantic,
   re-ranking, per-table thresholds exist only as blog technique. (Jempson's
   lexical-prefilter-then-semantic-rerank maps neatly onto the planned
   type-detection front door.)

## The risk

Claris is commoditizing the in-file basics on a yearly cadence: RAG spaces,
multi-server embedding caches, batched embedding, agentic previews coming.
The durable position is what native structurally does not do: enrichment,
cross-table balance, per-user learning, and scale beyond in-file vector
scans. Ship the sidecar value, keep the all-FM edition (SearchResults AI) as
the free on-ramp, and let Claris's improvements make the on-ramp better.

## Sources

Beezwax: beezwax.net/products/logicator; blog.beezwax.net (LOgiCATOR intro
2017; semantic search parts 1-3, 2024); marketplace.claris.com/detail/2681.html.
Claris: help.claris.com (perform-semantic-find, insert-embedding, claris-mcp);
claris.com/blog (2024 semantic search, 2025 release); claris.com/filemaker/ai-search.
FM 2026: soliantconsulting.com (executive summary), luminfire.com 2026-06-24,
skeletonkey.com launch post. Third parties: proofchat.ai;
marketplace.claris.com/detail/2598.html and /2693.html (Empowered);
empowereddatasolutions.com; 360works.com (ScriptMaster, MirrorSync 6);
mbsplugins.eu (Llama component); marketplace.claris.com/detail/2404.html and
navarre.training/searchresults (fmSearchResults); archive.seedcode.com;
seedcode.com. Sidecar plumbing: cdata.com (Elasticsearch JDBC),
gist.github.com/fsans, n8n.io, ottomatic.cloud. Techniques:
medium.com/transforming-digital (Jempson hybrid search),
soliantconsulting.com (on-prem LLM semantic search), dbservices.com
(chatbots, function calling, Claris MCP), portagebay.com (AI in FM 2025,
Claris MCP), community.claris.com (App Assistant).
