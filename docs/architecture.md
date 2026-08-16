# Architecture

## Boundaries and data flow

The system reads SampleHub MySQL and S3 with read-only credentials. It owns only Meilisearch documents, Redis jobs, a local SQLite control/caption database, and evaluation fixtures. It never updates SampleHub rows, descriptions, or objects.

```text
SampleHub MySQL ─┐
                 ├─> BullMQ indexer ─┬─> multilingual E5 passages ─┐
SampleHub S3 ────┘                   ├─> SigLIP 2 images ──────────┤
                                    ├─> DINOv2 images ────────────┼─> Meilisearch
                                    └─> Florence 2 captions ──────┘
                                               │                         ↑
                                               └─> SQLite cache          │
                                                                          │
Next.js web/admin ─> NestJS API ─> E5 + active visual provider ───────────┘
                         │
                         └─> SQLite run state, ranking, evaluation
```

All four providers are lazy-loaded behind one priority scheduler. Interactive query work has priority over indexing work at task boundaries. Model-specific device settings may select MPS or CPU.

## Catalog and generated data

Eligible products satisfy:

```sql
deleted_at IS NULL AND COALESCE(is_private, 0) = 0 AND type = 'plan_product'
```

One source product becomes one search document. `groupId` is the first 32 hex characters of SHA-256 over normalized `[series, brand]`. Results are distinct by group while facets remain product-level.

Florence captions only the thumbnail-designated original image, falling back to the first ordered original. The caption is stored in the local cache with its image SHA-256, model ID/revision, task, and timestamps. `generatedVisualCaption` is searchable in Meilisearch but excluded from displayed attributes and public product contracts.

The E5 passage contains labeled public fields followed by the generated visual description and remaining source details. The inference service applies the required `passage:` prefix; query requests receive `query:`. Inputs are truncated to 512 tokens, average-pooled, and normalized.

## Vectors and retrieval

Each v2 document stores:

- `e5_text`: one 768-dimensional multilingual product-passage vector
- `siglip_image`: representative or all-image 768-dimensional vectors according to `IMAGE_EMBEDDING_MODE`
- `dinov2_image`: matching 768-dimensional DINOv2 Base pooler/CLS vectors, L2 normalized

No new `siglip_text` product vector is generated. SigLIP text encoding remains useful for searching the SigLIP visual vector space. DINOv2 is image-only and cannot embed a text query into its vector space.

| Mode | SigLIP active | DINOv2 active |
| --- | --- | --- |
| `keyword` | raw lexical baseline | raw lexical baseline |
| `text_semantic` | E5 query against `e5_text` | E5 query against `e5_text` |
| `text_hybrid` | separate keyword and E5 branches | separate keyword and E5 branches |
| `text_visual` | SigLIP text against `siglip_image` | unavailable |
| `image_visual` | SigLIP image against `siglip_image` | DINOv2 image against `dinov2_image` |
| `auto` | keyword + E5 + optional SigLIP text/image branches | keyword + E5 + optional DINOv2 image branch |

Default auto weights are keyword/E5/SigLIP-text-to-image `0.40/0.40/0.20` for text-only SigLIP queries and keyword/E5/SigLIP-text-to-image/active-image `0.15/0.25/0.10/0.50` for combined SigLIP queries. DINOv2 drops the incompatible text-to-image branch and retains the keyword, E5, and image weights. Values are relative reciprocal-rank weights, stored as ranking v2 settings in SQLite, and editable in `/admin`; raw scores from different models are never compared directly.

Auto mode caches the live color, material, effect, surface, and origin facet vocabulary and combines exact catalog phrases with curated English, Traditional Chinese, and Simplified Chinese synonyms. Attribute families can span fields: for example, stone intent becomes an OR across matching material and effect values, while independent concepts such as color and stone remain AND constraints. The first mentioned color is treated as the structured base color; secondary colors remain in the semantic/visual query unless the user explicitly joins colors with `and` or `or`.

Explicit filters override derived fields. Preferred candidates are fused separately and interleaved with unfiltered fallback candidates at approximately 85/15 (six preferred results per fallback), while explicit filters remain mandatory everywhere. Each result reports its actual contributing branches and primary match source. Specialist modes bypass catalog interpretation, keeping them useful as evaluation baselines. Facets without values are omitted by the web UI; relevance is the only supported sort while the source has no prices.

The API checks active index embedders on a short cache. Before the v2 swap it encodes legacy semantic queries with SigLIP and searches `siglip_text`; after the swap it automatically uses E5. This keeps stable search available during migration. The global visual-model setting is persisted in SQLite. DINOv2 is effective only when the stable index exposes its embedder and the completed fingerprint matches the running configuration; otherwise the API falls back to SigLIP. Search cursors include the active provider so pagination cannot silently cross a model switch.

## Index lifecycle

A full build writes to a run-specific v2 shadow index and generates both SigLIP and DINOv2 image vectors. Caption cache hits are reused; missing captions are generated in small batches. Input-specific HTTP 422 responses recursively split image and caption batches so one invalid asset cannot discard valid neighbors. A caption or caption-model failure is recorded but the product continues with structured E5 text. S3 and per-provider image failures remain part of the image-success gates.

Only a complete, count-matched, image-gated, smoke-tested shadow index swaps into the stable name. Watermarks use the full-build start time so source changes during a long rebuild are captured by the next incremental. Incremental indexing refuses legacy vector settings and otherwise rehydrates changed products, maintains DINOv2 when its embedder exists, invalidates captions by content hash/model/task, deletes newly ineligible products, and advances watermarks after success.

The explicit `visual_backfill` run adds DINOv2 to an existing v2 stable index without replacing it. Because Meilisearch validates all documents when a `userProvided` embedder is added, the initialization pass first merges `dinov2_image: null` into every existing vector map, then registers the embedder. Each embedding update retrieves and verifies the existing E5/SigLIP vector map, merges the DINO vector, and uses a partial document update. Same-fingerprint retries skip valid completed vector sets. Readiness is recorded only after every product is visited and image success reaches 95%, so a partial or failed backfill never makes DINOv2 selectable.

## Local control data

SQLite stores migrations, index runs and failures, caption cache entries, stream watermarks, ranking v2 settings, active visual-model/readiness settings, evaluation queries, judgments, and reports. Legacy ranking JSON is left intact under its original key. Evaluation images live under `data/evaluation`; shopper uploads remain in memory and are discarded after each request.
