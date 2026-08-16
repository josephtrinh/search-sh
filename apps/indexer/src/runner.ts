import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Job } from "bullmq";
import type { ImageAsset, ProductDocument } from "@samplehub/contracts";
import { buildEmbeddingText } from "@samplehub/catalog";
import { runBatchWithIsolation } from "./batch-isolation";
import { CatalogRepository } from "./catalog";
import { ImageSource, InferenceClient, isInferenceInputError, MeiliClient } from "./clients";
import { config } from "./config";
import { selectEmbeddingImages } from "./image-selection";

interface AssetWork {
  key: string;
  productIndex: number;
  productId: string;
  asset: ImageAsset;
  embed: boolean;
  caption: boolean;
}

interface PrepareResult {
  documents: unknown[];
  referenced: number;
  embedded: number;
  failed: number;
  captioned: number;
  cached: number;
  failedCaptions: number;
}

export class IndexRunner {
  private readonly catalog = new CatalogRepository();
  private readonly inference = new InferenceClient();
  private readonly imageSource = new ImageSource();
  private readonly meili = new MeiliClient();
  private readonly db: Database.Database;

  constructor() {
    const path = resolve(config.STATE_DATABASE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS image_caption_cache (
      image_id TEXT NOT NULL, source_sha256 TEXT NOT NULL, model_id TEXT NOT NULL,
      model_revision TEXT NOT NULL, task TEXT NOT NULL, caption TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(image_id,source_sha256,model_id,model_revision,task)
    )`);
  }

  async close() {
    await this.catalog.close();
    this.db.close();
  }

  async run(job: Job<{ runId: string; mode: "full" | "incremental" }>) {
    const { runId, mode } = job.data;
    this.update(runId, { status: "running", started_at: new Date().toISOString() });
    try {
      if (mode === "full") await this.full(job);
      else await this.incremental(job);
      this.update(runId, { status: "completed", finished_at: new Date().toISOString() });
    } catch (error) {
      const cancelled = this.cancelling(runId);
      this.update(runId, {
        status: cancelled ? "cancelled" : "failed",
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      if (!cancelled) throw error;
    }
  }

  private async full(job: Job<{ runId: string }>) {
    const runId = job.data.runId;
    const rebuildStartedAt = new Date().toISOString();
    const total = await this.catalog.count();
    const shadow = `${config.MEILI_INDEX_UID}_build_${runId.replaceAll("-", "")}`;
    this.update(runId, { total_products: total });
    await this.meili.deleteIndex(shadow);
    await this.meili.create(shadow);
    await this.meili.configure(shadow);
    let after: string | null = null;
    let processed = 0;
    let embedded = 0;
    let failed = 0;
    let referenced = 0;
    let captioned = 0;
    let cached = 0;
    let failedCaptions = 0;
    for (;;) {
      this.assertActive(runId);
      const products = await this.catalog.batch(after, 20);
      if (!products.length) break;
      const result = await this.prepare(runId, products);
      referenced += result.referenced;
      embedded += result.embedded;
      failed += result.failed;
      captioned += result.captioned;
      cached += result.cached;
      failedCaptions += result.failedCaptions;
      await this.meili.add(shadow, result.documents);
      processed += products.length;
      after = products.at(-1)!.id;
      this.update(runId, {
        processed_products: processed,
        embedded_images: embedded,
        failed_images: failed,
        captioned_images: captioned,
        cached_captions: cached,
        failed_captions: failedCaptions,
      });
      await job.updateProgress(Math.round((processed / total) * 100));
    }
    if (processed !== total) throw new Error(`Expected ${total} products but indexed ${processed}`);
    if (referenced > 0 && embedded / referenced < 0.95) {
      throw new Error(`Image success rate ${((embedded / referenced) * 100).toFixed(2)}% is below 95%`);
    }
    if (await this.meili.count(shadow) !== total) throw new Error("Shadow index document count did not match source");
    await this.meili.smoke(shadow);
    if (!(await this.meili.exists(config.MEILI_INDEX_UID))) await this.meili.create(config.MEILI_INDEX_UID);
    await this.meili.swap(config.MEILI_INDEX_UID, shadow);
    await this.meili.smoke(config.MEILI_INDEX_UID);
    await this.meili.deleteIndex(shadow);
    this.setWatermark("products", rebuildStartedAt, "");
    this.setWatermark("files", rebuildStartedAt, "");
  }

  private async incremental(job: Job<{ runId: string }>) {
    const runId = job.data.runId;
    if (!(await this.meili.exists(config.MEILI_INDEX_UID))) throw new Error("Run a full index before incremental indexing");
    if (!(await this.meili.hasEmbedder(config.MEILI_INDEX_UID, "e5_text"))) throw new Error("The stable index uses the legacy vector schema; run a full index first");
    const productWatermark = this.watermark("products");
    const fileWatermark = this.watermark("files");
    const changes = await this.catalog.changedProductIds(productWatermark, fileWatermark);
    this.update(runId, { total_products: changes.ids.length });
    let processed = 0;
    let embedded = 0;
    let failed = 0;
    let captioned = 0;
    let cached = 0;
    let failedCaptions = 0;
    for (let offset = 0; offset < changes.ids.length; offset += 20) {
      this.assertActive(runId);
      const ids = changes.ids.slice(offset, offset + 20);
      const products = await this.catalog.byIds(ids);
      const active = new Set(products.map((product) => product.id));
      await this.meili.deleteDocuments(config.MEILI_INDEX_UID, ids.filter((id) => !active.has(id)));
      if (products.length) {
        const result = await this.prepare(runId, products);
        embedded += result.embedded;
        failed += result.failed;
        captioned += result.captioned;
        cached += result.cached;
        failedCaptions += result.failedCaptions;
        await this.meili.add(config.MEILI_INDEX_UID, result.documents);
      }
      processed += ids.length;
      this.update(runId, {
        processed_products: processed,
        embedded_images: embedded,
        failed_images: failed,
        captioned_images: captioned,
        cached_captions: cached,
        failed_captions: failedCaptions,
      });
      await job.updateProgress(changes.ids.length ? Math.round((processed / changes.ids.length) * 100) : 100);
    }
    this.setWatermark("products", changes.productMax, "");
    this.setWatermark("files", changes.fileMax, "");
  }

  private async prepare(runId: string, products: ProductDocument[]): Promise<PrepareResult> {
    const works = new Map<string, AssetWork>();
    let referenced = 0;
    products.forEach((product, productIndex) => {
      const embeddingAssets = selectEmbeddingImages(product, config.IMAGE_EMBEDDING_MODE);
      const captionAsset = selectEmbeddingImages(product, "thumbnail")[0];
      referenced += embeddingAssets.length;
      for (const asset of embeddingAssets) {
        const key = `${product.id}:${asset.id}`;
        works.set(key, { key, productIndex, productId: product.id, asset, embed: true, caption: asset.id === captionAsset?.id });
      }
      if (captionAsset && !embeddingAssets.some((asset) => asset.id === captionAsset.id)) {
        const key = `${product.id}:${captionAsset.id}`;
        works.set(key, { key, productIndex, productId: product.id, asset: captionAsset, embed: false, caption: true });
      }
    });

    const buffers = new Map<string, Buffer>();
    let failed = 0;
    const allWorks = [...works.values()];
    for (let offset = 0; offset < allWorks.length; offset += 8) {
      const chunk = allWorks.slice(offset, offset + 8);
      const settled = await Promise.allSettled(chunk.map((work) => this.imageSource.get(work.asset.url)));
      settled.forEach((entry, position) => {
        const work = chunk[position]!;
        if (entry.status === "fulfilled") buffers.set(work.key, entry.value);
        else {
          if (work.embed) failed++;
          this.failure(runId, work.productId, work.asset.id, "s3_download", String(entry.reason));
        }
      });
    }

    const imageVectors: number[][][] = products.map(() => []);
    const embeddable = allWorks.filter((work) => work.embed && buffers.has(work.key));
    let embedded = 0;
    for (let offset = 0; offset < embeddable.length; offset += 8) {
      const chunk = embeddable.slice(offset, offset + 8);
      const result = await runBatchWithIsolation(
        chunk,
        (batch) => this.inference.images(batch.map((work) => buffers.get(work.key)!)),
        isInferenceInputError,
      );
      for (const { item: work, value: vector } of result.successes) {
        imageVectors[work.productIndex]!.push(vector);
        embedded++;
      }
      for (const { item: work, error } of result.failures) {
        failed++;
        this.failure(runId, work.productId, work.asset.id, "embedding", String(error));
      }
    }

    const captions: Array<string | null> = products.map(() => null);
    const captionWorks = allWorks.filter((work) => work.caption && buffers.has(work.key));
    const misses: Array<AssetWork & { sha256: string }> = [];
    let cached = 0;
    for (const work of captionWorks) {
      const sha256 = createHash("sha256").update(buffers.get(work.key)!).digest("hex");
      const caption = this.cachedCaption(work.asset.id, sha256);
      if (caption !== null) {
        captions[work.productIndex] = caption;
        cached++;
      } else misses.push({ ...work, sha256 });
    }

    let captioned = 0;
    let failedCaptions = 0;
    for (let offset = 0; offset < misses.length; offset += config.MAX_CAPTION_BATCH) {
      const chunk = misses.slice(offset, offset + config.MAX_CAPTION_BATCH);
      const result = await runBatchWithIsolation(
        chunk,
        (batch) => this.inference.captions(batch.map((work) => buffers.get(work.key)!)),
        isInferenceInputError,
      );
      for (const { item: work, value: caption } of result.successes) {
        const normalized = caption.trim();
        if (!normalized) {
          failedCaptions++;
          this.failure(runId, work.productId, work.asset.id, "captioning", "Florence returned an empty caption");
          continue;
        }
        captions[work.productIndex] = normalized;
        this.storeCaption(work.asset.id, work.sha256, normalized);
        captioned++;
      }
      for (const { item: work, error } of result.failures) {
        failedCaptions++;
        this.failure(runId, work.productId, work.asset.id, "captioning", String(error));
      }
    }

    const textVectors = await this.inference.textPassages(products.map((product, index) => buildEmbeddingText(product, captions[index])));
    if (textVectors.length !== products.length) throw new Error("Inference text response count did not match request");
    const documents = products.map((product, index) => ({
      ...product,
      generatedVisualCaption: captions[index],
      _vectors: { e5_text: textVectors[index], siglip_image: imageVectors[index] },
    }));
    return { documents, referenced, embedded, failed, captioned, cached, failedCaptions };
  }

  private cachedCaption(imageId: string, sourceSha256: string): string | null {
    const row = this.db.prepare(`SELECT caption FROM image_caption_cache
      WHERE image_id=? AND source_sha256=? AND model_id=? AND model_revision=? AND task=?`).get(
      imageId, sourceSha256, config.CAPTION_MODEL_ID, config.CAPTION_MODEL_REVISION, config.CAPTION_TASK,
    ) as { caption?: string } | undefined;
    return row?.caption ?? null;
  }

  private storeCaption(imageId: string, sourceSha256: string, caption: string) {
    this.db.prepare(`INSERT INTO image_caption_cache(image_id,source_sha256,model_id,model_revision,task,caption)
      VALUES(?,?,?,?,?,?) ON CONFLICT(image_id,source_sha256,model_id,model_revision,task)
      DO UPDATE SET caption=excluded.caption,updated_at=CURRENT_TIMESTAMP`).run(
      imageId, sourceSha256, config.CAPTION_MODEL_ID, config.CAPTION_MODEL_REVISION, config.CAPTION_TASK, caption,
    );
  }

  private assertActive(runId: string) {
    if (this.cancelling(runId)) throw new Error("Index run cancelled");
  }
  private cancelling(runId: string): boolean {
    return (this.db.prepare("SELECT status FROM index_runs WHERE id=?").get(runId) as { status?: string } | undefined)?.status === "cancelling";
  }
  private update(runId: string, values: Record<string, unknown>) {
    const entries = Object.entries(values);
    this.db.prepare(`UPDATE index_runs SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`).run(...entries.map(([, value]) => value), runId);
  }
  private failure(runId: string, productId: string, imageId: string, code: string, message: string) {
    this.db.prepare("INSERT INTO index_failures(run_id,product_id,image_id,code,message,retryable) VALUES(?,?,?,?,?,1)").run(runId, productId, imageId, code, message.slice(0, 1000));
  }
  private watermark(stream: string): string {
    return (this.db.prepare("SELECT updated_at FROM sync_watermarks WHERE stream=?").get(stream) as { updated_at?: string } | undefined)?.updated_at ?? "1970-01-01T00:00:00.000Z";
  }
  private setWatermark(stream: string, updatedAt: string, id: string) {
    this.db.prepare(`INSERT INTO sync_watermarks(stream,updated_at,entity_id,updated_on) VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(stream) DO UPDATE SET updated_at=excluded.updated_at,entity_id=excluded.entity_id,updated_on=CURRENT_TIMESTAMP`).run(stream, updatedAt, id);
  }
}
