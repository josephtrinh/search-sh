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
  siglipEmbedded: number;
  siglipFailed: number;
  dinov2Embedded: number;
  dinov2Failed: number;
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

  async run(job: Job<{ runId: string; mode: "full" | "incremental" | "visual_backfill" }>) {
    const { runId, mode } = job.data;
    this.update(runId, { status: "running", started_at: new Date().toISOString() });
    try {
      if (mode === "full") await this.full(job);
      else if (mode === "incremental") await this.incremental(job);
      else await this.visualBackfill(job);
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
    let dinov2Embedded = 0;
    let dinov2Failed = 0;
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
      dinov2Embedded += result.dinov2Embedded;
      dinov2Failed += result.dinov2Failed;
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
        siglip_embedded_images: embedded,
        siglip_failed_images: failed,
        dinov2_embedded_images: dinov2Embedded,
        dinov2_failed_images: dinov2Failed,
      });
      await job.updateProgress(Math.round((processed / total) * 100));
    }
    if (processed !== total) throw new Error(`Expected ${total} products but indexed ${processed}`);
    if (referenced > 0 && embedded / referenced < 0.95) {
      throw new Error(`SigLIP image success rate ${((embedded / referenced) * 100).toFixed(2)}% is below 95%`);
    }
    if (referenced > 0 && dinov2Embedded / referenced < 0.95) {
      throw new Error(`DINOv2 image success rate ${((dinov2Embedded / referenced) * 100).toFixed(2)}% is below 95%`);
    }
    if (await this.meili.count(shadow) !== total) throw new Error("Shadow index document count did not match source");
    await this.meili.smoke(shadow);
    if (!(await this.meili.exists(config.MEILI_INDEX_UID))) await this.meili.create(config.MEILI_INDEX_UID);
    await this.meili.swap(config.MEILI_INDEX_UID, shadow);
    await this.meili.smoke(config.MEILI_INDEX_UID);
    await this.meili.deleteIndex(shadow);
    this.setSetting("dinov2_ready_fingerprint", config.DINOV2_FINGERPRINT);
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
    let dinov2Embedded = 0;
    let dinov2Failed = 0;
    const includeDinov2 = await this.meili.hasEmbedder(config.MEILI_INDEX_UID, "dinov2_image");
    for (let offset = 0; offset < changes.ids.length; offset += 20) {
      this.assertActive(runId);
      const ids = changes.ids.slice(offset, offset + 20);
      const products = await this.catalog.byIds(ids);
      const active = new Set(products.map((product) => product.id));
      await this.meili.deleteDocuments(config.MEILI_INDEX_UID, ids.filter((id) => !active.has(id)));
      if (products.length) {
        const result = await this.prepare(runId, products, includeDinov2);
        embedded += result.embedded;
        failed += result.failed;
        captioned += result.captioned;
        cached += result.cached;
        failedCaptions += result.failedCaptions;
        dinov2Embedded += result.dinov2Embedded;
        dinov2Failed += result.dinov2Failed;
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
        siglip_embedded_images: embedded,
        siglip_failed_images: failed,
        dinov2_embedded_images: dinov2Embedded,
        dinov2_failed_images: dinov2Failed,
      });
      await job.updateProgress(changes.ids.length ? Math.round((processed / changes.ids.length) * 100) : 100);
    }
    this.setWatermark("products", changes.productMax, "");
    this.setWatermark("files", changes.fileMax, "");
  }

  private async visualBackfill(job: Job<{ runId: string }>) {
    const runId = job.data.runId;
    if (!(await this.meili.exists(config.MEILI_INDEX_UID))) throw new Error("Run a full index before backfilling DINOv2");
    if (!(await this.meili.hasEmbedder(config.MEILI_INDEX_UID, "e5_text"))) throw new Error("The stable index uses the legacy vector schema; run a full index first");
    const total = await this.catalog.count();
    this.update(runId, { total_products: total, config_fingerprint: config.DINOV2_FINGERPRINT });
    if (!(await this.meili.hasEmbedder(config.MEILI_INDEX_UID, "dinov2_image"))) {
      await this.seedDinov2OptOuts(job, runId);
    }
    await this.meili.ensureDinov2Embedder(config.MEILI_INDEX_UID);
    const prior = this.db.prepare(`SELECT 1 FROM index_runs
      WHERE mode='visual_backfill' AND config_fingerprint=? AND id<>? LIMIT 1`).get(config.DINOV2_FINGERPRINT, runId);
    const resumeExisting = Boolean(prior) || this.getSetting("dinov2_ready_fingerprint") === config.DINOV2_FINGERPRINT;
    let after: string | null = null;
    let processed = 0;
    let referenced = 0;
    let embedded = 0;
    let failed = 0;
    for (;;) {
      this.assertActive(runId);
      const products = await this.catalog.batch(after, 20);
      if (!products.length) break;
      const existing = await this.meili.vectors(config.MEILI_INDEX_UID, products.map((product) => product.id));
      for (const product of products) {
        const vectors = existing.get(product.id);
        if (!vectors || !("e5_text" in vectors) || !("siglip_image" in vectors)) {
          throw new Error(`Cannot safely merge DINOv2 vectors for product ${product.id}: existing e5_text or siglip_image vectors were not returned`);
        }
      }
      const imageVectors: number[][][] = products.map(() => []);
      const skipped = new Set<number>();
      const works: AssetWork[] = [];
      products.forEach((product, productIndex) => {
        const assets = selectEmbeddingImages(product, config.IMAGE_EMBEDDING_MODE);
        referenced += assets.length;
        const current = existing.get(product.id)?.dinov2_image;
        if (resumeExisting && this.validVectorSet(current, assets.length)) {
          skipped.add(productIndex);
          embedded += assets.length;
          return;
        }
        for (const asset of assets) works.push({ key: `${product.id}:${asset.id}`, productIndex, productId: product.id, asset, embed: true, caption: false });
      });

      const buffers = new Map<string, Buffer>();
      for (let offset = 0; offset < works.length; offset += 8) {
        const chunk = works.slice(offset, offset + 8);
        const settled = await Promise.allSettled(chunk.map((work) => this.imageSource.get(work.asset.url)));
        settled.forEach((entry, position) => {
          const work = chunk[position]!;
          if (entry.status === "fulfilled") buffers.set(work.key, entry.value);
          else {
            failed++;
            this.failure(runId, work.productId, work.asset.id, "dinov2_s3_download", String(entry.reason));
          }
        });
      }

      const embeddable = works.filter((work) => buffers.has(work.key));
      for (let offset = 0; offset < embeddable.length; offset += 8) {
        const chunk = embeddable.slice(offset, offset + 8);
        const result = await runBatchWithIsolation(
          chunk,
          (batch) => this.inference.images(batch.map((work) => buffers.get(work.key)!), "dinov2"),
          isInferenceInputError,
        );
        for (const { item: work, value: vector } of result.successes) {
          imageVectors[work.productIndex]!.push(vector);
          embedded++;
        }
        for (const { item: work, error } of result.failures) {
          failed++;
          this.failure(runId, work.productId, work.asset.id, "dinov2_embedding", String(error));
        }
      }

      const updates = products.flatMap((product, productIndex) => skipped.has(productIndex) ? [] : [{
        id: product.id,
        _vectors: {
          ...(existing.get(product.id) ?? {}),
          dinov2_image: imageVectors[productIndex]!.length ? imageVectors[productIndex] : null,
        },
      }]);
      await this.meili.updateVectors(config.MEILI_INDEX_UID, updates);
      processed += products.length;
      after = products.at(-1)!.id;
      this.update(runId, {
        processed_products: processed,
        embedded_images: embedded,
        failed_images: failed,
        dinov2_embedded_images: embedded,
        dinov2_failed_images: failed,
      });
      await job.updateProgress(Math.round((processed / total) * 100));
    }
    if (processed !== total) throw new Error(`Expected ${total} products but backfilled ${processed}`);
    if (referenced > 0 && embedded / referenced < 0.95) {
      throw new Error(`DINOv2 image success rate ${((embedded / referenced) * 100).toFixed(2)}% is below 95%`);
    }
    this.setSetting("dinov2_ready_fingerprint", config.DINOV2_FINGERPRINT);
  }

  private async seedDinov2OptOuts(job: Job<{ runId: string }>, runId: string) {
    const expected = await this.meili.count(config.MEILI_INDEX_UID);
    let offset = 0;
    for (;;) {
      this.assertActive(runId);
      const page = await this.meili.vectorPage(config.MEILI_INDEX_UID, offset, 200);
      if (!page.length) break;
      const updates: Array<{ id: string; _vectors: Record<string, unknown> }> = [];
      for (const document of page) {
        if (!("e5_text" in document.vectors) || !("siglip_image" in document.vectors)) {
          throw new Error(`Cannot safely initialize DINOv2 for product ${document.id}: existing e5_text or siglip_image vectors were not returned`);
        }
        if (!Object.prototype.hasOwnProperty.call(document.vectors, "dinov2_image")) {
          updates.push({ id: document.id, _vectors: { ...document.vectors, dinov2_image: null } });
        }
      }
      await this.meili.updateVectors(config.MEILI_INDEX_UID, updates);
      offset += page.length;
      await job.updateProgress(0);
    }
    if (offset !== expected) throw new Error(`Expected to initialize ${expected} Meilisearch documents but visited ${offset}`);
  }

  private validVectorSet(value: unknown, expectedCount: number): boolean {
    const candidate = value && typeof value === "object" && !Array.isArray(value) && "embeddings" in value
      ? (value as { embeddings?: unknown }).embeddings : value;
    if (expectedCount === 0) return candidate === null || (Array.isArray(candidate) && candidate.length === 0);
    if (!Array.isArray(candidate)) return false;
    if (candidate.length === config.DINOV2_DIMENSIONS && candidate.every((entry) => typeof entry === "number")) return expectedCount === 1;
    return candidate.length === expectedCount && candidate.every((vector) => Array.isArray(vector)
      && vector.length === config.DINOV2_DIMENSIONS && vector.every((entry) => typeof entry === "number"));
  }

  private async prepare(runId: string, products: ProductDocument[], includeDinov2 = true): Promise<PrepareResult> {
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
    let dinov2Failed = 0;
    const allWorks = [...works.values()];
    for (let offset = 0; offset < allWorks.length; offset += 8) {
      const chunk = allWorks.slice(offset, offset + 8);
      const settled = await Promise.allSettled(chunk.map((work) => this.imageSource.get(work.asset.url)));
      settled.forEach((entry, position) => {
        const work = chunk[position]!;
        if (entry.status === "fulfilled") buffers.set(work.key, entry.value);
        else {
          if (work.embed) {
            failed++;
            if (includeDinov2) dinov2Failed++;
          }
          this.failure(runId, work.productId, work.asset.id, "s3_download", String(entry.reason));
        }
      });
    }

    const siglipImageVectors: number[][][] = products.map(() => []);
    const dinov2ImageVectors: number[][][] = products.map(() => []);
    const embeddable = allWorks.filter((work) => work.embed && buffers.has(work.key));
    let embedded = 0;
    for (let offset = 0; offset < embeddable.length; offset += 8) {
      const chunk = embeddable.slice(offset, offset + 8);
      const result = await runBatchWithIsolation(
        chunk,
        (batch) => this.inference.images(batch.map((work) => buffers.get(work.key)!), "siglip2"),
        isInferenceInputError,
      );
      for (const { item: work, value: vector } of result.successes) {
        siglipImageVectors[work.productIndex]!.push(vector);
        embedded++;
      }
      for (const { item: work, error } of result.failures) {
        failed++;
        this.failure(runId, work.productId, work.asset.id, "embedding", String(error));
      }
    }

    let dinov2Embedded = 0;
    if (includeDinov2) {
      for (let offset = 0; offset < embeddable.length; offset += 8) {
        const chunk = embeddable.slice(offset, offset + 8);
        const result = await runBatchWithIsolation(
          chunk,
          (batch) => this.inference.images(batch.map((work) => buffers.get(work.key)!), "dinov2"),
          isInferenceInputError,
        );
        for (const { item: work, value: vector } of result.successes) {
          dinov2ImageVectors[work.productIndex]!.push(vector);
          dinov2Embedded++;
        }
        for (const { item: work, error } of result.failures) {
          dinov2Failed++;
          this.failure(runId, work.productId, work.asset.id, "dinov2_embedding", String(error));
        }
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
    const documents = products.map((product, index) => {
      const vectors: Record<string, number[] | number[][] | undefined> = {
        e5_text: textVectors[index],
        siglip_image: siglipImageVectors[index],
      };
      if (includeDinov2) vectors.dinov2_image = dinov2ImageVectors[index];
      return { ...product, generatedVisualCaption: captions[index], _vectors: vectors };
    });
    return {
      documents, referenced, embedded, failed, captioned, cached, failedCaptions,
      siglipEmbedded: embedded, siglipFailed: failed, dinov2Embedded, dinov2Failed,
    };
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
  private getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key=?").get(key) as { value_json?: string } | undefined;
    if (!row?.value_json) return null;
    try { return String(JSON.parse(row.value_json)); } catch { return null; }
  }
  private setSetting(key: string, value: string) {
    this.db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`).run(key, JSON.stringify(value));
  }
}
