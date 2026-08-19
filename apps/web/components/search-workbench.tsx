"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  facetKeys,
  type FacetKey,
  type SearchResponse,
  type VisualModel,
  type VisualModelStatus,
} from "@samplehub/contracts";
import {
  ImageCropDropzone,
  cropImageFile,
  type ImageCrop,
} from "@/components/image-crop-dropzone";

const API = "/api";
const AUTO_SEARCH_DELAY_MS = 1100;
const LABELS: Record<FacetKey, string> = {
  category: "Category",
  material: "Material",
  color: "Colour",
  origin: "Origin",
  effect: "Effect",
  brand: "Brand",
  series: "Series",
  model: "Model",
  surface: "Surface",
  edge: "Edge",
  sizeGroup: "Size group",
  waterAbsorption: "Water absorption",
  fireResistance: "Fire resistance",
  price: "Price",
  availability: "Availability",
};
const MATCH_LABEL = {
  keyword: "Keyword match",
  semantic: "Semantic match",
  visual_text: "Visual-text match",
  image: "Image match",
} as const;

type Filters = Record<string, string[]>;
type SearchSnapshot = {
  query: string;
  filters: Filters;
  mode: string;
  image: File | null;
  crop: ImageCrop | null;
};

export function SearchWorkbench() {
  const [query, setQuery] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [crop, setCrop] = useState<ImageCrop | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Filters>({});
  const [mode, setMode] = useState("auto");
  const [visualModel, setVisualModel] = useState<VisualModel>("siglip2");
  const [visualStatus, setVisualStatus] = useState<VisualModelStatus | null>(
    null,
  );
  const [switchingModel, setSwitchingModel] = useState(false);
  const [searchPanelStuck, setSearchPanelStuck] = useState(false);
  const [searching, setSearching] = useState(false);
  const requestRef = useRef(0);
  const queryPanelRef = useRef<HTMLFormElement>(null);
  const autoSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestStateRef = useRef<SearchSnapshot>({
    query,
    filters: selected,
    mode,
    image,
    crop,
  });
  latestStateRef.current = { query, filters: selected, mode, image, crop };

  useEffect(() => {
    void fetch(`${API}/admin/visual-model`)
      .then((response) =>
        response.ok ? (response.json() as Promise<VisualModelStatus>) : null,
      )
      .then((status) => {
        if (!status) return;
        setVisualStatus(status);
        setVisualModel(status.active);
        if (status.active !== "siglip2")
          setMode((current) => (current === "text_visual" ? "auto" : current));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!image) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(
    () => () => {
      if (autoSearchTimerRef.current) clearTimeout(autoSearchTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const updateStickyState = () => {
      const panel = queryPanelRef.current;
      const compactLayout = window.matchMedia("(max-width: 1000px)").matches;
      setSearchPanelStuck(
        Boolean(
          panel && !compactLayout && panel.getBoundingClientRect().top <= 10,
        ),
      );
    };

    updateStickyState();
    window.addEventListener("scroll", updateStickyState, { passive: true });
    window.addEventListener("resize", updateStickyState);
    return () => {
      window.removeEventListener("scroll", updateStickyState);
      window.removeEventListener("resize", updateStickyState);
    };
  }, []);

  function cancelAutoSearch() {
    if (!autoSearchTimerRef.current) return;
    clearTimeout(autoSearchTimerRef.current);
    autoSearchTimerRef.current = null;
  }

  async function run({
    cursor,
    snapshot = latestStateRef.current,
  }: {
    cursor?: string;
    snapshot?: SearchSnapshot;
  } = {}) {
    if (snapshot.image && !snapshot.crop) return;
    if (!snapshot.query.trim() && !snapshot.image) {
      setResult(null);
      return;
    }

    const requestId = ++requestRef.current;
    setSearching(true);
    setError(null);

    try {
      const form = new FormData();
      if (snapshot.query.trim()) form.set("query", snapshot.query.trim());
      if (snapshot.image && snapshot.crop) {
        const croppedImage = await cropImageFile(snapshot.image, snapshot.crop);
        if (requestId !== requestRef.current) return;
        form.set("image", croppedImage);
      }
      form.set("mode", snapshot.mode);
      form.set("filters", JSON.stringify(snapshot.filters));
      form.set("limit", "24");
      if (cursor) form.set("cursor", cursor);

      const response = await fetch(`${API}/search`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string | string[];
        } | null;
        const message = Array.isArray(body?.message)
          ? body.message.join(", ")
          : body?.message;
        throw new Error(message ?? "Search failed");
      }

      const next = (await response.json()) as SearchResponse;
      if (requestId !== requestRef.current) return;
      setVisualModel(next.visualModel);
      setVisualStatus((current) =>
        current ? { ...current, active: next.visualModel } : current,
      );
      setResult((previous) => {
        if (!cursor || !previous) return next;
        const hits = [...previous.hits, ...next.hits].filter(
          (hit, index, all) =>
            all.findIndex((candidate) => candidate.groupId === hit.groupId) ===
            index,
        );
        return { ...next, hits };
      });
    } catch (cause) {
      if (requestId === requestRef.current)
        setError(cause instanceof Error ? cause.message : "Search failed");
    } finally {
      if (requestId === requestRef.current) setSearching(false);
    }
  }

  function scheduleCropSearch(sourceImage: File, nextCrop: ImageCrop) {
    cancelAutoSearch();
    autoSearchTimerRef.current = setTimeout(() => {
      autoSearchTimerRef.current = null;
      const latest = latestStateRef.current;
      if (latest.image !== sourceImage) return;
      void run({ snapshot: { ...latest, image: sourceImage, crop: nextCrop } });
    }, AUTO_SEARCH_DELAY_MS);
  }

  function selectImage(file: File) {
    cancelAutoSearch();
    requestRef.current += 1;
    setSearching(false);
    setError(null);
    setCrop(null);
    setImage(file);
  }

  function removeImage() {
    const latest = latestStateRef.current;
    cancelAutoSearch();
    requestRef.current += 1;
    setSearching(false);
    setError(null);
    setCrop(null);
    setImage(null);
    if (latest.query.trim()) {
      void run({ snapshot: { ...latest, image: null, crop: null } });
    } else {
      setResult(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    cancelAutoSearch();
    void run();
  }

  async function selectVisualModel(model: VisualModel) {
    if (model === visualModel || switchingModel) return;
    cancelAutoSearch();
    requestRef.current += 1;
    setSearching(false);
    setSwitchingModel(true);
    setError(null);
    try {
      const response = await fetch(`${API}/admin/visual-model`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string | string[];
        } | null;
        const message = Array.isArray(body?.message)
          ? body.message.join(", ")
          : body?.message;
        throw new Error(message ?? "Unable to switch visual model");
      }
      const status = (await response.json()) as VisualModelStatus;
      const nextMode =
        status.active === "siglip2" || mode !== "text_visual" ? mode : "auto";
      setVisualStatus(status);
      setVisualModel(status.active);
      setMode(nextMode);
      if (result) {
        await run({ snapshot: { ...latestStateRef.current, mode: nextMode } });
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to switch visual model",
      );
    } finally {
      setSwitchingModel(false);
    }
  }

  function toggle(key: string, value: string) {
    const values = selected[key] ?? [];
    const nextValues = values.includes(value)
      ? values.filter((item) => item !== value)
      : [...values, value];
    const next = { ...selected, [key]: nextValues };
    if (nextValues.length === 0) delete next[key];
    setSelected(next);
    cancelAutoSearch();
    if (result)
      void run({ snapshot: { ...latestStateRef.current, filters: next } });
  }

  const hasSelectedFilters = Object.values(selected).some(
    (values) => values.length > 0,
  );

  function clearFilters() {
    if (!hasSelectedFilters) return;
    setSelected({});
    cancelAutoSearch();
    if (result)
      void run({ snapshot: { ...latestStateRef.current, filters: {} } });
  }

  const facets = (
    result?.facets ??
    facetKeys.map((key) => ({ key, values: [], enabled: false }))
  ).filter((facet) => facet.enabled);
  const imageWaitingForCrop = Boolean(image && !crop);

  return (
    <section className="workbench">
      <form
        ref={queryPanelRef}
        className={`query-panel${image ? " has-reference" : ""}${searchPanelStuck ? " is-stuck" : ""}`}
        onSubmit={submit}
      >
        <div className="query-main">
          <label htmlFor="query">Search the library</label>
          <div className="search-row">
            <input
              id="query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. warm ivory stone with a quiet grain"
            />
            <button
              className="primary"
              disabled={
                searching || imageWaitingForCrop || (!query.trim() && !image)
              }
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
          <div className="mode-row">
            <span>Ranking</span>
            {[
              "auto",
              "keyword",
              "text_hybrid",
              "text_visual",
              "image_visual",
            ].map((value) => {
              const disabled =
                visualModel !== "siglip2" && value === "text_visual";
              return (
                <button
                  type="button"
                  disabled={disabled}
                  title={disabled ? "Text Visual requires SigLIP 2" : undefined}
                  onClick={() => setMode(value)}
                  className={mode === value ? "chip active" : "chip"}
                  key={value}
                >
                  {value.replaceAll("_", " ")}
                </button>
              );
            })}
            <div
              className="model-switch"
              role="group"
              aria-label="Active visual model"
            >
              <span>Visual</span>
              {(["siglip2", "dinov2", "dinov3"] as const).map((model) => {
                const ready =
                  model === "siglip2" ||
                  (model === "dinov2"
                    ? visualStatus?.dinov2Ready
                    : visualStatus?.dinov3Ready);
                const label =
                  model === "siglip2"
                    ? "SigLIP 2"
                    : model === "dinov2"
                      ? "DINOv2"
                      : "DINOv3";
                return (
                  <button
                    type="button"
                    className={
                      visualModel === model
                        ? "model-option active"
                        : "model-option"
                    }
                    aria-pressed={visualModel === model}
                    disabled={switchingModel || !ready}
                    title={
                      ready
                        ? `Use ${label}`
                        : `${label} is not ready for this index`
                    }
                    onClick={() => void selectVisualModel(model)}
                    key={model}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <ImageCropDropzone
          file={image}
          preview={preview}
          onFileSelected={selectImage}
          onRemove={removeImage}
          onCropInteractionStart={cancelAutoSearch}
          onCropChange={(nextCrop) => {
            setCrop(nextCrop);
            if (image) scheduleCropSearch(image, nextCrop);
          }}
          onValidationError={setError}
        />
      </form>
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="results-layout">
        <aside className="facets">
          <div className="aside-title">
            <strong>Refine</strong>
            <button
              type="button"
              disabled={!hasSelectedFilters}
              onClick={clearFilters}
            >
              Clear
            </button>
          </div>
          {facets.map((facet) => (
            <details
              key={facet.key}
              open={
                facet.enabled &&
                ["material", "color", "brand"].includes(facet.key)
              }
              className={!facet.enabled ? "disabled" : ""}
            >
              <summary>{LABELS[facet.key]}</summary>
              {facet.enabled ? (
                <div className="facet-values">
                  {facet.values.slice(0, 12).map(({ value, count }) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={(selected[facet.key] ?? []).includes(value)}
                        onChange={() => toggle(facet.key, value)}
                      />
                      <span>{value}</span>
                      <small>{count}</small>
                    </label>
                  ))}
                </div>
              ) : (
                <p>No indexed values</p>
              )}
            </details>
          ))}
        </aside>
        <div className="result-region">
          <div className="result-meta">
            <div>
              <strong>
                {result
                  ? `${result.hits.length} groups shown`
                  : "Ready to explore"}
              </strong>
              <span>
                {result
                  ? `${result.estimatedProductHits.toLocaleString()} matching exact products`
                  : "Use text, an image, or both"}
              </span>
            </div>
            {result ? (
              <span className="latency">
                {Math.round(result.processingTimeMs)} ms
              </span>
            ) : null}
          </div>
          {!result ? (
            <div className="empty">
              <span>◫</span>
              <h2>Your material board starts here</h2>
              <p>
                Results are grouped by Brand + Series. The strongest matching
                exact product becomes each card.
              </p>
            </div>
          ) : result.hits.length === 0 ? (
            <div className="empty">
              <h2>No matching groups</h2>
              <p>
                Try removing a filter or describing a broader visual quality.
              </p>
            </div>
          ) : (
            <div className="card-grid">
              {result.hits.map((hit) => {
                const product = hit.representative;
                const asset =
                  product.images.find(
                    (item) => item.id === product.thumbnailId,
                  ) ?? product.images[0];
                return (
                  <Link
                    className="product-card"
                    href={`/groups/${hit.groupId}`}
                    key={hit.groupId}
                  >
                    <div className="card-image">
                      {asset ? (
                        <img
                          src={asset.thumbnailUrl ?? asset.url}
                          alt={`${hit.brand} ${hit.series}`}
                          loading="lazy"
                        />
                      ) : (
                        <span>No image</span>
                      )}
                      <span className="source-pill">
                        {MATCH_LABEL[hit.primaryMatchSource]}
                      </span>
                    </div>
                    <div className="card-copy">
                      <p>{hit.brand}</p>
                      <h3>{hit.series}</h3>
                      <div className="attributes">
                        <span>{product.material ?? "Material —"}</span>
                        <span>{product.surface ?? "Surface —"}</span>
                      </div>
                      <small>
                        Representative:{" "}
                        {product.model ?? product.item ?? "Unspecified model"}
                      </small>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
          {result?.nextCursor ? (
            <button
              className="load-more"
              disabled={searching}
              onClick={() => void run({ cursor: result.nextCursor! })}
            >
              Load more groups
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
