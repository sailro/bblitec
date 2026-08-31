# Experimental native page UI

This branch tests a compiler bridge for the small browser UI surface reached by
Babylon Lite scenes. It is deliberately not a DOM implementation. The entry
compiler recognizes scene-created controls, lowers them to a typed retained UI
IR, and the PAL projects that IR into RmlUi. RmlUi records a backend-neutral
draw frame which the existing SDL_GPU and Dawn renderers consume.

## Implemented vertical slices

Scene 4 is the first proof case. Its unchanged TypeScript creates two buttons,
assigns inline styles and text, appends them to `document.body`, and installs
click handlers which mutate scene state and update their labels.

The racer demo is the broader case. It exercises helpers and class fields that
retain elements, nested/variadic append, dynamic attributes and style
properties, removal, a returned callback whose initializer closes back over
that callback, timer-driven text, and mouse/touch-shaped pointer handlers. The
compiler handles its pinned upstream source without a racer-specific rewrite.

The reached racer surface is:

| Component | Browser surface | Experimental native result |
| --- | --- | --- |
| camera mode label | retained `div`, dynamic text | retained RmlUi label |
| vehicle selector | `div`/`button`, click, dynamic styles | five interactive retained buttons |
| race timer | nested `div`/`span`, dynamic text | retained, updated timer panel |
| countdown | timer, text/color mutation, `remove`, Web Animations | text/color/removal retained; animation call is a no-op |
| touch controls | buttons, pointer events, attributes, class toggles | single-pointer SDL/RmlUi event mapping |
| host help and credit | static browser-page DOM/CSS outside the scene module | audited retained-tree companion |
| minimap | live Canvas2D | retained path/fill/stroke command stream |
| speed lines | live Canvas2D | retained per-frame stroked paths |

The compiler currently accepts:

- `document.createElement(<static tag>)`, including retained overlay canvases
- `element.textContent`, `innerText`, `className`, `id`, and `type`
- `element.style.cssText` and runtime `element.style.<property>` writes
- `element.setAttribute(<static name>, <runtime string>)`
- `appendChild`, variadic `append`, root attachment, and `remove`
- `classList.toggle`
- `click`, `pointerdown`, `pointerup`, `pointercancel`, and
  `lostpointercapture` listeners
- the single native pointer id and pointer-capture-shaped calls needed by
  racer; RmlUi owns the actual pressed-element dispatch
- the racer Canvas2D slice: backing `width`/`height`, `getContext("2d")`,
  scale, full-surface clear, paths (`moveTo`, `lineTo`, `closePath`, `arcTo`,
  `arc`), fill/stroke, and their reached colour/width/join/cap state

These calls reach the `ui:rml` feature. Only then does generated output include
`pal_ui_rml.cpp`, fetch the pinned RmlUi revision, enable FreeType, and link the
RmlUi core statically. A scene with no reached native UI carries none of it.
Host-page lookups and instrumentation remain browser-only and erase as before;
only handles returned by a recognized scene `createElement` call enter this UI
surface. A registered scene may additionally name an audited JSON companion for
static host-page chrome. The companion is lowered into the same browser-neutral
IR and keeps the pinned application TypeScript byte-identical.

## Runtime shape

The browser-neutral half is an engine-owned array of element records: tag,
text, attributes, dynamic style properties, parent/children, root attachment,
native event closures, and bounded canvas draw commands. Mutations increment a
revision. The RmlUi projection patches existing elements and text nodes in
place, preserving hover, pressed-element, and pointer-capture identity across
per-frame timer updates. Added and removed subtrees are projected separately.

The PAL owns RmlUi, SDL event translation, system-font selection, and a
CPU-side draw recorder. RmlUi receives input before the scene and consumed
events do not also move the camera. Each existing GPU renderer owns upload,
texture caching, pipelines, targets, sample count, and composition. The overlay
renders after the 3D frame in both the frame-graph and legacy presentation
paths.

Both backends render CSS and Canvas geometry into a transparent UI layer at
the scene's selected sample count (normally 4x), resolve that layer, and
premultiplied-alpha composite it over the final single-sample scene. This keeps
the scene resolve untouched while applying coverage antialiasing to rounded
CSS silhouettes and Canvas path edges. Font glyphs additionally retain their
filtered atlas smoothing.

Inline style text is passed through with explicit compatibility lowerings:

- the browser user-agent defaults reached by this experiment make `div` and
  `canvas` block elements and `button` an inline block;
- a host companion can contribute bounded exact-class rules below inline style
  priority; racer uses this to retain the desktop `display:none` rule for its
  touch-control root;
- generic `sans-serif` selects an available platform font;
- the regular and bold faces of that system family are loaded, and a browser
  fallback family list is resolved to the one native family;
- `position: fixed` becomes viewport-relative absolute positioning;
- zero `inset` expands to four offsets, and unsupported `backdrop-filter` is
  omitted;
- the reached browser `font` shorthand expands into RmlUi properties;
- browser `background` colour shorthand maps to `background-color`, and
  fractional `rgba()` alpha maps to RmlUi's 0..255 alpha convention;
- the compiler turns positioned `calc(P% +/- Npx)` offsets into a percentage
  offset plus a same-side pixel margin, because RmlUi 6.4 does not parse that
  browser form.

## Capture and validation

Ordinary parity remains canvas-only, matching the browser harness. Set
`BBLITE_CAPTURE_UI=1` together with `BBLITE_SCREENSHOT` to opt into a native
scene-plus-UI diagnostic capture.

Scene 4 has been exercised through an actual SDL mouse event. RmlUi
hit-tests the first scene 4 button, invokes the lowered TypeScript callback,
changes its label from `Rotate Torus: OFF` to `Rotate Torus: ON`, and the torus
rotates before the diagnostic capture.

Racer has been built and captured through both SDL_GPU and Dawn with its
retained overlay. Their completed 4x captures have MAD 0.0007 against each
other. A deterministic input replay switches from the yellow truck to the
motorcycle and cycles the camera from Chase to Hood; both the 3D vehicle/camera
and the retained selector/label state change. A later capture shows the
countdown removed, the race timer updating, and the live circuit minimap. A
delayed mouse test holds a selector button down across hundreds of timer
mutations before releasing it; the click still selects the motorcycle because
the pressed element is no longer rebuilt between events.

## Deliberate limits

This is an experiment, not a newly supported browser platform:

- No general selectors, HTML parsing, stylesheet cascade bridge, measurements,
  mutation observers, browser globals, or arbitrary DOM traversal.
- No form-value model, keyboard/text input surface, hover callbacks, multi-touch
  identity, or general event options.
- Tags and attribute names are static. Text, attribute values, and reached
  individual style properties can be runtime values.
- `animate()` is a deliberate no-op in this slice. Racer retains each
  countdown state transition but not its scale/fade tween.
- Listener removal is a no-op because the retained element records share the
  engine lifetime in the experiment.
- Racer's browser host help/credit and desktop touch-control rule are recorded
  in `ui/racer-host.json`; this is a manual audited companion, not automatic
  host-page discovery.
- Canvas2D is a narrow retained command IR, not an HTML canvas. Partial
  `clearRect`, images, text, gradients, clipping, arbitrary transforms, and
  non-convex fill tessellation are not implemented. The reached racer paths
  use the supported subset.
- Canvas geometry is rebuilt for drawing each frame; caching and a general
  z-order integration remain production work.
- Platform fonts are used, so text metrics are not browser-pixel-identical.
- Composite browser/native UI parity is not a gate; default parity still
  compares only the canvas.

The next useful step is to run the corpus audit against these exact concepts,
then add only the next high-frequency property, event, layout adaptation, or
Canvas command. Deterministic Canvas2D assets should continue to be executed
and baked at generation rather than entering this live overlay path.
