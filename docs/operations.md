# Operations

## Services and health

Default local ports are web `3000`, API `8000`, inference `8100`, Meilisearch `7700`, and Redis `6379`.

```bash
curl http://127.0.0.1:8100/health
curl http://127.0.0.1:8000/v1/health
curl http://127.0.0.1:7700/health
redis-cli -h 127.0.0.1 -p 6379 ping
```

The API health response reports inference and Meilisearch independently. A missing stable index is expected before the first full build; search returns service unavailable rather than silently returning empty results.

## Preflight

Start infrastructure and inference, then run:

```bash
pnpm --filter @samplehub/indexer preflight
pnpm --filter @samplehub/indexer smoke:search
```

Preflight verifies the eligible source count, maps one product, reads one source image, and checks both service health endpoints. The search smoke creates a temporary index, verifies two user-provided vector embedders, hybrid search, weighted federation, and global distinct, then deletes the temporary index even on failure.

## Index runs

Run the API and worker before starting a job in `/admin`. Use full indexing for the first build, after changing the embedding model/revision/dimensions, or after changing indexed fields/settings. Use incremental indexing for routine source updates.

Cancellation is cooperative at batch boundaries. A cancelled or failed full run never replaces the stable index. Per-image failures remain attached to the run in SQLite. A full build below the 95% image-success threshold fails by design; fix source access, corrupt images, or inference capacity and start a new full run.

Do not change `EMBEDDING_DIMENSIONS` without rebuilding. Do not point an existing index at a different model revision; vector spaces from different revisions are not assumed compatible.

## Evaluation

The admin flow stores labeled English, Chinese, or mixed-language queries; optional JPEG/PNG/WebP fixtures; and group relevance grades from 0–2. Running evaluation searches the applicable modes and records nDCG@10 by query and by mode/language/modality slice. Fixtures are local persistent test data, unlike shopper uploads.

## Backups and reset

Back up `data/search-state.sqlite` and `data/evaluation` to preserve control state and judgments. Meilisearch and Redis data reside in named Docker volumes. `pnpm infra:down` stops containers without deleting volumes. Deleting volumes is destructive and should only be done intentionally.

If the stable Meilisearch index is damaged, keep the source read-only, start a new full run, and allow the shadow-swap gate to repair it. If SQLite is lost, migrations recreate the database but run history, watermarks, ranking edits, and evaluation data are lost; begin with a full run.

## Production hardening

This implementation is deliberately local-development oriented. Before network deployment, add authentication and authorization around all admin routes, TLS, secret management, request rate limits, durable managed Redis/Meilisearch, centralized logs/metrics, backup policy, and constrained egress for the source credentials.
