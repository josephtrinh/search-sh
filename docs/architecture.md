# Architecture

## Boundaries and data flow

The system reads SampleHub MySQL and S3 with read-only credentials. It owns only Meilisearch documents, Redis jobs, a local SQLite control/caption database, and evaluation fixtures. It never updates SampleHub rows, descriptions, or objects.

```text
SampleHub MySQL ─┐
                 ├─> BullMQ indexer ─┬─> multilingual E5 passages ─┐
SampleHub S3 ────┘                   ├─> SigLIP 2 images ──────────┼─> Meilisearch
                                    └─> Florence 2 captions ──────┘
                                               │                         ↑
                                               └─> SQLite cache          │
                                                                          │
Next.js web/admin ─> NestJS API ─> E5 query + SigLIP text/image ──────────┘
                         │
                         └─> SQLite run state, ranking, evaluation
```

All three providers are lazy-loaded behind one priority scheduler. Interactive query work has priority over indexing work at task boundaries. Model-specific device settings may select MPS or CPU.

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

No new `siglip_text` product vector is generated. SigLIP text encoding remains useful for searching the visual vector space.

| Mode | Retrieval |
| --- | --- |
| `keyword` | raw lexical baseline |
| `text_semantic` | E5 query against `e5_text` |
| `text_hybrid` | separate keyword and E5 branches |
| `text_visual` | SigLIP text against `siglip_image` |
| `image_visual` | SigLIP image against `siglip_image` |
| `auto` | modality-aware weighted federation plus conservative aliases |

Default auto weights are keyword/E5/SigLIP-text-to-image `0.40/0.40/0.20` for text-only queries and keyword/E5/SigLIP-text-to-image/SigLIP-image `0.15/0.25/0.10/0.50` for combined queries. Values are relative, stored as ranking v2 settings in SQLite, and editable in `/admin`.

Auto mode recognizes conservative English, Traditional Chinese, and Simplified Chinese aliases for canonical origin, color, effect, porcelain, and non-slip values. Explicit filters override derived ones. Derived constraints use 85% filtered branches plus 15% unfiltered fallbacks; explicit filters remain mandatory everywhere. Specialist modes do not apply aliases, keeping them useful as evaluation baselines.

The API checks active index embedders on a short cache. Before the v2 swap it encodes legacy semantic queries with SigLIP and searches `siglip_text`; after the swap it automatically uses E5. This keeps stable search available during migration.

## Index lifecycle

A full build writes to a run-specific v2 shadow index. Caption cache hits are reused; missing captions are generated in small batches. Input-specific HTTP 422 responses recursively split image and caption batches so one invalid asset cannot discard valid neighbors. A caption or caption-model failure is recorded but the product continues with structured E5 text. S3 and SigLIP failures remain part of the existing image-success gate.

Only a complete, count-matched, image-gated, smoke-tested shadow index swaps into the stable name. Watermarks use the full-build start time so source changes during a long rebuild are captured by the next incremental. Incremental indexing refuses legacy vector settings and otherwise rehydrates changed products, invalidates captions by content hash/model/task, deletes newly ineligible products, and advances watermarks after success.

## Local control data

SQLite stores migrations, index runs and failures, caption cache entries, stream watermarks, ranking v2 settings, evaluation queries, judgments, and reports. Legacy ranking JSON is left intact under its original key. Evaluation images live under `data/evaluation`; shopper uploads remain in memory and are discarded after each request.
