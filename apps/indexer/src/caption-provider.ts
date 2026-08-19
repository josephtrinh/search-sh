import type { CaptionProvider } from "@samplehub/contracts";
import { config } from "./config";

export function captionField(provider: CaptionProvider): "generatedVisualCaption" | "generatedVisualCaptionQwen" {
  return provider === "qwen" ? "generatedVisualCaptionQwen" : "generatedVisualCaption";
}

export function captionEmbedder(provider: CaptionProvider): "e5_text" | "e5_text_qwen" {
  return provider === "qwen" ? "e5_text_qwen" : "e5_text";
}

export function captionModel(provider: CaptionProvider): { modelId: string; revision: string; task: string; batch: number } {
  return provider === "qwen"
    ? { modelId: config.QWEN_CAPTION_MODEL_ID, revision: config.QWEN_CAPTION_MODEL_SHA256, task: config.CAPTION_CACHE_KEYS.qwen, batch: config.MAX_QWEN_CAPTION_BATCH }
    : { modelId: config.CAPTION_MODEL_ID, revision: config.CAPTION_MODEL_REVISION, task: config.CAPTION_CACHE_KEYS.florence, batch: config.MAX_CAPTION_BATCH };
}

export function captionReadyKey(indexUid: string, provider: CaptionProvider): string {
  return `caption_ready:${indexUid}:${provider}`;
}
