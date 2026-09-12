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
`matchMedia` accepts resolution in `dppx` and `prefers-reduced-motion` (`reduce`,
`no-preference`, or the boolean form). Results retain identity through typed records
and nullable values; `matches` reads current state and `media` returns the normalized query.
Zero-argument `change` listeners run when the result changes. Other query forms,
event payloads and listener removal are unsupported. Motion queries share the
platform preference and refresh interval described under CSS below.
The application `document` can be passed through specialized dependency records with a stable identity
distinct from `window`; reached DOM operations remain limited to the projection below.
DOM handles stored in records, arrays, nullable fields and helper parameters retain the document owner.
In a Window application this is the Window document, even when a rendering engine is also in scope;
synchronous scenes use their scene engine.
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
| Construction | Static-tag createElement, appendChild, mixed text/element append, root attachment, remove |
| Content | textContent/innerText, bounded innerHTML, className/id/type, static attributes |
| Styles/classes | cssText, reached style fields, classList add/remove/forced toggle |
| Queries | Static class query on a known complete retained subtree; Window document ID lookup returns the first attached match in tree order, or null |
| Input | Reached click/mousedown/pointerdown/up/cancel/lost-capture callbacks; one pointer |
| Focus | Control/canvas focus, focus listeners, activeElement identity, button navigation |
| Text forms | Retained input/textarea value and input callbacks; textarea editing and vertical resize |
| Range forms | Retained value/input callbacks and native range widgets |
| Files | Object-URL download anchors and static single-file inputs |

Boolean `hidden` reads and writes reflect attribute presence; clearing it restores the authored
display rules. Author CSS can override its default `display:none`, following the
[HTML hidden contract](https://html.spec.whatwg.org/multipage/interaction.html#the-hidden-attribute).
The `until-found` state requires find-in-page behavior and is refused.

Boolean `disabled` reflects attribute presence on buttons, inputs and textareas.
Disabled controls cannot focus or activate through pointer input or `click()`;
re-enabling a control preserves its identity and listeners.

`append` evaluates arguments before insertion and retains literal text in order beside controls.
Adjacent text uses one layout run, including anonymous flex items; changing the parent layout
preserves its controls. Setting `textContent` or `innerHTML` replaces the prior children.

UI receives pointer input before cameras. Consumed events do not move cameras;
Window keyboard listeners run before default UI actions. `preventDefault`
suppresses those actions and camera propagation. Retained elements preserve
focus/hover/capture identity. Borrowed events cannot escape dispatch; copy
owned scalar fields.

Optional calls on nullable retained elements evaluate the receiver once, skip
arguments when it is absent, and keep its original handle through argument effects.
ID lookup classification does not execute the source ID expression.

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
deterministic CSS animation. Inherited `overflow-wrap` (`word-wrap`) supports `normal`, `break-word`
and `anywhere`; `word-break` supports `normal`, `break-all` and `break-word`. They use the native
line breaker and honor `white-space`; browser min-content sizing is not modeled.
Flex containers support wrapping and reversed directions, item grow/shrink/basis,
numeric `flex` shorthands, `flex-flow`, line/item alignment, and separate row/column gaps.
`start`/`end` alignment follows the physical axis when flex direction or wrapping reverses.
Physical padding and margin longhands retain native box sizing and auto margins.
These additional layout values require literal keywords or lengths; CSS math and intrinsic basis keywords refuse.
Live style writes retain their order across shorthands and longhands. An empty value removes the local
declaration, and replacing `cssText` restores the authored declaration list.
Standard `scrollbar-width` supports `auto` (16 density-independent pixels),
`thin` (8), and `none` (hidden while content remains scrollable). `scrollbar-color` accepts `auto`
or two literal RGB/hex/named colors and inherits through retained markup. Supported vendor pseudo-elements
are `::-webkit-scrollbar`, `-thumb`, `-track`, `-button`, and `-corner`, with optional hover;
non-auto standard width or colors take precedence. Orientation-specific states, track-piece and resizer pseudo-elements are unsupported.
Native scrollbar geometry and control appearance remain platform adaptations.
Solid backgrounds support `background-clip:border-box/padding-box/content-box`; image and gradient clipping remain unsupported.
Static `border-image` raster URLs use packaged assets with stretch slicing and an unpainted center.
Slices accept numbers or percentages; widths accept border-width multipliers, px, percentages or `auto`.
Widths track layout changes and share one reduction factor when opposing borders overlap.
The `border` shorthand resets the image. Nonzero outset, center fill, repeated tiles, SVG sources,
individual border-image longhands and runtime-generated image declarations are unsupported.
Raster images support `object-fit:fill/contain/cover/none/scale-down`, centered in their content box.
Fitting preserves the CSS layout size and clips the image and texture coordinates at that box;
source changes, live styles, resizing and display scaling update the painted image.
This follows [CSS object sizing](https://www.w3.org/TR/css-images-3/#the-object-fit).
`object-position` remains unsupported; retained Canvas2D currently accepts `fill` only.

Selectors are bounded class/id/compound and proven ancestor forms, with optional
hover, active and focus-visible states, shared by CSS text and host UI rules.
Direct-child forms `tag > .class` and `tag > .class.other` match the immediate
retained parent and follow live class changes and reparenting. Reparenting retains
the rendered element, its listeners and state. The current virtual document root
has the `body` tag; distinct HTML/head/body root identities remain unmodeled.
[Tag-only projection](../src/compiler/ui-projection.ts) is unsupported. Static selectors/properties are
validated; source/sheet order and live max-width rules are retained.
Reduced-motion media rules support `reduce` and `no-preference` through the same cascade.
On Windows, they follow the system [client-area animation preference](https://learn.microsoft.com/en-us/windows/win32/winauto/client-area-animation),
checked about once per second while the UI runs.
Other platforms currently refuse when this preference is reached.
Stylesheet strings can be assembled by closed helpers over literal scalars and option records;
argument effects execute once. Runtime-generated stylesheet text remains unsupported.
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
| `rmlui-flex-layout.patch` | Flex shorthand defaults, unordered flow resets and start/end alignment under reversal |
| `rmlui-solid-background-clip.patch` | Solid border/padding/content-box clipping and invalidation after style changes |
| `rmlui-textured-borders.patch` | Stretch raster border slices, live widths and CSS overlap reduction |
| `rmlui-premultiplied-rounding.patch` | Browser-oriented color/opacity rounding |
| `rmlui-fractional-letter-spacing.patch` | Fractional default-font accumulation; excludes HarfBuzz sample |
| `rmlui-line-leading.patch` | Floor upper half-leading; preserve authored fractional textarea line height |
| `rmlui-object-fit.patch` | Raster-image fitting, centered geometry and content-box texture cropping |
| `rmlui-overflow-wrap.patch` | Inherited emergency wrapping independent of word-break |
| `rmlui-transform-key-ownership.patch` | Own mutable transition keys; preserve shared relative transforms |

Relative transition units resolve at transition start. Fully responsive
relative-unit interpolation, gradient border compositing and exact browser
font rasterization are not guaranteed. Rebuild patched libraries before checks.

## Rendering

Both backends composite a premultiplied transparent layer at scene sample count.
Backdrop blur snapshots preceding UI, uses FP16 scratch targets and clips before
later UI. Resize/density updates intrinsic measurements. Canvas overlays sit
below DOM chrome.

Ordinary CSS filters render nested element subtrees into retained layers. Color
adjustments (brightness, contrast, grayscale, invert, opacity, saturate, sepia,
hue-rotate), pixel blur and drop-shadow chains preserve declaration order on both
backends. Drop shadows require an explicit hex, basic RmlUi named color, or comma
RGB/RGBA color with integer channels and fractional alpha. Filter functions are space-separated.
Static declarations and live style writes share the native compositor. Filtered
subtrees may contain backdrop blur; canvas-only capture excludes UI filters.

## Limits

Single-row inline grids support positive px/fr tracks with one element child per track.
Runtime track replacement and implicit extra rows refuse. Form dimensions support content-box and border-box.

- No general selectors/traversal/observers, full browser form semantics, JavaScript hover callbacks,
  multiple pointer identities or arbitrary events.
- Supported inset outlines become borders; other shadows/font-variant-numeric
  can degrade. General grid and unsupported text-shadow forms refuse.
- The reviewed difference-blend crosshair degrades; other unsupported blend
  modes refuse. Saved layer textures and general mask-image filters are unsupported.
- blur(px)/none are supported; other reached backdrop functions can degrade.
- will-change, touch-action, user-select and image-rendering are accepted hints.
- element.animate and listener removal are no-ops; CSS keyframes use mapped easing.

Parity measures the [full page](fidelity.md#what-is-measured-the-full-page);
do not infer that every UI residual is unavoidable.
