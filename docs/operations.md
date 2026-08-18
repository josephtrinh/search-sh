# Operations

## Services and health

Default ports are web `3000`, API `8000`, inference `8100`, Meilisearch `7700`, and Redis `6379`.

```bash
curl http://127.0.0.1:8100/health
curl http://127.0.0.1:8000/v1/health
curl http://127.0.0.1:7700/health
redis-cli -h 127.0.0.1 -p 6379 ping
```

Inference health reports SigLIP, DINOv2, DINOv3, E5, and Florence independently. `loaded: false` is normal before a provider's first request. API health reports Meilisearch and inference reachability. A missing stable index is expected before the first full build.

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

Preflight verifies source count/mapping, one S3 read, service health, and one embedding from each DINO model. Search smoke loads E5, SigLIP, DINOv2, and DINOv3 if necessary and verifies all four v2 user-provided embedders, the retrieval branches, and global distinct; API unit tests cover reciprocal-rank fusion. Florence loads when the first uncached caption is requested.

The five pinned models require several gigabytes of local model storage and additional working memory. Providers load lazily but remain resident. DINOv3 is a gated local model: its first request verifies `DINOV3_ARCHIVE_SHA256`, safely extracts `DINOV3_MODEL_ARCHIVE` into `DINOV3_MODEL_DIR`, and then loads the model. Extraction and ViT-B loading can leave preflight or a new backfill at zero progress for several minutes. The extracted model is reused on later starts while its marker and required files match the configured archive checksum.

Use `SIGLIP_BACKEND`, `DINOV2_BACKEND`, `DINOV3_BACKEND`, `TEXT_EMBEDDING_BACKEND`, or `CAPTION_BACKEND=cpu` if a provider has MPS compatibility or memory trouble. Providers remain resident after loading, so avoid loading every provider concurrently on a machine without enough RAM. Reducing `MAX_CAPTION_BATCH` bounds caption latency and memory; it does not change results.

Florence uses revision-pinned remote model code. Review a new revision before updating the pin. The configured implementation requests safetensors and never follows an unpinned `main` revision.

## Index runs

Use full indexing for the first build and after changing image mode, indexed fields, vector dimensions, or general Meilisearch settings. Incremental indexing is for routine source changes and deliberately fails on the legacy `siglip_text` schema. An existing v2 index can refresh Florence captions plus E5 or add either DINO model through dedicated backfills instead of a full rebuild.

Current-generation defaults are SigLIP 2 Base NaFlex with 576 patches, DINOv2 at 392 with normalized CLS/patch-mean pooling, and DINOv3 at 384 with the same pooling after excluding register tokens. Current catalog images use a whole-image view plus adaptive long-axis crops; DINO inputs are letterboxed. Before those model-specific transforms, inputs over 25 million pixels or 9 MiB are auto-oriented and normalized within a 4096-pixel edge. Sources over 150 million pixels or 50 MiB are rejected. Normal images pass through unchanged. These settings are fingerprinted, so changing them invalidates backfill resume state.

For a faster controlled comparison, use **Build legacy preview** and **Build current preview** in `/admin`. Choose 1–25,000 products (10,000 by default). Both builds hash product IDs with the same fixed seed and therefore use the same sample. A preview is selectable only after its shadow index completes all normal validation. Preview runs neither swap stable nor advance source watermarks; evaluator reports record the selected scope/generation/model.

The first caption-enriched build can be substantially longer than the earlier SigLIP-only build. Keep the API, worker, inference, Redis, and Meilisearch running and prevent machine sleep. The admin run reports:

- processed and total products
- embedded and failed SigLIP images
- embedded and failed DINOv2 images
- embedded and failed DINOv3 images
- newly generated, cache-hit, and failed Florence captions
- oversized images normalized or rejected
- product-level coverage for each visual model

Caption cache entries commit as work finishes, even though the shadow index swaps only at the end. Restarting a failed or cancelled full build therefore reuses successful captions. Caption failures do not block completion; missing captions are retried the next time the affected product is indexed. S3 failures are recorded once and are not also counted as Florence failures.

Image embedding and caption requests normally remain batched. When inference rejects a batch with HTTP 422, the worker recursively bisects it until it isolates the invalid inputs; successful neighbors are retained and only rejected singleton images increment the failure counters. Non-422 inference failures are not bisected because they normally indicate a service or model problem rather than input-specific data.

Use **Cancel** beside a queued or active run in Admin. Queued jobs are removed immediately; active cancellation is cooperative at product-batch boundaries. Cancelled rebuild shadows are removed automatically, and a new preview build removes stale terminal preview shadows. A cancelled or failed full run never replaces the stable index. Do not delete a shadow index manually while its run is active.

After deploying these normalization changes while an older preview is already running, cancel that run and restart the indexer. A recovered job whose stored status is `cancelling` is finalized as cancelled before any more catalog work, and its run-specific shadow is deleted. Then start a new preview so every image and fingerprint uses one consistent normalization policy.

### Caption and E5 backfill

After changing `CAPTION_TASK`, the Florence model/revision, or generation settings, restart inference, API, and indexer and click **Backfill captions + E5** in `/admin`. The current v2 index must have the same document count as the eligible source catalog. The run updates the stable index in place and invokes only Florence and E5; all SigLIP and DINO vectors are preserved.

The current image hash, caption model/revision, task, token limit, and beam count select the SQLite cache entry. A new task such as `<MORE_DETAILED_CAPTION>` therefore generates new captions, while a retry reuses successful entries. Products without images receive a null generated caption and an E5 passage built from structured catalog text alone.

An individual S3, invalid-image, or empty-caption failure preserves that product's existing caption and E5 vector, increments the caption-failure count, and lets the sweep continue. A schema/count mismatch, missing existing E5 or SigLIP vectors, E5 service error, or Meilisearch update failure stops the run. Successful batches remain applied after cancellation or failure; rerun the same mode to reuse cached captions and retry unsuccessful products.

### DINO backfills and switching

After a current-generation full rebuild, click **Backfill DINOv2** or **Backfill DINOv3** in `/admin` to refresh that provider independently. The runs are separate and may be completed in either order. A legacy-generation stable index is rejected to prevent current preprocessing from being written under legacy embedder semantics. Keep all services and the computer awake until the run completes. The existing index stays searchable with its active visual model throughout; a failed or cancelled backfill cannot activate its target model.

The first attempt initializes every existing document with a null opt-out for the target DINO embedder before registering it in Meilisearch. Admin progress can remain at zero during this one-time pass and while DINOv3 is extracted and loaded. This ordering is required because adding the embedder first makes Meilisearch reject documents that do not yet provide that vector.

A same-fingerprint retry resumes efficiently by preserving null markers and skipping products that already contain the expected number of valid target vectors: 768 dimensions for DINOv2 or DINOv3 ViT-B. It still scans the catalog and validates existing vector maps. The target becomes selectable only after the run visits the full eligible count and reaches 95% product coverage. Products without a selected image are excluded from that denominator. The Admin model toggle is global and persistent. Switching is immediate and needs neither a restart nor a rebuild.

Changing `DINOV3_IMAGE_SIZE`, `DINOV3_POOLING`, crop policy, or the configured DINOv3 archive checksum changes its fingerprint and requires a new DINOv3 backfill. The default image size is 384; accepted values are square multiples of 16 from 224 through 512. DINOv2 defaults to 392 and accepts multiples of 14 from 224 through 518. Changing vector dimensions requires a full rebuild rather than an in-place backfill.

The ViT-B migration changes DINOv3 vectors from 1,280 to 768 dimensions. A stable index that has the former ViT-H+ `dinov3_image` embedder therefore requires a current-generation full rebuild. After that migration, use the dedicated DINOv3 backfill for future same-dimension model/preprocessing refreshes.

Elapsed time is hardware, S3, and image-count dependent. The backfill avoids E5 and Florence work, so use its observed rate after the first few hundred products for a reliable estimate: `remaining products / products per minute`. Thumbnail mode processes roughly one image per eligible product; `all` mode may process up to every associated image.

## Completion checks

After `/admin` reports `completed`:

```bash
curl http://127.0.0.1:8000/v1/admin/index-status
curl http://127.0.0.1:8100/health
```

Confirm the stable document count matches the eligible source count and the inference health shows the expected pinned revisions. Run representative image-only, English text, Chinese text, and combined image-plus-text searches. Toggle among SigLIP, DINOv2, and DINOv3 for manual qualitative comparison; `text_visual` is intentionally unavailable under either DINO model. Evaluation reports should compare the applicable specialist baselines with `auto` using nDCG@10.

## Ranking and aliases

Admin sliders store relative reciprocal-rank weights. Defaults are:

- text-only: keyword `0.40`, E5 `0.40`, SigLIP text-to-image `0.20`
- combined: image `0.50`, E5 `0.25`, keyword `0.15`, SigLIP text-to-image `0.10`

At least one weight in each group must be positive. Auto mode resolves exact values from the live facet vocabulary, supplements them with curated synonyms, and supports OR families across material/effect fields. Preferred matches occupy roughly six of every seven result positions; the remaining lane is an unfiltered fallback. Explicit request filters always win over a conflicting derived field.

## Backups and reset

Back up `data/search-state.sqlite` plus its WAL files while services are stopped, and `data/evaluation`. SQLite now contains the reusable caption cache as well as control state and judgments. Losing it does not affect SampleHub, but forces captions to be regenerated.

Meilisearch uses the host bind mount `data/meilisearch`; Redis uses its Compose volume. `pnpm infra:down` stops containers without deleting either store. Back up the complete `data` directory only while API, indexer, and infrastructure are stopped so Meilisearch and SQLite are consistent. If the stable index is damaged, start a new full run. If SQLite is lost, migrations recreate it, but both DINO readiness fingerprints, the active-model setting, and reusable caption state are lost even if Meilisearch still has vectors. The `data` backup does not include the DINOv3 archive or extracted model under `temp`; transfer those separately or place the original archive at the configured path on the restored computer.

## Production hardening

This remains local-development software. Before network deployment, add authentication and authorization to admin routes, TLS, secret management, rate limits, managed durable stores, centralized logs/metrics, backups, and constrained source-credential egress.
