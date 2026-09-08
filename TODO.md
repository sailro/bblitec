# Unfinished work

Only open work belongs here. [Features](docs/features.md) owns support, [fidelity](docs/fidelity.md) owns
adaptations, [status](docs/status.md) owns measurements and [audit](audit.md) owns verified findings with their
status. One line per item: the gap, where it is, its size (S < 1 h, M < half day, L) and what reaches it.

## Compiler

- [ ] Nullable string/number truthiness emits bare `has_value()` (data-lowering.ts:8330): "" and 0 read truthy except through the localStorage flag (web-storage.ts:96). S, then sweep the 33 trees declaring `Nullable<std::string>`.
- [ ] Each frame yield nests another `defer_start_continuation` lambda (compiler.ts:20591): scene261 nests 161, 20 trees nest 2 or more. Emit a counted requeue in the same order. M.
- [ ] A finally spanning startEngine admits plain writes only (compiler.ts:20545-20567); lower exception completion so a cleanup exception replaces the active one instead of terminating. M; 8 trees reach finally.
- [ ] Every handle-touching function or method call inlines its whole body (classes.ts:1138-1175, user-functions.ts:2357-2405): the demos are 89-98% repeated text and antigravity-racer's main.cpp compiles in 400-620 s. Emit each body once per specialization and call it. L.
- [ ] Frame callbacks capture block-scoped and inlined-function locals by `std::ref` (compiler.ts:11736, closure-captures.ts:36-38): quake's `skyTime` and antigravity-racer's CSM receiver run on dead stack slots. Make the by-reference decision lexical. M.
- [ ] `switch` on a generation-known string emits every arm (statements.ts:963-1000); recursive groups are re-declared per entering call site (user-functions.ts:1650, classes.ts:1292); returned record scalars are boxed per call (compiler.ts:18647); static index resource loops unroll flat (statements.ts:2051-2072, scene214 944 KB). Fold each. M each.
- [ ] 27 `getText()` recognizers remain in src/compiler; the fetched-atlas bake is keyed on `voxelpack/`, `blocks.ts` and source substrings (fetched-canvas-atlas.ts:26-62) and 1,169 lines of hierarchy-walk provers are gated by the function name `findNode` (handle-collections.ts:2455-3813). Typed user-code IR with one symbol/alias resolver and an escape/retaining-sink model retires them. L.
- [ ] `probeEmission` (compiler.ts:13857-13885) restores nine fields by hand; features, assets, temporaries, native bindings and type-registry marks mutated in a declined probe persist. Journal every mutable field. M.
- [ ] Union discriminants accept string literals only (data-types.ts:1393); generic user functions refuse (user-functions.ts:691). S each; no corpus reach measured, drop if none.
- [ ] Typed WGSL parsing falls back to `rawSource` (shader-ir.ts:982) behind three regex predicates (:1154-1194); 37 regex-over-WGSL sites remain across the shader pipeline. Extend the IR to helper functions, constants and loops (:1320) before removing any. L.
- [ ] The UBO writer (pinned-ubo-writer-lowerer.ts:738-1451) and the glTF interpolation renderer (gltf/animation-interpolation.ts:91-231) are their own expression walkers; making them clients of the numeric lowerer needs two spelling knobs (float literals, minimal parenthesization) so the pinned bytes stay identical. M.
- [ ] 115 hand-rolled `new PinnedNumericLowerer` skeletons beside 87 `lowerPinnedFunction` sites (pinned-function-lowerer.ts): add caller-allocated locals and guard-arm selection to the generic path and migrate. L, byte-neutral per file.
- [ ] The glTF loader template is a 246 KB hand-written C++ program of which 14-17% is lowered (templates/gltf-loader-cpp.ts); the `.babylon` loader is hand-written entirely (templates/babylon-loader-cpp.ts). Continue the leaf-lowering rounds. L.

## Assets and composition

- [ ] Every browser producer launches Chromium (browser-harness.ts:131; 8 call sites) and re-transpiles its module graph (`transpileForBrowser`, 6 sites); share one page and graph per generation without weakening cache keys or provenance. M; about 40 trees.
- [ ] js_voxel_file.hpp:65 hand-parses one save document; replace with typed JSON lowering. M; minecraft, sandblox.
- [ ] Post-process option kinds are classified by a literal's field names (post-process-options.ts:385-407); derive them from the pinned option interface as screen-space-lowerer.ts:1086 does. S.
- [ ] material-plugin.ts evaluates `getCustomCode` bodies (:499-604) apart from `PinnedShaderText`; share the evaluator. S/M.
- [ ] Record-field assignments key on kind "material" plus property (assignments.ts:2391-2394): a PBR handle writing diffuseColor/specularColor emits the Standard field silently. Carry the family. S.
- [ ] Two sources whose 32-bit FNV names collide would overwrite one packaged asset (compiler/assets.ts:550); refuse the collision in `registerAsset`. S.
- [ ] Transcoded Basis/KTX2 chains are wrapped in a KTX1 container (basis-transcode.ts:248) that the generated parser copies mip by mip out of a whole-file read (compressed-texture-lowerer.ts:744, :776); ship the mip list and parse through spans (`CompressedMipLevel` in runtime.hpp, the glTF template, cli.ts). M; scenes 25/36/112.
- [ ] The image-codec list is spelled seven times (image-codecs.ts:7, feature-activation.ts:2299, browser-texture-function.ts:664, native/CMakeLists.txt:36, native/vcpkg.json features, package-demo.ps1:94-117/258-269, sdl3-image portfile.cmake:22-39). One manifest. S/M.
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
| UI | Tag allowlist (compiler.ts:8484); no retained UI under standalone frame-graph/effect drivers (:6130); Canvas2D partial clear, source-rect blits, transforms and clipping (ui.md#canvas2d) |
| Text | Static font size/options; live color arguments and run edits refuse (text.ts:134, text-surface.ts:59-149); one text-only default scene (upstream-lower.ts:759-764) |
| Post-process/TAA | TAA source preparation covers Standard colour tasks only (compiler.ts:1068, upstream-lower.ts:769); fog only for PBR/Standard surfaces (renderer-lowerer.ts:2991); scene-code transmissive materials have no composed arm (pinned-material-arms.ts:1311) |
| Flow graphs | 18 admitted block types; other blocks, accessors, context, BABYLON_flow_graph and data cycles refuse (features.md#flow-graphs) |
| Assets | Parented/geometry-less .babylon nodes (features.md#asset-loading-and-upload); collector rest/optional parameters (gltf-mesh-walks.ts:28); material extensions/texture transforms/BasisU with public albedo reads (gltf-material-texture-identity.ts:18); animated/morphed GPU instances (gltf-loader-cpp.ts:2832); Standard VAT (pinned-standard-variants.ts:494) |

- [ ] Bullet writes an ACTION target pose immediately (pal_physics_bullet.cpp:2763-2770); Havok integrates a deferred target and keeps the derived velocity. M; scene 106.
- [ ] Solver residuals at the registered poses (status.md: 105 0.274, 41 0.215, 101 0.178, 48 0.060, 45 0.039). Trace per substep with BBLITE_PHYSICS_TRACE (pal_physics_bullet.cpp:1715) before touching authored scenes or thresholds.
- [ ] One 0.28 foreground residual is shared by scenes 11/152/218/219 (status.md); unit-scale and browser/native palette controls untested. M.
- [ ] Retire regression-node-geometry-output, -scene-skeleton, -imported-mesh-walk, -physics-mesh-shape and -shadow-pbr-only: their registry "Retires when" conditions (scene-registry.ts:767/805/983/4307) are met by scenes 149/231/104-105/215. S.
- [ ] Editing gizmos are display-only (display-only-editing-gizmo adaptation; scenes 221/222/224): bounding-box and scale drags are not reached. M.
- [ ] Six generation-time feature-pair refusals stand where the constraint is per object (upstream-lower.ts:758-771, 2666-2740: detailed picking with thin instances, billboard picking with floating origin or splats, TAA with imported PBR, the two text regexes); refuse where the pairing is known. M each.

## Worker and platform

- [ ] Worker realms must share one rendering product (worker-modules.ts:82-85). L; unreached beyond offscreen.
- [ ] Transfer lists admit OffscreenCanvas only (workers.ts:119); clone nodes are undefined/null/bool/double/string/array/object/buffer/transfer (pal_structured_clone.hpp:41); ArrayBuffer transfer, MessagePort and Date/Map/Set/typed-array views refuse. L; unreached.
- [ ] Worker listeners: message/error only, `once` the only option, no worker-scope error or unhandledrejection (workers.ts:133-147, runtime.hpp:180). M; unreached.
- [ ] The Window realm forwards mouse events only (pal_window_realm.cpp:431-435); keyboard, cross-realm preventDefault and ResizeObserver entries are missing; drawCallCount is per engine but has no worker transport. L.
- [ ] SharedArrayBuffer/Atomics fall to the generic constructor refusal (expressions.ts:689); name the contract. S.
- [ ] DPR follows a 16 ms poll of SDL_GetWindowDisplayScale (pal_window_realm.cpp:477); a pure DPR change leaves the canvas backing store (pal_canvas.hpp:134) and every MediaQueryList stays registered (pal_window_realm.cpp:337-341). M.
- [ ] File accept/MIME/extension/label tables are spelled four times (browser-file.ts:39, js_file.hpp:280-326, js_voxel_file.hpp:26) with two parsers; one generated descriptor. M, deletes more than it adds.
- [ ] read_local_storage tests exists() before opening (pal_storage.cpp:124-138), read_text_file_bounded copies twice (pal_file_io.hpp:256-266), pal_ui_form.hpp:36 reads a font unchecked and pal.cpp:254 reads unbounded; one helper returning absent/error/value. M, deletes more than it adds.
- [ ] json_parse builds a nlohmann::ordered_json and converts it to JsonValue (js_json.hpp:598-604); parse directly, keeping key order, numeric flattening and the SyntaxError boundary. M.
- [ ] The Win32 move/resize modal loop stalls the SDL_PollEvent loop (pal_platform_events.hpp:621); adopt SDL main callbacks for interactive builds. M.

## Backend and performance

- [ ] No test compares .slots sidecars with PAL binding tables (test/ checks survival and bytes only); SDL keeps four PinnedStageSlots pairs (pal_sdl_gpu.cpp:941-1084) and Dawn its own node layout caches (pal_dawn.cpp:7158, :7307). M.
- [ ] create_torus is emitted in 182 trees and reached in 12; morph-shadow 19/2; light/camera gizmos 7/1. Gate at reach. M, deletes generated code.
- [ ] Shadow generator maps/buffers are released only at teardown (pal_sdl_gpu.cpp:3891, :6022) and handles index the vector; reclaim retired generators without compacting. M.
- [ ] The two scene frame loops are single 6.7-6.9k-line functions (pal_sdl_gpu.cpp:7180-14035, pal_dawn.cpp:10143-16812) and the frame conductor is re-spelled in eight loops; the frame-graph target planning and the 2D/effect/frame-graph conductors are duplicated per backend (~500 lines). Share one conductor template and one `plan_render_targets`. L.
- [ ] `pal_dawn.cpp` and `pal_sdl_gpu.cpp` are recompiled per scene because pal_gpu_shared.hpp includes six per-scene variant headers; the invariant PAL units and the precompiled header are rebuilt per tree though ten define tuples cover the registry (35% + 21% of all native compile time). A `bblite_pal_common` target and PCH bucketing first, then variant tables out of the backend units. L.
- [ ] `sync_style_sheet` rebuilds and re-projects the whole sheet every frame before comparing (pal_ui_rml.cpp:3306, :5004); the crosshair is a private property (:1929), there is no bare tag selector kind (:1729-1749), line height is hardcoded 1.32 (:3155). M.
- [ ] Dawn builds and deploys on Windows only (build-dawn.ps1:60-65, :105); Vulkan is compiled out of SDL and Dawn (build-sdl-min.ps1:156, DAWN_ENABLE_VULKAN=OFF) and no SPIR-V ships. L; validate Linux/macOS against browser references before claiming either.
- [ ] Drop sdl-multisample-read.patch (SDL#15838) and d3d12-multisample-lines.patch (SDL#16182) when an SDL release passes their controls; png-grey-ramp-last-index.patch self-retires. S per release.
- [ ] Floating origin recomputes the eye offset per draw (pal_gpu_shared.hpp:626 via :347) although frame_floating_origin_offset exists (:596); a transform-only version bump rebakes and re-uploads whole vertex buffers, twice with pinned_vertices (pal_dawn.cpp:13137-13181). M; 9 trees.
- [ ] `compile-shaders.ps1` re-implements target selection, tool discovery, stage identity and artifact lists that src owns and holds ~510 lines of SDL binding semantics as PowerShell regexes; one WGSL change re-runs the pass over all 307 directories. Port to TypeScript with a per-directory checkpoint; prove with `neutrality-generated`. L.
- [ ] The memory verdict cannot see object-level growth and prints a negative retired count (parity-scene.ts:1190-1195; the `[mem]` line at pal_gpu_shared.hpp:6612 carries no node count). S.
