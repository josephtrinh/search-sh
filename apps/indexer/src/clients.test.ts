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

test("configure applies a supplied managed profile without replacing generated embedders", async () => {
  const { MeiliClient } = await import("./clients");
  const { defaultManagedMeilisearchSettings } = await import("@samplehub/contracts");
  const originalFetch = globalThis.fetch;
  const profile = structuredClone(defaultManagedMeilisearchSettings);
  profile.pagination.maxTotalHits = 321;
  let settingsBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/settings")) {
      settingsBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ taskUid: 11 }, { status: 202 });
    }
    if (path === "/tasks/11") return Response.json({ status: "succeeded" });
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await new MeiliClient().configure("products", "current", profile);
    assert.deepEqual(settingsBody?.pagination, { maxTotalHits: 321 });
    assert.equal((settingsBody?.embedders as Record<string, unknown>).siglip_image_v2 !== undefined, true);
    assert.equal((settingsBody?.embedders as Record<string, unknown>).dinov3_image_v2 !== undefined, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
