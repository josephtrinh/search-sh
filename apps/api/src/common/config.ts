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
});
export type AppConfig = z.infer<typeof ConfigSchema>;
let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  if (!cached) {
    const parsed = ConfigSchema.parse(process.env);
    cached = { ...parsed, STATE_DATABASE_PATH: isAbsolute(parsed.STATE_DATABASE_PATH) ? parsed.STATE_DATABASE_PATH : resolve(WORKSPACE_ROOT, parsed.STATE_DATABASE_PATH) };
  }
  return cached;
}
export function redisConnection() {
  const config = getConfig();
  return { host: config.REDIS_HOST, port: config.REDIS_PORT, db: config.REDIS_DB,
    username: config.REDIS_USERNAME, password: config.REDIS_PASSWORD, maxRetriesPerRequest: null };
}
