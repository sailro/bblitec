# Audit 2026-09-08

Whole-repository audit at main `1e17bcf3` (386 commits after the 2026-09-01 audit), on the user's
ten questions: feature activation, re-derivation of pinned behavior, transpiler structure, native
isolation and sharing, generated C++, documentation, TODO accuracy, tooling, building and packaging.
Method: ten read-only agents, one per axis, every finding verified at file:line; then fix waves in
per-agent worktrees (byte-neutral refactors proven with the generated-tree digest, behavior changes
measured on both backends), then `/simplify` over the whole branch, then the full sweep.

Status values: **open**, **fixed** (this branch), **filed** (genuinely blocked; the row names what unblocks it).
Sizes: S < 1 h, M < half day, L longer. Line numbers are those of `1e17bcf3`.

## 1. Feature activation

Measured over all 307 generated trees: one activation ledger (`manifest.features` == `features.cmake`
== active activation rows in 307/307), fed by fifteen mechanisms; the renderer-capability defines are a
second layer with thirteen predicates re-typed in TypeScript deciding what the executed pin already
decided. All opt-in functions the docs mention are the pin's own exported API (15 of its 53 opt-ins are
unwired). No scene-name detection exists in the activation path.

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| FA-1 | H | fixed | PBR capability defines derived three ways (asset extension name OR scene call; re-typed asset predicates; composed binding names); the composed arms are only cross-checked | cli.ts:880-916, asset-specializer.ts:602-676, upstream-lower.ts:704-718,881-889 | every composed variant reports its arms; `src/composed-material-capabilities.ts` feeds the defines and slot table; six specializer booleans and the cli ORs deleted; `assertArmsCovered` is the composer's test. One value changed: scene144 spec-gloss slot dropped (the asset declares the extension without a texture, the pin composes metallic-roughness), MADs unchanged |
| FA-2 | M | open | CSM has a feature but no gate: 503 CSM lines in `pinned_shadow.hpp` in 15 shadow trees that never reach CSM, 62 lines in `runtime.hpp` in all trees; ESM has its own define and header | shadow-lowerer.ts:2347, upstream-lower.ts:900 | `BBLITE_SHADOWS_CSM` from `shadow:csm`; split `csm_shadow.hpp`; gate the PAL cascade arms |
| FA-3 | M | fixed | Asset lights joined by declared light types but arms selected by node references | pinned-material-arms.ts:195-240, compose-pipeline.ts:399-409 | one `gltfNodeLights` helper for both; byte-neutral (all ten corpus assets with lights reference them) |
| FA-4 | M | fixed | Standard bump from a JSON scan while reflection and lightmap come from composed bindings | babylon-asset-features.ts:88-112, upstream-lower.ts:796-804 | bump read off the composed Standard variants' `bT` binding; byte-neutral |
| FA-5 | M | open | `BBLITE_RENDERER_TRANSMISSION`, `BBLITE_DEFORM_PICKING_MORPH`, `BBLITE_GEOMETRY_TASK_FAMILIES` read by pal_dawn.cpp only; SDL compiles the transmission grab path into all 286 scene trees | pal_sdl_gpu.cpp:7321-7416, pal_dawn.cpp:198,8543,12444,13924 | gate the SDL arms on the same defines |
| FA-6 | L | open | Image codecs selected per packaged format; audio decode links every libnyquist container | CMakeLists.txt:957-1035, audio-surface.ts:311 | sniff packaged audio bytes (optional) |
| FA-7 | L | open | `ui:rml` added by the companion path bypassing `reachFeature`; registry-driven activation missing from the docs table | compiler.ts:1267 | route through `reachFeature`; document the five registry fields that reach generation |
| FA-8 | M | fixed | `BBLITE_HAS_TAA`, `BBLITE_STANDARD_SKELETON`, `BBLITE_STANDARD_VERTEX_ALPHA` written by lowerers with no activation row; the 45 CMake defines have no rows | post-process-lowerer.ts:572, pinned-standard-variants.ts:2253, standard-mesh-alpha.ts:86 | rows added for the three lowerer defines; `HAS_TAA` written 0/1; the CMake-derived defines stay CMake's (a row would re-type the mapping) |
| FA-9 | M | fixed | Dead defines with zero readers: `BBLITE_HAS_GLTF`, `BBLITE_SHADOWS`, `BBLITE_MATERIAL_DISPERSION` | CMakeLists.txt:1112-1119, upstream-lower.ts:887,900 | the two emitted defines deleted with their rows; a test scans every emitted `#define BBLITE_` for a native reader (`BBLITE_HAS_GLTF` is the build stream's) |
| FA-10 | L | fixed | Two define conventions (always 0/1 vs defined-only-when-on); no `-Wundef` | CMakeLists.txt:303-308,916-918,942-949 | `HAS_TAA` written both ways; `STANDARD_SKELETON`/`STANDARD_VERTEX_ALPHA` stay defined-only-when-on because every PAL reader tests `defined(...)` |
| FA-11 | M | open | `pal_physics_bullet.cpp` 99% ungated while queries/constraints/trigger/heightfield/character/floating-origin are separate features reached by 1-2 trees each; generated physics.cpp carries every arm in all 25 physics trees | pal_physics_bullet.cpp:653-2556, physics-lowerer.ts | six defines from the existing features; gate the PAL and the generated arms at reach |
| FA-12 | L | open | `runtime.hpp` 96% ungated: per-subsystem records (sprite 549, animation 302, shadow 234, picking 210, gizmo 180 lines) and eight pinned headers compiled into all trees | runtime.hpp, upstream-lower.ts | split per family behind the existing gates (compile time only) |
| FA-13 | M | fixed | Two refusal styles (1,768 source-located `fail()` vs 136 plain throws in the activation path, 12 naming the reaching site); six ad-hoc helpers; combination rules in five places | upstream-lower.ts:644-650, shadow-capabilities.ts:173-248, compiler.ts:1054-1071, compose-pipeline.ts:1123-1128 | `src/generation-refusal.ts`: `refuseGeneration` names the reaching site; one `unsupportedCombinations` table; 80 activation-path throws routed (the TAA coverage list in compiler.ts stays with the compiler) |
| FA-14 | L | open | Packaged-ImageBitmap erasure decided by `getText().includes("fetch(")` | user-functions.ts:2736-2738 | AST predicate |
| FA-15 | L | fixed | Eleven features gate nothing but claim consumer `features.cmake` | feature-activation.ts | ten rows now say `inventory`; `audio:buffer-source` is tested by CMake through a constructed name and keeps `features.cmake` |
| FA-16 | L | open | Site-less reaches (`browser:file`, one `data:json`) | compiler.ts:13060 | pass the site |
| FA-17 | L | open | docs/features.md lists six selection kinds; fifteen exist | docs/features.md:14-31 | replace with the mechanism table |

## 2. Re-derivation of pinned behavior

Native code owns no 3D formula beyond fitted physics and browser-UI substitutes; the PAL's matrix,
sort, CSM-bounds and camera-control bodies are generated from the pin. The gap is in the family
lowerers: 474 shape assertions guard hand-typed C++ bodies against 84 whole-function AST translations,
and an assertion pins a constant, never the composition order, the numeric width or the degenerate arm.

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| RD-1 | H | open | Three hand Euler rotators apply X then Y then Z; the pin's `eulerToQuat` is qx·qy·qz (Z first). Framing, `.babylon` vertex baking, floating-origin packing and shadow fitting disagree with the draw path (which uses the lowered `outer_transform_matrix`) for two-axis rotations | camera-lowerer.ts:767-781, renderer-lowerer.ts:2339-2372 (used :2403, shadow-lowerer.ts:1806), babylon-loader-cpp.ts:148-170 (:572,:659) | delete the three; use `pinnedTrsComposition` |
| RD-2 | H | open | `camera_world_matrix` restates `mat4LookAtWorldLHToRef` line by line; ArcRotate eye restated; camera-lowerer has 0 `lowerPinnedFunction` calls | camera-lowerer.ts:263-330 | lower both through `lowerPinnedFunction` |
| RD-3 | H | open | Property-animation slerp/normalize re-typed in float with two arms the pin lacks; the glTF TU lowers the same functions | animation-lowerer.ts:2218-2265 | reuse the lowered `interpolate_quaternion` |
| RD-4 | M | fixed | `preScalePolynomial` hand-transcribes a module-local pinned function behind a false "cannot be imported" comment | hdr-packager.ts:45-76 | the pinned `polynomialToPreScaledHarmonics` executes through `importPinnedModuleWithExports`; only the 36-to-27 repack is ours; package bytes unchanged |
| RD-5 | M | fixed | Private 177-line template evaluator duplicating `PinnedShaderText` | shader-builtins-grid.ts:44-220 | evaluator deleted; `PinnedShaderText` over a grid source context; scene213 WGSL identical |
| RD-6 | M | open | A third normalization convention in both loaders and a fourth in renderer-lowerer, undeclared | gltf-loader-cpp.ts:997-1001, babylon-loader-cpp.ts:172-177, renderer-lowerer.ts:2505-2513 | one lowered normalizer; declare any remaining divergence |
| RD-7 | M | fixed | Clustered slice scale/bias and spot cone restated with zero shape asserts | clustered-light-runtime.ts:194-198,436-444 | both lowered from the pinned refresh closure and cone writer; scenes 166/179 unchanged on both backends |
| RD-8 | M | fixed | Unasserted restated defaults: texture defaults/anisotropy rule; `rebuildSingle` ternary | pinned-address-modes.ts:302-352, pinned-light-mode.ts:435-441 | defaults and the anisotropy arm read off `loadTexture2DImpl`; the ternary asserted; byte-neutral |
| RD-9 | M | open | Regex over our own emitted C++ decides dead locals, continuation storage and loop-fold safety | compiler.ts:13955-13975,20643; statements.ts:2912-2920,3199 | IR facts (see TR-1) |
| RD-10 | M | open | Hand float restatement of the WGSL world multiply behind a text marker beside an IR-lowered normalizer | pinned-world-transform.ts:1001-1031 | emit through `emitShaderCppExpression` |
| RD-11 | L | open | Four undeclared semantic re-homings in the lifted shader family (skybox fog relocation, single-sample IP/grab arms, `positionUVW` rewrite) | shader-skybox.ts:103-112, shader-builtins-utility.ts:221-242, shader-builtins-background.ts:454-459, upstream-lower.ts:3505-3516 | one fidelity paragraph |
| RD-12 | L | open | `pick_sprite_2d` hidden-sprite guard `== 0` where the pin says `<= 0`; `baked_world_scale` names no pinned symbol | runtime.hpp:5113-5137, gltf-loader-cpp.ts:3486-3499 | align the guard; name the pinned read |

## 3. Transpiler: entry compiler

105 files, 104k lines; `Compiler` is 20.8k lines implementing 19 context interfaces (85 interfaces
re-type the same members up to 52 times); the same analysis question is answered by 14 escape walks,
13 loop-control walks and 6 capture walks with different descent rules; demo-shaped recognizers
survive; probes roll back 9 of 161 fields.

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| CC-1 | H | open | `probeEmission` restores the body and 9 of 161 fields; features, assets, temporaries, native bindings, scene meshes and type-registry marks mutated in a declined probe persist | compiler.ts:13857-13890, 15 probe sites | journaling `EmissionTransaction`; answer probe questions from the typed IR |
| CC-2 | H | open | ≥14 "is it written/escapes" walks, 13 loop-control walks, 6 capture walks, 5 body-reaches scans, each with its own descent rules; two match by name text | user-functions.ts:229-775, statements.ts:462-1325, native-functions.ts:1570-1861, static-evaluator.ts:1295, data-lowering.ts:93 | one policy-parameterized walker per family, migrated under neutrality |
| CC-3 | H | open | Demo-shaped recognizers: atlas bake keyed on `voxelpack/`, `blocks.ts`, `allReferencedTiles` and source substrings; `getImageData` gated on whole-file text; 1,169 lines of "Proves Scene 269 exactly" provers gated by the function name `findNode`; audio `decode` helper by callee text | fetched-canvas-atlas.ts:26-62, compiler.ts:15455-15466, handle-collections.ts:2455-3813, audio-surface.ts:248-300 | symbol reach and typed traversal contracts |
| CC-4 | H | open | 85 context interfaces re-type the same members; every sub-lowerer holds `this` compiler | compiler.ts:688-20836 | one `LoweringServices` base interface |
| CC-5 | M | open | 12 functions over 800 lines, 6 of them name ladders | intrinsics/mesh.ts:571 (2,254 lines), data-methods.ts:204, assignments.ts:1152, expressions.ts:313 | per-name handler tables |
| CC-6 | M | open | 3,284 lines of host-UI projection (HTML tokenizer, CSS parser) and 2,089 lines of DOM/platform calls inside `Compiler` | compiler.ts:5139-8906,15270-16228 | extract `ui-projection.ts` and `platform-calls.ts` |
| CC-7 | M | open | Duplicated tables/helpers: typed-array table ×6 (7 vs 9 rows), `unwrap` ×6 with 3 wrapper lists, `objectProperty` ×2 identical, canvas set ×2, assignment-range idiom ×17, update-op idiom ×27, chain-root walk ×6, Math tables ×5 | compiler.ts:11307, data-lowering.ts:1366,4483, data-types.ts:1042, static-evaluator.ts:1423 | one table/helper each |
| CC-8 | M | open | 243 text-only global/member recognitions; positional shape checks; any type named `*Node` classified as an audio node | static-evaluator.ts:713-977, text.ts:60-63, compiler.ts:1906 | resolve through the symbol resolvers |
| CC-9 | M | open | `Value` carries 151 optional fields on 40 kinds; five parallel 26-case switches and 1,406 discriminant comparisons | types.ts:1749, data-types.ts:656,2614,2688, data-lowering.ts:4960,5966 | per-kind modules with exhaustive visitors |
| CC-10 | M | open | 2,033 `!` (1,374 `arguments[N]!`), 197 casts, 333 `?? literal`, one error-swallowing catch | handle-collections.ts:2192, compiler.ts:15008,16606 | `argumentAt`; narrowing; narrow the catch |
| CC-11 | L | open | Value-import cycle through an intrinsic | intrinsics/material.ts:6 | move `enclosingLoopControl` to `loop-control.ts` |
| CC-12 | L | open | Dead: `isEntrySourceFile`, `shadowGeneratorHasRecordedCasters`, `requireDefaultScene`, `compileReference`, types.ts:30-32 re-export, 6 constant-only parameters, 68 needless exports | compiler.ts:12976,19897,20344; user-functions.ts:2301 | delete |
| CC-13 | M | open | Static-unroll folds compile every iteration and prove uniformity by text identity | statements.ts:2152-2213,2828-2980 | structured comparison once CC-1/CC-9 exist |
| CC-14 | L | open | `compiler-architecture.test.ts` asserts 417 regexes over the repository's own source with 0 compilations; 10 test files assert nothing | test/compiler-architecture.test.ts | behavior tests; neutrality baseline as the refactor gate |

## 4. Transpiler: lowering layer

124 files, 96k lines; 1.2 MB of the layer's 3.65 MB is C++ inside template literals; 76 files use no
AST translator; two loaders are 100% and 86% hand-written; the flow-graph and live-particle lowerers
carry the same partial evaluator twice; nine expression walkers over pinned bodies drift on operators.

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| LW-1 | H | open | glTF loader is a 246 KB hand-written C++ program; lowered segments are 14-17% of its bytes; 27 boolean knobs mirror the pin's feature modules by hand | templates/gltf-loader-cpp.ts | continue leaf lowering (the accessor/material/animation leaves prove the method) |
| LW-2 | H | open | `.babylon` loader 100% hand-written; its lowerer asserts six shapes | templates/babylon-loader-cpp.ts, babylon-lowerer.ts | lower `bake-local-matrix` and `parse-camera` first |
| LW-3 | H | fixed | Same partial evaluator twice (`Env`, `Completion`, exact-duplicate `moduleEnv`, free-name ladder, truthiness/typeof, statement/expression/binary/closure walks) | flow-graph-lowerer.ts:84-1886, node-particle-live-lowerer.ts:181-1223 | `src/lowering/pinned-partial-evaluator.ts`; both lowerers are value models over it; all trees byte-identical |
| LW-4 | H | open | Nine expression/statement walkers over pinned bodies; operator rows drift (`%`, `<=`, `!==` in three, refused by the UBO writer) | pinned-numeric-lowerer.ts, pinned-reference-lowerer.ts, pinned-ubo-writer-lowerer.ts:738-1451, pinned-shader-text.ts, gltf/animation-interpolation.ts:40-231, gltf/sampler-mapping.ts | operator table completed and shared by five walkers (done); making the UBO writer and the interpolation renderer numeric-scope clients needs two spelling knobs on the shared translator (parenthesization, float literals) before the pinned bytes can stay identical |
| LW-5 | H | fixed | 16 `gltf/*.ts` files (10,780 lines) bypass `LoweringContext` on a second contract API | gltf/shared.ts:199-569, gltf/loader.ts:361-387 | context exports `unwrapExpression`, `moduleScopeConstant`, `findNodes`, `propertyName`, `nullishDefault`, `numericValue`, `contractError`; the glTF copies are deleted and 16 leaves re-routed |
| LW-6 | M | fixed | `computeAabb` lowered once and hand-written three times in float | gizmo-lowerer.ts:3319, mesh-builders.ts:3030, line-lowerer.ts:602, shadow-lowerer.ts:1878 | `src/lowering/pinned-compute-aabb.ts` lowers the pinned function once for all four consumers (the shared-header write is a one-hunk follow-up in upstream-lower.ts) |
| LW-7 | M | fixed | Nine hand-typed recording GPU-device stubs plus four engine wrappers (~240 lines); one Proxy stand-in exists | pinned-esm-shadow.ts:61-115, pinned-screen-space.ts:342-424, seven more | `src/recording-device.ts`: one strict Proxy device/queue/encoder/pass under a per-producer contract; all producers migrated, generated trees byte-identical |
| LW-8 | M | open | 115 hand-rolled `new PinnedNumericLowerer` skeletons beside 87 `lowerPinnedFunction` sites; 62 math-call preambles, 44 xyz binding triplets, 74 header preambles re-typed | pinned-function-lowerer.ts:294-392 | `localStorage`/`armOf` options, `vec3MemberBindings`, `pinnedHeader`; migrate |
| LW-9 | M | open | Exact/near-exact helper copies: `moduleEnv`, `elementIndexText`, `isPath`, `plainMaterialUboSpec`/`plainMeshUboSpec`, `propertyName`, `rawWgslLiteral`, `unwrapExpression` ×4, `moduleConstant` ×3, `functionDeclaration` ×2, literal wrappers ×3, sprite/billboard family, dds/hdr adapters | lowering digest L-09 | lowering-side copies gone (`moduleEnv`, `elementIndexText`, `isPath`, the UBO spec pair, the DDS/HDR adapters, the numeric lowerer's unwrap and constant scan); the compiler-side `unwrapExpression`/`propertyName`/literal-wrapper copies and `rawWgslLiteral` follow with the compiler and rederive streams |
| LW-10 | M | open | One-method emitters of 1,000-3,200 lines (`SceneLowerer.lowerCore` 2,548; `lowerMeshFactories` 3,227; `GeneratedSourceWriter.emit` 2,553) | scene-lowerer.ts, mesh-builders.ts, upstream-lower.ts:751-3303 | scene core split into ten methods (-1,071 lines), sprite core into two; the composing return templates and `GeneratedSourceWriter.emit` remain |
| LW-11 | M | fixed | `variantBindings` regex over composed WGSL re-run at 16 call sites | pinned-pbr-variant-cpp.ts:730-798 | memoized per (group, texts); the `.slots` sidecars are written after generation, so memoization is the whole fix |
| LW-12 | M | open | Six generation-time feature-PAIR refusals where the constraint is per-object (detailed picking × thin instances, billboard picking × floating origin/splat, TAA × imported PBR, two text regexes) | upstream-lower.ts:758-771,2666-2740 | refuse where the pairing is known |
| LW-13 | L | fixed | 4 test-only exports, 102 stray exports, dead `standardLights` option, 4 single-caller translator options | pinned-material-arms.ts:681, upstream-lower.ts:489 | test-only exports and `standardLights` deleted; 29 stray exports dropped; the four translator options each gate a spelling that is not byte-identical for other bodies and stay |
| LW-14 | L | open | Six parallel C++ type-spelling tables | pinned-function-lowerer.ts:113-177, pinned-reference-lowerer.ts:54-66, pinned-numeric-lowerer.ts:40-102, flow-graph-lowerer.ts:178-185, node-particle-live-lowerer.ts:165-173, data-types.ts:2613-2685 | `src/lowering/cpp-types.ts` consumed by four tables; `parameterKinds` and the compiler's `cppType` follow (hunks in the lowering digest) |

## 5. Native runtime and PALs

Isolation holds: 22 single-backend builds (11 feature-diverse scenes × DAWN and SDL_GPU) configure
and build clean, single-backend executables reproduce the dual-build MADs exactly, backend APIs are
reached only through `pal_gpu.hpp` and two dispatch sites, generated code names no backend. About
900-1,100 duplicated lines are movable into the shared header; the two scene frame loops are single
6.7-6.9k-line functions.

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| NT-1 | M | fixed | TU selection has two authorities (`featureSources` vs a hand-listed REMOVE_ITEM + re-spelled Dawn predicates); `pal_dawn.cpp` added unconditionally | output-projection.ts:12-274, CMakeLists.txt:274-288,522-544 | Dawn units derived by name from the selected SDL units (a missing twin is a configure error); `pal_dawn.cpp` follows `renderer:scene`; a test pins the pattern |
| NT-2 | M | open | Duplicated record-sync and planning logic across the backends (frame-graph target planning, 2D/effect/frame-graph conductors, sprite-layer reconciliation, VAT/bone/storage sync, clustered lights, UI backdrop, screen-space sequencing) | native digest N-FAC-1 (12 pairs) | shared conductor template, `plan_render_targets`, `sync_records` templates |
| NT-3 | M | open | `run_gpu_engine` 6,855 lines and `run_dawn_engine` 6,669 lines; the conductor re-spelled in 8 loops | pal_sdl_gpu.cpp:7180-14035, pal_dawn.cpp:10143-16812 | split into setup/sync/encode/present; share the conductor |
| NT-4 | M | open | 2D host loops order UI layout differently: Dawn before sprite updates, SDL after them and after swapchain acquire; text update likewise swapped | pal_dawn_sprite.cpp:235-297, pal_sdl_gpu_sprite.cpp:224-281 | align SDL to the scene-loop order |
| NT-5 | M | open | Cycle collector's `owners() >= incoming + 1` invariant only asserted; an over-reporting tracer clears a live node silently in release | js_gc.hpp:216 | refuse instead of assert |
| NT-6 | L | open | Raw texture pointer value stored in the shared Engine record | runtime.hpp:4457-4461 | allocation-counter identity |
| NT-7 | L | open | `--backend` through the tool reconfigures the shared dev tree in place | scene-command.ts:1237-1248 | suffix the build directory |
| NT-8 | L | open | Per-frame canvas-size sync only in the Dawn loops | pal_dawn.cpp:12706 | shared conductor |
| NT-9 | L | open | Transmission members ungated in SDL; morph picking gated by different macros per backend | pal_sdl_gpu.cpp:240-1168 | same defines on both backends (FA-5) |
| NT-10 | L | open | CMake comment claims PAL objects are byte-identical across scenes; they differ | CMakeLists.txt:293-296 | reword |
| NT-11 | L | open | SDL-flavoured default parameter in the shared header | pal_gpu_shared.hpp:6651 | drop the default |
| NT-12 | L | open | Leaked `SDL_Cursor`; plain-global `text_weight_installed` where sibling realm state is thread_local | pal_platform_events.hpp:696-698, text.hpp:45 | destroy at quit; thread_local |
| NT-13 | L | open | Destroy-then-placement-new assignment operators rely on nothrow copies without asserting it | runtime.hpp:833-846,5400-5413 | static_assert |
| NT-14 | L | open | GPU ownership mostly manual; a null view from `wgpuTextureCreateView` stored unchecked | pal_dawn.cpp:3560-3561 | extend the owning wrappers |
| NT-15 | L | open | Device-option structs and the release lambda re-spelled 8 times | pal_sdl_gpu_shared.hpp:580-583, pal_dawn_shared.hpp:280-293 | one `DeviceOptions` + RAII |
| NT-16 | L | open | Dead: `wide_to_utf8`; legacy `BBLITE_IMAGE_CODECS` default serving 0/307 trees; stale `BBLITE_ENTRY_DRIVER` cache entry | pal_win32_text.hpp:50-84, CMakeLists.txt:22-27 | the codec default is a configure error now; `wide_to_utf8` follows with the native stream |
| NT-17 | L | open | Capture structs are ungated members of shipping text records | pal_*_text_resources.hpp:16,58,103 | gate on `BBLITE_VISUAL_CAPTURE` |
| NT-18 | L | open | Unchecked `[handle.value]` indexing convention with no debug switch | pal_dawn.cpp (94 sites), pal_sdl_gpu.cpp (64) | optional checked-handles switch |
| NT-19 | L | open | `Callback::operator()` copies the callback (two shared_ptr copies) per invocation | js_callback.hpp:80-84 | retain the body only |

## 6. Generated C++

The unrolled-loop class is mostly gone; the remaining size mechanism is inlining: every
handle-touching function or method call re-emits its whole body, so the eight demos are 89-98% repeated
text (minecraft 9.2 MB with 215 KB of distinct lines; `main.cpp.obj` 402-622 s for antigravity-racer).
Memory safety: no raw pointers, casts or container-reference reuse in generated demo code; the
record-callback cycles are collectable; idle 3,000-frame runs of tetris, doom and sandblox grow 0.0-0.1 MB.
Two demos run every frame on dead stack slots (GC-2).

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| GC-1 | H | open | Every handle-touching function/method call inlines its whole body; call chains multiply it (distinct lines 1.7-7.9% of the demos; compile minutes) | classes.ts:1138-1175, user-functions.ts:2357-2405, native-functions.ts:237,891,1055 | emit once per (declaration, specialization) and call it; long term let native functions take handle parameters |
| GC-2 | H | open | Frame/registry callbacks capture block-scoped and inlined-function locals by `std::ref`; quake's `skyTime` and antigravity-racer's CSM receiver run every frame on dead stack slots (use-after-scope) | compiler.ts:11736,11774,11844, closure-captures.ts:36-38 | make the by-reference decision lexical; box otherwise; add a generated-tree check |
| GC-3 | M | open | `switch` on a generation-known string emits every arm (tetris `play("move")` carries the whole sound table ×10, 17% of the file) | statements.ts:963-1000 | select the matching clause when the discriminant is static |
| GC-4 | M | open | Recursive groups re-declared and heap-allocated at every entering call site (doom ≈0.7 MB, 11 `Callback` allocations per shot) | user-functions.ts:1650,1715, classes.ts:1292-1300 | hoist per enclosing frame; plain lambdas for non-escaping groups |
| GC-5 | M | open | Returned record scalars boxed into `make_gc_shared<double>` per call on per-frame paths (doom `tryMove` per mobj per frame) | compiler.ts:18647-18660 | skip boxing for read-only consumers or box the record once |
| GC-6 | M | open | Static index resource loops unroll flat with no fold (scene214/215 944 KB, scene103 489 KB, five sprite grids 293 KB each; 20-50 s compiles) | statements.ts:2051-2072, resource-loops.ts:686-806 | capture-and-compare modulo the folded index; one runtime loop over a constexpr table |
| GC-7 | L | open | Environment-unpack lines and blanket `[[maybe_unused]]` are 15-21% of antigravity-racer; 27-62% of unpacked captures are unreferenced | closure-captures.ts:41-44 | unpack only referenced bindings |
| GC-8 | L | open | Float32Array literal tables emitted as `std::array<double>` (tetris 557 KB text, 572 KB rdata) | data-lowering.ts:4745-4748 | element type from the prefix |
| GC-9 | L | open | Baked CSG geometry as multi-megabyte inline float text (scene90 4.3 MB) | intrinsics/mesh.ts:1976-1978 | binary asset (optional) |
| GC-10 | L | open | Small static loops under the nest budget never attempt the fold | statements.ts:2837 | fold every static loop with ≥4 iterations |
| GC-11 | L | open | Continuation-tail locals become function-local `static`s; a second call would reuse a removed element | compiler.ts:20640-20667 | persist only locals read after a yield, or refuse repeated bodies |
| GC-12 | L | open | The memory verdict cannot see object-level growth and prints a negative retired count | parity-scene.ts:1190-1195, pal_gpu_shared.hpp:6612 | add node/allocation counters to the `[mem]` line |
| GC-13 | L | open | Exception boundary is "terminate the program", undocumented for generated callbacks | pal_event_loop.hpp:322-334, pal_sdl.cpp:414-426 | document; consider the error handler |

## 7. Tooling

The `src/` half is one consistent set (one flag parser, report writer, native spawn, browser ceremony,
staleness rule) with real gaps; the `tools/` half is an accumulation: 28 checker scripts (2,941 lines,
37% re-typed harness), 14 files reachable from nothing, two documented pairs not runnable at HEAD.

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| TL-1 | H | open | 28 interaction scripts with 24 hand-composed native environments; 1 of 13 registered-scene checkers spreads the registry `nativeEnvironment`; scenes 231/241 measured at a clock the registry never declares | tools/check-*.mjs, docs/debugging.md:72-92 | `scene -- check <id>` and `observe <id>` over declared checks |
| TL-2 | H | open | 14 tools files and 2 example probes reachable from nothing; scene 46/47 pairs cannot run; `clean --orphans` deletes the twins other checkers use | tooling inventory, scene-command.ts:2422-2436 | delete the dead, fold the rest, owned twins |
| TL-3 | M | open | Six "run bblite_native with env" implementations; `diff`, `capture --native` and `probe-variants` bypass `resolveNativeExecutable` | parity-scene.ts:990,1291, capture-native.ts:62-105, scene-command.ts:325,1775 | one `runMeasured()` |
| TL-4 | M | open | 628-line shared CLI toolkit lives inside parity-scene.ts | parity-scene.ts:138-766 | `src/tooling/*` |
| TL-5 | M | open | `compile-shaders.ps1` re-implements target selection, tool discovery, stage identity and artifact lists, plus ~510 lines of SDL binding semantics as PowerShell regexes | tools/compile-shaders.ps1 | port to TypeScript; prove with `neutrality-generated` |
| TL-6 | M | open | feature-activation.json, fidelity.json and provenance.json have no reader; `show` prints the registry entry only | scene-command.ts:2487-2491 | `show --activation|--adaptations|--provenance` |
| TL-7 | M | open | Draw attribution exists for 9 scenes only (registry-gated at compile) | scene-command.ts:240-245 | `parity --attribute` twin on demand |
| TL-8 | M | open | No non-running "is my exe current" check | parity-scene.ts:958-980 | `status <id>` |
| TL-9 | M | open | Zero tests spawn the 2.8k-line dispatcher | test/ | spawn-level tests |
| TL-10 | L | open | `validate` rejects the documented `--cold`; 12 accepted options undocumented; no `help` | scene-command.ts:2756 | accept; generate usage from the flag specs |
| TL-11 | L | open | Library functions set `process.exitCode`; exit codes 1/2/130 mixed; read-only commands hold the dist lock | scene-compose-report.ts:246, scene-neutrality.ts:319, dist-lock.ts:76 | return verdicts; skip the lock |
| TL-12 | L | open | Two tape spellings; backend list hard-coded ×22; `enableGpuDebug` re-typed ×17 | tools/*.mjs | the driver |
| TL-13 | L | open | Artifacts written and never read (`buffers-summary.txt`, scene49 observations); 65 orphan artifacts folders; 7 orphan trees | capture-instrumented.ts:526-529 | drop the writers; `clean --artifacts` |
| TL-14 | L | open | 17 superfluous exports; 5 copies of the is-main-module guard; 3 hand argv parsers | verify-*.ts, write-corpus-manifest.ts | one helper; `parseFlags` |
| TL-15 | L | open | Docs claim a registry `diagnostics` field; 5 npm scripts undocumented | docs/development.md:59, package.json | fix the word; document or delete |

## 8. Building and packaging

Dependency partitioning is right for codecs, FreeType/LunaSVG, Bullet, LabSound core-vs-codecs and
Dawn (linker maps of the 15 shipping builds); SDL's own subsystem trim is vacuous; the shipping RmlUi is
two patches stale; 35% of all native compile time is the two backend TUs recompiled per scene.

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| BD-1 | H | fixed | SDL trim vacuous: `-DSDL_AUDIO=$audioSetting` unquoted, caches hold the literal, capability files claim OFF, a test pins the broken text; ~386 KiB (22%) of a visual-only exe is unreachable subsystems | tools/build-sdl-min.ps1:144-147, test/build-options.test.ts:260 | one option table drives the configure and is read back from the produced cache (a `$` refuses); both installs rebuilt (`sdl-min` library 8.9 MB to 4.1 MB); torus-states exe 1,843,712 to 1,426,432 bytes, packaged and smoke-run |
| BD-2 | H | fixed | Shipping RmlUi artifacts carry 3 of 5 patches; no provenance recorded or checked; `upstream/rmlui.json` names two | build-rmlui.ps1:219-233, artifacts/tools/rmlui-static* | the artifact records commit and patch shas; CMake refuses a mismatch naming the rebuild command; the pin lists all five; all three artifacts rebuilt |
| BD-3 | H | open | 35% of registry compile is `pal_dawn.cpp` + `pal_sdl_gpu.cpp` recompiled per scene for six per-scene variant headers; invariant PAL TUs (9.7%) and the PCH (11.5%, 16.7 GB) rebuilt per tree though ≤10 define tuples cover 293 scenes | pal_gpu_shared.hpp:19-89,548 | first half done: ten scene-invariant units compile in a `bblite_pal_common` object library whose compile line names no generated directory (the precondition for a cross-scene object cache); the variant tables still live in the two backend units |
| BD-4 | M | fixed | Generation and build identity keyed by mtime: a byte-identical checkout regenerates and rebuilds everything | validation-resume.ts:72-76, generation-stamp.ts:16-19 | inputs and `dist/src` keyed by content through one size+mtime-to-sha cache; a touch of every input is a 2 s no-op |
| BD-5 | M | open | One WGSL change re-runs the shader pass over all 307 dirs; tint/dxc re-hashed per directory | scene-command.ts:1373-1445, compile-shaders.ps1:31-35,1210-1214 | per-directory checkpoint; hoist the hashes |
| BD-6 | M | open | `clean --orphans` would delete the 15 shipping trees; blind to 28 GB of worktree trees and PCH/DLL duplication | scene-command.ts:2389-2440 | recognise shipping trees; report |
| BD-7 | M | fixed | 9.8 GB identical DLL copies and 16.7 GB identical PCHs per dev tree; 1.7 GB per-tree static vcpkg installs | CMakeLists.txt:556-565 | runtime DLLs are hard links (35 MB less per dev tree, about 11 GB over the registry); the PCH follows BD-3 |
| BD-8 | M | fixed | Population makespan floor is `antigravity-racer/main.cpp` at 417 s under clang-cl /O2 (MSVC /O1 2.3-4× faster) | ninja logs | measured: `/clang:-O1` saves 3-7% (the minutes are clang's front end on the 8.8 MB unit, not the optimizer); `BBLITE_MAIN_OPT` knob kept, default unchanged; the real fix is GC-1 |
| BD-9 | L | fixed | ~30 copy-pasted `IN_LIST` define blocks; `/STACK` twice | CMakeLists.txt:371-1101,1148,1179 | `bblite_feature_define` (36 calls, 100 lines fewer); one `/STACK`; missing codec list is a configure error |
| BD-10 | L | fixed | Presets disagree with the recipe; over-featured SDL accepted silently; ad-hoc rmlui artifacts without a script | native/CMakePresets.json:43, CMakeLists.txt:91-116 | presets `min-sdl`, `min-sdl-audio-gamepad`, `min-dawn` resolve the recipe; a minimal configure warns on an over-featured SDL |
| BD-11 | L | fixed | Toolchain/checkout discovery duplicated 6+ times across build-*.ps1, development-tools.ts, package-demo.ps1 | tools/build-*.ps1 | `tools/bblite-tools.psm1` imported by the seven scripts; a test forbids re-spelled helpers |
| BD-12 | L | fixed | `static-no-dynapi.patch` in the overlay port dir but script-only; its edit invalidates the dev vcpkg stamp | native/vcpkg-overlay-ports/sdl3/, scene-command.ts:567-581 | moved to `tools/patches/sdl-static-no-dynapi.patch` (vcpkg's port ABI listed it, so an edit rebuilt sdl3 and sdl3-image) |
| BD-13 | L | open | FreeType ships unused font drivers (~123 KiB) in every UI demo | tetris map | overlay modules.cfg (unverified savings) |
| BD-14 | L | fixed | `BBLITE_PCH` defaults OFF under MINSIZE, costing ~1.2 s parse per TU per shipping build | CMakeLists.txt:1197-1201 | measured the other way: the precompile is a serial prefix that costs more than the parallel parses it saves (5.4 s vs 8.0 s wall); stays OFF, reason recorded |

## 9. Documentation

355 links resolve; every command, flag, environment variable, tool, patch, adaptation id, registry
field and number cited resolves to code except 18 stale items; ~45 lines restate each other between
features.md and fidelity.md; the physics contract is a measurement diary; docs/reviews accumulates
unread records.

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| DC-1 | H | open | Physics contract is a measurement diary (per-scene deltas, control counts, "still") | docs/fidelity.md:198-247 | mechanism sentences only; numbers to status |
| DC-2 | H | open | features.md and fidelity.md restate flow graphs, text, picking, node geometry, compressed textures, local cubemaps, animation managers (~45 lines) | docs digest D11-D20 | delete the fidelity restatements |
| DC-3 | M | open | Status coverage cells are unchecked prose; 18 rows disagree with the registry name | docs/status.md, verify-status.ts:58-69 | verify from the registry name |
| DC-4 | M | open | Nine canvas-only MAD values have no report artifact and no checker | docs/status.md:270-287 | write and verify `report-canvas.json` |
| DC-5 | M | open | Six wobble-exempt cells differ from the newest reports, undeclared | scene-neutrality.ts:152-168 | mark exempt cells; state the rule |
| DC-6 | M | open | Runtime-switch table misses 8 environment variables the binary reads | docs/debugging.md:113-131 | add rows |
| DC-7 | M | open | 10 checker scripts absent from the table | docs/debugging.md:73-87 | collapses with TL-1 |
| DC-8 | M | open | Build-switch facts on four pages; `BBLITE_HAS_TEXT` in features.md | ui.md:9, backends.md:68, features.md:412 | one table in development.md |
| DC-9 | M | open | Working rules duplicated between copilot-instructions and development/backends; the hygiene rule five times | development.md:40-42,53-54,69-70; backends.md:17,28-29 | keep in copilot-instructions |
| DC-10 | M | open | features.md "remain incomplete" tails (11) mirror TODO | docs/features.md | one link per section |
| DC-11 | M | open | docs/reviews accumulates unread records (7, +1 per PR); README says reviews live in PRs | verify-simplify.ts:140-142 | prune on merge; write the rule |
| DC-12 | M | open | Worker service design described twice | architecture.md:80-100, backends.md:66-83 | merge into backends |
| DC-13 | M | open | `native/CMakePresets.json` unreferenced and disagreeing with tool conventions | native/CMakePresets.json | document or delete |
| DC-14 | L | open | Hard-coded VS 18 CMake path as workspace setup | docs/development.md:18-22 | one sentence |
| DC-15 | L | open | Refusal message points at a README API list that does not exist | expressions.ts:3953 | point at features.md |
| DC-16 | L | open | Adaptation record text carries measurements into every fidelity.json | adaptations.ts:682-686 | mechanism only |
| DC-17 | L | open | Flow-graph block list uses invented names | docs/features.md:299-300 | the pin's `FgBlockType` names |
| DC-18 | L | open | Flags the docs' advice needs are unnamed | docs/debugging.md:26 | name them |
| DC-19 | L | open | "error84" | docs/debugging.md:79 | "Babylon error #84" |
| DC-20 | L | open | Colour rule undocumented; solver-delta commentary ×6 and "UI residual" ×9 inline | docs/status.md | one clause plus footnotes |
| DC-21 | L | open | Vestigial TODO section and README row | TODO.md:7-9, README.md:39 | delete |
| DC-22 | L | open | Dated diaries in code headers (scene-neutrality.ts 85 lines; verify-status, verify-simplify, asset-download-cache, capture-suite-reference; two PAL headers) | docs digest §3 | present-tense facts |
| DC-23 | L | open | 5 documented refusals not located; 14 reached without refusal wording | docs digest §5 | cite or soften |
| DC-24 | L | open | 11 undocumented refusals | docs digest §5 | one clause each |

## 10. TODO.md

Of 68 units (50 entries, 17 rows, 1 fact): 24 real as stated, 19 mis-stated, 4 done, 6 unreached,
4 not a task, 1 not measurable; 11 of 17 table rows carry qualifiers that name no code; open work
absent from it: the SDL trim (BD-1), the Win32 move/resize stall, text/post-process/flow-graph/asset
rows, five project-owned gates whose retirement conditions are met.

| Id | Sev | Status | Defect | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| TD-1 | H | open | TODO.md carries stale structure: a fact section, entries naming no code (`manager-delta sinks`, `result-shape registries`, pick-ray copies), unreached items (namespace imports, static-tuple `every`), 3 source comments citing entries that no longer exist | TODO.md, material-options.ts:539, scene-registry.ts:1538, output-projection.ts:446 | rewrite from the measured verdict table (90 lines) |
| TD-2 | H | open | Nullable string/number truthiness emits bare `has_value()` except through the localStorage flag; 33 trees declare `Nullable<std::string>` | data-lowering.ts:8330, web-storage.ts:96 | absent-or-empty / absent-or-zero; sweep the 33 trees |
| TD-3 | H | open | Frame yields nest `defer_start_continuation` lambdas (scene261 161 deep; 20 trees ≥2) | compiler.ts:20591 | counted requeue at the same drain |
| TD-4 | H | open | A PBR handle accepts Standard-only setters silently (`pbr.diffuseColor` emits the Standard field) | assignments.ts:21-33,2391-2394 | carry the family on each row |
| TD-5 | M | open | Post-process option kinds classified by a literal's field names | post-process-options.ts:385-407 | derive from the pinned interface |
| TD-6 | M | open | Image-codec list spelled seven times | image-codecs.ts:7-23, feature-activation.ts:2299, browser-texture-function.ts:664, CMakeLists.txt:36, vcpkg.json, package-demo.ps1, sdl3-image portfile | one manifest |
| TD-7 | M | fixed | Statement inventories missing for audio, clustered, atlas and VAT adapters | audio-lowerer.ts, clustered-light-*.ts, pinned-frame-atlas.ts, pinned-grid-atlas.ts, vat-lowerer.ts | inventories added for audio, VAT and both atlases; the clustered bodies are lowered instead (RD-7) |
| TD-8 | M | open | KTX1 container re-parsed and copied per mip at startup; KTX2 sampler enums hand-typed | basis-transcode.ts:248, compressed-texture-lowerer.ts:744-777, gltf-packager.ts:352-380 | sampler half fixed (`makeSampler` executed through the recorder and inverted through the pin's descriptor); mip-list half spans cli.ts, the glTF template and `CompressedMipLevel` in runtime.hpp (hunks in the recorder digest) |
| TD-9 | M | fixed | SPZ not bake-cached (280 ms vs 19 ms); no splat packaging collision check | splat-packager.ts:408-418 | SPZ framed as a cached capture keyed by container, pin and executed closure (scene123 compile 1.0 s to 0.4 s); the only unguarded collision is a 32-bit FNV clash of two sources in `compiler/assets.ts:550`, refusal hunk in the recorder digest |
| TD-10 | M | open | Five project-owned gates meet their own retirement conditions; one example never registered | scene-registry.ts:767,805,983,4307, examples/audit-gizmo-interaction.ts | retire |
| TD-11 | M | open | Backend items measured: `create_torus` emitted in 182 trees for 12 reaching; unversioned bone palettes; whole stylesheet re-projected per frame; per-draw eye offset; mesh triangles stored up to five times | mesh_factories emitter, pal_dawn.cpp:12907, pal_ui_rml.cpp:3306, pal_gpu_shared.hpp:626, pal_physics_bullet.cpp:157-2385 | per item |
| TD-12 | L | open | SDL Vulkan entry is not a task (compiled out, no defect recorded); SDL versions in lockstep | build-sdl-min.ps1:156 | delete the entry |

## 11. Housekeeping (local checkout, not repository content)

- 163 local branches merged into main; 53 unmerged codex/claude branches; 10 stashes; 41 worktrees
  (6 merged) under `C:/Dev/bbl-*` and `.claude/worktrees`. Deleting is the user's call.
- Orphan files: `docs/images/scenes/scene11-banner.png` (no reference); `reference/{morph-picking-standard,
  physics-drop,splat-update-picking}` and 14 `generated/` trees are outputs of fixtures and probes, not
  registry scenes; `test/fixtures/frame-graph-effect-only.ts` and `text-resource-ops.hpp` referenced by nothing.
- 37 GB of build trees (16.7 GB identical PCHs, 9.8 GB identical DLL copies); `.claude/worktrees/*/native` 28 GB.
