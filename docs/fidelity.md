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
| UI | RmlUi/FreeType and retained Canvas2D replace browser layout/rasterization; see [UI](ui.md) |
| Skinning | Loaded eight-influence skins retain four influences |
| GPU culling | Reached thin instances can use the pin's all-active fallback |
| Splats | Sorting is synchronous on the render thread |
| Physics/audio | Bullet replaces Havok; LabSound replaces browser audio |

## Shader contract

PBR/Standard use pinned composers; node materials use the pinned graph compiler;
plugins use the pin's splicer/bridges. Sprites, effects and post-processes use
pinned builders/literals with declared specialization. Composition failures
must not select a fallback shader.

The specialized shared vertex path uses a baked world and fixed PAL bindings.
Its deformation path uses four influences with a 64-matrix palette and supported
attribute/storage morph transport. `shared-material-vertex-transport` records
these differences from ordinary color material composition.

### Numeric width

Preserve JavaScript double precision until the source's Float32 allocation or
store. Matrix layout, multiplication order, coordinate transforms and rounding
are part of the contract. Numeric equality and byte equality differ for signed
zero; record which comparison a control establishes.

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

### glTF material inputs

Derive extension predicates and texture/factor choices from the loader, not
format assumptions. Pinned extension handlers own UV selection, transforms and
merging. Native animation targets retain independent texture slots; the pin
does not resolve metallic-roughness texture-transform pointers.

Public color/texture presence and identity differ from render fallbacks.
Retain original color arrays in double precision and project them at the source
registration boundary. Babylon material loading copies the first three diffuse
channels into a fresh array; unused export channels are not public diffuse lanes.

### Deformation and instancing

Vertex layout, mesh world, palette and instance-parent matrices must agree.
Loaded glTF coordinate mirroring is not a universal Standard-mesh convention.
Native Euler/quaternion lanes differ from the pin's single rotation proxy;
mixed writes and wider sharing need explicit admission.

Imported node geometry preserves raw source attributes/indices and per-view
worlds. Its world receipts can be numerically identical with signed-zero
differences; no general bit-identity claim follows.

### Textures and compressed textures

Keep pinned mips, encoding, samplers and upload orientation. KTX/Basis payloads
retain their block data/mips. `invertY` may select a UV transform rather than
a row flip; color and depth views are distinct resources.

### Gaussian splats

Draw, sort and picking share the rendered cloud. Updates retain source buffer
identity and preserve aliases to replaced storage. Refresh data textures before
the next draw or immediate pick; frame sorting follows the pin's transform gate.
Borrowed buffers without an owning lifetime refuse.

### Animation and hierarchy

Property/glTF tracks have separate target/interpolation contracts. Preserve
mutation and render-list invalidation boundaries. Autonomous managers use pinned
clock/lifecycle logic with ordered cancellable native frame requests. Persistent
application RAF composition remains bounded by source requeue semantics.

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
invalidate history that a browser retained. SDL sampled-depth formats can also
differ from Dawn's browser-compatible depth format.

## Picking contract

Use pinned projection modules and originating resource identity. Readback
continuations run after producing draws. Result aliases preserve identity and
barycentric width; mesh queries validate engine lifetime.

Upload pending morph weights/current bone poses before immediate picks.
Visible and picking draws must agree on geometry/world/palette space.
Detailed picking requires primitive-index support; native throws when unavailable
where the browser probe can leave the feature absent. Supported regular
deformation does not imply thin-instance/VAT or eight-influence coverage.

## Flow-graph contract

Generated graphs evaluate the pin's block bodies over the same static graph, so arithmetic, dispatch
order and pointer writes are the pin's. `flow-graph-attach-at-add` records the scheduling difference:
the attach runs inside addToScene instead of a resolved promise; onStart fires on the first
before-render tick in both. Pick dispatch is synchronous: the native release handler reads the id
buffer back in the same input phase, at most one frame earlier than the browser's readback promise.
The pin's pointer-identity guard on release is asserted, not restated; native mouse events carry one
pointer. Material transform reads come from the record each draw packs; a written offset shows at the
next draw. Selectability is a per-node flag the pick filter reads; visibility writes cascade through
the asset's node children and bump the draw-list epoch. `flowGraphRuntimes` is assigned per
addToScene and kept past the scene's disposal, as the pin's resolved array is; `flowGraphs` is the
document's graph list, filled at load.

## Physics contract

The generated Babylon layer targets Bullet; the browser uses Havok.
Identical trajectories are not guaranteed. Solver substitutions include substeps,
speculative contacts, rebound reconstruction, damping/speed conversion and rest
stabilization. The rebound rule is fitted behavior, not ported Havok internals.

Default physics follows variable frame delta, capped at 100 ms. Explicit
scene/world fixed steps advance once per rendered frame; there is no automatic
fixed-frequency accumulator. Applications must supply fixed-step scheduling.
Preserve authored overrides in browser/native comparisons.

Body insertion/configuration order, center-of-mass offsets, collider ownership,
trigger events and combine modes are explicit library boundaries. Degenerate
boxes expand below Bullet's margin with a positive-face limitation.
Triangle-mesh storage outlives its shape; dynamic concave bodies refuse.
Floating-origin regions are separate worlds and do not collide with one another.

Compare rest/shape properties separately from per-step flight, contact, rebound
and sleep traces. Remaining capabilities and residuals belong in [TODO](../TODO.md).

## Text contract

Pinned producers shape/pack static text. Lowered transforms retain doubles until
source float stores; uniform updates preserve their independent invalidation
conditions. TextData retains distinct mutable identity even when blobs deduplicate.

Group caches belong to TextData. Shared data can retain the first renderable's
UBO/style bindings until source invalidation rebuilds a group. Disposal releases
the appropriate buffer/atlas leases while retained CPU data follows source
lifetime. Runtime upload/style/group order and per-stage constants follow the pin.

Deferred registration checks existing scene identity, drains snapshots and
publishes after successful construction. Synchronous throws stop a batch;
admitted async wrappers allow the batch's remaining calls before rejection.
Arbitrary asynchronous builders are outside this boundary.

Both backends consume unchanged Slug WGSL and pinned pipeline descriptors.
SDL depth-format substitution and UI font rendering are separate adaptations.
Capture commands and unobserved byte-range limits belong in [debugging](debugging.md).

## Audio contract

LabSound implements the reached Web Audio boundary and remains independent of
the renderer. Matching graph topology/scheduling does not establish PCM fidelity.
A durable browser/native offline PCM gate and master-volume ramp support remain
unfinished; see [TODO](../TODO.md).

## What is measured: the full page

Parity includes the canvas and reached UI. Declared canvas thresholds also gate
UI-free attribution; those measurements do not replace full-page results.
[Status](status.md) owns numeric values; [debugging](debugging.md) owns measurement
commands and interpretation.

## Parity reports

Reports carry backend/build identity, full/foreground MAD, byte ratios, bias and
spatial attribution. They localize differences rather than diagnose their cause.
