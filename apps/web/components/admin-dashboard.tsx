"use client";
import { useEffect, useState, useTransition } from "react";
import type { IndexRunMode, IndexRunSummary, IndexScope, IndexScopeStatus, RankingConfig, VisualGeneration, VisualModel, VisualModelStatus } from "@samplehub/contracts";

const API = "/api";

function coverageSummary(run: IndexRunSummary): string {
  if (run.mode === "caption_backfill") return "not applicable";
  if (!run.visualEligibleProducts) return "pending";
  const percent = (covered: number) => `${Math.round(covered / run.visualEligibleProducts * 100)}%`;
  if (run.mode === "visual_backfill") return `DINOv2 ${percent(run.dinov2CoveredProducts)}`;
  if (run.mode === "dinov3_backfill") return `DINOv3 ${percent(run.dinov3CoveredProducts)}`;
  const values = [`SigLIP ${percent(run.siglipCoveredProducts)}`];
  if (run.mode === "full" || run.mode === "limited_full" || run.dinov2CoveredProducts) values.push(`DINOv2 ${percent(run.dinov2CoveredProducts)}`);
  if (run.mode === "full" || run.mode === "limited_full" || run.dinov3CoveredProducts) values.push(`DINOv3 ${percent(run.dinov3CoveredProducts)}`);
  return values.join(" · ");
}

export function AdminDashboard() {
  const [runs, setRuns] = useState<IndexRunSummary[]>([]);
  const [ranking, setRanking] = useState<RankingConfig | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [visual, setVisual] = useState<VisualModelStatus | null>(null);
  const [scope, setScope] = useState<IndexScopeStatus | null>(null);
  const [previewLimit, setPreviewLimit] = useState(10_000);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function refresh() {
    const [runsResponse, rankingResponse, healthResponse, visualResponse, scopeResponse] = await Promise.all([
      fetch(`${API}/admin/index-runs`), fetch(`${API}/admin/ranking`), fetch(`${API}/health`), fetch(`${API}/admin/visual-model`), fetch(`${API}/admin/index-scope`),
    ]);
    setRuns(await runsResponse.json());
    setRanking(await rankingResponse.json());
    setHealth(await healthResponse.json());
    setVisual(await visualResponse.json());
    setScope(await scopeResponse.json());
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, []);

  async function start(mode: IndexRunMode, generation?: VisualGeneration) {
    setError(null);
    const response = await fetch(`${API}/admin/index-runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, ...(mode === "limited_full" ? { generation, productLimit: previewLimit } : {}) }) });
    if (!response.ok) throw new Error((await response.json()).message ?? "Unable to start index operation");
    await refresh();
  }
  async function selectVisualModel(model: VisualModel) {
    setError(null);
    const response = await fetch(`${API}/admin/visual-model`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
    if (!response.ok) throw new Error((await response.json()).message ?? "Unable to switch visual model");
    setVisual(await response.json());
  }
  async function cancel(runId: string) {
    setError(null);
    const response = await fetch(`${API}/admin/index-runs/${runId}`, { method: "DELETE" });
    if (!response.ok) throw new Error((await response.json()).message ?? "Unable to cancel index operation");
    await refresh();
  }
  async function selectScope(nextScope: IndexScope) {
    const response = await fetch(`${API}/admin/index-scope`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: nextScope }) });
    if (!response.ok) throw new Error((await response.json()).message ?? "Unable to switch index scope");
    setScope(await response.json());
    await refresh();
  }
  async function saveRanking() {
    if (!ranking) return;
    await fetch(`${API}/admin/ranking`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ranking) });
    await refresh();
  }
  function perform(operation: () => Promise<void>) {
    startTransition(() => void operation().catch((cause) => setError(cause instanceof Error ? cause.message : "Operation failed")));
  }

  return <div className="admin-grid">
    <section className="panel system-panel"><div className="panel-heading"><div><p className="kicker">SYSTEM</p><h2>Runtime health</h2></div><span className="status-dot">LOCAL</span></div><pre>{health ? JSON.stringify(health, null, 2) : "Checking services…"}</pre></section>
    <section className="panel index-panel"><div className="panel-heading"><div><p className="kicker">INDEX</p><h2>Catalog operations</h2></div><div className="button-pair"><button disabled={pending} onClick={() => perform(() => start("incremental"))}>Incremental</button><button disabled={pending} onClick={() => perform(() => start("visual_backfill"))}>Backfill DINOv2</button><button disabled={pending} onClick={() => perform(() => start("dinov3_backfill"))}>Backfill DINOv3</button><button disabled={pending} onClick={() => perform(() => start("caption_backfill"))}>Backfill captions + E5</button><button disabled={pending} className="primary" onClick={() => perform(() => start("full"))}>Full rebuild</button></div></div>
      {error ? <div className="notice error">{error}</div> : null}
      <div className="visual-switch"><div><strong>Limited comparison indexes</strong><small>Build the same deterministic product sample in either generation. These runs never replace stable or advance incremental watermarks.</small></div><div className="button-pair"><label><small>Products</small><input type="number" min={1} max={25000} value={previewLimit} onChange={(event) => setPreviewLimit(Math.min(25000, Math.max(1, Number(event.target.value) || 1)))} /></label><button disabled={pending} onClick={() => perform(() => start("limited_full", "legacy"))}>Build legacy preview</button><button disabled={pending} onClick={() => perform(() => start("limited_full", "current"))}>Build current preview</button></div></div>
      <div className="visual-switch"><div><strong>Search index scope</strong><small>Active: {scope?.active.replaceAll("_", " ") ?? "loading"}. Stable is production-like; previews are isolated evaluator samples.</small>{scope?.previewLegacy.qualityWarning ? <small className="coverage-warning">Legacy: {scope.previewLegacy.qualityWarning}</small> : null}{scope?.previewCurrent.qualityWarning ? <small className="coverage-warning">Current: {scope.previewCurrent.qualityWarning}</small> : null}</div><div className="button-pair"><button className={scope?.active === "stable" ? "active" : ""} disabled={pending || !scope?.stable.available} onClick={() => perform(() => selectScope("stable"))}>Stable · {scope?.stable.count.toLocaleString() ?? 0}</button><button className={scope?.active === "preview_legacy" ? "active" : ""} disabled={pending || !scope?.previewLegacy.available} onClick={() => perform(() => selectScope("preview_legacy"))}>Legacy preview{scope?.previewLegacy.qualityWarning ? " ⚠" : ""} · {scope?.previewLegacy.count.toLocaleString() ?? 0}</button><button className={scope?.active === "preview_current" ? "active" : ""} disabled={pending || !scope?.previewCurrent.available} onClick={() => perform(() => selectScope("preview_current"))}>Current preview{scope?.previewCurrent.qualityWarning ? " ⚠" : ""} · {scope?.previewCurrent.count.toLocaleString() ?? 0}</button></div></div>
      <div className="visual-switch"><div><strong>Active visual model</strong><small>DINO models use image similarity and disable the SigLIP text-to-image branch.</small></div><div className="button-pair"><button className={visual?.active === "siglip2" ? "active" : ""} disabled={pending} onClick={() => perform(() => selectVisualModel("siglip2"))}>SigLIP 2</button><button className={visual?.active === "dinov2" ? "active" : ""} disabled={pending || !visual?.dinov2Ready} title={visual?.dinov2Ready ? "Use DINOv2" : "Complete a successful DINOv2 backfill first"} onClick={() => perform(() => selectVisualModel("dinov2"))}>DINOv2{visual?.dinov2Ready ? "" : " · not ready"}</button><button className={visual?.active === "dinov3" ? "active" : ""} disabled={pending || !visual?.dinov3Ready} title={visual?.dinov3Ready ? "Use DINOv3" : "Complete a successful DINOv3 backfill first"} onClick={() => perform(() => selectVisualModel("dinov3"))}>DINOv3{visual?.dinov3Ready ? "" : " · not ready"}</button></div></div>
      <div className="run-list">{runs.length ? runs.slice(0, 6).map((run) => <div className="run" key={run.id}><span className={`run-state ${run.status}`}>{run.status}</span><div><strong>{run.mode.replaceAll("_", " ")} index{run.visualGeneration ? ` · ${run.visualGeneration}` : ""}</strong><small>{run.mode === "caption_backfill" && run.status === "running" && run.processedProducts === 0 ? "Preparing Florence captions and E5 vectors…" : <>{run.processedProducts.toLocaleString()} / {run.totalProducts.toLocaleString()} products · coverage {coverageSummary(run)} · {run.normalizedImages.toLocaleString()} normalized · {run.rejectedSourceImages.toLocaleString()} rejected · {run.failedCaptions.toLocaleString()} caption failures</>}</small>{run.qualityWarning ? <small className="coverage-warning">{run.qualityWarning}</small> : null}</div><progress value={run.processedProducts} max={Math.max(run.totalProducts, 1)} />{["queued", "running", "cancelling"].includes(run.status) ? <button className="cancel-run" disabled={pending || run.status === "cancelling"} onClick={() => perform(() => cancel(run.id))}>{run.status === "cancelling" ? "Cancelling…" : "Cancel"}</button> : <span />}</div>) : <p>No indexing runs yet.</p>}</div></section>
    <section className="panel ranking-panel"><div className="panel-heading"><div><p className="kicker">RANKING</p><h2>Balanced preset</h2></div><button disabled={!ranking || pending} onClick={() => perform(saveRanking)}>Save weights</button></div>
      {ranking ? <div className="sliders">{Object.entries(ranking).filter(([key]) => key !== "version").map(([key, value]) => <label key={key}><span>{key.replace(/([A-Z])/g, " $1")}</span><input type="range" min="0" max="1" step="0.05" value={value} onChange={(event) => setRanking({ ...ranking, [key]: Number(event.target.value) } as RankingConfig)} /><output>{value.toFixed(2)}</output></label>)}</div> : <p>Loading ranking configuration…</p>}</section>
    <section className="panel eval-panel"><div className="panel-heading"><div><p className="kicker">RELEVANCE</p><h2>Judgment workspace</h2></div><span className="status-dot muted">nDCG@10</span></div><p>Create evaluation queries through the API, attach deliberate local image fixtures, and grade Brand+Series groups from 0–2. Reports use the globally selected visual model.</p><a href="/api-docs" target="_blank" rel="noreferrer">Open evaluator API →</a></section>
  </div>;
}
