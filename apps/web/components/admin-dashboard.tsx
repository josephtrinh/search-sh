"use client";
import { useEffect, useState, useTransition } from "react";
import type { IndexRunMode, IndexRunSummary, RankingConfig, VisualModel, VisualModelStatus } from "@samplehub/contracts";

const API = "/api";

export function AdminDashboard() {
  const [runs, setRuns] = useState<IndexRunSummary[]>([]);
  const [ranking, setRanking] = useState<RankingConfig | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [visual, setVisual] = useState<VisualModelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function refresh() {
    const [runsResponse, rankingResponse, healthResponse, visualResponse] = await Promise.all([
      fetch(`${API}/admin/index-runs`), fetch(`${API}/admin/ranking`), fetch(`${API}/health`), fetch(`${API}/admin/visual-model`),
    ]);
    setRuns(await runsResponse.json());
    setRanking(await rankingResponse.json());
    setHealth(await healthResponse.json());
    setVisual(await visualResponse.json());
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, []);

  async function start(mode: IndexRunMode) {
    setError(null);
    const response = await fetch(`${API}/admin/index-runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
    if (!response.ok) throw new Error((await response.json()).message ?? "Unable to start index operation");
    await refresh();
  }
  async function selectVisualModel(model: VisualModel) {
    setError(null);
    const response = await fetch(`${API}/admin/visual-model`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
    if (!response.ok) throw new Error((await response.json()).message ?? "Unable to switch visual model");
    setVisual(await response.json());
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
    <section className="panel index-panel"><div className="panel-heading"><div><p className="kicker">INDEX</p><h2>Catalog operations</h2></div><div className="button-pair"><button disabled={pending} onClick={() => perform(() => start("incremental"))}>Incremental</button><button disabled={pending} onClick={() => perform(() => start("visual_backfill"))}>Backfill DINOv2</button><button disabled={pending} className="primary" onClick={() => perform(() => start("full"))}>Full rebuild</button></div></div>
      {error ? <div className="notice error">{error}</div> : null}
      <div className="visual-switch"><div><strong>Active visual model</strong><small>DINOv2 disables the SigLIP text-to-image branch.</small></div><div className="button-pair"><button className={visual?.active === "siglip2" ? "active" : ""} disabled={pending} onClick={() => perform(() => selectVisualModel("siglip2"))}>SigLIP 2</button><button className={visual?.active === "dinov2" ? "active" : ""} disabled={pending || !visual?.dinov2Ready} title={visual?.dinov2Ready ? "Use DINOv2" : "Complete a successful DINOv2 backfill first"} onClick={() => perform(() => selectVisualModel("dinov2"))}>DINOv2{visual?.dinov2Ready ? "" : " · not ready"}</button></div></div>
      <div className="run-list">{runs.length ? runs.slice(0, 6).map((run) => <div className="run" key={run.id}><span className={`run-state ${run.status}`}>{run.status}</span><div><strong>{run.mode.replaceAll("_", " ")} index</strong><small>{run.mode === "visual_backfill" && run.status === "running" && run.processedProducts === 0 ? "Preparing existing Meilisearch vectors…" : <>{run.processedProducts.toLocaleString()} / {run.totalProducts.toLocaleString()} products · SigLIP {run.siglipEmbeddedImages.toLocaleString()} / {run.siglipFailedImages.toLocaleString()} failed · DINOv2 {run.dinov2EmbeddedImages.toLocaleString()} / {run.dinov2FailedImages.toLocaleString()} failed · {run.captionedImages.toLocaleString()} captions · {run.cachedCaptions.toLocaleString()} cached</>}</small></div><progress value={run.processedProducts} max={Math.max(run.totalProducts, 1)} /></div>) : <p>No indexing runs yet.</p>}</div></section>
    <section className="panel ranking-panel"><div className="panel-heading"><div><p className="kicker">RANKING</p><h2>Balanced preset</h2></div><button disabled={!ranking || pending} onClick={() => perform(saveRanking)}>Save weights</button></div>
      {ranking ? <div className="sliders">{Object.entries(ranking).filter(([key]) => key !== "version").map(([key, value]) => <label key={key}><span>{key.replace(/([A-Z])/g, " $1")}</span><input type="range" min="0" max="1" step="0.05" value={value} onChange={(event) => setRanking({ ...ranking, [key]: Number(event.target.value) } as RankingConfig)} /><output>{value.toFixed(2)}</output></label>)}</div> : <p>Loading ranking configuration…</p>}</section>
    <section className="panel eval-panel"><div className="panel-heading"><div><p className="kicker">RELEVANCE</p><h2>Judgment workspace</h2></div><span className="status-dot muted">nDCG@10</span></div><p>Create evaluation queries through the API, attach deliberate local image fixtures, and grade Brand+Series groups from 0–2. Reports use the globally selected visual model.</p><a href="/api-docs" target="_blank" rel="noreferrer">Open evaluator API →</a></section>
  </div>;
}
