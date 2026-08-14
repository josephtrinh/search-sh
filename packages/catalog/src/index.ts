import { createHash } from "node:crypto";
import type { ProductDocument } from "@samplehub/contracts";

export const normalizeGroupPart = (value: string): string => value.trim().toLocaleLowerCase("en-US");

export function createGroupId(series: string, brand: string): string {
  const key = JSON.stringify([normalizeGroupPart(series), normalizeGroupPart(brand)]);
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function buildEmbeddingText(product: ProductDocument): string {
  const fields: Array<[string, unknown]> = [
    ["Brand", product.brand],
    ["Series", product.series],
    ["Name", product.name],
    ["SKU", product.sku],
    ["Model", product.model],
    ["Item", product.item],
    ["Category", product.category],
    ["Category (Chinese)", product.categoryZh],
    ["Material", product.material],
    ["Color", product.color],
    ["Origin", product.origin],
    ["Effect", product.effect],
    ["Surface", product.surface],
    ["Edge", product.edge],
    ["Size", product.sizeGroup],
    ["Water absorption", product.waterAbsorption],
    ["Fire resistance", product.fireResistance],
    ["Description", product.description],
    ["Detail", product.detail],
    ["Remarks", product.remarks],
    ...Object.entries(product.attributes).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value] as [string, unknown]),
  ];
  return fields
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(([label, value]) => `${label}: ${String(value).trim()}`)
    .join(". ");
}

export const PUBLIC_PRODUCT_FIELDS = [
  "id", "groupId", "brand", "normalizedBrand", "series", "normalizedSeries", "name", "sku", "model", "item",
  "category", "categoryZh", "material", "color", "origin", "effect", "surface", "edge", "sizeGroup",
  "waterAbsorption", "fireResistance", "description", "detail", "remarks", "price", "availability",
  "width", "height", "length", "depth", "area", "updatedAt", "thumbnailId", "images", "attributes",
] as const;
