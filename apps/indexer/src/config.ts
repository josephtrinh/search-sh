import { z } from "zod";
import { config as loadEnv } from "dotenv";
import { isAbsolute, resolve } from "node:path";
import { captionCacheKey, qwenCaptionCacheKey } from "./caption-cache";

const WORKSPACE_ROOT = resolve(__dirname, "../../..");
loadEnv({ path: resolve(WORKSPACE_ROOT, ".env"), quiet: true });
const optional = z.string().optional().transform((value) => value || undefined);
const Schema = z.object({
  DATABASE_HOST: z.string(), DATABASE_PORT: z.coerce.number().int(), DATABASE_USERNAME: z.string(), DATABASE_PASSWORD: z.string(), DATABASE_NAME: z.string(),
  REDIS_HOST: z.string().default("127.0.0.1"), REDIS_PORT: z.coerce.number().default(6379), REDIS_DB: z.coerce.number().default(0), REDIS_USERNAME: optional, REDIS_PASSWORD: optional,
  MEILI_URL: z.string().url().default("http://127.0.0.1:7700"), MEILI_MASTER_KEY: z.string().min(16).default("local-development-master-key"), MEILI_INDEX_UID: z.string().default("products"),
  INFERENCE_URL: z.string().url().default("http://127.0.0.1:8100"), STATE_DATABASE_PATH: z.string().default("./data/search-state.sqlite"),
  AWS_ACCESS_KEY_ID: z.string(), AWS_SECRET_ACCESS_KEY: z.string(), AWS_REGION: z.string(), AWS_BUCKET_NAME: z.string(), AWS_BUCKET_URL: z.string().url(),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().default(768), EMBEDDING_MODEL_ID: z.string().default("google/siglip2-base-patch16-naflex"), EMBEDDING_MODEL_REVISION: z.string().default("b53b807d3a2d5e2b3911292f2d69e5341cdc064c"), SIGLIP_MAX_NUM_PATCHES: z.coerce.number().int().min(64).max(1024).default(576),
  DINOV2_DIMENSIONS: z.coerce.number().int().default(768), DINOV2_MODEL_ID: z.string().default("facebook/dinov2-base"), DINOV2_MODEL_REVISION: z.string().default("f9e44c814b77203eaa57a6bdbbd535f21ede1415"), DINOV2_IMAGE_SIZE: z.coerce.number().int().min(224).max(518).refine((value) => value % 14 === 0).default(392), DINOV2_POOLING: z.enum(["cls", "patch_mean", "cls_patch_mean"]).default("cls_patch_mean"),
  DINOV3_DIMENSIONS: z.coerce.number().int().default(768), DINOV3_MODEL_ID: z.string().default("facebook/dinov3-vitb16-pretrain-lvd1689m"),
  DINOV3_ARCHIVE_SHA256: z.string().regex(/^[a-f0-9]{64}$/i).default("037a1f688847bedfe533bc1c44b336160d56306c91ad008498c93659dbe85fe0"),
  DINOV3_IMAGE_SIZE: z.coerce.number().int().min(224).max(512).refine((value) => value % 16 === 0, "DINOV3_IMAGE_SIZE must be a multiple of 16").default(384), DINOV3_POOLING: z.enum(["cls", "patch_mean", "cls_patch_mean"]).default("cls_patch_mean"),
  TEXT_EMBEDDING_DIMENSIONS: z.coerce.number().int().default(768), TEXT_EMBEDDING_MODEL_ID: z.string().default("intfloat/multilingual-e5-base"), TEXT_EMBEDDING_MODEL_REVISION: z.string().default("d128750597153bb5987e10b1c3493a34e5a4502a"),
  CAPTION_MODEL_ID: z.string().default("microsoft/Florence-2-base-ft"), CAPTION_MODEL_REVISION: z.string().default("f6c1a25888ffc1d945ee8a1a77ac833c7303d46e"), CAPTION_TASK: z.string().default("<DETAILED_CAPTION>"), CAPTION_MAX_NEW_TOKENS: z.coerce.number().int().positive().default(128), CAPTION_NUM_BEAMS: z.coerce.number().int().positive().default(3), MAX_CAPTION_BATCH: z.coerce.number().int().min(1).max(8).default(2),
  CAPTION_INDEX_PROVIDER: z.enum(["florence", "qwen"]).default("florence"),
  QWEN_CAPTION_MODEL_ID: z.string().default("unsloth/Qwen3.5-0.8B-GGUF:Q4_K_S"),
  QWEN_CAPTION_MODEL_SHA256: z.string().regex(/^[a-f0-9]{64}$/i).default("5f7ccfa6e9df0d9ebbaff9ee095b18202bec1e0ac313ca688d2c57c9c80a6bc9"),
  QWEN_CAPTION_MMPROJ_SHA256: z.string().regex(/^[a-f0-9]{64}$/i).default("56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453"),
  QWEN_CAPTION_PROMPT_VERSION: z.string().min(1).default("qwen-material-caption-v1"),
  QWEN_CAPTION_PROMPT_SHA256: z.string().regex(/^[a-f0-9]{64}$/i).default("ca52f42df1545616283043810a8fa57f4cca7dabca957ec730ad63c68edb76db"),
  QWEN_CAPTION_MAX_TOKENS: z.coerce.number().int().positive().default(160),
  QWEN_CAPTION_SEED: z.coerce.number().int().default(42),
  MAX_QWEN_CAPTION_BATCH: z.coerce.number().int().min(1).max(8).default(1),
  IMAGE_EMBEDDING_MODE: z.enum(["thumbnail", "all"]).default("thumbnail"),
  CATALOG_IMAGE_NORMALIZE_THRESHOLD_PIXELS: z.coerce.number().int().positive().default(25_000_000),
  CATALOG_IMAGE_MAX_SOURCE_PIXELS: z.coerce.number().int().positive().default(150_000_000),
  CATALOG_IMAGE_MAX_SOURCE_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  CATALOG_IMAGE_MAX_EDGE: z.coerce.number().int().min(224).default(4096),
  CATALOG_IMAGE_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(9 * 1024 * 1024),
  STABLE_VISUAL_COVERAGE_MIN: z.coerce.number().min(0).max(1).default(0.95),
  PREVIEW_VISUAL_COVERAGE_MIN: z.coerce.number().min(0).max(1).default(0.90),
});
const parsed = Schema.parse(process.env);
if (parsed.CATALOG_IMAGE_MAX_SOURCE_PIXELS <= parsed.CATALOG_IMAGE_NORMALIZE_THRESHOLD_PIXELS) throw new Error("CATALOG_IMAGE_MAX_SOURCE_PIXELS must exceed CATALOG_IMAGE_NORMALIZE_THRESHOLD_PIXELS");
if (parsed.CATALOG_IMAGE_MAX_SOURCE_BYTES <= parsed.CATALOG_IMAGE_MAX_OUTPUT_BYTES) throw new Error("CATALOG_IMAGE_MAX_SOURCE_BYTES must exceed CATALOG_IMAGE_MAX_OUTPUT_BYTES");
const normalizationFingerprint = ["catalog-normalize-v1", parsed.CATALOG_IMAGE_NORMALIZE_THRESHOLD_PIXELS, parsed.CATALOG_IMAGE_MAX_SOURCE_PIXELS, parsed.CATALOG_IMAGE_MAX_SOURCE_BYTES, parsed.CATALOG_IMAGE_MAX_EDGE, parsed.CATALOG_IMAGE_MAX_OUTPUT_BYTES, "jpeg92-444-white"].join(":");
const florenceCacheKey = captionCacheKey(parsed.CAPTION_TASK, parsed.CAPTION_MAX_NEW_TOKENS, parsed.CAPTION_NUM_BEAMS);
const qwenCacheKey = qwenCaptionCacheKey(parsed.QWEN_CAPTION_PROMPT_VERSION, parsed.QWEN_CAPTION_MAX_TOKENS, parsed.QWEN_CAPTION_SEED, parsed.QWEN_CAPTION_MMPROJ_SHA256, parsed.QWEN_CAPTION_PROMPT_SHA256);
const florenceFingerprint = ["caption-e5-v2", "florence", parsed.CAPTION_MODEL_ID, parsed.CAPTION_MODEL_REVISION, florenceCacheKey, parsed.TEXT_EMBEDDING_MODEL_ID, parsed.TEXT_EMBEDDING_MODEL_REVISION, parsed.TEXT_EMBEDDING_DIMENSIONS, normalizationFingerprint].join(":");
const qwenFingerprint = ["caption-e5-v2", "qwen", parsed.QWEN_CAPTION_MODEL_ID, parsed.QWEN_CAPTION_MODEL_SHA256, qwenCacheKey, parsed.TEXT_EMBEDDING_MODEL_ID, parsed.TEXT_EMBEDDING_MODEL_REVISION, parsed.TEXT_EMBEDDING_DIMENSIONS, normalizationFingerprint].join(":");
export const config = {
  ...parsed,
  STATE_DATABASE_PATH: isAbsolute(parsed.STATE_DATABASE_PATH) ? parsed.STATE_DATABASE_PATH : resolve(WORKSPACE_ROOT, parsed.STATE_DATABASE_PATH),
  IMAGE_NORMALIZATION_FINGERPRINT: normalizationFingerprint,
  SIGLIP_FINGERPRINT: [parsed.EMBEDDING_MODEL_ID, parsed.EMBEDDING_MODEL_REVISION, parsed.EMBEDDING_DIMENSIONS, parsed.SIGLIP_MAX_NUM_PATCHES, "adaptive_long_axis_v1", parsed.IMAGE_EMBEDDING_MODE, normalizationFingerprint].join(":"),
  DINOV2_FINGERPRINT: [parsed.DINOV2_MODEL_ID, parsed.DINOV2_MODEL_REVISION, parsed.DINOV2_DIMENSIONS, parsed.DINOV2_IMAGE_SIZE, parsed.DINOV2_POOLING, "adaptive_long_axis_v1", "l2", parsed.IMAGE_EMBEDDING_MODE, normalizationFingerprint].join(":"),
  DINOV3_FINGERPRINT: [parsed.DINOV3_MODEL_ID, parsed.DINOV3_ARCHIVE_SHA256, parsed.DINOV3_DIMENSIONS, parsed.DINOV3_IMAGE_SIZE, parsed.DINOV3_POOLING, "adaptive_long_axis_v1", "l2", parsed.IMAGE_EMBEDDING_MODE, normalizationFingerprint].join(":"),
  CAPTION_BACKFILL_FINGERPRINT: florenceFingerprint,
  CAPTION_FINGERPRINTS: { florence: florenceFingerprint, qwen: qwenFingerprint },
  CAPTION_CACHE_KEYS: { florence: florenceCacheKey, qwen: qwenCacheKey },
  CAPTION_CACHE_KEY: florenceCacheKey,
};
export const redis = { host: config.REDIS_HOST, port: config.REDIS_PORT, db: config.REDIS_DB, username: config.REDIS_USERNAME, password: config.REDIS_PASSWORD, maxRetriesPerRequest: null };
