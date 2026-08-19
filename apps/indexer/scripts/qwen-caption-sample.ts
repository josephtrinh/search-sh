import { createHash } from "node:crypto";
import type { ProductDocument } from "@samplehub/contracts";
import { config } from "../src/config";
import { ImageSource, InferenceClient } from "../src/clients";
import { normalizeCatalogImage } from "../src/image-normalizer";
import { selectEmbeddingImages } from "../src/image-selection";

type SampleDocument = ProductDocument & {
  generatedVisualCaptionQwen?: string | null;
};

const scope = process.env.QWEN_SAMPLE_SCOPE ?? "preview_current";
const sampleSize = Number(process.env.QWEN_SAMPLE_SIZE ?? "30");
const scopeUid =
  scope === "stable"
    ? config.MEILI_INDEX_UID
    : `${config.MEILI_INDEX_UID}_preview_${scope === "preview_legacy" ? "legacy" : "current"}`;

if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 100) {
  throw new Error("QWEN_SAMPLE_SIZE must be an integer from 1 through 100");
}
if (!["stable", "preview_legacy", "preview_current"].includes(scope)) {
  throw new Error(
    "QWEN_SAMPLE_SCOPE must be stable, preview_legacy, or preview_current",
  );
}

async function documents(): Promise<SampleDocument[]> {
  const response = await fetch(
    `${config.MEILI_URL}/indexes/${scopeUid}/documents/fetch`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.MEILI_MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        limit: 10_000,
        fields: [
          "id",
          "groupId",
          "brand",
          "normalizedBrand",
          "series",
          "normalizedSeries",
          "name",
          "category",
          "categoryZh",
          "material",
          "color",
          "thumbnailId",
          "images",
        ],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Meilisearch sample fetch failed: ${(await response.text()).slice(0, 500)}`,
    );
  }
  return ((await response.json()) as { results: SampleDocument[] }).results;
}

function stableRank(document: SampleDocument): string {
  return createHash("sha256")
    .update(`qwen-caption-v2-sample:${document.id}`)
    .digest("hex");
}

async function main(): Promise<void> {
  const candidates = (await documents())
    .filter(
      (document) => selectEmbeddingImages(document, "thumbnail").length > 0,
    )
    .sort((left, right) => stableRank(left).localeCompare(stableRank(right)));
  const selected: SampleDocument[] = [];
  const imageIds = new Set<string>();
  for (const document of candidates) {
    const asset = selectEmbeddingImages(document, "thumbnail")[0];
    if (!asset || imageIds.has(asset.id)) continue;
    imageIds.add(asset.id);
    selected.push(document);
    if (selected.length === sampleSize) break;
  }
  if (selected.length < sampleSize) {
    throw new Error(
      `Only ${selected.length} unique image-bearing products were available`,
    );
  }

  const imageSource = new ImageSource();
  const inference = new InferenceClient();
  const results: Array<{
    id: string;
    material: string | null;
    color: string | null;
    caption: string | null;
    error: string | null;
    normalized: boolean;
  }> = [];

  for (const [index, document] of selected.entries()) {
    const asset = selectEmbeddingImages(document, "thumbnail")[0]!;
    try {
      const source = await imageSource.get(asset.url);
      const normalized = await normalizeCatalogImage(source);
      const [caption] = await inference.captions([normalized.buffer], "qwen");
      results.push({
        id: document.id,
        material: document.material,
        color: document.color,
        caption,
        error: null,
        normalized: normalized.normalized,
      });
      console.log(
        JSON.stringify({
          progress: `${index + 1}/${sampleSize}`,
          id: document.id,
          material: document.material,
          color: document.color,
          caption,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      results.push({
        id: document.id,
        material: document.material,
        color: document.color,
        caption: null,
        error: message,
        normalized: false,
      });
      console.log(
        JSON.stringify({
          progress: `${index + 1}/${sampleSize}`,
          id: document.id,
          material: document.material,
          color: document.color,
          error: message,
        }),
      );
    }
  }

  const captions = results.flatMap((result) =>
    result.caption ? [result.caption] : [],
  );
  const lengths = captions.map((caption) => caption.length);
  const applications =
    /\b(?:application|backsplash|countertop|flooring|may suit|suitable for|used for|wall cladding)\b/i;
  const imageOpening = /^(?:this|the) (?:image|photo|photograph|picture)\b/i;
  console.log(
    JSON.stringify({
      summary: {
        scope,
        indexUid: scopeUid,
        requested: sampleSize,
        succeeded: captions.length,
        failed: results.length - captions.length,
        startsWithImageReference: captions.filter((caption) =>
          imageOpening.test(caption),
        ).length,
        mentionsApplication: captions.filter((caption) =>
          applications.test(caption),
        ).length,
        lacksTerminalPunctuation: captions.filter(
          (caption) => !/[.!?]$/.test(caption),
        ).length,
        normalizedSourceImages: results.filter((result) => result.normalized)
          .length,
        captionCharacters: lengths.length
          ? {
              minimum: Math.min(...lengths),
              average: Math.round(
                lengths.reduce((sum, length) => sum + length, 0) /
                  lengths.length,
              ),
              maximum: Math.max(...lengths),
            }
          : null,
        errors: results.flatMap((result) =>
          result.error ? [{ id: result.id, error: result.error }] : [],
        ),
      },
    }),
  );
}

void main();
