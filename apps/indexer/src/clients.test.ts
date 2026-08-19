import assert from "node:assert/strict";
import test from "node:test";

const requiredEnv: Record<string, string> = {
  DATABASE_HOST: "127.0.0.1", DATABASE_PORT: "3306", DATABASE_USERNAME: "test",
  DATABASE_PASSWORD: "test", DATABASE_NAME: "test", AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: "us-east-1", AWS_BUCKET_NAME: "test",
  AWS_BUCKET_URL: "https://example.com",
};
for (const [key, value] of Object.entries(requiredEnv)) process.env[key] ??= value;

test("documentPage omits fields so Meilisearch returns complete documents", async () => {
  const { MeiliClient } = await import("./clients");
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ results: [{ id: "one", images: [], _vectors: { e5_text: [1] } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await new MeiliClient().documentPage("products", 0, 20);
    assert.equal("fields" in requestBody!, false);
    assert.equal(result[0]?.id, "one");
    assert.deepEqual(result[0]?._vectors, { e5_text: [1] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
