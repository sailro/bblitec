# Unfinished work

Only open work belongs here. [Features](docs/features.md) owns support, [fidelity](docs/fidelity.md) owns
adaptations, [status](docs/status.md) owns measurements and [audit](audit.md) owns verified findings with their
status. One line per item: the gap, where it is, its size (S < 1 h, M < half day, L) and what reaches it.

## Compiler

- [ ] Stored-array destructuring assignments still refuse nested, defaulted and member targets (data-lowering.ts); identifier targets and a final rest are represented. S/M; collection transforms use destructuring.
- [ ] Retained `textContent`/`innerText` compound assignments need a text getter preserving descendant/markup text; they refuse in ui-projection.ts. M; event-driven UI updates.
- [ ] Class inheritance, `#private` members, static blocks and mutable static fields written from static methods refuse (classes.ts); a caught error's `name` is always `Error` and its `cause` is dropped (error-values.ts), pending an error value kind over a native exception carrying both. M; real applications reach each a few times.
- [ ] `Object.assign(engineHandle, {...})` still erases silently (object-statics.ts, the shape the browser-instrumentation path always erased); lower it as the property writes it stands for, or refuse. S; camera-mutations and node-geometry tests pin the current shape.
- [ ] Lowerings that restate a neighbour instead of reaching one mechanism: the logical-assignment store repeats the scalar and data-path stores rather than running the plain assignment under its guard, and `dictionary.name` keeps a member arm per operation rather than canonicalizing to the element access (data-lowering.ts); `Array.from`'s mapper walk shares no scaffold with the array-callback loops; library globals are recognized per site with three alias tests (expressions.ts, static-evaluator.ts, module-initializers.ts); `DataTypeRegistry` names anonymous structs while classifying, so callers pre-gate on checker facts (`declaredAsDictionary`, `mentionsTypeParameter`), the module-state planner reads container-ness off initializer syntax, and the receiver's type arguments sit beside the call-frame stack (data-types.ts). M.
- [ ] A finally spanning startEngine admits plain writes only (compiler.ts:20545-20567); lower exception completion so a cleanup exception replaces the active one instead of terminating. M; 8 trees reach finally.
- [ ] Typed WGSL parsing falls back to `rawSource` (shader-ir.ts:982) behind three regex predicates (:1154-1194); 37 regex-over-WGSL sites remain across the shader pipeline. Extend the IR to helper functions, constants and loops (:1320) before removing any. L.

## Assets and composition

- [ ] Every browser producer launches Chromium (browser-harness.ts:131; 8 call sites) and re-transpiles its module graph (`transpileForBrowser`, 6 sites); share one page and graph per generation without weakening cache keys or provenance. M; about 40 trees.
- [ ] js_voxel_file.hpp:65 hand-parses one save document; replace with typed JSON lowering. M; minecraft, sandblox.
- [ ] material-plugin.ts evaluates `getCustomCode` bodies (:499-604) apart from `PinnedShaderText`; share the evaluator. S/M.
- [ ] Two sources whose 32-bit FNV names collide would overwrite one packaged asset (compiler/assets.ts:550); refuse the collision in `registerAsset`. S.
- [ ] `BBLITE_RENDERER_TRANSMISSION` is 1 in five trees whose composed set carries no refraction arm (littlest-tokyo, scene177, scene178, scene26, tetris); derive it from the composed arm like the other capability defines. S, changes five binaries.
- [ ] `renderer-lowerer.ts:3277-3470 assertPinnedShaderFormulas` asserts fragment formulas of a transcription that no longer exists; the four `lowerShaders` arm booleans exist for it alone. Delete. S.

## Runtime capabilities

| Area | Open work (refusal or gap) |
| --- | --- |
| Cameras | Off-center orthographic planes (camera.ts:384); geospatial input arms (scene 225); controls have no restore path after the disposer (scene.ts:317) |
| Hierarchy | Imported-root scaling and non-Y rotation (assignments.ts:1587-1599, scene-node-transforms.ts:20-37); getDescendants/getChildMeshes have no arm |
| Morphs | One direct target per mesh (mesh.ts:2085), one mesh per target (assignments.ts:2123), pre-start only (:2112), no thin-instance combination (pinned-mesh-features.ts:47) |
| PBR/Standard | Textured environment rotation (scene.ts:344, asset.ts:928); static local cubemaps only (local-cubemap.ts:50); metallic-reflectance allowlist (material-options.ts:872); lightmap binding before registration (material.ts:804) |
| Node materials | Numeric inputs and reflective/map mutation (node-input-surface.ts:36-76); later texture producers (compiler.ts:10249); imported strided/non-FLOAT/deformed geometry (node-geometry-assets.ts:29-49, compiler.ts:2008) |
| Plugins/shaders | System uniforms beyond five matrices (shader-material.ts:340); getUniforms/writeUbo/defines/isEnabled/priority (material-plugin.ts:194-206); PBR sampler plugins (:555); fixed-function state beyond culling/depthWrite (shader-material.ts:131) |
| Effects | Custom vertexWGSL and blend state (effect.ts:334); visibility/sampleType/viewDimension/samplerType (:132); per-binding uniform records (:390); textures beyond createSolidTexture2D (:417); update callback (:449); no dispose/unregister arm |
| Sprites/billboards | Sprite coverage-gamma lane never written (sprite-lowerer.ts:2257); handle-object APIs have no arm; loadSpriteAtlas metadataUrl/textureOptions (sprite.ts:891-916); system `order` against other transparents (:1578) |
| Picking | Four influences (four-influence-skinning adaptation, scene 7); thin-instance/VAT detailed picks (pinned-picking-shaders.ts:60); pickAsync filter/discard/ignore (picking.ts:89); hit-record field allowlist (hit-record.ts:103) |
| Splats | One shader-fragment list per scene (compiler.ts:19678); buffer-view methods beyond find/filter/reduce/some/every/map/forEach (data-methods.ts:1538-1559) |
| Shadows | PCF normalBias, PCF-spot forceRefreshEveryFrame, CSM stabilizeCascades/worldSpaceBias (shadow.ts:101-127); computed receiveShadows (assignments.ts:1794); thin-instance CSM casters lowered (pinned-csm.ts:536) but unobserved |
| Lines/instances | updateLineSystem topology and color-layout changes (line-lowerer.ts:843-846, line.ts:193); no dash API; thin-instance GPU culling omitted (adaptation; scenes 16/165, sandblox) |
| Particles | Unlowered evaluators/local shapes (node-particle-live-lowerer.ts:2110-2126); provider bridges (particle.ts:619, :797); snippets (:686); flipped textures (node-particle-lowerer.ts:2331); mixed provider/generation sets (particle.ts:537) |
| Navigation | Tiled builds without obstacles (navigation.ts:715); reachRadius (:561); no getRandomPointAround or dispose arm |
| Physics | Constraint springs/motors/retained handles (physics.ts:228-264); groundMesh-only square heightfields (:217); inertia orientation (:1341); character/viewer observables (character-controller.ts:52, physics.ts:288-319); concave/compound proximity targets refuse in the PAL |
| Audio | setMasterVolume ramps and eleven REFUSED_BY_NAME APIs (audio.ts:56-93); bus.ts is not lowered (output-projection.ts:446); no browser/native offline PCM gate |
| UI | Tag allowlist (compiler/ui-projection.ts); no retained UI under standalone frame-graph/effect drivers; Canvas2D partial clear, source-rect blits, transforms and clipping (ui.md#canvas2d) |
| Text | Static font size/options; live color arguments and run edits refuse; retained text requires one text-only default scene (pal_text_scene.hpp) |
| Post-process/TAA | TAA preparation covers Standard colour tasks only (pal_temporal_shared.hpp); fog only for PBR/Standard surfaces; scene-code transmissive materials have no composed arm |
| Flow graphs | 18 admitted block types; other blocks, accessors, context, BABYLON_flow_graph and data cycles refuse (features.md#flow-graphs) |
| Assets | Collector rest/optional parameters (gltf-mesh-walks.ts:28); material extensions/texture transforms/BasisU with public albedo reads (gltf-material-texture-identity.ts:18); animated/morphed GPU instances (gltf-loader-cpp.ts:2832); Standard VAT (pinned-standard-variants.ts:494) |

- [ ] Bullet writes an ACTION target pose immediately (pal_physics_bullet.cpp:2763-2770); Havok integrates a deferred target and keeps the derived velocity. M; scene 106.
- [ ] Solver residuals at the registered poses (status.md: 105 0.274, 41 0.215, 101 0.178, 48 0.060, 45 0.039). Trace per substep with BBLITE_PHYSICS_TRACE (pal_physics_bullet.cpp:1715) before touching authored scenes or thresholds.
- [ ] Editing gizmos are display-only (display-only-editing-gizmo adaptation; scenes 221/222/224): bounding-box and scale drags are not reached. M.

## Worker and platform

- [ ] Worker realms must share one rendering product (worker-modules.ts:82-85). L; unreached beyond offscreen.
- [ ] Transfer lists admit OffscreenCanvas only (workers.ts:119); clone nodes are undefined/null/bool/double/string/array/object/buffer/transfer (pal_structured_clone.hpp:41); ArrayBuffer transfer, MessagePort and Date/Map/Set/typed-array views refuse. L; unreached.
- [ ] Worker listeners: message/error only, `once` the only option, no worker-scope error or unhandledrejection (workers.ts:133-147, runtime.hpp:180). M; unreached.
- [ ] Window ResizeObserver entries are missing; drawCallCount is per engine but has no worker transport (pal_window_realm.cpp). M.
- [ ] DOM input still needs event-target value projection, AbortSignal lifetime, explicit pointer capture and coalesced events; focus/form events retain per-element dispatch (dom-listeners.ts, pal_dom_events.hpp, pal_ui_rml.cpp). L; application interaction controllers.
- [ ] SharedArrayBuffer/Atomics fall to the generic constructor refusal (expressions.ts:689); name the contract. S.
- [ ] DPR follows a 16 ms poll of SDL_GetWindowDisplayScale (pal_window_realm.cpp:477); a pure DPR change leaves the canvas backing store (pal_canvas.hpp:134) and every MediaQueryList stays registered (pal_window_realm.cpp:337-341). M.
- [ ] File accept/MIME/extension/label tables are spelled four times (browser-file.ts:39, js_file.hpp:280-326, js_voxel_file.hpp:26) with two parsers; one generated descriptor. M, deletes more than it adds.
- [ ] read_local_storage tests exists() before opening (pal_storage.cpp:124-138), read_text_file_bounded copies twice (pal_file_io.hpp:256-266), pal_ui_form.hpp:36 reads a font unchecked and pal.cpp:254 reads unbounded; one helper returning absent/error/value. M, deletes more than it adds.
- [ ] json_parse builds a nlohmann::ordered_json and converts it to JsonValue (js_json.hpp:598-604); parse directly, keeping key order, numeric flattening and the SyntaxError boundary. M.
- [ ] The Win32 move/resize modal loop stalls the SDL_PollEvent loop (pal_platform_events.hpp:621); adopt SDL main callbacks for interactive builds. M.

## Backend and performance

- [ ] No test compares .slots sidecars with PAL binding tables (test/ checks survival and bytes only); SDL keeps four PinnedStageSlots pairs (pal_sdl_gpu.cpp:941-1084) and Dawn its own node layout caches (pal_dawn.cpp:7158, :7307). M.
- [ ] Morph-shadow is emitted in 19 trees and reached in 2; light/camera gizmos 7/1. Gate at reach. M, deletes generated code.
- [ ] Shadow generator maps/buffers are released only at teardown (pal_sdl_gpu.cpp:3891, :6022) and handles index the vector; reclaim retired generators without compacting. M.
- [ ] The crosshair is a private property (pal_ui_rml.cpp:1929), there is no bare tag selector kind (:1729-1749), line height is hardcoded 1.32 (:3155). M.
- [ ] Dawn builds and deploys on Windows only (build-dawn.ps1:60-65, :105) and no SPIR-V ships. L; validate Linux/macOS against browser references before claiming either.
- [ ] Drop sdl-multisample-read.patch (SDL#15838) and d3d12-multisample-lines.patch (SDL#16182) when an SDL release passes their controls; png-grey-ramp-last-index.patch self-retires. S per release.
- [ ] A floating-origin transform-only version bump rebakes and re-uploads whole vertex buffers, twice with pinned_vertices (pal_dawn.cpp:13137-13181). M; 9 trees.
