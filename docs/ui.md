# Native page UI

The compiler lowers a bounded scene-created DOM/CSS/Canvas2D surface into
typed retained operations. RmlUi projects them into one backend-neutral draw
frame, consumed by SDL_GPU and Dawn. This is a compatibility surface, not a
general browser.

## Integration

`ui:rml` selects RmlUi, FreeType, platform fonts and renderer integration.
`ui:inline-svg` additionally requires LunaSVG. Static shipping artifacts
separate core UI from SVG; the complete development artifact includes SVG.
Scene feature selection and minimal dependency checks are documented in
[development](development.md).

Scene-created controls come from the original TypeScript. Reviewed
`ui/*.json` companions represent static host-page chrome through the same IR.
They are explicit inputs, not automatic browser-page discovery.

## DOM and events

| Area | Supported surface |
| --- | --- |
| Construction | Static-tag createElement; appendChild/append, root attachment and remove |
| Content | textContent/innerText, bounded innerHTML, className/id/type, static-name attributes |
| Styles/classes | cssText and reached style properties; classList add/remove/forced toggle |
| Queries | Static class query on a known root with a complete retained subtree |
| Input | Reached click/mousedown/pointerdown/up/cancel/lost-capture callbacks; one pointer id |
| Focus | Retained control/canvas focus, focus listeners, activeElement identity, button focus navigation |
| Files | Object-URL download anchors and static one-file inputs |

UI receives pointer input before scene camera controls. Consumed UI events
must not also move the camera. Window keyboard listeners run before default
UI actions; preventDefault suppresses those actions and camera propagation.
Element records update in place, preserving focus, hover and capture identity.
Borrowed event objects cannot escape their dispatch; copy owned scalar fields
into retained state.

Button descendants share their button's focus target. A press/release within
the button activates it; release outside cancels. Conditional mousedown
cancellation restores prior focus for that event. Cursor ownership follows
pointer events, including restoring visibility when leaving a hidden canvas
cursor.

### File transfer controls

A live native object URL plus anchor `download` opens the host save dialog.
Accepted Blob bytes publish through randomized exclusive staging and atomic
replacement; cancellation writes nothing. Arbitrary URL navigation refuses.

A file input accepts one selection and snapshots bytes/display name before
dispatching its change callback. Cancellation preserves the previous selection
and emits no callback. Input/FileList/File values share the immutable snapshot;
replacement/removal releases their references while retained old File values
keep their bytes. Reads enforce a per-file bound and a 256 MiB per-engine
live-selection cap. File.text reads the snapshot, never a source-supplied path.

Native picker completion is synchronized: the change listener and immediate
text continuation can run before click returns. This ordering is an explicit
adaptation. Multiple files, directories, wildcard/parameterized/unmappable
accept entries and source-selected paths refuse.

### Markup

innerHTML parses at generation. It accepts text, bounded div/span markup and
reviewed inline svg/path/rect attributes; runtime text is escaped. Scripts,
event attributes, arbitrary elements, dynamic attributes and malformed nesting
refuse. LunaSVG rasterizes inline vectors at live CSS size. currentColor tints
the image, so mixing it with literal paint and selecting internal path/rect
elements refuse.

## Canvas2D

The retained slice includes backing dimensions, a 2D context, scale,
provably full-surface clear, paths (move/line/close/arcTo/arc), reached fill and
stroke state, putImageData, canvas-to-canvas destination-rectangle drawImage,
sampling intent and bounded fillText.

Offscreen canvases retain premultiplied RGBA pixels and content revisions.
The IR carries element handles and sampling state, not GPU objects.
Partial clear, source-rectangle blits, general text shaping/clipping,
arbitrary transforms and general non-convex tessellation are unsupported.
Geometry is tessellated from the retained command stream for each draw frame.

## CSS, layout, and fonts

The projection supports the reviewed property surface: browser defaults for
reached tags, platform font families/weights, fixed positioning/inset/calc,
reached shorthands, packaged backgrounds, alpha colours, gradients, rounded
borders, text effects and deterministic CSS animation.

Stylesheet selectors are bounded: class/id, two-class compounds, reviewed
id/class descendants and statically proven ancestor-class/tag forms with
optional hover. Source order, specificity, attached-sheet order and live
max-width media evaluation are retained. Runtime style values pass through
the projection; static property names and static values are validated.

Fixed grids lower only when static repeat(integer, px) tracks, gaps and
child geometry prove equivalence to wrapping flex. Track-changing styles,
unknown class/id mutations and unsupported geometry refuse. The private
container does not match author selectors; mutable proven shapes migrate
existing children without recreating them.

Fonts resolve through DirectWrite, CoreText or fontconfig, with platform emoji
fallback where available. No hardcoded font paths are required. General
emoji/ZWJ shaping is outside the default RmlUi font engine.

Maintained patches under `native/patches/` adapt the installed RmlUi:

| Patch | Compatibility behavior |
| --- | --- |
| `rmlui-css-box-model.patch` | Solid background under borders; shrink-to-fit sizing beside an absolute horizontal offset |
| `rmlui-premultiplied-rounding.patch` | Browser-oriented colour/opacity rounding while preserving premultiplied constraints |
| `rmlui-fractional-letter-spacing.patch` | Fractional accumulation in the default font engine's width/geometry path |

These are compatibility choices. RmlUi documents padding-area background
painting, and CSS does not prescribe the browser's exact byte-rounding
algorithm. Do not characterize every difference as a violation of RmlUi's
contract. The letter-spacing patch does not cover its separate HarfBuzz sample.

After changing a maintained patch, rebuild the installed RmlUi library before
testing UI scenes. Regeneration alone does not update dependency binaries;
use the build commands and explicit install-root override in development.

Fractional font sizing, glyph rasterization and shaping still differ from the
browser. This is a known mechanism, not a claim that every UI residual is an
unavoidable floor. Gradient decorators also retain separate border-compositing
limitations.

## Rendering

RmlUi records geometry, texture updates, scissors, transforms and ordered
backdrop stages. Both renderers draw a transparent UI layer at the scene
sample count and composite with premultiplied alpha. A backdrop blur resolves
preceding UI, snapshots the accumulated image, uses cached FP16 scratch
targets and clips against scissor/clip geometry before later UI.

Scene and sprite-only drivers integrate UI. Standalone effect and scene-less
frame-graph drivers currently refuse it during generation. Resize/density
changes update RmlUi and intrinsic measurements. Packaged image decorators
resolve through the scene's asset directory.

Canvas overlays render below retained DOM chrome regardless of arbitrary
z-index interleaving. This is a recorded limitation for translucent flashes.

## Capture and parity

[Fidelity](fidelity.md#what-is-measured-the-full-page) owns the full-page versus
canvas-only measurement contract; [status](status.md) publishes results and
[debugging](debugging.md) owns capture commands. Font/layout differences must
not hide a scene-rendering regression under a permissive composite threshold.

## Limits

In addition to the bounded grammar above, `substituted-ui-runtime` records:

- No general selectors, DOM traversal, mutation observers, live text/form input,
  JavaScript hover callbacks, multiple pointer identities or arbitrary events.
- Supported inset selection outlines project as retained borders; other box
  shadows and font-variant-numeric can degrade without rendering.
- The reviewed difference-blend crosshair degrades; other unimplemented blend
  modes refuse. General mask/filter layers are not supplied by backdrop blur.
- blur(px)/none backdrop filters are supported; other reached functions can
  carry recorded degradation. Gradient-text-only properties refuse outside
  that projection.
- will-change, touch-action, user-select and image-rendering are accepted
  hints without a general native implementation.
- element.animate and listener removal are no-ops; CSS keyframes use mapped
  easing curves rather than identical browser timing functions.
- General grid, colour-transparent text and unsupported text-shadow forms
  refuse instead of silently approximating.
