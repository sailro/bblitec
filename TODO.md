# Unfinished work

Open gaps only. [Features](docs/features.md) owns support; [fidelity](docs/fidelity.md) owns adaptations;
[status](docs/status.md) owns measurements. Source paths identify the affected subsystem.

## Compiler

- [ ] Complete native capture types for opaque engine values and borrowed aliases so remaining shared closure templates can move to their owning C++ units (`compiler.ts`, `closure-captures.ts`).
- [ ] Classify remaining API implementation routes and member adapters; qualify untested overloads/forms through the [coverage workflow](docs/development.md#api-coverage).
- [ ] Dynamic values: optional own-property presence, earlier class instances, erased record/array mutation (`data-types.ts`, `json-record-views.ts`, `user-functions.ts`, `js_json.hpp`).
- [ ] Embedded NUL strings truncate at native value sinks (`cpp-literals.ts`, `data-sinks/scalars.ts`).
- [ ] URLSearchParams: non-string constructors, append/delete/sort and iteration (`search-params.ts`).
- [ ] Distinct null/undefined storage for destructuring/parameter defaults (`data-lowering.ts`, `js_data.hpp`).
- [ ] Custom thenable resolution and ownership (`async.ts`).
- [ ] Early-return getters (`compiler.ts`).
- [ ] Promise.race heterogeneous results/spreads/iterables; wider constructor adoption/rejection values (`async.ts`).
- [ ] Image network/responsive sources, load/error events and distinct DOMException values (`pal_ui_rml.cpp`).
- [ ] Browser GPU requests, constructors/prototypes and diagnostics (`browser-erasure.ts`, `pal_window_realm.cpp`).
- [ ] Dynamic typeof values in inferred string-literal fields (`data-sinks/structures.ts`).
- [ ] Promise.all spreads/iterables, stored void/value-only arrays and changed recovery representations (`async.ts`).
- [ ] Await inside catch/finally and broader abrupt cleanup completion (`async.ts`, `statements.ts`).
- [ ] Recursive record/function initializers without matching owned layouts (`compiler.ts`, `data-types.ts`).
- [ ] Transitive mutable dependencies in imported constant initializers (`module-initializers.ts`).
- [ ] textContent/innerText compound writes with descendant-text reads (`ui-projection.ts`).
- [ ] Transitions initiated by inline style writes (`pal_ui_rml.cpp`).
- [ ] Reuse RmlUi for live selector metadata; preserve authored queries, generated nodes and input state (`ui_selector.hpp`, `ui_selector_match.hpp`).
- [ ] Intrinsic grid spanning contributions, names/alternate placement, percentage tracks/heights, intrinsic functions and baseline/replaced-item alignment (`ui-grid.ts`).
- [ ] Named/minimum/block/style/scroll-state container queries, relative units and containment types (`ui-projection.ts`).
- [ ] List marker types, counters and images (`ui-projection.ts`, `pal_ui_defaults.hpp`).
- [ ] Constructed radio/number/date controls and file-input type transitions (`ui-projection.ts`).
- [ ] Vertical ranges, tick marks and Firefox control semantics (`pal_ui_range.hpp`).
- [ ] Scroll edge handoff, bounce/navigation, both-edge/vertical/viewport gutters (RmlUi scroll patches).
- [ ] Authored innerHTML query trees, interaction snapshots, :scope and computed selectors (`platform-calls.ts`).
- [ ] Class inheritance/static blocks/static mutation; one member table for the class lowerers' nine name loops; Error cause/errors property reads (`classes.ts`, `native-functions.ts`, `error-values.ts`).
- [ ] Generators/async iteration, Proxy, WeakRef and Symbol storage (`expressions.ts`, `statements.ts`, `data-types.ts`).
- [ ] Object.assign on engine handles erases writes (`object-statics.ts`).
- [ ] Shared lowering for logical assignment, dictionary property access and Array.from callbacks; derived identity and presence spellings marked at the leaf instead of compared against a second leaf; a string leaf given the number/boolean treatment so plain and data strings share one kind, and plain-string `=` through the string sink with the original expression (`data-lowering.ts`, `statements.ts`).
- [ ] Consolidate library-global recognition and type/storage classification; bind a browser primitive the deployment answers as the native constant it materializes to and lower `devicePixelRatio` only natively, so the answered-equals-native rule lives in one place and a nested browser-operand chain folds once per node; fold conditional expressions over answered browser values like logical chains, so the deployment query bag can materialize at the value and pass to helpers; compile a module constant initialized with a constructor once instead of at each use; one owner for the nullable-union member rule, so the lone-member shortcut and the NonNullable intersection arm do not both state it (`expressions.ts`, `static-evaluator.ts`, `module-initializers.ts`, `data-types.ts`, `data-lowering.ts`, `compiler.ts`, `browser-erasure.ts`).
- [ ] General exception completion across startEngine cleanup (`compiler.ts`).
- [ ] WGSL IR support for helpers/constants/loops; remove rawSource and regex fallbacks (`shader-ir.ts`).

## Assets and composition

- [ ] Share Chromium pages and transpiled graphs per generation (`browser-harness.ts`); and run a generation-time JSON pass in process instead of a child: `closureModules` (`browser-texture-function.ts`) already transpiles each module once to CommonJS with a require shim, so `executeModuleGraphCall` can evaluate that under `node:vm` at about a tenth of the child's cost with no data-URL inlining, decide type-only erasure from the emitted code rather than the source, and resolve siblings through the entry program's own resolutions (`program.ts` resolves CommonJS-style, so an extensionless sibling already resolves there) instead of a second file-system resolver (`module-json-sync.ts`, `executed-module-graph.ts`).
- [ ] Replace handwritten voxel-save parsing with typed JSON (`js_voxel_file.hpp`).
- [ ] Share plugin getCustomCode evaluation with PinnedShaderText (`material-plugin.ts`).
- [ ] Refuse packaged-asset FNV name collisions (`compiler/assets.ts`).
- [ ] Derive transmission activation from composed arms (`renderer-lowerer.ts`).
- [ ] Remove obsolete assertPinnedShaderFormulas and its unused arm flags (`renderer-lowerer.ts`).

## Runtime capabilities

| Area | Open gaps |
| --- | --- |
| Engine | Render-function wrapping; shared Window/worker recovery; SDL Vulkan/Metal timestamp queries; additional lifecycle/diagnostic APIs |
| Compute | f16 uniform writers; whole-array storage views on SDL Vulkan/Metal |
| Cameras | Live orthographic plane writes, geospatial input, control restoration, mutable world-matrix aliases |
| Hierarchy | Broader imported hierarchy cloning; descendant/child-mesh queries |
| Morphs | Multiple/replaced/late targets and thin-instance combinations |
| PBR/Standard | Textured environment rotation, live local probes, wider metallic-reflectance fields, post-registration lightmaps |
| Node materials | Numeric/reflective inputs, later textures, strided/non-FLOAT/deformed imported geometry |
| Plugins/shaders | Broader system matrices, uniform types/defines/priority and pipeline state |
| Effects | Custom vertex/blend/layouts, per-binding uniform records, wider textures, update/dispose/unregister |
| Sprites | Coverage gamma, handle APIs, atlas options and mixed transparent order |
| Picking | Eight-influence/deformed-instance/VAT detail, filter/discard/ignore and wider hit records |
| Splats | Multiple fragment sets and broader buffer-view methods |
| Shadows | PCF normalBias/spot refresh, CSM stabilization/bias, dynamic receiveShadows, thin-instance qualification |
| Geometry/instances | Imported geometry resizing; wider partial attribute updates; line topology/colors/dashes; dynamic draw counts |
| VAT | Broader bake, storage/time setters and deformation queries |
| Particles | Evaluators/local shapes, providers, snippets, flipped textures and mixed generation sets |
| Navigation | Tiled builds without obstacles, reach radius, broader path/point/ray queries and disposal |
| Physics | Springs/motors/retained constraints, wider heightfields, inertia orientation, observables, concave/compound queries |
| Audio | Babylon sound/bus/spatial wrappers and master ramps; owned async main-bus metadata; options/statechange, event payloads/onended/AbortSignal, nullable buffers, closed-context graphs, media streams and PCM parity |
| UI | Broader tags/drivers and Canvas2D clear/blit/transform/clip forms |
| Text | Dynamic font options/color/run edits and mixed/custom scene layouts |
| Post-process | Broader TAA/fog/transmission, task ordering/removal/disposal, resource views and samplers |
| Flow graphs | Blocks beyond the admitted 18, accessors/context, BABYLON_flow_graph and cycles |
| Textures | 3D creation, partial/runtime uploads and broader direct KTX2 paths |
| Assets | Wider collectors; public albedo extensions/transforms/BasisU; animated/morphed GPU instances; Standard VAT |

- [ ] ACTION prestep differs from Havok's deferred target/velocity (`pal_physics_bullet.cpp`).
- [ ] Physics solver residuals require substep tracing at registry poses; preserve source and thresholds.
- [ ] Bounding-box and scale gizmo drags lack native editing.

## Worker and platform

- [ ] Extend Android coverage and qualification, including emulator Offscreen rendering corruption ([remaining limits](docs/features.md#android)).
- [ ] iOS: fractional render-density caps, wider lifecycle/interaction coverage and physical-device signing/qualification ([current boundary](docs/features.md#ios)).
- [ ] Preserve runtime canvas dimensions in render targets and particle initialization, or refuse unsupported specialization.

- [ ] Different rendering products across worker realms (`worker-modules.ts`).
- [ ] ArrayBuffer/MessagePort transfer and Date/Map/Set/typed-view cloning (`workers.ts`, `pal_structured_clone.hpp`).
- [ ] Wider worker listener options and worker-scope error/rejection dispatch (`workers.ts`).
- [ ] ResizeObserver entries and worker draw-count transport (`pal_window_realm.cpp`).
- [ ] Beforeunload lifecycle; AbortSignal, explicit pointer capture and coalesced events (`dom-listeners.ts`).
- [ ] Explicit SharedArrayBuffer/Atomics contract (`expressions.ts`).
- [ ] DPR-only backing-store resize and MediaQueryList lifetime (`pal_window_realm.cpp`, `pal_canvas.hpp`).
- [ ] Native compression streams and broader MessageChannel/browser service calls (`platform-calls.ts`).
- [ ] Shared file accept/MIME/extension descriptors (`browser-file.ts`, `js_file.hpp`, `js_voxel_file.hpp`).
- [ ] Shared bounded I/O returning absent/error/value (`pal_storage.cpp`, `pal_file_io.hpp`, `pal_ui_form.hpp`, `pal.cpp`).
- [ ] Direct ordered JsonValue parsing without intermediate JSON conversion (`js_json.hpp`).
- [ ] Window updates during the Win32 move/resize modal loop (`pal_platform_events.hpp`).

## Backend and performance

- [ ] Reduce Minecraft chunk-streaming CPU update spikes; separate meshing, lighting, water settling and allocation costs.
- [ ] Scene290: sustain 100 FPS uncapped through impact and settling; Bullet stepping remains the bottleneck (`pal_physics_bullet.cpp`).
- [ ] Compare compiled slots with PAL binding tables; consolidate duplicated layout caches.
- [ ] Gate morph-shadow and light/camera gizmo emission on reach.
- [ ] Reclaim retired shadow resources without compacting handles.
- [ ] Remove private crosshair property and fixed line height (`pal_ui_rml.cpp`).
- [ ] Additional attribute operators/nth-child of-lists; generated counters/images/typed attr/outline/gradient-text; broader placeholder styling.
- [ ] Omitted/currentColor and non-pixel box shadows; viewport-limited shadow textures.
- [ ] Linux Vulkan parity against browser references, including scene75/scene187 residuals.
- [ ] macOS Metal/font parity and native Apple Silicon validation.
- [ ] Retire SDL multisample/line patches after upstream controls pass; PNG gray-ramp patch self-retires.
- [ ] Avoid full duplicated vertex rebakes/uploads for floating-origin transform-only changes (`pal_dawn.cpp`).
