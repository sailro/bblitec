# Native page UI

Typed DOM/CSS/Canvas2D operations project into RmlUi. SDL_GPU and Dawn consume the same draw frame.

With [deferred capabilities](features.md#program-compilation), registered missing CSS properties and
grid-track forms throw at retained style writes. Nonconstant stylesheet installation and unstructured
declaration strings throw for the missing browser CSS installation/retained-state bridge; RmlUi already
provides declaration and stylesheet parsers. Receiver and string expressions still lower
normally; the manifest lists each deferred feature. This does not add rendering support or change
strict-mode admission. Host-page sheets and unsupported conditional CSS forms still require admission.

## RmlUi ownership

| Area | Owner |
| --- | --- |
| Layout, flexbox, animations, transitions, controls | RmlUi |
| Live style selectors | RmlUi matches cached selector sheets against current elements; authored-tree DOM queries retain their own matcher |
| Shadows, gradients, filters | RmlUi effects/decorators; backend render hooks supply layers, masks, textures and shaders |
| Browser projection | Compiler admission, DOM ownership, events, CSS translation and compatibility patches |

The [pin](../upstream/rmlui.json) and maintained patches define the library surface.
Check them before adding an implementation. Source rejection does not imply missing library support.

Physical `float` (`none/left/right`) and `clear` (`none/left/right/both`) pass through to RmlUi layout.
Logical keywords remain unsupported; dynamic values are checked during native projection.

## Integration

- TypeScript owns live controls; reviewed `ui/*.json` companions or an HTML page describe static host chrome.
- An HTML page (`bblitec page.html [--site-root <dir>]`) is parsed by Chromium; its markup, text, attributes and
  `<style>` sheets are the host, and its one module script names the entry. `/` paths resolve beneath the site root
  (the page's directory by default).
- An inline module script runs before the entry and must end with a statement `import()` of it, reached on a
  generation-decided path; other dynamic imports refuse.
- Page elements are present natively: their lookups' null guards fold.
- Icon links, resource hints and fixed-scale viewport, theme-color, description and light color-scheme metadata are
  inert.
- Classic/data scripts, inline handlers, external sheets, foreign markup, quirks mode and other head content refuse,
  listed together; a sheet refusal names its rule's line.
- Worker applications select the Window host through reached Window APIs. Workers cannot use Window DOM.
- DOM handles retain their document owner across aliases, containers, helpers and engine creation.
- Source-declared optional Window properties start undefined and retain typed values on their Window, including stored receivers; records and callbacks preserve identity across reads, replacement and deletion.
- RAF runs on the owner repaint clock, returns cancellable IDs and needs no engine.
- Error/unhandled-rejection listeners support removal, once and preventDefault before engine creation.
  Events borrow dispatch; names are Error, stack/location are absent. Rejectionhandled is unsupported.
- Resolution, reduced-motion and pointer/hover matchMedia queries retain identity/current matches and
  zero-argument change listeners with identity-based removal. Extracted matchMedia functions retain
  identity across Window/globalThis reads; nullable query caches retain live results. Pointer/hover admits
  conjunctions and follows SDL device capabilities. Wider queries and event payloads refuse. ResizeObserver entries are unavailable;
  `typeof` MutationObserver/ResizeObserver is `function` in the Window realm.
  Their constructors pass through immutable aliases and generation-known options records; dynamic
  constructor storage and constructor identity comparisons refuse.
  Device-pixel-ratio-only backing-store resizes and MediaQueryList lifetime remain limited.
- MutationObserver supports microtask attribute notifications, static attribute filters and disconnect.
  Mutation records, old values, child-list changes and subtree observation refuse.
- Navigator and graphics guards follow the [environment contract](fidelity.md#semantic-contract).
  GPU adapter requests expose the selected host device's vendor, architecture, device and description;
  info retains identity. Plain options admit the default/high-performance core device; fallback,
  low-power, compatibility and XR selections reject. Heap snapshots, raw devices and GPU API instrumentation refuse.
- Location follows deployment. A query value the deployment answers folds to a constant (alone, beside
  native operands in comparisons, arithmetic and logical chains, or as a native string method receiver),
  including short-circuits it decides; other reads, such as run-time keys, parse the deployment query
  natively. Conditions over browser values the deployment does not answer refuse. Reload and
  location.search assignment complete the task/microtasks, then recreate realms retaining durable storage
  and the current query; other navigation refuses. Screen/viewport metrics use CSS pixels at display scale.
- The Window service provides promise-backed clipboard text writes; reads/rich data are unsupported.
- document.hidden/visibilityState and visibilitychange follow window hide/minimize and show/restore, once per change.

Host multi-canvas companions retain canvases, dividers and labels. Canvas-only captures include every
canvas at its page position.
Reached canvas `dataset.ready` writes gate Window captures until a rendering canvas has `data-ready="true"`
and publishes a fresh frame; startup rendering continues past a requested capture frame when necessary.
Bounded runs fail when a rendering canvas reports a nonempty `data-error`.

## DOM and events

| Area | Supported | Limits |
| --- | --- | --- |
| Construction | Static tags, appendChild, mixed text/element append/prepend/replaceChildren, element-array spreads in append/replaceChildren, remove, retained roots; parent, first/last child and sibling element reads | No general DOM implementation; prepend spreads refuse; tree, text and insertion reads inside innerHTML throw; document roots only append |
| Content | textContent/innerText writes, textContent reads, bounded innerHTML, static attributes, reflected id/className/lang/type/min/max/step, getAttribute/hasAttribute, isContentEditable from contenteditable | Compound text writes; `<style>` text reads; unsupported root replacement/removal |
| Styles/classes | cssText, static style fields/methods, classList add/remove/forced toggle; getComputedStyle display/opacity/visibility/zIndex from the last layout | Nonempty setProperty priority; dynamic property names; other computed properties; a scene's first computed read precedes its layout |
| Queries | Literal querySelector/querySelectorAll/matches/closest; attached document ID lookup (also `querySelector("#id")`); contains, isConnected; `instanceof` Node/Element/HTMLElement and reached control interfaces | Interaction states, :scope, dynamic selectors, pseudo-element queries |
| Pointer/keyboard | Mouse and multi-touch pointers, boundaries, click/dblclick, wheel, contextmenu, keyboard | No AbortSignal, explicit capture lifecycle or coalesced events |
| Handler properties | Element `on<event>` for represented pointer, keyboard, file-drag and form-control events: HTML listener position, in-place replacement, `null` removal, `false` cancels | Events without an element listener |
| Transitions | transitionend on elements, Document and Window with target and propertyName, through shared dispatch the update after RmlUi ends it | elapsedTime, other transition events, `ontransitionend` |
| Storage listeners | Window/Document target identity, optional structural receivers, removal/once/capture and borrowed key/oldValue/newValue/url/storageArea | Own Window writes are silent; external-process storage notifications and constructed StorageEvent are unsupported |
| File drags | SDL file dragenter/dragover/dragleave/drop on elements, Document and Window; dragover cancellation accepts a drop; borrowed DataTransfer.files, count and first file with name/size | No authored drags, text transfers, items, effects or wider file indices; dragover follows native motion notifications |
| Custom events | Owned CustomEvent, synchronous Document/Window dispatch, live JSON-compatible detail, cancellation and listener lifetime | Literal names distinct from native event channels; no element dispatch |
| Constructed input events | Owned Event/MouseEvent/PointerEvent/InputEvent values, identity sets, synchronous element/Document/Window dispatch, capture/bubble routing, cancellation and redispatch | Shared pointer, focus and input/change channels only; cross-document redispatch, unrepresented payload fields and option accessors refuse |
| Focus/forms | Focus/blur, literal/stored/optional focus options preventScroll (native focus never scrolls) and focusVisible, activeElement, input/textarea select(), button navigation, text/password/checkbox/color inputs, textarea, range value/min/max/step, select value/option selected, output value | Focus-option getters and spreads; full browser form behavior and broader constructed input types |
| Disclosure | details.open and summary activation | Broader disclosure-group behavior |
| Boolean attributes | hidden/disabled reflect presence; disabled controls cannot focus/activate | hidden=until-found refuses |

Queries use current attributes/order, including detached subtrees. Single queries return null; lists
are ordered snapshots. Dynamic traversal into innerHTML throws without an authored markup tree.
Optional tree receivers preserve absence through class predicates and short-circuit boolean values.
Generated boxes are excluded. Root documentElement/head/body identities are distinct.
Window applications create the implicit engine canvas before entry evaluation; explicitly authored host canvases are reused.

Common input dispatch preserves target/capture/bubble, callback identity, removal, once, capture,
passive, stopPropagation and stopImmediatePropagation. Passive listeners cannot cancel defaults.
UI runs before cameras; preventDefault suppresses default UI actions and camera propagation.
Touch contacts retain independent IDs and their initial targets through release or cancellation;
only the primary contact emits compatibility mouse events. Focus loss cancels active contacts.
Window keyboard listeners precede default actions. Element focus/blur preserves listener identity,
removal, non-bubbling dispatch and related targets. Form and successful file-selection input/change events
use shared DOM listener ordering and removal; form state is updated before callbacks.
Native canvas `tabIndex` reads as zero; keyboard focus targets the SDL surface rather than HTML tab order.

Checkbox activation updates checked before input/change. Programmatic control writes are silent.
Color inputs use an RGB/hex popup: preview emits input, Apply emits change, Cancel restores the value.
Values are six-digit opaque RGB; changing an input to or from color refuses.
Native select keyboard navigation requires opening the menu first.

Event flags, phases, modifiers, pointer IDs/types and target/currentTarget/relatedTarget are represented.
A base Event asserted to KeyboardEvent or MouseEvent reads a checked view of its payload.
Native Event/MouseEvent parameters borrow dispatch. PointerEvent/InputEvent helpers retain owned payloads
and shared identity; retained targets reject an expired document.
CustomEvent retains its detail and identity. Stored Window/Document/EventTargets preserve their document
and snapshot before call arguments. ownerDocument/defaultView retain target identity; Document roots and
activeElement use that owner. Native picker capability reads remain undefined through stored Window views.
Optional element calls and stored EventTarget listeners snapshot the receiver and skip arguments
when absent. Window input waits for callbacks while servicing layout requests.
Element views validate target ownership; Document, Window, text and unrepresented canvas targets refuse element
methods; an unrepresented canvas is not content-editable.
Queued form events copy value, checked, selected option and disclosure state before application callbacks.

Window pagehide runs before realm cleanup on close/reload, with Document target and Window currentTarget.
It uses shared listener ordering and microtask checkpoints, with the [HTML page-transition flags](https://html.spec.whatwg.org/multipage/nav-history-apis.html#the-pagetransitionevent-interface).
Beforeunload and page-history caching are unsupported; native pagehide has persisted=false.

Attribute names use HTML ASCII casing. Removal updates retained/rendered state; text/markup replacement
removes prior children. Plain text leaf updates retain projected text nodes and send changed strings
across the Window mailbox; structural and special text changes rebuild projection.
Dataset reads distinguish missing (`undefined`) and empty attributes.
Source append and replaceChildren arguments finish before replacement and insertion. Canvas backing
dimensions are drawable pixels; client dimensions and bounding rectangles are CSS pixels; element
offset/client sizes are rounded CSS pixels. Rectangle and size reads flush pending layout.
Retained bounding rectangles snapshot x/y, left/top, right/bottom and border-box width/height.
Pixel ratio, viewport size and input capabilities read host state without flushing pending DOM or canvas writes.

### File transfer controls

Window object URLs share the document's lifetime, including before rendering-engine creation and in deferred callbacks.
Save dialogs publish only accepted selections; cancellation publishes no file. Single-file inputs
snapshot bytes/name before change dispatch. File aliases retain snapshots; selections have a 256 MiB
live cap and per-file limits. Drops count up to 4096 files and snapshot the first (64 MiB maximum). Completion may occur before click returns. FileReader reads a
File or Blob as text inside `readAsText`, decoding by byte order mark (UTF-8 otherwise), with handlers
assigned before the read. `showOpenFilePicker`, `showSaveFilePicker` and `showDirectoryPicker` are absent.
Multiple input selections, directories, unsupported accept values, arbitrary source paths, file-input type
transitions and other FileReader reads refuse.

iOS uses UIKit Files with local storage and security-scoped imports; other platforms use SDL dialogs.
[Publication semantics](fidelity.md#semantic-contract) differ between direct paths and file providers.

### Markup

Closed innerHTML admits text/div/span, packaged img assets and reviewed SVG/path/rect attributes. Finite
conditional fragments select parsed alternatives; immutable aliases and helpers retain one runtime text span
inside fixed authored fragments. Runtime text is escaped and stored text is read from its captured value.
Queries on the markup owner preserve selected order, absence and live attributes; mixed retained/markup subtree queries
and removing or reparenting queried markup nodes refuse. Queried nodes accept text or closed markup replacement while
their descendants have no retained handles; later queries exclude replaced content.
Scripts, event attributes, unbounded attributes and malformed nesting refuse. SVG rasterizes at CSS size;
mixed currentColor/literal paints and queries inside static SVG markup refuse.

`createElementNS` admits SVG svg/path/rect/circle nodes with retained identity, case-sensitive attributes,
and live append/remove/replace operations. RmlUi's SVG plugin rasterizes shape XML; inherited currentColor
tracks the SVG root's computed color. Shape styles, listeners, layout reads, nested SVG, paint servers,
CSS-wide paint keywords and variable paints refuse.

## Canvas2D

Supports backing dimensions, scale, full clear, fillRect, strokeRect, bounded paths/fill/stroke, putImageData,
destination-rectangle canvas drawImage and bounded fillText; a context's `canvas` is its element. Host canvases the
program draws on are retained canvases sized by their width/height attributes. Offscreen pixels are premultiplied RGBA.
Closed canvas producers can bake getImageData; mutable module/engine inputs refuse.
Retained canvas commands follow DOM stacking, visibility and clipping; Window snapshots publish canvas
changes independently of text and layout updates.

The primary canvas is the element the program passes to createEngine, found by the id it is looked up
by (the host document's `renderCanvas` otherwise); a program that looks it up by several ids refuses.
An engine-less primary canvas presents through Window/input/RAF under that id and cannot also own a
source-created GPU engine. Partial clear, source-rectangle blits, general transforms/clipping/shaping
and non-convex tessellation refuse. Opaque full redraws retire covered commands.

## CSS, layout, and fonts

| Area | Supported | Limits |
| --- | --- | --- |
| Position/box | Reached defaults, fixed/inset, viewport/px/rem calc/min/max/clamp, box sizing, physical edges, horizontal-LTR logical margins/padding | Vertical/RTL logical mapping; containing-block/element-font-relative math, rem math in font sizing or custom properties, and unrepresented shorthands |
| Flex | Wrapping/reversal, grow/shrink/basis, numeric shorthand, flow, alignment, independent gaps | Intrinsic basis keywords and unrepresented CSS math |
| Grid | Sparse row flow; numeric column/row lines, negative lines and spans; auto/px/fr, minmax(auto or px, auto/px/fr), integer/auto-fit/auto-fill repeat, implicit track patterns, gaps/alignment and intrinsic spans | 256 tracks per axis; named areas/lines, alternate flow, subgrid, percentage/relative tracks, broader intrinsic functions and absolute-item placement |
| Grid items | Cell-relative widths/spacing, anonymous text items, live child/style changes | Percentage heights, baseline alignment and broader replaced-item sizing |
| Isolation | Reversible auto/isolate stacking contexts for painting and hit testing | Blend modes remain outside the retained surface |
| Containers | inline-size containment; unnamed nearest-ancestor max-width:Npx queries | Named/min/height/style/scroll-state queries, relative units, other containment types |
| Media | Reached max-width, portrait/landscape and reduced-motion rules | Reduced motion polls Windows/macOS accessibility preferences, Android animator scale or the Linux desktop portal (standard reduced-motion, then GNOME enable-animations); unavailable preferences refuse |
| Text | Wrapping/word-break, normal/italic, casing, clip/ellipsis, supported text effects, vertical-align keywords | Browser min-content, oblique, custom overflow, exact shaping/rasterization; vertical-align lengths/percentages |
| Visibility | Inherited visible/hidden with visible descendants; delayed zero-duration stylesheet transitions | collapse; inline writes do not initiate transitions |
| Borders/backgrounds | Solid sides, px/em/rem widths, length/percentage corner radii, gradients, solid border/padding/content clipping | Slash-separated elliptical radius syntax; gradient/image clipping and broader border composition |
| Box shadows | Ordered inset/outer layers, pixel offsets/spread/blur, explicit colors and color variables; outer shadows blur before the border-box clip; a single box larger than the viewport renders its shadow with a stretched band; a runtime assignment is checked against the CSS grammar itself, so an invalid value is ignored as CSSOM does while a valid one RmlUi cannot represent refuses | Omitted/currentColor, non-pixel lengths; a multi-box (inline) shadow texture clips to viewport size |
| Raster border images | Packaged stretch slices, number/percentage slices, live widths | Outset, center fill, repeat, SVG, longhands, runtime-generated declarations |
| Images | Centered fill/contain/cover/none/scale-down; content-box clipping; the image and content box snap to whole pixels as Blink's image painter does | object-position; Canvas2D supports fill only |
| Raster backgrounds | Single packaged image, explicit inheritance, centered contain/cover, natural-size repeat and zero sizing | Sized repetition, arbitrary sizes/positions and multiple layers |
| Gradient backgrounds | Ordered linear/radial/conic layers in the background shorthand; no-repeat layers with independent length/percentage sizes and keyword/length/percentage positions | Sized repetition, gradient longhands, layers extending outside their paint box or requiring rounded clipping |
| Transforms/clipping | Uniform nonnegative scale composed before transform; empty rectangular clips retain layout/focus | Nonuniform scale longhand and nonempty clip rectangles |
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
root, empty, not/is/where/has. Where has zero specificity. Has updates ancestor styles; nested has and
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

CSS font-family lists retain their order and match names case-insensitively. Installed faces load on demand at the requested weight and style;
an unavailable list uses the default UI face with a diagnostic.

Fonts use DirectWrite on Windows and FreeType with CoreText, Fontconfig or Android system-font discovery
on macOS/iOS, Linux and Android. Android resolves generic families through its font matcher and named
families through its installed-font list; variable fonts select the nearest named weight. Color glyphs use CoreText
on iOS (including Apple's `emjc` bitmaps) and Android's text renderer (including COLRv1).
Android bundles Noto Sans Symbols 2 for monochrome text symbols. Other FreeType color fonts retain
PNG decoding. Font coverage, baseline/line-height rounding, emoji/ZWJ shaping and rasterization can
differ from Chromium. Relative transition units resolve at transition start.

The maintained RmlUi patches are `native/patches/rmlui/NNNN-*.patch`, applied in number order.
[`native/patches/manifest.json`](../native/patches/manifest.json) states the contract each adds
(`purpose`) and its upstream state; each patch opens with its rationale.

## Rendering

Each backend composites premultiplied UI through one compositor: scene drivers render each segment into a
transparent layer at scene sample count; sprite and Window drivers blend into their single-sample targets.
Canvas overlays precede DOM chrome. An engine canvas presented beneath the UI (outside Worker hosts) is an opaque
rectangle, its content box, as the pin configures it: UI painted before it, in paint order, is clipped out of the
rectangle, a filtered layer at its composite. A rounded, transformed, translucent, filtered, masked or
overflow-clipped engine canvas refuses.
Backdrop blur snapshots preceding UI into FP16 scratch. An element with a backdrop filter is a backdrop root:
when a descendant also has one, the element and its descendants paint into their own layer, so that backdrop
reads only what the root painted before it, and draws its filtered backdrop over the same content, compounding a
translucent root as Chromium does.
Filters retain nested layers and ordered color adjustments, pixel blur and drop-shadow chains.
Filter scalar/px math resolves inherited custom properties in calc/min/max/clamp expressions;
omitted shadow colors and currentColor follow the element's computed color.
Other math units and bare var() shadow arguments refuse.
Canvas-only capture excludes UI filters.

## Limits

- General mask-image and unsupported blend modes refuse; the reviewed difference crosshair degrades.
- Backdrop blur(px)/none are represented; other reached backdrop functions may degrade.
- will-change, touch-action, user-select and image-rendering are hints. Only -webkit-user-drag:none is admitted.
- element.animate remains a no-op; listener removal outside shared input dispatch refuses.
- CSS easing/steps, font variants and rasterization have approximations.
- Retained UI is unavailable under standalone effect/frame-graph drivers.
- Only backdrop-filter, filter and mask elements are backdrop roots: RmlUi applies opacity per vertex and has no
  group layer for opacity below 1, clip-path or mix-blend-mode, which Chromium also treats as roots.
- An element with a filter or mask and a backdrop filter keeps RmlUi's order: its filtered backdrop paints inside
  the filter layer, so the filter applies to it and a descendant's backdrop reads it.
- A backdrop blur samples beyond the element's border box where Chromium mirrors at its edge.
- Only box-shadow assignments are checked against the CSS grammar; an invalid value for another property refuses
  when the PAL checks that property and is otherwise stored as written, where CSSOM ignores it. A box-shadow
  naming an unknown color keyword passes the check and refuses.
- A layer composite copies its source region before filtering, including composites without filters.
- A canvas's backing size is its intrinsic size; intrinsic canvas width does not enlarge a flex item or shrink-to-fit box.
- A scene's canvas hides the page paint beneath it even where the scene clears to a translucent color.
- A text or sprite renderer presents an authored engine canvas only while it fills the window.
- An image regenerates its quad when its absolute offset's sub-pixel fraction changes.

Parity measures the [full page](fidelity.md#what-is-measured-the-full-page).
