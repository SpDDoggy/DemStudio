# DEM Studio UI / Brand Spec

## Product assets

- Product mark: `assets/icon.svg`
- Windows application icons: `src-tauri/icons/`
- Product UI: `index.html`

The product mark is the existing DEM Studio terrain glyph. It must be used as an image asset and must not be replaced by emoji, fabricated illustrations, or a generic colored tile.

## Positioning

- Narrative role: professional desktop terrain authoring workspace
- Viewing distance: laptop and desktop at approximately one metre
- Visual temperature: calm, precise, technical
- Capacity: information-dense side panels around an immersive terrain viewport

## Fluent design system

- Anchor: Windows 11 Fluent desktop workspace, aligned to the approved three-pane reference dated 2026-07-24
- Color: cool white Mica-like base, pale blue-gray workspace, Windows blue `#0f6cda` for primary actions
- Typography: `"Segoe UI Variable Text"`, `"Segoe UI Variable Display"`, with native CJK fallbacks
- Spacing: 4 px base unit; primary intervals are 4, 8, 12, 16 and 24 px
- Geometry: 8 px control radius, 15 px command-island radius and 20 px panel radius
- Elevation: hairline borders plus soft, low-contrast floating-island shadows
- Motion: 100–220 ms, `cubic-bezier(.1,.9,.2,1)`, with reduced-motion support
- Window chrome: fully transparent, unblurred 52 px drag region with three circular minimize, maximize/restore and close actions

## Workspace composition

- Window commands: one detached brand/import island over the 52 px drag region; save and export remain canonical inspector actions.
- Terrain stage: full-window light canvas with grid; it remains the primary visual layer at every desktop size.
- Resource island: 292 px target width for current scene, dataset telemetry and recent files; DEM import has one canonical entry in the brand command island.
- Inspector island: 324 px target width, dismissible without resizing the canvas.
- Resource and inspector islands collapse through scale, clip-path and blur into named edge capsules; the capsules are the only restore controls.
- The stage grid is generated in world space, follows the camera and fades by distance and grazing angle so no finite boundary is visible.
- Camera controls remain centered at the bottom; no persistent status or secondary-action footer competes with the terrain stage.

## Interaction rules

- Primary actions use the accent color; selection and focus use a subtle accent tint.
- Acrylic-like translucency is reserved for transient overlays and floating viewport controls.
- Prompts, confirmations and application notices use the DEM Studio dialog layer. Browser `alert`, `confirm`, `prompt` and browser file inputs are forbidden.
- File selection uses the Tauri desktop picker; transient product decisions remain in the application dialog layer.
- Surfaces use hierarchy rather than decorative gradients.
- UI copy is limited to labels, values, commands, and operational status.
- Explanatory text belongs in external documentation, not the product interface.
