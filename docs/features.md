# Features

`bblitec` compiles a bounded TypeScript/Babylon Lite subset. Unsupported forms refuse during generation
or at explicit resource/device checks. [UI](ui.md) owns browser projection;
[fidelity](fidelity.md) owns semantic substitutions; [TODO](../TODO.md) lists gaps.

## Why anything is compile time

Assets, closed producers and shader composition run during generation. State, input, animation,
uploads and rendering run natively. There is no general JavaScript interpreter or dynamic module loader.

## Feature and capability selection

| Input | Selects |
| --- | --- |
| Reached APIs/properties/globals | Generated code, PAL units, native dependencies |
| Call options and asset loader predicates | Subfeatures, codecs, material variants |
| Pinned composition | Shader arms, layouts and binding requirements |
| Registry | Source, title, host UI, reference query and attribution |
| Build options | Backend, capture, size and PCH configuration |

`upstream/feature-activation.json` records sites, decisions and consumers. Reaching a factory can
activate its module even when one of its options is disabled.

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

Exercise percentages separate signatures, fields/accessors, constants and callbacks; type containers are excluded.
They qualify exercised forms only. Failed compilations, discarded probes and stale receipts earn no credit.
Unassessed declarations and type-dependent probe fallthrough mean unknown; `partial` combines positive and refusal evidence.
The remaining adapter boundary is unclassified, so no overall PAL completion percentage is available.
A project report sizes one external entry: the declarations it references, credited by the same evidence,
with its unrouted functions and pin gaps listed separately. See [collection commands](development.md#api-coverage).

## Program compilation

| Area | Supported | Limits |
| --- | --- | --- |
| Modules | Named/namespace imports, re-exports, constant aliases, external local TS/JS, JSDoc, `?raw`, ordered initialization | Runtime-selected modules; unrepresented mutable initializer dependencies |
| Control flow | Blocks, conditionals, switches, loops, break/continue, throw, catch bound to an Error carrying the native message, bounded finally | Suspended catch/finally; arbitrary cleanup across `startEngine` |
| Functions | Typed/generic functions, defaults, rest parameters, destructuring, supported recursion, stored values shared or adapted across sink signatures | Unresolved type arguments; unbounded resource specialization; a stored value cannot take a narrower signature; an adapted value is rebuilt at each reach |
| Classes | Fields, methods, accessors, generics, retained callbacks, receiver-preserving structural views, private names for fields, methods and accessors | Inheritance, private brand checks (`#x in value`), static fields and blocks; unsupported field storage |
| Closures | Shared mutable cells, function identity, optional calls, escaping recursive groups | Captures need owned representations; events cannot escape dispatch |
| Data | Typed/nullable records, discriminated and mixed unions, arrays, tuples, dictionaries, Map/Set, JSON | Optional own-property presence; erased native mutation; storage ambiguities |
| Async | Realm-owned promises, async functions/methods/IIFEs, early returns, loops, retained activations | Custom thenables; await in catch/finally; general async iteration |
| Workers | Local module scripts, isolated module state, typed cloning, timers, errors, close/terminate | Classic/runtime-selected scripts; incompatible rendering products |
| Worker graphics | OffscreenCanvas transfer, independent scene owners, shared Window presentation | Transfer lists admit OffscreenCanvas only; shared-device recovery refuses |

Local JavaScript implementations take precedence over companion declarations. Type-only imports do not
run initializers. `declare` creates no runtime value; bare `typeof` of an absent binding is `"undefined"`.

`import.meta.env` uses production client constants: `MODE="production"`, `PROD=true`, `DEV=false`,
`SSR=false`. `BASE_URL` follows deployment. Custom string fields use `--env NAME=value` or
`CompileOptions.environment`; absent keys are undefined. Built-ins cannot be overridden; dotenv and host
variables are not loaded implicitly.

Defaults and short-circuit operands evaluate once and lazily. Destructuring finishes the source before
left-to-right target writes. Defaults requiring distinct null/undefined states refuse when storage
cannot distinguish them. `for...of` admits identifiers, tuple/rest bindings and plain struct fields;
nested/default/renamed struct bindings refuse.

Dynamic JSON preserves actual fields and object identity through typed locals, arguments, conditionals
and represented generic returns. Source-backed record ownership can trigger compiler replay, preserving
earlier aliases and initializer counts. Optional-property presence, earlier class instances and mutations
through erased native records/arrays remain limited. Getters permit statements before a final return;
early returns refuse.

| Promise operation | Contract |
| --- | --- |
| `resolve` / constructor | Object identity; synchronous executor; first settlement wins; represented promise adoption |
| `then` / `catch` | Owned captures, queued reactions, compatible result storage; callback throws reject; `catch` and rejection callbacks bind their parameter to the caught Error |
| `finally` | Waits for cleanup; preserves original result unless cleanup throws/rejects |
| `all` | Ordered literal tuples and stored arrays of value promises; first rejection wins |
| `race` | Homogeneous represented arrays/tuples; empty input stays pending |

Custom thenables, arbitrary rejection values, heterogeneous race results and unrepresented aggregation
shapes refuse. `all` excludes literal spreads, other iterables and stored void/value-only arrays.
Async collection callbacks start synchronously and retain suspension; predicate promises are truthy.
Timers/microtasks need no engine. RAF needs a Window repaint source. Unhandled rejections are reported
in a subsequent task after microtasks. Worker cloning retains supported cycles/aliases and copied
buffers; MessagePort, shared memory and broader transferable values refuse.

### Core TypeScript library

| Area | Supported | Limits/adaptations |
| --- | --- | --- |
| Numbers | Reached Math operations, non-coercing Number predicates/constants, JS coercions and rounding, numeric callbacks | Native double transcendental functions; deterministic random; bounded rest signatures |
| Variadic Math | `min`, `max`, `hypot`, numeric tails and array spreads | Native `hypot` approximation; NaN/signed-zero rules retained for min/max |
| Arrays | Map/filter/find/reduce/predicates, flatMap/flat/concat, sorting, indexed searches, fill/copyWithin/splice, joins | Closed flatten depth; no callback `thisArg`; some scalar pop/shift paths require nonempty arrays |
| Tuples | Shared identity, typed and dynamic lanes, mutations, shallow rest arrays, destructuring | Sparse length growth and ambiguous null/undefined defaults refuse |
| Map/Set | Ordered construction, queries, mutation, spreads, entries, live `forEach` | WeakMap/WeakSet retain keys strongly |
| Iterators | Direct array/Map/Set iteration; retained Set keys/values/entries cursors, `next`, spreads, `Array.from` | Generators and general `Symbol.iterator` objects refuse |
| Strings | UTF-16 indexing/length, substring/repeat/concat, padding/trimming, replacement strings/callbacks | Native WTF-8 storage; embedded NUL value sinks remain limited |
| RegExp | Supported `g`/`i` patterns and replacement callbacks with captures/offset/original string | RegExp `replaceAll` with string replacement refuses |
| Unicode | NFC/NFD/NFKC/NFKD normalization; `localeCompare` locale/options | Host ICU data; option getters and non-string locale entries refuse |
| Objects | Supported keys/values/entries, assign/fromEntries/hasOwn/is, shallow spreads, delete/in | Fixed own-key proof required for optional structs; freeze/seal/preventExtensions are identity operations |
| JSON | Represented parse/stringify, actual dynamic fields, index-key order, undefined-property omission | Replacers and cyclic serialization refuse |
| Dates | Current/numeric/copy construction, now/getTime/valueOf/setTime, UTC `toISOString` | No string/calendar constructors or broader methods |
| Intl | Default DateTimeFormat and resolved time zone | No explicit locale/options, formatting or broader fields |
| URLSearchParams | String constructor, get/has, duplicate order, decoding, optional has value | Mutation, serialization, iteration and other constructors refuse |
| Binary data | ArrayBuffer, DataView getters/setters, Int8/Uint8/Int16/Uint16/Int32/Uint32/Float32/Float64 arrays | Unrepresented element/storage consumers refuse |

Typed-array buffer views retain bytes, offset, length and identity. Constructors check ToIndex,
alignment and bounds; set/slice/subarray/fill/copyWithin preserve overlap rules. Raw contiguous
consumers and some iteration paths refuse views. `ArrayBufferView` retains typed arrays and DataView.
Numeric index-signature writes preserve element conversion and grow ordinary arrays.

Array/object aliases retain identity. Spreads copy own scalar fields and share nested objects.
Object enumeration places numeric index keys before insertion-ordered names. Fixed record key
snapshots retain initialized keys; module namespace keys are lexical and values remain live.
String-literal-union searches accept outside strings as misses. `invertMat4` returns nullable fresh
Float32 storage; Float64/high-precision combinations refuse.

## Asset materialization

Reached URLs and base64 data become packaged assets. `--public-dir` maps deployment-relative assets;
`--site-url` sets the base (default `http://localhost/`). Other origins use remote loading.
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

KTX1 packages mips/blocks. Basis/KTX2 uses the pinned browser transcoder and supported native compression
families. Upload checks device support. Decoder bytes key caches; local decoder inputs are tracked.

### Gaussian splat row updates

`splatsData` and `updateData(ArrayBuffer)` share owned rows. Equal-count replacement preserves old
aliases and refreshes rendering/picking. Borrowed buffers and writes to the getter-only property refuse.

### Environment compilation

HDR uses pinned GGX prefiltering; DDS preserves specular mips; `.env` uploads decoded cubes. The BRDF LUT
is baked. Static box/sphere local environments and blended probe sets support setup before registration.
Live probe rebuilding/ORM rebinding refuse; direct intensity remains live.

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
texture/blend changes refuse. Finally across `startEngine` admits plain writes only.

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
before startup and observations require one scene. Failure callbacks expose `Error.message`.
Shared worker/offscreen recovery and engine render-function wrapping are unsupported.

Same-engine canvases have independent targets, cameras, rectangles and input ownership.

## Cameras and input

ArcRotate/Free cameras, framing, bounded orthographic projection, viewports and supported SDL controls
are live. Geospatial input, off-center orthographic planes and broader camera combinations refuse.

## Android

ARM64/x86_64 APKs use SDL_GPU/Vulkan on API 28+; retained UI requires API 29+.
RmlUi, LabSound/SDL audio and worker canvases sharing one native window are enabled.
Authored maxDevicePixelRatio caps the render buffer independently of the full-screen view.
Apps use landscape orientation and immersive fullscreen. Reveal navigation with a bottom-edge swipe;
system Back exits the activity. Multi-touch supports simultaneous UI controls and camera gestures.
Multiple native windows and Dawn remain unsupported. Full corpus and
physical-device performance qualification remain open.
[Commands](development.md#android).

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

## Geometry and meshes

Reached primitives, data factories, ribbons/extrusions/polyhedra, lines, CSG and thin instances use their
admitted option sets. Box/sphere data is mutable and shared through aliases. Unknown-count mesh/Standard/
shader factories require compatible profiles. Static expansion is capped at 4,096 iterations/1 MiB;
parameterized composition tables at 65,536 records each. Wider dynamic geometry updates remain limited.

## Scene hierarchy

Local/world transforms, visibility, parenting and bounded imported walks/cloning are represented.
Meshes may parent to meshes or transform nodes; transform nodes require transform-node parents.
Parent assignment and child insertion are separate. Imported roots expose position/Y rotation;
scaling, other rotations and broader cloning refuse. Detached imported leaves share geometry.
Opaque cached lists require visibility invalidation; transparent/transmissive visibility is live.

## Lights

Directional, hemispheric, point and spot lights support reached setters and per-mesh selection.

### Clustered lights

PBR clustered containers compose shaders at generation and update bins/data textures natively.

## Materials and material state

Standard, PBR, Grid, shader and selected no-color views support reached properties. PBR layers include
clearcoat, sheen, iridescence, anisotropy and transmission. UV/lightmap/vertex-color opt-ins remain explicit;
lightmap binding precedes registration. Runtime texture-producer choices refuse.

Public factors retain array identity/double precision. Reads require one registered scene and represented
producer identity. Rebuilds and replacement after binding refuse; direct array writes do not bump UBO
versions. Public glTF albedo reads exclude material extensions, transforms and BasisU.

Shader materials admit bounded 2D/array samplers, float/depth/comparison sampling, storage buffers and
selected uniform/system matrices. Wider descriptors, pipeline state and live composition profiles refuse.

### Node materials

Closed NME graphs compose once per shape with distinct owners. Texture slots may be filled before
registration; required missing bindings refuse. Numeric inputs, reflective/map mutation and later
producer/topology changes refuse. Public input observations require one scene.

Geometry MRTs admit IRRADIANCE, WORLD_POSITION, LOCAL_POSITION, REFLECTIVITY, VIEW_DEPTH,
NORMALIZED_VIEW_DEPTH, SCREENSPACE_DEPTH, VIEW_NORMAL, WORLD_NORMAL, ALBEDO and LINEAR_VELOCITY.
Imported geometry needs static tightly packed FLOAT attributes; deformation, instancing and imported
transform mutation/cloning refuse. Missing normals and used strided attributes refuse.

### Material plugins

Explicit enablement supports custom code and Standard sampler/texture bridges. Broader uniform writers,
runtime signatures and PBR sampler plugins refuse.

## Animation playback

GLTF supports LINEAR/STEP/CUBICSPLINE, TRS, skin/morph and admitted material/light/visibility pointers,
seeks, speed, masks and weighted/additive mixing. Metallic-roughness texture-transform pointers are ignored
by the pin. Property tracks support numeric leaves and linear/step interpolation; replacement does not retarget.

Managers support fixed delta, onUpdate and autonomous RAF start/stop. First variable delta is zero;
autonomous updates notify after evaluation. Autonomous and older persistent RAF lowering cannot coexist.

## Deformation and instancing

GPU skinning, storage morphs, VAT and thin-instance pools are supported. Direct morphs require one
pre-start attachment per mesh; conditional/replacement/thin-instance combinations refuse. Imported clones
share deformation resources. Standard skeletons require enablement. Thin-instance arrays retain aliases;
GPU culling has an [adaptation](fidelity.md#semantic-contract).

## Sprites

Sprite2D, billboards, atlases, animation, offscreen/depth targets, custom fragments and Y-sort are bounded.
Handle-object APIs, mixed transparent ordering, coverage gamma and broader picking combinations refuse.
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

## Physics

Bullet provides bodies, primitive/convex/mesh shapes, forces, motion, aggregates, mass, masks,
collisions/triggers, raycasts, floating origin and character control. Constraints admit ball/socket,
distance, hinge, prismatic, lock, slider and six-DOF with inline two-sided limits and discarded handles.
Springs/motors, retained constraint handles and inertia orientation refuse.

Thin-instance physics uses one native body per matrix, shared shape/property fanout and instance-indexed
ray/character/collision results. Collision callbacks retain removed bodies through after-step dispatch.
Thin physics with floating origin, body-aware trigger callbacks and retained trigger disposers are unsupported.

Heightfields require square ground-mesh grids/static bodies. Container construction precedes attachment;
convex children admit finite nonzero scale. Mixed child filters/materials/triggers and triangle children
refuse. Proximity/casts require inline query bags and convex targets. Viewers need construction-known
shape descriptors and a native toolchain; constraint overlays and observable startup membership refuse.
See [physics substitutions](fidelity.md#physics-contract).

## Audio

Renderer-independent LabSound/SDL3 supports no-options AudioContext, lifecycle promises, reached nodes,
AudioParam scheduling, decoded buffers and channel copying. Aliases retain identity and stopped clocks.
Owned buffers can cross contexts. Invalid decode rejects; channel copies preserve overlap/untouched data.

Async sources/oscillators support zero-argument ended listeners with removal/capture/once, including
promise callbacks. Context close cancels delivery. Event payloads, onended, AbortSignal, context options,
statechange and broader Babylon bus/spatial APIs refuse. Output selection/media streams/recording are
unavailable; supported capability guards expose absence. Closed-context graph operations remain limited.

## Shadows

PCF spot/directional, ESM directional and CSM support reached receivers/casters, layers, blur and morph
bounds. receiveShadows needs a known supported value. Broader options and thin-instance contracts refuse.

## Navigation

Recast/Detour supports solo and obstacle tile-cache builds, debug geometry, bounded queries, crowds,
agents and obstacles. Tiled builds without obstacles and unimplemented query/disposal APIs refuse.

## Frame graph

Scene-owned and scene-less graphs support ordered targets/tasks, overrides, depth, MRTs, blits and MSAA
resolve. Default tasks retain source ordering; authored tasks use explicit lists.

### Post-process passes

Leaf/composite passes support live uniforms, output identity and resize-relative targets. TAA needs one
scene, explicit Standard color tasks, engine-format color, depth24plus-stencil8 and single-sample inputs.
Non-Standard draws, implicit/geometry/copy/shadow tasks, clustered lights, transmission, unprepared
renderer/UI contexts and post-registration topology changes refuse. Tracked camera writes retain versions;
untracked/reflective mutation, environment rotation and authored exposure/contrast changes refuse.

### Screen-space effects

Contact shadows and one-bounce GI use single-sample color/depth, temporal resolve and live supported settings.

### Fullscreen effects

EffectWrapper/EffectRenderer, UniformEffectWrapper and tasks admit bounded layouts/uniforms/textures.
Custom vertices, broader textures/descriptors and lifecycle/update APIs refuse. Retained UI with
scene-less effect/frame-graph drivers is unsupported.

### Image processing

Exposure/contrast are live outside TAA restrictions. Image-processing writes admit exposure, contrast,
toneMapping and toneMappingEnabled. Tone mapping participates in composition.

## Text

Static font parsing/shaping/packing runs at generation. Live default text retains one run, packaged font,
palette, dimensions and static layout options. Alignment is left/center/right. Retained run color replacement
and setFontWeightOffset are bounded; arbitrary run edits/live color arguments refuse.

Renderable text needs one text-only default scene with a static FreeCamera or supported ArcRotate controls.
Transforms/opacity are live; membership/order/depth precede attachment. Late attachment, reflective writes,
high-precision matrices and custom tasks refuse. Standalone layers support affine pixel placement,
opacity/gamma/visibility/order; data replacement and mixed renderer families refuse.

## Runtime scene mutation

Supported removal, material append and instance updates refresh plans/resources. Unshared removed
geometry can be reclaimed; re-adding retired meshes refuses. Shadow resources remain engine-owned.
