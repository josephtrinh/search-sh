import { defaultRankingConfig } from "@samplehub/contracts";
import { StateService } from "./state.service";

describe("StateService", () => {
  let service: StateService;
  beforeAll(() => { process.env.STATE_DATABASE_PATH = `/tmp/samplehub-search-state-${process.pid}.sqlite`; service = new StateService(); service.onModuleInit(); });
  afterAll(() => service.onModuleDestroy());
  it("initializes balanced ranking defaults", () => { expect(service.getRanking()).toEqual(defaultRankingConfig); });
  it("persists index runs and cancellation", () => {
    const run = service.createIndexRun("full"); expect(run.status).toBe("queued");
    expect(run.captionedImages).toBe(0); expect(run.cachedCaptions).toBe(0); expect(run.failedCaptions).toBe(0);
    expect(service.requestCancellation(run.id)?.status).toBe("cancelling");
  });
  it("creates the content-addressed caption cache", () => {
    const table = service.raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='image_caption_cache'").get();
    expect(table).toBeTruthy();
  });
});
