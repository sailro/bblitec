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
| Runtime features | Reached APIs and asset families select generated sources and PAL units. |
| Renderer capabilities | Settled material/mesh/asset shapes select layouts and resource guards. |
| Codecs | Packaged image types select decoders and dependencies. |
| Emit options | Final compiler/asset decisions select lowerer and loader branches. |
| Composition | Pinned feature words and extension registration select shader variants. |
| Refusals | Unsupported combinations stop generation. |

`upstream/feature-activation.json` records these decisions and their origins. Reachability alone
is not a renderer capability: shadow resources, receiver families and ESM have separate gates.
Audio, physics, navigation, retained UI and codecs must also select their native dependencies.
Build switches and minimal configurations belong in [development](development.md).

## Program compilation

| Surface | Supported shape |
| --- | --- |
| Entry/modules | Local or imported entry helpers, supported top-level statements, named local imports/re-exports and ordered reached initializers. |
| Control flow | Blocks, conditionals, supported switches and loops, applicable break/continue, throw, bounded catch and finally. |
| Functions/classes | Data-typed functions, supported recursion, defaults, handle-helper inlining, local fields/methods/accessors and demanded shared instances. Stored subclass dispatch refuses. |
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
and handle-dependent escapes remain bounded; see [ownership](architecture.md#runtime-and-memory).

AOT asset awaits differ from frame-yield continuations. Workers use owner-loop promises for reached
async functions. Worker codecs support typed plain data, cycles, repeated references and copied
buffers. Transfer lists admit OffscreenCanvas; ArrayBuffer transfer, MessagePort, shared memory,
classic workers and runtime-selected scripts refuse. Graphics realms need identical rendering products.

## Asset materialization

Reached local/remote URLs become packaged assets; glTF buffers/images are embedded as needed.
Base64 data URLs decode during generation. Dynamic URLs outside supported producers and
percent-encoded asset data bodies refuse.

### Compressed geometry

Pinned Draco/meshopt decoders and document hooks run during packaging, preserving hook order.
Sparse, quantized and compressed inputs become ordinary native accessors. Remaining unsupported
extensions refuse.

### Compressed textures

KTX1 loads natively with its blocks/mips. Basis and glTF KTX2 use the pinned browser transcoder
at generation. The compression target is fixed for the validated device family; native upload
checks device support. Sampler, encoding and invertY behavior remain producer-specific.

### Gaussian splat row updates

`splatsData` reads and `updateData(ArrayBuffer)` retain shared source rows. Numeric views can edit
those bytes; buffer replacement preserves old aliases. Updates require equal row counts and owned
or retained storage, publish a version to both PALs, and refresh same-turn picking. Borrowed native
buffers refuse. `splatsData` is getter-only; replace rows through `updateData`.

### Environment compilation

HDR uses pinned WebGPU GGX prefiltering at generation. DDS preserves stored specular mips and
uses pinned harmonic derivation. Native `.env` loading uploads decoded cube data; the IBL BRDF LUT is offline.

PBR local environments retain independent `.env` results. Static box/sphere projection and
blended probe sets execute the pinned validation, grid/UBO packing and texture-copy planning.
Configuration, debug selection and solid ORM replacement must precede scene registration;
live probe rebuilding and ORM rebinding refuse. Direct-intensity writes remain native.

### Drawn and computed assets

Bounded module producers bake atlases/pixels in Chromium. CSG uses the pinned implementation;
CSG2 uses pinned Manifold WASM and preserves material partitions. CSG2 currently requires unchanged,
identity-transform box/sphere solids; preceding material assignments work. Runtime CSG2 control refuses.

### Browser-produced textures

Bounded scene functions can own a canvas and call pinned pixel/texture factories. Generation retains
pixels/blob and texture options; unrecognized calls or engine reads refuse. Live Canvas2D UI is separate.

### Node particles

- Sets stepped or frozen before their first frame, without an emitter provider, are baked. Frozen
  buffer aliases expose capacity/count and full-capacity numeric reads. Later simulation/column writes,
  nonfinite values, negative zero and native buffer access with composed set membership refuse.
- Frozen Sprite2D sheets retain shared Uint16 cells and observe cell writes each frame. Sheet replacement,
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
its continuation completes; cleanup currently admits plain writes, not calls, accessors or explicit throws.

## Shader pipeline

Generation composes the reached closed shader set. Shader origins and semantic
constraints belong in [fidelity](fidelity.md#shader-contract); compiled target
formats and binding authority belong in [backends](backends.md#compiled-binding-contract).

## Engine, scene, and frame loop

Registration, rendering contexts, fixed/live time, supported callbacks, timers and frame gates share
one conductor. Scene, SpriteRenderer, EffectRenderer and scene-less FrameGraphContext drivers activate
independently. Immutable engine aliases retain identity; rebinding them or creating multiple engines
within one entry point refuses.

Reviewed host canvases can share one engine while retaining separate scene targets, clear colors,
camera projections and pointer capture. Canvas rectangles drive allocation and resize; default scene
graphs share the original mesh/material identities. Wider surface options and lifecycle combinations
remain outside the validated multi-canvas contract.

## Cameras and input

ArcRotate/Free cameras, framing, bounded orthographic projection, viewports and supported SDL controls
are live. Geospatial cameras render their compiled pose; their input arms refuse.
Canvas dimensions follow drawable extent. Off-center orthographic planes and wider combinations remain unsupported.

## Asset loading and upload

Generated glTF and `.babylon` loaders create supported meshes, materials, lights, cameras, skins and
animation. glTF supports packaged external/compressed resources and reached material extensions;
unsupported fields/branches refuse. Parented or geometry-less `.babylon` nodes remain incomplete.

Recognized closed glTF collectors retain actual stack/preorder traversal independently of native flat
mesh storage, including Map insertion order. Metadata is demanded per asset/collector pair. Rest/default/
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

Bare visibility writes are live for transparent/transmissive draws. Opaque cached lists require
`setMeshVisible` invalidation. Full imported-root cloning/rotation/scaling and arbitrary visitor effects remain incomplete.

## Lights

Directional, hemispheric, point and spot lights support reached setters and per-mesh selection.
Asset discoveries activate needed features. The primary PBR analytic slot supports only a restricted spot shape.

### Clustered lights

The optional PBR clustered container selects shaders at generation and updates light/bin/data textures natively.

## Materials and material state

Standard, PBR, Grid, shader materials, supported no-colour views and live properties are available.
Reached PBR layers include clearcoat, sheen, iridescence, anisotropy and transmission. Explicit lightmap,
Standard UV and vertex-colour opt-ins remain distinct from asset discovery; live UV offsets require
`enableStandardUvOffset`. Vertex-alpha meshes select the matching transparent variant.

Public PBR factor/Standard diffuse arrays retain identity and double precision; factors have four
channels and diffuse colors three. Standard whole-array replacement retains its supplied storage.
Use owning numeric arrays for factory inputs; static readonly tuples and legacy object-color adapters
cannot co-reach numeric-array reads. glTF preserves absent versus explicitly supplied factors.

Numeric color reads require one static scene registration. Later group construction, rebuilds and color
replacement after binding refuse. Write-only replacements work before first binding, including new callback-created
materials. Direct array changes affect source reads without implicitly bumping the pinned material UBO version.

Public albedo reads retain source texture identity across sharing, replacement and equal-byte distinct
factories. glTF requires packaged producer associations; missing identity fails. Core images/factors,
sampled wrappers and UV2 clones work; material extensions, texture transforms and BasisU refuse when
public albedo reads are reached.

Shader materials support bounded 2D/2D-array samplers, float/depth/comparison sampling, declared storage
buffers and supported uniform/system matrices. Live material choices need compatible known instancing
profiles. Wider descriptors, fixed-function options and system values refuse.

### Node materials

Closed NME graphs compose at generation, including supported alpha-combine transparency and block loaders.
Repeated construction shares composition but retains distinct material/input owners. Texture input handles
survive aliases/helpers/containers. Setup can fill textures after attachment and before registration;
binding captures the original private slot and fails if required data is missing. Unused materials may stay unset.

Numeric inputs, map/reflective mutation, later texture producers and post-registration topology/input
changes refuse, including `options.textures`-only materials. Public inputs require one registered scene.
Geometry tasks compose per-task MRT views with raw POSITION/NORMAL/UV, source indices and per-view world
matrices; LOCAL_POSITION reads raw positions. Morphs, environment/shadow lights and trailing colour attachments refuse.

Imported node geometry requires static tightly packed FLOAT positions/normals and FLOAT UVs when present.
Missing normals, strided used attributes, deformation/instancing and imported transform mutation/cloning
refuse. Tight accessor offsets and unused strided views are valid. Proven scene-authored transforms remain supported.
See [node controls](debugging.md#before-calling-a-scene-done) for the browser resize limitation.

### Material plugins

Explicit enablement installs supported custom-code and sampler/texture bridges. Standard textures retain
per-material identity. Wider uniform writers, runtime signatures and PBR sampler plugins remain incomplete.

## Animation playback

Property clips and glTF channels have separate deterministic seek runtimes. Reached glTF channels include
TRS, skinning, morph weights and animation-pointer material/visibility targets. Metallic-roughness texture
transforms retain load-time values because the pinned resolver ignores those animation targets.

Property groups bind mutable numeric data leaves to their owner at group creation; intermediate replacement
does not retarget them. Owner/property identity governs mixing. Missing, readonly, nonnumeric and whole-vector/array targets refuse.

Managers support fixedDeltaMs, retained onUpdate and autonomous RAF start/stop. The first variable tick is
zero; autonomous updates notify afterward, while manual updates/seeks do not. Engine-less Canvas2D uses
its private presentation host. Autonomous managers cannot co-reach older persistent application RAF lowering.

## Deformation and instancing

GPU skinning, storage morphs, VAT and dynamic thin-instance pools are supported. Loaded eight-influence
skins retain four influences as an adaptation. Direct Standard/PBR morphs require one definite pre-start
attachment per mesh; replacement, conditional attachment and thin-instance combinations refuse. Weight updates work.
Scene-authored skeletons retain arrays/live palettes; Standard needs `enableStandardSkeleton`.

Thin-instance pools support count/matrix/color/flush and add/remove operations. GPU-culling enablement
records an adaptation: native draws active instances without the compute/indirect path.

## Sprites

Supported paths include Sprite2D layers/renderers, offscreen/depth-hosted targets, billboards, atlases,
animation, custom fragments and Y-sort. Options select pinned blend/shader arms and producer-specific mips.
Handle-object APIs, mixed transparent ordering, coverage gamma and several picking combinations remain incomplete.

## Picking

Basic/detailed GPU picks support mesh/cloud identity and points, with per-mesh skeleton/morph/combined
projection and pending-pose synchronization before submission. Billboard contributors are bounded.
Filter/ignore/discard options, deformed thin instances, VAT IDs, viewport and wider contributor/result combinations refuse.

PickingInfo aliases share identity and reached hit/bu/bv writes through nullable helpers and containers.
Name/normal queries retain the original engine association and throw after engine destruction/move;
payload reads survive. Transported results cannot convert to bare Mesh handles; direct statically owned
pick casts remain supported. Picked points keep their tuple snapshot behavior.

## Flow graphs

glTF `KHR_interactivity` graphs are parsed at generation by the pinned parser and lowered per block:
each admitted block body is partially evaluated over the static graph into one update function per
data output and one execute function per signal input, in the pin's pull/push order. Admitted blocks:
onStart, onSelect, sequence, variable get/set, pointer get/set, add, sub, mul, div, rem, abs, floor,
lt, clamp, combine2 and extract2. Pointers bind by executing the pinned path converter over recording
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

## Physics

Bullet implements the Havok-shaped PAL for reached bodies, primitive/convex/static-mesh shapes, forces,
velocities, motion/prestep, aggregates, centre of mass, masks, collisions/triggers, raycasts and floating origin.
Constraints, characters, heightfields and proximity/cast queries remain incomplete. Inertia overrides,
dynamic concave meshes and non-Y-aligned capsule/cylinder segments refuse. See [physics fidelity](fidelity.md#physics-contract).

Raycasts return nullable body identity, point/normal and double distance. Trigger selection and both masks
filter the closest eligible body. Arguments evaluate in source order; retained point objects expose changes
made by later arguments. Dynamic option aliases without native field storage refuse.

## Audio

Feature-selected LabSound/SDL3 supports reached Web Audio lifecycle, gain, oscillators, buffers, filters,
panning and AudioParam scheduling. Clips are packaged for native decoding. Broader Babylon sound/bus/spatial APIs and master ramps remain unsupported.

## Shadows

Reached PCF spot/directional, ESM directional and CSM paths support receivers/casters, layers, blur and
morph bounds. `receiveShadows` needs a static supported value; false is not a general live variant toggle.
Wider thin-instance caster contracts and generator options remain incomplete.

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
Implicit defaults, geometry/copy tasks, other material families, backgrounds/shadows, splats/sprites,
clustered lights, transmission, retained UI and other unprepared drivers refuse with TAA.

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
Custom vertex stages, arbitrary texture sources, wider descriptors and lifecycle/update APIs remain incomplete.
Retained UI with scene-less effect or frame-graph drivers refuses.

### Image processing

Exposure/contrast are live outside the TAA refusal above. Tone mapping affects composition; transmission
uses the pinned linear-frame and trailing image-processing contract.

## Text

Static font loading/default layout run the pinned parser, shaper and packer at generation. Text data and
native renderables retain identity through aliases/helpers/containers. Transform setters and opacity are
live; pipeline membership, depth and order must settle before attachment. Dynamic layout, late attachment/
disposal, conditional transform copies, reflective/internal-buffer writes and high-precision matrices refuse.

Rendering activates `BBLITE_HAS_TEXT` and supports one text-only default scene with a static FreeCamera.
Mixed ordering, custom tasks and camera mutation/controls refuse. Both PALs use composed Slug shaders,
packed resources and pinned alpha-to-coverage or premultiplied blending; shared data retains its group-cache behavior.

## Runtime scene mutation

Supported removal, material-family append and instance updates refresh plans/resources. Unshared removed
geometry can be reclaimed; re-adding retired meshes is not generally supported. Some shadow resources remain engine-owned.

## Diagnostics and capture

[Debugging](debugging.md) owns capture, attribution, memory and artifact commands;
[development](development.md) owns build configuration.

## Platform validation

Validated platforms and backend limitations belong in [backends](backends.md#backend-comparison).
