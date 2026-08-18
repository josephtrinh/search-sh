import type { VisualGeneration, VisualModel } from "@samplehub/contracts";
import { config } from "./config";

export type VisualEmbedderName =
  | "siglip_image"
  | "dinov2_image"
  | "dinov3_image"
  | "siglip_image_v2"
  | "dinov2_image_v2"
  | "dinov3_image_v2";

export interface VisualEmbeddingState {
  generation: VisualGeneration;
  fingerprints: Partial<Record<VisualModel, string>>;
  vectorCounts: Partial<Record<VisualModel, number>>;
}

const LEGACY_FINGERPRINTS: Record<VisualModel, string> = {
  siglip2: [
    "google/siglip2-base-patch16-224",
    "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2",
    768,
    "legacy-square-v1",
    config.IMAGE_EMBEDDING_MODE,
    config.IMAGE_NORMALIZATION_FINGERPRINT,
  ].join(":"),
  dinov2: [
    config.DINOV2_MODEL_ID,
    config.DINOV2_MODEL_REVISION,
    config.DINOV2_DIMENSIONS,
    224,
    "pooler_output",
    "legacy-square-v1",
    config.IMAGE_EMBEDDING_MODE,
    config.IMAGE_NORMALIZATION_FINGERPRINT,
  ].join(":"),
  dinov3: [
    config.DINOV3_MODEL_ID,
    config.DINOV3_ARCHIVE_SHA256,
    config.DINOV3_DIMENSIONS,
    224,
    "pooler_output",
    "legacy-square-v1",
    config.IMAGE_EMBEDDING_MODE,
    config.IMAGE_NORMALIZATION_FINGERPRINT,
  ].join(":"),
};

const CURRENT_FINGERPRINTS: Record<VisualModel, string> = {
  siglip2: config.SIGLIP_FINGERPRINT,
  dinov2: config.DINOV2_FINGERPRINT,
  dinov3: config.DINOV3_FINGERPRINT,
};

export function visualEmbedder(model: VisualModel, generation: VisualGeneration): VisualEmbedderName {
  const base = model === "siglip2" ? "siglip_image" : `${model}_image`;
  return `${base}${generation === "current" ? "_v2" : ""}` as VisualEmbedderName;
}

export function visualFingerprint(model: VisualModel, generation: VisualGeneration): string {
  return (generation === "current" ? CURRENT_FINGERPRINTS : LEGACY_FINGERPRINTS)[model];
}

export function generationFromEmbedders(embedders: Record<string, unknown>): VisualGeneration {
  return embedders.siglip_image_v2 ? "current" : "legacy";
}

export function previewIndexUid(generation: VisualGeneration): string {
  return `${config.MEILI_INDEX_UID}_preview_${generation}`;
}
