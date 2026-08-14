import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Job } from "bullmq";
import type { ProductDocument } from "@samplehub/contracts";
import { buildEmbeddingText } from "@samplehub/catalog";
import { CatalogRepository } from "./catalog";
import { ImageSource, InferenceClient, MeiliClient } from "./clients";
import { config } from "./config";

export class IndexRunner {
  private readonly catalog = new CatalogRepository(); private readonly inference = new InferenceClient();
  private readonly imageSource = new ImageSource(); private readonly meili = new MeiliClient(); private readonly db: Database.Database;
  constructor() { const path = resolve(config.STATE_DATABASE_PATH); mkdirSync(dirname(path), { recursive: true }); this.db = new Database(path); this.db.pragma("journal_mode = WAL"); }
  async close() { await this.catalog.close(); this.db.close(); }
  async run(job: Job<{ runId: string; mode: "full" | "incremental" }>) {
    const { runId, mode } = job.data; this.update(runId, { status: "running", started_at: new Date().toISOString() });
    try { if (mode === "full") await this.full(job); else await this.incremental(job); this.update(runId, { status: "completed", finished_at: new Date().toISOString() }); }
    catch (error) { const cancelled = this.cancelling(runId); this.update(runId, { status: cancelled ? "cancelled" : "failed", finished_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }); if (!cancelled) throw error; }
  }
  private async full(job: Job<{ runId: string }>) {
    const runId = job.data.runId; const rebuildStartedAt = new Date().toISOString(); const total = await this.catalog.count(); const shadow = `${config.MEILI_INDEX_UID}_build_${runId.replaceAll("-", "")}`;
    this.update(runId, { total_products: total }); await this.meili.deleteIndex(shadow); await this.meili.create(shadow); await this.meili.configure(shadow);
    let after: string | null = null, processed = 0, embedded = 0, failed = 0, referenced = 0;
    for (;;) {
      this.assertActive(runId); const products = await this.catalog.batch(after, 20); if (!products.length) break;
      const result = await this.prepare(runId, products); referenced += result.referenced; embedded += result.embedded; failed += result.failed;
      await this.meili.add(shadow, result.documents); processed += products.length; after = products.at(-1)!.id;
      this.update(runId, { processed_products: processed, embedded_images: embedded, failed_images: failed }); await job.updateProgress(Math.round((processed / total) * 100));
    }
    if (processed !== total) throw new Error(`Expected ${total} products but indexed ${processed}`);
    if (referenced > 0 && embedded / referenced < 0.95) throw new Error(`Image success rate ${(embedded / referenced * 100).toFixed(2)}% is below 95%`);
    if (await this.meili.count(shadow) !== total) throw new Error("Shadow index document count did not match source");
    await this.meili.smoke(shadow);
    if (!(await this.meili.exists(config.MEILI_INDEX_UID))) await this.meili.create(config.MEILI_INDEX_UID);
    await this.meili.swap(config.MEILI_INDEX_UID, shadow); await this.meili.smoke(config.MEILI_INDEX_UID); await this.meili.deleteIndex(shadow);
    this.setWatermark("products", rebuildStartedAt, ""); this.setWatermark("files", rebuildStartedAt, "");
  }
  private async incremental(job: Job<{ runId: string }>) {
    const runId = job.data.runId; if (!(await this.meili.exists(config.MEILI_INDEX_UID))) throw new Error("Run a full index before incremental indexing");
    const productWatermark = this.watermark("products"), fileWatermark = this.watermark("files");
    const changes = await this.catalog.changedProductIds(productWatermark, fileWatermark); this.update(runId, { total_products: changes.ids.length });
    let processed = 0, embedded = 0, failed = 0;
    for (let offset = 0; offset < changes.ids.length; offset += 20) {
      this.assertActive(runId); const ids = changes.ids.slice(offset, offset + 20); const products = await this.catalog.byIds(ids);
      const active = new Set(products.map((product) => product.id)); await this.meili.deleteDocuments(config.MEILI_INDEX_UID, ids.filter((id) => !active.has(id)));
      if (products.length) { const result = await this.prepare(runId, products); embedded += result.embedded; failed += result.failed; await this.meili.add(config.MEILI_INDEX_UID, result.documents); }
      processed += ids.length; this.update(runId, { processed_products: processed, embedded_images: embedded, failed_images: failed }); await job.updateProgress(changes.ids.length ? Math.round(processed / changes.ids.length * 100) : 100);
    }
    this.setWatermark("products", changes.productMax, ""); this.setWatermark("files", changes.fileMax, "");
  }
  private async prepare(runId: string, products: ProductDocument[]) {
    const textVectors = await this.inference.text(products.map(buildEmbeddingText)); const documents: unknown[] = [];
    let referenced = 0, embedded = 0, failed = 0;
    for (let index = 0; index < products.length; index++) {
      const product = products[index]!; const imageVectors: number[][] = []; referenced += product.images.length;
      for (let offset = 0; offset < product.images.length; offset += 8) {
        const assets = product.images.slice(offset, offset + 8); const settled = await Promise.allSettled(assets.map((asset) => this.imageSource.get(asset.url)));
        const buffers: Buffer[] = []; const successfulAssets: typeof assets = [];
        settled.forEach((entry, position) => { if (entry.status === "fulfilled") { buffers.push(entry.value); successfulAssets.push(assets[position]!); }
          else { failed++; this.failure(runId, product.id, assets[position]!.id, "s3_download", String(entry.reason)); } });
        if (buffers.length) { try { const vectors = await this.inference.images(buffers); imageVectors.push(...vectors); embedded += vectors.length; }
          catch (error) { failed += successfulAssets.length; successfulAssets.forEach((asset) => this.failure(runId, product.id, asset.id, "embedding", String(error))); } }
      }
      documents.push({ ...product, _vectors: { siglip_text: textVectors[index], siglip_image: imageVectors } });
    }
    return { documents, referenced, embedded, failed };
  }
  private assertActive(runId: string) { if (this.cancelling(runId)) throw new Error("Index run cancelled"); }
  private cancelling(runId: string): boolean { return (this.db.prepare("SELECT status FROM index_runs WHERE id=?").get(runId) as { status?: string } | undefined)?.status === "cancelling"; }
  private update(runId: string, values: Record<string, unknown>) { const entries = Object.entries(values); this.db.prepare(`UPDATE index_runs SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`).run(...entries.map(([, value]) => value), runId); }
  private failure(runId: string, productId: string, imageId: string, code: string, message: string) { this.db.prepare("INSERT INTO index_failures(run_id,product_id,image_id,code,message,retryable) VALUES(?,?,?,?,?,1)").run(runId, productId, imageId, code, message.slice(0, 1000)); }
  private watermark(stream: string): string { return (this.db.prepare("SELECT updated_at FROM sync_watermarks WHERE stream=?").get(stream) as { updated_at?: string } | undefined)?.updated_at ?? "1970-01-01T00:00:00.000Z"; }
  private setWatermark(stream: string, updatedAt: string, id: string) { this.db.prepare(`INSERT INTO sync_watermarks(stream,updated_at,entity_id,updated_on) VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(stream) DO UPDATE SET updated_at=excluded.updated_at,entity_id=excluded.entity_id,updated_on=CURRENT_TIMESTAMP`).run(stream, updatedAt, id); }
}
