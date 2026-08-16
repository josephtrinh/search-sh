import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { IndexRunMode, IndexRunSummary, RankingConfig } from "@samplehub/contracts";
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
        id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('full','incremental')), status TEXT NOT NULL,
        processed_products INTEGER NOT NULL DEFAULT 0, total_products INTEGER NOT NULL DEFAULT 0,
        embedded_images INTEGER NOT NULL DEFAULT 0, failed_images INTEGER NOT NULL DEFAULT 0,
        captioned_images INTEGER NOT NULL DEFAULT 0, cached_captions INTEGER NOT NULL DEFAULT 0,
        failed_captions INTEGER NOT NULL DEFAULT 0,
        started_at TEXT, finished_at TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  }
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
  createIndexRun(mode: IndexRunMode): IndexRunSummary {
    const id = randomUUID();
    this.db.prepare("INSERT INTO index_runs(id,mode,status) VALUES(?,?,'queued')").run(id, mode);
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
      captionedImages: Number(row.captioned_images), cachedCaptions: Number(row.cached_captions), failedCaptions: Number(row.failed_captions),
      startedAt: row.started_at ? String(row.started_at) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null, error: row.error ? String(row.error) : null };
  }
  raw(): Database.Database { return this.db; }
}
