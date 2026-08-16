import { SearchService } from "./search.service";
import { defaultRankingConfig } from "@samplehub/contracts";

describe("SearchService", () => {
  const service = new SearchService({ getRanking: () => defaultRankingConfig } as never);
  it("rejects malformed cursors", () => { expect(() => (service as any).decodeCursor("bad")).toThrow("Invalid search cursor"); });
  it("round trips a cursor", () => { const cursor = (service as any).encodeCursor(24); expect((service as any).decodeCursor(cursor)).toBe(24); });
  it("sorts numeric item labels before text and blanks", () => {
    const values = ["A", null, "10", "2", "01"].sort((a, b) => (service as any).itemOrder(a, b));
    expect(values).toEqual(["01", "2", "10", "A", null]);
  });
  it("builds the approved text-only auto weights", () => {
    const branches = (service as any).buildBranches("auto", "grey tile", { semantic: [1], visualText: [2] }, undefined, defaultRankingConfig, true);
    expect(branches.map((branch: any) => [branch.source, branch.query.federationOptions.weight])).toEqual([
      ["keyword", .4], ["e5_text", .4], ["siglip_image", .2],
    ]);
  });
  it("builds the approved combined auto weights", () => {
    const branches = (service as any).buildBranches("auto", "grey tile", { semantic: [1], visualText: [2], image: [3] }, undefined, defaultRankingConfig, true);
    expect(branches.map((branch: any) => [branch.source, branch.query.federationOptions.weight])).toEqual([
      ["keyword", .15], ["e5_text", .25], ["siglip_image", .1], ["siglip_image", .5],
    ]);
  });
});
