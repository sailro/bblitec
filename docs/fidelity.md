# Fidelity

The reference is the unchanged scene running on the pinned Babylon Lite package.
This page owns intentional adaptations and source/native semantic boundaries.
[Features](features.md) owns admission; [backends](backends.md) owns GPU transport.

## Semantic contract

| Artifact | Evidence |
| --- | --- |
| `manifest.json` | Reached graph, features and assets |
| `fidelity.json` | Intentional adaptations and their risks |
| `upstream/provenance.json` | Pinned modules/symbols |
| `upstream/feature-activation.json` | Reach reasons and consumers |
| `upstream/renderer-fidelity.json` | Renderer invariants/formats |
| `upstream/shaders/composition.json` | Composed modules |
| Shader reflection, `*.native.wgsl`, `*.slots` | Actual interfaces/bindings |
| `upstream/shaders/shader-compiler.json` | Offline compiler/target identity |

Executing pinned code unchanged is not automatically an adaptation. Assertions
around a restated body do not establish complete semantic equivalence. Do not
label an unexplained residual a precision floor or intentional divergence.

| Boundary | Native adaptation |
| --- | --- |
| AOT assets | Materialization and ordinary asset awaits occur at generation; reference queries fold |
| Executed producers | Chromium creates selected pixels/buffers/bakes; results depend on its execution environment |
| Workers/Window | AOT factories, typed cloning and native realm loops; snapshotted layout and 16 ms ResizeObserver polling |
| Plain data | Typed native storage, checked access and bounded sparse/JSON behavior |
| Storage/files | Host preference storage, native URL tokens and synchronized picker completion |
| Device recovery | Native device/resource reconstruction retains scene owners; GPU identities name actual backend resources and device generations. SDL_GPU handles forced loss; Dawn also handles its device-lost notification. Driver failures remain fatal when recovery cannot run. |
| UI | RmlUi/FreeType and retained Canvas2D replace browser layout/rasterization; see [UI](ui.md) |
| Skinning | Loaded eight-influence skins retain four influences |
| GPU culling | Reached thin instances can use the pin's all-active fallback |
| Splats | Sorting is synchronous on the render thread |
| Physics/audio | Bullet replaces Havok; LabSound replaces browser audio |

Primary-canvas datasets with source readback remain live; write-only instrumentation erases.
The harness-ready gate shares this storage. Recovery global disposal hooks remain live. Closed Promise/RAF predicates
resume through engine frame boundaries. `drawCallCount` measures native GPU draw commands, including
transport passes; browser context accounting can differ.

Uncaught source exceptions in ordinary engine callbacks propagate through the PAL to the generated
entry handler, which reports the error and exits with status 1. A local source catch still handles
its own exception. Realm tasks use their installed error handler; without one, they rethrow.
This differs from a browser reporting a callback exception and continuing its event loop.

## Shader contract

PBR/Standard use pinned composers; node materials use the pinned graph compiler;
plugins use the pin's splicer/bridges. Sprites, effects and post-processes use
pinned builders/literals with declared specialization. Composition failures
must not select a fallback shader.

The specialized shared vertex path uses a baked world and fixed PAL bindings.
Its deformation path uses four influences with a 64-matrix palette and supported
attribute/storage morph transport. `shared-material-vertex-transport` records
these differences from ordinary color material composition.

Lifted utility shaders also adapt stage inputs: the texture skybox computes its affine fog
distance in the fragment from interpolated world position, which can change floating-point rounding.
The HDR background reconstructs `positionUVW` as world position minus the background centre;
this represents the admitted translated cube. SDL's single-sample image-processing wrapper samples
at texel centres instead of the pin's integer load. The single-sample transmission grab replaces
the multisample average with a mip-zero load while retaining the pinned manual bilinear filter.

### Numeric width

Preserve JavaScript double precision until the source's Float32 allocation or
store. Matrix layout, multiplication order, coordinate transforms and rounding
are part of the contract. Numeric equality and byte equality differ for signed
zero; record which comparison a control establishes.

Packaged glTF light worlds retain the source Float32 matrices. Light scalars and colors enter
native float records; ranges above float maximum clamp to that maximum. Spot cone angles retain
double precision, and their uniform cosine comes from the source writer's Float32 store.
Imported glTF cameras retain double scalar/vector fields and source Float32 parent/fixup matrices.

### The reference pose

Match source/module hashes, query, seek/frame, canvas size and UI. Native
deterministic clocks are capture controls. They do not justify changing authored
time steps or updating a golden to conceal drift.

### Depth

Main color uses the selected native depth convention; shadow passes retain their
own convention. SDL may choose depth-only formats where the browser uses
depth24plus-stencil8. Stencil use, compare/write, winding and readback
reconstruction require separate contracts.

### Shadows

Preserve pinned caster bounds, filtering, pass state and sampled-depth meaning.
Shader agreement alone does not establish CSM bounds, instance coverage or
correct binding of mixed ordinary/comparison samplers.

### Background and environment

Background geometry, cube orientation, mip policy, encoding and samplers follow
the reached pinned path. Image processing and scene-color capture are separate
passes; keep their source order.

Local cubemap probe sets execute the pin's setters, probe-grid producer, uniform writer and copy
planner at generation; the composed fragment stays unchanged. SDL's large-uniform storage substitution
is recorded in `static-local-cubemap-packets`.

### glTF material inputs

Derive extension predicates and texture/factor choices from the loader, not
format assumptions. Pinned extension handlers own UV selection, transforms and
merging. Native animation targets retain independent texture slots; the pin
does not resolve metallic-roughness texture-transform pointers.

Public color/texture presence and identity differ from render fallbacks.

### Deformation and instancing

Vertex layout, mesh world, palette and instance-parent matrices must agree.
Loaded glTF coordinate mirroring is not a universal Standard-mesh convention.
Native Euler/quaternion lanes differ from the pin's single rotation proxy;
mixed writes and wider sharing need explicit admission.

Imported node geometry world receipts can be numerically identical with signed-zero
differences; no general bit-identity claim follows.

### Textures and compressed textures

Keep pinned mips, encoding, samplers and upload orientation. `invertY` may select
a UV transform rather than a row flip; color and depth views are distinct resources.

### Gaussian splats

Draw, sort and picking share the rendered cloud. Updates retain source buffer
identity and preserve aliases to replaced storage. Refresh data textures before
the next draw or immediate pick; frame sorting follows the pin's transform gate.
Borrowed buffers without an owning lifetime refuse.

### Animation and hierarchy

Property/glTF tracks have separate target/interpolation contracts. Preserve
mutation and render-list invalidation boundaries. Autonomous managers issue ordered
cancellable native frame requests.

### Frame graph and post-process passes

A task owns its output formats, sample count, camera/aspect block and load/store
operations. Partial swapchain copies preserve earlier content. Composite output
identity can differ from its last pass, especially when history is written
after presentation.

TAA preserves pinned cache keys, clean scratch, successful uploaded bytes,
private factor, hook ordering and partial failure state. Missing cameras leave
cache/storage unchanged. Late uniform writes affect earlier encoded draws in
the same submission. See [transport](backends.md#temporal-post-process-transport).

Fog/environment keys represent object replacement, not equal values. Camera
versions follow source setters, including repeated writes and target aliases.
A task camera override controls packing; TAA's change test uses its source
scene camera.

Screen-space history resets follow source allocation, identity, version, enable
and inverse-matrix predicates. Native recreation of unchanged-size textures can
invalidate history that a browser retained.

## Picking contract

Use pinned projection modules and originating resource identity. Readback
continuations run after producing draws. Visible and picking draws must agree on
geometry/world/palette space. Detailed picking requires primitive-index support;
native throws when unavailable where the browser probe can leave the feature absent.

## Flow-graph contract

Generated graphs evaluate the pin's block bodies over the same static graph, so arithmetic, dispatch
order and pointer writes are the pin's. `flow-graph-attach-at-add` records the scheduling difference:
the attach runs inside addToScene instead of a resolved promise; onStart fires on the first
before-render tick in both. Pick dispatch is synchronous: the native release handler reads the id
buffer back in the same input phase, at most one frame earlier than the browser's readback promise.
A written material transform offset shows at the next draw.

## Physics contract

Body debug geometry is materialized by Node Havok WASM from complete HP shape constructor inputs.
A generated startup entry extracts inputs before `startEngine`; clocks, physics steps, renderer/input execution,
external storage and observable debug membership refuse. Only unread direct instrumentation clocks are omitted.
Source/assets/compiler/native/tool identities and descriptors are recorded in `physics-debug-geometry.json`;
native matching compares every descriptor field. No body poses, trajectories, frames or reference pixels are baked.

HINGE anchors and default perpendicular vectors come from the pin; Bullet supplies the hinge solver.
Other Cartesian/angular constraints use Bullet's six-axis solver with source-selected free/limited/locked rows.
The radial row preserves those Cartesian frames. It evaluates predicted substep anchors and applies the
measured correction `0.4 * initialSignedViolation - predictedSignedViolation`, with short-step stiffness
scaling. Forces, torque, both lever arms and inverse inertia participate; no poses or trajectories are baked.
Degenerate anchor axes and constraints between bodies in different worlds refuse.
Identical trajectories are not guaranteed. Solver substitutions include substeps,
speculative contacts, rebound reconstruction, damping/speed conversion and rest
stabilization. The rebound rule is fitted behavior, not ported Havok internals.

Deep initial overlaps use fitted positional recovery, approximately 5% per 60 Hz frame capped at 1 m/s;
incoming impacts retain the rebound solver. TELEPORT pose writes retain zero kinematic velocity.
ACTION pose writes use Bullet's immediate swept pose, where Havok integrates a deferred target and
retains the derived velocity.

Default physics follows variable frame delta, capped at 100 ms. Explicit
scene/world fixed steps advance once per rendered frame, including the initial zero engine delta.
Each scene resolves its callback delta once per update; there is no automatic
fixed-frequency accumulator. Applications must supply fixed-step scheduling.
Preserve authored overrides in browser/native comparisons.

Body insertion/configuration order, center-of-mass offsets, collider ownership,
trigger events and combine modes are explicit library boundaries. Degenerate
boxes expand below Bullet's margin with a positive-face limitation.
Triangle-mesh storage outlives its shapes. Static bodies use Bullet's BVH;
dynamic bodies use GImpact with its approximate inertia over the same triangles.
Heightfield extraction translates pinned world-space bounds, Float32 stores and sample remapping.
Bullet uses a static triangle BVH with the measured Havok grid orientation and cell diagonal.
Rectangular HP heightfields read inconsistent/out-of-range samples in the pin and refuse.
Container placement translates the pinned inverse/product/decomposition path. Bullet convex support
instances preserve child-local offsets, rotation and nonuniform scale without mutating shared geometry.
Container inertia uses Bullet's approximation; child material/filter/trigger differences refuse.
Floating-origin regions are separate worlds and do not collide with one another.

Convex proximity uses Bullet GJK/EPA; casts use its convex sweep. Cylinder queries use a measured rounded
rim margin `min(0.015, 0.1 * minimumHalfExtent)`. Parallel cylinder/capsule contacts select the lower axial
overlap endpoint to match Havok's nonunique closest feature. These are measured solver adaptations.
Box queries use a measured 0.015 rounded margin capped by the smallest half-extent. Capsule/box face
ties select the capsule's authored first endpoint within the face overlap.

Character-controller contact order differs from Havok when dynamic obstacles move; the contacted-body
set agrees while contact instants and later contact points differ.

Compare rest/shape properties separately from per-step flight, contact, rebound
and sleep traces.

## Text contract

Pinned producers shape/pack static text. TextData retains distinct mutable identity even when
blobs deduplicate. Live layout uses HarfBuzz over the packaged font and pinned AST layout/packing;
generation runs the pinned extractor/atlas packer over the complete font repertoire, so atlas
allocation and indices precede input.

Group caches belong to TextData. Shared data can retain the first renderable's
UBO/style bindings until source invalidation rebuilds a group. Disposal releases
the appropriate buffer/atlas leases while retained CPU data follows source
lifetime. Runtime upload/style/group order and per-stage constants follow the pin.

Deferred registration checks existing scene identity, drains snapshots and
publishes after successful construction. Synchronous throws stop a batch;
admitted async wrappers allow the batch's remaining calls before rejection.
Arbitrary asynchronous builders are outside this boundary.

Both backends consume unchanged Slug WGSL and pinned pipeline descriptors.

## Audio contract

LabSound implements the reached Web Audio boundary and remains independent of
the renderer. Matching graph topology/scheduling does not establish PCM fidelity.

## What is measured: the full page

Parity includes the canvas and reached UI. Declared canvas thresholds also gate
UI-free attribution; those measurements do not replace full-page results.
[Status](status.md) owns numeric values; [debugging](debugging.md) owns measurement
commands and interpretation.

## Parity reports

Reports carry backend/build identity, full/foreground MAD, byte ratios, bias and
spatial attribution. They localize differences rather than diagnose their cause.
