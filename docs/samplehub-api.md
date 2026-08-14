# SampleHub source mapping

The indexer connects directly to the existing SampleHub MySQL and S3 sources using read-only credentials. This file records the integration boundary; it is not a proposal to modify SampleHub.

## Selection

- Table: `products` (`p`)
- Eligible: `p.deleted_at IS NULL`, `COALESCE(p.is_private, 0) = 0`, `p.type = 'plan_product'`
- Category: left join `const` on `p.category_id`, excluding deleted constants
- Images: `files.product_img_id`, excluding deleted and archived files
- Image order: IDs in `products.image_ids`; unlisted images sort last
- Incremental streams: `products.updated_at` and `files.updated_at`

## Public fields

Core identity and discovery fields include brand, series, name, SKU, model, item, bilingual category, material, color, origin, effect, surface, edge, size group, water absorption, fire resistance, description, detail, remarks, RRP, status, dimensions, area, timestamps, and image metadata.

The `attributes` object includes public technical and packaging specifications: anti-bacterial, application areas, shade variation, EVA suitability, SRI, slip/chemical/stain resistance, unit, lead time, box/pallet quantities and dimensions, pattern, surface density, environmental, NRC, SAA, Alpha W/MH, sound absorption class, core material, IXPE, VOCs, wear layer, outdoor/indoor, and maintenance.

## Explicit exclusions

- private, deleted, or non-`plan_product` rows
- `unit_rate` and `discount`
- `internal_note` and other administrative notes
- supplier, organization, author, plan, and folder ownership identifiers
- access-control and admin-creation fields
- S3 credentials or private object metadata

The UI-visible price is `products.rrp`. Image URLs use the configured public bucket base; binary reads for embedding use the read-only S3 API.
