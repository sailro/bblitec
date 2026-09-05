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
  and retaining-sink model. Replace source-text/positional scope recognizers.
  General render/update callbacks, escaping captures and dynamic-import/AOT
  promise dispatch need this common contract.
- [ ] Extend discriminated unions, numeric-literal narrowing and
  definitely-assigned locals across try/finally. A static nullable annotation
  must not keep both branches live when its value is known.
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
- [ ] Generalize optional trailing out-parameters, enum values in native
  arrays, vector setter aliases and nullable handle-like result records.
- [ ] Validate warning-clean emission for a direct
  `if (physicsRaycast(...).hasHit)` and a Vec3 literal inside a frame callback.
  These forms need their own build regressions before their old probe reports
  can be considered closed.
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
- [ ] Normalize reflection sidecar source paths so shader-cache replay does
  not depend on which scene populated the cache first.
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
  visibility rather than the PBR binding-0/1 convention.
- [ ] Gate optional generated code at its actual reach: CSM blocks/sizes,
  morph-shadow helpers, physics aggregate/trigger helpers, camera viewport
  helpers, mesh clone/builders, display gizmos and utility-layer overlays.
  Build scenes reaching none, each alone and interacting combinations.
- [ ] Reclaim retired shadow tasks/targets/caster views using
  generation-checked handles and source-material texture ownership. Release
  removed resources without invalidating retained source handles.
- [ ] Share duplicated physics mask/dirty-marking paths. Retain body region
  origins and indexed triangle-mesh backing storage where supported.
- [ ] Consolidate gizmo widget builders/options and utility-layer records.
  Reuse per-frame bounds-walk scratch and indexed visitation instead of
  repeated allocation and linear duplicate searches.
- [ ] Use one shared billboard-pick candidate walk and measure the
  readable-present-copy blit paths before consolidating SDL presentation.
- [ ] Avoid full detailed-pick CPU-array copies while preserving scene-facing
  typed-array semantics. Supply an internal borrowed/read-only geometry view.
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
| Cameras | Explicit off-center orthographic bounds, disable/restore behavior and wider environment combinations. Camera upperRadiusLimit sizing is implemented; add an observing gate rather than reimplement it. |
| Imported hierarchy | Full root clone/rotation/scaling, imported light/camera descendants and morph clone weights. Give imported roots a consistent native node representation and preserve clone-of-clone outer transforms. |
| Rotation | Replace separate Euler/quaternion lanes with the pinned proxy model; lower quaternion-to-Euler conversion and measure mixed writes. |
| Direct morph | Multiple targets and one shared weights object attached to several meshes. |
| PBR | Remaining metallic-reflectance options, textured environment rotation, local cubemap blending and unimplemented asset extension fields. |
| Standard UV | Material uvOffset, lightmap legacyFlipV and rebuild semantics beyond the reached fixed transform. |
| Textures | Remaining depth/geometry texture-view assignments and explicit per-texture encoding paths; do not conflate supported colour views with other aspects. |
| Node material | Geometry MRT, delegating blockLoader, loaded-material texture handles and live scalar inputs. Alpha-combine graphs are already supported; wider alpha modes still need contracts. |
| Plugin | Uniform writers/UBO layouts, priority/defines/runtime enable state and PBR sampler plugins. Trim dead Standard arms using actual material usage counts. |
| Shader material | Remaining uniform APIs/system values and depth/blend/stencil/plugin options outside the reached sets. Typed 2D/array/comparison samplers and storage creation/update/dispose/binding already exist. Preserve material depthCompare explicitly. |
| Effects | Wider binding descriptors/textures, custom vertex and renderer update callbacks, disposal and unregister operations. |
| Sprites | Coverage gamma, handle-object methods, append-atlas forms and mixed-family transparent depth ordering. Atlas-from-frames is already implemented. |
| Billboards | Cutout, floating-origin and mixed splat contributors in picking; preserve one registration-ordered contributor list. |
| Picking | Raw skeletons, morph-only/basic deformation, thin-instance/VAT ids, filter/discard/ignore, remaining PickingInfo fields/nullable returns and multiple clouds. Basic/detailed picking and getPickedNormal are implemented. |
| Splats | Shared splatsData buffer identity, Float32Array-over-ArrayBuffer views, live updateData/upload/versioning, lossless SOG WebP decode and per-cloud plugin sets. F32Array is already a typed-array wrapper; verify its constructor/view semantics rather than assuming vector ownership. |
| Shadows | Thin-instance CSM caster bounds, unsupported generator options/live receive toggles, task-camera facade and caster-specific composition. Recheck morph-bound numeric width and CSM array sizes against pinned declarations. |
| Lines | Runtime-computed point lists, createLines/dashed lines, colour updates, material compare and per-instance colour setters outside the reached slice. |
| Thin instances | Dynamic draw-count fast path, culling/LOD controls and actual GPU culler; measure a sufficiently large changing pool. |
| Particles | Live sets, moving-emitter replay, graph snippets, flipped texture uploads, bridge lifecycle/view options and broader graph-factory arguments. |
| Navigation | Tiled-without-obstacles builds, additional queries/random state, sources and disposal not yet lowered. |
| Physics | Constraints, character controllers/viewer, heightfield/capsule APIs, mass centre updates, disposal, shape rotation and remaining body/trigger options. Existing force/impulse/velocity/prestep controls are not missing. |
| Physics fidelity | Segment-end raycast misses, first-substep gravity/landing residuals, speculative box contacts, fixed-clock timer boundary and double-precision solver evaluation need focused traces. |
| Audio | Durable browser/native offline PCM gate; master-volume ramps and broader Babylon sound/bus/spatial/analysis/lifecycle APIs. |
| UI/platform | General text input/forms, retained UI under other drivers, device loss, multiple surfaces and a renderer-independent Canvas2D-only driver. |

## P1 — Unregistered numbered scenes

The current registry leaves these 29 numbered scenes unregistered. Helper
modules without a numbered scene entry are not integration candidates.

| Scene | Integration scope still to establish |
| --- | --- |
| 41 | Non-glTF container entity traversal and physics scene construction |
| 46 | Module mutable state and physics constraints/axis limits |
| 47 | Physics viewer, heightfield and switch-assigned mesh handling |
| 48 | Shape/material setters and full centre-of-mass behavior in Bullet |
| 49 | Capsule builder plus the scene's physics/gizmo contracts |
| 91 | CSG2 through pinned manifold WASM and per-material mesh creation |
| 103 | PhysicsBody Map identity and segment-end raycasts; keep reference query |
| 104, 105 | Structural hierarchy guards/owner grouping and character controller |
| 106 | Enum data values and vector-set aliases; aggregate/prestep setters already exist |
| 114 | Scene-authored skeleton, box-data result, nullable PickingInfo, barycentric reads and missing deformation pipeline arms |
| 121 | Retained splat buffer views and live updateData |
| 122 | SOG ZIP/WebP decode without an alpha-corrupting canvas round trip |
| 149 | Node geometry emitter/inputs, material texture reads and MRT draws on both backends |
| 153 | Canvas2D-only driver, fillRect, plain-data animation targets and update loop |
| 164 | GPU device-loss lifecycle |
| 180, 181 | Text subsystem plus live text controls/input |
| 186 | Tuple flatten and PBR local cubemap probes |
| 225 | Geospatial camera/control surface |
| 227, 228 | Multiple surfaces and swapchains |
| 231 | Scene-authored Standard skeleton, vertex-alpha bucket, UV offset and optional out-parameters |
| 241 | glTF anisotropy, diffuse transmission/translucency, specular textures and animation-pointer inputs |
| 261 | TAA composite output identity/input tasks, history uniforms and camera projection jitter; compact its frame yields |
| 275 | Font loading and 3D text |
| 300 | Executed blob atlas into graph arguments, sprite-sheet state, particle-buffer reads and fixture data shapes |
| 302 | Definite assignment, provider/matrix step replay, shared seed factory, nested startEngine and capture narrowing |
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
