# SampleHub Multimodal Search

A local-first monorepo for grouped SampleHub product search using Meilisearch and SigLIP 2. It supports keyword, text-semantic, text-to-image, image, and combined retrieval without changing the source SampleHub database or object store.

## Workspace

- `apps/web` — Next.js shopper and admin/evaluation interface
- `apps/api` — NestJS search and administration API
- `apps/indexer` — BullMQ catalog indexing worker
- `services/inference` — FastAPI SigLIP 2 embedding service
- `packages/contracts` — shared Zod schemas and TypeScript types
- `packages/catalog` — grouping and embedding-text rules
- `docs` — architecture, operations, and source mapping

## Prerequisites

- Node.js 22+
- pnpm 10.12.4
- Python 3.11–3.13 and `uv`
- Docker with Compose
- read-only SampleHub MySQL and S3 credentials

## Setup

```bash
cp .env.example .env
pnpm install
pnpm infra:up
```

Fill `.env` with the read-only source credentials. Keep the Meilisearch key at least 16 characters. If Redis or Meilisearch already occupies the configured port, use the existing compatible service or change both the Compose mapping and `.env`.

Install and start real local inference:

```bash
pnpm inference:dev
```

The first start downloads the pinned `google/siglip2-base-patch16-224` revision. On Apple Silicon the provider selects MPS when available and otherwise uses CPU. For a lightweight contract-only server, set `INFERENCE_BACKEND=deterministic`; never use that backend to build a production-quality index.

In separate terminals:

```bash
pnpm --filter @samplehub/api dev
pnpm --filter @samplehub/indexer dev
pnpm --filter @samplehub/web dev
```

Open `http://127.0.0.1:3000` for search and `/admin` for indexing, ranking controls, and evaluation. Local development intentionally has no authentication; do not expose these services to an untrusted network.

## First index

Run the read-only dependency preflight and Meilisearch feature smoke test:

```bash
pnpm --filter @samplehub/indexer preflight
pnpm --filter @samplehub/indexer smoke:search
```

With the API and worker running, start a **full** run from `/admin`. Search remains unavailable until the full shadow index passes its count, image-success, and smoke gates and is atomically swapped to the stable `products` index. Subsequent runs may be incremental.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
uv run --directory services/inference ruff check .
pnpm inference:test
```

See [operations](docs/operations.md) for recovery and indexing details and [architecture](docs/architecture.md) for ranking and data flow.
