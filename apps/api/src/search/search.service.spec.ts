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
    expect(branches.map((branch: any) => [branch.source, branch.weight])).toEqual([
      ["keyword", .4], ["semantic", .4], ["visual_text", .2],
    ]);
  });
  it("builds the approved combined auto weights", () => {
    const branches = (service as any).buildBranches("auto", "grey tile", { semantic: [1], visualText: [2], image: [3] }, undefined, defaultRankingConfig, true);
    expect(branches.map((branch: any) => [branch.source, branch.weight])).toEqual([
      ["keyword", .15], ["semantic", .25], ["visual_text", .1], ["image", .5],
    ]);
  });
  it("combines derived attribute families with OR and independent concepts with AND", () => {
    const expression = (service as any).derivedFilterExpression({}, [
      { canonical: "Red", fields: { color: ["Red"] } },
      { canonical: "Stone", fields: { material: ["Sintered Stone", "Flexistone"], effect: ["Stone"] } },
    ]);
    expect(expression).toBe('color IN ["Red"] AND (material IN ["Sintered Stone","Flexistone"] OR effect IN ["Stone"])');
  });
  it("lets explicit filters override the same derived field", () => {
    const expression = (service as any).derivedFilterExpression({ color: ["Blue"] }, [
      { canonical: "Red", fields: { color: ["Red"] } },
    ]);
    expect(expression).toBeUndefined();
  });
});
