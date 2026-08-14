import assert from "node:assert/strict";
import test from "node:test";
import { createGroupId, normalizeGroupPart } from "./index";

test("normalizes grouping like SampleHub", () => {
  assert.equal(normalizeGroupPart("  Calacatta  "), "calacatta");
  assert.equal(createGroupId(" Series ", "Brand"), createGroupId("series", " brand "));
});
