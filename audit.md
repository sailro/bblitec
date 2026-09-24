# Audit

Findings of the 2026-09-23 audit at main `8407fa11` (evidence cites that commit). Status: `fixed`,
`partial` (remaining step stated), `open`, `declined` (reason stated). Capability gaps are the Limits in
[features](docs/features.md) and [UI](docs/ui.md); [TODO](TODO.md) holds internal work, qualification
and performance.

## Feature activation (FA)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| FA-1 | high | Asset facts joined the feature list after compilation or were ORed at 7 consumers; adaptations ran first (scene226 lacked its splat adaptations). | `joinAssetFeatures()` runs before adaptations; one implication table; `projectFeatures()` renders sources for entries and workers; one `ActivationPlan`. | fixed |
| FA-2 | high | Transmission activated from reach/asset ORs and emitted-literal comparisons; 5 skybox-only trees compiled the transmission path. | Define from the composed refraction/thickness arms and scene reach; `setPbrSkybox` no longer reaches it; unpinned `transmissive`/`subsurface` options refuse. | fixed |
| FA-3 | med | The activation inventory re-derived 33 rows; 15 features had no reader, 8 claimed false readers. | Rows record the plan's reasons; a test checks every claimed reader. | fixed |
| FA-4 | med | Asset conditions restated from the pinned registry; GLBs parsed ≥5 times. | Each document parsed once; lights from the executed plan; `staticModules` removed; packaging records the id of every feature the pinned loader ran (`GltfMeshPlan.features`), and the specializer reads it and each planned mesh's topology instead of restating the registry triggers. | fixed |
| FA-5 | med | Macros have two owners and three guard styles with opposite defaults; no `-Wundef`. | One owner per macro (CMake for feature-keyed ones; `render_capabilities.hpp` in every tree for generator decisions), always 0/1; only `#if X` (native 560 `defined()` guards → 0; generated 2,094 → 0); `-Werror=undef` (clang-cl), `/we4668` (MSVC) on project units, which found two units reading a generator macro before its header. `BBLITE_HAS_SHADOWS` keys on the shadow generator list, checked by a test. | fixed |
| FA-6 | med | Camera/light gizmo factories and morph-shadow bounds emitted without reach. | `gizmo:camera`/`gizmo:light` and `shadow:morph-bounds` gate emission and native records. | fixed |
| FA-7 | low | `loadBabylon` reached `camera:free` with `loadCamera: false`. | Camera parser emitted only when cameras load. | fixed |
| FA-8 | low | Activation records embedded absolute checkout paths. | Repository-relative POSIX paths. | fixed |
| FA-9 | low | `ModelGeometry::morph_bounds` is compiled into every scene and cleared by every mesh builder. | `morph_bounds` and its release compile under `BBLITE_SHADOW_MORPH_BOUNDS`; builders clear it only when `shadow:morph-bounds` is reached. | fixed |
| FA-10 | low | The transmission/thickness slot pair follows the renderer define, so a translucency-only scene compiles the grab machinery (scene26). | Each map slot keys on its own composed binding; scene26 drops the transmission renderer. | fixed |
| FA-11 | low | Native test fixtures compile with ad-hoc `/D` flags and harness defaults, without the undefined-macro check. | The harness renders fixture macros as headers from the one table, states its build options, makes third-party headers external and compiles with `/we4668` (`-Werror=undef` under clang-cl). | fixed |
| FA-12 | med | CMake re-derives feature→macro for 58 macros the activation plan already decides, and a test greps CMakeLists to keep them in sync. | `src/feature-macros.ts` decides every feature-keyed macro from the final feature list into its own generated `bblite/features/<name>.hpp`, included by each file testing it; CMake keeps source/link selection and build options; tests cover the headers and each file's includes. | fixed |

## Re-derivation in TypeScript (RDT)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| RDT-1 | high | 1,362 AST-shape assertions guarded hand-written C++ transcriptions of pinned bodies. | Every family is lowered from the pin: camera, sprite/billboard writers and sorts, grid atlas, pick helpers, animation mixer/tracks, mesh bounds, tube/extrude, VAT, glTF light direction, clustered lights, text data (the pin's record graph over `PinnedRecordModel`), Sprite2D Y-sort, Havok floating origin and the device-loss coordinator; their guards are gone. The text renderable/renderer factories are RDN-3. | fixed |
| RDT-2 | high | Pinned functions hand-copied though lowered elsewhere (camera clamp/inertia, `evaluate_track`, grid atlas, `expandWorldAabbForMesh`, mesh bounds). | All use the lowered versions. | fixed |
| RDT-3 | high | Hand copies without a lowered version (clustered lights, free-camera yaw/pitch, VAT, glTF light direction, mixer, tube/extrude, HDR prefilter setup, Draco/basisu routing). | HDR prefilter setup executes the pinned cube chain; Draco decodes through the executed pinned pre-mesh hook; KHR_texture_basisu routes through the executed pinned extension. | fixed |
| RDT-4 | high | Behaviour keyed on mesh names starting with `wheel`. | Declined for now: removing it sinks the racer body (imported positions are offsets over baked worlds). Needs imported node-local transforms, a parent-world matrix and parent×local composition first. | open |
| RDT-5 | med | Pinned WGSL rewritten by regex onto flattened uniform layouts. | Keep pinned structs/bindings; remap by compaction; pinned UBO writers. | open |
| RDT-6 | med | Composed WGSL read back with ~20 regexes. | Typed WGSL reflection (`shader-ir.ts`, `wgsl-layout.ts`). | fixed |
| RDT-7 | med | Regex/spelling checks over pinned TS and packaged JS. | AST readers and one specifier rewriter; the last sites (tone-map scale through the WGSL IR, blend-export family, lite-error import, clearcoat remap bit, skybox condition, export index, async stripping) read syntax. Tint HLSL/MSL rewriting is RDT-15. | fixed |
| RDT-8 | med | `assertPinnedShaderFormulas` guarded formulas no longer copied. | Deleted with its flags. | fixed |
| RDT-9 | med | `shader-ir.ts` regex raw-module fallback; user WGSL constant rewritten by regex. | Full typed WGSL front end; raw path deleted. | fixed |
| RDT-10 | low | Plugin `getCustomCode` had its own evaluator. | Shares the pinned shader-text folding. | fixed |
| RDT-11 | low | Pinned defaults copied into tables and checked. | Material, billboard, post-process and navigation defaults read or emitted from the pin. | fixed |
| RDT-12 | low | Hand SDL blit, stale comment, predeclared shader programs. | Comment fixed; `setAlphaToCoverage` takes any reached shader-material program and the predeclared table is deleted; the copy blit is the pin's copy-task shader, on both backends. | fixed |
| RDT-13 | low | Grid material and sprite-grid absent-arm defaults are literals (`material-options.ts`, `material.ts`, `intrinsics/sprite.ts`); the node-particle Sprite2D bridge relies on header defaults. | Factory `??` defaults read from the pin (`pinned-factory-defaults.ts`); the grid atlas carries a presence flag per optional member; the Sprite2D bridge fills every layer member. | fixed |
| RDT-14 | med | The clustered-light refresh uses a hand dirty key (view/projection equality, `topologyDirty` bound true) and matches generic JS by source text in its statement hook. | The refresh is lowered whole with the pin's dirty key and a generated `ClusteredRefreshState`; array operations live in the shared lowerer; platform calls resolve by declaration; uploads follow the pin's writes. | fixed |
| RDT-15 | med | `shader-bindings.ts` rewrites Tint HLSL/MSL with ~40 regexes (register compaction to SDL spaces, combined samplers, SV_Position order, discard→clip, MSL buffer indices). | Emit SDL layouts from a Tint-linked generator and delete the rewrites. | open |

## Re-derivation in native code (RDN)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| RDN-1 | high | The PAL bakes TRS into vertices and re-picks each draw's world matrix instead of uploading the pin's `worldMatrix`. | Feed generated `MeshUniforms.world`; upload local vertices. | open |
| RDN-2 | high | Camera input dispatch diverged from the pinned handlers. | Handlers and key map lowered; real frame delta; SDL only translates events. | fixed |
| RDN-3 | med | Camera/billboard/sprite/text templates transcribed pinned formulas. | Camera, billboard, sprite and text data lowered. Remaining: the text renderable and renderer factories (`text-lowerer.ts`, `text-renderer-lowerer.ts`, 35 + 39 guards) and the GPU writers' selector guards. | partial |
| RDN-4 | med | 61 record defaults copied or invented pinned values. | Option structs written whole by generation carry none; records zeroed; render tasks without `clrColor` (the default task included) clear to the scene's live colour; a scene without a camera clears and draws through a zero scene block and skips what the pin skips; glTF projection writes each absent key's pinned default. Remaining: `create_pbr_material` and the `set_pbr_*` setters still rely on `MaterialRecord` initializers, and an absent clearcoat/sheen/iridescence layer is encoded as zero intensity. | partial |
| RDN-5 | med | Invented environment fallback face. | Measured unused; zero cube bound. | fixed |
| RDN-6 | med | Render bucket rule lacked the pin's opacity/blend arms. | Bucket from the pinned `isTransparent` predicates (fixtures: 0.373 → 0.000, 0.121 → 0.000). | fixed |
| RDN-7 | med | Small pinned functions hand-copied. | Generated from the pin, including `pack_morph_deltas` (`morph_targets.hpp` from `createMorphTargets`). | fixed |
| RDN-8 | med | Pick orchestration restated per backend. | Shared preparation, clears and decode; lowered pointer mapping. | fixed |
| RDN-9 | low | UI composite WGSL duplicated. | One compositor per backend. | fixed |
| RDN-10 | low | Dawn hand-writes bind-group layouts. | One keyed layout cache; sprite UBO size from the generated writer. Remaining: layouts from `.slots`/reflection. | partial |
| RDN-11 | low | Recast wrapper defaults copied without version provenance. | Emitted from the pinned wrapper packages, whose versions are recorded. | fixed |
| RDN-12 | low | The Recast wrapper's query half-extents, generator config transforms and 2048-node path query are hand ports (`pal_navigation_recast.cpp`). | Query half-extents and the 2048-node pool are emitted from the pinned wrapper and read by every search. Each generator's build-config step (`generateSoloNavMeshData`/`generateTileCache`: region areas squared, detail sampling in cells, tile grid, padded tile extent) is lowered from the installed generators package into the generated navigation header and handed to the PAL over `NavRcConfig`; the hand port is deleted. | fixed |
| RDN-13 | low | The pin sorts sprite `_layers` in place; native builds a fresh permutation each frame, so ties after an order change differ. | Stable in-place sort. | open |
| RDN-14 | low | Billboard sorting under a floating origin and Sprite2D pivots use float where the pin uses numbers (205/206 identical today). | Double lanes. | open |
| RDN-15 | low | `update_surface_cameras` gives every scene the primary frame delta, wrong for a scene with its own `fixedDeltaMs`. | Per-scene delta. | open |
| RDN-16 | low | Property-animation records store float lanes (`animation-records.hpp`). | Group times, speed, weights, fades and clip rates are double end to end; key times, values, samples and blend buckets stay float where the pin stores into a Float32Array. | fixed |
| RDN-17 | med | Mesh removal leaves physics node poses, property-animation targets, light include/exclude lists, shadow casters, render-task mesh lists and node-material groups naming the mesh; the pin prunes render tasks and material groups and clears `parent`. | Lower the pin's removal pruning. | open |
| RDN-18 | low | A camera-less overlay or utility layer projects through the base camera on Dawn and the SDL_GPU swapchain overlay, and through none on SDL_GPU graph layers; the pin uses each layer's `cfg.cam ?? scene.camera`. | Align both backends on the pin. | open |
| RDN-19 | low | Animation seek harness and glTF group operations (`set_animation_current_time`, `set_animation_speed_ratio`, `go_to_frame`, additive setters) take float where the pin passes numbers. | Double parameters. | open |
| RDN-20 | med | The camera-less pass contract is ~26 `if (camera)` arms per backend, and render-task-base's `cfg.cam ?? scene.camera` / `cfg.clrColor ?? sc.clearColor` resolution is transcribed in each backend. | Lower the pass resolution once into an `upstream::` function; one shared pass-camera builder yielding the zero block; lowered pinned early returns do the per-renderable skips. | open |
| RDN-21 | med | Tile-cache builds defaulted `expectedLayersPerTile` to the wrapper's 4; the pinned `_createNavMeshFromMerged` resolves `?? 1` first. | `createNavMesh` emits the pinned default read from the module; the PAL requires the key. | fixed |
| RDN-22 | low | The PAL threw on a refused obstacle add, leaving the generated null check dead. | The PAL returns an empty optional and the generated layer refuses. | fixed |
| RDN-23 | low | Arithmetic the generators hand to Detour after the config step is hand-ported in the PAL: solo `NavMeshCreateParams` walkable values and `buildBvTree`, tile-cache params and `maxTiles`, the tile/poly bit split (`dtIlog2`/`dtNextPow2`), `NavMeshParams.tileWidth`, `getBoundingBox` and `createRcConfig`'s spread. | `navigation-build-plan.ts` lowers every number the generators hand Recast/Detour from the installed packages (bounds, `createRcConfig` over the resolved spreads, build-config steps, the Detour parameter records, the tile/poly bit split, per-tile config and allocator sizes); the PAL keeps only the library calls; `computePath` capacities come from core. | fixed |
| RDN-24 | low | Tile-cache builds silently dropped off-mesh connections; a build without `tileSize` refused though the pin defaults it to 32. | Off-mesh connections on a tile cache refuse; `tileSize ?? 32` is the pin's. | fixed |
| RDN-25 | low | The PAL hand-ports JavaScript that runs over library data: the solo generator's poly area/flag normalization, `createDefaultTileCacheMeshProcess`, `setOffMeshConnections` packing and defaults, and `createDebugNavMeshGeometry`. | Lower each from its package or pinned body. | open |
| RDN-26 | med | The native clustered factories (`create_clustered_point_light`, spot and siblings) are hand-written. | Lower the pinned factory bodies. | open |
| RDN-27 | low | The clustered refresh identifies its camera by `CameraRecord*`; the packer passes `srcStrideBytes ?? width * 4` as a `0u` sentinel. | Handle identity; an optional stride. | open |
| RDN-28 | low | `begin_device_recovery` restates the pin's context-kind check with its own message. | Lower `assertEveryActiveContextKindIsRecoverable`. | open |

## Compiler core (CC)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| CC-1 | high | Nullable resource kinds classified by bare type name. | Declaration-origin checks; user `class Mesh`/`interface Material` compile. | fixed |
| CC-2 | high | `compiler.ts` holds 18.7k lines behind a 437-member interface. | `SceneManifestRecorder`, `BindingScopes`, `ConditionLowerer`, browser predicates in `BrowserErasure`, `DeclarationLowerer` and `PropertyAccessLowerer` own their slices behind narrow contexts (19,183 → 10,725 lines; 448 → 349 service members; output identical). Remaining: closures, async/lifecycle, option adapters, the native-emission registry, assets and the `note*` admissions. | partial |
| CC-3 | high | Minecraft save/load matched by path regex and replaced by native code. | Pinned save/load lowers from its own source; the path regex and `js_voxel_file.hpp` are deleted. Missing File System Access pickers read as `undefined`; `new Promise` outside a realm (escaping resolve; still-pending ends the awaiting function); FileReader and file-input `onchange`; parsed documents stay dynamic through record-typed returns. | fixed |
| CC-4 | high | Pinned lowerers diverged from JS semantics; folding written 7 times. | One operator module; `<<`, `^`, `\|0` via `bbl::js`; comparisons shared; pinned and scene-code `Math.max/min` lower through one `math_extreme` at any arity (float writer lanes `math_extreme_lane`; camera controls included); pinned Uint32Array stores use `to_uint32`. | fixed |
| CC-5 | med | Library-global recognition has 4 spellings. | One `libraryGlobal()` at every site, window-qualified timers lower as the bare calls (quake's `clearTimeout` was dropped), and `isGlobalUndefined`/`isNullishLiteral` replace every hand `undefined` check. | fixed |
| CC-6 | med | Declaration origin decided 8 ways. | One `declarationOrigin()`. | fixed |
| CC-7 | med | Nullable-union rule had no owner. | `presentMembers()`/`nullability()`. | fixed |
| CC-8 | med | Class members found by name in ≥12 loops. | One `ClassMemberTable` per class, linked to its base (`class-members.ts`); inheritance, mutable statics, static blocks and brand checks lower through it; no name loop remains. | fixed |
| CC-9 | med | String and presence facts spelled per site. | Presence through `presenceFlagCpp`/`presenceCpp`, truthiness through `truthinessCondition`; three truthiness/presence bugs fixed with tests. | fixed |
| CC-10 | med | Methods inlined at every call; constant tables wrapped each element. | Tables emit typed literals (tetris `renderer.cpp` 1.96 → 0.83 MB). Method sharing is blocked by `canShareFunctionBody` refusals (function-typed parameters, retained-canvas reads). | partial |
| CC-11 | low | Raw symbol lookups bypass `valueSymbol`. | `declaredSymbol` (65) and `resolvedSymbol` (24) replace every raw lookup in `src/compiler/**` as of their merge; two imported-name fixes with tests. Streams merged later reintroduced some (CC-20). | fixed |
| CC-12 | low | Truthiness/comparison lowering split three ways. | `comparisons.ts` owns operators, folds, boolean comparisons and `instanceof`; `ConditionLowerer` owns conditions, and the static evaluator and data lowerer reach it directly. | fixed |
| CC-13 | low | Literal `renderCanvas` id, silent GitHub asset fallback, `offsetX` as `clientX`. | Canvas keyed on `createEngine`; `--public-url` or refusal; offsets recorded as an adaptation. | fixed |
| CC-14 | high | Silent miscompiles: static blocks dropped, `Object.assign` on handles erased, embedded NUL truncated. | Static blocks and handle `Object.assign` refuse; NUL-containing strings keep their length. | fixed |
| CC-15 | high | `??=` onto a nullable class reference emitted nothing. | Presence-guarded store. | fixed |
| CC-16 | med | Lazy singletons (`let c: C \| null = null; c = new C()`) refused. | Rebound locals store their declared type. | fixed |
| CC-17 | low | `lookupIdentifierValue` restates `bindings.lookupOptional` (55 callers), and 11 context interfaces redeclare `bindings` because two folds narrow it to lookups. | `bindings.lookupOptional` is the one lookup (51 callers moved); the two narrowing folds take a `StaticFoldContext`, so no context redeclares `bindings`. | fixed |
| CC-18 | med | Colour-shape refusals (DEAD-13) are placed per site; the compiler never reads TypeScript assignability diagnostics, which would refuse every off-API object shape at once. | One contextual-type colour decision (`requireObjectColour`); a program-wide refusal on type errors was measured (2 corpus sites vs 581 test `createEngine({})` errors and a newer-pin application) and not adopted. | fixed |
| CC-19 | med | Presence is lost after the first `?.` in a chain: `found?.position.y` reads through the optional unchecked, and `if (found?.position.y)` tests the value, not presence. | A presence rule for the whole chain and a guarded binding. | open |
| CC-20 | low | Raw `getSymbolAtLocation` reads: 10 reintroduced in `src/compiler` by streams merged after CC-11 (`async.ts`, `class-members.ts`, `classes.ts`, `data-types.ts`, `executed-application-function.ts`, `pending-activations.ts`) and 7 outside it (`api-usage.ts`, `api-surface.ts`, `pinned-csm.ts`). | Route each through `declaredSymbol`/`resolvedSymbol`. | open |
| CC-21 | low | Plain-data functions that reach the engine were emitted standalone and did not compile; `on…` handler properties on UI elements were silently dropped. | They stay inline; handler properties refuse (file-input `onchange` lowers). | fixed |
| CC-22 | low | `File.text()` copies raw bytes without UTF-8 decoding or BOM removal (FileReader decodes); `typeof reader.result` is `"undefined"` where the browser says `"object"`. | Share FileReader's decoding; distinct null storage. | open |
| CC-23 | low | Once a program reaches a `new Promise`, the check for stored or callback uses of waiting functions scans the whole program and could refuse unreached code. | Scope the scan to reached code. | open |
| CC-24 | med | A shared call is evaluated ahead of earlier operands that read state it changes (`"x" + count + reg()` gives "x22", JS "x12"). | Preserve JavaScript evaluation order around shared calls. | open |
| CC-25 | med | A `Map.forEach` callback that invokes callbacks stored on class instances exhausts compiler memory. | Bound the reach analysis. | open |
| CC-26 | low | `Array.pop()` on an empty array throws natively; JavaScript returns `undefined`. | Return the absent value. | open |
| CC-27 | med | Recursion through stored instances (a tree's `sum()` over `children`) refuses; it needs the method emitted as a native function over its receiver. | Emit recursive methods over stored receivers. | open |
| CC-28 | low | Callbacks that call an abstract method are inlined instead of shared (the abstract declaration has no body). | Treat abstract dispatch as shareable. | open |

## Lowering layer (LW)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| LW-1 | high | Restated pinned strings and ~35k lines of C++ template text. | Same programme as RDT-1, which is lowered; remaining template text is the text renderable/renderer factories (RDN-3). | partial |
| LW-2 | high | Eight overlapping evaluators of pinned TypeScript. | One folding core; one checked TypeScript program over the pinned sources (`pinned-program.ts`) through which lowerers resolve names and types (identifier-spelled lookups 18 → 0); `PinnedReferenceLowerer` retired. | fixed |
| LW-3 | high | Seven generation-time execution mechanisms; Chromium per bake; JSON passes in children. | In-process JSON passes; one shared Chromium per generation (68 bakes on 35 browsers). | fixed |
| LW-4 | med | WGSL structs parsed by regex; two layout tables. | `reflectWgslStruct` and one `wgsl-layout.ts`. | fixed |
| LW-5 | med | Shader-text builders re-interpreted by an 880-line evaluator. | Pinned builders and fragments (defines prelude, PBR vertex template, morph/instance/skeleton) are executed; application shader builders and plugin `getCustomCode` run at generation over the declarations they reach (`executed-application-function.ts`); the 920-line evaluator is deleted. | fixed |
| LW-6 | med | Private per-family attribute tables, walkers, UBO writers, sorts. | Shared emitters and readers; writers and sorts lowered. | fixed |
| LW-7 | med | Feature→source mapping stated twice. | The table owns emission. | fixed |
| LW-8 | med | Regex/text scans where AST helpers exist. | AST helpers. | fixed |
| LW-9 | med | Pinned constants read 7 ways. | Public `pinnedConstant` family. | fixed |
| LW-10 | low | Dead lowering exports. | Deleted. | fixed |
| LW-11 | med | Pinned UBO-writer, glTF-leaf and SH-prescale scopes compute in float (`math_extreme_lane`, `scalarPrecision`, the deduced width) where the pin computes in double and rounds at the Float32Array store. | Compute every pinned numeric scope in double and convert at the typed-array sink; delete the width options. | open |
| LW-12 | low | About 12 modules outside `src/lowering` still build their own `new LoweringContext(sharedUpstreamStore())` instead of `sharedPinnedContext()`. | Use the shared context. | open |

## Native PAL (NT)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| NT-1 | high | Two near-copy UI compositors per backend. | One compositor per backend (−1,152 lines). | fixed |
| NT-2 | med | `pal_gpu_shared.hpp` is a 6,476-line header with ≥15 concerns. | Split by concern; non-template bodies in one unit. | open |
| NT-3 | med | One Dawn layout-cache set per material family. | One keyed layout cache. | fixed |
| NT-4 | med | Feature families written twice inside two monoliths. | Paired family units, then shared orchestration. | open |
| NT-5 | low | Enum mappings duplicated within each backend. | One formats header per backend. | fixed |
| NT-6 | low | Standalone Run classes repeat phase boilerplate. | `RendererRun<Derived>`. | fixed |
| NT-7 | high | Dawn/LabSound patch changes neither rebuilt nor refused installs. | Dawn, LabSound, RmlUi and trimmed-SDL artifacts record their source and ordered patch digests; configure refuses a differing record and `dev:setup` rebuilds it. | fixed |
| NT-8 | med | Patches in 3 places, 5 mechanisms, no inventory. | `native/patches/manifest.json` lists all 50 patches over 7 libraries; builders apply them one way; `patches:check` (in `lint`, and doctor) fails on orphans, headers, order, pins and consumers. | fixed |
| NT-9 | med | RmlUi order by `zz` prefixes; zero-context hunks. | RmlUi patches renumbered in effective order with 3-line context; the old and new series produce byte-identical trees. | fixed |
| NT-10 | low | Patches lack purpose headers; stale upstream notes. | Every owned patch opens with a purpose header mirrored in the manifest; upstream states corrected. | fixed |
| NT-11 | low | Single-backend builds deployed both backends' shaders. | Deploy and payload checks filter by compiled backend. | fixed |
| NT-12 | low | 8-way backend `#if` matrix. | `pal_gpu_dispatch.hpp` table. | fixed |
| NT-13 | med | `synchronize()`'s internal order (overlay refresh, rematch, draw lists, plan-mesh sync, storage publication, submit, camera update) is written per backend and still differs (storage publication). | A shared `synchronize_scene<Backend>` in the frame conductor owning the order, with backend hooks (with NT-4). | open |
| NT-14 | med | The patch record is computed three times (TypeScript, CMake, PowerShell); vcpkg portfiles restate PATCHES lists a regex parser reconciles; builders' variant choice is re-derived by verifiers. | `patch-identity.cmake` is the one reader of the patch series (configure, portfiles, builders, doctor); artifacts record `_VARIANTS`; `portfilePatches` and the TypeScript/PowerShell copies are deleted. | fixed |
| NT-15 | low | Three Dawn invalid-handle checks raise `GpuTransportError` (reaching the device-recovery listeners) where the SDL_GPU equivalents raise `std::runtime_error`. | One classification for an invalid handle on both backends. | open |

## Generated C++ (GC)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| GC-1 | high | Mesh/geometry records append-only (doom tape: 178 → 4,924). | Retired slots are reused under mesh-handle generations (doom 179 records for 178 entries; minecraft 474 for a 474 peak); the memory gate judges occupied records against the meshes the scene draws (doom 178 for 178, tetris 46 for 46, minecraft 455 for 455). Remaining: loader, hierarchy-listed and transform-node records keep their slots. | partial |
| GC-2 | high | The memory gate ran idle and watched only working set. | Gameplay tapes, record-growth and slope gates. | fixed |
| GC-3 | med | `.clang-tidy` enabled 17 checks. | Empty-catch, throwing-static-initialization, unchecked-optional-access and member-init are enabled: empty source handlers are dropped or name their discard, allocating generated constants are function-local statics, the Havok event methods receive the checked context; CheckMain is on. | fixed |
| GC-4 | med | Generated code indexes records directly (850 sites), so a handle kept past its mesh's retirement reaches the slot's next mesh. | Every generated access goes through `recordAt` → `bbl::handle_at` (registry: 24,699 direct sites → 0); bounds and the mesh generation are checked in every build (≤0.6% of a cold frame), so a retired mesh's handle throws. The check found an SDL_GPU sync of the previous plan after mesh retirement, now fixed. | fixed |
| GC-5 | med | Every `Array<T>` registered a GC node. | Records declare `gc_trace_edges` only when a field can own a traced edge; `make_ref`/`make_gc_shared` register only traceable payloads (doom 11.9M → 209k GC allocations after warm-up). Remaining: closure bodies always register (GC-21). | fixed |
| GC-6 | low | 623 loops count with `double`. | Canonical counted loops count in `std::int64_t` and convert at each read (666 of 728 loops). | fixed |
| GC-7 | low | Constant tables wrapped every element. | Typed literals and element-typed tables. | fixed |
| GC-8 | low | Asset lookup inline per fetch site. | One table per asset set. | fixed |
| GC-9 | low | Uninitialised generated locals and scalar fields. | Value-initialised. | fixed |
| GC-10 | low | Most application code stays in `main.cpp`; tuple environments of arity 114. | Blocked with CC-10. | open |
| GC-11 | low | MSVC suppressed C4702 for generated units. | Fallthrough proof; `/wd4702` removed (10 apps build with MSVC). | fixed |
| GC-12 | med | A `switch` over a temporary string bound a dangling `string_view`. | Storage bound before the view. | fixed |
| GC-13 | low | Collection `forEach` copies were `const auto`, rejected by clang-cl `/WX`. | Non-const copies. | fixed |
| GC-14 | low | `float32Literal` rounds through double first; a midpoint can differ from `Math.fround` (`cpp-literals.ts`). | `float32Literal` and `floatLiteral` spell a float32-midpoint double as `Math.fround` stores it; table literals defer to them. | fixed |
| GC-15 | low | Generated `main` catches only `std::exception`. | Generated `main`, the Window application and platform entries report every escape through `bbl::report_uncaught_error`. | fixed |
| GC-16 | med | Physics node refs, property-animation targets, animated-mesh bindings and light include/exclude lists name a mesh by slot without its generation (`mesh_slot_handle` stopgap), so the retired-mesh check cannot see them. | Store `MeshHandle`s. | open |
| GC-17 | low | `runtime.hpp` still indexes records by `.value` in render-task, material and animation helpers. | `runtime.hpp` render-task, material, asset, storage-buffer and CSM helpers go through `handle_at`/`handle_find` (one shared validity predicate); the slot allocator stays raw. | fixed |
| GC-18 | med | `handle_at` checks a generation only when the handle type carries one, so slot-only references (`PhysicsNodeRef`, `mesh_slot_handle` callers) pass unchecked and retirement scans child lists to protect them. | Store `MeshHandle`s (a variant for physics nodes), make a generation-carrying table reject generation-less handles at compile time, delete `mesh_slot_handle`. | open |
| GC-19 | low | Slot reuse waits on `composition_feature_rows_initialized`, and `composition_feature_mesh` falls back to the creation ordinal, because composition rows have two identities. | Assign the row in `store_mesh_record` (clones take their source's). | open |
| GC-20 | med | MSVC builds of generated trees fail on C4244 conversions: a `float`-parameter callback through `std::function<void(double)>` (scene303), `build_view_matrix` storing doubles into floats (renderer_plan), `size_t`/`uint64_t` to double (scene164). | Emit explicit conversions or matching types. | open |
| GC-21 | low | Closure bodies always register with the cycle collector (doom's remaining 209k allocations); gating them on traceable captures tripped a clang-analyzer `NewDeleteLeaks` false positive. | Register only closures whose captures can own an edge. | open |

## Dead code (DEAD)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| DEAD-1 | med | Functions and a file used only by their tests. | Deleted or moved to test helpers. | fixed |
| DEAD-2 | med | Exported functions referenced nowhere. | Deleted. | fixed |
| DEAD-3 | med | Goldens/previews of deregistered scenes; unregistered example. | Deleted. | fixed |
| DEAD-4 | med | 12 unused test fixtures. | Deleted (13 with a second unwired compute check). | fixed |
| DEAD-5 | low | Unreferenced native functions and CMake options. | Deleted. | fixed |
| DEAD-6 | low | Native symbols only fixtures called. | Fixtures use product API; release-accounting hooks kept. | fixed |
| DEAD-7 | low | Legacy `classStyles` spelling. | Migrated and deleted. | fixed |
| DEAD-8 | low | Self-described "legacy" compiler paths. | Measured: all reached by scenes or tests. | declined |
| DEAD-9 | low | 258 exports used only in their own file. | Drop exports; `ts-prune -u`. | open |
| DEAD-10 | low | Unused parameters, duplicated helpers, silently passing tests. | Fixed; the tooling `isRecord` copy stays (importing it would load TypeScript into `scene show`). | fixed |
| DEAD-11 | low | Scene PBR manifest `transmission`, `ior` and `thickness` fields are written and never read. | Writer and type fields deleted; only the 35 PBR manifests moved. | fixed |
| DEAD-12 | low | `PrimitiveKind` box/ground/sphere/torus are unused and `MeshRecord::dimensions` is never written (`runtime.hpp`). | The four kinds and `dimensions` deleted; the default camera skips a mesh without bounds, as the pin does. | fixed |
| DEAD-13 | low | Object colour inputs (`{r,g,b,a}` baseColorFactor, `{r,g,b}` diffuseColor) are not pinned API; only a test reaches them. | `{r,g,b}` and `{r,g,b,a}` refuse wherever the pin types a number tuple (every Color3 site, `baseColorFactor`); Color4 objects stay where pinned (clear colours, lines). | fixed |
| DEAD-14 | low | `PrimitiveKind` decides default-camera framing and normal mirroring, standing in for the pin's bounds presence. | Record bounds presence where the pin sets it and read that. | open |

## Documentation (DOC)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| DOC-1 | high | Most TODO entries restated Limits owned by features/ui. | Limits own capability gaps; TODO holds internal work (1,477 → ~480 words). | fixed |
| DOC-2 | high | ~20 code comments cited removed doc/TODO text. | Pointers replaced by facts or deleted. | fixed |
| DOC-3 | high | 32 facts stated in 2-5 documents. | One owner each. | fixed |
| DOC-4 | med | 10 wrong facts. | Corrected. | fixed |
| DOC-5 | med | TODO bundles, wrong owners, done items. | Single-line tasks with owners. | fixed |
| DOC-6 | low | Status repeated one physics note 8 times. | One intro sentence. | fixed |

## Tooling and CLI (TL)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| TL-1 | high | `clean --artifacts` deleted 10 live artifact roots. | One `ARTIFACT_ROOTS` table shared by writers and clean, with a test. | fixed |
| TL-2 | med | 8 of 25 scene commands restated others. | 21 commands; parity measures both backends by default. | fixed |
| TL-3 | med | Four sizing tools. | `scene -- survey`. | fixed |
| TL-4 | med | PowerShell packaging re-implements TypeScript helpers. | Desktop packaging is `src/package-demo.ts`; staging, archive, receipts, publication and notices are shared TypeScript modules the Android/iOS scripts call. | fixed |
| TL-5 | med | Tools import `dist/src` unchecked. | `tsconfig.tools.json` (strict + `checkJs`) checks tools/ and checks/plugins/ at 0 errors through `npm run lint:tools` (part of `lint`); the build emits declarations; the import-name test is subsumed and deleted. Remaining: the three `checks/plugins/*.init.js` browser scripts (TL-24). | fixed |
| TL-6 | med | Backend names and `--exe` accepted inconsistently. | One backend parser; `BBLITE_NATIVE_EXE` for every measuring command. | fixed |
| TL-7 | med | Seek handled 3 ways; `parity --seek` could overwrite a golden. | One pose resolver; seeks are diagnostic. | fixed |
| TL-8 | med | `geometry` used weaker staleness and regex task discovery. | Capture provenance and configured output; tasks from the manifest's `copyTasks`. | fixed |
| TL-9 | low | Two JSON report writers. | One record module. | fixed |
| TL-10 | low | Help/parser/doc drift. | Shared flag specs; generated usage. | fixed |
| TL-11 | low | Dead entry points and aliases. | Deleted. | fixed |
| TL-12 | low | Duplicated walkers and runners. | Walkers, runners and the record writer shared in `tooling/`; `validation-resume.ts` deleted. | fixed |
| TL-13 | low | `parity`/`check` wait forever on a Window host in a locked console session (offscreen 905 s, ocean 8,830 s). | Window-host runs without their own limit are killed after 120 s + 50 ms per frame; the timeout names the locked session. | fixed |
| TL-14 | low | `check scene149` fails 1/28 at main (the pin's live resize did not throw #84); scene149 and break-meshes-60 browser observations are stale. | The check reads the error codes the pinned `buildResolvePath` throws (1.31 renumbered #84 to #86); break-meshes-60/240/live, scene149, scene180, scene46 and scene47 re-observed; all pass on both backends. | fixed |
| TL-15 | low | Package `.staging/` folders accumulate. | A published run removes its staging folder; a failed one keeps it. | fixed |
| TL-16 | low | The memory gate's slope test trips on a single allocation step (quake SDL_GPU once; minecraft while its records stay flat). | Theil–Sen slope over the whole window and its later half; minecraft is flat at 18,000 frames. | fixed |
| TL-17 | low | Window-host runs are bounded by a tool timeout; the native frame clock already sees the occluded or timed-out present and retries forever. | A bounded run fails after 30 s without a compositor tick, naming the status; the tool timeout is gone. | fixed |
| TL-18 | med | 18 test files slice `pal_sdl_gpu.cpp`/`pal_dawn.cpp` as text and stub what the slice needs (the camera is non-null), so the camera-less arms are never run by a harness. | Link harnesses against extracted shared stage units (after RDN-20/NT-13). | open |
| TL-19 | low | `build-labsound.ps1` and `build-rmlui.ps1` reset their checkout and re-apply patches on every `demos:release`, recompiling everything (build-sdl-min now records its applied series). | `Sync-PatchedCheckout` serves every builder; warm runs compile 0 units (RmlUi 203 → 0). | fixed |
| TL-20 | med | `window-input-order` is timing-dependent: it passes alone and fails under machine load (2 of 4 runs at one head). | Drive the fixture's frame clock and presentation deterministically. | open |
| TL-21 | low | scene181 cannot be observed: its golden (2026-09-08) differs from the current Chrome only at the textarea resize grip. | Recapture the golden with provenance, then observe. | open |
| TL-22 | low | `check scene149-transport` fails ("Generated source differs from browser source"): its inputs were captured at pin 1.27 by an observer the repository does not contain. | Capture them with repository tooling at the current pin. | open |
| TL-23 | med | `check scene261-live` fails: the "moving" capture describes frame 161 where the phase asked for 35, and the input tape does not move the camera. | Fix the native frame timing / input replay. | open |
| TL-24 | low | The three `checks/plugins/*.init.js` browser scripts are not type-checked (40 errors). | A browser tsconfig (DOM + WebGPU types, declared globals) in `lint:tools`. | open |
| TL-25 | low | Window-host applications (offscreen, ocean) print no `[mem][frame]` samples, so `memory all` reports them unmeasured; `lint:cpp` does not refuse a build whose PCH is older than its headers. | Sample memory on the Window host; check PCH freshness. | open |

## Building (BD)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| BD-1 | high | Each native edit recreated every scene's build tree (short ninja path). | Tool paths compare by final spelling. | fixed |
| BD-2 | high | Emission transactions deep-copied compiler state (72.7% of quake generation). | A transaction is a mark in one undo journal: journaled maps/sets/arrays/records, `@journaled` fields, readonly state types written through `writable()`; the walking capture is deleted (walk-as-oracle: 0 mismatches). Transaction self time quake 9.7 → 2.7 s, minecraft survey 9.4 → 0.9 s, antigravity 366 → 59 s; generation CPU −36…−76%. | fixed |
| BD-3 | med | Largest apps generated last. | Ordered by recorded cost. | fixed |
| BD-4 | high | `demos:release` on Windows failed since 2026-09-18. | Array-preserving parallel arguments. | fixed |
| BD-5 | med | ccache full and path-keyed per worktree. | `base_dir`, 25 GiB. | fixed |
| BD-6 | med | No PCH under ccache. | Clang PCH with cache sloppiness. | fixed |
| BD-7 | med | Every unit receives all feature macros; header folder keyed on all headers. | Units read only the macro headers they include; under the object cache each repository unit reads a content-addressed folder of its include closure's generated headers. quake: a `render_capabilities.hpp` edit rebuilds 3 units (was 33), an unread macro flip 0 (was 41). | fixed |
| BD-8 | med | Backend units compile once per scene shape. | Capability-independent code in shared units. | open |
| BD-9 | med | `main.cpp` is each large app's critical path. | With GC-10. | open |
| BD-10 | low | Shipping carries SDL software blitting and the MSVC demangler. | The trimmed SDL compiles out the blitters, RLE, YUV and stb_image through a project include (torus-states exe −22%). | fixed |
| BD-11 | med | Trimmed SDL records no patch set. | The trimmed SDL records its patch set under NT-7's check. | fixed |
| BD-12 | low | Two SDL trim options are not options. | Removed; the guard requires a declared (BOOL or INTERNAL) option. | fixed |
| BD-13 | low | Packages ship vcpkg SDL's 349 KB licence. | vcpkg SDL is the `sdl` manifest feature, requested only where no trimmed SDL replaces it; every package, iOS included, ships the trimmed SDL's notices. | fixed |
| BD-14 | low | `--plan` failed before generation. | Plan generates first. | fixed |
| BD-15 | low | Startup failures discarded output. | Output tail; long paths refused. | fixed |
| BD-16 | med | Checkouts of different manifests sharing one vcpkg install reinstall it on every build. | Shared installs are keyed by the manifest digest, three kept per name. | fixed |
| BD-17 | low | Journaled writes to shared records are found by inventory, not enforced by types; `EmissionSet.add` is 21 s of antigravity's 59 s journal cost. | Readonly types inside the compiler (or a test failing on unjournaled writes); cheaper dependency-set adds. | open |
| BD-18 | low | `runtime.hpp` sits in the PCH and tests 15 feature macros, so every PAL unit's cache key carries them; generated units never hit the cache across scenes. | Split the feature-gated record blocks out of `runtime.hpp`; content-addressed generated sources. | open |
| BD-19 | low | `controller_type` (11.5 KiB) is linked into the trimmed SDL with joystick support off. | Trim it with the joystick subsystem. | open |

## Workers (WK)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| WK-1 | high | Worker messages with Date/Map/Set/typed views compiled then threw `DataCloneError`. | Structured-clone codecs; unsupported types refuse at generation. | fixed |
| WK-2 | med | Class instances cross workers as classes; the browser delivers plain objects without private fields or prototype. | Refused at both message ends, naming the class; no registered program posts one. | fixed |
