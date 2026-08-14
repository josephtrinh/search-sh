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
    const sample = await catalog.batch(null, 1);
    if (!sample[0]) throw new Error("No eligible SampleHub guest-library products were found");
    let s3Readable = false;
    if (sample[0].images[0]) {
      const bytes = await new ImageSource().get(sample[0].images[0].url);
      s3Readable = bytes.length > 0;
    }
    console.log(JSON.stringify({ eligibleProducts: count, sampleProductMapped: Boolean(sample[0].id && sample[0].groupId),
      sampleImageCount: sample[0].images.length, s3Readable, meilisearchHealthy: meili.ok, inferenceHealthy: inference.ok }, null, 2));
  } finally {
    await catalog.close();
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
