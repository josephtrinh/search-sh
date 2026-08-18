import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { CatalogImageError, normalizeCatalogImage, type CatalogImageLimits } from "./image-normalizer";

const limits: CatalogImageLimits = {
  normalizeThresholdPixels: 100,
  maxSourcePixels: 1_000,
  maxSourceBytes: 100_000,
  maxEdge: 16,
  maxOutputBytes: 20_000,
};

test("leaves ordinary supported images unchanged", async () => {
  const input = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  const result = await normalizeCatalogImage(input, limits);
  assert.equal(result.normalized, false);
  assert.equal(result.buffer, input);
});

test("normalizes oversized decoded images within the output envelope", async () => {
  const input = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } }).png().toBuffer();
  const result = await normalizeCatalogImage(input, limits);
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(result.normalized, true);
  assert.equal(metadata.format, "jpeg");
  assert.ok(Math.max(metadata.width!, metadata.height!) <= limits.maxEdge);
  assert.ok(result.outputBytes <= limits.maxOutputBytes);
});

test("rejects sources above the hard compressed-size limit", async () => {
  const input = Buffer.alloc(101);
  await assert.rejects(
    normalizeCatalogImage(input, { ...limits, maxSourceBytes: 100 }),
    (error: unknown) => error instanceof CatalogImageError && error.code === "catalog_image_source_too_large",
  );
});

test("rejects sources above the hard decoded-pixel limit", async () => {
  const input = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(
    normalizeCatalogImage(input, { ...limits, maxSourcePixels: 300 }),
    (error: unknown) => error instanceof CatalogImageError && error.code === "catalog_image_source_too_large",
  );
});
