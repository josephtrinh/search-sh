import { z } from "zod";

export const productDocumentFields = [
  "id", "groupId", "brand", "normalizedBrand", "series", "normalizedSeries", "name", "sku", "model", "item",
  "material", "color", "origin", "effect", "surface", "edge", "sizeGroup",
  "waterAbsorption", "fireResistance", "description", "remarks",
  "width", "height", "length", "depth", "area", "updatedAt", "thumbnailId", "images", "attributes",
] as const;

export const meilisearchKeywordFields = [
  "brand", "series", "name", "sku", "model", "item", "material", "color", "origin",
  "effect", "surface", "edge", "sizeGroup", "waterAbsorption", "fireResistance", "description", "remarks",
  "attributes",
] as const;

export const meilisearchFacetFields = [
  "material", "color", "origin", "effect", "brand", "series", "model", "surface", "edge", "sizeGroup",
  "waterAbsorption", "fireResistance",
] as const;

export const requiredMeilisearchAttributes = {
  displayedAttributes: [...productDocumentFields],
  searchableAttributes: [...meilisearchKeywordFields, "generatedVisualCaption", "generatedVisualCaptionQwen"],
  filterableAttributes: ["groupId", ...meilisearchFacetFields],
  sortableAttributes: [],
} as const;

const AttributeNameSchema = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/, "Use letters, numbers, dots, underscores, or hyphens");
const AttributeListSchema = z.array(AttributeNameSchema).max(256).superRefine((values, context) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) context.addIssue({ code: "custom", path: [index], message: `Duplicate attribute: ${value}` });
    seen.add(value);
  });
});

export const ManagedMeilisearchSettingsShapeSchema = z.object({
  displayedAttributes: AttributeListSchema,
  searchableAttributes: AttributeListSchema,
  filterableAttributes: AttributeListSchema,
  sortableAttributes: AttributeListSchema,
  pagination: z.object({ maxTotalHits: z.number().int().min(1).max(1_000_000) }),
  faceting: z.object({
    maxValuesPerFacet: z.number().int().min(1).max(10_000),
    sortFacetValuesBy: z.record(AttributeNameSchema.or(z.literal("*")), z.enum(["alpha", "count"])),
  }),
});

export const ManagedMeilisearchSettingsSchema = ManagedMeilisearchSettingsShapeSchema.superRefine((settings, context) => {
  for (const key of ["displayedAttributes", "searchableAttributes", "filterableAttributes", "sortableAttributes"] as const) {
    const configured = new Set(settings[key]);
    for (const required of requiredMeilisearchAttributes[key]) {
      if (!configured.has(required)) context.addIssue({ code: "custom", path: [key], message: `${required} is required by the application` });
    }
  }
  const filterable = new Set(settings.filterableAttributes);
  for (const field of Object.keys(settings.faceting.sortFacetValuesBy)) {
    if (field !== "*" && !filterable.has(field)) {
      context.addIssue({ code: "custom", path: ["faceting", "sortFacetValuesBy", field], message: `${field} must also be filterable` });
    }
  }
});

export type ManagedMeilisearchSettings = z.infer<typeof ManagedMeilisearchSettingsSchema>;

export const defaultManagedMeilisearchSettings: ManagedMeilisearchSettings = {
  displayedAttributes: [...productDocumentFields, "_visualEmbeddingState"],
  searchableAttributes: [...meilisearchKeywordFields.slice(0, 15), "generatedVisualCaption", "generatedVisualCaptionQwen", ...meilisearchKeywordFields.slice(15)],
  filterableAttributes: ["groupId", ...meilisearchFacetFields],
  sortableAttributes: [],
  pagination: { maxTotalHits: 10_000 },
  faceting: { maxValuesPerFacet: 100, sortFacetValuesBy: { "*": "count" } },
};

export type MeilisearchTaskState = "enqueued" | "processing" | "succeeded" | "failed" | "canceled";

export interface MeilisearchEmbedderSummary {
  name: string;
  source: string;
  dimensions: number | null;
}

export interface MeilisearchIndexSettingsStatus {
  scope: "stable" | "preview_legacy" | "preview_current";
  uid: string;
  available: boolean;
  inSync: boolean;
  settings: ManagedMeilisearchSettings | null;
  embedders: MeilisearchEmbedderSummary[];
  taskUid: number | null;
  taskStatus: MeilisearchTaskState | null;
  error: string | null;
}

export interface MeilisearchSettingsStatus {
  profile: ManagedMeilisearchSettings;
  defaults: ManagedMeilisearchSettings;
  required: typeof requiredMeilisearchAttributes;
  indexes: MeilisearchIndexSettingsStatus[];
  applying: boolean;
  indexingBusy: boolean;
  environment: {
    url: string;
    baseIndexUid: string;
    version: string | null;
  };
}
