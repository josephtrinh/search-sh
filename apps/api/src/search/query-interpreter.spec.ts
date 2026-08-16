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
  it("uses the live vocabulary for colors and ORs material/effect families", () => {
    const result = interpretQuery("red stones for a modern room", {
      color: ["Red", "Blue"],
      material: ["Sintered Stone", "Flexistone", "Porcelain Tile"],
      effect: ["Stone", "Wood"],
      surface: [], origin: [],
    });
    expect(result.derivedFilterGroups).toEqual([
      { canonical: "Red", fields: { color: ["Red"] } },
      { canonical: "Stone", fields: { material: ["Sintered Stone", "Flexistone"], effect: ["Stone"] } },
    ]);
  });
  it("prefers a longer exact catalog value over an overlapping broad family", () => {
    const result = interpretQuery("sintered stone", {
      material: ["Sintered Stone", "Flexistone"], effect: ["Stone"],
    });
    expect(result.derivedFilterGroups).toEqual([
      { canonical: "Sintered Stone", fields: { material: ["Sintered Stone"] } },
    ]);
  });
  it("uses the first color as the structured base color while retaining secondary visual colors in text", () => {
    const result = interpretQuery("dark blue marble with white veins", {
      color: ["Blue", "White"], material: ["Sintered Stone"], effect: ["Marble"],
    });
    expect(result.derivedFilters.color).toEqual(["Blue"]);
    expect(result.lexicalQuery).toContain("White veins");
  });
  it("supports an explicit OR between values of the same facet", () => {
    const result = interpretQuery("red or blue tile", { color: ["Red", "Blue"] });
    expect(result.derivedFilters.color).toEqual(["Red", "Blue"]);
  });
});
