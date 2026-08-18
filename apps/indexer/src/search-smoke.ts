import "dotenv/config";
import { buildEmbeddingText, createGroupId, normalizeGroupPart } from "@samplehub/catalog";
import type { ProductDocument } from "@samplehub/contracts";
import { InferenceClient, MeiliClient } from "./clients";
import { config } from "./config";

async function main() {
  const uid = `products_smoke_${Date.now()}`;
  const meili = new MeiliClient();
  try {
    await meili.create(uid);
    await meili.configure(uid);
    const product: ProductDocument = {
      id: "smoke-product", groupId: createGroupId("Calacatta", "Stone Lab"), brand: "Stone Lab", normalizedBrand: normalizeGroupPart("Stone Lab"),
      series: "Calacatta", normalizedSeries: normalizeGroupPart("Calacatta"), name: "Cloud tile", sku: "SMOKE-1", model: "Cloud", item: null, category: null, categoryZh: null,
      material: "Marble", color: "Grey", origin: "Italy", effect: "Stone", surface: "Honed", edge: "Rectified", sizeGroup: "600x600",
      waterAbsorption: null, fireResistance: null, description: "Quiet grey marble tile", detail: null, remarks: null, price: null,
      availability: null, width: 600, height: 10, length: 600, depth: null, area: null, updatedAt: new Date().toISOString(), thumbnailId: null, images: [], attributes: {},
    };
    const inference = new InferenceClient();
    const textVector = (await inference.textPassages([buildEmbeddingText(product)]))[0]!;
    const siglipVector = (await inference.visualText(["grey stone tile"]))[0]!;
    const sampleImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
    const dinov2Vector = (await inference.images([sampleImage], "dinov2"))[0]!;
    const dinov3Vector = (await inference.images([sampleImage], "dinov3"))[0]!;
    await meili.add(uid, [{ ...product, _vectors: { e5_text: textVector, siglip_image_v2: [siglipVector], dinov2_image_v2: [dinov2Vector], dinov3_image_v2: [dinov3Vector] } }]);
    const response = await fetch(`${config.MEILI_URL}/multi-search`, {
      method: "POST", headers: { Authorization: `Bearer ${config.MEILI_MASTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ federation: { limit: 10, offset: 0, distinct: "groupId" }, queries: [
        { indexUid: uid, q: "grey stone", vector: textVector, hybrid: { embedder: "e5_text", semanticRatio: .5 }, federationOptions: { weight: .5 } },
        { indexUid: uid, q: "", vector: siglipVector, hybrid: { embedder: "siglip_image_v2", semanticRatio: 1 }, federationOptions: { weight: .5 } },
        { indexUid: uid, q: "", vector: dinov2Vector, hybrid: { embedder: "dinov2_image_v2", semanticRatio: 1 }, federationOptions: { weight: .5 } },
        { indexUid: uid, q: "", vector: dinov3Vector, hybrid: { embedder: "dinov3_image_v2", semanticRatio: 1 }, federationOptions: { weight: .5 } },
      ] }),
    });
    if (!response.ok) throw new Error(`Federated search failed: ${await response.text()}`);
    const result = await response.json() as { hits: Array<{ groupId: string }> };
    if (result.hits[0]?.groupId !== product.groupId) throw new Error("Federated distinct search did not return the expected group");
    console.log(JSON.stringify({ multipleUserProvidedVectors: true, dinov2ImageSearch: true, dinov3ImageSearch: true, hybridSearch: true, weightedFederation: true, globalDistinct: true }, null, 2));
  } finally {
    await meili.deleteIndex(uid);
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
