import { z } from "zod";
import { config as loadEnv } from "dotenv";
import { isAbsolute, resolve } from "node:path";

export const WORKSPACE_ROOT = resolve(__dirname, "../../../..");
loadEnv({ path: resolve(WORKSPACE_ROOT, ".env"), quiet: true });

const optionalString = z.string().optional().transform((value) => value || undefined);
const ConfigSchema = z.object({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(8000),
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  REDIS_USERNAME: optionalString,
  REDIS_PASSWORD: optionalString,
  MEILI_URL: z.string().url().default("http://127.0.0.1:7700"),
  MEILI_MASTER_KEY: z.string().min(16).default("local-development-master-key"),
  MEILI_INDEX_UID: z.string().default("products"),
  INFERENCE_URL: z.string().url().default("http://127.0.0.1:8100"),
  STATE_DATABASE_PATH: z.string().default("./data/search-state.sqlite"),
  DINOV2_MODEL_ID: z.string().default("facebook/dinov2-base"),
  DINOV2_MODEL_REVISION: z.string().default("f9e44c814b77203eaa57a6bdbbd535f21ede1415"),
  DINOV2_DIMENSIONS: z.coerce.number().int().positive().default(768),
  DINOV3_MODEL_ID: z.string().default("facebook/dinov3-vith16plus-pretrain-lvd1689m"),
  DINOV3_ARCHIVE_SHA256: z.string().regex(/^[a-f0-9]{64}$/i).default("57a28916842ed1d39728ae18c0732ffc31a904407c135232a9a15c87cc28b10d"),
  DINOV3_DIMENSIONS: z.coerce.number().int().positive().default(1280),
  DINOV3_IMAGE_SIZE: z.coerce.number().int().min(224).max(512).refine((value) => value % 16 === 0, "DINOV3_IMAGE_SIZE must be a multiple of 16").default(224),
  IMAGE_EMBEDDING_MODE: z.enum(["thumbnail", "all"]).default("thumbnail"),
});
export type AppConfig = z.infer<typeof ConfigSchema> & { DINOV2_FINGERPRINT: string; DINOV3_FINGERPRINT: string };
let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  if (!cached) {
    const parsed = ConfigSchema.parse(process.env);
    cached = {
      ...parsed,
      STATE_DATABASE_PATH: isAbsolute(parsed.STATE_DATABASE_PATH) ? parsed.STATE_DATABASE_PATH : resolve(WORKSPACE_ROOT, parsed.STATE_DATABASE_PATH),
      DINOV2_FINGERPRINT: [parsed.DINOV2_MODEL_ID, parsed.DINOV2_MODEL_REVISION, parsed.DINOV2_DIMENSIONS, "pooler_output", "l2", parsed.IMAGE_EMBEDDING_MODE].join(":"),
      DINOV3_FINGERPRINT: [parsed.DINOV3_MODEL_ID, parsed.DINOV3_ARCHIVE_SHA256, parsed.DINOV3_DIMENSIONS, parsed.DINOV3_IMAGE_SIZE, "pooler_output", "l2", parsed.IMAGE_EMBEDDING_MODE].join(":"),
    };
  }
  return cached;
}
export function redisConnection() {
  const config = getConfig();
  return { host: config.REDIS_HOST, port: config.REDIS_PORT, db: config.REDIS_DB,
    username: config.REDIS_USERNAME, password: config.REDIS_PASSWORD, maxRetriesPerRequest: null };
}
