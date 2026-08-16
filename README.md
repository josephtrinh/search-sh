# SampleHub Multimodal Search

A local-first monorepo for grouped SampleHub product search. It combines Meilisearch keyword retrieval, multilingual E5 text semantics, SigLIP 2 visual retrieval, and Florence 2 image captions without changing the source SampleHub database or object store.

## Workspace

- `apps/web` — Next.js shopper and admin interface
- `apps/api` — NestJS search and administration API
- `apps/indexer` — BullMQ catalog indexing worker
- `services/inference` — FastAPI SigLIP 2, multilingual E5, and Florence 2 service
- `packages/contracts` — shared API schemas and TypeScript types
- `packages/catalog` — grouping and E5 passage rules
- `docs` — architecture, operations, and source mapping

## Prerequisites

- Node.js 24.15.x; use the repository `.nvmrc`
- pnpm 10.12.4
- Python 3.11–3.13 and `uv`
- Docker with Compose
- read-only SampleHub MySQL and S3 credentials
- several gigabytes of free model-cache space; 8–10 GB of total free working space is recommended for thumbnail mode

Do not mix Node major versions after installing dependencies. `better-sqlite3` is a native module and must match the active Node ABI.

## Setup

```bash
nvm install
nvm use
corepack enable
cp .env.example .env
pnpm install
pnpm rebuild better-sqlite3
pnpm infra:up
```

Fill `.env` with the read-only source credentials. Keep the Meilisearch key at least 16 characters. If Redis or Meilisearch already occupies a configured port, use that compatible service or update both Compose and `.env` consistently.

Start inference:

```bash
pnpm inference:dev
```

Models load lazily, so `/health` can be healthy while its `loaded` fields are false. The first matching request downloads the pinned model revision:

- SigLIP 2 for image and text-to-image embeddings
- multilingual E5 Base for query and product-passage embeddings
- Florence 2 Base FT for generated detailed captions

Apple Silicon defaults to MPS when available. Set an individual backend to `cpu` if necessary. `INFERENCE_BACKEND=deterministic` starts a lightweight contract-only service; never use it to build a meaningful search index.

Start the applications in separate terminals, each after `nvm use`:

```bash
pnpm --filter @samplehub/api dev
pnpm --filter @samplehub/indexer dev
pnpm --filter @samplehub/web dev
```

Open `http://127.0.0.1:3000` for search and `http://127.0.0.1:3000/admin` for indexing and ranking. Local development intentionally has no authentication; do not expose it to an untrusted network.

Auto text search extracts populated catalog attributes from the live facet vocabulary, applies cross-field material/effect families as preferred constraints, and combines keyword, E5, and SigLIP results with weighted reciprocal-rank fusion. Empty facets are hidden automatically.

## Image and caption policy

`IMAGE_EMBEDDING_MODE=thumbnail` embeds the original image selected by `products.thumbnail_id`, falling back to the first ordered original image. `all` embeds every product image in batches of eight.

Florence always captions only that representative thumbnail/fallback image, even in `all` mode. Captions and provenance are cached in local SQLite by image content hash. They are searchable but are not displayed or returned as trusted product copy. Changing image mode, a model revision, a caption task, dimensions, indexed fields, or index settings requires a full rebuild.

## First index or v2 migration

With infrastructure and inference running:

```bash
pnpm --filter @samplehub/indexer preflight
pnpm --filter @samplehub/indexer smoke:search
```

Start a **full rebuild** from `/admin`. The existing stable index remains searchable using legacy SigLIP text routing until the new E5 shadow index passes validation and swaps in. Incremental indexing intentionally refuses a legacy index.

The first Florence pass is much slower than later rebuilds. Cached captions survive a failed or cancelled rebuild, so restarting the full run reuses completed work. On macOS, prevent sleep during a long run with `caffeinate` in a separate terminal.

The stable index is replaced only after:

1. every eligible source product is processed;
2. the shadow document count matches the source count;
3. at least 95% of selected SigLIP images embed successfully; and
4. the search smoke query succeeds.

Caption failures are reported separately and do not block the swap; affected products still receive structured E5 embeddings.
If one image in an inference batch is rejected with HTTP 422, the indexer recursively splits that batch and records only the rejected image. Valid images that shared the original batch continue normally.

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

Compose stores Meilisearch in the host directory `data/meilisearch` so the MVP can be copied between computers. This directory contains the searchable documents, Meilisearch index structures, and the stored E5 and SigLIP vectors. `data/search-state.sqlite` contains the caption cache and control state, while `data/evaluation` contains local evaluation fixtures.

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

This archive carries the existing image embeddings, E5 embeddings produced from product text plus caption text, caption cache, and evaluation state, so it does not require a new full rebuild. It does not contain the Hugging Face model cache or source MySQL/S3 data. Keep `.env` separate and transfer its credentials securely.

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
