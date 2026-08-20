import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { createGroupId, normalizeGroupPart } from "@samplehub/catalog";
import type { ImageAsset, ProductDocument } from "@samplehub/contracts";
import { config } from "./config";

interface RawProduct extends RowDataPacket {
  id: string; brand: string; series: string; name: string | null; sku: string | null; model: string | null; item: string | null;
  material: string | null; color: string | null; origin: string | null; effect: string | null; surface: string | null; edge: string | null;
  sizeGroup: string | null; waterAbsorption: string | null; fireResistance: string | null; description: string | null;
  remarks: string | null; width: number | null; height: number | null; length: number | null; depth: number | null;
  area: string | number | null; updatedAt: Date; thumbnailId: string | null; imageIds: string | null;
  antiBacterial: string | null; applicationArea1: string | null; applicationArea2: string | null; shadeVariation: string | null;
  evaSuitable: string | null; sri: string | null; slipResistance: string | null; chemicalResistance: string | null; stainResistance: string | null;
  unit: string | null; pcsBox: string | null; m2Box: string | null; kgBox: string | null; m2Plt: string | null;
  boxPlt: string | null; kgsPlt: string | null; palletWeight: string | null; palletWidth: string | null; palletDepth: string | null;
  palletHeight: string | null; pattern: string | null; surfaceDensity: string | null; environmental: string | null;
  nrc: string[] | string | null; saa: string[] | string | null; alphaWMh: string[] | string | null; soundAbsorptionClass: string[] | string | null;
  coreMaterial: string | null; ixpe: string | null; vocs: string | null; wearLayer: string | null; outdoorIndoor: string | null; maintenance: string | null;
}
interface RawImage extends RowDataPacket { id: string; path: string; thumbnail: string | null; mime: string | null; productId: string; }

const PRODUCT_SELECT = `SELECT p.id, p.brand_name brand, p.series, p.name, p.sku, p.model, p.item,
  p.material, p.color, p.origin, p.effect, p.surface, p.edge,
  p.size_group sizeGroup, p.water_absorption waterAbsorption, p.fire_resistance fireResistance,
  p.description, p.remarks, p.width, p.height, p.length, p.depth, p.area,
  p.anti_bacterial antiBacterial, p.application_area1 applicationArea1, p.application_area2 applicationArea2,
  p.shade_variation shadeVariation, p.eva_suitable evaSuitable, p.sri, p.slip_resistance slipResistance,
  p.chemical_resistance chemicalResistance, p.stain_resistance stainResistance, p.unit,
  p.pcs_box pcsBox, p.m2_box m2Box, p.kg_box kgBox, p.m2_plt m2Plt, p.box_plt boxPlt, p.kgs_plt kgsPlt,
  p.pallet_weight palletWeight, p.pallet_width palletWidth, p.pallet_depth palletDepth, p.pallet_height palletHeight,
  p.pattern, p.surface_density surfaceDensity, p.environmental, p.nrc, p.saa, p.alpha_w_mh alphaWMh,
  p.sound_absorption_class soundAbsorptionClass, p.core_material coreMaterial, p.ixpe, p.vocs, p.wear_layer wearLayer,
  p.outdoor_indoor outdoorIndoor, p.maintenance,
  p.updated_at updatedAt, p.thumbnail_id thumbnailId, p.image_ids imageIds
  FROM products p`;
const ELIGIBLE = `p.deleted_at IS NULL AND COALESCE(p.is_private,0)=0 AND p.type='plan_product'`;

export class CatalogRepository {
  private readonly pool: Pool = createPool({ host: config.DATABASE_HOST, port: config.DATABASE_PORT, user: config.DATABASE_USERNAME,
    password: config.DATABASE_PASSWORD, database: config.DATABASE_NAME, connectionLimit: 3, timezone: "Z", decimalNumbers: true });
  async close() { await this.pool.end(); }
  async count(): Promise<number> { const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT COUNT(*) total FROM products p WHERE ${ELIGIBLE}`); return Number(rows[0]!.total); }
  async batch(afterId: string | null, limit: number): Promise<ProductDocument[]> {
    const [rows] = await this.pool.query<RawProduct[]>(`${PRODUCT_SELECT} WHERE ${ELIGIBLE} ${afterId ? "AND p.id > ?" : ""} ORDER BY p.id LIMIT ?`, afterId ? [afterId, limit] : [limit]);
    return this.hydrate(rows);
  }
  async byIds(ids: string[]): Promise<ProductDocument[]> {
    if (!ids.length) return [];
    const [rows] = await this.pool.query<RawProduct[]>(`${PRODUCT_SELECT} WHERE ${ELIGIBLE} AND p.id IN (?)`, [ids]);
    return this.hydrate(rows);
  }
  async deterministicSampleIds(limit: number): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.id FROM products p WHERE ${ELIGIBLE} ORDER BY SHA2(CONCAT('samplehub-visual-preview-v1:', p.id), 256), p.id LIMIT ?`,
      [limit],
    );
    return rows.map((row) => String(row.id));
  }
  async changedProductIds(productWatermark: string, fileWatermark: string): Promise<{ ids: string[]; productMax: string; fileMax: string }> {
    const [products] = await this.pool.query<RowDataPacket[]>("SELECT id, updated_at FROM products WHERE updated_at > ? ORDER BY updated_at,id", [productWatermark]);
    const [files] = await this.pool.query<RowDataPacket[]>("SELECT product_img_id id, updated_at FROM files WHERE product_img_id IS NOT NULL AND updated_at > ? ORDER BY updated_at,id", [fileWatermark]);
    const ids = [...new Set([...products, ...files].map((row) => String(row.id)))];
    return { ids, productMax: products.length ? new Date(products.at(-1)!.updated_at).toISOString() : productWatermark,
      fileMax: files.length ? new Date(files.at(-1)!.updated_at).toISOString() : fileWatermark };
  }
  private async hydrate(rows: RawProduct[]): Promise<ProductDocument[]> {
    if (!rows.length) return [];
    const [imageRows] = await this.pool.query<RawImage[]>(`SELECT id,path,thumbnail,mime,product_img_id productId FROM files
      WHERE product_img_id IN (?) AND deleted_at IS NULL AND is_archive=0`, [rows.map((row) => row.id)]);
    const imagesByProduct = new Map<string, RawImage[]>();
    for (const image of imageRows) imagesByProduct.set(image.productId, [...(imagesByProduct.get(image.productId) ?? []), image]);
    return rows.map((row) => {
      const order = new Map((row.imageIds ?? "").split(",").filter(Boolean).map((id, index) => [id, index]));
      const images: ImageAsset[] = (imagesByProduct.get(row.id) ?? []).sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9)).map((image) => ({
        id: image.id, url: this.publicUrl(image.path), thumbnailUrl: image.thumbnail ? this.publicUrl(image.thumbnail) : null, mime: image.mime,
      }));
      return {
        id: row.id, groupId: createGroupId(row.series, row.brand), brand: row.brand, normalizedBrand: normalizeGroupPart(row.brand),
        series: row.series, normalizedSeries: normalizeGroupPart(row.series), name: row.name, sku: row.sku, model: row.model, item: row.item,
        material: row.material, color: row.color, origin: row.origin, effect: row.effect, surface: row.surface,
        edge: row.edge, sizeGroup: row.sizeGroup, waterAbsorption: row.waterAbsorption, fireResistance: row.fireResistance,
        description: row.description, remarks: row.remarks,
        width: row.width, height: row.height, length: row.length, depth: row.depth, area: row.area === null ? null : Number(row.area),
        updatedAt: new Date(row.updatedAt).toISOString(), thumbnailId: row.thumbnailId, images,
        attributes: {
          "Anti-bacterial": row.antiBacterial, "Application area 1": row.applicationArea1, "Application area 2": row.applicationArea2,
          "Shade variation": row.shadeVariation, "EVA suitable": row.evaSuitable, SRI: row.sri, "Slip resistance": row.slipResistance,
          "Chemical resistance": row.chemicalResistance, "Stain resistance": row.stainResistance, Unit: row.unit,
          "Pieces per box": row.pcsBox, "m² per box": row.m2Box, "kg per box": row.kgBox, "m² per pallet": row.m2Plt,
          "Boxes per pallet": row.boxPlt, "kg per pallet": row.kgsPlt, "Pallet weight": row.palletWeight,
          "Pallet width": row.palletWidth, "Pallet depth": row.palletDepth, "Pallet height": row.palletHeight,
          Pattern: row.pattern, "Surface density": row.surfaceDensity, Environmental: row.environmental,
          NRC: jsonList(row.nrc), SAA: jsonList(row.saa), "Alpha W/MH": jsonList(row.alphaWMh),
          "Sound absorption class": jsonList(row.soundAbsorptionClass), "Core material": row.coreMaterial,
          IXPE: row.ixpe, VOCs: row.vocs, "Wear layer": row.wearLayer, "Outdoor/indoor": row.outdoorIndoor, Maintenance: row.maintenance,
        },
      };
    });
  }
  private publicUrl(key: string): string { return `${config.AWS_BUCKET_URL.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`; }
}

function jsonList(value: string[] | string | null): string[] | null {
  if (value === null || Array.isArray(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [value];
  }
}
