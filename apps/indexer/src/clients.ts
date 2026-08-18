import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { VisualGeneration, VisualModel } from "@samplehub/contracts";
import { config } from "./config";
import { CatalogImageError } from "./image-normalizer";
import { generationFromEmbedders, visualEmbedder } from "./visual-generation";

export class InferenceHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Inference ${operation} failed: ${responseBody}`);
    this.name = "InferenceHttpError";
  }
}

export function isInferenceInputError(error: unknown): boolean {
  return error instanceof InferenceHttpError && error.status === 422;
}

export class InferenceClient {
  async textPassages(texts: string[]): Promise<number[][]> { return this.call("embed/text", { texts, inputType: "passage", priority: 10 }); }
  async visualText(texts: string[], generation: VisualGeneration = "current"): Promise<number[][]> { return this.call("embed/visual-text", { texts, generation, priority: 10 }); }
  async images(images: Buffer[], model: VisualModel = "siglip2", generation: VisualGeneration = "current"): Promise<number[][]> { return this.call("images", { images: images.map((image) => image.toString("base64")), model, generation, priority: 10 }); }
  async catalogImages(images: Buffer[], model: VisualModel, generation: VisualGeneration): Promise<number[][][]> {
    const response = await fetch(`${config.INFERENCE_URL}/v1/embed/catalog-images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: images.map((image) => image.toString("base64")), model, generation, priority: 10 }),
    });
    if (!response.ok) throw new InferenceHttpError("catalog-images", response.status, (await response.text()).slice(0, 500));
    return ((await response.json()) as { embedding_sets: number[][][] }).embedding_sets;
  }
  async captions(images: Buffer[]): Promise<string[]> {
    const response = await fetch(`${config.INFERENCE_URL}/v1/caption/images`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ images: images.map((image) => image.toString("base64")), priority: 10 }) });
    if (!response.ok) throw new InferenceHttpError("caption", response.status, (await response.text()).slice(0, 500));
    return ((await response.json()) as { captions: string[] }).captions;
  }
  private async call(path: string, body: unknown): Promise<number[][]> {
    const normalizedPath = path.includes("/") ? path : `embed/${path}`;
    const response = await fetch(`${config.INFERENCE_URL}/v1/${normalizedPath}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new InferenceHttpError(path, response.status, (await response.text()).slice(0, 500));
    return ((await response.json()) as { embeddings: number[][] }).embeddings;
  }
}

export class ImageSource {
  private readonly s3 = new S3Client({ region: config.AWS_REGION, credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY } });
  async get(keyOrUrl: string): Promise<Buffer> {
    const base = config.AWS_BUCKET_URL.replace(/\/$/, "") + "/";
    const key = decodeURIComponent(keyOrUrl.startsWith(base) ? keyOrUrl.slice(base.length) : keyOrUrl);
    const result = await this.s3.send(new GetObjectCommand({ Bucket: config.AWS_BUCKET_NAME, Key: key }));
    if (!result.Body) throw new Error("S3 object had no body");
    if (result.ContentLength !== undefined && result.ContentLength > config.CATALOG_IMAGE_MAX_SOURCE_BYTES) {
      throw new CatalogImageError("catalog_image_source_too_large", `S3 object is ${result.ContentLength} bytes; maximum catalog image source is ${config.CATALOG_IMAGE_MAX_SOURCE_BYTES}`);
    }
    const buffer = Buffer.from(await result.Body.transformToByteArray());
    if (buffer.length > config.CATALOG_IMAGE_MAX_SOURCE_BYTES) {
      throw new CatalogImageError("catalog_image_source_too_large", `S3 object is ${buffer.length} bytes; maximum catalog image source is ${config.CATALOG_IMAGE_MAX_SOURCE_BYTES}`);
    }
    return buffer;
  }
}

export class MeiliClient {
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${config.MEILI_URL}${path}`, { method, headers: { Authorization: `Bearer ${config.MEILI_MASTER_KEY}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`Meilisearch ${method} ${path}: ${(await response.text()).slice(0, 500)}`);
    return response.status === 204 ? undefined : response.json();
  }
  async exists(uid: string): Promise<boolean> { const response = await fetch(`${config.MEILI_URL}/indexes/${uid}`, { headers: { Authorization: `Bearer ${config.MEILI_MASTER_KEY}` } }); return response.ok; }
  async listIndexes(): Promise<string[]> {
    const response = await this.request("GET", "/indexes?limit=1000") as { results?: Array<{ uid?: string }> };
    return (response.results ?? []).flatMap((entry) => entry.uid ? [entry.uid] : []);
  }
  async create(uid: string) { await this.wait((await this.request("POST", "/indexes", { uid, primaryKey: "id" })).taskUid); }
  async configure(uid: string, generation: VisualGeneration = "current") {
    const settings = {
      displayedAttributes: ["id","groupId","brand","normalizedBrand","series","normalizedSeries","name","sku","model","item","category","categoryZh","material","color","origin","effect","surface","edge","sizeGroup","waterAbsorption","fireResistance","description","detail","remarks","price","availability","width","height","length","depth","area","updatedAt","thumbnailId","images","attributes","_visualEmbeddingState"],
      searchableAttributes: ["brand","series","name","sku","model","item","category","categoryZh","material","color","origin","effect","surface","edge","sizeGroup","waterAbsorption","fireResistance","generatedVisualCaption","description","detail","remarks","attributes"],
      filterableAttributes: ["groupId","category","material","color","origin","effect","brand","series","model","surface","edge","sizeGroup","waterAbsorption","fireResistance","price","availability"],
      sortableAttributes: ["price"], pagination: { maxTotalHits: 10000 }, faceting: { maxValuesPerFacet: 100, sortFacetValuesBy: { "*": "count" } },
      embedders: {
        e5_text: { source: "userProvided", dimensions: config.TEXT_EMBEDDING_DIMENSIONS },
        [visualEmbedder("siglip2", generation)]: { source: "userProvided", dimensions: config.EMBEDDING_DIMENSIONS },
        [visualEmbedder("dinov2", generation)]: { source: "userProvided", dimensions: config.DINOV2_DIMENSIONS },
        [visualEmbedder("dinov3", generation)]: { source: "userProvided", dimensions: config.DINOV3_DIMENSIONS },
      },
    };
    await this.wait((await this.request("PATCH", `/indexes/${uid}/settings`, settings)).taskUid);
  }
  async add(uid: string, documents: unknown[]) { await this.wait((await this.request("POST", `/indexes/${uid}/documents?primaryKey=id`, documents)).taskUid); }
  async deleteDocuments(uid: string, ids: string[]) { if (ids.length) await this.wait((await this.request("POST", `/indexes/${uid}/documents/delete-batch`, ids)).taskUid); }
  async count(uid: string): Promise<number> { return Number((await this.request("GET", `/indexes/${uid}/stats`)).numberOfDocuments); }
  async hasEmbedder(uid: string, name: string): Promise<boolean> { const settings = await this.request("GET", `/indexes/${uid}/settings`); return Boolean(settings.embedders?.[name]); }
  async generation(uid: string): Promise<VisualGeneration> {
    const settings = await this.request("GET", `/indexes/${uid}/settings/embedders`) as Record<string, unknown>;
    return generationFromEmbedders(settings);
  }
  async ensureVisualEmbedder(uid: string, model: "dinov2" | "dinov3", generation: VisualGeneration) {
    const settings = await this.request("GET", `/indexes/${uid}/settings/embedders`) as Record<string, { dimensions?: number } | undefined>;
    const embedder = visualEmbedder(model, generation);
    const dimensions = model === "dinov2" ? config.DINOV2_DIMENSIONS : config.DINOV3_DIMENSIONS;
    const label = model === "dinov2" ? "DINOv2" : "DINOv3";
    const current = settings[embedder];
    if (current) {
      if (current.dimensions !== dimensions) {
        throw new Error(`Existing ${label} embedder has ${current.dimensions ?? "unknown"} dimensions; a full rebuild is required for ${dimensions} dimensions`);
      }
      return;
    }
    await this.wait((await this.request("PATCH", `/indexes/${uid}/settings/embedders`, {
      ...settings,
      [embedder]: { source: "userProvided", dimensions },
    })).taskUid);
  }
  async vectors(uid: string, ids: string[]): Promise<Map<string, { vectors: Record<string, unknown>; state?: Record<string, unknown> }>> {
    if (!ids.length) return new Map();
    const response = await this.request("POST", `/indexes/${uid}/documents/fetch`, { ids, fields: ["id", "_visualEmbeddingState"], retrieveVectors: true, limit: ids.length }) as { results?: Array<{ id: string; _vectors?: Record<string, unknown>; _visualEmbeddingState?: Record<string, unknown> }> };
    return new Map((response.results ?? []).map((document) => [String(document.id), { vectors: document._vectors ?? {}, state: document._visualEmbeddingState }]));
  }
  async vectorPage(uid: string, offset: number, limit: number): Promise<Array<{ id: string; vectors: Record<string, unknown> }>> {
    const response = await this.request("POST", `/indexes/${uid}/documents/fetch`, {
      offset, limit, fields: ["id"], retrieveVectors: true,
    }) as { results?: Array<{ id: string; _vectors?: Record<string, unknown> }> };
    return (response.results ?? []).map((document) => ({ id: String(document.id), vectors: document._vectors ?? {} }));
  }
  async updateVectors(uid: string, documents: Array<{ id: string; _vectors: Record<string, unknown>; _visualEmbeddingState?: Record<string, unknown> }>) {
    await this.updateDocuments(uid, documents);
  }
  async updateDocuments(uid: string, documents: Array<Record<string, unknown>>) {
    if (documents.length) await this.wait((await this.request("PUT", `/indexes/${uid}/documents`, documents)).taskUid);
  }
  async swap(first: string, second: string) { await this.wait((await this.request("POST", "/swap-indexes", [{ indexes: [first, second] }])).taskUid); }
  async deleteIndex(uid: string) { if (await this.exists(uid)) await this.wait((await this.request("DELETE", `/indexes/${uid}`)).taskUid); }
  async smoke(uid: string) { await this.request("POST", `/indexes/${uid}/search`, { q: "stone", limit: 1, distinct: "groupId" }); }
  private async wait(taskUid: number) {
    for (;;) { const task = await this.request("GET", `/tasks/${taskUid}`); if (task.status === "succeeded") return task; if (task.status === "failed" || task.status === "canceled") throw new Error(`Meilisearch task ${taskUid} ${task.status}: ${JSON.stringify(task.error)}`); await new Promise((resolve) => setTimeout(resolve, 150)); }
  }
}
