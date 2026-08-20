import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "bullmq";
import type { ImageAsset, ProductDocument } from "@samplehub/contracts";
import sharp from "sharp";

const requiredEnv: Record<string, string> = {
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "3306",
  DATABASE_USERNAME: "test",
  DATABASE_PASSWORD: "test",
  DATABASE_NAME: "test",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AWS_REGION: "us-east-1",
  AWS_BUCKET_NAME: "test",
  AWS_BUCKET_URL: "https://example.com",
};
for (const [key, value] of Object.entries(requiredEnv))
  process.env[key] ??= value;

function product(id: string, image?: ImageAsset): ProductDocument {
  return {
    id,
    groupId: `group-${id}`,
    brand: "Brand",
    normalizedBrand: "brand",
    series: "Series",
    normalizedSeries: "series",
    name: id,
    sku: null,
    model: null,
    item: null,
    material: "Stone",
    color: null,
    origin: null,
    effect: null,
    surface: null,
    edge: null,
    sizeGroup: null,
    waterAbsorption: null,
    fireResistance: null,
    description: null,
    remarks: null,
    width: null,
    height: null,
    length: null,
    depth: null,
    area: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    thumbnailId: image?.id ?? null,
    images: image ? [image] : [],
    attributes: {},
  };
}

test("caption backfill updates successful products and gives failed products structured-only vectors", async () => {
  const { IndexRunner } = await import("./runner");
  const assets = ["fresh", "cached", "failed"].map((id) => ({
    id: `${id}-image`,
    url: id,
    thumbnailUrl: null,
    mime: "image/png",
  }));
  const products = [
    product("fresh", assets[0]),
    product("cached", assets[1]),
    product("failed", assets[2]),
    product("no-image"),
  ];
  const vectors = new Map(
    products.map((entry, index) => [
      entry.id,
      {
        vectors: {
          e5_text: [index],
          siglip_image: [[index + 10]],
          dinov2_image: [[index + 20]],
          dinov3_image: [[index + 30]],
        },
      },
    ]),
  );
  const updates: Array<Record<string, unknown>> = [];
  const runUpdates: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  const stored: string[] = [];
  const validImage = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();

  interface Harness {
    captionBackfill(job: Job<{ runId: string }>): Promise<void>;
  }
  const runner = Object.create(IndexRunner.prototype) as unknown as Harness &
    Record<string, unknown>;
  Object.assign(runner, {
    meili: {
      exists: async () => true,
      hasEmbedder: async () => true,
      ensureCaptionEmbedder: async () => undefined,
      count: async () => products.length,
      documentPage: async (_uid: string, offset: number) => offset === 0
        ? products.map((entry) => ({ ...entry, _vectors: vectors.get(entry.id)!.vectors }))
        : [],
      updateDocuments: async (
        _uid: string,
        documents: Array<Record<string, unknown>>,
      ) => {
        updates.push(...documents);
      },
      semanticSmoke: async () => undefined,
    },
    imageSource: {
      get: async (url: string) => {
        if (url === "failed") throw new Error("S3 unavailable");
        return validImage;
      },
    },
    inference: {
      captions: async () => ["new detailed caption"],
      textPassages: async (texts: string[]) =>
        texts.map((_, index) => [100 + index]),
    },
    cachedCaption: (imageId: string) =>
      imageId === "cached-image" ? "cached detailed caption" : undefined,
    storeCaption: (imageId: string) => stored.push(imageId),
    failure: (_runId: string, productId: string) => failures.push(productId),
    assertActive: () => undefined,
    assertCaptionCoverage: async () => undefined,
    setSetting: () => undefined,
    update: (_runId: string, values: Record<string, unknown>) =>
      runUpdates.push(values),
  });
  const progress: number[] = [];
  const job = {
    data: { runId: "caption-run" },
    updateProgress: async (value: number) => {
      progress.push(value);
    },
  } as Job<{ runId: string }>;

  await runner.captionBackfill(job);

  assert.deepEqual(updates.map((entry) => String(entry.id)).sort(), [
    "cached",
    "failed",
    "fresh",
    "no-image",
  ]);
  assert.equal(
    updates.find((entry) => entry.id === "no-image")?.generatedVisualCaption,
    null,
  );
  assert.equal(
    updates.find((entry) => entry.id === "fresh")?.generatedVisualCaption,
    "new detailed caption",
  );
  assert.equal(
    updates.find((entry) => entry.id === "cached")?.generatedVisualCaption,
    "cached detailed caption",
  );
  assert.equal(updates.find((entry) => entry.id === "failed")?.generatedVisualCaption, null);
  assert.deepEqual(
    (
      updates.find((entry) => entry.id === "fresh")?._vectors as Record<
        string,
        unknown
      >
    ).siglip_image,
    [[10]],
  );
  assert.deepEqual(
    (
      updates.find((entry) => entry.id === "fresh")?._vectors as Record<
        string,
        unknown
      >
    ).dinov2_image,
    [[20]],
  );
  assert.deepEqual(
    (
      updates.find((entry) => entry.id === "fresh")?._vectors as Record<
        string,
        unknown
      >
    ).dinov3_image,
    [[30]],
  );
  assert.deepEqual(stored, ["fresh-image"]);
  assert.deepEqual(failures, ["failed"]);
  assert.equal(runUpdates.at(-1)?.captioned_images, 1);
  assert.equal(runUpdates.at(-1)?.cached_captions, 1);
  assert.equal(runUpdates.at(-1)?.failed_captions, 1);
  assert.equal(progress.at(-1), 100);
});

test("caption embedder initialization preserves existing vectors", async () => {
  const { IndexRunner } = await import("./runner");
  const updates: Array<Record<string, unknown>> = [];
  const runner = Object.create(IndexRunner.prototype) as Record<string, unknown> & {
    seedCaptionOptOuts(job: Job, runId: string, uid: string, embedder: "e5_text_qwen"): Promise<void>;
  };
  Object.assign(runner, {
    meili: {
      count: async () => 1,
      vectorPage: async (_uid: string, offset: number) => offset === 0 ? [{ id: "one", vectors: { e5_text: [1], siglip_image_v2: [[2]] } }] : [],
      updateVectors: async (_uid: string, documents: Array<Record<string, unknown>>) => updates.push(...documents),
    },
    assertActive: () => undefined,
  });
  await runner.seedCaptionOptOuts({ updateProgress: async () => undefined } as unknown as Job, "run", "products", "e5_text_qwen");
  assert.deepEqual(updates[0]?._vectors, { e5_text: [1], siglip_image_v2: [[2]], e5_text_qwen: null });
});
