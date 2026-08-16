import { interpretQuery } from "./query-interpreter";

describe("interpretQuery", () => {
  it("canonicalizes English aliases into source filters", () => {
    const result = interpretQuery("Italian grey wood effect porcelain tile");
    expect(result.lexicalQuery).toBe("Italy Grey Wood Porcelain Tile");
    expect(result.derivedFilters).toEqual({
      origin: ["Italy"], color: ["Grey"], effect: ["Wood"], material: ["Porcelain Tile"],
    });
  });
  it("supports Traditional and Simplified Chinese aliases", () => {
    expect(interpretQuery("灰色防滑瓷磚").derivedFilters).toEqual({
      color: ["Grey"], material: ["Porcelain Tile"], surface: ["Grip R11", "Grip R12"],
    });
    expect(interpretQuery("中国木纹瓷砖").derivedFilters).toEqual({
      origin: ["China"], effect: ["Wood"], material: ["Porcelain Tile"],
    });
  });
  it("does not derive a clearly negated alias", () => {
    const result = interpretQuery("grey tile without marble");
    expect(result.derivedFilters.color).toEqual(["Grey"]);
    expect(result.derivedFilters.effect).toBeUndefined();
  });
});
