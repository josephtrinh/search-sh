"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { facetKeys, type FacetKey, type SearchResponse, type VisualModel, type VisualModelStatus } from "@samplehub/contracts";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000/v1";
const LABELS: Record<FacetKey, string> = { category: "Category", material: "Material", color: "Colour", origin: "Origin", effect: "Effect", brand: "Brand", series: "Series", model: "Model", surface: "Surface", edge: "Edge", sizeGroup: "Size group", waterAbsorption: "Water absorption", fireResistance: "Fire resistance", price: "Price", availability: "Availability" };
const MATCH_LABEL = { keyword: "Keyword match", semantic: "Semantic match", visual_text: "Visual-text match", image: "Image match" } as const;

export function SearchWorkbench() {
  const [query, setQuery] = useState(""); const [image, setImage] = useState<File | null>(null); const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null); const [error, setError] = useState<string | null>(null); const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [mode, setMode] = useState("auto"); const [visualModel, setVisualModel] = useState<VisualModel>("siglip2"); const [pending, startTransition] = useTransition(); const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { void fetch(`${API}/admin/visual-model`).then((response) => response.ok ? response.json() as Promise<VisualModelStatus> : null).then((status) => { if (status) { setVisualModel(status.active); if (status.active === "dinov2") setMode((current) => current === "text_visual" ? "auto" : current); } }).catch(() => undefined); }, []);
  function selectImage(file: File | null) { if (preview) URL.revokeObjectURL(preview); setImage(file); setPreview(file ? URL.createObjectURL(file) : null); }
  async function run(cursor?: string) {
    setError(null); const form = new FormData(); if (query.trim()) form.set("query", query.trim()); if (image) form.set("image", image); form.set("mode", mode);
    form.set("filters", JSON.stringify(selected)); form.set("limit", "24"); if (cursor) form.set("cursor", cursor);
    try { const response = await fetch(`${API}/search`, { method: "POST", body: form }); if (!response.ok) throw new Error((await response.json()).message ?? "Search failed");
      const next = await response.json() as SearchResponse; setVisualModel(next.visualModel); setResult((previous) => {
        if (!cursor || !previous) return next;
        const hits = [...previous.hits, ...next.hits].filter((hit, index, all) => all.findIndex((candidate) => candidate.groupId === hit.groupId) === index);
        return { ...next, hits };
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Search failed"); }
  }
  function submit(event: React.FormEvent) { event.preventDefault(); startTransition(() => void run()); }
  function toggle(key: string, value: string) { setSelected((current) => { const values = current[key] ?? []; return { ...current, [key]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] }; }); }
  const facets = (result?.facets ?? facetKeys.map((key) => ({ key, values: [], enabled: false }))).filter((facet) => facet.enabled);
  return <section className="workbench">
    <form className="query-panel" onSubmit={submit}>
      <div className="query-main"><label htmlFor="query">Search the library</label><div className="search-row"><input id="query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. warm ivory stone with a quiet grain" />
        <button className="primary" disabled={pending || (!query.trim() && !image)}>{pending ? "Searching…" : "Search"}</button></div>
        <div className="mode-row"><span>Ranking</span>{["auto","keyword","text_hybrid","text_visual","image_visual"].map((value) => { const disabled = visualModel === "dinov2" && value === "text_visual"; return <button type="button" disabled={disabled} title={disabled ? "Text Visual requires SigLIP 2" : undefined} onClick={() => setMode(value)} className={mode === value ? "chip active" : "chip"} key={value}>{value.replaceAll("_", " ")}</button>; })}<span className="visual-model-label">Visual: {visualModel === "dinov2" ? "DINOv2" : "SigLIP 2"}</span></div></div>
      <button type="button" className={preview ? "image-drop has-image" : "image-drop"} onClick={() => inputRef.current?.click()}>
        {preview ? <img src={preview} alt="Selected search reference" /> : <><span className="upload-icon">＋</span><strong>Add a reference image</strong><small>JPEG, PNG or WebP · 10 MB max</small></>}
      </button><input ref={inputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => selectImage(event.target.files?.[0] ?? null)} />
    </form>
    {error ? <div className="notice error">{error}</div> : null}
    <div className="results-layout"><aside className="facets"><div className="aside-title"><strong>Refine</strong><button onClick={() => setSelected({})}>Clear</button></div>
      {facets.map((facet) => <details key={facet.key} open={facet.enabled && ["material","color","brand"].includes(facet.key)} className={!facet.enabled ? "disabled" : ""}><summary>{LABELS[facet.key]}</summary>
        {facet.enabled ? <div className="facet-values">{facet.values.slice(0, 12).map(({ value, count }) => <label key={value}><input type="checkbox" checked={(selected[facet.key] ?? []).includes(value)} onChange={() => toggle(facet.key, value)} /><span>{value}</span><small>{count}</small></label>)}</div> : <p>No indexed values</p>}</details>)}</aside>
      <div className="result-region"><div className="result-meta"><div><strong>{result ? `${result.hits.length} groups shown` : "Ready to explore"}</strong><span>{result ? `${result.estimatedProductHits.toLocaleString()} matching exact products` : "Use text, an image, or both"}</span></div>
        {result ? <span className="latency">{Math.round(result.processingTimeMs)} ms</span> : null}</div>
        {!result ? <div className="empty"><span>◫</span><h2>Your material board starts here</h2><p>Results are grouped by Brand + Series. The strongest matching exact product becomes each card.</p></div> : result.hits.length === 0 ? <div className="empty"><h2>No matching groups</h2><p>Try removing a filter or describing a broader visual quality.</p></div> : <div className="card-grid">{result.hits.map((hit) => {
          const product = hit.representative; const asset = product.images.find((item) => item.id === product.thumbnailId) ?? product.images[0];
          return <Link className="product-card" href={`/groups/${hit.groupId}`} key={hit.groupId}><div className="card-image">{asset ? <img src={asset.thumbnailUrl ?? asset.url} alt={`${hit.brand} ${hit.series}`} loading="lazy" /> : <span>No image</span>}<span className="source-pill">{MATCH_LABEL[hit.primaryMatchSource]}</span></div>
            <div className="card-copy"><p>{hit.brand}</p><h3>{hit.series}</h3><div className="attributes"><span>{product.material ?? "Material —"}</span><span>{product.surface ?? "Surface —"}</span></div><small>Representative: {product.model ?? product.item ?? "Unspecified model"}</small></div></Link>;
        })}</div>}
        {result?.nextCursor ? <button className="load-more" disabled={pending} onClick={() => startTransition(() => void run(result.nextCursor!))}>Load more groups</button> : null}
      </div></div>
  </section>;
}
