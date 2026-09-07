# Features

This page owns the supported surface and where work runs. It is a bounded
TypeScript/Babylon Lite compiler: unsupported constructs usually refuse during
generation, while device- and loaded-resource-dependent checks can fail at
runtime. Some intentional substitutions are recorded in
[fidelity](fidelity.md). Current measurements belong in [status](status.md);
unfinished capabilities belong in [TODO](../TODO.md).

## Why anything is compile time

The native executable has no browser, runtime network loader or dynamic
TypeScript module system. Generation materializes remote assets, executes
browser-dependent producers and composes the closed shader set. Live scene
state, animation, input, resource uploads and draw submission remain native.

A family can span both phases. Baking browser-produced pixels does not require
baking a sprite frame grid; the grid can still derive from the decoded texture
at load time. Preserve the pinned boundary rather than moving every computation
to generation merely because it is possible.

## Feature and capability selection

Babylon Lite activates optional behavior through both lazy API registration
and asset-loader discovery. The port represents those different upstream
triggers, then merges their consequences before emission.

| Mechanism | Authority | Consumer |
| --- | --- | --- |
| Runtime features | Reached API calls, plus asset-discovered light/environment/splat families | `features.cmake`, generated source lists, PAL translation units |
| Renderer capabilities | Settled material/mesh/asset shape and explicit opt-ins | `render_capabilities.hpp`, resource/layout guards |
| Image codecs | Packaged image types | `BBLITE_IMAGE_CODECS`, CMake and shipping dependencies |
| Emit options | Final compiler/asset decisions | Dedicated lowerers and generated loader arms |
| Composition | Pinned feature words and lazy extension registration | PBR, Standard, node and custom variant tables |
| Refusals | Unsupported combinations | Generation diagnostics |

`src/feature-activation.ts` records all six mechanisms in
`upstream/feature-activation.json`, using the values the pipeline actually
selected. Each row identifies its reason, upstream origin and consumers. The
inventory is an audit aid; a provenance label alone does not establish semantic
equivalence.

For example, source clearcoat setters register an optional feature, while a
glTF clearcoat extension reaches the loader's material builder. Both can
require the same native material state. An explicit `isEnabled: false` does
not undo a module registration whose factory the source already reached.

`shadowCapabilities` derives the Standard, PBR and node receiver gates and
their shared generator resources. Use the union
`BBLITE_SHADOW_RECEIVERS` for common shadow resources and each family gate for
its binding path. `BBLITE_SHADOWS` records reachability; it does not imply every
receiver/resource path is needed. ESM resources have their own gate.

Optional audio, physics, navigation, retained UI and image decoding must be
selected at both generated-source and dependency boundaries. See
[development](development.md) for minimal-build commands and
[audit](../audit.md) for partitioning defects being resolved.

## Program compilation

| Surface | Supported shape |
| --- | --- |
| Entry | Local `main`, supported top-level entry statements, or an imported entry helper with an erased reporting-only rejection handler |
| Modules | Named local imports/re-exports and dependency-ordered reached module initializers |
| Control flow | Scoped blocks, `if`, supported `switch`, `for`/`while`/`for-of`, and applicable `break`/`continue` |
| Functions | Once-emitted data-typed functions, supported mutually recursive groups, defaults and inlined handle-dependent helpers |
| Closures | Supported stored callbacks, shared outer cells, timer/RAF and API-owned retained callbacks; function identity where represented |
| Classes | Local fields, constructor/parameter properties, methods/accessors and demanded shared instances; stored subclass dispatch remains unsupported |
| Data | Typed records, nullable values, arrays, insertion-ordered Map/Set, tuples, destructuring, spreads and bounded static records |
| Binary data | ArrayBuffer, DataView, reached typed-array constructors and indexing; fill/set/copyWithin/slice on supported owned storage |
| Numeric/string | Reached runtime Math, including JavaScript `Math.round`, deterministic random, string operations and coercions |
| JSON | Generated stringify codecs and dynamic parsed values with source-level shape checks; unsupported replacers/cyclic serialization refuse |
| Exceptions | `throw`, bounded catch handling and finally cleanup; catch bindings must satisfy the compiler's supported/erased binding rules |
| Browser state | Reference query folding, bounded browser erasure, immediate AOT asset promises and live canvas extents |
| Dedicated workers | Local module Worker/URL construction, per-instance module state, typed cloned messages, once listeners, errors, close/terminate, owner-loop timers and bounded promise continuations |
| Worker graphics | Transferred OffscreenCanvas, independent engine contexts, source-driven resize and display-paced rendering; Window host companion, ResizeObserver and resolution media queries |
| Storage/files | Per-user localStorage, bounded Blob/object URLs, one-file open and download; [UI](ui.md#file-transfer-controls) owns controls |
| UI | Supported retained DOM/CSS/Canvas2D operations; [UI](ui.md) owns their complete compatibility boundary |

Pinned readonly literal enum exports remain values in native arrays. Physics
motion and prestep arguments validate against the pin's parameter types before
converting to native enums.

Numeric typed arrays can view a retained ArrayBuffer with an optional numeric
byte offset and element count. Indexed reads, writes and updates share bytes
across element types; `buffer`, `byteOffset`, `byteLength` and array identity
retain their source meaning through assignment, callbacks and return values.
Offsets/counts use ToIndex after truncation, then alignment and bounds checks.
Explicit nonnumeric constructor arguments refuse. Numeric buffer views refuse
methods and native consumers requiring contiguous typed storage, including
iteration, copying constructors, fill, set, slice and copyWithin; numeric
subarray remains unsupported. Owned typed arrays retain their existing APIs.
Effectful indices over internal borrowed native vectors refuse until those
producers supply a retained source array; scalar indices keep their existing path.

Scene-facing `mat4Invert` reuses the pinned inverse and returns nullable fresh
Float32 storage. Singular matrices return null; Float64 inputs and high-precision
matrix allocation combinations refuse with source locations.

This is not a complete typed user-code IR. Handle-dependent helper inlining,
escape classification, generic bodies, resource loops and aliasing have
limitations. The [runtime ownership contract](architecture.md#runtime-and-memory)
defines which retained graphs are traced and which native owners remain roots.

No arbitrary JavaScript execution or dynamic modules run in the native
executable. AOT `await` and frame-yield continuations have different semantics;
the latter schedule work across the frame conductor rather than blocking a
browser promise loop. Worker builds instead select owner-loop promises and
coroutine activations for their reached async functions. Assets are still
materialized during compilation; this does not provide arbitrary runtime fetch.

Worker message codecs admit typed plain data, arrays, cycles, repeated
references and copied buffers. Source transfer lists currently admit
OffscreenCanvas; ArrayBuffer transfer, MessagePort, shared memory, classic
workers and runtime-selected scripts need further admission. Graphics realms
must use identical generated rendering products. The detailed execution and
ownership boundaries are in [architecture](architecture.md#worker-service-design).

## Asset materialization

Material albedo fallback reads distinguish PBR `baseColorTexture`/`baseColorFactor`
from Standard `diffuseTexture`/`diffuseColor`. Public color arrays retain source
identity and double precision through reads, aliases and Standard whole-array
replacement. PBR factors supplied as owning numeric arrays keep their contents
at runtime; composition observes only the pin's array-presence test. glTF keeps
the original public factor only where the pinned builder or animation-pointer
feature supplies it, including the distinction between explicit white and an
omitted factory option.

Albedo texture reads retain the original `StoredTexture` producer arm and
identity: materials sharing one source texture compare equal, distinct factories
remain distinct even with equal bytes, and replacing a slot preserves old aliases.
Solid producers use the common one-texel adapter. The glTF loader requires
packaged source-texture associations when these reads are reached; a present
texture without retained producer identity fails explicitly. The other existing
PBR texture-slot adapters are unchanged.

glTF albedo associations execute the pin's image cache, sampler activation,
material builder and texture wrappers during packaging, with inert image/GPU
transport. Native loads allocate fresh identities from those associations and
retain the actual fallback texels. Core image/factor producers, sampled wrappers
and UV2 clones are covered; material extensions, texture transforms and BasisU
producers currently refuse when public albedo texture reads are reached.

Numeric color reads currently require one static scene registration. Later
material-group construction, rebuilds and whole color replacement after
registration refuse because separate group UBO snapshots are not represented.
Write-only array assignments remain available before a material's first binding,
including new materials created in live callbacks; the native setter rejects a
previously registered or currently bound material before changing its arrays or
render fields. Tuple-returning color helpers retain the existing scalar render
adapter and cannot co-reach numeric-array property reads.
Direct array changes remain visible to source reads without implicitly changing
the pinned `_uboVersion`. Legacy `{r,g,b,a}`/`{r,g,b}` render adapters cannot
co-reach numeric-array reads. Static readonly tuples cannot be retained as
factory inputs; use an owning numeric array. Admitted factor/diffuse arrays have
four/three channels respectively; dynamic invalid lengths fail at runtime.

Reached file/remote URLs are packaged under the generated scene. glTF external
buffers/images are embedded as needed; local application assets retain reviewed
logical paths. Base64 data URLs decode at generation. Dynamic URLs outside a
supported producer and percent-encoded data bodies refuse.

### Compressed geometry

The packager executes the pinned Draco/meshopt decoders and document hooks.
Meshopt, sparse-accessor, quantization and splat hooks keep the pin's order so
later hooks consume earlier outputs. Native loading sees ordinary accessors
after those transformations. A packaged document still containing an
unsupported extension refuses rather than silently reading an unpatched base.

### Compressed textures

KTX1 is parsed at native load and uploads its own blocks/mips. Basis and glTF
KTX2 routes execute the pinned browser transcoder during generation, packaging
the resulting container. The selected compression target is fixed for the
validated device family. Native upload checks device support. Texture
`invertY`, encoding and sampler choices retain their own contracts.

### Gaussian splat row updates

Reading `splatsData` or calling `updateData(ArrayBuffer)` retains the cloud's
shared source rows. Numeric views can edit those bytes before an update;
replacing the buffer preserves aliases to the old rows. The update uses the
pinned geometry builder, rejects incompatible counts before committing, and
publishes a version consumed by both PALs and cloud picking. The receiver must
be a present splat handle, and the buffer must own or retain its storage.
Borrowed native-vector buffers refuse before publishing any cloud state.
Unused row APIs carry no retained source buffer.
`splatsData` is a getter-only property; assigning to it is refused. Replace its
buffer through `updateData`.

### Environment compilation

HDR runs the pinned WebGPU GGX prefilter during generation. DDS preserves its
stored specular mips and derives harmonics through the pinned source. Native
`.env` loading parses its container and uploads decoded cube data. The
image-based-lighting BRDF LUT is generated offline.

### Drawn and computed assets

Bounded module producers can run in Chromium to bake drawn atlases or computed
pixel buffers. CSG plans execute the pinned CSG implementation under Node.
Cache identity covers producer inputs and the relevant implementation. Browser
rasterization and numerically fragile executed output are recorded adaptations.

CSG2 executes the pinned Manifold WASM in Chromium and retains the pin's
per-material partition names and slots. Initialization and solid disposal run
at generation. Source solids currently require unchanged identity-transform
box/sphere factories; preceding material assignments are supported. Runtime
control of generation-only CSG2 operations refuses.

### Browser-produced textures

A bounded scene function can own a canvas and call the pinned pixel/texture
factories. The executor records the resulting RGBA or blob and texture options;
unrecognized pinned calls or engine reads refuse. Selection is structural, but
some specialized source gates remain tracked in TODO. Runtime Canvas2D UI is a
separate retained surface.

### Node particles

A set without an emitter provider that the scene steps or freezes before its
first frame is baked: generation runs the pinned parser, normalizer, builder
and simulation in Chromium and
bakes the particle state they produced. Billboard and Sprite2D bridges derive
their layout, blend and synchronization rules from pinned declarations. A
registered frozen set is accepted only when the observed extra step leaves
consumed columns unchanged.

Frozen buffer and column aliases expose capacity, live count and full-capacity
numeric reads, including double-precision ages. Initialization writes run in
the ordered bake; later writes and simulation changes refuse once native code
has observed the snapshot. A manually assigned sprite sheet retains shared
`Uint16Array` cells: the Sprite2D renderer still synchronizes every frame and
observes writes through aliases. Cell dimensions are captured when its atlas
is built. Sheet-object replacement, effectful sheet callbacks and broader
binding lifecycle/view options remain unsupported.
Frozen snapshots require finite column values and currently refuse negative
zero. Native buffer/sheet access combined with composed set membership also
refuses until system aliases have a canonical identity across sets.

A set a pure-2D binding takes without any scene step is live: the graph's
block evaluators are partially evaluated at generation over the parsed graph,
and the per-particle closures they install are translated to C++ from their
own bodies, together with the pinned simulation loop, creation-slot order,
lock caching and death clamp. The executed pin still builds the set in the
bake driver, and what it reports about that build (installed slots, step
count, settings, traversal order) is checked against the evaluation. Random
draws are the pinned generator's on both sides. Covered evaluators: System
(static emit rate), CreateParticle, world Box shape, UpdatePosition,
UpdateColor, TextureSource, Input (constants, Position, Age, Lifetime, Color,
ScaledDirection, ScaledColorStep), Random (None, PerParticle, PerSystem),
compact Math, Lerp and Converter. Local Point shape and LocalPositionUpdated
also preserve the pin's local position/id/valid columns and their swap-removal.
Other variant evaluators (once-per-particle random, aliased math, connected
emit rate, other local shapes and sprite sheets) remain outside this slice,
and the two-pass MultiplyAdd blend refuses on a live layer.

`withNodeParticleEmitterProvider` selects native simulation, including authored
pre-frame steps. Its callback retains shared Float32Array storage, is sampled
when wrapped, and supplies a validated matrix once per started animation call.
Zero update speed and stopped emission still sample; an unstarted system does
not. The pinned setup/frame bodies update the world matrix and translation.
`registerNodeParticleSet` creates a billboard, honors `autoStart`, and installs
the pinned animate-then-sync callback. Source start/stop/animate, scalar writes
and live count/capacity reads use that same state. Native Math.random overrides
retain their closure state and saved-function identity; a finally spanning
startEngine runs when its continuation completes. That cleanup currently admits
plain writes; calls, accessors and explicit throws require the exception
completion work tracked in [TODO](../TODO.md).

Provider-backed sets require definite initialization before recurring callbacks.
Standalone provider options, mixed native/frozen sets, composed system lists,
explicit billboard or pure-2D provider bridges, inverse-matrix registration and
unsupported hooks refuse. Texture changes and blend enabling after registration
also refuse. Exact native fixtures cover 180 frames, deaths, random draw counts,
provider sampling and callback ownership; scene302's unchanged seek and live
modes additionally have both-backend image and input replay measurements.

Three pinned bodies are restated and asserted rather than translated: the
variant-selection predicate (the build-time evaluator has no
`Array.prototype.find` or `String.prototype.endsWith`), the swap-remove over
the buffer's column list (three element widths in one list) and the Sprite2D
bridge sync (template-literal throws and `Number.isFinite`). The bake ships
the parsed graph once per bridge, a live set's atlas row rides the frozen
system table, and an origin write finds its mapping by request and bridge at
run time; no reached scene measures a change to any of these.

## Shader pipeline

### Stage 1: composition and specialization

PBR and Standard stages come from the pinned composer and extension registry;
node materials execute the pinned graph compiler. Post-process and effect
factories provide their shader text/layouts. Packaged literals are lifted,
and supported builders are AST-folded. Custom source uses typed shader IR where
supported and a strict reflected path elsewhere.

The specialized diagnostic/depth/background vertex stage projects the pinned
PBR template and shared deformation/instance fragments through typed shader IR
onto its PAL transport. Skybox declaration, binding and fog specialization also
uses typed IR. [Fidelity](fidelity.md#shader-contract) records the retained
transport adaptations.

### Stage 2: compiling WGSL for the device

| Backend/target | Compilation |
| --- | --- |
| SDL_GPU D3D12 | Pinned Tint to normalized HLSL, then DXC to DXIL |
| SDL_GPU Vulkan | Normalized Tint HLSL through DXC to SPIR-V |
| SDL_GPU Metal | Pinned Tint to MSL |
| Dawn | Deployed WGSL compiled by Dawn at runtime |

SDL_GPU binds from the compiled `.slots` sidecar; Dawn uses the deployed
module's binding numbers. See [backends](backends.md) for layouts and
[development](development.md) for cache/toolchain commands.

## Engine, scene, and frame loop

Immutable engine aliases and engines returned by inlined helpers retain the
original engine identity. Rebinding such aliases and creating multiple engines
within one entry point remain unsupported.

Engine/scene registration, ordered rendering contexts, fixed or live frame
time, supported before-render/update callbacks, timers and frame gates run
through the shared conductor. Scene, SpriteRenderer, EffectRenderer and
scene-less FrameGraphContext drivers compile independently when reached.

## Cameras and input

ArcRotate/Free cameras, default framing, bounded orthographic projection,
viewports and supported SDL controls are live. The geospatial (globe-orbit)
camera compiles its orientation state, limits and per-change recompute, and
attaches its control surface. None of that surface's input arms is wired to
the platform, so a geospatial camera renders its pose and does not move.
Canvas dimensions follow the drawable extent. Off-center orthographic planes
and wider camera combinations remain unfinished; general browser input APIs
are not implied.

## Asset loading and upload

Generated glTF and `.babylon` loaders construct supported meshes, materials,
lights, cameras, skins and animation. glTF supports reached external resources,
sparse/quantized/compressed inputs after packaging, texture transforms and
material extensions. Unsupported extension fields and loader branches refuse.
The `.babylon` parented/geometry-less-node surface remains incomplete.

Recognized closed glTF mesh collectors retain their source traversal order.
Packaging runs the pinned hierarchy builder and the admitted stack or recursive
collector, then stores a separate permutation of the native mesh table. This
preserves `Map` insertion order and repeated material construction; native flat
mesh consumers keep their existing table. Only reached asset/collector pairs
carry this metadata. Partial or repeated hierarchies, instanced/splat producers
and early `break` remain refused by this bounded collector path.

## Geometry and meshes

Reached primitives, mesh data, ribbons/extrusion/polyhedra, line systems, CSG,
thin instances and transform mutations are supported within their intrinsic
option sets. Runtime geometry/source arrays follow the data model; builder
presence does not imply every option or update form.

`createBoxData` accepts a numeric size or a literal options object with size,
width, height and depth. It and `createSphereData` return mutable typed arrays;
aliases of a returned stream share its storage, and separate calls own separate
buffers. Box dimensions remain doubles until the pinned Float32 position store.

Proved fixed-composition counted/for-of loops over supported primitive and
Standard-material construction emit native loops while retaining creation-order
composition records. Runtime-safe mesh, Standard and ShaderMaterial construction
with unknown counts uses explicit call-site profiles rather than pretending one
profile means one allocation. Existing material pools can be selected natively
with conservative variants. Ordinal-dependent PBR/glTF creation after an unknown
material-allocation count, and unbounded specialization changes, refuse.
Across one compilation, static loop expansion
is limited to 4,096 iterations and 1 MiB of captured emission, including failed
probes. Parameterized resource loops additionally cap each mesh/material
composition table at 65,536 records.
Immutable baked numeric streams use deduplicated namespace tables rather than
expanding literal data inside loop bodies; each native array construction still
owns its mutable storage.

## Scene hierarchy

Scene-created transform nodes, parenting, local/world transforms, visibility,
supported imported-hierarchy walks and bounded cloning are represented.
Retained `position`, `rotation` and `scaling` aliases preserve their owner's
handle across arena growth and source-variable reassignment; vector setters
reuse the normal transform mutation path.
Bare visibility writes are read each frame for transparent and transmissive
draws, including meshes hidden when lists were built. Opaque cached lists retain
their deferred bare-write behavior; `setMeshVisible` invalidates those lists.
A mesh parents to either a mesh or a transform node, through the two lanes a
mesh record keeps for the pin's single `parent` field; a transform node parents
only to another transform node, because its record holds no mesh lane. A bare
`parent` write registers the child for invalidation, and `children.push` fills
the traversal list separately, as upstream keeps them apart.
Imported roots and runtime TransformNode values still have distinct paths;
full imported-root cloning/rotation/scaling and arbitrary hierarchy visitor
effects remain unfinished.

## Lights

Directional, hemispheric, point and spot lights, supported live setters and
per-mesh light selection feed generated writers. Asset light discoveries join
the runtime feature list. The primary PBR analytic slot has a restricted spot
shape; wider combinations must not silently invent a fallback.

### Clustered lights

The optional PBR clustered container selects its fragments at generation.
Native code updates the reached light field, binning and data textures per
frame. Reuse the pinned registration and writer rules for further variants.

## Materials and material state

Standard, PBR and Grid materials, shader materials, supported no-colour views,
alpha/culling state and live property writes are available. PBR layers include
clearcoat, sheen, iridescence, anisotropy and transmission where reached by
supported source APIs or asset extensions. glTF anisotropy and diffuse
transmission execute the pinned loader handlers during packaging, preserving
their option objects and independent texture transforms in native records.
Explicit PBR lightmap/Standard UV/vertex-colour opt-ins remain distinct from
asset-driven shape.
`enableStandardUvOffset` enables live UV-offset assignments, and vertex-alpha
meshes select the transparent draw bucket and matching Standard variant.

Shader materials support bounded typed 2D/2D-array samplers, float/depth sample
types and comparison mode, plus declared storage buffers and their reached
create/update/dispose/bind operations. Custom uniform declarations and the
supported system-matrix list drive generated writers; wider fixed-function
options and system values still refuse.
Live scene-local ShaderMaterial choices retain every candidate's instancing
requirements. Multiple candidates require a known mesh composition profile;
incompatible instance layouts for one program still refuse.

### Node materials

Pinned NME graphs compose at generation with bounded graph inputs, textures
and block-loader forms. Supported alpha-combine graphs draw transparently.
The pinned geometry-aware loader may delegate through its resolved import;
local closed-switch loaders remain supported. Repeated runtime construction
of a closed graph shares shader composition while retaining distinct material
owners, input maps and texture2d slots. Input handles survive aliases, helpers,
containers and owner teardown. Setup may fill their texture after construction
and mesh attachment, before scene registration. The deferred builder captures
the original private slot and reports a missing texture at binding time; an
unused material may remain unset. Numeric input state, map replacement,
reflective mutation, later texture producer writes, and topology or input
changes after registration remain refused. These binding limits also apply to
materials initialized only through `options.textures`, without reading public
inputs. Public input access additionally admits one registered scene until
independent scene binding snapshots are represented.

Uniform input state is otherwise frozen. A graph reached by a geometry-renderer
task also composes the pin's geometry view — a third module per (graph, task),
emitted from the graph's own `GeometryTextureOutputBlock` terminal with its own
vertex inputs, texture pairs and uniform block — and both backends draw it into
the task's attachments. Geometry views retain original POSITION, NORMAL and UV
lanes, source indices and the per-view world matrix. LOCAL_POSITION outputs read
those original positions. Morph targets, environment or shadow lights and a
trailing colour attachment remain refused by name. Wider input mutation remains
unfinished.

Imported node geometry currently requires static, tightly packed FLOAT
POSITION/NORMAL streams and FLOAT UVs when present. Missing normals, reached
strided attribute views, imported deformation/instancing and source transform
mutation or cloning are refused. Ordinary accessor byte offsets remain valid;
unused strided views do not affect admission. Proven scene-authored mesh
transforms keep their existing behavior alongside imported geometry.

Scene149 exercises 79 distinct node material owners and 285 meshes in a color
view and two geometry views with seven and four attachments. Its canonical
full-image and foreground gates are 0.02 on each backend. Camera orbit is
compared with actual browser pointer input. Native resize is compared with a
fresh browser startup at the new size: the pinned browser's live resize fails
with error 84 when its resolve target retains the old dimensions.

### Material plugins

Explicit plugin enablement installs the pin's bridges. The compiler folds
supported custom-code and sampler/texture declarations. Standard plugin
textures are retained per material; wider uniform writers, runtime signature
changes and PBR sampler plugins remain incomplete.

## Animation playback

Property clips and glTF channels use separate runtimes with deterministic
seeking. Supported glTF slices include TRS, skinning, morph weights and reached
animation-pointer material/visibility targets, including texture transforms
on the reached extension slots. The pinned resolver deliberately ignores
metallic-roughness texture transforms; those retain their load-time values.
Track interpolation and target
support are independent; a property-animation option does not establish glTF
support for the same spelling.

Property groups can bind mutable numeric leaves on plain data objects. Each
path resolves its owner once at group creation, retains that object and shares
the caller's storage; replacing an intermediate object does not retarget an
existing group. Resolved owner/property identity also drives weighted mixing.
Whole data-vector/array writes and missing, readonly or nonnumeric leaves
remain unsupported.

Animation managers support `fixedDeltaMs`, retained `onUpdate` callbacks and
autonomous start/stop on the engine RAF conductor. Clock expressions and state
writes derive from the pin; the first variable-step tick receives zero, and
`onUpdate` runs after each autonomous update. Manual updates and seeks do not
notify. Engine-less Canvas2D entries use the private presentation host described
in [UI](ui.md#canvas2d). Autonomous managers cannot coexist with the older
persistent application RAF lowering; those loops need source requeue retention
before their callback ordering can compose.

## Deformation and instancing

GPU skinning, morph/storage morph, baked vertex animation and dynamic
thin-instance pools are supported. The glTF skin path retains four influences
when an asset supplies eight, recorded as an adaptation. Direct morph factories
have a narrower target/shared-weight surface than loaded glTF morphs.
Definite scene-code morph attachments compose Standard and PBR storage
variants and keep local vertices beside the live mesh world. Each scene mesh
accepts one direct morph attachment; replacing it, including through an alias,
refuses because detached morph resources do not retain independent storage.
Conditional or post-start attachments and direct morphs combined with thin
instances refuse. Updating the attached resource's weights remains supported.
Scene-authored skeletons retain their joint/weight arrays and live bone palettes.
Standard materials require `enableStandardSkeleton`; both backends upload the
palette for the pinned skinned vertex stage.

The reached thin-instance pool includes set/count/matrix/colour/flush,
add/remove and count reads. GPU-culling enablement records omission of its
compute/indirect path; the native fallback draws active instances.

## Sprites

Sprite2D layers, standalone renderers, offscreen targets, depth-hosted layers,
billboards, atlas-frame factories, sprite animation, custom fragments and
renderer Y-sort have supported paths. Per-layer/system options select pinned
shader and blend arms. A layer's atlas carries the pinned loader's own mip
decision on both backends: none for `loadSpriteAtlas`, the full chain with the
trilinear sampler for a texture a node-particle graph loaded through
`loadTexture2D`. Handle-object APIs, mixed-family transparent ordering,
coverage gamma and several picking combinations remain incomplete.

## Picking

GPU picking supports the basic and detailed pipelines, mesh/cloud identities
and sampled picked points. Regular meshes select the pin's four-influence
skeleton, morph-only or combined projection per mesh in both modes. The
projection synchronizes pending pose writes before submitting the pick and
reads the visible draw's bone texture and morph storage. Scene-authored poses
keep their live mesh world transform. Billboard picking
has a bounded contributor path. Filter/ignore/discard options, deformed thin
instances, VAT ids and remaining result properties are incomplete. Deformed
thin-instance picks, viewport and unsupported multi-contributor cases refuse
at their boundary.

`PickingInfo` retains one result identity through nullable helper returns,
records, arrays and Map/Set keys. The reached `hit`, `bu` and `bv` scalar
fields share writes between aliases; point reads and picked-node/normal
queries keep the existing property surface. Queries use the result's original
engine, including after helper/container transport. Destroying or moving that
engine makes subsequent mesh-name and normal queries throw; result payload
reads remain available. This checked lifetime boundary does not retain native
engines or meshes beyond their owner. Converting a transported result to a
bare `Mesh` handle refuses because that handle cannot carry the checked owner;
existing direct picks with a statically known entry engine retain their casts.
Picked-point reads keep the existing tuple snapshot behavior.

## Display gizmos

Display, editing and bounding-box gizmos share a generated utility-layer path.
Supported pointer registrations enable position-edit behavior; display-only
gizmos do not imply interaction. Retargeting and shape-specific options retain
explicit limits. Geometry, follow scaling and bounds arithmetic are lowered
from pinned source. Native resource creation, lifecycle and scene traversal
remain checked structural adapters. A gizmo handle may be held by a nullable
local or class field and created on first use, so an editor scene can keep a
widget out of its own static frame; the name carries the widget's engine from
the assignment, so reading it before one refuses.

## Physics

The generated Babylon physics layer runs over Bullet through the Havok-shaped
PAL seam. Reached bodies, primitive/convex/static-mesh shapes, forces/impulses,
velocity/motion/prestep controls, aggregate options, shape materials, an
authored centre of mass, masks, collisions, triggers, raycasts and
floating-origin regions have supported paths.
Constraints, character controllers, heightfields, shape proximity/cast queries
and wider lifecycle controls remain incomplete. Inertia and inertia-orientation
mass-property overrides refuse: Havok's inertia term is per unit mass while the
PAL's is the absolute tensor, and an omitted mass would leave Havok's
volume-times-density value on the body. Dynamic concave meshes and
non-Y-aligned capsule/cylinder segments refuse. Solver substitution is not
pixel or trajectory equivalence; [fidelity](fidelity.md#physics-contract)
defines the distinction.

Raycasts expose nullable body identity, hit point/normal and the pin's double
distance from the original origin. Returned bodies retain Map key identity.
The default and explicit false `shouldHitTriggers` queries exclude triggers;
true and runtime boolean values select the closest eligible body after both
collision masks, using the current trigger flag.
Ray arguments and option properties evaluate in source order. Scalar values
are captured at evaluation; retained point objects keep their identity and
expose coordinate changes made while evaluating later arguments.
Captured option aliases use stored scalar fields or generation-known values;
dynamic aliases without native field storage refuse explicitly.
Scene 103 covers automatic instance lookup and default-query pointer picking;
focused segment-end probes preserve the pin's exact and float-rounded misses.

## Audio

The reached Web Audio graph runs through LabSound and an SDL3 device; encoded
clips are packaged before runtime decode. Engine lifecycle, gain, oscillators,
buffers, filters, panning and reached AudioParam scheduling have supported
paths. Babylon's broader sound/bus/spatial APIs and master-volume ramps remain
outside the measured slice. Audio is feature-selected, including dependencies.

## Shadows

PCF spot/directional, ESM directional and CSM generators support reached
receiver/caster families, array layers, blur and morph-bound refresh.
Imported/runtime mesh collections can select supported receiver states, but
the source `receiveShadows` assignment still requires a static supported value.
A false assignment does not provide a general live variant toggle.
CSM fitting and packing derive from the pinned ASTs; wider thin-instance caster
contracts and generator options beyond the accepted sets remain unfinished.

## Navigation

Recast/Detour supports reached solo and obstacle tile-cache builds, debug
geometry, raycast/closest-point queries, crowds, agents and obstacle updates.
The tiled-without-obstacles build and unimplemented queries/disposal refuse.
This PAL is independent of either GPU backend.

## Frame graph

Scene-owned and scene-less graphs support reached render targets, ordered
tasks, material overrides, depth passes, geometry MRTs, blits and MSAA resolve.
A compiler-created default scene task retains skybox/mesh/ground ordering;
application-created tasks obey their explicit lists. Target, depth and viewport
contracts are shared across backends.

### Post-process passes

Reached leaf effects and composites execute pinned factories at generation.
Their writers, target relationships and parameters drive live native passes.
Source-relative intermediate sizes follow resize.

Composite output identity is observed from the pinned facade independently
of pass order. The compiler can transport a proven source render-task handle
through a composite descriptor, and uniform writers can read private live
task state.

TAA supports one scene with explicit Standard colour render tasks and reached
post-process leaves. Source render targets require the engine colour format
and a `depth24plus-stencil8` attachment; post-process inputs must be proven
single-sample textures. Multiple source tasks retain distinct state and can
select camera overrides. Implicit default scene stages, geometry/copy tasks,
PBR/grid/node/custom/no-colour materials, shadows, backgrounds, splats,
billboards, sprite/effect/screen-space drivers, clustered lights, transmission
and retained UI refuse when co-reached with TAA.

Task construction and attachment must precede initial scene registration.
Later graph recording/topology changes and authored rebuilds refuse. Arc-camera
scalar/component writes, retained direct target aliases, bulk target writes,
limit hooks, inertia and admitted camera animation lanes are supported.
Untracked camera producers, parent or target replacement, target copies into
plain data aggregates, computed target stores, unlowered mutation operators
and erased `Object.assign` calls refuse. TAA accepts one startup control
attachment; duplicate or recurring attachments need per-attachment callback
ownership. Fog requires fresh inline configs with inline colour arrays;
`setEnvironmentRotation` refuses until its explicit cache invalidation is
represented. Authored image-processing exposure/contrast writes refuse until
their JS double cache keys survive native scalar storage. The state and ordering
contracts are in
[fidelity](fidelity.md#frame-graph-and-post-process-passes), with GPU transport
in [backends](backends.md#temporal-post-process-transport).

### Screen-space effects

Screen-space contact shadows and one-bounce global illumination run the pin's
producer and temporal-resolve pipelines over a single-sample colour/depth
target, reading its depth attachment through a depth-only view. Generation
runs each factory to obtain its modules, layouts and pass order and lowers the
temporal state machine and uniform packing from the pinned bodies; the live
settings, the enabled toggle and a light's own direction are sampled every
frame. The history copy and composite are ordinary post-process passes.

### Fullscreen effects

EffectWrapper/EffectRenderer, UniformEffectWrapper and their frame-graph tasks
have supported layout/uniform/texture slices. Custom vertex stages, wider
binding descriptors, arbitrary texture sources, per-frame renderer updates and
disposal APIs are not generally supported. Retained UI under scene-less effect
or frame-graph drivers currently refuses.

### Image processing

Exposure and contrast are live uniform state. The selected tone-mapping record
participates in material composition. Transmission uses the pinned linear-frame
and trailing image-processing contract.

## Text

Static `loadFont` and `createDefaultTextData` execute the pinned font parser,
shaper and packing modules at generation. Their manifest retains exact byte
streams, padded atlas extents, used ranges, capacities, versions and provenance.
Dynamic layout/update calls still refuse at source. `createTextRenderable`
creates a retained native entity; text data and renderables preserve identity
through aliases, containers, helpers and captured callbacks. Transform component
and bulk writes call the pinned setters, including Euler/quaternion cache rules;
opacity remains live. Pipeline membership, depth behavior and order must settle
before text attachment. Late attachment/disposal, copied conditional transform
objects, reflective writes and internal buffer mutation refuse explicitly.

Compiler projection supplies the pinned GPU lifecycle and pipeline descriptors,
including per-stage constants, reflected resources and vertex layouts. Initial
renderer admission is one text-only default scene with a static FreeCamera;
mixed draw ordering, custom tasks, camera writers/controls and high precision
text matrices remain refused. Text registration requires `BBLITE_HAS_TEXT`.
Both PALs draw the composed Slug shaders with packed instance/storage data and
the pin's alpha-to-coverage or premultiplied blend state. Scene275 is registered;
shared-data and ordinary-blend fixtures cover the other admitted binding paths.
See [fidelity](fidelity.md#text-contract).

## Runtime scene mutation

Supported removal, material-family append and dynamic instance updates trigger
plan/resource updates. Removed unshared geometry can be reclaimed; re-adding
that retired mesh is not generally supported. Some retired shadow topology
remains engine-owned and needs explicit reclamation work.

## Diagnostics and capture

[Debugging](debugging.md) owns scene analysis, capture/diff, attribution,
memory and artifact commands. [Development](development.md) owns compile-time
and runtime switches.

## Platform validation

D3D12 on Windows is the validated local target. SDL_GPU Vulkan has a known PBR
shading divergence; Linux and Metal validation remain open. Dawn's native
surface integration is currently Windows-specific. Generated portability
artifacts do not establish a tested platform.
