# Operations

## Services and health

Default ports are web `3000`, API `8000`, inference `8100`, Meilisearch `7700`, and Redis `6379`.

```bash
curl http://127.0.0.1:8100/health
curl http://127.0.0.1:8000/v1/health
curl http://127.0.0.1:7700/health
redis-cli -h 127.0.0.1 -p 6379 ping
```

Inference health reports SigLIP, E5, and Florence independently. `loaded: false` is normal before a provider's first request. API health reports Meilisearch and inference reachability. A missing stable index is expected before the first full build.

## Node native-module recovery

The workspace is pinned to Node 24.15.x because `better-sqlite3` is compiled for a specific Node ABI. If the API reports `ERR_DLOPEN_FAILED` or a `NODE_MODULE_VERSION` mismatch:

```bash
nvm use
pnpm rebuild better-sqlite3
```

If rebuilding is insufficient, run `pnpm install` under Node 24.15.x. Do not install under one Node major and run under another.

## Preflight and model loading

```bash
pnpm --filter @samplehub/indexer preflight
pnpm --filter @samplehub/indexer smoke:search
```

Preflight verifies source count/mapping, one S3 read, and service health. Search smoke loads E5 and SigLIP if necessary and verifies both v2 user-provided embedders, the retrieval branches, and global distinct; API unit tests cover reciprocal-rank fusion. Florence loads when the first uncached caption is requested.

The three pinned models require several gigabytes of local Hugging Face cache and additional working memory. Providers load lazily but remain resident. Use `SIGLIP_BACKEND`, `TEXT_EMBEDDING_BACKEND`, or `CAPTION_BACKEND=cpu` if a provider has MPS compatibility or memory trouble. Reducing `MAX_CAPTION_BATCH` bounds caption latency and memory; it does not change results.

Florence uses revision-pinned remote model code. Review a new revision before updating the pin. The configured implementation requests safetensors and never follows an unpinned `main` revision.

## Index runs

Use full indexing for the first build and after changing model IDs, revisions, dimensions, caption task, image mode, indexed fields, or Meilisearch settings. Incremental indexing is for routine source changes and deliberately fails on the legacy `siglip_text` schema.

The first caption-enriched build can be substantially longer than the earlier SigLIP-only build. Keep the API, worker, inference, Redis, and Meilisearch running and prevent machine sleep. The admin run reports:

- processed and total products
- embedded and failed SigLIP images
- newly generated, cache-hit, and failed Florence captions

Caption cache entries commit as work finishes, even though the shadow index swaps only at the end. Restarting a failed or cancelled full build therefore reuses successful captions. Caption failures do not block completion; missing captions are retried the next time the affected product is indexed. S3 failures are recorded once and are not also counted as Florence failures.

Image embedding and caption requests normally remain batched. When inference rejects a batch with HTTP 422, the worker recursively bisects it until it isolates the invalid inputs; successful neighbors are retained and only rejected singleton images increment the failure counters. Non-422 inference failures are not bisected because they normally indicate a service or model problem rather than input-specific data.

Cancellation is cooperative at product-batch boundaries. A cancelled or failed full run never replaces the stable index. The old index remains searchable with legacy routing until the v2 shadow swaps. Do not delete a shadow index manually while its run is active.

## Completion checks

After `/admin` reports `completed`:

```bash
curl http://127.0.0.1:8000/v1/admin/index-status
curl http://127.0.0.1:8100/health
```

Confirm the stable document count matches the eligible source count and the inference health shows the expected pinned revisions. Run representative image-only, English text, Chinese text, and combined image-plus-text searches. Evaluation reports should compare the specialist baselines with `auto` using nDCG@10.

## Ranking and aliases

Admin sliders store relative reciprocal-rank weights. Defaults are:

- text-only: keyword `0.40`, E5 `0.40`, SigLIP text-to-image `0.20`
- combined: image `0.50`, E5 `0.25`, keyword `0.15`, SigLIP text-to-image `0.10`

At least one weight in each group must be positive. Auto mode resolves exact values from the live facet vocabulary, supplements them with curated synonyms, and supports OR families across material/effect fields. Preferred matches occupy roughly six of every seven result positions; the remaining lane is an unfiltered fallback. Explicit request filters always win over a conflicting derived field.

## Backups and reset

Back up `data/search-state.sqlite` plus its WAL files while services are stopped, and `data/evaluation`. SQLite now contains the reusable caption cache as well as control state and judgments. Losing it does not affect SampleHub, but forces captions to be regenerated.

Meilisearch and Redis use named Docker volumes. `pnpm infra:down` stops containers without deleting volumes. Volume deletion is destructive and should be intentional. If the stable index is damaged, start a new full run. If SQLite is lost, migrations recreate it but begin with a full run.

## Production hardening

This remains local-development software. Before network deployment, add authentication and authorization to admin routes, TLS, secret management, rate limits, managed durable stores, centralized logs/metrics, backups, and constrained source-credential egress.
