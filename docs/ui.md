# Native page UI

`bblitec` lowers the browser UI surface reached by supported Babylon Lite
scenes into a typed retained UI IR. The PAL projects that IR into RmlUi, and
the SDL_GPU and Dawn renderers consume the same backend-neutral draw frame.
This is a bounded compatibility surface, not a general DOM or HTML canvas.

## Integration

The `ui:rml` feature is selected only when compilation reaches supported UI
operations. It adds the RmlUi projection, FreeType, platform font discovery,
and renderer integration. Bounded inline markup additionally selects
`ui:inline-svg`, and CMake requires the pinned RmlUi artifact's LunaSVG plugin.
Builds without reached UI include none of these components.

Scene-created controls are lowered from the original TypeScript. Static chrome
owned by a browser host page can be represented by a reviewed JSON companion,
such as `ui/racer-host.json`. The companion enters the same retained IR and
does not modify the application source.

The supported applications cover retained labels and buttons, complete game
HUDs, Canvas2D overlays, bitmap cursors, CSS animation, and host-page chrome.
LibreQuake includes the broadest Canvas2D case: its `SbarHud` decodes QPIC
assets from `gfx.wad` and composes the status bar through retained canvas
commands.

## DOM and events

The compiler accepts:

- `document.createElement(<static tag>)`;
- `textContent`, `innerText`, bounded `innerHTML`, `className`, `id`, and
  `type`;
- an object-URL `href` plus `download` on `<a>`, and static `type="file"` plus
  `accept` on `<input>`;
- `style.cssText` and reached `style.<property>` writes;
- `setAttribute(<static name>, <runtime string>)`;
- `appendChild`, variadic `append`, root attachment, and `remove`;
- `classList.add`, `remove`, and forced `toggle(name, enabled)`;
- `querySelectorAll(".class")` on a statically-known retained root, with
  DOM-order `forEach(element, index)` over a statically complete subtree;
- `click`, `mousedown`, `pointerdown`, `pointerup`, `pointercancel`, and
  `lostpointercapture` listeners, plus `change` on a file input;
- the single native pointer id and pointer-capture calls reached by the
  supported applications;
- programmatic render-canvas `focus()`, including the browser's one-pixel
  focused-canvas outline in the full-page native frame.

RmlUi receives input before scene controls. Consumed UI events do not also
move the camera. Element records are patched in place, so hover, pressed, and
pointer-capture identity survive text and style updates.
`preventDefault()` is carried on the event while its callback executes.
RmlUi focuses before dispatching `mousedown`, so native restores the previous
focus only when that execution cancelled; a conditional cancellation does not
permanently make the element unfocusable.
Platform event objects are borrowed for one dispatch. A persistent callback
cannot capture one directly or through a retained record, tuple, container, or
closure value; copy the owned scalar field it needs instead.

### File transfer controls

File transfer is retained state but not RmlUi form handling. A programmatic
anchor click whose `href` is a live native object URL and whose `download` is
set opens the host save dialog, using a safe extension/MIME-derived filter and
the download name as its suggestion. Accepting writes the Blob bytes through
the PAL's randomized exclusive staging and atomic replacement; cancelling
leaves the destination untouched.
Ordinary URL navigation is outside the surface and refuses.

A programmatic `<input type="file">` click opens SDL3's host open dialog for
the static `accept` list. One accepted result is bounded before allocation and
becomes an opaque byte/display-name `FileList` snapshot before the registered
`change` callback runs once; cancellation preserves the prior `files` value and
dispatches nothing. Input, FileList, and File values share that snapshot.
Replacement and element removal release the input's ownership, while a retained
old File keeps its bytes until its final handle dies; all live selections share
a 256 MiB per-engine aggregate cap. `files[0]` is truthy only when selected, and
`File.text()` reads the immutable bytes rather than reopening a path.
Native dialog completion is synchronized, so the populated list and its
immediate `text().then(...)` callback run before `click()` returns; the
generated listener copies owned callback-local handles and shares mutable
outer cells. Multiple files, directory selection, wildcard, parameterized or
unmappable accept entries, and source-supplied paths refuse. Blob/object-URL
lifetime and the recorded ordering adaptation are defined in
[fidelity](fidelity.md).

`innerHTML` is parsed at generation, not handed through as arbitrary markup.
The accepted grammar is text plus `div`/`span` (static `class` and reviewed
`style`) and inline `svg` containing self-closing `path`/`rect` nodes with the
reviewed numeric, paint, stroke, view-box, and path-data attributes. Runtime
text substitutions are RML-escaped. Scripts, event attributes, links, foreign
elements, unquoted/dynamic attributes, and malformed nesting refuse with a
source location. RmlUi's pinned LunaSVG plugin rasterizes the vector at its
live CSS size; `currentColor` is carried through the inherited RmlUi colour as
an image tint. Because that tint applies to the whole image, an SVG mixing a
literal paint with `currentColor` refuses; `none` is non-paint. Selectors
targeting internal `path` or `rect` nodes likewise refuse because LunaSVG
receives those nodes as image data rather than RmlUi elements.

## Canvas2D

The retained Canvas2D surface includes:

- backing `width` and `height`, `getContext("2d")`, scale, and full-surface
  clear;
- `moveTo`, `lineTo`, `closePath`, `arcTo`, and `arc` paths;
- fill and stroke colour, width, join, and cap state;
- `putImageData(new ImageData(...))`;
- canvas-to-canvas `drawImage` with a destination rectangle;
- `imageSmoothingEnabled`;
- the bounded `fillText` surface reached by LibreQuake.

Offscreen canvases own a premultiplied RGBA backing store and content revision.
Canvas blits refer to retained element handles; the IR contains no SDL or Dawn
objects. Nearest and linear sampling intent is carried into both renderers.

## CSS, layout, and fonts

Inline styles, reviewed sheet rules, and reached `@keyframes` are
projected to RmlUi. Compatibility lowering covers:

- browser defaults for `div`, `canvas`, and `button`;
- system UI, sans-serif, and monospace family resolution;
- regular and weighted platform font faces;
- `position: fixed`, `inset`, positioned `calc()`, and density units;
- reached `font` and background shorthands;
- runtime-selected, root-relative `background: <color> url(...) center/cover`
  images, packaged at their reviewed logical paths;
- fractional `rgba()` alpha;
- linear and radial decorators, rounded borders, text effects, text shadows
  (glyph effects -- not box shadows), and per-glyph gradient text;
- reached CSS animation timing names and deterministic animation time.

Static style text is validated at generation against the reviewed property
surface: a property outside it refuses naming itself and the accepted sets.
`<style>` sheets accept exact `.class` and `#id` rules, two-class compounds,
the audited `#id .class` form, and `.ancestor tag` with optional `:hover`.
Class/tag descendants are accepted only after the complete retained
construction subtree proves at least one matching tag; the typed retained
selector keeps the ancestor scope, so unrelated tags cannot inherit it.
RmlUi evaluates the reached hover pseudo-class directly.

The same typed rules accept `@media (max-width:Npx)` for the reached position,
size, and font-size overrides. RmlUi evaluates them against the live context
and reevaluates after every SDL resize; CSS pixels are translated to its
density-independent units. Rules remain in source order, so ordinary
specificity, later overrides, and values such as `right:auto` and
`bottom:auto` retain the browser cascade. Scene-created sheets follow live
root attachment order, including remove/reappend, rather than element
allocation order. Private projection metadata uses the same selector
specificity before source order.

RmlUi 6.4 has no grid formatting context. The compiler accepts only
`display:grid` paired with `grid-template-columns:repeat(integer, px)`, a
static pixel gap, and direct children proven to have the matching fixed pixel
width, one fixed height, compatible min/max constraints, and no track-changing
margin, padding, or border. It
then uses a fixed-width wrapping flex child container, which is equivalent for
the reached regular grids. Optional fixed row tracks must match the child
height and the proven number of populated rows. The implementation container
uses a private tag so author descendant
selectors cannot match it; authored start/center/end track alignment is
retained, and a media, hover, or mutable-class rule that can change a grid
item's geometry makes the proof refuse. Every reachable mutable-class grid
shape is validated independently, and runtime-unknown class or id mutations
refuse only when they could activate a grid or alter one of its child proofs.
Explicit row templates additionally require every counted child to remain in
normal flow. Runtime grid-class transitions migrate the existing authored
children without recreating them. Each applied shape is named in
`substituted-ui-runtime`; any unprovable grid refuses.

Font paths are resolved through DirectWrite on Windows, CoreText on macOS, and
fontconfig on Linux. The UI layer contains no hardcoded font paths. Platform
font rasterization and browser font rasterization are not pixel-identical.

The pinned RmlUi carries two patches under `native/patches/`, each a
browser rule it did not implement, measured on the retained demos and
corrected in the library rather than compensated in the projection, so that
every element from every style source gets it:

- **`rmlui-css-box-model.patch`.** Two CSS rules. A background paints under
  the border (`background-clip: border-box` is the initial value) where
  RmlUi painted it under the padding box alone, so a translucent border read
  over the page instead of over its own panel -- tetris's
  `rgba(255,255,255,0.08)` rims measured 170 where the browser shows 63. And
  an absolutely positioned `width:auto` box with one horizontal offset
  shrinks to fit the width beside that offset (CSS 2.1 section 10.3.7), where
  RmlUi's shrink-to-fit width ignored the offset, so `left:50%` never wrapped
  -- the voxel sandbox's help line is two lines in the browser. A gradient
  background is an RmlUi decorator painted over the padding box after the
  border, so a translucent border over a gradient still composites over the
  page (platformer's boss pips).
- **`rmlui-premultiplied-rounding.patch`.** RmlUi premultiplies a byte colour
  by truncating `c·a/255` where Chrome's Skia rounds it (`SkMulDiv255Round`),
  so tetris's `rgba(10,12,20,0.75)` panel premultiplied to (7,8,14) against
  the browser's (7,9,15) -- one level dark on every translucent panel pixel.

The text itself is the remaining floor, and it is measured rather than
assumed. CSS computes `0.8rem` as 12.8 px; RmlUi's default font engine
truncates the size to a whole pixel on the way to FreeType, and FreeType
would round a TrueType face's ppem to a whole pixel regardless, because
Segoe UI, Arial and Consolas all set the `head` table's integer-ppem flag.
So a 12.48 px row renders at 12 px and measures 4--6% narrower than
DirectWrite's, which renders the fraction; passing the float size through
(a trial patch, measured and dropped) only turned truncation into nearest
rounding and cost tetris 0.1 MAD. Rendering the fraction would take an
`FT_Set_Transform` scale over the rounded ppem with advances read after it,
on top of the glyph rasterization difference itself.

## Rendering

RmlUi records CPU-side geometry, texture updates, scissors, and transforms.
Each GPU backend owns upload, caches, pipelines, multisample targets, and final
composition. CSS and Canvas geometry render into a transparent UI layer at the
scene sample count, resolve once, and premultiplied-alpha composite over the
single-sample scene. Glyph atlases retain filtered sampling.
Inline image decorators resolve relative URLs through the scene's packaged
asset directory. The projector keeps a minimal stylesheet container even when
the page supplies only inline styles, because RmlUi's decorator instancers are
owned by that container.

The UI path is integrated into the scene and sprite-only presentation loops.
The standalone fullscreen-effect and frame-graph drivers render no UI on
either backend, so generation refuses a program that reaches retained UI
under either driver. Resize and display-density changes update both the
RmlUi context and intrinsic layout measurements. Synthetic intrinsic widths
are cleared and recomputed on those changes, and yield whenever an active
authored width rule supplies the size.

## Capture and parity

Parity captures the full 1280×720 page by default, including the 3D canvas and
DOM/CSS UI. Native screenshots include the retained UI in the same image.
`docs/status.md` publishes these composite MAD values.

Set `BBLITE_CAPTURE_UI=0` for a canvas-only attribution run. Its references and
reports are written under `artifacts/parity-canvas/` beside the canonical
full-page gate. A scene whose UI dominates the composite MAD declares registry
`canvasThresholds`, and its parity run then measures and gates the canvas-only
pair as well — a 3D regression cannot hide under the UI residual. Status rows
above MAD 0.5 identify UI as the dominant residual and publish the
corresponding canvas-only MAD.

The deterministic browser harness pins request-animation-frame time,
`performance.now()`, timers, and CSS animation time at the configured capture
frame. Both native backends use the same pose.

## Limits

The accepted divergences below are also recorded in the
`substituted-ui-runtime` adaptation of every `ui:rml` scene's generated
`fidelity.json`; the refusals hold the rest of the boundary at generation.

- There is no general browser selector or HTML engine, measurement API,
  mutation observer, or arbitrary DOM traversal. Selector and markup parsing
  stop at the generation-validated forms above; RmlUi performs only their live
  cascade, hover, and media evaluation.
- Form values other than the bounded one-file picker, keyboard text input,
  JavaScript hover callbacks, multi-touch identity, and general event options
  are unsupported. Reached CSS `:hover` is supported.
- Tags and attribute names are static. Text, attribute values, and reached
  individual style properties may be runtime values; runtime style values
  flow to the projection unvalidated, while static property names are
  enforced at generation. This includes dynamic `border-color` writes used
  to mark selected retained-UI controls.
- Style properties outside the reviewed surface refuse at generation. A static
  `box-shadow: inset 0 0 0 <px> <color>` projects to the equivalent inside
  border on an out-of-flow retained child, preserving both the selection
  outline and the original element's content geometry. Other box
  shadows remain accepted with a recorded degradation and no native rendering,
  alongside `backdrop-filter` (and its `-webkit-` twin),
  `font-variant-numeric`, and the voxel sandbox crosshair's
  exact `mix-blend-mode:difference` (other blend modes still refuse). The
  crosshair's reviewed two-layer gradient shape itself projects to the same
  retained bar markup used by Doom; only the difference blend is degraded.
  Four reached hints are accepted
  as inert: `will-change`, `touch-action`, `user-select`, and
  `image-rendering` (canvas sampling intent rides the retained blit
  commands instead). "Shadows" in the supported surface means text shadows:
  `text-shadow` projects to glyph shadow/glow effects, and an unparseable
  shadow list refuses.
- `background-clip:text`, `background-size`, `-webkit-text-stroke`, and
  `filter: drop-shadow(...)` are consumed only by the gradient-text
  projection and refuse outside that combination, as do `color:transparent`
  and `display:grid` outside the statically-proven fixed-track combination.
- Web Animations `element.animate()` is a no-op; reached CSS `@keyframes` are
  supported, with `steps()`/`step-start`/`step-end` played as
  `linear-in-out` and the `ease*` family as `sine*`.
- Listener removal is a no-op because retained UI records share engine
  lifetime.
- Host-page companions are reviewed inputs, not automatic page discovery.
- Canvas overlays composite below the retained DOM chrome regardless of
  z-index (the recorder queues canvas geometry first, then RmlUi draws the
  interactive tree above it). The reached interleavings differ only for
  translucent full-screen flashes.
- Canvas2D excludes partial `clearRect` -- generation refuses a clear whose
  arguments are not provably the full surface (the canvas's own size reads,
  a const alias of them, a statically-assigned backing size, or the logical
  size a reached `scale()` maps onto the backing store) -- plus
  source-rectangle `drawImage`, general text shaping, clipping, arbitrary
  transforms, and general non-convex fill tessellation.
- Canvas geometry is tessellated from the retained command stream for each
  draw frame.
