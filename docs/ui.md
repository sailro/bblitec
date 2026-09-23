# Native page UI

Typed DOM/CSS/Canvas2D operations project into RmlUi. SDL_GPU and Dawn consume the same draw frame.

## RmlUi ownership

| Area | Owner |
| --- | --- |
| Layout, flexbox, animations, transitions, controls | RmlUi |
| Selectors | RmlUi supports queries, matches/closest, combinators, attributes, positional forms and negation |
| Shadows, gradients, filters | RmlUi effects/decorators; backend render hooks supply layers, masks, textures and shaders |
| Browser projection | Compiler admission, DOM ownership, events, CSS translation and compatibility patches |

The [pin](../upstream/rmlui.json) and maintained patches define the library surface.
Check them before adding an implementation. Source rejection does not imply missing library support.

## Integration

- TypeScript owns live controls; reviewed `ui/*.json` companions describe static host chrome.
- Worker applications select the Window host through reached Window APIs. Workers cannot use Window DOM.
- DOM handles retain their document owner across aliases, containers, helpers and engine creation.
- RAF runs on the owner repaint clock, returns cancellable IDs and needs no engine.
- Error/unhandled-rejection listeners support removal, once and preventDefault before engine creation.
  Events borrow dispatch; names are Error, stack/location are absent. Rejectionhandled is unsupported.
- Resolution and reduced-motion matchMedia queries retain identity/current matches and zero-argument change
  listeners. Wider queries, event payloads and removal refuse. ResizeObserver entries are unavailable.
  Device-pixel-ratio-only backing-store resizes and MediaQueryList lifetime remain limited.
- Navigator and graphics guards follow the [environment contract](fidelity.md#semantic-contract). Heap
  snapshots, GPU adapter requests and GPU API instrumentation are unsupported.
- Location follows deployment. A query value the deployment answers folds to a constant (alone, beside
  native operands in comparisons, arithmetic and logical chains, or as a native string method receiver),
  including short-circuits it decides; other reads, such as run-time keys, parse the deployment query
  natively. Conditions over browser values the deployment does not answer refuse. Reload and
  location.search assignment complete the task/microtasks, then recreate realms retaining durable storage
  and the current query; other navigation refuses. Screen/viewport metrics use CSS pixels at display scale.
- The Window service provides promise-backed clipboard text writes; reads/rich data are unsupported.

Host multi-canvas companions retain canvases, dividers and labels. Canvas-only captures include every
canvas at its page position.

## DOM and events

| Area | Supported | Limits |
| --- | --- | --- |
| Construction | Static tags, appendChild, mixed text/element append, remove, retained roots | No general DOM implementation |
| Content | textContent/innerText, bounded innerHTML, id/class/type, static attributes | Compound text writes; unsupported root replacement/removal |
| Styles/classes | cssText, static style fields/methods, classList add/remove/forced toggle | Nonempty setProperty priority; dynamic property names |
| Queries | Literal querySelector/querySelectorAll/matches/closest; attached document ID lookup | Interaction states, :scope, dynamic selectors, pseudo-element queries |
| Pointer/keyboard | Mouse and multi-touch pointers, boundaries, click/dblclick, wheel, contextmenu, keyboard | No AbortSignal, explicit capture lifecycle or coalesced events |
| Focus/forms | Focus, activeElement, button navigation, text/password/checkbox/color inputs, textarea, range value/min/max/step, select value/option selected, output value | Full browser form behavior and broader constructed input types |
| Disclosure | details.open and summary activation | Broader disclosure-group behavior |
| Boolean attributes | hidden/disabled reflect presence; disabled controls cannot focus/activate | hidden=until-found refuses |

Queries use current attributes/order, including detached subtrees. Single queries return null; lists
are ordered snapshots. Dynamic traversal into innerHTML throws without an authored markup tree.
Generated boxes are excluded. Root documentElement/head/body identities are distinct.

Common input dispatch preserves target/capture/bubble, callback identity, removal, once, capture,
passive, stopPropagation and stopImmediatePropagation. Passive listeners cannot cancel defaults.
UI runs before cameras; preventDefault suppresses default UI actions and camera propagation.
Touch contacts retain independent IDs and their initial targets through release or cancellation;
only the primary contact emits compatibility mouse events. Focus loss cancels active contacts.
Window keyboard listeners precede default actions. Focus/form callbacks use per-element dispatch.

Checkbox activation updates checked before input/change. Programmatic control writes are silent.
Color inputs use an RGB/hex popup: preview emits input, Apply emits change, Cancel restores the value.
Values are six-digit opaque RGB; changing an input to or from color refuses.
Native select keyboard navigation requires opening the menu first.

Event flags, phases, modifiers, pointer IDs/types and target/currentTarget/relatedTarget are represented.
Copy owned fields before dispatch ends. Optional element calls snapshot the receiver and skip arguments
when absent. Window input waits for callbacks while servicing layout requests.
Queued form events copy value, checked, selected option and disclosure state before application callbacks.

Window pagehide runs before realm cleanup on close/reload, with Document target and Window currentTarget.
It uses shared listener ordering and microtask checkpoints, with the [HTML page-transition flags](https://html.spec.whatwg.org/multipage/nav-history-apis.html#the-pagetransitionevent-interface).
Beforeunload and page-history caching are unsupported; native pagehide has persisted=false.

Attribute names use HTML ASCII casing. Removal updates retained/rendered state; text/markup replacement
removes prior children. Plain text leaf updates retain projected text nodes and send changed strings
across the Window mailbox; structural and special text changes rebuild projection.
Source append arguments finish before insertion. Canvas backing dimensions are drawable pixels; client
dimensions and bounding rectangles are CSS pixels. Rectangle reads flush pending layout.

### File transfer controls

Save dialogs publish only accepted selections; cancellation publishes no file. Single-file inputs
snapshot bytes/name before change dispatch. File aliases retain snapshots; selections have a 256 MiB
live cap and per-file limits. Completion may occur before click returns. Multiple files/directories,
unsupported accept values, arbitrary source paths and file-input type transitions refuse.

iOS uses UIKit Files with local storage and security-scoped imports; other platforms use SDL dialogs.
[Publication semantics](fidelity.md#semantic-contract) differ between direct paths and file providers.

### Markup

Closed innerHTML admits text/div/span and reviewed SVG/path/rect attributes. Scripts, event attributes,
dynamic attributes and malformed nesting refuse. Runtime text is escaped. SVG rasterizes at CSS size;
mixed currentColor/literal paints and internal SVG queries refuse.

## Canvas2D

Supports backing dimensions, scale, full clear, fillRect, bounded paths/fill/stroke, putImageData,
destination-rectangle canvas drawImage and bounded fillText. Offscreen pixels are premultiplied RGBA.
Closed canvas producers can bake getImageData; mutable module/engine inputs refuse.

Engine-less renderCanvas presents through Window/input/RAF. That primary canvas cannot also own a
source-created GPU engine. Partial clear, source-rectangle blits, general transforms/clipping/shaping
and non-convex tessellation refuse. Opaque full redraws retire covered commands.

## CSS, layout, and fonts

| Area | Supported | Limits |
| --- | --- | --- |
| Position/box | Reached defaults, fixed/inset, viewport/px calc/min/max/clamp, box sizing, physical edges, horizontal-LTR logical margins/padding | Vertical/RTL logical mapping; containing-block/font-relative math and unrepresented shorthands |
| Flex | Wrapping/reversal, grow/shrink/basis, numeric shorthand, flow, alignment, independent gaps | Intrinsic basis keywords and unrepresented CSS math |
| Grid | Row-major grid/inline-grid; auto/px/fr, minmax(px,fr), integer repeat, implicit rows, gaps/alignment; positive grid-column start/end; intrinsic flexible spans | 256 explicit tracks; flexible spans require percentage width; span minimum-track growth, named/alternate placement, percentage tracks and broader intrinsic functions |
| Grid items | Cell-relative widths/spacing, anonymous text items, live child/style changes | Percentage heights, baseline alignment and broader replaced-item sizing |
| Containers | inline-size containment; unnamed nearest-ancestor max-width:Npx queries | Named/min/height/style/scroll-state queries, relative units, other containment types |
| Media | Reached max-width and reduced-motion rules | Reduced motion uses Windows preference polling; other platforms refuse that preference |
| Text | Wrapping/word-break, normal/italic, casing, clip/ellipsis, supported text effects | Browser min-content, oblique, custom overflow, exact shaping/rasterization |
| Visibility | Inherited visible/hidden with visible descendants; delayed zero-duration stylesheet transitions | collapse; inline writes do not initiate transitions |
| Borders/backgrounds | Solid sides, px/em/rem widths, length/percentage corner radii, gradients, solid border/padding/content clipping | Slash-separated elliptical radius syntax; gradient/image clipping and broader border composition |
| Box shadows | Ordered inset/outer layers, pixel offsets/spread/blur, explicit colors and color variables | Omitted/currentColor, non-pixel lengths; cached textures clip to viewport size |
| Raster border images | Packaged stretch slices, number/percentage slices, live widths | Outset, center fill, repeat, SVG, longhands, runtime-generated declarations |
| Images | Centered fill/contain/cover/none/scale-down; content-box clipping | object-position; Canvas2D supports fill only |
| Scrollbars | auto/thin/none widths, auto/two-color styles, selected WebKit parts, stable gutter | Both-edge/vertical/viewport gutters; orientation states, track-piece, resizer |
| Overscroll | Per-axis auto/contain/none through the native scroll path | Browser edge handoff/bounce/navigation; contain and none share behavior |
| Lists | Unmarked block lists with default margins/indentation | Marker types, counters and images |

Grid retains authored parents and structural selectors; source/style/inline order, responsive changes
and child mutations update it. Container queries settle before synchronous measurements and report
nonconverging layouts.

Custom properties preserve case, inherit and support var fallbacks; `--bbl-` is reserved. Quoted values
and nested blocks retain declaration boundaries. Empty writes remove local declarations; cssText
replaces the list. Closed stylesheet helpers/templates snapshot values in source order. Runtime-generated
stylesheet text refuses.

Stylesheet selectors support tags/IDs/classes, attribute presence/equality, descendant/child/sibling
combinators, hover/active/focus/focus-visible/focus-within/disabled/checked, positional An+B/of-type,
empty, not/is/where/has. Where has zero specificity. Has updates ancestor styles; nested has and
pseudo-elements within relative lists refuse. Wider attribute operators and nth-child of-lists remain limited.

Before/after generate flow/positioned boxes from literal strings or attr text. None/normal remove boxes;
empty strings retain them. Generated boxes do not affect authored queries/serialization/positional counts.
Counters/images/typed attr fallbacks and adaptations requiring authored handles refuse. Placeholder
styles admit color/opacity only.

Horizontal range widgets support appearance:none and WebKit thumb/track styles, including state,
size/margins/borders/gradients/shadows. Input behavior remains native. Vertical ranges and tick marks
are unsupported; Gecko-only selector lists are rejected like Chromium's. Native scrollbars use 15/8
CSS-pixel auto/thin widths; standard non-auto settings override vendor styles.

Packaged raster images expose decode/complete/natural dimensions before engine creation. Decode settles
on realm microtasks; empty/broken images reject and source changes invalidate requests. Network/responsive
sources, load/error events and distinct DOMException values are unsupported.

Normal line height uses the current font's metrics and inherits as a keyword; explicit numeric and
length values retain their respective inheritance rules.

Fonts use DirectWrite on Windows and FreeType with CoreText, Fontconfig or Android system-font discovery
on macOS/iOS, Linux and Android. Android resolves generic families through its font matcher and named
families through its installed-font list; variable fonts select the nearest named weight. Color glyphs use CoreText
on iOS (including Apple's `emjc` bitmaps) and Android's text renderer (including COLRv1).
Android bundles Noto Sans Symbols 2 for monochrome text symbols. Other FreeType color fonts retain
PNG decoding. Font coverage, baseline/line-height rounding, emoji/ZWJ shaping and rasterization can
differ from Chromium. Relative transition units resolve at transition start.

| Maintained RmlUi patch | Contract |
| --- | --- |
| `rmlui-css-box-model.patch` | Background painting, shadow bounds, shrink-to-fit and descendant bottom-margin collapse |
| `rmlui-css-declarations.patch` | Quoted/nested declarations |
| `rmlui-visibility.patch` | Visibility inheritance/transitions |
| `rmlui-zero-track-grid.patch` | Native grid formatting |
| `rmlui-zz-grid-column.patch` | Explicit column placement and intrinsic flexible spans |
| `rmlui-zz-container-queries.patch` | Inline containment/max-width queries |
| `rmlui-fragment-root.patch` | Fragment roots |
| `rmlui-generated-content.patch` | Generated-box ownership |
| `rmlui-selector-functions.patch` | Functional selectors/placeholder |
| `rmlui-range-layout.patch` | Horizontal range layout |
| `rmlui-overscroll-axes.patch` | Independent scroll axes |
| `rmlui-scrollbar-gutter.patch` | Stable gutter |
| `rmlui-flex-layout.patch` | Flex defaults/alignment |
| `rmlui-solid-background-clip.patch` | Solid clipping |
| `rmlui-textured-borders.patch` | Raster border slices |
| `rmlui-premultiplied-rounding.patch` | Color rounding |
| `rmlui-fractional-letter-spacing.patch` | Fractional advances |
| `rmlui-line-leading.patch` | Font-derived normal line height and leading/textarea metrics |
| `rmlui-object-fit.patch` | Image fitting |
| `rmlui-overflow-wrap.patch` | Emergency wrapping |
| `rmlui-transform-key-ownership.patch` | Transition key lifetime |
| `rmlui-zzz-android-charconv.patch` | Locale-independent CSS number parsing with Android/macOS libc++ |
| `rmlui-zzzz-percentage-radius.patch` | Border-box percentage radii, elliptical border geometry and shadow/outline radii |

## Rendering

Each backend composites premultiplied UI through one compositor: scene drivers render each segment into a
transparent layer at scene sample count; sprite and Window drivers blend into their single-sample targets.
Canvas overlays precede DOM chrome.
Backdrop blur snapshots preceding UI into FP16 scratch. Filters retain nested layers and ordered color
adjustments, pixel blur and explicit-color drop-shadow chains. Canvas-only capture excludes UI filters.

## Limits

- General mask-image and unsupported blend modes refuse; the reviewed difference crosshair degrades.
- Backdrop blur(px)/none are represented; other reached backdrop functions may degrade.
- will-change, touch-action, user-select and image-rendering are hints. Only -webkit-user-drag:none is admitted.
- element.animate and listener removal outside shared input dispatch remain no-ops.
- CSS easing/steps, font variants and rasterization have approximations.
- Retained UI is unavailable under standalone effect/frame-graph drivers.

Parity measures the [full page](fidelity.md#what-is-measured-the-full-page).
