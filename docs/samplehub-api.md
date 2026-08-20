# SampleHub source mapping

The indexer connects directly to the existing SampleHub MySQL and S3 sources using read-only credentials. This file records the integration boundary; it is not a proposal to modify SampleHub.

Florence/Qwen captions, caption provenance, E5 passages, and all vectors are search-owned derived data. They are stored only in local SQLite and Meilisearch. They never update `products.description` or any other SampleHub field.

## Selection

- Table: `products` (`p`)
- Eligible: `p.deleted_at IS NULL`, `COALESCE(p.is_private, 0) = 0`, `p.type = 'plan_product'`
- Images: `files.product_img_id`, excluding deleted and archived files
- Image order: IDs in `products.image_ids`; unlisted images sort last
- Incremental streams: `products.updated_at` and `files.updated_at`

## Public fields

Core identity and discovery fields include brand, series, name, SKU, model, item, material, color, origin, effect, surface, edge, size group, water absorption, fire resistance, description, remarks, dimensions, area, timestamps, and image metadata.

The `attributes` object includes public technical and packaging specifications: anti-bacterial, application areas, shade variation, EVA suitability, SRI, slip/chemical/stain resistance, unit, box/pallet quantities and dimensions, pattern, surface density, environmental, NRC, SAA, Alpha W/MH, sound absorption class, core material, IXPE, VOCs, wear layer, outdoor/indoor, and maintenance.

## Explicit exclusions

- private, deleted, or non-`plan_product` rows
- `unit_rate` and `discount`
- category and bilingual category labels, `detail`, RRP/price, status/availability, and lead time
- `internal_note` and other administrative notes
- supplier, organization, author, plan, and folder ownership identifiers
- access-control and admin-creation fields
- S3 credentials or private object metadata

The search document intentionally omits category labels, detail, RRP/price, status/availability, and lead time because the current catalog does not supply useful search data for those fields. Image URLs use the configured public bucket base; binary reads for embedding use the read-only S3 API.

`products.thumbnail_id` selects the representative original image. If it is absent or invalid, the first original ordered by `products.image_ids` is used. SigLIP may embed all originals when configured, but each caption provider captions only this representative image.
