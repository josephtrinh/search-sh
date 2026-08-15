import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImageAsset } from "@samplehub/contracts";
import { selectEmbeddingImages } from "./image-selection";

const images: ImageAsset[] = [
  { id: "first", url: "https://example.test/first.jpg", thumbnailUrl: "https://example.test/first-small.jpg", mime: "image/jpeg" },
  { id: "chosen", url: "https://example.test/chosen.jpg", thumbnailUrl: "https://example.test/chosen-small.jpg", mime: "image/jpeg" },
  { id: "last", url: "https://example.test/last.jpg", thumbnailUrl: null, mime: "image/jpeg" },
];

describe("selectEmbeddingImages", () => {
  it("selects the original asset designated by thumbnailId", () => {
    assert.deepEqual(selectEmbeddingImages({ images, thumbnailId: "chosen" }, "thumbnail"), [images[1]]);
  });

  it("falls back to the first ordered original asset when thumbnailId is absent", () => {
    assert.deepEqual(selectEmbeddingImages({ images, thumbnailId: null }, "thumbnail"), [images[0]]);
  });

  it("falls back to the first ordered original asset when thumbnailId is stale", () => {
    assert.deepEqual(selectEmbeddingImages({ images, thumbnailId: "missing" }, "thumbnail"), [images[0]]);
  });

  it("keeps every ordered asset in all mode", () => {
    assert.deepEqual(selectEmbeddingImages({ images, thumbnailId: "chosen" }, "all"), images);
  });

  it("returns no asset when the product has no images", () => {
    assert.deepEqual(selectEmbeddingImages({ images: [], thumbnailId: null }, "thumbnail"), []);
  });
});
