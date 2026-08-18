import { SearchService } from "./search.service";
import { defaultRankingConfig } from "@samplehub/contracts";

describe("SearchService", () => {
  const service = new SearchService({ getRanking: () => defaultRankingConfig } as never);
  it("rejects malformed cursors", () => { expect(() => (service as any).decodeCursor("bad", "siglip2", "legacy", "products")).toThrow("Invalid search cursor"); });
  it("rejects legacy cursors that do not identify their visual model", () => { const cursor = Buffer.from(JSON.stringify({ v: 1, offset: 24 }), "utf8").toString("base64url"); expect(() => (service as any).decodeCursor(cursor, "siglip2", "legacy", "products")).toThrow("Invalid search cursor"); });
  it("round trips a cursor", () => { const cursor = (service as any).encodeCursor(24, "dinov2", "current", "products_preview_current"); expect((service as any).decodeCursor(cursor, "dinov2", "current", "products_preview_current")).toBe(24); });
  it("rejects a cursor after the global visual model changes", () => { const cursor = (service as any).encodeCursor(24, "siglip2", "legacy", "products"); expect(() => (service as any).decodeCursor(cursor, "dinov2", "legacy", "products")).toThrow("active visual model or index scope changed"); });
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
  it("uses DINOv2 for image search and omits SigLIP visual text", () => {
    const branches = (service as any).buildBranches("auto", "grey tile", { semantic: [1], image: [3] }, undefined, defaultRankingConfig, true, "dinov2");
    expect(branches.map((branch: any) => [branch.source, branch.query.hybrid?.embedder])).toEqual([
      ["keyword", undefined], ["semantic", "e5_text"], ["image", "dinov2_image"],
    ]);
  });
  it("uses DINOv3 for image search and omits SigLIP visual text", () => {
    const branches = (service as any).buildBranches("auto", "grey tile", { semantic: [1], image: [3] }, undefined, defaultRankingConfig, true, "dinov3");
    expect(branches.map((branch: any) => [branch.source, branch.query.hybrid?.embedder])).toEqual([
      ["keyword", undefined], ["semantic", "e5_text"], ["image", "dinov3_image"],
    ]);
  });
  it("uses generation-specific embedder names for current indexes", () => {
    const branches = (service as any).buildBranches("image_visual", "", { image: [3] }, undefined, defaultRankingConfig, true, "dinov2", "current", "products_preview_current");
    expect(branches[0].query).toMatchObject({ indexUid: "products_preview_current", hybrid: { embedder: "dinov2_image_v2" } });
  });
  it("keeps a selectable legacy DINO model active even when its old fingerprint differs", async () => {
    let configured = "siglip2";
    const legacyState = {
      getIndexScope: () => "stable",
      getConfiguredVisualModel: () => configured,
      getVisualModelStatus: () => ({
        active: "siglip2", generation: "legacy", scope: "stable", siglip2Ready: true,
        dinov2Ready: false, dinov2Fingerprint: "old", dinov3Ready: false, dinov3Fingerprint: null,
      }),
      setVisualModel: (model: string) => { configured = model; },
    };
    const legacyService = new SearchService(legacyState as never);
    jest.spyOn(legacyService as any, "indexSchema").mockResolvedValue({
      v2: true, generation: "legacy", siglip2: true, dinov2: true, dinov3: false,
    });
    await expect(legacyService.setVisualModel("dinov2")).resolves.toMatchObject({ active: "dinov2", dinov2Ready: true });
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
