import assert from "node:assert/strict";
import test from "node:test";
import { captionCacheKey } from "./caption-cache";

test("caption cache identity changes with task and generation settings", () => {
  const detailed = captionCacheKey("<DETAILED_CAPTION>", 128, 3);
  assert.notEqual(detailed, captionCacheKey("<MORE_DETAILED_CAPTION>", 128, 3));
  assert.notEqual(detailed, captionCacheKey("<DETAILED_CAPTION>", 200, 3));
  assert.notEqual(detailed, captionCacheKey("<DETAILED_CAPTION>", 128, 5));
});
