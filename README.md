# SampleHub Multimodal Search

A local-first monorepo for grouped SampleHub product search. It combines Meilisearch keyword retrieval, multilingual E5 text semantics, switchable SigLIP 2, DINOv2, or DINOv3 visual retrieval, and switchable Florence 2 or Qwen 3.5 image captions without changing the source SampleHub database or object store.

## Workspace

- `apps/web` — Next.js shopper and admin interface
- `apps/api` — NestJS search and administration API
- `apps/indexer` — BullMQ catalog indexing worker
- `services/inference` — FastAPI SigLIP 2, DINOv2, DINOv3, multilingual E5, and Florence 2 service
- `packages/contracts` — shared API schemas and TypeScript types
- `packages/catalog` — grouping and E5 passage rules
- `docs` — architecture, operations, and source mapping

## Prerequisites

- Node.js 24.15.x; use the repository `.nvmrc`
- pnpm 10.12.4
- Python 3.11–3.13 and `uv`
- Docker with Compose
- read-only SampleHub MySQL and S3 credentials
- at least 10 GB of free model/cache space when using the local DINOv3 ViT-B archive
- `llama-server` from llama.cpp when generating Qwen captions (not required for search after backfill)

Do not mix Node major versions after installing dependencies. `better-sqlite3` is a native module and must match the active Node ABI.

## First-time setup

```bash
nvm install
nvm use
corepack enable
cp .env.example .env
pnpm install
pnpm rebuild better-sqlite3
pnpm --filter './packages/**' build
pnpm infra:up
```

Fill `.env` with the read-only source credentials. Keep the Meilisearch key at least 16 characters. If Redis or Meilisearch already occupies a configured port, use that compatible service or update both Compose and `.env` consistently.

DINOv3 is a gated Meta model. After accepting its license, place the downloaded archive at:

```text
temp/facebookdinov3-vitb16-pretrain-lvd1689m-transformers-default-v1.tar.gz
```

The inference service verifies the configured SHA-256 and safely extracts it into the gitignored `temp/dinov3-vitb16-pretrain-lvd1689m` directory when DINOv3 is first requested. Keep the archive intact for setup on another computer; neither the gated weights nor the extracted directory are committed to the repository.

To install the optional Qwen caption model, install llama.cpp (for example, `brew install llama.cpp` on macOS), then download and verify the pinned Unsloth files:

```bash
pnpm qwen:download
pnpm qwen:verify
```

This stores `Qwen3.5-0.8B-Q4_K_S.gguf` and `mmproj-F16.gguf` under the gitignored `temp/qwen3.5-0.8b/` directory and verifies both SHA-256 checksums. The vision projector is required; the language GGUF by itself cannot caption images.

The shared workspace packages export compiled files from their ignored `dist` directories. `pnpm install` links those packages but does not compile them, and the filtered application `dev` commands below do not build them automatically. Build them before starting an application from a fresh clone.

## Subsequent development sessions

After the first-time setup, select the repository's Node version and start the local infrastructure:

```bash
nvm use
pnpm infra:up
```

Run `pnpm install` again after the lockfile or package dependencies change. If files under `packages/` changed, rerun `pnpm --filter './packages/**' build` before starting the applications.

Start inference:

```bash
pnpm inference:dev
```

When generating or backfilling Qwen captions, also start its single-slot local server in another terminal:

```bash
pnpm qwen:dev
```

`pnpm qwen:dev` reads `QWEN_CONTEXT_SIZE` and `QWEN_IMAGE_MAX_TOKENS` from the root `.env`. The defaults are 8192 total context tokens and at most 4096 visual tokens per image. The image-token cap controls llama.cpp's dynamic-resolution vision encoding, not the source file's pixels or compressed size; catalog images have already passed the normalization limits described below.

It binds only to `127.0.0.1:8200`, uses one parallel request and Metal offload, and applies the configured context and visual-token limits. Stop it after the Qwen backfill; searches use the stored caption and E5 vectors and do not call Qwen.

Models load lazily, so `/health` can be healthy while its `loaded` fields are false. The first matching request downloads a pinned remote revision or loads the configured local archive:

- SigLIP 2 for image and text-to-image embeddings
- DINOv2 Base for the optional image-only visual retrieval experiment
- the local DINOv3 ViT-B/16 archive for the optional 768-dimensional image-only experiment
- multilingual E5 Base for query and product-passage embeddings
- Florence 2 Base FT for generated detailed captions
- Qwen 3.5 0.8B Q4_K_S through llama.cpp for the optional catalog-specific captions

Apple Silicon defaults to MPS when available. Set an individual backend to `cpu` if necessary. `INFERENCE_BACKEND=deterministic` starts a lightweight contract-only service; never use it to build a meaningful search index.

Start the applications in separate terminals, each after `nvm use`:

```bash
pnpm --filter @samplehub/api dev
pnpm --filter @samplehub/indexer dev
pnpm --filter @samplehub/web dev
```

Open `http://127.0.0.1:3000` for search and `http://127.0.0.1:3000/admin` for indexing and ranking.

### Access from the local network

The web development server reads its bind address and port from the root `.env`. The defaults are:

```env
WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_ALLOWED_ORIGINS=
```

`0.0.0.0` makes the web server listen on all network interfaces. Other devices on the same trusted network can open the configured port using this computer's LAN address, for example:

```text
http://192.168.0.139:3000
```

Change `WEB_PORT` if that port is already occupied, then use the same port in the URL. The launcher automatically allows the machine's current LAN interface addresses for Next.js development assets and hot reload. Add comma-separated hostnames or addresses to `WEB_ALLOWED_ORIGINS` only when clients use an additional name that is not detected automatically.

Browser API requests use the web server's same-origin `/api` proxy, so the API, inference service, Meilisearch, and Redis remain bound to `127.0.0.1` and do not need to be exposed separately. If the page is unreachable, allow incoming connections for Node.js or the configured TCP port in the host firewall. The LAN address may change when the router renews its DHCP lease.

Local development intentionally has no authentication. Anyone who can reach the web server can also access the evaluator and indexing controls, so use LAN access only on a trusted network and never forward the configured web port to the internet.

Auto text search extracts populated catalog attributes from the live facet vocabulary, applies cross-field material/effect families as preferred constraints, and uses weighted reciprocal-rank fusion. With SigLIP active it combines keyword, E5, and SigLIP text-to-image retrieval. With either DINO model active, text search uses keyword and E5 only because DINOv2 and DINOv3 have no text encoder. Empty facets are hidden automatically.

## Image and caption policy

`IMAGE_EMBEDDING_MODE=thumbnail` embeds the original image selected by `products.thumbnail_id`, falling back to the first ordered original image. `all` embeds every product image in batches of eight. The same selection policy is used for SigLIP, DINOv2, and DINOv3.

Current-generation catalog embeddings preserve the whole image and add square long-axis views only when its aspect ratio exceeds 1.2. Depending on length, two to four evenly spaced tiles are added, capped at five vectors per source image. SigLIP 2 uses the pinned NaFlex Base model with a 576-patch budget so the whole view keeps its native aspect ratio. DINOv2 uses 392×392 inputs and DINOv3 uses 384×384 inputs; both letterbox instead of stretching or center-cropping and use the normalized 50/50 CLS plus patch-mean descriptor. Interactive query images remain a single vector: native-aspect NaFlex for SigLIP and letterboxed for DINO.

Both caption providers caption only that representative thumbnail/fallback image, even in `all` mode. Provider-specific captions and provenance are cached in local SQLite by image content hash. They are searchable but are not displayed or returned as trusted product copy. Florence uses `generatedVisualCaption` with `e5_text`; Qwen uses `generatedVisualCaptionQwen` with `e5_text_qwen`. The active pair can be switched instantly after both are ready for the selected index scope.

## First index or v2 migration

With infrastructure and inference running:

```bash
pnpm --filter @samplehub/indexer preflight
pnpm --filter @samplehub/indexer smoke:search
```

Start a **full rebuild** from `/admin`. New full rebuilds always create the current visual generation under `siglip_image_v2`, `dinov2_image_v2`, and `dinov3_image_v2`. The existing stable index remains searchable with its legacy model and preprocessing until the current-generation shadow passes validation and swaps in. Incremental indexing detects the stable generation and preserves its embedder names and preprocessing, so newly added catalog products remain compatible before or after the migration.

The first Florence pass is much slower than later rebuilds. Cached captions survive a failed or cancelled rebuild, so restarting the full run reuses completed work. On macOS, prevent sleep during a long run with `caffeinate` in a separate terminal.

Catalog images over 25 million decoded pixels or 9 MiB compressed are normalized once before any model sees them: EXIF orientation is applied, aspect ratio is preserved within a 4096-pixel edge, transparency is flattened to white, and the result is encoded as high-quality 4:4:4 JPEG. Normal inputs remain unchanged. Sources over 150 million pixels or 50 MiB are rejected as unsafe. These limits and the output envelope are configurable with the `CATALOG_IMAGE_*` settings in `.env`; changing them changes the visual fingerprints.

The stable index is replaced only after:

1. every eligible source product is processed;
2. the shadow document count matches the source count;
3. at least 95% of image-eligible products have one or more successful vectors for each configured visual provider; and
4. the search smoke query succeeds.

Caption failures are reported separately and do not block the swap; affected products still receive structured E5 embeddings.
If one image in an inference batch is rejected with HTTP 422, the indexer recursively splits that batch and records only the rejected image. Valid images that shared the original batch continue normally.

## Compare generations on a limited catalog sample

In `/admin`, choose a product limit from 1 through 25,000 and build a **legacy preview** and/or **current preview**. Both generations use the same deterministic source-ID sample, making model comparisons directly comparable. The default limit is 10,000.

Preview builds use their own shadow indexes and never replace stable, alter incremental watermarks, or affect shopper search until explicitly selected under **Search index scope**. Their minimum product coverage is 90%; completion below the 95% production target is shown as a warning. Products with no selected image are excluded from the denominator, and products with visual failures still retain structured text and E5 search. Only a completed, count-matched, image-gated, smoke-tested preview can be selected. Evaluation reports record the selected scope, visual generation, and visual model. Rebuilding a preview leaves its previous completed version searchable until the replacement succeeds.

## Backfill and compare caption providers without a full rebuild

After changing Florence settings or the versioned Qwen prompt/settings in `.env`, restart inference, API, and indexer. Start `pnpm qwen:dev` when Qwen generation is needed. In `/admin`, select the target **Search index scope**, then click **Backfill Florence** or **Backfill Qwen**. The backfill walks exactly the documents already in that stable or preview index, keeps it searchable, and does not invoke SigLIP, DINOv2, or DINOv3.

For each indexed product, the worker captions only the representative image, reuses cache entries matching the image hash plus the provider/model/prompt/generation fingerprint, rebuilds the E5 passage from catalog fields plus that provider's caption, and replaces only that provider's caption and E5 vector. Every other field and vector is copied back unchanged. Changing from `<DETAILED_CAPTION>` to `<MORE_DETAILED_CAPTION>` or changing Qwen's prompt requires a new `QWEN_CAPTION_PROMPT_VERSION` and matching `QWEN_CAPTION_PROMPT_SHA256`, producing intentional cache misses; completed work is reused after cancellation or failure.

If Qwen returns `<NO_MATERIAL>`, or a product has no usable representative image, its Qwen caption is null and it receives a structured-catalog-text-only E5 vector; there is no Florence fallback. An individual image failure preserves an existing successful provider value or creates the structured-only vector when that provider has no prior value. Systemic Qwen, E5, schema, or Meilisearch failures stop the run. A provider becomes selectable for that scope only after every indexed document has its vector, the count matches, and a semantic smoke query succeeds. Partial and cancelled runs retain cached progress but are not marked ready.

Use **Active caption provider** in `/admin` to switch Florence/Qwen retrieval for the active scope. Keyword queries restrict `attributesToSearchOn` to trusted catalog fields plus only the active caption field, and semantic queries use only the matching E5 vector. Evaluation metadata and pagination cursors record the active caption provider.

`CAPTION_INDEX_PROVIDER=florence` remains the default for full and incremental indexing. After approving Qwen on a preview and stable backfill, set it to `qwen` and restart the API/indexer for Qwen-only future indexing. A Qwen-only incremental run invalidates Florence readiness when it adds or updates products, preventing an incomplete Florence index from being selected. `llama-server` must be running for Qwen full/incremental generation, but not for normal search.

## Try DINOv2 or DINOv3 without replacing existing vectors

The stable index can hold all three visual vector sets. SigLIP remains the default, and switching the active model in `/admin` is immediate once the selected DINO model is ready. The selection is stored in `data/search-state.sqlite` and applies globally to search and evaluation.

For a current-generation stable index, restart inference, API, and indexer after pulling these changes, then click **Backfill DINOv2** or **Backfill DINOv3** in `/admin`. Each is an independent in-place vector backfill: it keeps the current searchable index, documents, other vector providers, and captions. A full rebuild is not required, and the two DINO backfills may run in either order. A legacy-generation stable index is rejected because adding current preprocessing under a legacy embedder name would make the comparison invalid; run a current full rebuild first.

Each backfill is resumable for the same model fingerprint. On the first run it safely initializes every existing document with the target embedder set to `null` before registering that `userProvided` embedder; Meilisearch requires this opt-out for documents without the new vector. The worker fetches each document's current `_vectors`, verifies E5 and SigLIP are present, merges only the target DINO vector, and writes the complete vector map back. The run may remain at 0 processed while DINOv3 verifies/extracts its archive, loads the model, and initializes Meilisearch. A model becomes selectable only after all eligible products are visited and at least 95% of image-eligible products have a successful vector.

In either DINO mode:

- image-only search uses the selected DINO provider;
- combined image plus text search fuses that provider's image vector, E5 semantic, and keyword branches;
- text-only search uses E5 semantic and keyword branches;
- `text_visual` is disabled because DINOv2 and DINOv3 have no compatible text encoder.

Switch among **SigLIP 2**, **DINOv2**, and **DINOv3** in `/admin`; this selects one visual model and never ensembles their scores or vectors. Full rebuilds create all three. Incremental runs maintain every provider registered on the stable index. Changing crop policy, pooling, model revision, resolution, or patch budget changes its fingerprint and requires the corresponding rebuild/backfill. DINOv2 defaults to 392 pixels (multiples of 14 from 224–518); DINOv3 defaults to 384 pixels (multiples of 16 from 224–512).

If the stable index was configured with the former 1,280-dimensional ViT-H+ DINOv3 embedder, rebuild it before using ViT-B because Meilisearch cannot change that embedder to 768 dimensions in place. Once the stable index is current-generation, the normal **Backfill DINOv3** run can refresh that model without rerunning SigLIP, DINOv2, E5, or Florence.

## Verify and stop

```bash
curl http://127.0.0.1:8100/health
curl http://127.0.0.1:8000/v1/health
curl http://127.0.0.1:8000/v1/admin/index-status
```

Confirm the latest run is `completed`, its processed count equals the eligible catalog count, and Meilisearch reports the same document count. Stop the foreground application processes with Ctrl-C, then stop local infrastructure without deleting data:

```bash
pnpm infra:down
```

## Portable MVP data

Compose stores Meilisearch in the host directory `data/meilisearch` so the MVP can be copied between computers. This directory contains the searchable documents, Meilisearch index structures, and the stored E5, SigLIP, and optional DINOv2/DINOv3 vectors. `data/search-state.sqlite` contains the caption cache, active visual-model selection, independent DINO readiness fingerprints, and control state, while `data/evaluation` contains local evaluation fixtures.

Installations created before the host bind mount may still have their index in the Docker named volume `search-sh_meili_data`. Changing to an empty host directory does not delete that volume, but Meilisearch will start with an empty database because the old volume is no longer mounted. Avoid a full rebuild by copying the named volume before starting the new Compose configuration.

### One-time named-volume migration

Stop the API and indexer with Ctrl-C so they cannot write during the migration, then stop Meilisearch:

```bash
docker compose stop meilisearch
docker volume ls --filter name=meili_data
mkdir -p data/meilisearch
docker run --rm --entrypoint /bin/sh \
  -v search-sh_meili_data:/source:ro \
  -v "$PWD/data/meilisearch:/destination" \
  getmeili/meilisearch:v1.45.1 -c 'cp -a /source/. /destination/'
```

If `docker volume ls` reports a different volume name, use that name before `:/source:ro`. Do not continue if `data/meilisearch` is empty after the copy. The configured Compose mount is `./data/meilisearch:/meili_data`.

Start the service and verify the existing stable index and document count:

```bash
docker compose up -d meilisearch
curl http://127.0.0.1:7700/health
```

Then start the API and check `http://127.0.0.1:8000/v1/admin/index-status`. The stable document count should match the count from before the migration. No full rebuild is required when the files were copied successfully. Keep `search-sh_meili_data` as a rollback copy until search and the document count have been verified; do not run `docker compose down -v` or remove the old volume during migration.

### Copy, move, and restore

Stop the API, indexer, and local infrastructure before creating a portable archive. This gives both Meilisearch and SQLite a consistent on-disk state:

```bash
pnpm infra:down
tar -czf samplehub-mvp-data.tar.gz data
```

Copy the archive and repository to the destination computer. Use the same pinned Meilisearch image version, extract the archive at the repository root so it restores `data/`, and start the services normally:

```bash
tar -xzf samplehub-mvp-data.tar.gz
pnpm infra:up
```

This archive carries the existing SigLIP and optional DINOv2/DINOv3 image embeddings, E5 embeddings produced from product text plus caption text, active visual-model setting, caption cache, and evaluation state, so it does not require a new full rebuild. It does not contain the Hugging Face model cache, the gated DINOv3 archive/extraction, or source MySQL/S3 data. Keep `.env` separate and transfer its credentials securely.

## Development verification

```bash
nvm use
pnpm typecheck
pnpm test
pnpm build
uv run --directory services/inference ruff check .
pnpm inference:test
```

See [operations](docs/operations.md) for recovery and tuning and [architecture](docs/architecture.md) for data flow and ranking behavior.
