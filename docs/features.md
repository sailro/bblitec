# Features

`bblitec` compiles a bounded TypeScript/Babylon Lite subset. Unsupported forms refuse during generation
or at explicit resource/device checks. Limits here and in [UI](ui.md) (browser projection) are the
capability gaps; [fidelity](fidelity.md) owns semantic substitutions.

## Why anything is compile time

Assets, closed producers and shader composition run during generation. State, input, animation,
uploads and rendering run natively. There is no general JavaScript interpreter or dynamic module loader.

## Feature and capability selection

| Input | Selects |
| --- | --- |
| Reached APIs/properties/globals | Generated code, PAL units, native dependencies |
| Call options and asset loader predicates | Runtime features joined from assets, subfeatures, codecs, material variants |
| Pinned composition | Shader arms, layouts and binding requirements |
| Registry | Source, title, host UI, reference query and attribution |
| Build options | Backend, capture, size and PCH configuration |

`generated/<id>/upstream/feature-activation.json` records repository-relative reach sites, asset joins,
the activation plan's reasons and checked consumers. An asset's loader trigger joins the same runtime
feature a scene call reaches before anything reads the feature list; material and shader capabilities,
including the transmission renderer, come from the composed arms. Reaching a factory activates its
module even when one of its options is disabled, except where a literal option opts a parser out, as
`loadBabylon({ loadCamera: false })` does for the camera parser.

### API coverage inventory

The pinned `index.d.ts` supplies [`upstream/babylon-lite-api.json`](../upstream/babylon-lite-api.json):
exports, overloads, methods, fields/accessors, index signatures and reachable types. Fingerprints include
type dependencies. Inherited fields belong to their declaring type; external peer APIs and stripped internals are excluded.

| Evidence | Scope |
| --- | --- |
| Exercised forms | Successful AST lowering across the full test suite and every registered scene/demo, including dynamic test inputs |
| Source translation | Generated pinned bodies, configured bindings/specializations, and dispatched call/method/expression/statement adapters |
| Entry adapters | Registry probes and passing source forms; imported Babylon calls require an entry adapter even when their bodies translate |
| Semantic cases | Scoped native/parity assertions and refusals in [`upstream/api-coverage.json`](../upstream/api-coverage.json) |

Exercise percentages separate signatures, fields/accessors, constants and callbacks (type containers
excluded) and qualify exercised forms only; failed compilations, discarded probes and stale receipts earn
no credit. Unassessed declarations and type-dependent probe fallthrough are unknown; `partial` combines
positive and refusal evidence. The adapter boundary is unclassified, so there is no overall PAL completion
percentage. See [collection commands](development.md#api-coverage) and, for one external entry,
[sizing](development.md#sizing-a-capability-before-implementing-it).

## Program compilation

| Area | Supported | Limits |
| --- | --- | --- |
| Modules | Named/namespace imports, re-exports, constant aliases, external local TS/JS, JSDoc, `?raw`, ordered initialization | Runtime-selected modules; unrepresented mutable initializer dependencies |
| Control flow | Blocks, conditionals, switches, loops, break/continue, throw, owned caught Errors, nested synchronous finally around await | Await inside catch/finally; arbitrary cleanup across `startEngine` |
| Functions | Typed/generic functions, defaults, rest parameters, destructuring, supported recursion, stored values shared or adapted across sink signatures, type parameters narrowed past null inside generic bodies | Unresolved type arguments; unbounded resource specialization; a stored value cannot take a narrower signature; an adapted value is rebuilt at each reach; a value-typed parameter narrowed past null keeps its nullable representation inside an object literal |
| Classes | Fields, methods, accessors, generics, retained callbacks, receiver-preserving structural views, private names for fields, methods and accessors, rebound class-typed locals (`let c: C \| null = null; c = new C()`); inheritance between local classes: `super(...)`/`super.m()`, abstract and protected members, overrides dispatched through base-typed stored references, `instanceof`; mutable static fields and static blocks, run where the declaration evaluates; private brand checks (`#x in value`) | Extending a non-local class; generic classes or sibling fields of different types in a stored hierarchy; a private name redeclared in a subclass; writing an inherited static through a subclass; static accessors; recursion through stored instances; an uninitialized `let c: C \| undefined`; unsupported field storage |
| Closures | Shared mutable cells, function identity, optional calls, escaping recursive groups | Captures need owned representations; events cannot escape dispatch |
| Data | Typed/nullable records, discriminated and mixed unions, arrays, tuples, dictionaries, Map/Set, JSON | Optional own-property presence; earlier class instances; mutation through erased native records/arrays; storage ambiguities; dynamic `typeof` values in inferred string-literal fields; recursive record/function initializers without matching owned layouts |
| Async | Realm-owned promises, async functions/methods/IIFEs, early returns, loops, retained activations; outside a realm, constructed promises whose resolving functions escape into callbacks | Custom thenables; general async iteration; outside a realm a constructed promise is awaited or returned where it is created and is not settled from a timer or frame callback, and a call that can await one still pending is awaited, returned or a statement (not stored or a callback) |
| Workers | Local module scripts, isolated module state, cloning of records, arrays, numeric tuples, Date, Map, Set, ArrayBuffer, typed arrays and DataView with cycles/aliases (views of one buffer share its copy), timers, errors, close/terminate | Classic/runtime-selected scripts; incompatible rendering products; messages carrying class instances, Errors, mixed unions, dynamic JSON, functions, promises, iterators or platform objects refuse; SharedArrayBuffer/Atomics; listener options other than static `once`; WorkerGlobalScope error listeners and worker-scope rejection dispatch |
| Worker graphics | OffscreenCanvas transfer, independent scene owners, shared Window presentation | Transfer lists admit OffscreenCanvas only |

Local JavaScript implementations take precedence over companion declarations. Type-only imports do not
run initializers. `declare` creates no runtime value; bare `typeof` of an absent binding is `"undefined"`.
A module executed at generation may import its relative siblings without an extension.

`import.meta.env` uses production client constants: `MODE="production"`, `PROD=true`, `DEV=false`,
`SSR=false`. `BASE_URL` follows deployment. Custom string fields use `--env NAME=value` or
`CompileOptions.environment`; absent keys are undefined. Built-ins cannot be overridden; dotenv and host
variables are not loaded implicitly.

Defaults and short-circuit operands evaluate once and lazily. Loose equality between operands of one
primitive type is strict equality; across types it refuses. Destructuring finishes the source before
left-to-right target writes. Defaults requiring distinct null/undefined states refuse when storage
cannot distinguish them. `for...of` admits identifiers, tuple/rest bindings and plain struct fields;
nested/default/renamed struct bindings refuse.

Dynamic JSON preserves actual fields and object identity through typed locals, arguments (members
included), conditionals, represented generic returns and record-typed function returns. Source-backed
record ownership can trigger compiler replay, preserving earlier aliases and initializer counts. Getters
permit statements before a final return; early returns refuse.
Self-captured `satisfies` records retain one identity when their checked and initializer layouts agree.

| Promise operation | Contract |
| --- | --- |
| `resolve` / constructor | Object identity; synchronous executor; first settlement wins; represented promise adoption |
| `reject` | Owned Error identity |
| `then` / `catch` | Owned captures, queued reactions, compatible result storage; callback throws reject; `catch` and rejection callbacks bind their parameter to the caught Error |
| `finally` | Waits for cleanup; preserves original result unless cleanup throws/rejects |
| `all` | Ordered literal tuples and stored arrays of value promises; first rejection wins |
| `allSettled` | Ordered literal tuples and stored promise arrays, including void; fresh settlement records and original Error identities |
| `race` | Homogeneous represented arrays/tuples; empty input stays pending |

Arbitrary rejection values, heterogeneous race results and unrepresented aggregation shapes refuse.
`all` excludes literal spreads, other iterables and stored void/value-only arrays. `allSettled` excludes
literal spreads and other iterables. Async collection callbacks start synchronously and retain
suspension; predicate promises are truthy.
Outside a realm the executor runs in place and an await reads the settlement; one still pending ends the
awaiting activation ([fidelity](fidelity.md#semantic-contract)). Timers/microtasks need no engine. RAF
needs a Window repaint source. Unhandled rejections are reported in a subsequent task after microtasks.
MessageChannel and runtime compression streams refuse; gzip/base64 JSON decoded through
`DecompressionStream` folds at generation.

### Core TypeScript library

| Area | Supported | Limits/adaptations |
| --- | --- | --- |
| Numbers | Reached Math operations, non-coercing Number predicates/constants, JS coercions and rounding, numeric callbacks | Native double transcendental functions; deterministic random; bounded rest signatures |
| Variadic Math | `min`, `max`, `hypot`, numeric tails and array spreads | Native `hypot` approximation; NaN/signed-zero rules retained for min/max |
| Arrays | Map/filter/find/reduce/predicates, flatMap/flat/concat, sorting, indexed searches, fill/copyWithin/splice, joins | Closed flatten depth; no callback `thisArg`; some scalar pop/shift paths require nonempty arrays |
| Tuples | Shared identity, typed and dynamic lanes, mutations, shallow rest arrays, destructuring | Sparse length growth and ambiguous null/undefined defaults refuse |
| Map/Set | Ordered construction, queries, mutation, spreads, entries, live `forEach` | An iterator value of a nullable reference type reads as present |
| Iterators | Direct array/Map/Set iteration; retained Set keys/values/entries cursors, `next`, spreads, `Array.from` | Generators and general `Symbol.iterator` objects refuse |
| Strings | UTF-16 indexing/length, substring/repeat/concat, padding/trimming, replacement strings/callbacks, `+=` on locals, fields and elements | A concatenated operand is built before it is appended |
| RegExp | Supported `g`/`i` patterns and replacement callbacks with captures/offset/original string | RegExp `replaceAll` with string replacement refuses |
| Unicode | NFC/NFD/NFKC/NFKD normalization; `localeCompare` locale/options | Option getters and non-string locale entries refuse |
| Objects | Supported keys/values/entries, assign/fromEntries/hasOwn/is, shallow spreads, delete/in | Fixed own-key proof required for optional structs; Object.assign targets records, object literals and structs, other targets refuse |
| JSON | Represented parse/stringify, actual dynamic fields, index-key order, undefined-property omission; a generation-time pass folds only when its result is a round-trip document, else it lowers as an ordinary call | Replacers and cyclic serialization refuse |
| Dates | Current/numeric/copy construction, now/getTime/valueOf/setTime, UTC `toISOString` | No string/calendar constructors or broader methods |
| Intl | Default DateTimeFormat and resolved time zone | No explicit locale/options, formatting or broader fields |
| URLSearchParams | String constructor, get/has/set/toString, duplicate order, decoding and form encoding; mutation retains object identity and invalidates deployment-query folds | Append/delete/sort, iteration and other constructors refuse |
| Binary data | ArrayBuffer, DataView getters/setters, Int8/Uint8/Int16/Uint16/Int32/Uint32/Float32/Float64 arrays | Unrepresented element/storage consumers refuse |

Typed-array buffer views retain bytes, offset, length and identity. Constructors check ToIndex,
alignment and bounds; set/slice/subarray/fill/copyWithin preserve overlap rules. Raw contiguous
consumers and some iteration paths refuse views. `ArrayBufferView` retains typed arrays and DataView.
Numeric index-signature writes preserve element conversion and grow ordinary arrays.

Proxy, WeakRef and Symbol values refuse. Array/object aliases retain identity. Spreads copy own scalar
fields and share nested objects.
Object enumeration places numeric index keys before insertion-ordered names. Fixed record key
snapshots retain initialized keys; module namespace keys are lexical and values remain live.
String-literal-union searches accept outside strings as misses. `invertMat4` returns nullable fresh
Float32 storage; Float64/high-precision combinations refuse.

## Asset materialization

Reached URLs and base64 data become packaged assets. `--public-dir` maps deployment-relative assets;
`--public-url` serves root-relative assets no public directory holds, and a root-relative asset with
neither refuses; registry scenes compile with the pinned `lab/public` URL. `--site-url` sets the base
(default `http://localhost/`). Other origins use remote loading.
Unsupported dynamic URLs and percent-encoded asset bodies refuse.

### Runtime HTTP

Async `fetch(url, options)` uses absolute HTTP(S) URLs with specialized method, string headers and body.
Known one-argument asset fetches use packaged responses. Responses expose ok/status/url/bodyUsed and
text/json/arrayBuffer reads; bodies consume once. HTTP errors fulfill; transport/missing-file errors reject.
Request objects, streaming and wider options/methods refuse. Transport limits are in [fidelity](fidelity.md).

### Compressed geometry

Pinned Draco/meshopt decoders run during packaging. Sparse/quantized/compressed inputs become native
accessors. Bootstrap `setDracoBaseUrl` and `setKtx2DecoderUrl` accept generation-known URLs; KTX2 overrides
need fresh nested literals. Configuration is per loading realm and must precede compressed loads.

### Compressed textures

KTX1 packages BC/ASTC candidates in source order and selects a supported format on the rendering device.
Candidates require matching dimensions and sampler rules. Missing assets, unsupported families and
uncompressed fallback refuse. Basis/KTX2 uses the pinned browser transcoder; upload checks device support.

### Gaussian splat row updates

`splatsData` and `updateData(ArrayBuffer)` share owned rows. Equal-count replacement preserves old
aliases and refreshes rendering/picking. Borrowed buffers and writes to the getter-only property refuse.
Multiple fragment sets and broader buffer-view methods remain limited.

### Environment compilation

HDR uses pinned GGX prefiltering; DDS preserves specular mips; `.env` uploads decoded cubes. The BRDF LUT
is baked. Static box/sphere local environments and blended probe sets support setup before registration.
Live probe rebuilding/ORM rebinding refuse; direct intensity remains live.

Procedural sky environments support packaged BRDF textures, GPU cube generation/mips and live
atmosphere updates. Sun color and irradiance use pinned arithmetic; overlapping updates and disposal
cancel stale publication. Custom yield hooks refuse.

### Drawn and computed assets

Closed Chromium producers bake pixels/atlases. Pinned CSG/CSG2 bake geometry; CSG2 requires unchanged,
identity-transform boxes/spheres and known material partitions. Runtime CSG2 control refuses.

### Browser-produced textures

Closed scene functions may own canvases and invoke pinned pixel/texture factories. Unknown calls,
mutable inputs and runtime engine reads refuse. Live UI Canvas2D is separate.

### Node particles

| Path | Contract |
| --- | --- |
| Frozen/baked | Pre-frame stepped/frozen sets without providers; retained numeric buffer reads |
| Sprite2D sheets | Shared Uint16 cells with live writes; replacement and broader bindings refuse |
| Native pure 2D | Supported static emission, Point/Box shapes, position/color, texture, Input/Math/Lerp/Converter and random modes |
| Emitter provider | Owned Float32 matrix callback sampled at wrapping and animation; definite initialization |

Mixed frozen/native sets, unsupported evaluators/hooks, dynamic emission shapes and post-registration
texture/blend changes refuse. Finally across `startEngine` admits plain writes only. Snippets and
flipped textures remain limited.

## Shader pipeline

The reached shader set is closed at generation. See [shader fidelity](fidelity.md#shader-contract)
and [compiled bindings](backends.md#compiled-binding-contract).

## Engine, scene, and frame loop

Scene, sprite, effect and scene-less frame-graph drivers share frame orchestration. Immutable engine
aliases retain identity; multiple engines in one entry and rebinding refuse.

Runtime `msaaSamples` selects one sample for numeric 1, four otherwise, evaluated once. Engine reads,
default scene targets and effect/frame-graph targets share this selection. Explicit numeric constants
other than 1/4 refuse. `enableSurfaceResizeObserver` admits engines and auxiliary surfaces; native loops
own extent refresh.

Ordinary device recovery retains CPU owners and rebuilds GPU resources. Setup must be unconditional
before startup and observations require one scene. Failure callbacks expose `Error.message`. As
upstream, a failed recovery does not re-arm; a later loss then refuses rather than continuing. Only the
scene strategy registers, so a loss with an active sprite, text, effect or frame-graph context refuses with
the pin's own message. Shared worker/offscreen recovery and engine render-function wrapping are unsupported.
`disposeEngine` preserves retirement, stop, surface and resource cleanup order, including device
teardown after a disposer throws. It is independent of recovery. On Windows, application iteration
stalls during the modal window move/resize loop.
GPU task timing queries and enable requests expose the [native capability result](fidelity.md#semantic-contract).

Same-engine canvases have independent targets, cameras, rectangles and input ownership.

Compute tasks retain identity, writable names/execution gates and replaceable disposers.
Stored functions admit `bind(thisArg)` without partial arguments or dynamic `this` rebinding.
Compute uniform layouts require generation-known field names/types and retain source packing,
validation and distinct object identity. Uniform buffers and task-owned arenas retain padded staging,
aligned slots and disposal. Typed writers admit f32/u32/i32 scalars and numeric vector/matrix arrays;
f16 writers remain outside the admitted surface. Binding declarations and shader descriptors retain
source validation and disposal; WGSL and entry points must be generation-known. Async pipeline
preparation, binding sets, dynamic offsets and ordered task submission run on both backends.
Bindings admit uniform/storage buffers, sampled/storage textures and samplers; optional record
own-property presence refuses. Frame-graph compute tasks may follow system shadows and must precede
user render tasks.
One-shot completion waits for submitted GPU work and preserves rearming/disposal semantics.
Storage readback validates byte ranges, coalesces identical requests and serializes differing ranges.
Compute outputs can feed sampled material slots and storage-backed geometry. Mipmap tasks preserve
source execution gates and command order. Six-layer storage views with cube sampling are qualified
on Dawn and patched SDL D3D12; other SDL drivers refuse this combination.

## Cameras and input

ArcRotate/Free cameras, framing, orthographic projection, viewports and supported SDL controls are live.
Orthographic options admit halfHeight and optional left/right/bottom/top planes; later plane writes refuse.
World matrices admit copied typed-array reads and constant indices 0–15. Tracked transforms and
configurable FreeCamera controls retain worldMatrixVersion; mutable matrix aliases refuse.
Control restoration, geospatial input and broader camera combinations remain limited.

## Android

ARM64/x86_64 APKs use SDL_GPU or Dawn on API 28+; retained UI requires API 29+.
RmlUi, LabSound/SDL audio and worker canvases sharing one native window are enabled.
Authored maxDevicePixelRatio caps the render buffer independently of the full-screen view.
Apps use landscape orientation and immersive fullscreen. Reveal navigation with a bottom-edge swipe;
system Back exits the activity. Multi-touch supports simultaneous UI controls and camera gestures.
Multiple native windows remain unsupported. Full corpus and
physical-device performance qualification remain open.
[Commands](development.md#android).

## iOS

iOS 16+ bundles use SDL UIKit windows/input. Simulator requires Dawn/Metal; device builds support
SDL_GPU/Metal or Dawn. Trimmed ARM64 packages support iPhone and iPad.
Landscape fullscreen supports native density or `maxDevicePixelRatio=1`; intermediate caps refuse.
UIKit file import/export and native color emoji are supported.
Device bundles are unsigned and unqualified on hardware. Signing, device deployment and App Store
distribution are not implemented; Simulator captures do not qualify device behavior.
[Commands](development.md#ios).

## Asset loading and upload

| Format | Supported | Limits |
| --- | --- | --- |
| glTF | Meshes/materials, lights, perspective cameras, skins/morphs, animation, reached extensions, compressed/external assets | Contiguous FLOAT MAT4 inverse binds; complete contiguous animation accessors; fixed light capacity |
| glTF ORM composition | Source-selected occlusion/metallic-roughness merge | Equally sized opaque images; no scaled/alpha/compressed bitmap composition |
| `.babylon` | Parented meshes/nodes, Standard materials, point lights, cameras, loadCamera/loadTextures | maxMeshes unsupported |
| Closed collectors | Source traversal/order and per-asset metadata | Rest/default/optional parameters, partial/repeated hierarchies, early break, instanced/splat producers |

Pinned loaders determine geometry, transforms, bounds, topology, material scheduling and feature-hook
order. `enableGltfCameras` requires definite setup. Orthographic imports refuse. Attachments preserve
existing scene cameras and fresh callback identities. Native animation retains source-selected owners.
3D texture creation, partial/runtime texture uploads and broader direct KTX2 paths remain limited.

## Geometry and meshes

Reached primitives, data factories, ribbons/extrusions/polyhedra, lines, CSG and thin instances use their
admitted option sets. Box/sphere data is mutable and shared through aliases. Unknown-count mesh/Standard/
shader factories require compatible profiles. Static expansion is capped at 4,096 iterations/1 MiB;
parameterized composition tables at 65,536 records each. Wider dynamic geometry updates, line
topology/colors/dashes and dynamic draw counts remain limited.
Owned data meshes support geometry resizing and shared-family rebinding; omitted clones retain their
existing geometry. Imported geometry resizing refuses.

## Scene hierarchy

Local/world transforms, visibility, parenting and bounded imported walks/cloning are represented.
Meshes may parent to meshes or transform nodes; transform nodes require transform-node parents.
Parent assignment and child insertion are separate. Synthetic glTF roots expose position, scaling,
Euler/quaternion rotation and copied world matrices. Broader imported hierarchy cloning refuses;
descendant/child-mesh queries remain limited.
Detached imported leaves share geometry.
Opaque cached lists require visibility invalidation; transparent/transmissive visibility is live.

## Lights

Directional, hemispheric, point and spot lights support reached setters and per-mesh selection.
Intensity and diffuse-color setters retain validation and unchanged-value behavior.

### Clustered lights

PBR clustered containers compose shaders at generation. The container and light factories, the container's
addition and its per-frame refresh are lowered from the pinned bodies; the refresh keys its camera by handle.

## Materials and material state

Standard, PBR, Grid, shader and selected no-color views support reached properties. PBR layers include
clearcoat, sheen, iridescence, anisotropy and transmission. UV/lightmap/vertex-color opt-ins remain explicit;
lightmap binding precedes registration. Runtime texture-producer choices refuse.

Public factors retain array identity/double precision. Reads require one registered scene and represented
producer identity. Rebuilds and replacement after binding refuse; direct array writes do not bump UBO
versions. Public glTF albedo reads exclude material extensions, transforms and BasisU. Textured
environment rotation and wider metallic-reflectance fields remain limited.

Shader materials admit bounded 2D/array samplers, float/depth/comparison sampling, storage buffers and
selected uniform/system matrices. Wider descriptors, pipeline state and live composition profiles refuse.
A source or plugin `getCustomCode` a scene builds with a function is run at generation over
generation-known arguments; one reaching a host or engine API, a module `let`/`var`, `this` or a runtime
value refuses. Alpha to coverage reaches shader materials; Standard and PBR targets refuse.

### Node materials

Closed NME graphs compose once per shape with distinct owners. Texture slots may be filled before
registration; required missing bindings refuse. Numeric inputs, reflective/map mutation and later
producer/topology changes refuse. Public input observations require one scene.

Geometry MRTs admit IRRADIANCE, WORLD_POSITION, LOCAL_POSITION, REFLECTIVITY, VIEW_DEPTH,
NORMALIZED_VIEW_DEPTH, SCREENSPACE_DEPTH, VIEW_NORMAL, WORLD_NORMAL, ALBEDO and LINEAR_VELOCITY.
Imported geometry needs static tightly packed FLOAT attributes; deformation, instancing and imported
transform mutation/cloning refuse. Missing normals and used strided attributes refuse.

### Material plugins

Explicit enablement supports custom code, Standard/PBR texture bridges and retained typed uniform
writers for the admitted scalar/vector/matrix surface. Source callbacks update their scratch storage
and vertex/fragment bindings. Dynamic shader signatures and broader plugin hooks refuse.

## Animation playback

GLTF supports LINEAR/STEP/CUBICSPLINE, TRS, skin/morph and admitted material/light/visibility pointers,
seeks, speed, masks and weighted/additive mixing. Property tracks support numeric leaves and linear/step
interpolation.

Managers support fixed delta, onUpdate and autonomous RAF start/stop. First variable delta is zero;
autonomous updates notify after evaluation. Autonomous managers cannot share a program with a persistent
application RAF loop.

## Deformation and instancing

GPU skinning, storage morphs, VAT and thin-instance pools are supported. Direct morphs require one
pre-start attachment per mesh; conditional/replacement/thin-instance combinations refuse. Imported clones
share deformation resources. Standard skeletons require enablement. Thin-instance arrays retain aliases;
GPU culling has an [adaptation](fidelity.md#semantic-contract). Broader VAT bakes, VAT storage/time
setters and deformation queries, Standard-material VAT and animated/morphed imported GPU instances
remain limited.

## Sprites

Sprite2D, billboards, atlases, animation, offscreen/depth targets, custom fragments and Y-sort are bounded.
Handle-object APIs, mixed transparent ordering, coverage gamma and broader picking combinations refuse.
Broader atlas options remain limited.
UV-scroll attributes require float32 scalar/vector formats.

## Picking

Basic/detailed picks retain resource identity, pending poses and supported skeleton/morph projection.
Filter/ignore/discard, deformed thin instances, VAT IDs and wider result/contributor combinations refuse.
Detailed picks exclude active thin instances, billboards and splats. PickingInfo retains identity;
engine-dependent name/normal queries throw after engine destruction, while payload reads survive.

## Flow graphs

KHR_interactivity supports SceneReadyEvent, OnSelect, Sequence, Get/SetVariable, Get/SetProperty,
Add/Subtract/Multiply/Divide/Modulo, Abs, Floor, LessThan, Clamp, CombineVector2 and ExtractVector2.
Targets include node visibility/selectability and base-color texture scale/offset. Selection uses a
primary tap within five pixels and GPU picking. Other blocks, accessors, contexts, data cycles and
BABYLON_flow_graph JSON refuse. Runtime/graph lists support length, indexing and nullish fallback.

## Display gizmos

Utility-layer display, bounding boxes and supported rotation editing retain native input and owner
identity. Lazy construction is supported. Camera deferral accepts zero-argument predicates for
shouldHandlePointerDown, isExternalDragActive and isExternalPickPending; wider options refuse.
Bounding-box and scale gizmo drags have no native editing.

## Physics

Bullet provides bodies, primitive/convex/mesh shapes, forces, motion, aggregates, mass, masks,
collisions/triggers, raycasts, floating origin and character control. Constraints admit ball/socket,
distance, hinge, prismatic, lock, slider and six-DOF with inline two-sided limits and discarded handles.
Springs/motors, retained constraint handles and inertia orientation refuse.

Thin-instance physics uses one native body per matrix, shared shape/property fanout and instance-indexed
ray/character/collision results. Collision callbacks retain removed bodies through after-step dispatch.
Thin physics with floating origin, body-aware trigger callbacks and retained trigger disposers are unsupported.

Heightfields require square ground-mesh grids/static bodies. Zero/degenerate shapes refuse. Container
construction precedes attachment; convex children admit finite nonzero scale. Mixed child
filters/materials/triggers and triangle children refuse. Proximity/casts require inline query bags and
convex targets. Viewers need construction-known shape descriptors and a native toolchain; constraint
overlays and observable startup membership refuse.
See [physics substitutions](fidelity.md#physics-contract).

## Audio

Renderer-independent LabSound/SDL3 supports no-options AudioContext, lifecycle promises, reached nodes,
AudioParam scheduling, decoded buffers and channel copying. Aliases retain identity and stopped clocks.
Owned buffers can cross contexts. Invalid decode rejects; channel copies preserve overlap/untouched data.

Async sources/oscillators support zero-argument ended listeners with removal/capture/once, including
promise callbacks. Context close cancels delivery. Event payloads, onended, AbortSignal, context options,
statechange and broader Babylon bus/spatial APIs refuse. Output selection/media streams/recording are
unavailable; supported capability guards expose absence. Closed-context graph operations, master ramps,
owned async main-bus metadata and nullable buffers remain limited.

## Shadows

PCF spot/directional, ESM directional and CSM support reached receivers/casters, layers, blur and morph
bounds. receiveShadows needs a known supported value. Broader options and thin-instance contracts refuse.
PCF normalBias/spot refresh and CSM stabilization/bias remain limited.
Generator enable changes retain resources and update receiver darkness; CSM callbacks retain source order.

## Navigation

Recast/Detour supports solo and obstacle tile-cache builds, debug geometry, bounded queries, crowds,
agents and obstacles. Tiled builds without obstacles, tile-cache builds with off-mesh connections and
unimplemented query/disposal APIs refuse.

## Frame graph

Scene-owned and scene-less graphs support ordered targets/tasks, overrides, depth, MRTs, blits and MSAA
resolve. Default tasks retain source ordering; authored tasks use explicit lists. Task
reordering/removal/disposal and broader resource views/samplers remain limited.

### Post-process passes

Leaf/composite passes support live uniforms, output identity and resize-relative targets.
Bloom weight reads/writes preserve the explicit updateUniforms boundary. TAA needs one scene, explicit
Standard color tasks, engine-format color, depth24plus-stencil8 and single-sample inputs.
Non-Standard draws, implicit/geometry/copy/shadow tasks, clustered lights, transmission, unprepared
renderer/UI contexts and post-registration topology changes refuse. Tracked camera writes retain versions;
untracked/reflective mutation, environment rotation and authored exposure/contrast changes refuse.

### Screen-space effects

Contact shadows and one-bounce GI use single-sample color/depth, temporal resolve and live supported settings.

### Fullscreen effects

EffectWrapper/EffectRenderer, UniformEffectWrapper and tasks admit bounded layouts/uniforms/textures.
Custom vertices, broader textures/descriptors and lifecycle/update APIs refuse.

### Image processing

Exposure/contrast are live outside TAA restrictions. Image-processing writes admit exposure, contrast,
toneMapping and toneMappingEnabled. Tone mapping participates in composition.

## Text

Static font parsing/shaping/packing runs at generation. Text data keeps the pin's runs, draw groups, style
palette and slot allocator: updateTextData reset/addRun/removeRun/replaceRun, updateDefaultTextData with or
without a color and per-run setFontWeightOffset are live. Live text lays out over the font's packaged
repertoire with static layout options; alignment is left/center/right. Runs are retained runs or copies
(`{ ...run, defaultColor, pixelsPerFontUnit }`); literal glyph lists, replacement storages and user glyph
storages (createGlyphStorage, extractGlyphCurves, createTextData) refuse.

Renderable text needs one text-only default scene with a static FreeCamera or supported ArcRotate controls.
Transforms/opacity are live; membership/order/depth precede attachment. Late attachment, reflective writes,
high-precision matrices and custom tasks refuse. Standalone layers support affine pixel placement,
opacity/gamma/visibility/order; data replacement and mixed renderer families refuse.

## Runtime scene mutation

Supported removal, material append and instance updates refresh plans/resources. Removing a mesh from its
last scene retires it, as the pin does: its geometry is reclaimed and later meshes reuse its record slots
(loader meshes and meshes a hierarchy still lists keep theirs); re-adding or cloning it refuses. Shadow
resources remain engine-owned.
