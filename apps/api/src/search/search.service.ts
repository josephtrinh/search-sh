import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { facetKeys, FiltersSchema, SearchRequestSchema, type FacetKey, type GroupDetail, type ProductDocument, type RankingConfig, type SearchResponse } from "@samplehub/contracts";
import { getConfig } from "../common/config";
import { StateService } from "../state/state.service";

type MeiliHit = ProductDocument & { _rankingScore?: number };
interface MeiliResult { hits: MeiliHit[]; estimatedTotalHits?: number; processingTimeMs?: number; facetDistribution?: Record<string, Record<string, number>>; }

const FACET_FIELD: Record<FacetKey, string> = {
  category: "category", material: "material", color: "color", brand: "brand", series: "series",
  model: "model", surface: "surface", edge: "edge", sizeGroup: "sizeGroup", waterAbsorption: "waterAbsorption",
  fireResistance: "fireResistance", price: "price", availability: "availability",
};

@Injectable()
export class SearchService {
  private readonly config = getConfig();
  constructor(private readonly state: StateService) {}

  private async meili(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.config.MEILI_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.config.MEILI_MASTER_KEY}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404) throw new NotFoundException("Search index is not available. Run a full index first.");
    if (!response.ok) throw new ServiceUnavailableException(`Meilisearch: ${(await response.text()).slice(0, 300)}`);
    return response.json();
  }

  private async embed(kind: "text" | "images", values: string[]): Promise<{ vectors: number[][]; milliseconds: number }> {
    const started = performance.now();
    const response = await fetch(`${this.config.INFERENCE_URL}/v1/embed/${kind}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind === "text" ? { texts: values, priority: 0 } : { images: values, priority: 0 }),
    });
    if (!response.ok) throw new BadRequestException(`Inference rejected the query: ${(await response.text()).slice(0, 300)}`);
    const payload = await response.json() as { embeddings: number[][] };
    return { vectors: payload.embeddings, milliseconds: performance.now() - started };
  }

  private filterExpression(filters: unknown): string | undefined {
    const parsed = FiltersSchema.parse(filters);
    const clauses: string[] = [];
    for (const [key, values] of Object.entries(parsed) as Array<[FacetKey, string[] | undefined]>) {
      if (values?.length) clauses.push(`${FACET_FIELD[key]} IN [${values.map((value) => JSON.stringify(value)).join(",")}]`);
    }
    return clauses.length ? clauses.join(" AND ") : undefined;
  }

  private branch(query: string, vector: number[] | undefined, embedder: string | undefined, ratio: number, filter?: string, weight = 1) {
    return {
      indexUid: this.config.MEILI_INDEX_UID,
      q: query,
      ...(vector ? { vector } : {}),
      ...(embedder ? { hybrid: { embedder, semanticRatio: ratio } } : {}),
      ...(filter ? { filter } : {}),
      showRankingScore: true,
      federationOptions: { weight },
    };
  }

  async search(input: Record<string, unknown>, image?: Express.Multer.File): Promise<SearchResponse> {
    const request = SearchRequestSchema.parse({ ...input, filters: typeof input.filters === "string" ? JSON.parse(input.filters) : input.filters, hasImage: Boolean(image) });
    const started = performance.now();
    const filter = this.filterExpression(request.filters);
    const ranking = this.state.getRanking();
    const query = request.query ?? "";
    const [textEmbedding, imageEmbedding] = await Promise.all([
      query && request.mode !== "keyword" ? this.embed("text", [query]) : Promise.resolve(undefined),
      image ? this.embed("images", [image.buffer.toString("base64")]) : Promise.resolve(undefined),
    ]);
    const branches = this.buildBranches(request.mode, query, textEmbedding?.vectors[0], imageEmbedding?.vectors[0], filter, ranking);
    if (!branches.length) throw new BadRequestException("The selected mode is incompatible with the supplied query");
    const offset = this.decodeCursor(request.cursor);
    let result: MeiliResult;
    if (branches.length === 1) {
      result = await this.meili(`/indexes/${this.config.MEILI_INDEX_UID}/search`, { ...branches[0], indexUid: undefined, federationOptions: undefined,
        distinct: "groupId", facets: facetKeys.map((key) => FACET_FIELD[key]), limit: request.limit, offset });
    } else {
      const payload = await this.meili("/multi-search", {
        federation: { limit: request.limit, offset, distinct: "groupId" },
        queries: branches,
      });
      result = payload as MeiliResult;
    }
    const facetResult = await this.loadFacets(branches[0]!, filter);
    const hits = result.hits.map((hit) => ({ groupId: hit.groupId, brand: hit.brand, series: hit.series,
      representative: this.cleanHit(hit), matchSources: branches.map((branch) => String(branch.hybrid?.embedder ?? "keyword")) }));
    return {
      hits,
      facets: facetKeys.map((key) => {
        const values = facetResult.facetDistribution?.[FACET_FIELD[key]] ?? {};
        return { key, values: Object.entries(values).map(([value, count]) => ({ value, count })), enabled: Object.keys(values).length > 0 };
      }),
      nextCursor: hits.length === request.limit ? this.encodeCursor(offset + hits.length) : null,
      estimatedProductHits: facetResult.estimatedTotalHits ?? result.estimatedTotalHits ?? hits.length,
      processingTimeMs: performance.now() - started,
      timing: { inference: (textEmbedding?.milliseconds ?? 0) + (imageEmbedding?.milliseconds ?? 0), meilisearch: result.processingTimeMs ?? 0 },
    };
  }

  private buildBranches(mode: string, query: string, text: number[] | undefined, image: number[] | undefined, filter: string | undefined, ranking: RankingConfig): any[] {
    if (mode === "keyword") return query ? [this.branch(query, undefined, undefined, 0, filter)] : [];
    if (mode === "text_semantic") return text ? [this.branch("", text, "siglip_text", 1, filter)] : [];
    if (mode === "text_hybrid") return text ? [this.branch(query, text, "siglip_text", ranking.semanticRatio, filter)] : [];
    if (mode === "text_visual") return text ? [this.branch("", text, "siglip_image", 1, filter)] : [];
    if (mode === "image_visual") return image ? [this.branch("", image, "siglip_image", 1, filter)] : [];
    const branches: any[] = [];
    const textScale = image ? ranking.combinedTextWeight : 1;
    if (text) {
      branches.push(this.branch(query, text, "siglip_text", ranking.semanticRatio, filter, textScale * ranking.textHybridWeight));
      branches.push(this.branch("", text, "siglip_image", 1, filter, textScale * ranking.textVisualWeight));
    }
    if (image) branches.push(this.branch("", image, "siglip_image", 1, filter, text ? ranking.combinedImageWeight : 1));
    return branches;
  }

  private async loadFacets(base: any, filter?: string): Promise<MeiliResult> {
    return this.meili(`/indexes/${this.config.MEILI_INDEX_UID}/search`, { ...base, indexUid: undefined, federationOptions: undefined,
      filter, distinct: undefined, facets: facetKeys.map((key) => FACET_FIELD[key]), limit: 0, offset: 0 });
  }

  async product(id: string): Promise<ProductDocument> {
    const document = await this.meili(`/indexes/${this.config.MEILI_INDEX_UID}/documents/${encodeURIComponent(id)}`);
    return this.cleanHit(document as MeiliHit);
  }

  async group(groupId: string): Promise<GroupDetail> {
    const products: ProductDocument[] = [];
    for (let offset = 0; offset < 10_000; offset += 1000) {
      const page = await this.meili(`/indexes/${this.config.MEILI_INDEX_UID}/search`, { q: "", filter: `groupId = ${JSON.stringify(groupId)}`, limit: 1000, offset });
      products.push(...(page.hits as MeiliHit[]).map((hit) => this.cleanHit(hit)));
      if (page.hits.length < 1000) break;
    }
    if (!products.length) throw new NotFoundException("Product group not found");
    const byModel = new Map<string, ProductDocument[]>();
    for (const product of products) {
      const key = product.model ?? "";
      byModel.set(key, [...(byModel.get(key) ?? []), product]);
    }
    return { groupId, brand: products[0]!.brand, series: products[0]!.series,
      models: [...byModel.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, items]) => ({
        model: model || null,
        areaTotal: items.some((item) => item.area !== null) ? items.reduce((sum, item) => sum + (item.area ?? 0), 0) : null,
        items: items.sort((a, b) => this.itemOrder(a.item, b.item) || a.id.localeCompare(b.id)),
      })) };
  }

  private itemOrder(a: string | null, b: string | null): number {
    if (!a) return b ? 1 : 0; if (!b) return -1;
    const na = Number(a), nb = Number(b); const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
    if (aNum && bNum) return na - nb || a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
  }

  private cleanHit(hit: MeiliHit): ProductDocument {
    const { _rankingScore: _, ...document } = hit;
    return document;
  }
  private encodeCursor(offset: number): string { return Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString("base64url"); }
  private decodeCursor(cursor?: string): number {
    if (!cursor) return 0;
    try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (value.v !== 1 || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error(); return value.offset; }
    catch { throw new BadRequestException("Invalid search cursor"); }
  }
}
