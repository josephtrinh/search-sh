import assert from "node:assert/strict";
import test from "node:test";
import { mergeVisualVector, validVisualVectorSet } from "./visual-vectors";

test("validates visual vectors against the target model dimensions", () => {
  assert.equal(
    validVisualVectorSet(
      [
        [1, 2],
        [3, 4],
      ],
      2,
      2,
    ),
    true,
  );
  assert.equal(validVisualVectorSet([1, 2], 1, 2), true);
  assert.equal(validVisualVectorSet([[1, 2]], 1, 3), false);
  assert.equal(validVisualVectorSet(null, 0, 1280), true);
});

test("merges DINOv3 without replacing existing visual vectors", () => {
  const result = mergeVisualVector(
    { e5_text: [1], siglip_image: [[2]], dinov2_image: [[3]] },
    "dinov3_image",
    [[4, 5]],
  );
  assert.deepEqual(result, {
    e5_text: [1],
    siglip_image: [[2]],
    dinov2_image: [[3]],
    dinov3_image: [[4, 5]],
  });
});
