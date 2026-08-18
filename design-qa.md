# Design QA — Search Reference Crop

## Evidence

- Source visual truth: user-provided screenshots in the conversation showing the SampleHub UI crop interaction and the requested full-image starting selection. The attachments are not exposed as local filesystem paths.
- Source dimensions: the original 1586 × 534 px composite interaction reference plus the latest desktop Search Lab screenshot; comparison is focused on the highlighted crop viewport.
- Implementation screenshots:
  - `/private/tmp/search-sh-crop-full-default.png`
  - `/private/tmp/search-sh-crop-mobile.png`
- Implementation viewports: 1440 × 1000 CSS px desktop and 390 × 1000 CSS px responsive, both at device scale factor 1.
- State: a real SampleHub material image is selected, the initial crop covers the complete displayed image, controls are enabled, and image-search results have loaded.
- Density normalization: implementation captures are 1 CSS px to 1 image px. The source is a composite reference rather than a same-viewport page capture, so comparison is component-level rather than pixel-diffed full-page.

## Full-view comparison

The implementation preserves the Search Lab header, search-first hierarchy, neutral SampleHub palette, filter rail, and four-column desktop result grid. The crop state remains inside the existing reference-image slot instead of introducing a modal or unrelated page structure. The responsive capture has no horizontal overflow and keeps search, crop, and results in a clear vertical order.

## Focused crop comparison

The focused crop region matches the reference interaction language: contained material image, white movable/resizable selection, close control at the top right, and compact zoom-out/zoom-in/reset controls at the bottom. The initial selection now aligns with all four displayed-image edges, so no portion is excluded until the tester intentionally resizes or zooms it. The implementation intentionally omits SampleHub UI's help popover because it was not part of the approved MVP scope.

## Required fidelity surfaces

- Fonts and typography: existing Search Lab typography, UI weights, and compact labels are preserved; crop controls use accessible labels without adding display typography.
- Spacing and layout rhythm: the selected-image state vertically centers the search controls against the taller crop viewport; desktop and mobile spacing remain consistent with the existing panel.
- Colors and visual tokens: crop chrome uses the existing black, white, grey, border, and surface tokens rather than the previous green treatment.
- Image quality and asset fidelity: QA used a real 216 × 216 SampleHub catalog thumbnail. The viewport keeps the image sharp and the submitted crop is encoded as WebP at 0.92 quality, capped at a 4096 px edge.
- Copy and content: the empty tile clearly says click or drop, lists supported formats and size, and replacement/removal controls have accessible names.

## Interaction and console verification

- Valid JPEG native drop: passed; the crop viewport appeared and the prior validation error cleared.
- Drag-over affordance: passed; the active drop class was applied.
- Initial crop and automatic search: passed; the crop rectangle matched the full 240 × 240 px displayed image within 1 px on every edge, and 24 grouped results loaded.
- Zoom and crop movement: passed; each settled interaction produced one additional debounced search request.
- Crop movement: passed; the selection moved 18 px horizontally and 12 px vertically.
- Remove and restore upload state: passed.
- Unsupported file validation: passed with `Image must be JPEG, PNG, or WebP.`
- Responsive overflow: passed; body width remained 390 px at the 390 px viewport.
- Browser console errors: none.

## Comparison history

1. Initial implementation: the crop worked, but the desktop search controls remained top-aligned against the taller crop viewport, leaving an uneven empty region.
2. Fix: added selected-image alignment so the search controls center vertically beside the crop viewport.
3. Post-fix evidence: `/private/tmp/search-sh-crop-desktop.png` shows balanced search and crop regions with no remaining P0, P1, or P2 findings.
4. Follow-up finding: the initial crop selected 80% of the displayed image, while the requested MVP behavior was to begin with the largest possible crop.
5. Fix: changed default crop creation to use the complete displayed-image bounds while preserving subsequent resize, zoom, pan, and reset interactions.
6. Post-fix evidence: `/private/tmp/search-sh-crop-full-default.png`; browser geometry measured both the crop and image at x 1116, y 130, width 240, and height 240. No P0, P1, or P2 findings remain.

## Findings

No actionable P0, P1, or P2 differences remain. The component-level differences from the SampleHub UI reference are intentional MVP adaptations to the Search Lab's existing layout.

## Follow-up polish

- P3: a short crop-help tooltip could be added later if internal testers need onboarding for wheel zoom and image panning.

final result: passed
