import { z } from "zod";
import { config as loadEnv } from "dotenv";
import { isAbsolute, resolve } from "node:path";

const WORKSPACE_ROOT = resolve(__dirname, "../../..");
loadEnv({ path: resolve(WORKSPACE_ROOT, ".env"), quiet: true });
const optional = z.string().optional().transform((value) => value || undefined);
const Schema = z.object({
  DATABASE_HOST: z.string(), DATABASE_PORT: z.coerce.number().int(), DATABASE_USERNAME: z.string(), DATABASE_PASSWORD: z.string(), DATABASE_NAME: z.string(),
  REDIS_HOST: z.string().default("127.0.0.1"), REDIS_PORT: z.coerce.number().default(6379), REDIS_DB: z.coerce.number().default(0), REDIS_USERNAME: optional, REDIS_PASSWORD: optional,
  MEILI_URL: z.string().url().default("http://127.0.0.1:7700"), MEILI_MASTER_KEY: z.string().min(16).default("local-development-master-key"), MEILI_INDEX_UID: z.string().default("products"),
  INFERENCE_URL: z.string().url().default("http://127.0.0.1:8100"), STATE_DATABASE_PATH: z.string().default("./data/search-state.sqlite"),
  AWS_ACCESS_KEY_ID: z.string(), AWS_SECRET_ACCESS_KEY: z.string(), AWS_REGION: z.string(), AWS_BUCKET_NAME: z.string(), AWS_BUCKET_URL: z.string().url(),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().default(768), EMBEDDING_MODEL_ID: z.string().default("google/siglip2-base-patch16-224"), EMBEDDING_MODEL_REVISION: z.string().default("75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"),
  TEXT_EMBEDDING_DIMENSIONS: z.coerce.number().int().default(768), TEXT_EMBEDDING_MODEL_ID: z.string().default("intfloat/multilingual-e5-base"), TEXT_EMBEDDING_MODEL_REVISION: z.string().default("d128750597153bb5987e10b1c3493a34e5a4502a"),
  CAPTION_MODEL_ID: z.string().default("microsoft/Florence-2-base-ft"), CAPTION_MODEL_REVISION: z.string().default("f6c1a25888ffc1d945ee8a1a77ac833c7303d46e"), CAPTION_TASK: z.string().default("<DETAILED_CAPTION>"), MAX_CAPTION_BATCH: z.coerce.number().int().min(1).max(8).default(2),
  IMAGE_EMBEDDING_MODE: z.enum(["thumbnail", "all"]).default("thumbnail"),
});
const parsed = Schema.parse(process.env);
export const config = { ...parsed, STATE_DATABASE_PATH: isAbsolute(parsed.STATE_DATABASE_PATH) ? parsed.STATE_DATABASE_PATH : resolve(WORKSPACE_ROOT, parsed.STATE_DATABASE_PATH) };
export const redis = { host: config.REDIS_HOST, port: config.REDIS_PORT, db: config.REDIS_DB, username: config.REDIS_USERNAME, password: config.REDIS_PASSWORD, maxRetriesPerRequest: null };
