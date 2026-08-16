import assert from "node:assert/strict";
import test from "node:test";
import { buildEmbeddingText, createGroupId, normalizeGroupPart } from "./index";
import type { ProductDocument } from "@samplehub/contracts";

test("normalizes grouping like SampleHub", () => {
  assert.equal(normalizeGroupPart("  Calacatta  "), "calacatta");
  assert.equal(createGroupId(" Series ", "Brand"), createGroupId("series", " brand "));
});

test("places the generated visual caption in the E5 passage without changing source copy", () => {
  const product = {
    id: "1", groupId: "group", brand: "Brand", normalizedBrand: "brand", series: "Series", normalizedSeries: "series",
    name: null, sku: null, model: "M1", item: null, category: null, categoryZh: null, material: "Porcelain Tile", color: "Grey",
    origin: "Italy", effect: "Marble", surface: "Honed", edge: null, sizeGroup: null, waterAbsorption: null, fireResistance: null,
    description: "Source description", detail: null, remarks: null, price: null, availability: null, width: null, height: null,
    length: null, depth: null, area: null, updatedAt: new Date(0).toISOString(), thumbnailId: null, images: [], attributes: {},
  } satisfies ProductDocument;
  const passage = buildEmbeddingText(product, "Soft grey veining on a pale surface.");
  assert.match(passage, /Visual description: Soft grey veining/);
  assert.match(passage, /Description: Source description/);
  assert.ok(passage.indexOf("Visual description") < passage.indexOf("Description: Source"));
});
