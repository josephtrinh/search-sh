import type { ImageAsset, ProductDocument } from "@samplehub/contracts";

export type ImageEmbeddingMode = "thumbnail" | "all";

export function selectEmbeddingImages(
  product: Pick<ProductDocument, "images" | "thumbnailId">,
  mode: ImageEmbeddingMode,
): ImageAsset[] {
  if (mode === "all") return product.images;

  const selected = product.thumbnailId
    ? product.images.find((image) => image.id === product.thumbnailId)
    : undefined;

  return selected ? [selected] : product.images.slice(0, 1);
}
