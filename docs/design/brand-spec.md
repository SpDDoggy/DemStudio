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

- Anchor: Windows 11 Fluent desktop workspace
- Color: neutral Mica-like base, white elevated controls, Windows blue `#005fb8` for primary actions
- Typography: `"Segoe UI Variable Text"`, `"Segoe UI Variable Display"`, with native CJK fallbacks
- Spacing: 4 px base unit; primary intervals are 4, 8, 12, 16 and 24 px
- Geometry: 4 px control radius, 8 px panel radius, 12 px dialog radius
- Elevation: hairline borders plus two restrained shadow levels
- Motion: 100–200 ms, `cubic-bezier(.1,.9,.2,1)`, with reduced-motion support
- Window chrome: custom 32 px draggable title bar with native minimize, maximize/restore and close actions

## Interaction rules

- Primary actions use the accent color; selection and focus use a subtle accent tint.
- Acrylic-like translucency is reserved for transient overlays and floating viewport controls.
- Surfaces use hierarchy rather than decorative gradients.
- UI copy is limited to labels, values, commands, and operational status.
- Explanatory text belongs in external documentation, not the product interface.
