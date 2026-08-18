import { validate } from "class-validator";
import { StartIndexRunDto } from "./start-index-run.dto";

describe("StartIndexRunDto", () => {
  it("accepts the caption backfill mode", async () => {
    const dto = Object.assign(new StartIndexRunDto(), {
      mode: "caption_backfill",
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it("rejects an unknown run mode", async () => {
    const dto = Object.assign(new StartIndexRunDto(), { mode: "caption_only" });
    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });

  it("accepts a bounded current-generation preview", async () => {
    const dto = Object.assign(new StartIndexRunDto(), { mode: "limited_full", generation: "current", productLimit: 10000 });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it("rejects a preview above the safety limit", async () => {
    const dto = Object.assign(new StartIndexRunDto(), { mode: "limited_full", generation: "legacy", productLimit: 25001 });
    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });
});
