# Native page UI

The bounded DOM/CSS/Canvas2D projection uses retained typed operations and
RmlUi. SDL_GPU and Dawn consume the same UI draw frame. This page owns the UI
surface and its compatibility limits.

## Integration

Build switches for RmlUi, FreeType and LunaSVG are in
[development](development.md#native-builds). Scene TypeScript owns live controls. Reviewed `ui/*.json` companions describe
static host chrome explicitly; they do not discover arbitrary browser pages.
Window metrics, media queries, resize observers and application error listeners in an application with workers select the native
Window host directly; they do not require static host markup. Worker realms cannot use those Window APIs.
The application `document` can be passed through specialized dependency records with a stable identity
distinct from `window`; reached DOM operations remain limited to the projection below.
`window` error and unhandled-rejection listeners receive native exception messages before engine creation.
Removal, `once` and `preventDefault` are supported; events borrow their dispatch frame. Native error
names remain `Error`, `stack` is undefined and source locations are unavailable; `rejectionhandled` and arbitrary rejection values are unsupported.

Environment reads support aliased `navigator` values, native platform identification, processor
count and system language. Optional browser client hints, device-memory estimates and the browser WebGPU
entry point are absent.
`navigator.userAgent` is the fixed identifier `bblitec/native`; operating-system identity is available separately as `navigator.platform`.
Aliased `performance.now()` reads the native monotonic clock; the nonstandard JavaScript heap snapshot is absent.
Location origin, pathname and href follow the configured deployment base and query.
Application realms support `navigator.clipboard.writeText` through the native window thread, with a promise
that rejects if the operating-system write fails. Clipboard reads and rich clipboard data are unsupported.
`location.reload()` finishes the current task and microtasks, then recreates the application and its workers;
durable local storage survives. Navigation to other URLs remains unsupported.
Window applications read current screen bounds, usable bounds and color depth through the same snapshot
as viewport metrics. Screen dimensions use CSS pixels at the Window display scale.

The multi-canvas companions retain the original canvases, divider and labels. Equivalent flex panes
provide native rectangles; pinned host HTML supplies the browser reference. Canvas-only captures
retain every canvas at its page position, so labels cannot conceal a rendering regression.

## DOM and events

| Area | Supported |
| --- | --- |
| Construction | Static-tag createElement, appendChild/append, root attachment, remove |
| Content | textContent/innerText, bounded innerHTML, className/id/type, static attributes |
| Styles/classes | cssText, reached style fields, classList add/remove/forced toggle |
| Queries | Static class query on a known complete retained subtree; Window document ID lookup returns the first attached match in tree order, or null |
| Input | Reached click/mousedown/pointerdown/up/cancel/lost-capture callbacks; one pointer |
| Focus | Control/canvas focus, focus listeners, activeElement identity, button navigation |
| Text forms | Retained input/textarea value and input callbacks; textarea editing and vertical resize |
| Range forms | Retained value/input callbacks and native range widgets |
| Files | Object-URL download anchors and static single-file inputs |

UI receives pointer input before cameras. Consumed events do not move cameras;
Window keyboard listeners run before default UI actions. `preventDefault`
suppresses those actions and camera propagation. Retained elements preserve
focus/hover/capture identity. Borrowed events cannot escape dispatch; copy
owned scalar fields.

Canvas `width/height` are drawable pixels; `clientWidth/clientHeight` are CSS
pixels. Pointer conversion uses pixel density/display scale. Density changes
refresh metrics even without a drawable resize.

### File transfer controls

Downloads use save dialogs and atomic publication; cancellation writes nothing.
File inputs snapshot bytes/name before change dispatch. Cancellation retains the
old selection; retained File values keep old snapshots. Reads enforce per-file
limits and a 256 MiB engine live-selection cap. `File.text` reads the snapshot.

Picker completion and immediate text continuations can occur before `click`
returns. Multiple files/directories, unsupported accept entries, arbitrary URL
navigation and source-selected native paths refuse.

### Markup

Generation-time innerHTML accepts bounded text/div/span and reviewed
svg/path/rect attributes. Scripts, event attributes, dynamic attributes,
unsupported elements and malformed nesting refuse. Runtime text is escaped.
Inline SVG rasterizes at live CSS size; [mixed currentColor/literal paints](../src/compiler/ui-projection.ts) and
queries into SVG internals refuse.

## Canvas2D

Supports backing dimensions, scale, full-surface clear, fillRect, bounded
paths/fill/stroke, putImageData, destination-rectangle canvas drawImage,
sampling intent and bounded fillText. Offscreen canvases retain premultiplied
RGBA pixels and revisions.

Generation captures top-level `getImageData` reads in closed canvas-producing
functions. Arguments must be known data, closed data producers or local asset
directories; mutable module inputs and runtime engine reads refuse.

An engine-less entry can present primary `renderCanvas` with window/input/RAF
support on both backends. Source-created GPU engine ownership cannot share that
primary canvas. Client size stays live; backing dimensions follow source resets.
Rectangles normalize negative extents and use backing-pixel fractional coverage.
Opaque full redraws retire covered commands.

Partial clear, source-rectangle blits, arbitrary transforms, general
clipping/shaping and non-convex tessellation remain unsupported.

## CSS, layout, and fonts

Supports reached browser defaults, platform fonts, fixed/inset/calc positioning,
bounded shorthands, backgrounds, gradients, rounded borders, text effects and
deterministic CSS animation. Scrollbars are 16 density-independent pixels.

Selectors are bounded class/id/compound and proven ancestor forms, with optional
hover. [Tag-only projection](../src/compiler/ui-projection.ts) is unsupported. Static selectors/properties are
validated; source/sheet order and live max-width rules are retained.
Only fixed grids with proven equivalent wrapping-flex geometry lower; unknown
track/class/id changes refuse.

Fonts use DirectWrite/CoreText/fontconfig. Generic emoji/ZWJ shaping is limited.
Unauthored button fonts use the generic sans default; normal line height uses
per-face ratios, so browser glyph/size rounding can differ.
Windows file fonts use DirectWrite OpenType shaping and browser-compatible raster modes and coverage.
Color/fallback faces and font effects retain RmlUi rasterization; glyph coverage and baseline rounding
can differ from browser text. Textareas preserve fractional line height and design advances;
native range painting follows browser geometry and control states.

| Maintained RmlUi patch | Purpose |
| --- | --- |
| `rmlui-css-box-model.patch` | Solid backgrounds under borders; offset shrink-to-fit sizing |
| `rmlui-premultiplied-rounding.patch` | Browser-oriented color/opacity rounding |
| `rmlui-fractional-letter-spacing.patch` | Fractional default-font accumulation; excludes HarfBuzz sample |
| `rmlui-line-leading.patch` | Floor upper half-leading; preserve authored fractional textarea line height |
| `rmlui-transform-key-ownership.patch` | Own mutable transition keys; preserve shared relative transforms |

Relative transition units resolve at transition start. Fully responsive
relative-unit interpolation, gradient border compositing and exact browser
font rasterization are not guaranteed. Rebuild patched libraries before checks.

## Rendering

Both backends composite a premultiplied transparent layer at scene sample count.
Backdrop blur snapshots preceding UI, uses FP16 scratch targets and clips before
later UI. Resize/density updates intrinsic measurements. Canvas overlays sit
below DOM chrome.

## Limits

Single-row inline grids support positive px/fr tracks with one element child per track.
Runtime track replacement and implicit extra rows refuse. Form dimensions support content-box and border-box.

- No general selectors/traversal/observers, full browser form semantics, JavaScript hover callbacks,
  multiple pointer identities or arbitrary events.
- Supported inset outlines become borders; other shadows/font-variant-numeric
  can degrade. General grid and unsupported text-shadow forms refuse.
- The reviewed difference-blend crosshair degrades; other unsupported blend
  modes refuse. Backdrop blur does not supply general mask/filter layers.
- blur(px)/none are supported; other reached backdrop functions can degrade.
- will-change, touch-action, user-select and image-rendering are accepted hints.
- element.animate and listener removal are no-ops; CSS keyframes use mapped easing.

Parity measures the [full page](fidelity.md#what-is-measured-the-full-page);
do not infer that every UI residual is unavoidable.
