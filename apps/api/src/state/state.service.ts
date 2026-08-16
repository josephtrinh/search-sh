import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { IndexRunMode, IndexRunSummary, RankingConfig, VisualModel, VisualModelStatus } from "@samplehub/contracts";
import { defaultRankingConfig } from "@samplehub/contracts";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "../common/config";

@Injectable()
export class StateService implements OnModuleInit, OnModuleDestroy {
  private db!: Database.Database;
  onModuleInit(): void {
    const path = resolve(getConfig().STATE_DATABASE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }
  onModuleDestroy(): void { this.db?.close(); }
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS index_runs (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('full','incremental','visual_backfill')), status TEXT NOT NULL,
        processed_products INTEGER NOT NULL DEFAULT 0, total_products INTEGER NOT NULL DEFAULT 0,
        embedded_images INTEGER NOT NULL DEFAULT 0, failed_images INTEGER NOT NULL DEFAULT 0,
        siglip_embedded_images INTEGER NOT NULL DEFAULT 0, siglip_failed_images INTEGER NOT NULL DEFAULT 0,
        dinov2_embedded_images INTEGER NOT NULL DEFAULT 0, dinov2_failed_images INTEGER NOT NULL DEFAULT 0,
        captioned_images INTEGER NOT NULL DEFAULT 0, cached_captions INTEGER NOT NULL DEFAULT 0,
        failed_captions INTEGER NOT NULL DEFAULT 0,
        config_fingerprint TEXT, started_at TEXT, finished_at TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sync_watermarks (stream TEXT PRIMARY KEY, updated_at TEXT NOT NULL, entity_id TEXT NOT NULL, updated_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS index_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, product_id TEXT, image_id TEXT,
        code TEXT NOT NULL, message TEXT NOT NULL, retryable INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS image_caption_cache (
        image_id TEXT NOT NULL, source_sha256 TEXT NOT NULL, model_id TEXT NOT NULL,
        model_revision TEXT NOT NULL, task TEXT NOT NULL, caption TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(image_id,source_sha256,model_id,model_revision,task)
      );
      CREATE TABLE IF NOT EXISTS evaluation_queries (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, query_text TEXT, language TEXT NOT NULL DEFAULT 'en',
        modality TEXT NOT NULL, fixture_path TEXT, filters_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS judgments (
        query_id TEXT NOT NULL, group_id TEXT NOT NULL, grade INTEGER NOT NULL CHECK(grade BETWEEN 0 AND 2),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(query_id, group_id),
        FOREIGN KEY(query_id) REFERENCES evaluation_queries(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        id TEXT PRIMARY KEY, config_json TEXT NOT NULL, report_json TEXT, status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT
      );
    `);
    this.ensureColumn("index_runs", "captioned_images", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("index_runs", "cached_captions", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("index_runs", "failed_captions", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("index_runs", "siglip_embedded_images", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("index_runs", "siglip_failed_images", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("index_runs", "dinov2_embedded_images", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("index_runs", "dinov2_failed_images", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("index_runs", "config_fingerprint", "TEXT");
    this.expandIndexRunModes();
  }
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  private expandIndexRunModes(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='index_runs'").get() as { sql?: string } | undefined;
    if (row?.sql?.includes("visual_backfill")) return;
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE index_runs_next (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('full','incremental','visual_backfill')), status TEXT NOT NULL,
        processed_products INTEGER NOT NULL DEFAULT 0, total_products INTEGER NOT NULL DEFAULT 0,
        embedded_images INTEGER NOT NULL DEFAULT 0, failed_images INTEGER NOT NULL DEFAULT 0,
        siglip_embedded_images INTEGER NOT NULL DEFAULT 0, siglip_failed_images INTEGER NOT NULL DEFAULT 0,
        dinov2_embedded_images INTEGER NOT NULL DEFAULT 0, dinov2_failed_images INTEGER NOT NULL DEFAULT 0,
        captioned_images INTEGER NOT NULL DEFAULT 0, cached_captions INTEGER NOT NULL DEFAULT 0,
        failed_captions INTEGER NOT NULL DEFAULT 0, config_fingerprint TEXT,
        started_at TEXT, finished_at TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      this.db.exec(`INSERT INTO index_runs_next SELECT
        id,mode,status,processed_products,total_products,embedded_images,failed_images,
        siglip_embedded_images,siglip_failed_images,dinov2_embedded_images,dinov2_failed_images,
        captioned_images,cached_captions,failed_captions,config_fingerprint,
        started_at,finished_at,error,created_at FROM index_runs`);
      this.db.exec("DROP TABLE index_runs");
      this.db.exec("ALTER TABLE index_runs_next RENAME TO index_runs");
    })();
  }
  getRanking(): RankingConfig {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get("ranking_v2") as { value_json: string } | undefined;
    return row ? { ...defaultRankingConfig, ...JSON.parse(row.value_json) } : defaultRankingConfig;
  }
  setRanking(value: RankingConfig): RankingConfig {
    this.db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES('ranking_v2',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`).run(JSON.stringify(value));
    return this.getRanking();
  }
  getVisualModelStatus(): VisualModelStatus {
    const activeRow = this.db.prepare("SELECT value_json FROM settings WHERE key='active_visual_model'").get() as { value_json?: string } | undefined;
    const readyRow = this.db.prepare("SELECT value_json FROM settings WHERE key='dinov2_ready_fingerprint'").get() as { value_json?: string } | undefined;
    let configured: VisualModel = "siglip2";
    try {
      const value = activeRow?.value_json ? JSON.parse(activeRow.value_json) : "siglip2";
      if (value === "dinov2") configured = value;
    } catch {}
    let fingerprint: string | null = null;
    try { fingerprint = readyRow?.value_json ? String(JSON.parse(readyRow.value_json)) : null; } catch {}
    const dinov2Ready = fingerprint === getConfig().DINOV2_FINGERPRINT;
    return { active: configured === "dinov2" && dinov2Ready ? "dinov2" : "siglip2", siglip2Ready: true, dinov2Ready, dinov2Fingerprint: fingerprint };
  }
  setVisualModel(model: VisualModel): VisualModelStatus {
    this.db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES('active_visual_model',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`).run(JSON.stringify(model));
    return this.getVisualModelStatus();
  }
  createIndexRun(mode: IndexRunMode, configFingerprint?: string): IndexRunSummary {
    const id = randomUUID();
    this.db.prepare("INSERT INTO index_runs(id,mode,status,config_fingerprint) VALUES(?,?,'queued',?)").run(id, mode, configFingerprint ?? null);
    return this.getIndexRun(id)!;
  }
  getIndexRun(id: string): IndexRunSummary | null {
    const row = this.db.prepare("SELECT * FROM index_runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRun(row) : null;
  }
  listIndexRuns(): IndexRunSummary[] {
    return (this.db.prepare("SELECT * FROM index_runs ORDER BY created_at DESC LIMIT 100").all() as Record<string, unknown>[]).map((row) => this.mapRun(row));
  }
  requestCancellation(id: string): IndexRunSummary | null {
    this.db.prepare("UPDATE index_runs SET status='cancelling' WHERE id=? AND status IN ('queued','running')").run(id);
    return this.getIndexRun(id);
  }
  private mapRun(row: Record<string, unknown>): IndexRunSummary {
    return { id: String(row.id), mode: row.mode as IndexRunMode, status: row.status as IndexRunSummary["status"],
      processedProducts: Number(row.processed_products), totalProducts: Number(row.total_products),
      embeddedImages: Number(row.embedded_images), failedImages: Number(row.failed_images),
      siglipEmbeddedImages: Number(row.siglip_embedded_images), siglipFailedImages: Number(row.siglip_failed_images),
      dinov2EmbeddedImages: Number(row.dinov2_embedded_images), dinov2FailedImages: Number(row.dinov2_failed_images),
      captionedImages: Number(row.captioned_images), cachedCaptions: Number(row.cached_captions), failedCaptions: Number(row.failed_captions),
      startedAt: row.started_at ? String(row.started_at) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null, error: row.error ? String(row.error) : null };
  }
  raw(): Database.Database { return this.db; }
}
