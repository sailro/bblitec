# Native page UI

Typed DOM/CSS/Canvas2D project into RmlUi ([pin](../upstream/rmlui.json), patches in `native/patches/rmlui/`).
RmlUi owns layout, flexbox, transitions, controls, selector matching and effects; the compiler owns admission, DOM
ownership, events and CSS translation; backends own uploads, layers and premultiplied composition. Check the pin
before implementing: a source refusal does not mean RmlUi lacks the feature.

## Host pages

- TypeScript owns live controls; the HTML page describes static chrome.
- `bblitec page.html [--site-root <dir>] [--site-public-dir <dir>]`: Chromium parses the page; markup, attributes and
  `<style>` sheets are the host, its one module script names the entry. The site serves `/` from its public directory
  (`--site-public-dir`, else `--public-dir`; none by default), then its root (default: the page's directory), as Vite
  does.
- Page URLs (markup, sheets, img `src` writes, script and module `src`) resolve against the page and name the file the
  site serves at their path, whatever their query or fragment. A document URL the site does not serve beneath the
  entry module's directory is a module asset, packaged at the public root; another is the deployment's.
- A page `<select>` holds only its options: whitespace between them is dropped, other text refuses.
- Collapsible white space follows CSS: none between blocks or flex/grid items, one space between inline boxes, and
  none ending a line; spaces ending a `pre-wrap` line hang.
- An inline module script must end with a statement `import()` of the entry. Classic body scripts, inline or `src`
  (same origin), admit expression statements and run at their parser position.
- Refused, listed together: head classic scripts, `async`/`defer`, classic globals, sheets after classic scripts, data
  scripts, inline handlers, external sheets, foreign markup, quirks mode, other head content. Icon links, resource
  hints and basic metadata are inert.
- Worker applications select the Window host through reached Window APIs; workers have no DOM.
- The primary canvas is the element passed to `createEngine` (else the host's `renderCanvas`); looking it up by several
  ids refuses. Window applications create the implicit engine canvas before entry evaluation.

## Window services

- RAF runs on the owner repaint clock; no engine needed.
- matchMedia: `resolution` alone, or an `and` of the device features a sheet's `@media` admits (reduced-motion, hover,
  pointer), with change listeners. Other queries and payloads refuse.
- MutationObserver: attribute notifications (classList writes included), static filters, subtree, disconnect. Records
  and child lists refuse.
  ResizeObserver entries are unavailable.
- Location: deployment query reads fold to constants. Reload, `location.search` writes and same-document
  `assign`/`href` recreate realms, keeping durable storage; another document throws NotSupportedError.
- Clipboard: text writes only. `visibilitychange` follows window hide/show.
- The window is top-level: `parent`, `top` and `frames` are the Window. Nothing posts it a message, so a
  `message` listener receives only events the program dispatches, whose MessageEvent members read `undefined`.
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
| Content | textContent/innerText, bounded innerHTML, static attributes, reflected properties (on a lookup of unknown tag, checked when written), a link's `href` read (resolved against the document URL), dataset, `new Image()`, img `src` selecting packaged images (literals or runtime strings with inferable candidates; load/error, natural size, `complete`), `scrollTop`/`scrollLeft` (applied clamped at the next layout) | Compound text/dataset writes, dynamic dataset keys, other property writes, img `src` without inferable candidates (incl. `data:`/object URLs), `draggable = true`, `autocomplete` reads; `title` tooltips not rendered |
| Styles | cssText, static style fields, classList; getComputedStyle display/opacity/visibility/zIndex | `setProperty` priority, dynamic names, other computed properties |
| Queries | Literal selectors, runtime text in quoted attribute values, unions of literal selectors, state pseudo-classes, `matches`, `closest`, ID lookup, `contains`, `instanceof` | `:scope`, pseudo-elements, other runtime selector text |
| Pointer/keyboard | Mouse, multi-touch, touch events, pointer capture, click/dblclick, wheel, contextmenu, keys, `on<event>` properties | Coalesced events, Touch radius/rotation/stylus fields |
| Events | transitionend, storage, file drags (first file), gamepadconnected/gamepaddisconnected, CustomEvent, constructed Event/MouseEvent/PointerEvent/InputEvent/KeyboardEvent (keydown and keyup reach the key listeners), `composedPath` | Element CustomEvent dispatch, authored drags, cross-document redispatch |
| Forms | Focus/blur and the bubbling focusin/focusout after them, activeElement, `tabIndex`, text/password/checkbox/color/range inputs, textarea, select, output, details/summary, `form.elements.namedItem`, `new FormData(form)` (its entry list; `get`/`has`/`set`/`delete`/iterators), `submit` listeners ([never dispatched](fidelity.md#semantic-contract)) | Full browser form behavior; `hidden=until-found`; several controls of one name (RadioNodeList) and file inputs in FormData throw NotSupportedError; a FormData submitter |

- Selector structure is parsed at generation with the literal grammar. In a runtime attribute value, a line break
  throws SyntaxError; the delimiting quote, a backslash, tab or NUL throw NotSupportedError.
- `:hover`/`:active` read the UI's last update, so a listener of the pointer event that changes them sees the earlier
  state; focus states, `:checked` and `:disabled` read the document.
- Listener options: `capture`, `once`, `passive`, `signal` ([abort](fidelity.md#semantic-contract)). touchstart,
  touchmove, wheel and mousewheel listeners on the Window, Document, `<html>` and `<body>` are passive unless `passive`
  is given (Chromium).
- SDL finger events fire, per contact, its pointer events, then a TouchEvent at the target of its press while a
  listener names its type: `touches` in press order, `targetTouches`, `changedTouches`, each one object per event.
  Page coordinates equal client coordinates because the viewport never scrolls. A primary contact that stays alone,
  within 15 CSS px and under 500 ms taps after its touchend: compatibility mouse events at the element under it, then
  click. A canceled pointerdown withholds those mouse events; a canceled touchstart or touchend the whole tap. Touch
  cancellation never reaches cameras or retained-UI defaults. Focus loss fires touchcancel.
- Gamepads follow SDL's device events. `getGamepads()` reads none until a gamepad user gesture (a standard button, a
  trigger, or a stick past half its travel); then gamepadconnected fires at the Window for each connected pad, and
  later for each new one. gamepaddisconnected fires for an announced pad's removal. Test passes drop gamepad input. A
  pad reads `index`, `connected`, `mapping` (always "standard"), `axes` and `buttons` (`pressed`, `value`: a trigger's
  travel, 1 for another button down); an interface declaring those members holds the pad itself.
- `document.hasFocus()` is the window's input focus, from SDL's focus events.
- An event's `target`/`currentTarget` narrowed by `instanceof` to an element is that retained element; writes through it
  lower as the element's own.
- Dynamically created scripts are retained, never rendered: an external script fails to load (a task fires `error`
  after it connects, never `load`); inline text refuses, or throws NotSupportedError when a connected script gets it.
- `inputmode`, input `type` and inherited `spellcheck` choose the platform keyboard and autocorrection; labels activate
  their `for` or nested control.
- Key events read `isComposing` inside an input method composition (SDL text editing until a commit or focus loss).
  `location` is 1 or 2 for a left or right modifier, 3 for the numeric keypad.
- A listener's event is of its family's kind, so `event.type` compared with another family's type is settled: one
  function listening to key and pointer events lowers its `keydown` branch for the key family only.
- Pointer capture (element, engine canvas or stored element) retargets the pointer's events, compatibility mouse
  events and hover until release, pointerup or pointercancel; touch presses capture implicitly. SDL holds a captured
  mouse beyond the window.
- Window pointer lock applies relative mouse mode and cursor visibility on the display thread; Escape and focus
  loss release it and notify the owning engine.
- UI handles input before cameras; a canceled pointer, mouse or wheel event suppresses camera propagation.
- Pointer, touch and wheel input in the letterbox around a `viewport-fit=auto` page never reaches it; a press the page
  received keeps its moves and release wherever they land.
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
- Window file dialogs run on the display thread; callbacks, selections and object URLs stay in the application realm.

## Markup and SVG

- Static innerHTML is parsed at generation by Chromium (the browser's tree, entities and implied end tags).
- innerHTML admits text/div/span/label, comments, packaged img, reviewed SVG path/rect and packaged PNG/JPEG `<image>`,
  role/aria-*/data-*; runtime text is escaped. Scripts, event attributes and runtime tag or attribute names refuse.
- A runtime string with a closed string domain (`src/compiler/string-domain.ts`: constants, `for...of` elements,
  records read by a run-time key, call-site arguments, aliases) is markup: generation lowers each text it can hold and
  the string selects one. Past 256 texts it refuses, unless runtime text beside them makes it runtime text.
- A stored string of fixed fragments (closed choices among them included) around one runtime text reads as the shape
  whose fragments it holds, the most specific first.
- Static innerHTML with input/select/option/textarea builds retained elements, so its controls own state as created
  ones do: div/span/p/h1/h2/b/strong/label/nav/a/form/output/button and reviewed control attributes. A flat template's
  runtime operands are text there (escaped, as in projected markup); in attributes they refuse. A link targets this
  browsing context only. A form holding a text or password input refuses (Enter submits it; native forms never
  submit). Comments, other tags, textarea content and other dynamic markup with controls refuse; whitespace between
  options is not kept.
- ARIA has no native accessibility bridge.
- `createElementNS`: SVG svg/path/rect/circle/line/ellipse/polyline/polygon and text (its text or one textPath),
  rasterized at CSS size by RmlUi's SVG plugin. Presentation properties (fill, stroke and its width, caps, joins,
  opacities, paint order) cascade from stylesheets over attributes; currentColor is the root's color. A textPath's
  glyphs are placed along its path in the face the UI font resolves. Pointer listeners hit painted geometry (fill,
  stroke band, glyph cells; `pointer-events` auto/none, a listener opting in as on HTML elements) and
  getBoundingClientRect reads its bounds. Listeners without DOM input, nested SVG, tspan and paint servers refuse.

## Canvas2D

Backing dimensions, scale, full clear, fillRect/strokeRect, bounded paths, putImageData, destination-rect drawImage,
bounded fillText. A canvas kept in a record, container or class field, and a 2D context kept in a class field, keep
their roles. Offscreen pixels are premultiplied RGBA; closed producers can bake `getImageData`. Partial clear,
source-rect blits, general transforms/clipping and non-convex tessellation refuse.

## CSS

| Area | Admitted | Refuses |
| --- | --- | --- |
| Box | `display` block/inline/inline-block/flow-root/flex/inline-flex/table parts/grid/inline-grid (an unclamped `-webkit-box` is flex along `-webkit-box-orient`), fixed/inset, px/rem/viewport calc/min/max/clamp (also over `var()`, with times and angles), percentages in that math for sizes, margins, padding, insets, flex basis and gaps (one min/max/clamp level over them), `env()` safe-area insets (the window's under `viewport-fit=cover`, else 0), box sizing, physical and horizontal-LTR logical edges, float/clear, `aspect-ratio`, `zoom` numbers/percentages (also over `var()`; offset, client and scroll reads unzoomed) | Other `display` values, `-webkit-box-*` alignment and flex longhands; vertical/RTL logical mapping, element-font-relative math, other units in math, percentages in math elsewhere or nested past one min/max/clamp level, other `env()` variables without a fallback; `aspect-ratio` on replaced elements, grid items and flex items with both sizes auto in a stretched definite row; `zoom` math and keywords |
| Flex | Wrap, direction, grow/shrink/basis, alignment, gaps, `order` (layout and paint order) | Intrinsic basis keywords, `order` on grid items |
| Grid | Line placement, spans, named areas (`grid-template-areas`, `grid-area`), auto/fr/minmax with px/em/rem/vw/vh lengths, repeat/auto-fit/auto-fill (≤256 tracks/axis) | Named lines, subgrid, percentage tracks |
| Containers/media | inline-size containment, unnamed max-width queries; `and` of px min/max width and height, orientation, reduced-motion, hover and pointer media (hover/pointer: the device's primary pointer, read at run time; `prefers-reduced-motion` and `hover` also bare) | Named/height/style queries; `any-hover`/`any-pointer`, `or`/`not`/lists |
| Text | Wrapping, italic, casing, ellipsis, legacy line clamp (vertical `-webkit-box` + `-webkit-line-clamp`: the box ends at line N, which ends in an ellipsis when lines follow), vertical-align keywords, decoration lines | An ellipsis after a non-text box ending the clamp line; oblique, decoration colors/styles, vertical-align lengths |
| Borders/backgrounds | Solid and dashed borders and outlines (Chromium's dashes; `none`/`hidden` sides have no width), radii, gradients (`background`, `background-image` and run-time `style.background`; sized layers repeat in both axes), one packaged image (PNG, JPEG, WebP, or SVG that LunaSVG rasterizes, `data:` URLs included) at auto, contain, cover or two-length sizes, raster border-image slices | Dotted, double, groove, ridge, inset and outset lines; elliptical radius syntax, multiple raster layers, sized raster repetition, one-axis or spaced gradient repetition, a gradient repeated under its border (`border-box` clip), `background-clip` beside sized gradients or as `content-box` beside any |
| Shadows/filters | Box shadows (px and viewport lengths, `vmin`/`vmax` included), filters, drop-shadow chains, backdrop blur; `opacity` below 1 composites the element and its descendants as a group | Other shadow length units, other backdrop functions (may degrade) |
| Transforms/clipping | Uniform nonnegative scale; `clip-path` inset()/polygon() over px/%/calc() (aliased edges) | Nonuniform scale, nonempty clip rectangles, other basic shapes, `round`, reference boxes |
| Motion | `transition`/`animation` shorthands (s/ms; easing keywords, `cubic-bezier()`, `steps()`; animation directions and fill modes), `transition-delay`/`animation-delay` lists (negative delays start part-way), nonnegative `transition-duration` and positive `animation-duration` lists; inline style, cssText and removal writes transition like rule changes; `filter` lists interpolate per function; keyframes lower as rules do, `background-position` included (gradient text follows it) | `linear()` easing, `paused`, fractional or zero iteration counts, zero-duration animations, other transition/animation longhands; keyframe strings and lists (images, sizes, repeats, font families, shadows, grid tracks, border images, aspect ratios, cursors, custom properties) |
| Selectors | Tags/IDs/classes, attribute presence/equality, combinators, state pseudo-classes, An+B, `not/is/where/has`, `::before/::after` | Nested `:has`, wider attribute operators, counters |
| Other | `!important`, CSS-wide keywords in rules, inline styles and keyframes (`inherit`: the parent's computed value; `initial`: CSS's initial value, CanvasText per scheme, medium and currentcolor borders included; `revert`/`revert-layer`: the user-agent sheet's declaration; on a shorthand every longhand, `font`'s line height included; a custom property's `initial` the guaranteed-invalid value), custom properties (`--bbl-` reserved), space-separated `rgb()`/`rgba()`, scrollbars, overscroll, unmarked lists, `color-scheme`, opaque `accent-color` (a `var()` one checked at run time) | Runtime-generated stylesheet text, list markers, translucent accents |

In [deferred mode](features.md#deferred-capabilities), registered missing CSS properties and grid-track forms throw at
the write; host-page sheets still need admission.

## Fonts

- DirectWrite on Windows, including text effects through RmlUi's effect kernels; FreeType with CoreText
  (macOS/iOS), Fontconfig (Linux) or Android discovery.
- Color glyphs: CoreText on iOS, Android's text renderer. Android bundles Noto Sans Symbols 2.
- Missing glyphs fall back per glyph. Sizes stay fractional (FreeType quantizes to 1/64 px); sizes above 16384 px refuse.
- Font selection, kerning, line-height rounding and rasterization can differ from Chromium.
- Gradient-clipped text uses per-glyph averaged colours, not a continuous gradient; its text strokes use RmlUi's
  outward outline.

## Rendering

- Every driver draws the page UI multisampled in its target's format: the first run over an untouched destination
  resolves into it, later runs into a transparent layer composited over it; engine canvases blend between runs. Canvas
  overlays precede DOM chrome.
- Without `viewport-fit=cover` the page lays out in the window's safe rectangle; the window paints the rest with the
  canvas background (the root's, else the body's, over the scheme's Canvas colour). Chromium 156 under CDP safe-area
  emulation keeps the whole window for every fit.
- An engine canvas beneath the UI is an opaque rectangle; a rounded, transformed, translucent, filtered, masked,
  clip-path or overflow-clipped engine canvas refuses.
- Backdrop blur snapshots preceding UI into FP16 scratch.
- Disjoint opacity paint folds alpha into vertices after clipping; overlapping groups use paint-bounded targets.
  Nested effects and backdrop reads retain their ordered composites.
- The ring around a focused canvas is drawn natively and yields to an author outline: the unhosted engine canvas has
  no element a UA style rule could match.

## Limits

- General mask-image and unsupported blend modes refuse.
- will-change, touch-action, user-select and image-rendering are hints; only `-webkit-user-drag: none` and
  `-webkit-touch-callout: none` are admitted.
- `element.animate` is a no-op.
- Retained UI is unavailable under standalone effect/frame-graph drivers.
- Only backdrop-filter, filter, mask and opacity elements are backdrop roots (none for clip-path, mix-blend-mode).
- Backdrop blur samples beyond the border box where Chromium mirrors.
- The page UI renders at 4x MSAA whatever the engine's `msaaSamples`; Chromium antialiases analytically.
- A rounded dashed border thicker than its radii dashes along its centerline where Chromium strokes those sides
  straight; with unequal side widths its dash ends at the corners follow the radii, not the centerline's normal.
- Only box-shadow writes are checked against the CSS grammar; other invalid values refuse or are stored as written.
- A scene canvas hides page paint beneath it even when it clears translucent.
- Text/sprite renderers present an authored engine canvas only while it fills the page viewport.
