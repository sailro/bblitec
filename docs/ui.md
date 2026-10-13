# Native page UI

Typed DOM/CSS/Canvas2D project into RmlUi ([pin](../upstream/rmlui.json), patches in `native/patches/rmlui/`).
RmlUi owns layout, flexbox, transitions, controls, selector matching and effects; the compiler owns admission, DOM
ownership, events and CSS translation; backends own uploads, layers and premultiplied composition. Check the pin
before implementing: a source refusal does not mean RmlUi lacks the feature.

## Host pages

- TypeScript owns live controls; reviewed `ui/*.json` companions or an HTML page describe static chrome.
- `bblitec page.html [--site-root <dir>]`: Chromium parses the page; markup, attributes and `<style>` sheets are the host,
  its one module script names the entry, `/` resolves beneath the site root (default: the page's directory).
- An inline module script must end with a statement `import()` of the entry. Inline classic body scripts admit
  expression statements and run at their parser position.
- Refused, listed together: external/head classic scripts, classic globals, sheets after classic scripts, data scripts,
  inline handlers, external sheets, foreign markup, quirks mode, other head content. Icon links, resource hints and
  basic metadata are inert.
- Worker applications select the Window host through reached Window APIs; workers have no DOM.
- The primary canvas is the element passed to `createEngine` (else the host's `renderCanvas`); looking it up by several
  ids refuses. Window applications create the implicit engine canvas before entry evaluation.

## Window services

- RAF runs on the owner repaint clock; no engine needed.
- matchMedia: resolution, reduced-motion, pointer/hover with change listeners. Other queries and payloads refuse.
- MutationObserver: attribute notifications, static filters, disconnect. Records, child lists, subtree refuse.
  ResizeObserver entries are unavailable.
- Location: deployment query reads fold to constants. Reload, `location.search` writes and same-document
  `assign`/`href` recreate realms, keeping durable storage; another document throws NotSupportedError.
- Clipboard: text writes only. `visibilitychange` follows window hide/show.
- `beforeunload` then `pagehide` (persisted=false, no prompt) run before realm cleanup; worker realms refuse them.
- Error/unhandledrejection listeners are supported; `rejectionhandled` is not.
- GPU adapter requests describe the selected device; fallback, low-power, compatibility and XR requests reject.

## DOM and events

| Area | Admitted | Refuses |
| --- | --- | --- |
| Tree | Static tags, text nodes, append/insert/prepend/replaceChildren, remove, `replaceWith`, `insertAdjacentElement`, parent/child/sibling reads | Stored child collections, prepend spreads, tree reads inside innerHTML, `replaceWith` text/spreads, dynamic adjacent positions |
| Content | textContent/innerText, bounded innerHTML, static attributes, reflected properties, dataset, packaged img `src` choices | Compound text/dataset writes, dynamic dataset keys, other property writes; `title` tooltips not rendered |
| Styles | cssText, static style fields, classList; getComputedStyle display/opacity/visibility/zIndex | `setProperty` priority, dynamic names, other computed properties |
| Queries | Literal selectors, `matches`, `closest`, ID lookup, `contains`, `instanceof` | `:scope`, pseudo-elements; dynamic selectors (deferred: throw) |
| Pointer/keyboard | Mouse, multi-touch, click/dblclick, wheel, contextmenu, keys, `on<event>` properties | AbortSignal, coalesced events, pointer capture (deferred: throw) |
| Events | transitionend, storage, file drags (first file), CustomEvent, constructed Event/MouseEvent/PointerEvent/InputEvent, `composedPath` | Element CustomEvent dispatch, authored drags, cross-document redispatch |
| Forms | Focus/blur, activeElement, `tabIndex`, text/password/checkbox/color/range inputs, textarea, select, output, details/summary | Full browser form behavior; `hidden=until-found` |

- UI handles input before cameras; `preventDefault` suppresses camera propagation. Only the primary touch emits mouse events.
- `tabIndex` reflects `tabindex`: 0 joins Tab navigation in tree order, negative leaves it; positive values throw
  NotSupportedError. Canvas `tabIndex` reads 0 (keyboard focus targets the SDL surface); other canvas writes refuse.
- `scrollIntoView` (boolean or block/inline/behavior) applies at the next layout; smooth scrolls only the nearest
  scroll container, outer ones jump.
- Erased writes: canvas `tabIndex = 0`, engine-canvas `width`/`height` (the window owns size), dataset members nothing reads.
- Color inputs use an RGB/hex popup (preview emits input, Apply emits change). Select keyboard navigation needs the menu open.
- Canvas backing size is drawable pixels; client sizes and rects are CSS pixels; rect/size reads flush layout.

## Files

- Anchors: object-URL `href` downloads; string `href` navigates like `location.assign`. A non-`_self/_parent/_top`
  `target` is inert; string `href` with `download` refuses.
- Save dialogs publish only accepted selections. Single-file inputs only; FileList index 0.
- Limits: 256 MiB live selection cap; drops count up to 4096 files and snapshot the first (64 MiB); Blob 64 MiB.
- FileReader supports `readAsText` only (BOM-detected, else UTF-8). File System Access pickers are absent.
- iOS uses UIKit Files; other platforms SDL dialogs.

## Markup and SVG

- innerHTML admits text/div/span/label, comments, packaged img, reviewed SVG path/rect, role/aria-*/data-*; runtime text
  is escaped. Scripts, event attributes and malformed nesting refuse; markup-created controls throw in deferred mode.
- ARIA has no native accessibility bridge.
- `createElementNS`: SVG svg/path/rect/circle/line/ellipse/polyline/polygon, rasterized at CSS size by RmlUi's SVG
  plugin. Shape styles, listeners, nested SVG and paint servers refuse.

## Canvas2D

Backing dimensions, scale, full clear, fillRect/strokeRect, bounded paths, putImageData, destination-rect drawImage,
bounded fillText. Offscreen pixels are premultiplied RGBA; closed producers can bake `getImageData`. Partial clear,
source-rect blits, general transforms/clipping and non-convex tessellation refuse.

## CSS

| Area | Admitted | Refuses |
| --- | --- | --- |
| Box | fixed/inset, px/rem/viewport calc/min/max/clamp, box sizing, physical and horizontal-LTR logical edges, float/clear | Vertical/RTL logical mapping, element-font-relative math |
| Flex | Wrap, direction, grow/shrink/basis, alignment, gaps | Intrinsic basis keywords |
| Grid | Line placement, spans, auto/px/fr/minmax, repeat/auto-fit/auto-fill (≤256 tracks/axis) | Named areas/lines, subgrid, percentage tracks |
| Containers/media | inline-size containment, unnamed max-width queries; max-width, orientation, reduced-motion media | Named/height/style queries |
| Text | Wrapping, italic, casing, ellipsis, vertical-align keywords, decoration lines | Oblique, decoration colors/styles, vertical-align lengths |
| Borders/backgrounds | Solid borders, radii, gradients, one packaged image, raster border-image slices | Elliptical radius syntax, multiple image layers, sized repetition |
| Shadows/filters | Box shadows, filters, drop-shadow chains, backdrop blur | Non-pixel shadow lengths, other backdrop functions (may degrade) |
| Transforms | Uniform nonnegative scale | Nonuniform scale, nonempty clip rectangles |
| Selectors | Tags/IDs/classes, attribute presence/equality, combinators, state pseudo-classes, An+B, `not/is/where/has`, `::before/::after` | Nested `:has`, wider attribute operators, counters |
| Other | Custom properties (`--bbl-` reserved), scrollbars, overscroll, unmarked lists, `color-scheme`, opaque `accent-color` | Runtime-generated stylesheet text, list markers, translucent accents |

In [deferred mode](features.md#deferred-capabilities), registered missing CSS properties, grid-track forms, nonconstant
stylesheet installation and unstructured declaration strings throw at the write; host-page sheets still need admission.

## Fonts

- DirectWrite on Windows; FreeType with CoreText (macOS/iOS), Fontconfig (Linux) or Android discovery.
- Color glyphs: CoreText on iOS, Android's text renderer. Android bundles Noto Sans Symbols 2.
- Missing glyphs fall back per glyph. Sizes stay fractional (FreeType quantizes to 1/64 px); sizes above 16384 px refuse.
- Font selection, kerning, line-height rounding and rasterization can differ from Chromium.

## Rendering

- Scene drivers render each UI segment into a transparent layer at scene sample count; sprite and Window drivers blend
  into single-sample targets. Canvas overlays precede DOM chrome.
- An engine canvas beneath the UI is an opaque rectangle; a rounded, transformed, translucent, filtered, masked or
  overflow-clipped engine canvas refuses.
- Backdrop blur snapshots preceding UI into FP16 scratch.

## Limits

- General mask-image and unsupported blend modes refuse.
- will-change, touch-action, user-select and image-rendering are hints; only `-webkit-user-drag: none` is admitted.
- `element.animate` is a no-op.
- Retained UI is unavailable under standalone effect/frame-graph drivers.
- Only backdrop-filter, filter and mask elements are backdrop roots (no group layer for opacity, clip-path, mix-blend-mode).
- Backdrop blur samples beyond the border box where Chromium mirrors.
- Only box-shadow writes are checked against the CSS grammar; other invalid values refuse or are stored as written.
- A scene canvas hides page paint beneath it even when it clears translucent.
- Text/sprite renderers present an authored engine canvas only while it fills the window.
