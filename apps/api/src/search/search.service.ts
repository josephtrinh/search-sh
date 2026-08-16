import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { facetKeys, FiltersSchema, SearchRequestSchema, type FacetKey, type GroupDetail, type ProductDocument, type RankingConfig, type SearchFilters, type SearchResponse } from "@samplehub/contracts";
import { getConfig } from "../common/config";
import { StateService } from "../state/state.service";
import { interpretQuery, interpretedFields, type AttributeVocabulary, type DerivedFilterGroup, type QueryInterpretation } from "./query-interpreter";
import { interleavePreferredResults, weightedReciprocalRankFusion } from "./rank-fusion";

type MeiliHit = ProductDocument & { _rankingScore?: number; _federation?: unknown };
interface MeiliResult { hits: MeiliHit[]; estimatedTotalHits?: number; processingTimeMs?: number; facetDistribution?: Record<string, Record<string, number>>; }
type MatchSource = "keyword" | "semantic" | "visual_text" | "image";
interface SearchBranch { source: MatchSource; weight: number; tier: "standard" | "preferred" | "fallback"; query: Record<string, unknown>; }
interface RankedHit { hit: MeiliHit; matchSources: MatchSource[]; primaryMatchSource: MatchSource; }

const FACET_FIELD: Record<FacetKey, string> = {
  category: "category", material: "material", color: "color", origin: "origin", effect: "effect", brand: "brand", series: "series",
  model: "model", surface: "surface", edge: "edge", sizeGroup: "sizeGroup", waterAbsorption: "waterAbsorption",
  fireResistance: "fireResistance", price: "price", availability: "availability",
};

@Injectable()
export class SearchService {
  private readonly config = getConfig();
  private schemaCache: { v2: boolean; expiresAt: number } | null = null;
  private vocabularyCache: { value: AttributeVocabulary; expiresAt: number } | null = null;
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

  private async isV2Index(): Promise<boolean> {
    if (this.schemaCache && this.schemaCache.expiresAt > Date.now()) return this.schemaCache.v2;
    try {
      const settings = await this.meili(`/indexes/${this.config.MEILI_INDEX_UID}/settings`);
      const v2 = Boolean(settings.embedders?.e5_text);
      this.schemaCache = { v2, expiresAt: Date.now() + 5000 };
      return v2;
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  }

  private async embed(path: "text" | "visual-text" | "images", values: string[]): Promise<{ vectors: number[][]; milliseconds: number }> {
    const started = performance.now();
    const response = await fetch(`${this.config.INFERENCE_URL}/v1/embed/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(path === "images" ? { images: values, priority: 0 } : { texts: values, ...(path === "text" ? { inputType: "query" } : {}), priority: 0 }),
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

  private derivedFilterExpression(explicit: SearchFilters, groups: readonly DerivedFilterGroup[]): string | undefined {
    const expressions = groups.flatMap((group) => {
      const clauses = Object.entries(group.fields).flatMap(([field, values]) => {
        const key = field as FacetKey;
        if (explicit[key]?.length || !values?.length) return [];
        return [`${FACET_FIELD[key]} IN [${values.map((value) => JSON.stringify(value)).join(",")}]`];
      });
      if (!clauses.length) return [];
      return [clauses.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`];
    });
    return expressions.length ? expressions.join(" AND ") : undefined;
  }

  private combineFilters(...filters: Array<string | undefined>): string | undefined {
    const active = filters.filter((filter): filter is string => Boolean(filter));
    return active.length ? active.map((filter) => `(${filter})`).join(" AND ") : undefined;
  }

  private async attributeVocabulary(): Promise<AttributeVocabulary> {
    if (this.vocabularyCache && this.vocabularyCache.expiresAt > Date.now()) return this.vocabularyCache.value;
    const result = await this.meili(`/indexes/${this.config.MEILI_INDEX_UID}/search`, {
      q: "", limit: 0, facets: interpretedFields.map((field) => FACET_FIELD[field]),
    }) as MeiliResult;
    const value = Object.fromEntries(interpretedFields.map((field) => [field,
      Object.keys(result.facetDistribution?.[FACET_FIELD[field]] ?? {})])) as AttributeVocabulary;
    this.vocabularyCache = { value, expiresAt: Date.now() + 5 * 60_000 };
    return value;
  }

  private branch(source: MatchSource, query: string, vector: number[] | undefined, embedder: string | undefined, filter?: string, weight = 1): SearchBranch {
    return { source, weight, tier: "standard", query: {
      indexUid: this.config.MEILI_INDEX_UID,
      q: query,
      ...(vector ? { vector } : {}),
      ...(embedder ? { hybrid: { embedder, semanticRatio: 1 } } : {}),
      ...(filter ? { filter } : {}),
      showRankingScore: true,
    } };
  }

  async search(input: Record<string, unknown>, image?: Express.Multer.File): Promise<SearchResponse> {
    const request = SearchRequestSchema.parse({ ...input, filters: typeof input.filters === "string" ? JSON.parse(input.filters) : input.filters, hasImage: Boolean(image) });
    const started = performance.now();
    const explicitFilters = FiltersSchema.parse(request.filters);
    const v2 = await this.isV2Index();
    if (!v2 && (explicitFilters.origin?.length || explicitFilters.effect?.length)) {
      throw new BadRequestException("Origin and effect filters require a completed v2 full rebuild");
    }
    const explicitFilter = this.filterExpression(explicitFilters);
    const ranking = this.state.getRanking();
    const query = request.query ?? "";
    const needsSemantic = Boolean(query) && ["auto", "text_semantic", "text_hybrid"].includes(request.mode);
    const needsVisualText = Boolean(query) && (["auto", "text_visual"].includes(request.mode) || (!v2 && needsSemantic));
    const [semanticEmbedding, visualTextEmbedding, imageEmbedding] = await Promise.all([
      needsSemantic && v2 ? this.embed("text", [query]) : Promise.resolve(undefined),
      needsVisualText ? this.embed("visual-text", [query]) : Promise.resolve(undefined),
      image ? this.embed("images", [image.buffer.toString("base64")]) : Promise.resolve(undefined),
    ]);
    const interpretation: QueryInterpretation = request.mode === "auto" && Boolean(query)
      ? interpretQuery(query, await this.attributeVocabulary())
      : { lexicalQuery: query, derivedFilterGroups: [], derivedFilters: {} };
    if (!v2) {
      delete interpretation.derivedFilters.origin;
      delete interpretation.derivedFilters.effect;
      interpretation.derivedFilterGroups = interpretation.derivedFilterGroups.map((group) => ({ ...group, fields: { ...group.fields, origin: undefined, effect: undefined } }));
    }
    const derivedFilter = this.derivedFilterExpression(explicitFilters, interpretation.derivedFilterGroups);
    const hasDerived = Boolean(derivedFilter);
    const preferredFilter = this.combineFilters(explicitFilter, derivedFilter);
    const vectors = {
      semantic: semanticEmbedding?.vectors[0] ?? (!v2 ? visualTextEmbedding?.vectors[0] : undefined),
      visualText: visualTextEmbedding?.vectors[0],
      image: imageEmbedding?.vectors[0],
    };
    let branches = this.buildBranches(request.mode, interpretation.lexicalQuery, vectors, preferredFilter, ranking, v2);
    if (hasDerived) {
      const preferred = branches.map((branch) => ({ ...branch, tier: "preferred" as const, weight: branch.weight * 0.85 }));
      const fallback = this.buildBranches(request.mode, interpretation.lexicalQuery, vectors, explicitFilter, ranking, v2)
        .map((branch) => ({ ...branch, tier: "fallback" as const, weight: branch.weight * 0.15 }));
      branches = [...preferred, ...fallback];
    }
    if (!branches.length) throw new BadRequestException("The selected mode is incompatible with the supplied query");
    const offset = this.decodeCursor(request.cursor);
    const activeFacetKeys = v2 ? facetKeys : facetKeys.filter((key) => key !== "origin" && key !== "effect");
    const ranked = await this.executeBranches(branches, request.limit, offset);
    const facetResult = await this.loadFacets(branches[0]!.query, activeFacetKeys);
    const hits = ranked.hits.map(({ hit, matchSources, primaryMatchSource }) => ({ groupId: hit.groupId, brand: hit.brand, series: hit.series,
      representative: this.cleanHit(hit), matchSources, primaryMatchSource }));
    return {
      hits,
      facets: facetKeys.map((key) => {
        const values = facetResult.facetDistribution?.[FACET_FIELD[key]] ?? {};
        return { key, values: Object.entries(values).map(([value, count]) => ({ value, count })), enabled: Object.keys(values).length > 0 };
      }),
      nextCursor: hits.length === request.limit ? this.encodeCursor(offset + hits.length) : null,
      estimatedProductHits: facetResult.estimatedTotalHits ?? ranked.estimatedTotalHits ?? hits.length,
      processingTimeMs: performance.now() - started,
      timing: { inference: (semanticEmbedding?.milliseconds ?? 0) + (visualTextEmbedding?.milliseconds ?? 0) + (imageEmbedding?.milliseconds ?? 0), meilisearch: ranked.processingTimeMs },
    };
  }

  private async executeBranches(branches: readonly SearchBranch[], limit: number, offset: number): Promise<{ hits: RankedHit[]; estimatedTotalHits?: number; processingTimeMs: number }> {
    if (branches.length === 1) {
      const branch = branches[0]!;
      const { indexUid: _, ...query } = branch.query;
      const result = await this.meili(`/indexes/${this.config.MEILI_INDEX_UID}/search`, {
        ...query, distinct: "groupId", limit, offset,
      }) as MeiliResult;
      return { hits: result.hits.map((hit) => ({ hit, matchSources: [branch.source], primaryMatchSource: branch.source })),
        estimatedTotalHits: result.estimatedTotalHits, processingTimeMs: result.processingTimeMs ?? 0 };
    }
    const candidateLimit = Math.min(1000, Math.max(200, offset + limit * 4));
    const results = await Promise.all(branches.map(async (branch) => {
      const { indexUid: _, ...query } = branch.query;
      const result = await this.meili(`/indexes/${this.config.MEILI_INDEX_UID}/search`, {
        ...query, distinct: "groupId", limit: candidateLimit, offset: 0,
      }) as MeiliResult;
      return { branch, result };
    }));
    const fuse = (selected: typeof results) => weightedReciprocalRankFusion(selected.map(({ branch, result }) => ({
      source: branch.source, weight: branch.weight, hits: result.hits,
    })), (hit) => hit.groupId);
    const hasPreferredTier = results.some(({ branch }) => branch.tier === "preferred");
    const fused = (hasPreferredTier
      ? interleavePreferredResults(
        fuse(results.filter(({ branch }) => branch.tier === "preferred")),
        fuse(results.filter(({ branch }) => branch.tier === "fallback")),
        (result) => result.hit.groupId,
      )
      : fuse(results)).slice(offset, offset + limit);
    return {
      hits: fused.map(({ hit, matchSources, primaryMatchSource }) => ({
        hit, matchSources: matchSources as MatchSource[], primaryMatchSource: primaryMatchSource as MatchSource,
      })),
      estimatedTotalHits: Math.max(...results.map(({ result }) => result.estimatedTotalHits ?? result.hits.length)),
      processingTimeMs: results.reduce((total, { result }) => total + (result.processingTimeMs ?? 0), 0),
    };
  }

  private buildBranches(mode: string, query: string, vectors: { semantic?: number[]; visualText?: number[]; image?: number[] }, filter: string | undefined, ranking: RankingConfig, v2: boolean): SearchBranch[] {
    const semanticEmbedder = v2 ? "e5_text" : "siglip_text";
    if (mode === "keyword") return query ? [this.branch("keyword", query, undefined, undefined, filter)] : [];
    if (mode === "text_semantic") return vectors.semantic ? [this.branch("semantic", "", vectors.semantic, semanticEmbedder, filter)] : [];
    if (mode === "text_hybrid") return [
      ...(query ? [this.branch("keyword", query, undefined, undefined, filter, ranking.textKeywordWeight)] : []),
      ...(vectors.semantic ? [this.branch("semantic", "", vectors.semantic, semanticEmbedder, filter, ranking.textSemanticWeight)] : []),
    ];
    if (mode === "text_visual") return vectors.visualText ? [this.branch("visual_text", "", vectors.visualText, "siglip_image", filter)] : [];
    if (mode === "image_visual") return vectors.image ? [this.branch("image", "", vectors.image, "siglip_image", filter)] : [];
    if (vectors.image && !query) return [this.branch("image", "", vectors.image, "siglip_image", filter)];
    if (vectors.image && query) return [
      this.branch("keyword", query, undefined, undefined, filter, ranking.combinedKeywordWeight),
      ...(vectors.semantic ? [this.branch("semantic", "", vectors.semantic, semanticEmbedder, filter, ranking.combinedSemanticWeight)] : []),
      ...(vectors.visualText ? [this.branch("visual_text", "", vectors.visualText, "siglip_image", filter, ranking.combinedVisualTextWeight)] : []),
      this.branch("image", "", vectors.image, "siglip_image", filter, ranking.combinedImageWeight),
    ];
    return [
      ...(query ? [this.branch("keyword", query, undefined, undefined, filter, ranking.textKeywordWeight)] : []),
      ...(vectors.semantic ? [this.branch("semantic", "", vectors.semantic, semanticEmbedder, filter, ranking.textSemanticWeight)] : []),
      ...(vectors.visualText ? [this.branch("visual_text", "", vectors.visualText, "siglip_image", filter, ranking.textVisualWeight)] : []),
    ];
  }

  private async loadFacets(base: Record<string, unknown>, activeFacetKeys: readonly FacetKey[]): Promise<MeiliResult> {
    const { indexUid: _, ...query } = base;
    return this.meili(`/indexes/${this.config.MEILI_INDEX_UID}/search`, { ...query,
      distinct: undefined, facets: activeFacetKeys.map((key) => FACET_FIELD[key]), limit: 0, offset: 0 });
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
    const { _rankingScore: _, _federation: __, ...document } = hit;
    return document;
  }
  private encodeCursor(offset: number): string { return Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString("base64url"); }
  private decodeCursor(cursor?: string): number {
    if (!cursor) return 0;
    try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (value.v !== 1 || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error(); return value.offset; }
    catch { throw new BadRequestException("Invalid search cursor"); }
  }
}
