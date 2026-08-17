import Link from "next/link";
import { notFound } from "next/navigation";
import type { GroupDetail } from "@samplehub/contracts";
const API = "http://127.0.0.1:8000/v1";
export default async function GroupPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params; const response = await fetch(`${API}/groups/${encodeURIComponent(groupId)}`, { cache: "no-store" }); if (response.status === 404) notFound(); if (!response.ok) throw new Error("Unable to load product group");
  const group = await response.json() as GroupDetail;
  return <main className="detail-page"><Link className="back" href="/">← Back to discovery</Link><p className="eyebrow">BRAND + SERIES</p><h1>{group.brand} <span>/ {group.series}</span></h1>
    <div className="model-list">{group.models.map((model, index) => <section className="model-section" key={`${model.model}-${index}`}><header><div><small>MODEL</small><h2>{model.model ?? "Unspecified model"}</h2></div><div className="model-stats"><span>{model.items.length} items</span><span>{model.areaTotal === null ? "Area —" : `${model.areaTotal.toLocaleString()} m²`}</span></div></header>
      <div className="item-grid">{model.items.map((item) => { const asset = item.images.find((image) => image.id === item.thumbnailId) ?? item.images[0]; return <article key={item.id}>{asset ? <img src={asset.thumbnailUrl ?? asset.url} alt="" loading="lazy" /> : <div className="image-placeholder" />}<div><strong>{item.item ?? item.color ?? "Exact product"}</strong><span>{item.material ?? "—"} · {item.surface ?? "—"}</span><small>{item.id}</small></div></article>; })}</div></section>)}</div></main>;
}
