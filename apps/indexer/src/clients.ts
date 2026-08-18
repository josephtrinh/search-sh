import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config";

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
  async visualText(texts: string[]): Promise<number[][]> { return this.call("embed/visual-text", { texts, priority: 10 }); }
  async images(images: Buffer[], model: "siglip2" | "dinov2" | "dinov3" = "siglip2"): Promise<number[][]> { return this.call("images", { images: images.map((image) => image.toString("base64")), model, priority: 10 }); }
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
    return Buffer.from(await result.Body.transformToByteArray());
  }
}

export class MeiliClient {
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${config.MEILI_URL}${path}`, { method, headers: { Authorization: `Bearer ${config.MEILI_MASTER_KEY}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`Meilisearch ${method} ${path}: ${(await response.text()).slice(0, 500)}`);
    return response.status === 204 ? undefined : response.json();
  }
  async exists(uid: string): Promise<boolean> { const response = await fetch(`${config.MEILI_URL}/indexes/${uid}`, { headers: { Authorization: `Bearer ${config.MEILI_MASTER_KEY}` } }); return response.ok; }
  async create(uid: string) { await this.wait((await this.request("POST", "/indexes", { uid, primaryKey: "id" })).taskUid); }
  async configure(uid: string) {
    const settings = {
      displayedAttributes: ["id","groupId","brand","normalizedBrand","series","normalizedSeries","name","sku","model","item","category","categoryZh","material","color","origin","effect","surface","edge","sizeGroup","waterAbsorption","fireResistance","description","detail","remarks","price","availability","width","height","length","depth","area","updatedAt","thumbnailId","images","attributes"],
      searchableAttributes: ["brand","series","name","sku","model","item","category","categoryZh","material","color","origin","effect","surface","edge","sizeGroup","waterAbsorption","fireResistance","generatedVisualCaption","description","detail","remarks","attributes"],
      filterableAttributes: ["groupId","category","material","color","origin","effect","brand","series","model","surface","edge","sizeGroup","waterAbsorption","fireResistance","price","availability"],
      sortableAttributes: ["price"], pagination: { maxTotalHits: 10000 }, faceting: { maxValuesPerFacet: 100, sortFacetValuesBy: { "*": "count" } },
      embedders: {
        e5_text: { source: "userProvided", dimensions: config.TEXT_EMBEDDING_DIMENSIONS },
        siglip_image: { source: "userProvided", dimensions: config.EMBEDDING_DIMENSIONS },
        dinov2_image: { source: "userProvided", dimensions: config.DINOV2_DIMENSIONS },
        dinov3_image: { source: "userProvided", dimensions: config.DINOV3_DIMENSIONS },
      },
    };
    await this.wait((await this.request("PATCH", `/indexes/${uid}/settings`, settings)).taskUid);
  }
  async add(uid: string, documents: unknown[]) { await this.wait((await this.request("POST", `/indexes/${uid}/documents?primaryKey=id`, documents)).taskUid); }
  async deleteDocuments(uid: string, ids: string[]) { if (ids.length) await this.wait((await this.request("POST", `/indexes/${uid}/documents/delete-batch`, ids)).taskUid); }
  async count(uid: string): Promise<number> { return Number((await this.request("GET", `/indexes/${uid}/stats`)).numberOfDocuments); }
  async hasEmbedder(uid: string, name: string): Promise<boolean> { const settings = await this.request("GET", `/indexes/${uid}/settings`); return Boolean(settings.embedders?.[name]); }
  async ensureVisualEmbedder(uid: string, model: "dinov2" | "dinov3") {
    const settings = await this.request("GET", `/indexes/${uid}/settings/embedders`) as Record<string, { dimensions?: number } | undefined>;
    const embedder = `${model}_image`;
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
  async vectors(uid: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    if (!ids.length) return new Map();
    const response = await this.request("POST", `/indexes/${uid}/documents/fetch`, { ids, fields: ["id"], retrieveVectors: true, limit: ids.length }) as { results?: Array<{ id: string; _vectors?: Record<string, unknown> }> };
    return new Map((response.results ?? []).map((document) => [String(document.id), document._vectors ?? {}]));
  }
  async vectorPage(uid: string, offset: number, limit: number): Promise<Array<{ id: string; vectors: Record<string, unknown> }>> {
    const response = await this.request("POST", `/indexes/${uid}/documents/fetch`, {
      offset, limit, fields: ["id"], retrieveVectors: true,
    }) as { results?: Array<{ id: string; _vectors?: Record<string, unknown> }> };
    return (response.results ?? []).map((document) => ({ id: String(document.id), vectors: document._vectors ?? {} }));
  }
  async updateVectors(uid: string, documents: Array<{ id: string; _vectors: Record<string, unknown> }>) {
    if (documents.length) await this.wait((await this.request("PUT", `/indexes/${uid}/documents`, documents)).taskUid);
  }
  async swap(first: string, second: string) { await this.wait((await this.request("POST", "/swap-indexes", [{ indexes: [first, second] }])).taskUid); }
  async deleteIndex(uid: string) { if (await this.exists(uid)) await this.wait((await this.request("DELETE", `/indexes/${uid}`)).taskUid); }
  async smoke(uid: string) { await this.request("POST", `/indexes/${uid}/search`, { q: "stone", limit: 1, distinct: "groupId" }); }
  private async wait(taskUid: number) {
    for (;;) { const task = await this.request("GET", `/tasks/${taskUid}`); if (task.status === "succeeded") return task; if (task.status === "failed" || task.status === "canceled") throw new Error(`Meilisearch task ${taskUid} ${task.status}: ${JSON.stringify(task.error)}`); await new Promise((resolve) => setTimeout(resolve, 150)); }
  }
}
