import "dotenv/config";
import { CatalogRepository } from "./catalog";
import { ImageSource } from "./clients";
import { config } from "./config";

async function main() {
  const catalog = new CatalogRepository();
  try {
    const [count, meili, inference] = await Promise.all([
      catalog.count(),
      fetch(`${config.MEILI_URL}/health`),
      fetch(`${config.INFERENCE_URL}/health`),
    ]);
    const inferenceHealth = inference.ok ? await inference.json() as { models?: Record<string, { model_id?: string; configured_revision?: string }> } : null;
    const sample = await catalog.batch(null, 1);
    if (!sample[0]) throw new Error("No eligible SampleHub guest-library products were found");
    let s3Readable = false;
    let dinov2: Record<string, unknown> | null = null;
    let dinov3: Record<string, unknown> | null = null;
    if (sample[0].images[0]) {
      const bytes = await new ImageSource().get(sample[0].images[0].url);
      s3Readable = bytes.length > 0;
      const response = await fetch(`${config.INFERENCE_URL}/v1/embed/images`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: [bytes.toString("base64")], model: "dinov2", priority: 10 }),
      });
      if (!response.ok) throw new Error(`DINOv2 preflight failed: ${(await response.text()).slice(0, 500)}`);
      dinov2 = await response.json() as Record<string, unknown>;
      if (Number(dinov2.dimensions) !== config.DINOV2_DIMENSIONS) throw new Error(`DINOv2 returned ${dinov2.dimensions} dimensions instead of ${config.DINOV2_DIMENSIONS}`);
      const dinov3Response = await fetch(`${config.INFERENCE_URL}/v1/embed/images`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: [bytes.toString("base64")], model: "dinov3", priority: 10 }),
      });
      if (!dinov3Response.ok) throw new Error(`DINOv3 preflight failed: ${(await dinov3Response.text()).slice(0, 500)}`);
      dinov3 = await dinov3Response.json() as Record<string, unknown>;
      if (Number(dinov3.dimensions) !== config.DINOV3_DIMENSIONS) throw new Error(`DINOv3 returned ${dinov3.dimensions} dimensions instead of ${config.DINOV3_DIMENSIONS}`);
    }
    console.log(JSON.stringify({ eligibleProducts: count, sampleProductMapped: Boolean(sample[0].id && sample[0].groupId),
      sampleImageCount: sample[0].images.length, s3Readable, meilisearchHealthy: meili.ok, inferenceHealthy: inference.ok,
      inferenceModels: inferenceHealth?.models ?? null, dinov2Preflight: dinov2, dinov3Preflight: dinov3 }, null, 2));
  } finally {
    await catalog.close();
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
