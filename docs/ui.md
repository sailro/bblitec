# Native page UI

`bblitec` lowers the browser UI surface reached by supported Babylon Lite
scenes into a typed retained UI IR. The PAL projects that IR into RmlUi, and
the SDL_GPU and Dawn renderers consume the same backend-neutral draw frame.
This is a bounded compatibility surface, not a general DOM or HTML canvas.

## Integration

The `ui:rml` feature is selected only when compilation reaches supported UI
operations. It adds the RmlUi projection, FreeType, platform font discovery,
and renderer integration. Builds without reached UI include none of these
components.

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
- `textContent`, `innerText`, `innerHTML`, `className`, `id`, and `type`;
- `style.cssText` and reached `style.<property>` writes;
- `setAttribute(<static name>, <runtime string>)`;
- `appendChild`, variadic `append`, root attachment, and `remove`;
- `classList.toggle`;
- `click`, `pointerdown`, `pointerup`, `pointercancel`, and
  `lostpointercapture` listeners;
- the single native pointer id and pointer-capture calls reached by the
  supported applications.

RmlUi receives input before scene controls. Consumed UI events do not also
move the camera. Element records are patched in place, so hover, pressed, and
pointer-capture identity survive text and style updates.

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
- fractional `rgba()` alpha;
- linear and radial decorators, rounded borders, text effects, text shadows
  (glyph effects -- not box shadows), and per-glyph gradient text;
- reached CSS animation timing names and deterministic animation time.

Static style text is validated at generation against the reviewed property
surface: a property outside it refuses naming itself and the accepted sets.
`<style>` sheets accept exact `.class` and `#id` rules, the audited
`#id .class` descendant form, and `@keyframes` blocks; any other selector
refuses by name. A descendant rule is projected as a global class rule (the
retained IR carries no scoped rules), which is exact for the reached sheets
because they attach those classes only inside the id's own subtree; the
projection is recorded in the scene's `substituted-ui-runtime` adaptation,
and two rules that would collide on one global class refuse.

Font paths are resolved through DirectWrite on Windows, CoreText on macOS, and
fontconfig on Linux. The UI layer contains no hardcoded font paths. Platform
font rasterization and browser font rasterization are not pixel-identical.

## Rendering

RmlUi records CPU-side geometry, texture updates, scissors, and transforms.
Each GPU backend owns upload, caches, pipelines, multisample targets, and final
composition. CSS and Canvas geometry render into a transparent UI layer at the
scene sample count, resolve once, and premultiplied-alpha composite over the
single-sample scene. Glyph atlases retain filtered sampling.

The UI path is integrated into the scene and sprite-only presentation loops.
The standalone fullscreen-effect and frame-graph drivers render no UI on
either backend, so generation refuses a program that reaches retained UI
under either driver. Resize and display-density changes update both the
RmlUi context and intrinsic layout measurements.

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

- There is no general selector engine, HTML parser, browser stylesheet
  cascade, measurement API, mutation observer, or arbitrary DOM traversal.
- Form values, keyboard text input, hover callbacks, multi-touch identity, and
  general event options are unsupported.
- Tags and attribute names are static. Text, attribute values, and reached
  individual style properties may be runtime values; runtime style values
  flow to the projection unvalidated, while static property names are
  enforced at generation.
- Style properties outside the reviewed surface refuse at generation. Four
  reached properties are accepted with a recorded degradation and no native
  rendering: `backdrop-filter` (and its `-webkit-` twin), `box-shadow`
  (the recorder exposes no render layers; the PAL filters dynamic writes
  identically), and `font-variant-numeric`. Four reached hints are accepted
  as inert: `will-change`, `touch-action`, `user-select`, and
  `image-rendering` (canvas sampling intent rides the retained blit
  commands instead). "Shadows" in the supported surface means text shadows:
  `text-shadow` projects to glyph shadow/glow effects, and an unparseable
  shadow list refuses.
- `background-clip:text`, `background-size`, `-webkit-text-stroke`, and
  `filter: drop-shadow(...)` are consumed only by the gradient-text
  projection and refuse outside that combination, as do `color:transparent`
  and `display:grid` outside their reached combinations.
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
