import { defaultRankingConfig } from "@samplehub/contracts";
import { StateService } from "./state.service";

describe("StateService", () => {
  let service: StateService;
  beforeAll(() => { process.env.STATE_DATABASE_PATH = `/tmp/samplehub-search-state-${process.pid}.sqlite`; service = new StateService(); service.onModuleInit(); });
  afterAll(() => service.onModuleDestroy());
  it("initializes balanced ranking defaults", () => { expect(service.getRanking()).toEqual(defaultRankingConfig); });
  it("persists index runs and cancellation", () => {
    const run = service.createIndexRun("full"); expect(run.status).toBe("queued");
    expect(service.requestCancellation(run.id)?.status).toBe("cancelling");
  });
});
