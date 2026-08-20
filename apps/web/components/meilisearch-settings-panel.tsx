"use client";

import { useEffect, useMemo, useState } from "react";
import type { ManagedMeilisearchSettings, MeilisearchSettingsStatus } from "@samplehub/contracts";

const API = "/api";
type AttributeKey = "displayedAttributes" | "searchableAttributes" | "filterableAttributes" | "sortableAttributes";

const ATTRIBUTE_DETAILS: Record<AttributeKey, { title: string; summary: string; impact: string; indexWork: string; ordered?: boolean }> = {
  displayedAttributes: {
    title: "Displayed attributes",
    summary: "Fields returned by Meilisearch search responses. Required product fields are locked because result cards and detail pages consume them.",
    impact: "Removing optional fields reduces response payload size. This does not change keyword or vector accuracy.",
    indexWork: "Settings task only; no embedding regeneration or application rebuild.",
  },
  searchableAttributes: {
    title: "Searchable attributes",
    summary: "Fields scanned by keyword search. Earlier fields have greater importance in Meilisearch's attribute ranking.",
    impact: "Changes keyword, Text Hybrid, and Auto results. It does not alter existing E5 or visual vectors.",
    indexWork: "Meilisearch internally re-indexes documents. Search remains available; no full catalog rebuild is required.",
    ordered: true,
  },
  filterableAttributes: {
    title: "Filterable attributes",
    summary: "Fields allowed in filters and facet requests. Refine-sidebar and group lookup fields are locked.",
    impact: "Adding fields increases index storage and indexing work. Removing required fields would break filters, so it is blocked.",
    indexWork: "Meilisearch internally rebuilds filter data; no embedding regeneration is required.",
  },
  sortableAttributes: {
    title: "Sortable attributes",
    summary: "Fields Meilisearch permits in sort expressions.",
    impact: "The current frontend always uses relevance, so new fields have no visible effect until a matching sort control is added.",
    indexWork: "Meilisearch may rebuild sort data; no embedding regeneration is required.",
  },
};

function cloneSettings(settings: ManagedMeilisearchSettings): ManagedMeilisearchSettings {
  return structuredClone(settings);
}

function scopeLabel(scope: string): string {
  return scope.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function AttributeEditor({ settingKey, values, required, disabled, onChange }: {
  settingKey: AttributeKey;
  values: string[];
  required: readonly string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  const [candidate, setCandidate] = useState("");
  const details = ATTRIBUTE_DETAILS[settingKey];
  const requiredSet = useMemo(() => new Set(required), [required]);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  function add() {
    const value = candidate.trim();
    if (!value || values.includes(value) || !/^[A-Za-z0-9_.-]+$/.test(value)) return;
    onChange([...values, value]);
    setCandidate("");
  }

  return <section className="meili-setting-card">
    <header><div><h3>{details.title}</h3><p>{details.summary}</p></div><span className="restart-badge">Restart: none</span></header>
    <div className="setting-instructions"><p><strong>Impact</strong>{details.impact}</p><p><strong>Apply behavior</strong>{details.indexWork}</p></div>
    <ol className={`attribute-list${details.ordered ? " ordered" : ""}`}>
      {values.map((value, index) => <li key={value}>
        <code>{value}</code>
        {requiredSet.has(value) ? <span className="required-badge">Required</span> : null}
        <span className="attribute-actions">
          {details.ordered ? <><button type="button" aria-label={`Move ${value} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>↑</button><button type="button" aria-label={`Move ${value} down`} disabled={disabled || index === values.length - 1} onClick={() => move(index, 1)}>↓</button></> : null}
          <button type="button" aria-label={`Remove ${value}`} disabled={disabled || requiredSet.has(value)} onClick={() => onChange(values.filter((entry) => entry !== value))}>Remove</button>
        </span>
      </li>)}
    </ol>
    <div className="attribute-add"><input value={candidate} disabled={disabled} placeholder="Add a top-level field" aria-label={`Add ${details.title.toLowerCase()} field`} onChange={(event) => setCandidate(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} /><button type="button" disabled={disabled || !candidate.trim()} onClick={add}>Add</button></div>
  </section>;
}

function FacetingEditor({ settings, disabled, onChange }: { settings: ManagedMeilisearchSettings; disabled: boolean; onChange: (settings: ManagedMeilisearchSettings) => void }) {
  const [newOverride, setNewOverride] = useState("");
  const sort = settings.faceting.sortFacetValuesBy;
  const overrides = Object.entries(sort).filter(([field]) => field !== "*");
  const available = settings.filterableAttributes.filter((field) => !(field in sort));

  function setSort(field: string, value: "alpha" | "count") {
    onChange({ ...settings, faceting: { ...settings.faceting, sortFacetValuesBy: { ...sort, [field]: value } } });
  }

  return <section className="meili-setting-card compact-setting-card">
    <header><div><h3>Faceting</h3><p>Controls how many values each Refine group returns and whether values favor frequency or alphabetical order.</p></div><span className="restart-badge">Restart: none</span></header>
    <div className="setting-instructions"><p><strong>Impact</strong>Higher limits expose more filter values but increase facet computation and response size.</p><p><strong>Apply behavior</strong>Applies through a live settings task; no catalog or embedding rebuild.</p></div>
    <label className="number-setting"><span>Maximum values per facet<small>Current UI can scroll long lists, but only request as many values as testers need.</small></span><input type="number" min={1} max={10_000} disabled={disabled} value={settings.faceting.maxValuesPerFacet} onChange={(event) => onChange({ ...settings, faceting: { ...settings.faceting, maxValuesPerFacet: Number(event.target.value) } })} /></label>
    <div className="facet-sort-list">
      <label><span>Default facet order</span><select disabled={disabled} value={sort["*"] ?? "count"} onChange={(event) => setSort("*", event.target.value as "alpha" | "count")}><option value="count">Count (most common first)</option><option value="alpha">Alphabetical</option></select></label>
      {overrides.map(([field, value]) => <label key={field}><code>{field}</code><select disabled={disabled} value={value} onChange={(event) => setSort(field, event.target.value as "alpha" | "count")}><option value="count">Count</option><option value="alpha">Alphabetical</option></select><button type="button" disabled={disabled} onClick={() => { const next = { ...sort }; delete next[field]; onChange({ ...settings, faceting: { ...settings.faceting, sortFacetValuesBy: next } }); }}>Remove</button></label>)}
    </div>
    <div className="attribute-add"><select disabled={disabled || available.length === 0} value={newOverride} onChange={(event) => setNewOverride(event.target.value)}><option value="">Add field override…</option>{available.map((field) => <option key={field} value={field}>{field}</option>)}</select><button type="button" disabled={disabled || !newOverride} onClick={() => { setSort(newOverride, "count"); setNewOverride(""); }}>Add override</button></div>
  </section>;
}

export function MeilisearchSettingsPanel() {
  const [status, setStatus] = useState<MeilisearchSettingsStatus | null>(null);
  const [draft, setDraft] = useState<ManagedMeilisearchSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(preserveDraft = dirty) {
    const response = await fetch(`${API}/admin/meilisearch-settings`, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).message ?? "Unable to load Meilisearch settings");
    const next = await response.json() as MeilisearchSettingsStatus;
    setStatus(next);
    if (!preserveDraft) setDraft(cloneSettings(next.profile));
  }

  useEffect(() => {
    void refresh(false).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load Meilisearch settings"));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [dirty]);

  function change(next: ManagedMeilisearchSettings) {
    setDraft(next);
    setDirty(true);
  }

  async function perform(method: "PATCH" | "DELETE" | "POST", path = "") {
    if (!draft) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${API}/admin/meilisearch-settings${path}`, { method, headers: { "Content-Type": "application/json" }, body: method === "PATCH" ? JSON.stringify(draft) : undefined });
      if (!response.ok) throw new Error((await response.json()).message ?? "Unable to apply Meilisearch settings");
      const next = await response.json() as MeilisearchSettingsStatus;
      setStatus(next);
      setDraft(cloneSettings(next.profile));
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to apply Meilisearch settings");
    } finally {
      setPending(false);
    }
  }

  if (!status || !draft) return <section className="panel meili-panel"><p>Loading Meilisearch settings…</p>{error ? <div className="notice error">{error}</div> : null}</section>;
  const locked = pending || status.applying || status.indexingBusy;
  const outOfSync = status.indexes.some((index) => index.available && !index.inSync && index.taskStatus !== "enqueued" && index.taskStatus !== "processing");

  return <section className="panel meili-panel">
    <div className="panel-heading meili-panel-heading"><div><p className="kicker">MEILISEARCH</p><h2>Index settings</h2><p>One managed profile is applied to stable and every available preview. New rebuilds read this saved profile automatically.</p></div><div className="meili-actions"><button type="button" disabled={locked || !dirty} onClick={() => void perform("PATCH")}>Save and apply globally</button><button type="button" disabled={locked} onClick={() => { if (window.confirm("Restore the application default Meilisearch settings for every managed index?")) void perform("DELETE"); }}>Reset defaults</button>{outOfSync ? <button type="button" disabled={locked} onClick={() => void perform("POST", "/retry")}>Retry out-of-sync</button> : null}</div></div>
    {error ? <div className="notice error">{error}</div> : null}
    {status.indexingBusy ? <div className="notice">Settings are locked while an index build or backfill is active.</div> : null}
    {status.applying ? <div className="notice">Meilisearch is applying the profile. Structural changes can take time while internal index data is rebuilt; search services do not need to restart.</div> : null}

    <div className="meili-runtime"><span><strong>Server</strong>{status.environment.url}</span><span><strong>Version</strong>{status.environment.version ?? "unavailable"}</span><span><strong>Base index</strong>{status.environment.baseIndexUid}</span></div>
    <div className="meili-index-statuses">
      {status.indexes.map((index) => <article key={index.scope} className={!index.available ? "unavailable" : index.inSync ? "synced" : "drifted"}><header><strong>{scopeLabel(index.scope)}</strong><span>{!index.available ? "Not built" : index.taskStatus === "enqueued" || index.taskStatus === "processing" ? index.taskStatus : index.inSync ? "In sync" : "Out of sync"}</span></header><code>{index.uid}</code>{index.taskUid !== null ? <small>Task {index.taskUid}{index.taskStatus ? ` · ${index.taskStatus}` : ""}</small> : null}{index.error ? <small className="meili-task-error">{index.error}</small> : null}</article>)}
    </div>

    <div className="meili-settings-grid">
      {(["displayedAttributes", "searchableAttributes", "filterableAttributes", "sortableAttributes"] as const).map((settingKey) => <AttributeEditor key={settingKey} settingKey={settingKey} values={draft[settingKey]} required={status.required[settingKey]} disabled={locked} onChange={(values) => change({ ...draft, [settingKey]: values })} />)}
      <section className="meili-setting-card compact-setting-card">
        <header><div><h3>Pagination</h3><p>Limits how deeply a caller can page through ranked results.</p></div><span className="restart-badge">Restart: none</span></header>
        <div className="setting-instructions"><p><strong>Impact</strong>Higher values make more results reachable but can increase ranking latency. The frontend currently requests up to 48 results at a time.</p><p><strong>Apply behavior</strong>Applies through a live settings task; no catalog or embedding rebuild.</p></div>
        <label className="number-setting"><span>Maximum total hits<small>Keep this near the deepest result testers genuinely need. Allowed: 1–1,000,000.</small></span><input type="number" min={1} max={1_000_000} disabled={locked} value={draft.pagination.maxTotalHits} onChange={(event) => change({ ...draft, pagination: { maxTotalHits: Number(event.target.value) } })} /></label>
      </section>
      <FacetingEditor settings={draft} disabled={locked} onChange={change} />
    </div>

    <section className="managed-embedders"><header><div><h3>Managed embedders</h3><p>Read-only because names and dimensions must match vectors produced by inference.</p></div><span className="restart-badge">Managed by rebuild/backfill</span></header><div className="embedder-scopes">{status.indexes.map((index) => <article key={index.scope}><strong>{scopeLabel(index.scope)}</strong>{index.embedders.length ? <table><thead><tr><th>Name</th><th>Source</th><th>Dimensions</th></tr></thead><tbody>{index.embedders.map((embedder) => <tr key={embedder.name}><td><code>{embedder.name}</code></td><td>{embedder.source}</td><td>{embedder.dimensions?.toLocaleString() ?? "—"}</td></tr>)}</tbody></table> : <p>{index.available ? "No embedders configured" : "Index not built"}</p>}</article>)}</div><p className="embedder-instruction"><strong>To change these:</strong> update the matching model/dimension configuration, restart the affected inference and indexer processes, then use a full rebuild or the dedicated backfill. Editing an embedder definition alone would make stored vectors incompatible.</p></section>

    <aside className="meili-environment-note"><strong>Connection and server settings are intentionally read-only here.</strong><span>After changing <code>MEILI_URL</code> or <code>MEILI_INDEX_UID</code> in <code>.env</code>, restart API and indexer. If the master key or a Docker-level Meilisearch option changes, restart/recreate Meilisearch and restart API/indexer. None of the six editable index settings above require a service restart.</span></aside>
  </section>;
}
