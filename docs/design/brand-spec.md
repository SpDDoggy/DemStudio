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
- Geometry: 6 px control radius, 10 px panel radius, 12 px floating controls and dialogs
- Elevation: hairline borders plus two restrained shadow levels
- Motion: 100–200 ms, `cubic-bezier(.1,.9,.2,1)`, with reduced-motion support
- Window chrome: custom 52 px draggable title bar with native minimize, maximize/restore and close actions

## Workspace composition

- Command bar: breadcrumb and current dataset status on the left, primary file/export actions on the right.
- Resource rail: 260 px target width for import, recent files and live dataset metadata.
- Terrain stage: flexible light canvas with grid, compact dataset HUD, orientation cube and bottom camera controls.
- Inspector: 330 px target width with underline tabs and vertically grouped controls.

## Interaction rules

- Primary actions use the accent color; selection and focus use a subtle accent tint.
- Acrylic-like translucency is reserved for transient overlays and floating viewport controls.
- Surfaces use hierarchy rather than decorative gradients.
- UI copy is limited to labels, values, commands, and operational status.
- Explanatory text belongs in external documentation, not the product interface.
