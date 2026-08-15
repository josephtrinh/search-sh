# Architecture

## Boundaries

The system reads the SampleHub MySQL catalog and S3 images with read-only credentials. It owns only Meilisearch documents, Redis jobs, a local SQLite control database, and local evaluation fixtures. It never mutates the SampleHub schema, rows, or objects.

```text
SampleHub MySQL ─┐
                 ├─> BullMQ indexer ─> SigLIP inference ─> Meilisearch
SampleHub S3 ────┘          ↑                                  ↑
                            │                                  │
                       Redis queue                       NestJS API
                                                               ↑
                                                    Next.js web/admin
                            SQLite <──── run state/evaluation ──┘
```

## Catalog contract

Eligible products satisfy all three source predicates:

```sql
deleted_at IS NULL AND COALESCE(is_private, 0) = 0 AND type = 'plan_product'
```

One source product becomes one search document. A stable `groupId` is the first 32 hex characters of SHA-256 over the JSON tuple of normalized `[series, brand]`; normalization trims and lowercases using the English locale. Search results are distinct by `groupId`, while facet counts remain product-level. Group detail fetches all exact documents and subdivides them by model.

Only public merchandising/specification fields are indexed. Internal notes, unit rate, discount, supplier/organization/author identifiers, and access-control fields are excluded. See [source mapping](samplehub-api.md).

## Vectors and retrieval

The inference service exposes independent normalized text and image embeddings from pinned SigLIP 2. Each document stores:

- `siglip_text`: one vector generated from labeled public product fields
- `siglip_image`: vectors selected by `IMAGE_EMBEDDING_MODE`; `thumbnail` uses the original asset designated by `thumbnail_id` and falls back to the first ordered original, while `all` embeds every image in batches of eight

SigLIP 2 text inputs are truncated to the model-declared context length (64 positions for the pinned model). Identity and primary discovery fields are placed first in the embedding template so they survive truncation; full untruncated fields remain available to Meilisearch keyword retrieval.

The API constructs Meilisearch branches according to the requested mode:

| Mode | Retrieval |
| --- | --- |
| `keyword` | lexical query only |
| `text_semantic` | text vector, semantic ratio 1 |
| `text_hybrid` | lexical + text vector |
| `text_visual` | text vector searched against image vectors |
| `image_visual` | uploaded image vector against image vectors |
| `auto` | weighted federation of applicable text and image branches |

Text and image embeddings are requested concurrently when both are supplied. Meilisearch weighted federation applies one global `groupId` distinct rule. Ranking settings are held in SQLite and editable through the admin UI. Cursor pagination is an opaque encoded offset; it is not snapshot-isolated.

## Index lifecycle

A full build writes to a run-specific shadow index. It must satisfy:

1. every eligible product was processed;
2. shadow document count equals the source count;
3. at least 95% of referenced images embedded successfully;
4. a search smoke query succeeds.

Only then is the shadow index atomically swapped with the stable index. The old index is smoke-tested through the stable name and then deleted. Product and file watermarks are set to the full-build start time so changes made during the rebuild are captured by the next incremental run.

Incremental indexing merges the product and file change streams, rehydrates changed eligible products, removes documents that became ineligible/deleted, and advances both watermarks only after successful completion.

## Local control data

SQLite stores schema migrations, index runs and image failures, stream watermarks, ranking settings, evaluation queries, relevance judgments, and evaluation reports. Evaluation images live under `data/evaluation`; shopper uploads remain in memory and are discarded after the request.
