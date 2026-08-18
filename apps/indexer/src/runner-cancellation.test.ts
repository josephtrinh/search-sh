import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "bullmq";

const requiredEnv: Record<string, string> = {
  DATABASE_HOST: "127.0.0.1", DATABASE_PORT: "3306", DATABASE_USERNAME: "test",
  DATABASE_PASSWORD: "test", DATABASE_NAME: "test", AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: "us-east-1", AWS_BUCKET_NAME: "test",
  AWS_BUCKET_URL: "https://example.com",
};
for (const [key, value] of Object.entries(requiredEnv)) process.env[key] ??= value;

test("a recovered cancelling rebuild cleans its shadow before finalizing", async () => {
  const { IndexRunner } = await import("./runner");
  const calls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const runner = Object.create(IndexRunner.prototype) as IndexRunner & Record<string, unknown>;
  Object.assign(runner, {
    cancelling: () => true,
    cleanupRunShadow: async () => { calls.push("cleanup"); },
    update: (_runId: string, values: Record<string, unknown>) => { calls.push("update"); updates.push(values); },
  });
  const job = { data: { runId: "cancelled-run", mode: "limited_full", generation: "current", productLimit: 100 } } as Job;
  await runner.run(job);
  assert.deepEqual(calls, ["cleanup", "update"]);
  assert.equal(updates[0]?.status, "cancelled");
});
