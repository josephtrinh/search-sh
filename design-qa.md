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

prior task result: passed

---

# Design QA — Frontend Model Switcher and Sticky Search

## Evidence

- Source visual truth: the user-provided 1566 × 623 px composite screenshot in the current conversation. The attachment is not exposed as a local filesystem path.
- Source state: Discover uses the current preview, DINOv3 is active, the desktop results grid has four columns, and the highlighted search panel sits below a non-sticky header.
- Implementation screenshot: unavailable.
- Implementation viewport: unavailable; the requested desktop layout was implemented against the existing Discover breakpoint and the source screenshot.
- CSS size/density normalization: unavailable without an implementation capture.

## Static implementation review

- The model selector is part of the existing search mode row and uses the same three labels and readiness state as Admin.
- Selecting a model updates the shared API state, protects unavailable models, moves an incompatible Text Visual search to Auto, and reruns visible results with the new model.
- The site header now scrolls normally. The complete search panel becomes sticky with a 10 px top gap on desktop and returns to normal document flow below the 1000 px breakpoint so the crop interface cannot monopolize a small viewport.
- The panel retains its opaque card surface before scrolling. Once stuck, its background changes to 35% white with a 14 px backdrop blur; controls and reference imagery remain fully opaque and readable.
- The implementation preserves the existing design tokens, button treatment, spacing, and typography.

## Interaction and API verification

- TypeScript check: passed.
- Production web build: passed.
- Discover route response: passed with HTTP 200.
- Shared model endpoint: passed; the test state was restored to DINOv3, with SigLIP2, DINOv2, and DINOv3 reported ready.
- Browser-rendered interaction test: blocked.
- Browser console inspection: blocked.

## Sticky-surface follow-up

- Source visual truth: the latest user-provided scrolled Discover screenshot highlighting the search panel's contact with the top viewport edge and its large opaque surface.
- Implemented target: 10 px visible clearance above the stuck card and a translucent background only while the sticky constraint is active.
- TypeScript check and stylesheet validation: passed.
- Matching-viewport screenshot and visual comparison: blocked by the browser connection issue below.

## Findings

- Blocked: the required in-app browser runtime could not initialize because its bundled client imports `node:process`, which the available `node_repl` runtime rejected. As a result, I could not capture the implementation at the matching viewport, create the required side-by-side visual comparison, exercise the controls in-browser, or inspect the browser console.
- No P0, P1, or P2 issues were found in static code review or build/API verification, but those checks do not substitute for browser visual QA.

final result: blocked
