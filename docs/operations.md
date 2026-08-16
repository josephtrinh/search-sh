# Operations

## Services and health

Default ports are web `3000`, API `8000`, inference `8100`, Meilisearch `7700`, and Redis `6379`.

```bash
curl http://127.0.0.1:8100/health
curl http://127.0.0.1:8000/v1/health
curl http://127.0.0.1:7700/health
redis-cli -h 127.0.0.1 -p 6379 ping
```

Inference health reports SigLIP, DINOv2, E5, and Florence independently. `loaded: false` is normal before a provider's first request. API health reports Meilisearch and inference reachability. A missing stable index is expected before the first full build.

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

Preflight verifies source count/mapping, one S3 read, service health, and one DINOv2 embedding. Search smoke loads E5, SigLIP, and DINOv2 if necessary and verifies all three v2 user-provided embedders, the retrieval branches, and global distinct; API unit tests cover reciprocal-rank fusion. Florence loads when the first uncached caption is requested.

The four pinned models require several gigabytes of local Hugging Face cache and additional working memory. Providers load lazily but remain resident. Use `SIGLIP_BACKEND`, `DINOV2_BACKEND`, `TEXT_EMBEDDING_BACKEND`, or `CAPTION_BACKEND=cpu` if a provider has MPS compatibility or memory trouble. Reducing `MAX_CAPTION_BATCH` bounds caption latency and memory; it does not change results.

Florence uses revision-pinned remote model code. Review a new revision before updating the pin. The configured implementation requests safetensors and never follows an unpinned `main` revision.

## Index runs

Use full indexing for the first build and after changing the text/caption/SigLIP configuration, caption task, image mode, indexed fields, or general Meilisearch settings. Incremental indexing is for routine source changes and deliberately fails on the legacy `siglip_text` schema. An existing v2 index can add or refresh DINOv2 through the dedicated backfill instead of a full rebuild.

The first caption-enriched build can be substantially longer than the earlier SigLIP-only build. Keep the API, worker, inference, Redis, and Meilisearch running and prevent machine sleep. The admin run reports:

- processed and total products
- embedded and failed SigLIP images
- embedded and failed DINOv2 images
- newly generated, cache-hit, and failed Florence captions

Caption cache entries commit as work finishes, even though the shadow index swaps only at the end. Restarting a failed or cancelled full build therefore reuses successful captions. Caption failures do not block completion; missing captions are retried the next time the affected product is indexed. S3 failures are recorded once and are not also counted as Florence failures.

Image embedding and caption requests normally remain batched. When inference rejects a batch with HTTP 422, the worker recursively bisects it until it isolates the invalid inputs; successful neighbors are retained and only rejected singleton images increment the failure counters. Non-422 inference failures are not bisected because they normally indicate a service or model problem rather than input-specific data.

Cancellation is cooperative at product-batch boundaries. A cancelled or failed full run never replaces the stable index. The old index remains searchable with legacy routing until the v2 shadow swaps. Do not delete a shadow index manually while its run is active.

### DINOv2 backfill and switching

After restarting the inference service, API, and indexer on the updated code, click **Backfill DINOv2** in `/admin`. Keep all services and the computer awake until the run completes. The existing index stays searchable with SigLIP throughout; a failed or cancelled backfill cannot activate DINOv2.

The first attempt initializes every existing document with a null DINOv2 opt-out before adding the Meilisearch `userProvided` embedder. The Admin progress can remain at zero during this one-time pass. This ordering is required because adding the embedder first makes Meilisearch reject all documents that do not yet provide that vector. A same-fingerprint retry resumes efficiently by preserving the null markers and skipping products that already contain the expected number of valid 768-dimensional DINOv2 vectors. It still scans the catalog and validates existing vector maps. DINOv2 becomes selectable only after the run processes the full eligible count and reaches 95% image success. The Admin model toggle is global and persistent. Switching is immediate and needs neither a restart nor a rebuild.

Elapsed time is hardware, S3, and image-count dependent. The backfill avoids E5 and Florence work, so use its observed rate after the first few hundred products for a reliable estimate: `remaining products / products per minute`. Thumbnail mode processes roughly one image per eligible product; `all` mode may process up to every associated image.

## Completion checks

After `/admin` reports `completed`:

```bash
curl http://127.0.0.1:8000/v1/admin/index-status
curl http://127.0.0.1:8100/health
```

Confirm the stable document count matches the eligible source count and the inference health shows the expected pinned revisions. Run representative image-only, English text, Chinese text, and combined image-plus-text searches. Toggle between SigLIP and DINOv2 for manual qualitative comparison; `text_visual` is intentionally unavailable under DINOv2. Evaluation reports should compare the applicable specialist baselines with `auto` using nDCG@10.

## Ranking and aliases

Admin sliders store relative reciprocal-rank weights. Defaults are:

- text-only: keyword `0.40`, E5 `0.40`, SigLIP text-to-image `0.20`
- combined: image `0.50`, E5 `0.25`, keyword `0.15`, SigLIP text-to-image `0.10`

At least one weight in each group must be positive. Auto mode resolves exact values from the live facet vocabulary, supplements them with curated synonyms, and supports OR families across material/effect fields. Preferred matches occupy roughly six of every seven result positions; the remaining lane is an unfiltered fallback. Explicit request filters always win over a conflicting derived field.

## Backups and reset

Back up `data/search-state.sqlite` plus its WAL files while services are stopped, and `data/evaluation`. SQLite now contains the reusable caption cache as well as control state and judgments. Losing it does not affect SampleHub, but forces captions to be regenerated.

Meilisearch uses the host bind mount `data/meilisearch`; Redis uses its Compose volume. `pnpm infra:down` stops containers without deleting either store. Back up the complete `data` directory only while API, indexer, and infrastructure are stopped so Meilisearch and SQLite are consistent. If the stable index is damaged, start a new full run. If SQLite is lost, migrations recreate it, but the DINOv2 readiness/toggle and reusable caption state are lost even if Meilisearch still has vectors.

## Production hardening

This remains local-development software. Before network deployment, add authentication and authorization to admin routes, TLS, secret management, rate limits, managed durable stores, centralized logs/metrics, backups, and constrained source-credential egress.
