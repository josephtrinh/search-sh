import { z } from "zod";

export const rankingModes = [
  "auto",
  "keyword",
  "text_semantic",
  "text_hybrid",
  "text_visual",
  "image_visual",
] as const;

export const RankingModeSchema = z.enum(rankingModes);
export type RankingMode = z.infer<typeof RankingModeSchema>;

export const VisualModelSchema = z.enum(["siglip2", "dinov2"]);
export type VisualModel = z.infer<typeof VisualModelSchema>;

export interface VisualModelStatus {
  active: VisualModel;
  siglip2Ready: boolean;
  dinov2Ready: boolean;
  dinov2Fingerprint: string | null;
}

export const facetKeys = [
  "category",
  "material",
  "color",
  "origin",
  "effect",
  "brand",
  "series",
  "model",
  "surface",
  "edge",
  "sizeGroup",
  "waterAbsorption",
  "fireResistance",
  "price",
  "availability",
] as const;

export type FacetKey = (typeof facetKeys)[number];

export const FiltersSchema = z.object(
  Object.fromEntries(facetKeys.map((key) => [key, z.array(z.string()).optional()])) as Record<
    FacetKey,
    z.ZodOptional<z.ZodArray<z.ZodString>>
  >,
);
export type SearchFilters = z.infer<typeof FiltersSchema>;

export const SearchRequestSchema = z
  .object({
    query: z.string().trim().max(500).optional(),
    mode: RankingModeSchema.default("auto"),
    filters: FiltersSchema.default({}),
    sort: z.literal("relevance").default("relevance"),
    limit: z.coerce.number().int().min(1).max(48).default(24),
    cursor: z.string().max(8192).optional(),
    hasImage: z.boolean().default(false),
  })
  .refine((value) => Boolean(value.query) || value.hasImage, {
    message: "Provide text, an image, or both",
  });
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export interface ImageAsset {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  mime: string | null;
}

export type ProductAttributeValue = string | number | string[] | null;

export interface ProductAttributes {
  [key: string]: ProductAttributeValue;
}

export interface ProductDocument {
  id: string;
  groupId: string;
  brand: string;
  normalizedBrand: string;
  series: string;
  normalizedSeries: string;
  name: string | null;
  sku: string | null;
  model: string | null;
  item: string | null;
  category: string | null;
  categoryZh: string | null;
  material: string | null;
  color: string | null;
  origin: string | null;
  effect: string | null;
  surface: string | null;
  edge: string | null;
  sizeGroup: string | null;
  waterAbsorption: string | null;
  fireResistance: string | null;
  description: string | null;
  detail: string | null;
  remarks: string | null;
  price: number | null;
  availability: string | null;
  width: number | null;
  height: number | null;
  length: number | null;
  depth: number | null;
  area: number | null;
  updatedAt: string;
  thumbnailId: string | null;
  images: ImageAsset[];
  attributes: ProductAttributes;
}

export interface GroupCard {
  groupId: string;
  brand: string;
  series: string;
  representative: ProductDocument;
  matchSources: string[];
  primaryMatchSource: "keyword" | "semantic" | "visual_text" | "image";
}

export interface FacetResult {
  key: FacetKey;
  values: Array<{ value: string; count: number }>;
  enabled: boolean;
}

export interface SearchResponse {
  hits: GroupCard[];
  facets: FacetResult[];
  nextCursor: string | null;
  estimatedProductHits: number;
  processingTimeMs: number;
  timing: Record<string, number>;
  visualModel: VisualModel;
}

export interface GroupDetail {
  groupId: string;
  brand: string;
  series: string;
  models: Array<{
    model: string | null;
    areaTotal: number | null;
    items: ProductDocument[];
  }>;
}

export const IndexRunModeSchema = z.enum(["full", "incremental", "visual_backfill"]);
export type IndexRunMode = z.infer<typeof IndexRunModeSchema>;

export interface IndexRunSummary {
  id: string;
  mode: IndexRunMode;
  status: "queued" | "running" | "cancelling" | "cancelled" | "failed" | "completed";
  processedProducts: number;
  totalProducts: number;
  embeddedImages: number;
  failedImages: number;
  siglipEmbeddedImages: number;
  siglipFailedImages: number;
  dinov2EmbeddedImages: number;
  dinov2FailedImages: number;
  captionedImages: number;
  cachedCaptions: number;
  failedCaptions: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface RankingConfig {
  version: 2;
  textKeywordWeight: number;
  textSemanticWeight: number;
  textVisualWeight: number;
  combinedKeywordWeight: number;
  combinedSemanticWeight: number;
  combinedVisualTextWeight: number;
  combinedImageWeight: number;
}

export const defaultRankingConfig: RankingConfig = {
  version: 2,
  textKeywordWeight: 0.4,
  textSemanticWeight: 0.4,
  textVisualWeight: 0.2,
  combinedKeywordWeight: 0.15,
  combinedSemanticWeight: 0.25,
  combinedVisualTextWeight: 0.1,
  combinedImageWeight: 0.5,
};
