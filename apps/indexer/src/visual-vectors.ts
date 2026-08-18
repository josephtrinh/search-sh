export type VisualEmbedder = "dinov2_image" | "dinov3_image" | "dinov2_image_v2" | "dinov3_image_v2";

export function validVisualVectorSet(
  value: unknown,
  expectedCount: number,
  dimensions: number,
): boolean {
  const candidate =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "embeddings" in value
      ? (value as { embeddings?: unknown }).embeddings
      : value;
  if (expectedCount === 0)
    return (
      candidate === null || (Array.isArray(candidate) && candidate.length === 0)
    );
  if (!Array.isArray(candidate)) return false;
  if (
    candidate.length === dimensions &&
    candidate.every((entry) => typeof entry === "number")
  )
    return expectedCount === 1;
  return (
    candidate.length === expectedCount &&
    candidate.every(
      (vector) =>
        Array.isArray(vector) &&
        vector.length === dimensions &&
        vector.every((entry) => typeof entry === "number"),
    )
  );
}

export function mergeVisualVector(
  existing: Record<string, unknown>,
  embedder: VisualEmbedder,
  value: number[][] | null,
): Record<string, unknown> {
  return { ...existing, [embedder]: value };
}

export function mergeTextVector(
  existing: Record<string, unknown>,
  value: number[],
): Record<string, unknown> {
  return { ...existing, e5_text: value };
}
