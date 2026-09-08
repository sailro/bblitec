# Unfinished work

Only open work belongs here. [Features](docs/features.md) owns current support,
[fidelity](docs/fidelity.md) owns adaptations, and [status](docs/status.md) owns
measurements. A listed integration area is not a promise that one change finishes
its scene.

## Unregistered numbered scenes

The corpus/registry comparison leaves **4** numbered scenes unregistered.

| Scene | Remaining integration |
| --- | --- |
| 46 | Module-scope mutable state and all six pinned constraint types; map solver differences explicitly, including LINEAR_DISTANCE |
| 104, 105 | Structural hierarchy/owner grouping and character controller |
| 180 | Standalone text renderer/layer, range controls, dynamic color and weight updates |

## Compiler and lowering

- [ ] Replace positional/source-text recognizers with typed user-code IR, one
  symbol/alias resolver and an escape/retaining-sink model. Mutable callback
  captures and dynamic-import continuations need one ownership contract. The
  node-particle and flow-graph lowerers each carry a pinned-body partial
  evaluator (environment, module scope, free-name ladder, statement walk);
  share one core and emit flow-graph node functions as members of the
  generated runtime class once both generated trees are proven byte-identical.
- [ ] Extend namespace/default imports, discriminated/numeric-literal unions,
  stored subclass dispatch, generic method instantiation and runtime
  definite assignment across try/finally.
- [ ] Represent exception completion in finally: cleanup exceptions must
  replace active exceptions without C++ double-throw termination.
- [ ] Carry numeric width on values, unify tuple/return/manager-delta sinks and
  invalidate static parameter metadata after writes.
- [ ] Preserve general nullable string/number truthiness, including empty/zero.
- [ ] Make compiler probes transactional and non-emitting. Consolidate alias,
  callback/timer and loop-control walks; represent pending-let control depth.
- [ ] Replace avoidable class hydration/default reads and identity-only closure
  construction with lazy properties/default recognition/heterogeneous lookup.
- [ ] Collapse empty frame yields into counted requeues without changing order.
- [ ] Extend optional out-parameters, nullable handle records and static
  every/some predicates over decoded tuples.
- [ ] Extend typed WGSL parsing to reached const/function/loop forms and remove
  raw-source fallback only where IR covers the contract.
- [ ] Consolidate pinned translator result-shape registries and route remaining
  vec3 literals through record-literal lowering.
- [ ] Share pinned pick-ray/computeAabb lowering, typed-array/enum tables and
  symbol-based imported traversal helpers.
- [ ] Complete semantic statement inventories for restated audio, clustered
  light, atlas and VAT adapters.

## Assets and composition

- [ ] Share parsed module graphs and browser workers for producer execution,
  preserving isolation, complete cache keys and fetched-asset provenance.
- [ ] Replace voxel-atlas/save-load recognizers with typed fetched-asset,
  ordinary module and JSON lowering.
- [ ] Consolidate recording GPU stubs with strict per-producer method contracts.
- [ ] Share an ordered typed Babylon renderable manifest between loader
  generation and material composition.
- [ ] Generalize bounded local factory/shader-text evaluation for scene and
  plugin declarations. Derive post-process option kinds from pinned types.
- [ ] Carry material family in typed values and validate family-specific writes
  and task overrides during composition.
- [ ] Cache SPZ with rotation provenance; add same-cloud PLY/SPLAT equivalence
  and shared packaging collision policy.
- [ ] Store assembled KTX1 bytes directly; parse native ranges through spans.
  Derive KTX2 sampler mapping from source descriptors.
- [ ] Share one image-codec manifest across generation, CMake, vcpkg and packaging.

## Runtime capabilities

| Area | Open work |
| --- | --- |
| Cameras | Off-center orthographic bounds, disable/restore and geospatial input; add observing upperRadiusLimit coverage |
| Hierarchy/rotation | Imported-root clone/rotation/scaling, clone-of-clone transforms, imported descendants and a unified Euler/quaternion proxy |
| Morphs | Multiple/shared targets, retained replacement, conditional attachment and thin-instance combinations |
| PBR/Standard | Remaining reflectance options, textured environment rotation, live local-probe/ORM rebinding and lightmap flip/rebuild semantics |
| Node materials | Live scalar inputs, later input/topology changes, wider texture producers and imported deformed/strided geometry |
| Plugins/shader materials | Wider UBO/uniform/system values, runtime plugin signatures, PBR samplers and fixed-function state |
| Effects | Broader vertex/binding/texture descriptors, update/dispose/unregister paths |
| Sprites/billboards | Coverage gamma, handle APIs, append-atlas forms and one registration-ordered mixed transparent/pick list |
| Picking | Eight influences, deformed thin-instance/VAT IDs, scene-code filter closures, remaining result fields and multiple clouds |
| Splats | Per-cloud plugins, mixed pick contributors and typed-buffer methods/contiguous consumers |
| Shadows | Thin-instance CSM bounds, generator options/live receive toggles, task cameras and caster-specific composition |
| Lines/instances | Runtime point lists, lines/dashes/color changes, fast dynamic draw count and GPU culling/LOD |
| Particles | Wider evaluators/providers/bridges/snippets, texture flip, lifecycle and mixed-set random/buffer ownership |
| Navigation | Tiled builds without obstacles, broader queries/random state and disposal |
| Physics | Constraints, characters/viewer, explicit or rectangular heightfields, broader query shapes/options, inertia orientation/conversion and remaining lifecycle/options |
| Audio | Browser/native offline PCM gate, master-volume ramps and broader sound/bus/spatial APIs |
| UI | General forms/text input, additional drivers and multi-surface source shapes |

- [ ] Preserve imported clone placement semantics: explicit clone position must
  replace the source position, not add a baked node transform.
- [ ] Investigate shared shark-pose residuals in scenes 11/152 using unit-scale
  and browser/native palette controls.
- [ ] Trace physics first-substep/landing, speculative contacts, timer boundaries
  and solver precision without changing authored scenes or thresholds.
- [ ] Retire project-owned gates only when a corpus gate observes the same
  behavior, including immediate state changes.

## Worker and platform

- [ ] Support heterogeneous renderer products across realms.
- [ ] Add ArrayBuffer transfer, MessagePort/Channel and wider structured-clone
  types with atomic validation/detachment.
- [ ] Extend Promise/rejection/error listeners and EventTarget options.
- [ ] Extend asynchronous Window keyboard/focus/default actions and observer
  payloads; add per-realm draw instrumentation.
- [ ] Treat shared memory, classic workers and runtime-selected scripts as
  separate contracts; preserve the worker-free path.
- [ ] Add a controlled cross-display DPR transition for Offscreen.
- [ ] Share typed MIME/extension/label descriptors for file filters/downloads.
- [ ] Read bounded files into sized storage with explicit absent/error/value
  results; preserve open errors and avoid stat/open races.
- [ ] Parse dynamic JSON directly into JsonValue while preserving key order,
  duplicate/numeric behavior and throw boundaries.

## Backend and performance

- [ ] Build compiled-stage layout checks for optional/removed bindings; share
  node reflection/layout maps while preserving stage visibility and per-view
  state. Share geometry color-target construction.
- [ ] Gate optional CSM/morph-shadow/physics/camera/mesh/gizmo code at actual reach.
- [ ] Version bone palettes across every writer before skipping unchanged
  draw/pick uploads; preserve immediate pose-write-to-pick behavior.
- [ ] Reclaim retired shadow targets/caster views without invalidating retained
  source handles. Avoid detailed-pick CPU copies with an internal borrowed view.
- [ ] Share physics dirty/mask paths and region/backing storage; tighten
  proximity searches using the best distance found.
- [ ] Reuse gizmo bounds/visitation scratch, billboard-pick walks and
  thin-instance staging buffers.
- [ ] Split UI stylesheet/tree/content dirtiness and update affected subtrees.
  Generalize repeated-background/crosshair layers, tag selectors and per-element
  normal line height.
- [ ] Consolidate particle swap/remove/sprite synchronization with pinned
  lowering; share per-set graphs and remove redundant live mapping lookups.
- [ ] Resolve SDL Vulkan sampler contracts/PBR divergence; validate Linux,
  macOS/Metal and additional adapters against matching browser references.
- [ ] Extend Dawn surface/tool deployment beyond Windows.
- [ ] Retire SDL/SDL_image compatibility patches only after upstream behavior
  passes their controls; keep unrelated patches/ports intact.
- [ ] Evaluate RmlUi patches against supported font engines; do not assume every
  adaptation is an upstream defect.
- [ ] Measure high-precision/floating-origin transport, avoid transform-only
  vertex reuploads and redundant per-draw eye offsets where equivalent.
- [ ] Use linker/payload measurements to reduce shipping codecs/CRT/audio costs.
  Improve LabSound package exports and evaluate packed native assets separately
  from immutable source evidence.
