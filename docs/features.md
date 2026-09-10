# Features

This page owns supported behavior, activation and limits. The compiler accepts a bounded
TypeScript/Babylon Lite surface. Unsupported source usually refuses during generation;
device and loaded-resource checks may fail at runtime. See [fidelity](fidelity.md) for
intentional substitutions, [status](status.md) for measurements and [TODO](../TODO.md) for unfinished work.

## Why anything is compile time

Generation packages assets, runs browser-dependent producers and composes the closed shader set.
Scene state, animation, input, uploads and drawing remain native. Executables have no arbitrary
JavaScript execution, dynamic module loader or runtime network fetch.

## Feature and capability selection

Reached APIs and asset-discovered features determine what is emitted. Calling an optional factory
can activate its module even when an option is explicitly disabled.

| Selection | Authority and effect |
| --- | --- |
| API reach | Intrinsic calls, property writes, browser globals and dynamic-import shapes record a feature with its reaching site; features select generated sources and PAL units. |
| Call options | Option flags on a reached call (floating origin, tile-cache obstacles) select sub-features. |
| Asset discovery | The pin's loader predicates over packaged assets join features (lights, IBL, splats, KTX, interactivity) and select image codecs and their dependencies. |
| Composition shape | The executed pinned composer's arms and bindings select variant counts and material capability defines; shadow resources, receiver families and ESM have their own conjunction gates. |
| Registry and companions | `source`, `title`, `nativeHostUi`, `parity.referenceSearch` and `parity.attribution` are the only registry fields that reach generation; a reviewed `ui/*.json` companion activates the retained UI. |
| Build options | Backend, size, capture and precompiled-header switches select build shapes; see [development](development.md#native-builds). |
| Refusals | Unsupported combinations stop generation. |

`upstream/feature-activation.json` records these decisions and their origins.
Audio, physics, navigation, retained UI and codecs also select their native dependencies.

## Program compilation

| Surface | Supported shape |
| --- | --- |
| Entry/modules | Local or imported entry helpers, supported top-level statements, named local imports/re-exports and ordered reached initializers. |
| Control flow | Blocks, conditionals, supported switches and loops, applicable break/continue, throw, bounded catch and finally. |
| Functions/classes | Data-typed functions, supported recursion, defaults, shared resource helpers, local fields/methods/accessors and demanded shared instances. Definite PBR/glTF calls preserve per-call metadata; unsupported shared return shapes inline. Stored subclass dispatch is unsupported. |
| Closures | Supported retained API callbacks, timers/RAF, shared outer cells and represented function identity. |
| Data | Typed/nullable records, arrays, insertion-ordered Map/Set, tuples, destructuring, spreads and bounded static records. |
| Numeric/string | Reached Math, JavaScript rounding/coercions, deterministic random and supported string operations. |
| JSON | Generated stringify codecs and dynamic parsed values with source shape checks; unsupported replacers and cyclic serialization refuse. |
| Binary data | ArrayBuffer, DataView, reached typed arrays and supported owned-storage methods. |
| Browser/UI | Query folding, bounded erasure, live canvas extents, retained DOM/CSS/Canvas2D; see [UI](ui.md). |
| Workers | Local module workers, isolated module state, typed cloned messages, listeners, errors, close/terminate, timers and bounded promises. |
| Worker graphics | Transferred OffscreenCanvas, independent engines, source resize, display-paced rendering and a Window host companion. |
| Storage/files | Per-user localStorage, bounded Blob/object URLs, one-file open and download; see [file controls](ui.md#file-transfer-controls). |

Numeric typed-array views retain shared ArrayBuffer bytes, identity, offset and length across aliases,
callbacks and returns. Constructors apply ToIndex, alignment and bounds checks. Explicit nonnumeric
arguments refuse. Buffer views support indexed access but refuse contiguous-storage consumers,
iteration, copying constructors, fill/set/slice/copyWithin and numeric subarray. Owned arrays retain
those supported methods. Effectful indices into borrowed native vectors refuse without retained storage.

`mat4Invert` returns fresh nullable Float32 storage; singular matrices return null. Float64 inputs
and high-precision matrix allocation combinations refuse. Generic functions, resource loops, aliases
and handle-dependent escapes are bounded; see [ownership](architecture.md#runtime-and-memory).

AOT asset awaits differ from frame-yield continuations. Workers use owner-loop promises for reached
async functions. Worker codecs support typed plain data, cycles, repeated references and copied
buffers. Transfer lists admit OffscreenCanvas only; MessagePort and shared memory are unsupported.
Classic workers and runtime-selected scripts refuse. Worker options admit `name`, `type: "module"`
and `credentials: "same-origin"` only. Graphics realms need identical rendering products.

Native `for...of` accepts an identifier, plain tuple/map-entry bindings or plain struct field bindings.
Nested patterns, defaults, rest bindings and renamed struct fields refuse.

### Core TypeScript library

User code supports `Math.fround`, `acos`, `asin`, `log`, `log2`, `cbrt`, `sinh` and
`clz32`; Number constants and `isFinite`, `isNaN`, `isInteger`, `isSafeInteger` retain
their non-coercing predicates. Transcendental operations execute at native double precision.

Dense `T[]` arrays of user data support `flatMap`, `concat`, `at`, `lastIndexOf`,
`copyWithin`, `join` for strings/numbers/booleans/enums, ranged `fill` and `splice` with removal/insertion.
`fill` and `copyWithin` return the original array; `splice` returns a fresh array
of removed values. `Array.of`, `Array.from(arrayOrSet)`, and length-only
`Array.from({ length }, (value, index) => ...)` are admitted. Callback overloads
require a local function or function literal and omit `thisArg`.

Map construction accepts literal key/value pairs or another Map with matching
types. Map/Set `forEach` observes insertion order, deletion and appended entries,
and receives the original collection as its third argument.

Strings support string-pattern `replace`/`replaceAll` with string replacements
and substitution tokens, `substring`, `repeat`, string-argument `concat`, `at`
and `codePointAt`. These indexed methods and string length use UTF-16 code units;
native storage is UTF-8, with WTF-8 for lone surrogates. Regex `replaceAll`,
replacement callbacks, locale collation and normalization remain unsupported.

## Asset materialization

Reached local/remote URLs become packaged assets; glTF buffers/images are embedded as needed.
Base64 data URLs decode during generation. Dynamic URLs outside supported producers and
percent-encoded asset data bodies refuse.

### Compressed geometry

Pinned Draco/meshopt decoders and document hooks run during packaging, preserving hook order.
Sparse, quantized and compressed inputs become ordinary native accessors. Other extensions refuse.

### Compressed textures

KTX1 is parsed at generation into a mip table and GPU blocks; native mip spans share that payload.
Basis and glTF KTX2 use the pinned browser transcoder
at generation. The compression target is fixed for the validated device family; native upload
checks device support. Sampler, encoding and invertY behavior are producer-specific.

### Gaussian splat row updates

`splatsData` reads and `updateData(ArrayBuffer)` retain shared source rows. Numeric views can edit
those bytes; buffer replacement preserves old aliases. Updates require equal row counts and owned
or retained storage, publish a version to both PALs, and refresh same-turn picking. Borrowed native
buffers [refuse at update](../src/lowering/splat-lowerer.ts). `splatsData` is getter-only; replace rows through `updateData`.

### Environment compilation

HDR uses pinned WebGPU GGX prefiltering at generation. DDS preserves stored specular mips and
uses pinned harmonic derivation. Native `.env` loading uploads decoded cube data; the IBL BRDF LUT is offline.

PBR local environments retain independent `.env` results. Static box/sphere projection and
blended probe sets execute the pinned validation, grid/UBO packing and texture-copy planning.
Configuration, debug selection and solid ORM replacement must precede scene registration;
live probe rebuilding and ORM rebinding refuse. Direct-intensity writes remain native.
Single-environment options admit `shape`, `projectionPosition`, `projectionSize`, `projectionRadius`
and `capturePosition`; probe-set options admit `probes`, `voxelGrid` and `parallaxCorrection` only.

### Drawn and computed assets

Bounded module producers bake atlases/pixels in Chromium. CSG uses the pinned implementation;
CSG2 uses pinned Manifold WASM and preserves material partitions. Both package baked geometry
as binary streams. CSG2 requires unchanged,
identity-transform box/sphere solids; preceding material assignments work.
[Runtime CSG2 control](../src/compiler/intrinsics/mesh.ts) refuses.

### Browser-produced textures

Bounded scene functions can own a canvas and call pinned pixel/texture factories. Generation retains
pixels/blob and texture options; unrecognized calls or engine reads refuse. Live Canvas2D UI is separate.

### Node particles

- Sets stepped or frozen before their first frame, without an emitter provider, are baked. Frozen
  buffer aliases expose capacity/count and full-capacity numeric reads. Later simulation/column writes,
  nonfinite values, negative zero and native buffer access with composed set membership refuse.
- Frozen Sprite2D sheets retain shared Uint16 cells and observe cell writes each frame. [Sheet replacement](../src/compiler/particle-sheet.ts),
  effectful callbacks and broader binding/view options refuse; cell dimensions are captured at atlas creation.
- Unstepped pure-2D bindings can simulate natively. Covered evaluators include static emit rate,
  CreateParticle, world Box/local Point shapes, position/color updates, textures, supported Input/Math/Lerp/
  Converter blocks and None/PerParticle/PerSystem random. Other local shapes, connected emit rates,
  once-per-particle random, aliased math, sprite sheets and live MultiplyAdd blending refuse.
- `withNodeParticleEmitterProvider` selects native simulation, including pre-frame steps. Its retained
  Float32 matrix callback is sampled at wrapping and once per started animation call, including stopped
  emission or zero update speed. Registration honors autoStart and animate-then-sync ordering.
- Provider sets require definite initialization. Mixed native/frozen sets, composed system lists,
  standalone provider options, explicit provider bridges, inverse-matrix registration and unsupported
  hooks refuse. Texture changes and blend enabling after registration also refuse.

Native random overrides preserve closure/function identity. A finally spanning startEngine runs when
its continuation completes; cleanup admits plain writes, not calls, accessors or explicit throws.

## Shader pipeline

Generation composes the reached closed shader set. Shader origins and semantic
constraints belong in [fidelity](fidelity.md#shader-contract); compiled target
formats and binding authority belong in [backends](backends.md#compiled-binding-contract).

## Engine, scene, and frame loop

Registration, rendering contexts, fixed/live time, supported callbacks, timers and frame gates share
one conductor. Scene, SpriteRenderer, EffectRenderer and scene-less FrameGraphContext drivers activate
independently. Immutable engine aliases retain identity; rebinding them or [creating multiple engines](../src/compiler.ts)
within one entry point refuses.

Device-loss scene recovery retains CPU owners and rebuilds GPU resources on SDL_GPU and Dawn.
Registration must be unconditional before startup; resource observations support one registered scene.
Loss/recovered callbacks take no arguments; failure callbacks expose `Error.message`. Worker/offscreen
device ownership refuses. Forced loss, repeated recovery, resize, controls and disposal are validated.
Shadow-only PBR color/opacity/falloff must settle unconditionally before scene registration.

Reviewed host canvases can share one engine while retaining separate scene targets, clear colors,
camera projections and pointer capture. Canvas rectangles drive allocation and resize; default scene
graphs share the original mesh/material identities. Wider surface options and lifecycle combinations
are unsupported.

## Cameras and input

ArcRotate/Free cameras, framing, bounded orthographic projection, viewports and supported SDL controls
are live. Geospatial cameras render their compiled pose; geospatial input is unsupported.
Canvas dimensions follow drawable extent. Off-center orthographic planes and wider combinations are unsupported.

## Asset loading and upload

Generated glTF loaders create supported meshes, materials, lights, cameras, skins and animation,
including packaged external/compressed resources and reached material extensions. Unsupported branches refuse.
Skin inverse bind matrices require contiguous, unnormalized FLOAT MAT4 accessors.
Animation samplers require contiguous accessor storage and complete elements.
Mesh order, names and base/variant material scheduling execute from the pinned loader during packaging.
Unused base declarations allocate no render material; variant materials retain separate identities.
Separate occlusion and metallic-roughness images use the pinned ORM composition and upload path.
Its CPU Canvas2D adapter requires equally sized opaque images; scaling, alpha compositing and
compressed bitmap composition refuse.
`.babylon` loading supports parented meshes, container nodes, Standard materials, point lights and cameras.
Mesh construction, hierarchy and material/scene control flow lower from the pin. `loadCamera` and
`loadTextures` are honored; `maxMeshes` is unsupported.

Recognized closed glTF and `.babylon` collectors retain source traversal independently of native flat
mesh storage. glTF owner maps retain insertion order. Metadata is demanded per asset/collector pair. Rest/default/
optional collector parameters, partial/repeated hierarchies, instanced/splat producers and early break refuse.

## Geometry and meshes

Reached primitives, mesh data, ribbons/extrusions/polyhedra, line systems, CSG, thin instances and transform
writes support their admitted option sets. `createBoxData` accepts numeric size or literal size/width/height/
depth options. Box/sphere data return mutable typed arrays: aliases share storage; separate calls do not.

Fixed-composition resource loops can emit native loops while retaining creation order. Unknown-count
mesh/Standard/ShaderMaterial factories require compatible profiles. Ordinal-dependent PBR/glTF allocation
and unbounded specialization refuse. Static expansion is capped at 4,096 iterations and 1 MiB, including
failed probes; parameterized mesh/material composition tables are capped at 65,536 records each.

## Scene hierarchy

Scene-created transform nodes, supported parenting, local/world transforms, visibility and bounded
imported walks/cloning are represented. Position/rotation/scaling aliases retain their owner handle.
Meshes can parent to meshes or transform nodes; transform nodes can parent only to transform nodes.
Parent assignment and children-list insertion remain separate operations.
TRS vectors accept x/y/z components; mesh rotation quaternions accept x/y/z/w only. Imported roots
expose position and Y rotation; scaling and quaternion writes require retained outer transforms.

Detached static imported leaves share geometry and restore local attributes. Babylon imports retain their
initial source TRS; [cloning one after transform mutation](../src/lowering/scene-lowerer.ts) refuses.
Clones can be transformed and cloned again.

Bare visibility writes are live for transparent/transmissive draws. Opaque cached lists require
`setMeshVisible` invalidation. Full imported-root cloning/rotation/scaling and arbitrary visitor effects are unsupported.

## Lights

Directional, hemispheric, point and spot lights support reached setters and per-mesh selection.
Asset discoveries activate needed features. PBR analytic lights use the reached composed variants.

### Clustered lights

The optional PBR clustered container selects shaders at generation and updates light/bin/data textures natively.

## Materials and material state

Standard, PBR, Grid, shader materials, supported no-colour views and live properties are available.
Reached PBR layers include clearcoat, sheen, iridescence, anisotropy and transmission. Explicit lightmap,
Standard UV and vertex-colour opt-ins remain distinct from asset discovery; live UV offsets require
`enableStandardUvOffset`. Vertex-alpha meshes select the matching transparent variant.
Standard file lightmaps preserve texture encoding, UV channel, intensity, additive/shadowmap blending
and the pinned `uAng === Math.PI` V flip. Texture binding requires setup before registration.

Public PBR factor/Standard diffuse arrays retain identity and double precision; factors have four
channels and diffuse colors three. Standard whole-array replacement retains its supplied storage.
Use owning numeric arrays for factory inputs; static readonly tuples and legacy object-color adapters
cannot co-reach numeric-array reads. glTF preserves absent versus explicitly supplied factors.

[Numeric color reads](../src/compiler.ts) admit at most one registered scene. Later group construction, rebuilds and color
replacement after binding refuse. Write-only replacements work before first binding, including new callback-created
materials. Direct array changes affect source reads without implicitly bumping the pinned material UBO version.

Public albedo reads retain source texture identity across sharing, replacement and equal-byte distinct
factories. glTF requires [packaged producer associations](../src/gltf-material-texture-identity.ts); missing identity fails. Core images/factors,
sampled wrappers and UV2 clones work; material extensions, texture transforms and BasisU refuse when
public albedo reads are reached.

Shader materials support bounded 2D/2D-array samplers, float/depth/comparison sampling, declared storage
buffers and supported uniform/system matrices. Live material choices need compatible known instancing
profiles. Wider [descriptors, fixed-function options and system values](../src/compiler/shader-material.ts) refuse.

### Node materials

Closed NME graphs compose at generation, including supported alpha-combine transparency and block loaders.
Repeated construction shares composition but retains distinct material/input owners. Texture input handles
survive aliases/helpers/containers. Setup can fill textures after attachment and before registration;
binding captures the original private slot and fails if required data is missing. Unused materials may stay unset.

[Numeric inputs, map/reflective mutation](../src/compiler/node-input-surface.ts), later texture producers and post-registration topology/input
changes refuse, including `options.textures`-only materials. Public inputs require one registered scene.
Geometry tasks compose per-task MRT views with raw POSITION/NORMAL/UV, source indices and per-view world
matrices; LOCAL_POSITION reads raw positions. Morphs, environment/shadow lights and trailing colour attachments refuse.
Geometry texture types admit IRRADIANCE, WORLD_POSITION, LOCAL_POSITION, REFLECTIVITY, VIEW_DEPTH,
NORMALIZED_VIEW_DEPTH, SCREENSPACE_DEPTH, VIEW_NORMAL, WORLD_NORMAL, ALBEDO and LINEAR_VELOCITY only.

[Imported node geometry](../src/node-geometry-assets.ts) requires static tightly packed FLOAT positions/normals and FLOAT UVs when present.
Missing normals, strided used attributes, deformation/instancing and imported transform mutation/cloning
refuse. Tight accessor offsets and unused strided views are valid. Proven scene-authored transforms remain supported.
See [node controls](debugging.md#before-calling-a-scene-done) for the browser resize limitation.

### Material plugins

Explicit enablement installs supported custom-code and sampler/texture bridges. Standard textures retain
per-material identity. Wider uniform writers, runtime signatures and PBR sampler plugins are unsupported.

## Animation playback

Property clips and glTF channels have separate deterministic seek runtimes. Reached glTF channels include
TRS, skinning, morph weights and animation-pointer material/visibility targets. Metallic-roughness texture
transforms retain load-time values because the pinned resolver ignores those animation targets.

Property groups bind mutable numeric data leaves to their owner at group creation; intermediate replacement
does not retarget them. Owner/property identity governs mixing. Missing, readonly, nonnumeric and whole-vector/array targets refuse.
Property tracks admit `linear` and `step` interpolation only.

Managers support fixedDeltaMs, retained onUpdate and autonomous RAF start/stop. The first variable tick is
zero; autonomous updates notify afterward, while manual updates/seeks do not. Engine-less Canvas2D uses
its private presentation host. Autonomous managers cannot co-reach older persistent application RAF lowering.

## Deformation and instancing

GPU skinning, storage morphs, VAT and dynamic thin-instance pools are supported; loaded eight-influence
skins are an [adaptation](fidelity.md#semantic-contract). Direct Standard/PBR morphs require one definite pre-start
attachment per mesh; replacement, conditional attachment and thin-instance combinations refuse. Weight updates work.
Scene-authored skeletons retain arrays/live palettes; Standard needs `enableStandardSkeleton`.

Thin-instance pools support count/matrix/color/flush and add/remove operations. GPU-culling enablement
is an [adaptation](fidelity.md#semantic-contract).

## Sprites

Supported paths include Sprite2D layers/renderers, offscreen/depth-hosted targets, billboards, atlases,
animation, custom fragments and Y-sort. Options select pinned blend/shader arms and producer-specific mips.
Handle-object APIs, mixed transparent ordering, coverage gamma and several picking combinations are unsupported.
Pinned UV-scroll attributes must use `float32`, `float32x2`, `float32x3` or `float32x4`; other formats refuse.

## Picking

Basic/detailed GPU picks support mesh/cloud identity and points, with per-mesh skeleton/morph/combined
projection and pending-pose synchronization before submission. Billboard contributors are bounded.
Filter/ignore/discard options, deformed thin instances, VAT IDs, viewport and wider contributor/result combinations refuse.
Contributor checks use the picked scene and filter. Detailed picks refuse active thin instances, billboards
and splats; billboard picks refuse cutout, eye-relative positions and simultaneous splat contributors.

PickingInfo aliases share identity and reached hit/bu/bv writes through nullable helpers and containers.
Name/normal queries retain the original engine association and throw after engine destruction/move;
payload reads survive. Transported results cannot convert to bare Mesh handles; direct statically owned
pick casts remain supported. Picked points keep their tuple snapshot behavior.

## Flow graphs

glTF `KHR_interactivity` graphs are parsed at generation by the pinned parser and lowered per block:
each admitted block body is partially evaluated over the static graph into one update function per
data output and one execute function per signal input, in the pin's pull/push order. Admitted block
types: SceneReadyEvent, OnSelect, Sequence, GetVariable, SetVariable, GetProperty, SetProperty, Add,
Subtract, Multiply, Divide, Modulo, Abs, Floor, LessThan, Clamp, CombineVector2 and ExtractVector2.
Pointers bind by executing the pinned path converter over recording
stand-ins; supported targets are node visibility (cascading) and selectability and a material's
base-colour `KHR_texture_transform` scale/offset. Graphs attach when the asset's scene setup chains,
fire onStart on the first before-render tick and receive onSelect from `enableFlowGraphPointerPicking`
(primary-button tap within five pixels, GPU pick under the selectability filter). An asset with the
extension joins the feature. `flowGraphRuntimes` (awaited) reads as the container's list of attached
runtimes and `flowGraphs` as the document's graph list: length, index and `?? []`. A graph's
accessors, a runtime's context, `BABYLON_flow_graph` JSON, data cycles and other block types refuse.

## Display gizmos

Display, editing and bounding-box gizmos use a utility layer. Interaction requires supported pointer
registration; shape options and retargeting remain bounded. Nullable locals/class fields can create gizmos
on first use; reads before assignment refuse. Material producers retain their source RGB values and shared color arrays.
Rotation widgets register host pointer input, retain enlarged ring colliders and apply the pinned angle/quaternion
update in parent coordinates. Utility layers rematch GPU resources when lazy construction adds meshes.
Camera deferral accepts zero-argument predicates for `shouldHandlePointerDown`, `isExternalDragActive`
and `isExternalPickPending`; other options refuse.

## Physics

Constraint factories support BALL_AND_SOCKET, DISTANCE, HINGE, PRISMATIC, LOCK, SLIDER and SIX_DOF
with discarded results. Body-local anchors, collision opt-in and inline Cartesian/angular/radial limits
are supported. Both limit bounds are required; [springs, motor settings and retained constraint handles](../src/compiler/intrinsics/physics.ts) refuse.
Joints retain their bodies, follow mass-frame changes and detach while either body is outside their world.

Bullet implements the Havok-shaped PAL for reached bodies, primitive/convex/static-mesh shapes, forces,
velocities, motion/prestep, aggregates, centre of mass, masks, collisions/triggers, raycasts and floating origin.
Convex proximity/cast queries return local input and world target contacts, distance/fraction, trigger/mask
filtering and cast body exclusion. Query bags and quaternions require inline objects; concave/compound proximity
targets refuse. Dynamic triangle meshes use GImpact. Character movement kernels, capsule lifecycle and
collision callbacks lower from pinned source; collectors retain body identity across convex, mesh and compound contacts.
Mass and inertia overrides are supported. Omitted mass requires a positive primitive or closed convex volume.
Inertia-orientation overrides and non-Y-aligned capsule/cylinder segments refuse. See [physics fidelity](fidelity.md#physics-contract).

Heightfields accept ground meshes with square vertex grids and static bodies. Explicit sample bags and
rectangular grids refuse. Shape geometry options retain nullable scalar/vector fields through typed helper
returns; primitive family selection must be construction-known. Gravity setters support ordinary worlds,
all floating-origin regions or one region selected by world position.

Container shapes retain child ownership and source-derived relative TRS. Convex children support finite
nonzero scale per placement. Construction must finish before attachment; mixed child materials/masks,
triggers and triangle-mesh children refuse.

Body viewers retain show/hide/dispose, node transforms and the pinned always-depth line material.
Debug geometry requires construction-known HP shape descriptors and a native toolchain during compilation.
Show/hide return observations, observable startup debug membership and constraint overlays refuse.

Raycasts return nullable body identity, point/normal and double distance. Trigger selection and both masks
filter the closest eligible body. Arguments evaluate in source order; retained point objects expose changes
made by later arguments. Dynamic option aliases without native field storage refuse.

## Audio

Feature-selected LabSound/SDL3 supports reached Web Audio lifecycle, gain, oscillators, buffers, filters,
panning and AudioParam scheduling. `decodeAudioData` consumes encoded ArrayBuffer bytes at the context's
sample rate; fetched clips are packaged. Direct response-buffer reads select codecs by container signature.
Stored or constructed buffers retain all supported codecs. Broader Babylon sound/bus/spatial APIs and master ramps are unsupported.

## Shadows

Reached PCF spot/directional, ESM directional and CSM paths support receivers/casters, layers, blur and
morph bounds. [`receiveShadows`](../src/compiler/assignments.ts) needs a static supported value; false is not a general live variant toggle.
Wider thin-instance caster contracts and generator options are unsupported.

## Navigation

Recast/Detour supports solo and obstacle tile-cache builds, debug geometry, raycast/closest-point queries,
crowds, agents and obstacles. Tiled builds without obstacles and unimplemented queries/disposal refuse.

## Frame graph

Scene-owned/scene-less graphs support ordered targets/tasks, overrides, depth passes, geometry MRTs,
blits and MSAA resolve. Default tasks retain skybox/mesh/ground order; authored tasks use explicit lists.

### Post-process passes

Reached factories provide leaf/composite passes, live uniforms, output identity and resize-relative targets.
TAA requires one scene, explicit Standard colour tasks, engine-format color, depth24plus-stencil8 and proven
single-sample post-process inputs. Source tasks retain independent state and may select camera overrides.
Native preparation checks each submitted task's draw list, camera and scene. Non-Standard draws,
implicit defaults, geometry/copy/shadow tasks, clustered lights, transmission and registered unprepared
renderer/UI contexts refuse. Unused materials and resources outside these passes do not reject TAA.

TAA tasks must precede initial registration; rebuilds/topology changes refuse. Supported Arc-camera writes,
target components/bulk setters, limits, inertia and animation use tracked versions. Untracked producers,
parent/target replacement, copied target aggregates, computed/unlowered stores and Object.assign refuse.
Only one startup control attachment is allowed. Fog needs fresh inline configs/colors. Environment rotation
and authored exposure/contrast writes refuse until their cache invalidation/precision is represented.

### Screen-space effects

Contact shadows and one-bounce GI use a single-sample color/depth target, temporal resolve and depth-only
sampling. Supported settings, enablement and light direction are live; history/composite use post-process passes.

### Fullscreen effects

EffectWrapper/EffectRenderer, UniformEffectWrapper and their tasks support bounded layouts/uniforms/textures.
Custom vertex stages, arbitrary texture sources, wider descriptors and lifecycle/update APIs are unsupported.
[Retained UI with scene-less effect or frame-graph drivers](../src/compiler.ts) refuses.

### Image processing

Exposure/contrast are live outside the TAA refusal above. Tone mapping affects composition; transmission
uses the pinned linear-frame and trailing image-processing contract.
Image-processing property writes admit `exposure`, `contrast`, `toneMapping` and `toneMappingEnabled` only.

## Text

Static font loading/default layout run the pinned parser, shaper and packer at generation. Runtime strings
and `updateDefaultTextData` retain the packaged font, layout options, single run, palette and live dimensions.
Font size/options are static; alignment admits `left`, `center` and `right` only.
A retained single-run spread can replace defaultColor; the opt-in
`setFontWeightOffset` accepts a retained run or numeric index and preserves source clamping and group identity.
Explicit live color arguments and arbitrary run edits refuse.
Text data/renderables retain identity through aliases/helpers/containers. Transform setters and opacity are
live; pipeline membership, depth and order settle before attachment. Late attachment/disposal, conditional
transform copies, reflective/internal-buffer writes and high-precision matrices refuse.

Text rendering supports one text-only default scene with a static FreeCamera or supported ArcRotate
controls. [Binding validates the scene's attachments, tasks and camera](../native/src/pal_text_scene.hpp); unrelated resources are permitted.
Mixed ordering, custom tasks and other camera writes refuse. Both PALs use composed Slug shaders,
packed resources and pinned alpha-to-coverage or premultiplied blending; shared data retains its group-cache behavior.

Standalone TextRenderer layers support affine pixel placement, opacity, coverage gamma, visibility,
ordering and shared text data on both backends. Source bundle invalidation and a depthless single-sample
pass are retained. Layer data replacement, arbitrary renderer mutation and mixed renderer families refuse.

## Runtime scene mutation

Supported removal, material-family append and instance updates refresh plans/resources. Unshared removed
geometry can be reclaimed; re-adding retired meshes is unsupported. Shadow resources stay engine-owned.

Diagnostics belong in [debugging](debugging.md), build configuration in [development](development.md)
and validated platforms in [backends](backends.md#backend-comparison).
