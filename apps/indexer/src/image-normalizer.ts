import sharp from "sharp";
import { config } from "./config";

export interface CatalogImageLimits {
  normalizeThresholdPixels: number;
  maxSourcePixels: number;
  maxSourceBytes: number;
  maxEdge: number;
  maxOutputBytes: number;
}

export interface NormalizedCatalogImage {
  buffer: Buffer;
  normalized: boolean;
  originalBytes: number;
  originalPixels: number;
  outputBytes: number;
}

export class CatalogImageError extends Error {
  constructor(readonly code: "catalog_image_source_too_large" | "catalog_image_normalization", message: string) {
    super(message);
    this.name = "CatalogImageError";
  }
}

export const catalogImageLimits: CatalogImageLimits = {
  normalizeThresholdPixels: config.CATALOG_IMAGE_NORMALIZE_THRESHOLD_PIXELS,
  maxSourcePixels: config.CATALOG_IMAGE_MAX_SOURCE_PIXELS,
  maxSourceBytes: config.CATALOG_IMAGE_MAX_SOURCE_BYTES,
  maxEdge: config.CATALOG_IMAGE_MAX_EDGE,
  maxOutputBytes: config.CATALOG_IMAGE_MAX_OUTPUT_BYTES,
};

async function encode(input: Buffer, maxEdge: number, quality: number, maxSourcePixels: number): Promise<Buffer> {
  return sharp(input, { limitInputPixels: maxSourcePixels, sequentialRead: true, failOn: "error" })
    .autoOrient()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
}

export async function normalizeCatalogImage(input: Buffer, limits: CatalogImageLimits = catalogImageLimits): Promise<NormalizedCatalogImage> {
  if (input.length > limits.maxSourceBytes) {
    throw new CatalogImageError("catalog_image_source_too_large", `Compressed source is ${input.length} bytes; maximum is ${limits.maxSourceBytes}`);
  }
  try {
    const metadata = await sharp(input, { limitInputPixels: limits.maxSourcePixels, sequentialRead: true, failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) {
      throw new CatalogImageError("catalog_image_normalization", "Source must be a decodable JPEG, PNG, or WebP image");
    }
    const pixels = metadata.width * metadata.height;
    if (pixels > limits.maxSourcePixels) {
      throw new CatalogImageError("catalog_image_source_too_large", `Decoded source is ${pixels} pixels; maximum is ${limits.maxSourcePixels}`);
    }
    if (pixels <= limits.normalizeThresholdPixels && input.length <= limits.maxOutputBytes) {
      return { buffer: input, normalized: false, originalBytes: input.length, originalPixels: pixels, outputBytes: input.length };
    }
    const attempts: Array<[number, number]> = [[limits.maxEdge, 92], [limits.maxEdge, 85], [limits.maxEdge, 75], [Math.min(limits.maxEdge, 3072), 75], [Math.min(limits.maxEdge, 2048), 75]];
    for (const [edge, quality] of attempts) {
      const output = await encode(input, edge, quality, limits.maxSourcePixels);
      if (output.length <= limits.maxOutputBytes) {
        return { buffer: output, normalized: true, originalBytes: input.length, originalPixels: pixels, outputBytes: output.length };
      }
    }
    throw new CatalogImageError("catalog_image_normalization", `Normalized output could not be reduced below ${limits.maxOutputBytes} bytes`);
  } catch (error) {
    if (error instanceof CatalogImageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/pixel limit|Input image exceeds pixel limit/i.test(message)) {
      throw new CatalogImageError("catalog_image_source_too_large", message);
    }
    throw new CatalogImageError("catalog_image_normalization", message);
  }
}
