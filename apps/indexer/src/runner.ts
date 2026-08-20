import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Job } from "bullmq";
import { ManagedMeilisearchSettingsSchema, defaultManagedMeilisearchSettings, type CaptionProvider, type ImageAsset, type IndexRunMode, type IndexScope, type ManagedMeilisearchSettings, type ProductDocument, type VisualGeneration, type VisualModel } from "@samplehub/contracts";
import { buildEmbeddingText } from "@samplehub/catalog";
import { runBatchWithIsolation } from "./batch-isolation";
import { CatalogRepository } from "./catalog";
import { ImageSource, InferenceClient, isInferenceInputError, MeiliClient } from "./clients";
import { config } from "./config";
import { captionEmbedder, captionField, captionModel, captionReadyKey } from "./caption-provider";
import { selectEmbeddingImages } from "./image-selection";
import { CatalogImageError, normalizeCatalogImage } from "./image-normalizer";
import { mergeTextVector, mergeVisualVector, validVisualVectorSet, type VisualEmbedder } from "./visual-vectors";
import { previewIndexUid, visualEmbedder, visualFingerprint, type VisualEmbeddingState } from "./visual-generation";

interface IndexJobData {
  runId: string;
  mode: IndexRunMode;
  generation?: VisualGeneration;
  productLimit?: number;
  captionProvider?: CaptionProvider;
  targetScope?: IndexScope;
}

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
  dinov3Embedded: number;
  dinov3Failed: number;
  normalizedImages: number;
  rejectedSourceImages: number;
  eligibleProducts: number;
  siglipCoveredProducts: number;
  dinov2CoveredProducts: number;
  dinov3CoveredProducts: number;
}

interface VisualBackfillTarget {
  model: "dinov2" | "dinov3";
  mode: "visual_backfill" | "dinov3_backfill";
  label: "DINOv2" | "DINOv3";
  embedder: VisualEmbedder;
  dimensions: number;
  fingerprint: string;
  readySetting: "dinov2_ready_fingerprint" | "dinov3_ready_fingerprint";
  embeddedColumn: "dinov2_embedded_images" | "dinov3_embedded_images";
  failedColumn: "dinov2_failed_images" | "dinov3_failed_images";
}

interface CaptionBackfillCandidate {
  product: ProductDocument & { _vectors: Record<string, unknown> };
  caption: string | null;
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

  async run(job: Job<IndexJobData>) {
    const { runId, mode } = job.data;
    if (this.cancelling(runId)) {
      let cleanupError: unknown;
      try { await this.cleanupRunShadow(job.data); } catch (cause) { cleanupError = cause; }
      this.update(runId, {
        status: "cancelled",
        finished_at: new Date().toISOString(),
        error: ["Index run cancelled before it started", cleanupError ? `Shadow cleanup failed: ${String(cleanupError)}` : null].filter(Boolean).join(" · "),
      });
      return;
    }
    this.update(runId, { status: "running", started_at: new Date().toISOString() });
    try {
      if (mode === "full") await this.full(job);
      else if (mode === "limited_full") await this.limitedFull(job);
      else if (mode === "incremental") await this.incremental(job);
      else if (mode === "visual_backfill") await this.visualBackfill(job, this.backfillTarget("dinov2"));
      else if (mode === "dinov3_backfill") await this.visualBackfill(job, this.backfillTarget("dinov3"));
      else if (mode === "caption_backfill") await this.captionBackfill(job);
      else throw new Error(`Unsupported index run mode: ${String(mode)}`);
      this.update(runId, { status: "completed", finished_at: new Date().toISOString() });
    } catch (error) {
      const cancelled = this.cancelling(runId);
      let cleanupError: unknown;
      if (cancelled) {
        try { await this.cleanupRunShadow(job.data); } catch (cause) { cleanupError = cause; }
      }
      this.update(runId, {
        status: cancelled ? "cancelled" : "failed",
        finished_at: new Date().toISOString(),
        error: [error instanceof Error ? error.message : String(error), cleanupError ? `Shadow cleanup failed: ${String(cleanupError)}` : null].filter(Boolean).join(" · "),
      });
      if (!cancelled) throw error;
    }
  }

  private async full(job: Job<IndexJobData>) {
    await this.rebuild(job, "current");
  }

  private async limitedFull(job: Job<IndexJobData>) {
    const generation = job.data.generation ?? "current";
    const productLimit = job.data.productLimit ?? 10_000;
    if (!Number.isInteger(productLimit) || productLimit < 1 || productLimit > 25_000) {
      throw new Error("Limited preview product limit must be between 1 and 25,000");
    }
    await this.rebuild(job, generation, productLimit);
  }

  private async rebuild(job: Job<IndexJobData>, generation: VisualGeneration, productLimit?: number) {
    const runId = job.data.runId;
    const rebuildStartedAt = new Date().toISOString();
    const sourceTotal = await this.catalog.count();
    const sampleIds = productLimit ? await this.catalog.deterministicSampleIds(Math.min(productLimit, sourceTotal)) : null;
    const total = sampleIds?.length ?? sourceTotal;
    const preview = productLimit !== undefined;
    const previewTarget = preview ? previewIndexUid(generation) : null;
    const shadow = `${previewTarget ?? config.MEILI_INDEX_UID}_build_${runId.replaceAll("-", "")}`;
    const coverageThreshold = preview ? config.PREVIEW_VISUAL_COVERAGE_MIN : config.STABLE_VISUAL_COVERAGE_MIN;
    this.update(runId, { total_products: total, visual_coverage_threshold: coverageThreshold });
    if (preview) await this.cleanupStalePreviewShadows(previewTarget!, shadow);
    await this.meili.deleteIndex(shadow);
    await this.meili.create(shadow);
    await this.meili.configure(shadow, generation, this.meilisearchSettingsProfile());
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
    let dinov3Embedded = 0;
    let dinov3Failed = 0;
    let normalizedImages = 0;
    let rejectedSourceImages = 0;
    let eligibleProducts = 0;
    let siglipCoveredProducts = 0;
    let dinov2CoveredProducts = 0;
    let dinov3CoveredProducts = 0;
    for (;;) {
      this.assertActive(runId);
      const products: ProductDocument[] = sampleIds
        ? await this.catalog.byIds(sampleIds.slice(processed, processed + 20))
        : await this.catalog.batch(after, 20);
      if (!products.length) break;
      const result = await this.prepare(runId, products, { dinov2: true, dinov3: true }, generation);
      referenced += result.referenced;
      embedded += result.embedded;
      failed += result.failed;
      captioned += result.captioned;
      cached += result.cached;
      failedCaptions += result.failedCaptions;
      dinov2Embedded += result.dinov2Embedded;
      dinov2Failed += result.dinov2Failed;
      dinov3Embedded += result.dinov3Embedded;
      dinov3Failed += result.dinov3Failed;
      normalizedImages += result.normalizedImages;
      rejectedSourceImages += result.rejectedSourceImages;
      eligibleProducts += result.eligibleProducts;
      siglipCoveredProducts += result.siglipCoveredProducts;
      dinov2CoveredProducts += result.dinov2CoveredProducts;
      dinov3CoveredProducts += result.dinov3CoveredProducts;
      await this.meili.add(shadow, result.documents);
      processed += products.length;
      after = sampleIds ? null : products.at(-1)!.id;
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
        dinov3_embedded_images: dinov3Embedded,
        dinov3_failed_images: dinov3Failed,
        normalized_images: normalizedImages,
        rejected_source_images: rejectedSourceImages,
        visual_eligible_products: eligibleProducts,
        siglip_covered_products: siglipCoveredProducts,
        dinov2_covered_products: dinov2CoveredProducts,
        dinov3_covered_products: dinov3CoveredProducts,
      });
      await job.updateProgress(Math.round((processed / total) * 100));
    }
    if (processed !== total) throw new Error(`Expected ${total} products but indexed ${processed}`);
    const coverage = {
      siglip2: this.coverage(siglipCoveredProducts, eligibleProducts),
      dinov2: this.coverage(dinov2CoveredProducts, eligibleProducts),
      dinov3: this.coverage(dinov3CoveredProducts, eligibleProducts),
    };
    for (const [label, ratio] of Object.entries(coverage)) {
      if (ratio < coverageThreshold) throw new Error(`${label} product coverage ${(ratio * 100).toFixed(2)}% is below ${(coverageThreshold * 100).toFixed(0)}%`);
    }
    const qualityWarning = preview && Object.values(coverage).some((ratio) => ratio < config.STABLE_VISUAL_COVERAGE_MIN)
      ? `Preview completed below the ${(config.STABLE_VISUAL_COVERAGE_MIN * 100).toFixed(0)}% production coverage target`
      : null;
    this.update(runId, { quality_warning: qualityWarning });
    if (await this.meili.count(shadow) !== total) throw new Error("Shadow index document count did not match source");
    await this.meili.smoke(shadow);
    if (preview) {
      if (!(await this.meili.exists(previewTarget!))) await this.meili.create(previewTarget!);
      await this.meili.swap(previewTarget!, shadow);
      await this.meili.smoke(previewTarget!);
      await this.meili.deleteIndex(shadow);
      this.setSetting(`preview_${generation}_metadata`, { sourceCount: sourceTotal, limit: productLimit, count: total, generation, coverage, qualityWarning, completedAt: new Date().toISOString() });
      this.setSetting(captionReadyKey(previewTarget!, config.CAPTION_INDEX_PROVIDER), config.CAPTION_FINGERPRINTS[config.CAPTION_INDEX_PROVIDER]);
      this.deleteSetting(captionReadyKey(previewTarget!, config.CAPTION_INDEX_PROVIDER === "qwen" ? "florence" : "qwen"));
      return;
    }
    if (!(await this.meili.exists(config.MEILI_INDEX_UID))) await this.meili.create(config.MEILI_INDEX_UID);
    await this.meili.swap(config.MEILI_INDEX_UID, shadow);
    await this.meili.smoke(config.MEILI_INDEX_UID);
    await this.meili.deleteIndex(shadow);
    this.setSetting("stable_visual_generation", generation);
    this.setSetting("siglip_ready_fingerprint", visualFingerprint("siglip2", generation));
    this.setSetting("dinov2_ready_fingerprint", visualFingerprint("dinov2", generation));
    this.setSetting("dinov3_ready_fingerprint", visualFingerprint("dinov3", generation));
    this.setSetting(captionReadyKey(config.MEILI_INDEX_UID, config.CAPTION_INDEX_PROVIDER), config.CAPTION_FINGERPRINTS[config.CAPTION_INDEX_PROVIDER]);
    this.deleteSetting(captionReadyKey(config.MEILI_INDEX_UID, config.CAPTION_INDEX_PROVIDER === "qwen" ? "florence" : "qwen"));
    this.setWatermark("products", rebuildStartedAt, "");
    this.setWatermark("files", rebuildStartedAt, "");
  }

  private async incremental(job: Job<{ runId: string }>) {
    const runId = job.data.runId;
    if (!(await this.meili.exists(config.MEILI_INDEX_UID))) throw new Error("Run a full index before incremental indexing");
    if (!(await this.meili.hasEmbedder(config.MEILI_INDEX_UID, captionEmbedder(config.CAPTION_INDEX_PROVIDER)))) throw new Error(`The stable index does not have ${config.CAPTION_INDEX_PROVIDER} caption vectors; run a full index or provider backfill first`);
    const captionReadiness = this.getSetting(captionReadyKey(config.MEILI_INDEX_UID, config.CAPTION_INDEX_PROVIDER));
    if (config.CAPTION_INDEX_PROVIDER === "qwen" && captionReadiness !== config.CAPTION_FINGERPRINTS.qwen) {
      throw new Error("Complete a successful stable Qwen caption backfill before Qwen-only incremental indexing");
    }
    if (config.CAPTION_INDEX_PROVIDER === "florence" && captionReadiness !== null && captionReadiness !== config.CAPTION_FINGERPRINTS.florence) {
      throw new Error("Complete a successful stable Florence caption backfill before incremental indexing with the changed caption settings");
    }
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
    let dinov3Embedded = 0;
    let dinov3Failed = 0;
    let normalizedImages = 0;
    let rejectedSourceImages = 0;
    let eligibleProducts = 0;
    let siglipCoveredProducts = 0;
    let dinov2CoveredProducts = 0;
    let dinov3CoveredProducts = 0;
    const generation = await this.meili.generation(config.MEILI_INDEX_UID);
    const includeDinov2 = await this.meili.hasEmbedder(config.MEILI_INDEX_UID, visualEmbedder("dinov2", generation));
    const includeDinov3 = await this.meili.hasEmbedder(config.MEILI_INDEX_UID, visualEmbedder("dinov3", generation));
    for (let offset = 0; offset < changes.ids.length; offset += 20) {
      this.assertActive(runId);
      const ids = changes.ids.slice(offset, offset + 20);
      const products = await this.catalog.byIds(ids);
      const active = new Set(products.map((product) => product.id));
      await this.meili.deleteDocuments(config.MEILI_INDEX_UID, ids.filter((id) => !active.has(id)));
      if (products.length) {
        const result = await this.prepare(runId, products, { dinov2: includeDinov2, dinov3: includeDinov3 }, generation);
        embedded += result.embedded;
        failed += result.failed;
        captioned += result.captioned;
        cached += result.cached;
        failedCaptions += result.failedCaptions;
        dinov2Embedded += result.dinov2Embedded;
        dinov2Failed += result.dinov2Failed;
        dinov3Embedded += result.dinov3Embedded;
        dinov3Failed += result.dinov3Failed;
        normalizedImages += result.normalizedImages;
        rejectedSourceImages += result.rejectedSourceImages;
        eligibleProducts += result.eligibleProducts;
        siglipCoveredProducts += result.siglipCoveredProducts;
        dinov2CoveredProducts += result.dinov2CoveredProducts;
        dinov3CoveredProducts += result.dinov3CoveredProducts;
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
        dinov3_embedded_images: dinov3Embedded,
        dinov3_failed_images: dinov3Failed,
        normalized_images: normalizedImages,
        rejected_source_images: rejectedSourceImages,
        visual_eligible_products: eligibleProducts,
        siglip_covered_products: siglipCoveredProducts,
        dinov2_covered_products: dinov2CoveredProducts,
        dinov3_covered_products: dinov3CoveredProducts,
      });
      await job.updateProgress(changes.ids.length ? Math.round((processed / changes.ids.length) * 100) : 100);
    }
    this.setWatermark("products", changes.productMax, "");
    this.setWatermark("files", changes.fileMax, "");
    if (changes.ids.length) {
      this.setSetting(captionReadyKey(config.MEILI_INDEX_UID, config.CAPTION_INDEX_PROVIDER), config.CAPTION_FINGERPRINTS[config.CAPTION_INDEX_PROVIDER]);
      this.setSetting(captionReadyKey(config.MEILI_INDEX_UID, config.CAPTION_INDEX_PROVIDER === "qwen" ? "florence" : "qwen"), "invalidated");
    }
  }

  private backfillTarget(model: "dinov2" | "dinov3"): VisualBackfillTarget {
    return model === "dinov2" ? {
      model, mode: "visual_backfill", label: "DINOv2", embedder: "dinov2_image_v2",
      dimensions: config.DINOV2_DIMENSIONS, fingerprint: config.DINOV2_FINGERPRINT,
      readySetting: "dinov2_ready_fingerprint", embeddedColumn: "dinov2_embedded_images",
      failedColumn: "dinov2_failed_images",
    } : {
      model, mode: "dinov3_backfill", label: "DINOv3", embedder: "dinov3_image_v2",
      dimensions: config.DINOV3_DIMENSIONS, fingerprint: config.DINOV3_FINGERPRINT,
      readySetting: "dinov3_ready_fingerprint", embeddedColumn: "dinov3_embedded_images",
      failedColumn: "dinov3_failed_images",
    };
  }

  private async visualBackfill(job: Job<{ runId: string }>, target: VisualBackfillTarget) {
    const runId = job.data.runId;
    if (!(await this.meili.exists(config.MEILI_INDEX_UID))) throw new Error(`Run a full index before backfilling ${target.label}`);
    if (!(await this.meili.hasEmbedder(config.MEILI_INDEX_UID, "e5_text")) && !(await this.meili.hasEmbedder(config.MEILI_INDEX_UID, "e5_text_qwen"))) throw new Error("The stable index has no caption-aware E5 embedder; run a full index first");
    if ((await this.meili.generation(config.MEILI_INDEX_UID)) !== "current") {
      throw new Error(`${target.label} current-generation backfill requires a current-generation full rebuild`);
    }
    const total = await this.catalog.count();
    this.update(runId, { total_products: total, config_fingerprint: target.fingerprint });
    if (!(await this.meili.hasEmbedder(config.MEILI_INDEX_UID, target.embedder))) {
      await this.seedVisualOptOuts(job, runId, target);
    }
    await this.meili.ensureVisualEmbedder(config.MEILI_INDEX_UID, target.model, "current");
    const prior = this.db.prepare(`SELECT 1 FROM index_runs
      WHERE mode=? AND config_fingerprint=? AND id<>? LIMIT 1`).get(target.mode, target.fingerprint, runId);
    const resumeExisting = Boolean(prior) || this.getSetting(target.readySetting) === target.fingerprint;
    let after: string | null = null;
    let processed = 0;
    let referenced = 0;
    let embedded = 0;
    let failed = 0;
    let normalizedImages = 0;
    let rejectedSourceImages = 0;
    let eligibleProducts = 0;
    let coveredProducts = 0;
    for (;;) {
      this.assertActive(runId);
      const products = await this.catalog.batch(after, 20);
      if (!products.length) break;
      const existing = await this.meili.vectors(config.MEILI_INDEX_UID, products.map((product) => product.id));
      for (const product of products) {
        const vectors = existing.get(product.id)?.vectors;
        if (!vectors || (!("e5_text" in vectors) && !("e5_text_qwen" in vectors)) || !("siglip_image_v2" in vectors)) {
          throw new Error(`Cannot safely merge ${target.label} vectors for product ${product.id}: an E5 or SigLIP vector was not returned`);
        }
      }
      const imageVectors: number[][][] = products.map(() => []);
      const skipped = new Set<number>();
      const works: AssetWork[] = [];
      products.forEach((product, productIndex) => {
        const assets = selectEmbeddingImages(product, config.IMAGE_EMBEDDING_MODE);
        referenced += assets.length;
        if (assets.length) eligibleProducts++;
        const current = existing.get(product.id)?.vectors[target.embedder];
        const state = existing.get(product.id)?.state as VisualEmbeddingState | undefined;
        const expectedFingerprint = visualFingerprint(target.model, "current");
        if (resumeExisting && state?.fingerprints?.[target.model] === expectedFingerprint && validVisualVectorSet(current, state.vectorCounts?.[target.model] ?? 0, target.dimensions)) {
          skipped.add(productIndex);
          embedded += assets.length;
          if (assets.length) coveredProducts++;
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
            if (entry.reason instanceof CatalogImageError && entry.reason.code === "catalog_image_source_too_large") rejectedSourceImages++;
            this.failure(runId, work.productId, work.asset.id, `${target.model}_s3_download`, String(entry.reason));
          }
        });
      }

      for (let offset = 0; offset < works.length; offset += 4) {
        const chunk = works.slice(offset, offset + 4).filter((work) => buffers.has(work.key));
        const settled = await Promise.allSettled(chunk.map((work) => normalizeCatalogImage(buffers.get(work.key)!)));
        settled.forEach((entry, position) => {
          const work = chunk[position]!;
          if (entry.status === "fulfilled") {
            buffers.set(work.key, entry.value.buffer);
            if (entry.value.normalized) normalizedImages++;
            return;
          }
          buffers.delete(work.key);
          failed++;
          if (entry.reason instanceof CatalogImageError && entry.reason.code === "catalog_image_source_too_large") rejectedSourceImages++;
          const code = entry.reason instanceof CatalogImageError ? entry.reason.code : "catalog_image_normalization";
          this.failure(runId, work.productId, work.asset.id, code, String(entry.reason));
        });
      }

      const embeddable = works.filter((work) => buffers.has(work.key));
      for (let offset = 0; offset < embeddable.length; offset += 8) {
        const chunk = embeddable.slice(offset, offset + 8);
        const result = await runBatchWithIsolation(
          chunk,
          (batch) => this.inference.catalogImages(batch.map((work) => buffers.get(work.key)!), target.model, "current"),
          isInferenceInputError,
        );
        for (const { item: work, value: vectors } of result.successes) {
          imageVectors[work.productIndex]!.push(...vectors);
          embedded++;
        }
        for (const { item: work, error } of result.failures) {
          failed++;
          this.failure(runId, work.productId, work.asset.id, `${target.model}_embedding`, String(error));
        }
      }

      const updates = products.flatMap((product, productIndex) => {
        if (skipped.has(productIndex)) return [];
        const entry = existing.get(product.id)!;
        const priorState = (entry.state ?? {}) as Partial<VisualEmbeddingState>;
        const vectorCount = imageVectors[productIndex]!.length;
        return [{
          id: product.id,
          _visualEmbeddingState: {
            generation: "current",
            fingerprints: { ...(priorState.fingerprints ?? {}), [target.model]: visualFingerprint(target.model, "current") },
            vectorCounts: { ...(priorState.vectorCounts ?? {}), [target.model]: vectorCount },
          },
          _vectors: mergeVisualVector(entry.vectors, target.embedder, vectorCount ? imageVectors[productIndex]! : null),
        }];
      });
      coveredProducts += products.reduce((count, _product, productIndex) => count + (skipped.has(productIndex) ? 0 : imageVectors[productIndex]!.length > 0 ? 1 : 0), 0);
      await this.meili.updateVectors(config.MEILI_INDEX_UID, updates);
      processed += products.length;
      after = products.at(-1)!.id;
      this.update(runId, {
        processed_products: processed,
        embedded_images: embedded,
        failed_images: failed,
        [target.embeddedColumn]: embedded,
        [target.failedColumn]: failed,
        normalized_images: normalizedImages,
        rejected_source_images: rejectedSourceImages,
        visual_eligible_products: eligibleProducts,
        [target.model === "dinov2" ? "dinov2_covered_products" : "dinov3_covered_products"]: coveredProducts,
        visual_coverage_threshold: config.STABLE_VISUAL_COVERAGE_MIN,
      });
      await job.updateProgress(Math.round((processed / total) * 100));
    }
    if (processed !== total) throw new Error(`Expected ${total} products but backfilled ${processed}`);
    const coverage = this.coverage(coveredProducts, eligibleProducts);
    if (coverage < config.STABLE_VISUAL_COVERAGE_MIN) {
      throw new Error(`${target.label} product coverage ${(coverage * 100).toFixed(2)}% is below ${(config.STABLE_VISUAL_COVERAGE_MIN * 100).toFixed(0)}%`);
    }
    this.setSetting(target.readySetting, target.fingerprint);
  }

  private async captionBackfill(job: Job<IndexJobData>) {
    const { runId } = job.data;
    const provider = job.data.captionProvider ?? "florence";
    const scope = job.data.targetScope ?? "stable";
    const uid = this.indexUidForScope(scope);
    const field = captionField(provider);
    const embedder = captionEmbedder(provider);
    const model = captionModel(provider);
    if (!(await this.meili.exists(uid))) throw new Error(`The ${scope} index does not exist`);
    if (!(await this.meili.hasEmbedder(uid, embedder))) {
      await this.seedCaptionOptOuts(job, runId, uid, embedder);
    }
    await this.meili.ensureCaptionEmbedder(uid, provider);
    const total = await this.meili.count(uid);
    this.update(runId, {
      total_products: total,
      config_fingerprint: config.CAPTION_FINGERPRINTS[provider],
      caption_provider: provider,
      target_scope: scope,
    });

    let processed = 0;
    let captioned = 0;
    let cached = 0;
    let failedCaptions = 0;
    let normalizedImages = 0;
    let rejectedSourceImages = 0;
    let smokeVector: number[] | null = null;
    let consecutiveQwenFailures = 0;
    for (;;) {
      this.assertActive(runId);
      const products = await this.meili.documentPage(uid, processed, 20);
      if (!products.length) break;
      const candidates: CaptionBackfillCandidate[] = [];
      const imageWorks = products.flatMap((product) => {
        const asset = selectEmbeddingImages(product, "thumbnail")[0];
        if (!asset) {
          candidates.push({ product, caption: null });
          return [];
        }
        return [{ product, asset }];
      });
      const misses: Array<{ product: (typeof products)[number]; asset: ImageAsset; buffer: Buffer; sha256: string }> = [];
      for (let offset = 0; offset < imageWorks.length; offset += 8) {
        const chunk = imageWorks.slice(offset, offset + 8);
        const settled = await Promise.allSettled(chunk.map(async (work) => normalizeCatalogImage(await this.imageSource.get(work.asset.url))));
        settled.forEach((entry, position) => {
          const work = chunk[position]!;
          if (entry.status === "rejected") {
            failedCaptions++;
            if (entry.reason instanceof CatalogImageError && entry.reason.code === "catalog_image_source_too_large") rejectedSourceImages++;
            this.failure(runId, work.product.id, work.asset.id, entry.reason instanceof CatalogImageError ? entry.reason.code : "caption_s3_download", String(entry.reason));
            if (!(typeof work.product[field] === "string" && embedder in work.product._vectors)) candidates.push({ product: work.product, caption: null });
            return;
          }
          if (entry.value.normalized) normalizedImages++;
          const sha256 = createHash("sha256").update(entry.value.buffer).digest("hex");
          const cachedCaption = this.cachedCaption(work.asset.id, sha256, provider);
          if (cachedCaption !== undefined) {
            cached++;
            candidates.push({ product: work.product, caption: cachedCaption });
          } else misses.push({ ...work, buffer: entry.value.buffer, sha256 });
        });
      }

      for (let offset = 0; offset < misses.length; offset += model.batch) {
        const chunk = misses.slice(offset, offset + model.batch);
        const result = await runBatchWithIsolation(chunk, (batch) => this.inference.captions(batch.map((work) => work.buffer), provider), isInferenceInputError);
        const serviceFailure = result.failures.find(({ error }) => !isInferenceInputError(error));
        if (serviceFailure) throw serviceFailure.error;
        for (const { item: work, value } of result.successes) {
          consecutiveQwenFailures = 0;
          const caption = value?.trim() || null;
          if (provider === "florence" && !caption) {
            failedCaptions++;
            this.failure(runId, work.product.id, work.asset.id, "captioning", "Florence returned an empty caption");
            if (!(typeof work.product[field] === "string" && embedder in work.product._vectors)) candidates.push({ product: work.product, caption: null });
            continue;
          }
          this.storeCaption(work.asset.id, work.sha256, caption, provider);
          captioned++;
          candidates.push({ product: work.product, caption });
        }
        for (const { item: work, error } of result.failures) {
          failedCaptions++;
          this.failure(runId, work.product.id, work.asset.id, "captioning", String(error));
          if (!(typeof work.product[field] === "string" && embedder in work.product._vectors)) candidates.push({ product: work.product, caption: null });
          if (provider === "qwen" && ++consecutiveQwenFailures >= 5) {
            throw new Error(`Qwen rejected ${consecutiveQwenFailures} consecutive catalog images; stopping because this indicates a systemic server or request configuration problem`);
          }
        }
      }

      const textVectors = candidates.length ? await this.inference.textPassages(candidates.map(({ product, caption }) => buildEmbeddingText(product, caption))) : [];
      if (textVectors.length !== candidates.length) throw new Error("Inference text response count did not match caption backfill candidates");
      smokeVector ??= textVectors[0] ?? null;
      this.assertActive(runId);
      await this.meili.updateDocuments(uid, candidates.map(({ product, caption }, index) => ({
        id: product.id,
        [field]: caption,
        _vectors: mergeTextVector(product._vectors, textVectors[index]!, embedder),
      })));
      processed += products.length;
      this.update(runId, { processed_products: processed, captioned_images: captioned, cached_captions: cached, failed_captions: failedCaptions, normalized_images: normalizedImages, rejected_source_images: rejectedSourceImages });
      await job.updateProgress(total ? Math.round((processed / total) * 100) : 100);
    }
    if (processed !== total) throw new Error(`Expected ${total} products but visited ${processed}`);
    await this.assertCaptionCoverage(uid, embedder, total);
    if (smokeVector) await this.meili.semanticSmoke(uid, embedder, smokeVector);
    this.setSetting(captionReadyKey(uid, provider), config.CAPTION_FINGERPRINTS[provider]);
    await job.updateProgress(100);
  }

  private async seedCaptionOptOuts(job: Job<IndexJobData>, runId: string, uid: string, embedder: "e5_text" | "e5_text_qwen") {
    const expected = await this.meili.count(uid);
    let offset = 0;
    for (;;) {
      this.assertActive(runId);
      const page = await this.meili.vectorPage(uid, offset, 200);
      if (!page.length) break;
      const updates = page.flatMap((document) => Object.prototype.hasOwnProperty.call(document.vectors, embedder)
        ? []
        : [{ id: document.id, _vectors: { ...document.vectors, [embedder]: null } }]);
      await this.meili.updateVectors(uid, updates);
      offset += page.length;
      await job.updateProgress(0);
    }
    if (offset !== expected) throw new Error(`Expected to initialize ${expected} caption vectors but visited ${offset}`);
  }

  private async seedVisualOptOuts(job: Job<{ runId: string }>, runId: string, target: VisualBackfillTarget) {
    const expected = await this.meili.count(config.MEILI_INDEX_UID);
    let offset = 0;
    for (;;) {
      this.assertActive(runId);
      const page = await this.meili.vectorPage(config.MEILI_INDEX_UID, offset, 200);
      if (!page.length) break;
      const updates: Array<{ id: string; _vectors: Record<string, unknown> }> = [];
      for (const document of page) {
        if ((!("e5_text" in document.vectors) && !("e5_text_qwen" in document.vectors)) || !("siglip_image_v2" in document.vectors)) {
          throw new Error(`Cannot safely initialize ${target.label} for product ${document.id}: an E5 or SigLIP vector was not returned`);
        }
        if (!Object.prototype.hasOwnProperty.call(document.vectors, target.embedder)) {
          updates.push({ id: document.id, _vectors: mergeVisualVector(document.vectors, target.embedder, null) });
        }
      }
      await this.meili.updateVectors(config.MEILI_INDEX_UID, updates);
      offset += page.length;
      await job.updateProgress(0);
    }
    if (offset !== expected) throw new Error(`Expected to initialize ${expected} Meilisearch documents but visited ${offset}`);
  }

  private async prepare(
    runId: string,
    products: ProductDocument[],
    visual = { dinov2: true, dinov3: true },
    generation: VisualGeneration = "current",
  ): Promise<PrepareResult> {
    const captionProvider = config.CAPTION_INDEX_PROVIDER;
    const captionTargetField = captionField(captionProvider);
    const captionTargetEmbedder = captionEmbedder(captionProvider);
    const captionConfig = captionModel(captionProvider);
    const works = new Map<string, AssetWork>();
    let referenced = 0;
    let eligibleProducts = 0;
    products.forEach((product, productIndex) => {
      const embeddingAssets = selectEmbeddingImages(product, config.IMAGE_EMBEDDING_MODE);
      if (embeddingAssets.length) eligibleProducts++;
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
    let dinov3Failed = 0;
    let normalizedImages = 0;
    let rejectedSourceImages = 0;
    const allWorks = [...works.values()];
    for (let offset = 0; offset < allWorks.length; offset += 8) {
      const chunk = allWorks.slice(offset, offset + 8);
      const settled = await Promise.allSettled(chunk.map((work) => this.imageSource.get(work.asset.url)));
      settled.forEach((entry, position) => {
        const work = chunk[position]!;
        if (entry.status === "fulfilled") buffers.set(work.key, entry.value);
        else {
          if (entry.reason instanceof CatalogImageError && entry.reason.code === "catalog_image_source_too_large") rejectedSourceImages++;
          if (work.embed) {
            failed++;
            if (visual.dinov2) dinov2Failed++;
            if (visual.dinov3) dinov3Failed++;
          }
          this.failure(runId, work.productId, work.asset.id, "s3_download", String(entry.reason));
        }
      });
    }

    for (let offset = 0; offset < allWorks.length; offset += 4) {
      const chunk = allWorks.slice(offset, offset + 4).filter((work) => buffers.has(work.key));
      const settled = await Promise.allSettled(chunk.map((work) => normalizeCatalogImage(buffers.get(work.key)!)));
      settled.forEach((entry, position) => {
        const work = chunk[position]!;
        if (entry.status === "fulfilled") {
          buffers.set(work.key, entry.value.buffer);
          if (entry.value.normalized) normalizedImages++;
          return;
        }
        buffers.delete(work.key);
        if (entry.reason instanceof CatalogImageError && entry.reason.code === "catalog_image_source_too_large") rejectedSourceImages++;
        if (work.embed) {
          failed++;
          if (visual.dinov2) dinov2Failed++;
          if (visual.dinov3) dinov3Failed++;
        }
        const code = entry.reason instanceof CatalogImageError ? entry.reason.code : "catalog_image_normalization";
        this.failure(runId, work.productId, work.asset.id, code, String(entry.reason));
      });
    }

    const siglipImageVectors: number[][][] = products.map(() => []);
    const dinov2ImageVectors: number[][][] = products.map(() => []);
    const dinov3ImageVectors: number[][][] = products.map(() => []);
    const embeddable = allWorks.filter((work) => work.embed && buffers.has(work.key));
    let embedded = 0;
    for (let offset = 0; offset < embeddable.length; offset += 8) {
      const chunk = embeddable.slice(offset, offset + 8);
      const result = await runBatchWithIsolation(
        chunk,
        (batch) => this.inference.catalogImages(batch.map((work) => buffers.get(work.key)!), "siglip2", generation),
        isInferenceInputError,
      );
      for (const { item: work, value: vectors } of result.successes) {
        siglipImageVectors[work.productIndex]!.push(...vectors);
        embedded++;
      }
      for (const { item: work, error } of result.failures) {
        failed++;
        this.failure(runId, work.productId, work.asset.id, "embedding", String(error));
      }
    }

    let dinov2Embedded = 0;
    if (visual.dinov2) {
      for (let offset = 0; offset < embeddable.length; offset += 8) {
        const chunk = embeddable.slice(offset, offset + 8);
        const result = await runBatchWithIsolation(
          chunk,
          (batch) => this.inference.catalogImages(batch.map((work) => buffers.get(work.key)!), "dinov2", generation),
          isInferenceInputError,
        );
        for (const { item: work, value: vectors } of result.successes) {
          dinov2ImageVectors[work.productIndex]!.push(...vectors);
          dinov2Embedded++;
        }
        for (const { item: work, error } of result.failures) {
          dinov2Failed++;
          this.failure(runId, work.productId, work.asset.id, "dinov2_embedding", String(error));
        }
      }
    }

    let dinov3Embedded = 0;
    if (visual.dinov3) {
      for (let offset = 0; offset < embeddable.length; offset += 8) {
        const chunk = embeddable.slice(offset, offset + 8);
        const result = await runBatchWithIsolation(
          chunk,
          (batch) => this.inference.catalogImages(batch.map((work) => buffers.get(work.key)!), "dinov3", generation),
          isInferenceInputError,
        );
        for (const { item: work, value: vectors } of result.successes) {
          dinov3ImageVectors[work.productIndex]!.push(...vectors);
          dinov3Embedded++;
        }
        for (const { item: work, error } of result.failures) {
          dinov3Failed++;
          this.failure(runId, work.productId, work.asset.id, "dinov3_embedding", String(error));
        }
      }
    }

    const captions: Array<string | null> = products.map(() => null);
    const captionWorks = allWorks.filter((work) => work.caption && buffers.has(work.key));
    const misses: Array<AssetWork & { sha256: string }> = [];
    let cached = 0;
    for (const work of captionWorks) {
      const sha256 = createHash("sha256").update(buffers.get(work.key)!).digest("hex");
      const caption = this.cachedCaption(work.asset.id, sha256, captionProvider);
      if (caption !== undefined) {
        captions[work.productIndex] = caption;
        cached++;
      } else misses.push({ ...work, sha256 });
    }

    let captioned = 0;
    let failedCaptions = 0;
    let consecutiveQwenFailures = 0;
    for (let offset = 0; offset < misses.length; offset += captionConfig.batch) {
      const chunk = misses.slice(offset, offset + captionConfig.batch);
      const result = await runBatchWithIsolation(
        chunk,
        (batch) => this.inference.captions(batch.map((work) => buffers.get(work.key)!), captionProvider),
        isInferenceInputError,
      );
      if (captionProvider === "qwen") {
        const serviceFailure = result.failures.find(({ error }) => !isInferenceInputError(error));
        if (serviceFailure) throw serviceFailure.error;
      }
      for (const { item: work, value: caption } of result.successes) {
        consecutiveQwenFailures = 0;
        const normalized = caption?.trim() || null;
        if (captionProvider === "florence" && !normalized) {
          failedCaptions++;
          this.failure(runId, work.productId, work.asset.id, "captioning", "Florence returned an empty caption");
          continue;
        }
        captions[work.productIndex] = normalized;
        this.storeCaption(work.asset.id, work.sha256, normalized, captionProvider);
        captioned++;
      }
      for (const { item: work, error } of result.failures) {
        failedCaptions++;
        this.failure(runId, work.productId, work.asset.id, "captioning", String(error));
        if (captionProvider === "qwen" && ++consecutiveQwenFailures >= 5) {
          throw new Error(`Qwen rejected ${consecutiveQwenFailures} consecutive catalog images; stopping because this indicates a systemic server or request configuration problem`);
        }
      }
    }

    const textVectors = await this.inference.textPassages(products.map((product, index) => buildEmbeddingText(product, captions[index])));
    if (textVectors.length !== products.length) throw new Error("Inference text response count did not match request");
    const documents = products.map((product, index) => {
      const vectors: Record<string, number[] | number[][] | undefined> = {
        [captionTargetEmbedder]: textVectors[index],
        [visualEmbedder("siglip2", generation)]: siglipImageVectors[index],
      };
      if (visual.dinov2) vectors[visualEmbedder("dinov2", generation)] = dinov2ImageVectors[index];
      if (visual.dinov3) vectors[visualEmbedder("dinov3", generation)] = dinov3ImageVectors[index];
      const state: VisualEmbeddingState = {
        generation,
        fingerprints: {
          siglip2: visualFingerprint("siglip2", generation),
          ...(visual.dinov2 ? { dinov2: visualFingerprint("dinov2", generation) } : {}),
          ...(visual.dinov3 ? { dinov3: visualFingerprint("dinov3", generation) } : {}),
        },
        vectorCounts: {
          siglip2: siglipImageVectors[index]!.length,
          ...(visual.dinov2 ? { dinov2: dinov2ImageVectors[index]!.length } : {}),
          ...(visual.dinov3 ? { dinov3: dinov3ImageVectors[index]!.length } : {}),
        },
      };
      return { ...product, [captionTargetField]: captions[index], _visualEmbeddingState: state, _vectors: vectors };
    });
    return {
      documents, referenced, embedded, failed, captioned, cached, failedCaptions,
      siglipEmbedded: embedded, siglipFailed: failed, dinov2Embedded, dinov2Failed,
      dinov3Embedded, dinov3Failed, normalizedImages, rejectedSourceImages, eligibleProducts,
      siglipCoveredProducts: siglipImageVectors.filter((vectors) => vectors.length > 0).length,
      dinov2CoveredProducts: visual.dinov2 ? dinov2ImageVectors.filter((vectors) => vectors.length > 0).length : 0,
      dinov3CoveredProducts: visual.dinov3 ? dinov3ImageVectors.filter((vectors) => vectors.length > 0).length : 0,
    };
  }

  private cachedCaption(imageId: string, sourceSha256: string, provider: CaptionProvider = config.CAPTION_INDEX_PROVIDER): string | null | undefined {
    const model = captionModel(provider);
    const row = this.db.prepare(`SELECT caption FROM image_caption_cache
      WHERE image_id=? AND source_sha256=? AND model_id=? AND model_revision=? AND task=?`).get(
      imageId, sourceSha256, model.modelId, model.revision, model.task,
    ) as { caption?: string } | undefined;
    return row ? row.caption || null : undefined;
  }

  private storeCaption(imageId: string, sourceSha256: string, caption: string | null, provider: CaptionProvider = config.CAPTION_INDEX_PROVIDER) {
    const model = captionModel(provider);
    this.db.prepare(`INSERT INTO image_caption_cache(image_id,source_sha256,model_id,model_revision,task,caption)
      VALUES(?,?,?,?,?,?) ON CONFLICT(image_id,source_sha256,model_id,model_revision,task)
      DO UPDATE SET caption=excluded.caption,updated_at=CURRENT_TIMESTAMP`).run(
      imageId, sourceSha256, model.modelId, model.revision, model.task, caption ?? "",
    );
  }

  private indexUidForScope(scope: IndexScope): string {
    return scope === "stable" ? config.MEILI_INDEX_UID : previewIndexUid(scope === "preview_legacy" ? "legacy" : "current");
  }

  private async assertCaptionCoverage(uid: string, embedder: string, expected: number) {
    let offset = 0;
    for (;;) {
      const page = await this.meili.vectorPage(uid, offset, 200);
      if (!page.length) break;
      const missing = page.find((document) => !(embedder in document.vectors));
      if (missing) throw new Error(`Caption provider vector ${embedder} is missing for product ${missing.id}`);
      offset += page.length;
    }
    if (offset !== expected) throw new Error(`Caption readiness scan visited ${offset} of ${expected} products`);
  }

  private assertActive(runId: string) {
    if (this.cancelling(runId)) throw new Error("Index run cancelled");
  }
  private coverage(covered: number, eligible: number): number {
    return eligible === 0 ? 1 : covered / eligible;
  }
  private async cleanupRunShadow(data: IndexJobData) {
    if (data.mode !== "full" && data.mode !== "limited_full") return;
    const base = data.mode === "limited_full" ? previewIndexUid(data.generation ?? "current") : config.MEILI_INDEX_UID;
    await this.meili.deleteIndex(`${base}_build_${data.runId.replaceAll("-", "")}`);
  }
  private async cleanupStalePreviewShadows(base: string, current: string) {
    const prefix = `${base}_build_`;
    const runs = this.db.prepare("SELECT id,status FROM index_runs").all() as Array<{ id: string; status: string }>;
    const statuses = new Map(runs.map((run) => [run.id.replaceAll("-", ""), run.status]));
    for (const uid of await this.meili.listIndexes()) {
      if (!uid.startsWith(prefix) || uid === current) continue;
      const status = statuses.get(uid.slice(prefix.length));
      if (!status || ["completed", "failed", "cancelled"].includes(status)) await this.meili.deleteIndex(uid);
    }
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
  private meilisearchSettingsProfile(): ManagedMeilisearchSettings {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key='meilisearch_settings_profile_v2'").get() as { value_json?: string } | undefined;
    if (!row?.value_json) return structuredClone(defaultManagedMeilisearchSettings);
    try {
      const parsed = ManagedMeilisearchSettingsSchema.safeParse(JSON.parse(row.value_json));
      return parsed.success ? parsed.data : structuredClone(defaultManagedMeilisearchSettings);
    } catch {
      return structuredClone(defaultManagedMeilisearchSettings);
    }
  }
  private setSetting(key: string, value: unknown) {
    this.db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`).run(key, JSON.stringify(value));
  }
  private deleteSetting(key: string) {
    this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
  }
}
