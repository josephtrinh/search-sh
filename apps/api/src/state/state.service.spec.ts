import { defaultRankingConfig } from "@samplehub/contracts";
import Database from "better-sqlite3";
import { StateService } from "./state.service";

describe("StateService", () => {
  let service: StateService;
  beforeAll(() => {
    process.env.STATE_DATABASE_PATH = `/tmp/samplehub-search-state-${process.pid}.sqlite`;
    const legacy = new Database(process.env.STATE_DATABASE_PATH);
    legacy.exec(`CREATE TABLE IF NOT EXISTS index_runs (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('full','incremental')), status TEXT NOT NULL,
      processed_products INTEGER NOT NULL DEFAULT 0, total_products INTEGER NOT NULL DEFAULT 0,
      embedded_images INTEGER NOT NULL DEFAULT 0, failed_images INTEGER NOT NULL DEFAULT 0,
      started_at TEXT, finished_at TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ); INSERT OR IGNORE INTO index_runs(id,mode,status) VALUES('legacy-run','full','completed')`);
    legacy.close();
    service = new StateService(); service.onModuleInit();
  });
  afterAll(() => service.onModuleDestroy());
  it("initializes balanced ranking defaults", () => { expect(service.getRanking()).toEqual(defaultRankingConfig); });
  it("persists index runs and cancellation", () => {
    const run = service.createIndexRun("full"); expect(run.status).toBe("queued");
    expect(run.captionedImages).toBe(0); expect(run.cachedCaptions).toBe(0); expect(run.failedCaptions).toBe(0);
    expect(run.siglipEmbeddedImages).toBe(0); expect(run.dinov2EmbeddedImages).toBe(0);
    expect(service.requestCancellation(run.id)?.status).toBe("cancelling");
  });
  it("migrates legacy runs and accepts visual backfills", () => {
    expect(service.getIndexRun("legacy-run")?.status).toBe("completed");
    expect(service.createIndexRun("visual_backfill", "test-fingerprint").mode).toBe("visual_backfill");
  });
  it("keeps SigLIP active until the current DINOv2 fingerprint is ready", () => {
    expect(service.getVisualModelStatus()).toMatchObject({ active: "siglip2", dinov2Ready: false });
    expect(service.setVisualModel("dinov2").active).toBe("siglip2");
  });
  it("creates the content-addressed caption cache", () => {
    const table = service.raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='image_caption_cache'").get();
    expect(table).toBeTruthy();
  });
});
