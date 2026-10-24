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
- Web Storage: getItem/setItem/removeItem. `localStorage` lives in the host preference directory; `sessionStorage` in
  process memory (kept across realm recreation, never on disk, no quota) and is absent in worker realms.
- Clipboard: text writes only. `visibilitychange` follows window hide/show.
- `beforeunload` then `pagehide` (persisted=false, no prompt) run before realm cleanup; worker realms refuse them.
- Error/unhandledrejection listeners are supported; `rejectionhandled` is not.
- `requestIdleCallback`/`cancelIdleCallback` (direct, `window.` members, stored aliases): each callback runs in its
  own task once the task queue is empty, before a 50 ms deadline, the next due timer and, while a repaint is pending,
  the next frame predicted from the display's tick interval; `timeout` runs it timed out (`timeRemaining()` 0).
  Worker realms refuse them.
- `alert`/`confirm` show a modal SDL message box (OK, or OK/Cancel; title = window title) on the Window thread and
  block the realm. Linux Wayland needs zenity. `prompt` stays [deferred](features.md#deferred-capabilities): SDL has
  no text-input dialog.
- Fullscreen: `requestFullscreen()` on the document element or the primary canvas makes the window fullscreen, then
  resolves, then fires the document's `fullscreenchange`; other elements reject with NotSupportedError, a failed
  window change with TypeError. `exitFullscreen()` restores a window the page made fullscreen; Escape and the system
  leaving fullscreen exit it too. `fullscreenerror`, element listeners and `:fullscreen` are not lowered.
- GPU adapter requests describe the selected device; fallback, low-power, compatibility and XR requests reject.

## DOM and events

| Area | Admitted | Refuses |
| --- | --- | --- |
| Tree | Static tags, text nodes, append/insert/prepend/replaceChildren, remove, `replaceWith`, `insertAdjacentElement`, parent/child/sibling reads | Stored child collections, prepend spreads, tree reads inside innerHTML, `replaceWith` text/spreads, dynamic adjacent positions |
| Content | textContent/innerText, bounded innerHTML, static attributes, reflected properties, dataset, `new Image()`, img `src` selecting packaged images (literals or runtime strings with inferable candidates; load/error, natural size, `complete`), `scrollTop`/`scrollLeft` (applied clamped at the next layout) | Compound text/dataset writes, dynamic dataset keys, other property writes, img `src` without inferable candidates (incl. `data:`/object URLs), `draggable = true`, `autocomplete` reads; `title` tooltips not rendered |
| Styles | cssText, static style fields, classList; getComputedStyle display/opacity/visibility/zIndex | `setProperty` priority, dynamic names, other computed properties |
| Queries | Literal selectors, runtime text in quoted attribute values, unions of literal selectors, state pseudo-classes, `matches`, `closest`, ID lookup, `contains`, `instanceof` | `:scope`, pseudo-elements, other runtime selector text |
| Pointer/keyboard | Mouse, multi-touch, pointer capture, click/dblclick, wheel, contextmenu, keys, `on<event>` properties | Coalesced events |
| Events | transitionend, storage, file drags (first file), gamepadconnected/gamepaddisconnected (application realm), CustomEvent, constructed Event/MouseEvent/PointerEvent/InputEvent, `composedPath` | Element CustomEvent dispatch, authored drags, cross-document redispatch |
| Forms | Focus/blur, activeElement, `tabIndex`, text/password/checkbox/color/range inputs, textarea, select, output, details/summary | Full browser form behavior; `hidden=until-found` |

- Selector structure is parsed at generation with the literal grammar. In a runtime attribute value, a line break
  throws SyntaxError; the delimiting quote, a backslash, tab or NUL throw NotSupportedError.
- `:hover`/`:active` read the UI's last update, so a listener of the pointer event that changes them sees the earlier
  state; focus states, `:checked` and `:disabled` read the document.
- Listener options: `capture`, `once`, `passive`, `signal` ([abort](fidelity.md#semantic-contract)).
- Gamepad events: after the first listener, a 16 ms task compares the pads `getGamepads()` reports with those announced
  and fires gamepaddisconnected, then gamepadconnected, at the Window; pads present at the first poll connect then.
- An event's `target`/`currentTarget` narrowed by `instanceof` to an element is that retained element; writes through it
  lower as the element's own.
- Dynamically created scripts are retained, never rendered: an external script fails to load (a task fires `error`
  after it connects, never `load`); inline text refuses, or throws NotSupportedError when a connected script gets it.
- `inputmode`, input `type` and inherited `spellcheck` choose the platform keyboard and autocorrection; labels activate
  their `for` or nested control.
- Pointer capture (element, engine canvas or stored element) retargets the pointer's events, compatibility mouse
  events and hover until release, pointerup or pointercancel; touch presses capture implicitly. SDL holds a captured
  mouse beyond the window.
- UI handles input before cameras; `preventDefault` suppresses camera propagation. Only the primary touch emits mouse events.
- `tabIndex` reflects `tabindex`: 0 joins Tab navigation in tree order, negative leaves it; positive values throw
  NotSupportedError. Canvas `tabIndex` reads 0 (keyboard focus targets the SDL surface); writing 0 is erased, other
  values refuse.
- `scrollIntoView` (boolean or block/inline/behavior) applies at the next layout; smooth scrolls only the nearest
  scroll container, outer ones jump.
- Erased writes: engine-canvas `width`/`height` (the window owns size), dataset members nothing reads.
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

- Static innerHTML is parsed at generation by Chromium (the browser's tree, entities and implied end tags).
- innerHTML admits text/div/span/label, comments, packaged img, reviewed SVG path/rect and packaged PNG/JPEG `<image>`,
  role/aria-*/data-*; runtime text is escaped. Scripts, event attributes and runtime tag or attribute names refuse.
- Static innerHTML with input/select/option/textarea builds retained elements, so its controls own state as created
  ones do: div/span/p/h1/h2/b/strong/label/button and reviewed control attributes. Comments, other tags, textarea
  content and dynamic markup with controls refuse; whitespace between options is not kept.
- ARIA has no native accessibility bridge.
- `createElementNS`: SVG svg/path/rect/circle/line/ellipse/polyline/polygon, rasterized at CSS size by RmlUi's SVG
  plugin. Shape styles, listeners, nested SVG and paint servers refuse.

## Canvas2D

Backing dimensions, scale, full clear, fillRect/strokeRect, bounded paths, putImageData, destination-rect drawImage,
bounded fillText. A canvas kept in a record, container or class field, and a 2D context kept in a class field, keep
their roles. Offscreen pixels are premultiplied RGBA; closed producers can bake `getImageData`. Partial clear,
source-rect blits, general transforms/clipping and non-convex tessellation refuse.

## CSS

| Area | Admitted | Refuses |
| --- | --- | --- |
| Box | fixed/inset, px/rem/viewport calc/min/max/clamp (also over `var()`, with times and angles), box sizing, physical and horizontal-LTR logical edges, float/clear, `aspect-ratio` | Vertical/RTL logical mapping, element-font-relative math, other units in math over `var()`; `aspect-ratio` on replaced elements, grid items and flex items with both sizes auto in a stretched definite row |
| Flex | Wrap, direction, grow/shrink/basis, alignment, gaps | Intrinsic basis keywords |
| Grid | Line placement, spans, named areas (`grid-template-areas`, `grid-area`), auto/fr/minmax with px/em/rem/vw/vh lengths, repeat/auto-fit/auto-fill (≤256 tracks/axis) | Named lines, subgrid, percentage tracks |
| Containers/media | inline-size containment, unnamed max-width queries; max-width, orientation, reduced-motion media | Named/height/style queries |
| Text | Wrapping, italic, casing, ellipsis, vertical-align keywords, decoration lines | Oblique, decoration colors/styles, vertical-align lengths |
| Borders/backgrounds | Solid borders, radii, gradients, one packaged image, raster border-image slices | Elliptical radius syntax, multiple image layers, sized repetition |
| Shadows/filters | Box shadows, filters, drop-shadow chains, backdrop blur | Non-pixel shadow lengths, other backdrop functions (may degrade) |
| Transforms/clipping | Uniform nonnegative scale; `clip-path` inset()/polygon() over px/%/calc() (aliased edges) | Nonuniform scale, nonempty clip rectangles, other basic shapes, `round`, reference boxes |
| Motion | `transition`/`animation` shorthands (s/ms; easing keywords, `cubic-bezier()`, `steps()`; animation directions and fill modes), `transition-delay`/`animation-delay` lists (negative delays start part-way); inline style, cssText and removal writes transition like rule changes | `linear()` easing, `paused`, fractional or zero iteration counts, zero-duration animations, other transition/animation longhands |
| Selectors | Tags/IDs/classes, attribute presence/equality, combinators, state pseudo-classes, An+B, `not/is/where/has`, `::before/::after` | Nested `:has`, wider attribute operators, counters |
| Other | `!important`, custom properties (`--bbl-` reserved), scrollbars, overscroll, unmarked lists, `color-scheme`, opaque `accent-color` | Runtime-generated stylesheet text, list markers, translucent accents |

In [deferred mode](features.md#deferred-capabilities), registered missing CSS properties and grid-track forms throw at
the write; host-page sheets still need admission.

## Fonts

- DirectWrite on Windows; FreeType with CoreText (macOS/iOS), Fontconfig (Linux) or Android discovery.
- Color glyphs: CoreText on iOS, Android's text renderer. Android bundles Noto Sans Symbols 2.
- Missing glyphs fall back per glyph. Sizes stay fractional (FreeType quantizes to 1/64 px); sizes above 16384 px refuse.
- Font selection, kerning, line-height rounding and rasterization can differ from Chromium.

## Rendering

- Scene drivers render each UI segment into a transparent layer at scene sample count; sprite and Window drivers blend
  into single-sample targets. Canvas overlays precede DOM chrome.
- An engine canvas beneath the UI is an opaque rectangle; a rounded, transformed, translucent, filtered, masked,
  clip-path or overflow-clipped engine canvas refuses.
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
