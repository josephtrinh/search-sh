import { SearchService } from "./search.service";

describe("SearchService", () => {
  const service = new SearchService({ getRanking: () => ({ semanticRatio: .5, textHybridWeight: .5, textVisualWeight: .5, combinedTextWeight: .5, combinedImageWeight: .5 }) } as never);
  it("rejects malformed cursors", () => { expect(() => (service as any).decodeCursor("bad")).toThrow("Invalid search cursor"); });
  it("round trips a cursor", () => { const cursor = (service as any).encodeCursor(24); expect((service as any).decodeCursor(cursor)).toBe(24); });
  it("sorts numeric item labels before text and blanks", () => {
    const values = ["A", null, "10", "2", "01"].sort((a, b) => (service as any).itemOrder(a, b));
    expect(values).toEqual(["01", "2", "10", "A", null]);
  });
});
