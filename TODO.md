# Unfinished work

This file owns future capabilities and maintenance work. Confirmed audit
defects and their closure evidence live in [audit.md](audit.md). Supported
behavior lives in [features](docs/features.md); measured results live in
[status](docs/status.md). Do not duplicate completed work or development history.

The numbered-scene inventory below is checked against `src/scene-registry.ts`.
Its rows describe remaining integration scope, not a fresh compile-probe
transcript or a guarantee that one listed change completes the scene. Before
implementation, follow the sizing/capture workflow in
[debugging](docs/debugging.md).

## P1 — Compiler model

- [ ] Generalize namespace/default imports beyond specialized recognized
  modules; preserve resolved-symbol intrinsic identity.
- [ ] Build a typed user-code IR with one symbol/alias resolver, escape graph
  and retaining-sink model. Replace source-text/positional scope recognizers,
  including the syntactic stored-callback set behind shared closure cells;
  until then a by-value capture of a mutable binding that a closure writes
  needs a refusal measured across the matrix. General render/update
  callbacks, escaping captures and dynamic-import/AOT promise dispatch need
  this common contract.
- [ ] Extend discriminated unions, numeric-literal narrowing and runtime
  definitely-assigned locals across try/finally beyond generation-only bindings.
- [ ] Lower finally with explicit exception completion so a cleanup exception
  replaces an active body exception. The existing C++ scope guard can terminate
  on that double throw; engine-spanning finally therefore refuses cleanup calls,
  accessors and explicit throws until their exception behavior is represented.
- [ ] Carry runtime numeric width on values rather than in already-rendered
  C++ text; use the same sink conversion for inline returns and tuple lanes.
  Invalidate static parameter metadata after assignment. Compare generated
  output and remeasure affected numeric/sprite scenes.
- [ ] Preserve JavaScript truthiness for general nullable strings/numbers,
  including empty string and zero. The localStorage-specific rule does not
  establish correctness for every optional value.
- [ ] Add stored subclass/dynamic dispatch and full generic method-body
  instantiation. Keep concrete class identity and hoisted-field proofs.
- [ ] Avoid unused class hydration reads, default-initializer duplication and
  whole-closure construction for identity-only Map/Set lookup. These need lazy
  properties, default-value recognition and heterogeneous lookup respectively.
- [ ] Collapse adjacent empty frame-yield continuations into counted requeues.
  Keep scheduling order while removing compiler nesting ceilings; align
  for/for-of/budgeted-loop frame-yield classification.
- [ ] Make probes non-emitting and transactional for compiler state as well as
  text; use typed optionality/receiver classification instead of compileValue
  probes. Consolidate alias resolution and loop-control subtree walks.
- [ ] Generalize optional trailing out-parameters and nullable handle-like
  result records.
- [ ] Extend every/some and related shape predicates over generation-decoded
  tuple bindings, using the same static materialization boundary as arguments.
- [ ] Extend typed WGSL parsing through reached const/function/loop forms and
  retire strict raw-source fallback when the IR can represent their contracts.

## P1 — Lowering reuse and asset processing

- [ ] Lower pick-ray construction through an optional-record return adapter.
  Consolidate repeated computeAabb derivations across mesh, line and morph
  helpers onto the already-lowered pinned function.
- [ ] Extend shared statement inventories to restated audio, clustered-light,
  atlas and VAT bodies. `LoweringContext.assertStatementInventory` already
  exists; the remaining task is complete contract coverage, not moving the
  helper. A count alone must not stand in for semantic arm coverage.
- [ ] Consolidate typed-array name/type tables, imported mesh-search emitters,
  repeated enum-option validation and distinct-list registries. Generalize
  recursive flatten recognition by symbols/normalized structure.
- [ ] Consolidate recording WebGPU stubs only after inventorying each caller's
  allowed method surface; keep unexpected calls failing rather than supplying
  a permissive shared stub.
- [ ] Reuse one parsed repository module graph and browser worker for asset
  execution. Preserve producer isolation, complete content-addressed inputs and
  fetched-asset provenance. Retire the voxel-atlas-specific source gate through
  a typed fetched-asset manifest.
- [ ] Emit an ordered typed `.babylon` renderable manifest shared by native
  loader generation and variant composition, replacing their duplicate
  admission/count predicates.
- [ ] Generalize the bounded local-factory evaluator and shader-text fold for
  scene declarations, including source-located failure reporting. Plugin-only
  copies should consume those shared entry points.
- [ ] Carry material family as a typed lane, then validate every family-specific
  write; a generic material handle must not accept an unrelated Standard setter.
- [ ] Derive post-process option kinds from pinned config declarations, not
  the scene's chosen field names.
- [ ] Cache SPZ payloads with observed rotation and assert that a scene-wide
  rotation cannot hide a version-conditional write. Add a same-cloud
  PLY/SPLAT packaging equivalence fixture and shared output-collision policy.
- [ ] Cache assembled KTX1 bytes rather than base64 JSON; parse native
  container ranges through spans to avoid full extra copies. Derive KTX2
  sampler mapping from the pinned descriptor and measure large-texture replay.

## P1 — Runtime, build and tooling

- [ ] Extract stateful UI analysis into a narrow lowerer with typed style
  metadata. Split stylesheet/tree/content dirtiness; update affected subtrees,
  track layout demand, index hover candidates and active textures, and replace
  hardcoded repeated-background/crosshair markup with generic typed layers.
- [ ] Add compiled-stage layout tests comparing reflection/slots with PAL
  bindings. Cover optional node morph pairs, empty generic layouts and removed
  bindings before narrowing generated capability guards.
- [ ] Reflect each node variant once into a shared binding map. Build node
  group-1 layouts from it, preserving nodeU's binding and actual stage
  visibility rather than the PBR binding-0/1 convention. Fold the node
  geometry variants into that same table behind a task selector, which needs
  the slot arithmetic to move with them, and compose a node mesh block once
  per mesh per frame rather than once per pass.
- [ ] Build one geometry colour-target builder per backend. The node arm is a
  third near-verbatim copy of the classes-to-targets loop and a strict subset
  of the two material-family copies, whose trailing-output, blend and
  depth-write arms are already no-ops for a geometry view.
- [ ] Gate optional generated code at its actual reach: CSM blocks/sizes,
  morph-shadow helpers, physics aggregate/trigger helpers, camera viewport
  helpers, mesh clone/builders, display gizmos and utility-layer overlays.
  Build scenes reaching none, each alone and interacting combinations.
- [ ] Reclaim retired shadow tasks/targets/caster views using
  generation-checked handles and source-material texture ownership. Release
  removed resources without invalidating retained source handles.
- [ ] Share duplicated physics mask/dirty-marking paths. Retain body region
  origins and indexed triangle-mesh backing storage where supported. Narrow
  the proximity collector's search threshold to the best distance found so
  far, so the narrowphase stops generating pairs the collector discards.
- [ ] Consolidate gizmo widget builders/options and utility-layer records.
  Reuse per-frame bounds-walk scratch and indexed visitation instead of
  repeated allocation and linear duplicate searches.
- [ ] Use one shared billboard-pick candidate walk and measure the
  readable-present-copy blit paths before consolidating SDL presentation.
- [ ] Avoid full detailed-pick CPU-array copies while preserving scene-facing
  typed-array semantics. Supply an internal borrowed/read-only geometry view.
- [ ] Add a bone-palette version covering scene skeleton publication, glTF
  animation and bone-control writes, then share dirty upload checks between
  visible draws and picking. Repeated skinned picks currently upload unchanged
  palettes; transform versions do not cover every pose writer. Validate an
  immediate pose write followed by a pick before skipping any upload.
- [ ] Remove double compilation/copies of optional vertex streams and place
  mesh/material compatibility validation at composition, including task
  material overrides.
- [ ] Build a shared image-codec manifest contract across generation, CMake,
  vcpkg and packaging instead of repeating optional codec lists.
- [ ] Retire SDL overlay fixes only after a candidate dependency implements
  and passes the multisample-storage and D3D12-line checks. Track
  [SDL #15838](https://github.com/libsdl-org/SDL/pull/15838) and
  [SDL #16183](https://github.com/libsdl-org/SDL/pull/16183).
  Keep the shipping-only static-no-dynapi patch separate.
- [ ] Establish an upstream retirement path for SDL_image's
  `png-grey-ramp-last-index.patch`; keep unrelated overlay ports when removing
  an individual fixed port. Revalidate decoder pixels before updating baseline.
- [ ] Review the retained RmlUi compatibility patches against upstream
  responses and supported font engines; they are not all documented RmlUi bugs.

## P1 — Broader feature contracts

| Family | Remaining work and validation boundary |
| --- | --- |
| Cameras | Explicit off-center orthographic bounds, disable/restore behavior and wider environment combinations. Camera upperRadiusLimit sizing is implemented; add an observing gate rather than reimplement it. Geospatial controls attach but every input arm refuses: the pin's frame integrator resets through chained assignments and null stores that the pinned numeric lowerer has no arm for, and drag-pan, zoom-to-cursor, pinch and fly-to additionally need a picking ray off the inverse view-projection. |
| Imported hierarchy | Full root clone/rotation/scaling, imported light/camera descendants and morph clone weights. Give imported roots a consistent native node representation and preserve clone-of-clone outer transforms. A clone of a loaded mesh that sets its own position adds the loader's baked node transform instead of replacing it, measured at 15.992 MAD on a clone-and-place probe and reproduced with glTF alone. |
| Rotation | Replace separate Euler/quaternion lanes with the pinned proxy model; lower quaternion-to-Euler conversion and measure mixed writes. |
| Direct morph | Multiple targets, one shared weights object attached to several meshes, replacement with independently retained detached resources, runtime attachment variants and native-coordinate thin-instance streams. Definite scene-code attachments compose Standard and PBR morph variants with local vertices and live world matrices; second attachments to a scene mesh and the remaining attachment/instancing combinations refuse. |
| PBR | Remaining metallic-reflectance options, textured environment rotation, local cubemap blending and unimplemented asset extension fields. |
| Standard UV | Lightmap legacyFlipV and rebuild semantics beyond the reached live offset and texture transforms. |
| Textures | Remaining depth/geometry texture-view assignments and explicit per-texture encoding paths; do not conflate supported colour views with other aspects. |
| Node material | Geometry MRT, delegating blockLoader, loaded-material texture handles and live scalar inputs. Alpha-combine graphs are already supported; wider alpha modes still need contracts. A node material drawn by a geometry-renderer task builds a single-target pipeline for a multi-attachment pass and is not refused; the refusal belongs where the mesh and task are paired, not on the feature pair. |
| Plugin | Uniform writers/UBO layouts, priority/defines/runtime enable state and PBR sampler plugins. Trim dead Standard arms using actual material usage counts. |
| Shader material | Remaining uniform APIs/system values and depth/blend/stencil/plugin options outside the reached sets. Typed 2D/array/comparison samplers and storage creation/update/dispose/binding already exist. Preserve material depthCompare explicitly. |
| Effects | Wider binding descriptors/textures, custom vertex and renderer update callbacks, disposal and unregister operations. |
| Sprites | Coverage gamma, handle-object methods, append-atlas forms and mixed-family transparent depth ordering. Atlas-from-frames is already implemented. |
| Billboards | Cutout, floating-origin and mixed splat contributors in picking; preserve one registration-ordered contributor list. |
| Picking | Eight-influence skinning, deformed thin-instance/VAT ids, filter/discard/ignore, remaining PickingInfo fields and multiple clouds. Basic/detailed regular skeleton, morph-only and combined projections are implemented; nullable results retain identity and checked engine ownership through supported data paths. |
| Splats | Per-cloud plugin sets and remaining picking contributor combinations. Retained splatsData/updateData buffers and byte-safe numeric ArrayBuffer views preserve aliases; view methods and native contiguous consumers remain explicitly unsupported until adapted. |
| Shadows | Thin-instance CSM caster bounds, unsupported generator options/live receive toggles, task-camera facade and caster-specific composition. Recheck morph-bound numeric width and CSM array sizes against pinned declarations. |
| Lines | Runtime-computed point lists, createLines/dashed lines, colour updates, material compare and per-instance colour setters outside the reached slice. |
| Thin instances | Dynamic draw-count fast path, culling/LOD controls and actual GPU culler; measure a sufficiently large changing pool. |
| Particles | Broader live evaluators, provider inverse-matrix registration and pure-2D/explicit billboard bridges, graph snippets, flipped texture uploads, bridge lifecycle/view options and broader graph-factory arguments. Mixed native/frozen sets and composed system membership still need shared random/buffer identity. |
| Navigation | Tiled-without-obstacles builds, additional queries/random state, sources and disposal not yet lowered. |
| Physics | Constraints, character controllers/viewer, heightfield/capsule APIs, disposal, shape rotation and remaining body/trigger options. Existing force/impulse/velocity/prestep and authored centre-of-mass controls are not missing. Havok's inertia term is per unit mass while `PhysicsMassProperties::inertia` is absolute, so explicit inertia and inertia orientation are refused rather than converted. Constraints are a new divergence class: the stepping contract covers contacts only, and `LINEAR_DISTANCE` has no Bullet equivalent. |
| Physics fidelity | First-substep gravity/landing residuals, speculative box contacts, fixed-clock timer boundary and double-precision solver evaluation need focused traces. |
| Audio | Durable browser/native offline PCM gate; master-volume ramps and broader Babylon sound/bus/spatial/analysis/lifecycle APIs. |
| UI/platform | General text input/forms, retained UI under other drivers, device loss, multiple surfaces and a renderer-independent Canvas2D-only driver. |

## P1 — Worker service

The [dedicated Worker service](docs/architecture.md#worker-service-design)
implements local module factories, independent realms, task/microtask/timer
ordering, typed promises, cloned message graphs, canvas transfer and owned
shutdown. Computation, repeated-instance, nested-worker, cancellation and
graphics consumers have targeted checks. Remaining API expansion:

- [ ] Compose heterogeneous generated graphics products into explicit domains;
  the current shared renderer accepts identical product sets across realms.
- [ ] Admit ArrayBuffer transfer lists, MessagePort/MessageChannel and broader
  structured-clone types, with atomic validation/detachment across mixed lists.
- [ ] Extend Promise APIs and unhandled-rejection delivery; add explicit
  WorkerGlobalScope error-listener and broader EventTarget option contracts.
- [ ] Extend Window host input/DOM admission, including keyboard/focus/default
  actions across asynchronous realm boundaries, and observer entry payloads.
- [ ] Add per-realm draw instrumentation and a shared capture census; the
  current deterministic image gate covers independent engines, while per-draw
  capture explicitly refuses this configuration.
- [ ] Treat shared memory, classic workers and runtime-selected scripts as
  separate feature contracts; preserve the worker-free runtime path.

## P1 — Offscreen (Worker) application

The unchanged pinned application is registered as `offscreen`. It owns both
views, the original blocking button and the Worker message protocol. Full-page
and separate canvas gates freeze both engines at frame 180. Targeted native
replay checks blocking, unblocking, expanded-button centering, responsive resize
and shutdown on both backends. Run instructions are in
[development](docs/development.md#worker-application-checks).

- [ ] Add a controlled cross-display DPR transition check; source DPR watchers
  and resize messages are implemented, but the current replay changes window
  dimensions on one display.

## P1 — Unregistered numbered scenes

The current registry leaves these 16 numbered scenes unregistered. Helper
modules without a numbered scene entry are not integration candidates.

| Scene | Integration scope still to establish |
| --- | --- |
| 41 | Non-glTF container entity traversal and physics scene construction |
| 46 | Module-scope mutable state, a `createPhysicsConstraint` intrinsic over all six pinned types, and a Bullet constraint layer. Three contracts; the third is a new divergence class, since `LINEAR_DISTANCE` has no Bullet equivalent. |
| 47 | Physics viewer, heightfield and switch-assigned mesh handling |
| 49 | A `createCapsule` builder, a mesh parented to a mesh, `shapeProximity`/`shapeCast` over Bullet closest-point and convex-sweep entry points, and a conditional mixing a picked node with null. Four contracts. |
| 104, 105 | Structural hierarchy guards/owner grouping and character controller |
| 149 | Delegating `blockLoader` (the pin's `loadNodeBlockEmitterWithGeometry`, where the port accepts a local closed switch), live node-material input handles, loaded-material reads, runtime per-material node construction, and the geometry `LOCAL_POSITION` attachment, which needs a bound local-normal lane and a real node world. Five contracts. |
| 164 | GPU device-loss lifecycle |
| 180 | The text subsystem plus live text controls and input. It reads `textarea.value` and re-layouts on `input`, so nothing folds: `layoutText` shapes through a vendored pure-JS shaper, and matching its glyph ids, advances and kerning natively is a re-derivation, not a port. It also needs the standalone text renderer path with no scene or camera, a dynamically imported weight-offset call and eight live DOM controls. |
| 181 | The same text subsystem and live input as 180. |
| 186 | Tuple flatten, live PBR `ormTexture`/`directIntensity` writes, and the PBR local-cubemap extension, which needs cube-array textures in both PALs and a 64 KB uniform block SDL_GPU pushes rather than binds. Three contracts, the third a subsystem. |
| 227, 228 | Multiple surfaces and swapchains |
| 261 | Composite output identity, a source render-task reference as a descriptor option, a live blend-factor writer, a per-frame task execute hook, and camera projection jitter over a persistent per-task scene UBO. Five contracts. The last two have no refusal: with only the first three, generation succeeds and the scene renders unjittered and unblended. |
| 275 | `loadFont` and `createDefaultTextData` folded by executing the pinned shaper at generation, a text scene entity carrying the pin's deferred registration, the alpha-to-coverage text arm, the pinned Slug shader family with its overridable constant, and a text draw path in both PALs. Six contracts; the payload folds to about 1.5k floats and pinned Tint accepts both stages today, but the sixth is a new draw subsystem and the fifth would be this compiler's first overridable shader constant. |
| 304 | FlowGraph runtimes and glTF interactivity |

- [ ] Investigate the shared shark-pose residual in scenes 11/152 with a
  unit-scale control and browser/native palette comparison.
- [ ] Keep project-owned gates for contracts no registered corpus scene
  observes, including runtime thin-instance flush/count and observing physics
  shape/region cases. Retire them only when equivalent corpus coverage exists.

## P1 — File/data platform boundary

- [ ] Replace voxel-module save/load recognition and the handwritten grammar
  with ordinary JSON/user-module lowering. Resolve typed parse and File System
  Access API boundaries; reuse the generic browser-file PAL.
- [ ] Emit one typed file-accept descriptor covering MIME, extensions and
  labels, used by both input filters and Blob downloads.
- [ ] Read bounded text directly into a sized string and return a typed
  absent/error/value result from open, removing the extra byte copy and
  stat-before-open race without suppressing non-not-found errors.
- [ ] Parse dynamic JSON directly into JsonValue with source order,
  duplicate-key/numeric behavior and existing throw boundaries, avoiding the
  intermediate ordered_json tree.

## P1 — Backend portability

### Vulkan

- [ ] Resolve SDL's combined-image-sampler binding contract without relying on
  the normalized-HLSL stopgap; localize the PBR shading divergence using
  reflection and uniforms.
- [ ] Run Linux and multiple adapter classes; validate depth, clip space,
  cube orientation and texture colour spaces against same-platform references.

### Metal

- [ ] Build and run generated MSL on macOS; validate uniforms, derivatives,
  cube maps and blending.
- [ ] Extend Dawn surface creation, adapter setup and tool/library deployment
  beyond Windows; WGSL transport already belongs to Dawn.

## P2 — Performance and shipping

- [ ] Reuse dynamic thin-instance staging spans/scratch for mirror transforms
  and colour padding, preserving capacity/version invalidation.
- [ ] Widen remaining high-precision matrices only with an observing transformed
  large-world scene. Reuse a per-pass eye offset instead of recomputing it per
  draw, and avoid re-uploading byte-identical vertices after a transform-only
  change under floating origin.
- [ ] Evaluate SDL surface conversion, image writer and CRT size using linker
  maps. Remove a dependency only after every decoder/writer consumer is
  accounted for and pixels still match.
- [ ] Evaluate packed native assets without modifying immutable source
  evidence; report original and packaged byte budgets separately.
- [ ] Improve LabSound package discovery/export consumption and measure the
  reached audio implementation beyond its prototype PCM checks.
