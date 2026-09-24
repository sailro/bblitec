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
| FA-4 | med | Asset conditions restated from the pinned registry; GLBs parsed ≥5 times. | Each document parsed once; lights from the executed plan; `staticModules` removed. Remaining: record triggered registry rows at packaging and read them in the specializer. | partial |
| FA-5 | med | Macros have two owners and three guard styles with opposite defaults; no `-Wundef`. | One owner per macro (CMake for feature-keyed ones; `render_capabilities.hpp` in every tree for generator decisions), always 0/1; only `#if X` (native 560 `defined()` guards → 0; generated 2,094 → 0); `-Werror=undef` (clang-cl), `/we4668` (MSVC) on project units, which found two units reading a generator macro before its header. `BBLITE_HAS_SHADOWS` keys on the shadow generator list, checked by a test. | fixed |
| FA-6 | med | Camera/light gizmo factories and morph-shadow bounds emitted without reach. | `gizmo:camera`/`gizmo:light` and `shadow:morph-bounds` gate emission and native records. | fixed |
| FA-7 | low | `loadBabylon` reached `camera:free` with `loadCamera: false`. | Camera parser emitted only when cameras load. | fixed |
| FA-8 | low | Activation records embedded absolute checkout paths. | Repository-relative POSIX paths. | fixed |
| FA-9 | low | `ModelGeometry::morph_bounds` is compiled into every scene and cleared by every mesh builder. | `morph_bounds` and its release compile under `BBLITE_SHADOW_MORPH_BOUNDS`; builders clear it only when `shadow:morph-bounds` is reached. | fixed |
| FA-10 | low | The transmission/thickness slot pair follows the renderer define, so a translucency-only scene compiles the grab machinery (scene26). | Key the slots on the composed arms. | open |
| FA-11 | low | Native test fixtures compile with ad-hoc `/D` flags and harness defaults, without the undefined-macro check. | Derive fixture flags from the CMake table and add `/we4668`. | open |
| FA-12 | med | CMake re-derives feature→macro for 58 macros the activation plan already decides, and a test greps CMakeLists to keep them in sync. | Generate every macro from the activation plan (per unit, with BD-7); CMake keeps source and link selection. | open |

## Re-derivation in TypeScript (RDT)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| RDT-1 | high | 1,362 AST-shape assertions guarded hand-written C++ transcriptions of pinned bodies. | Camera, sprite/billboard writers and sorts, grid atlas, pick helpers, animation mixer/tracks, mesh bounds, tube/extrude, VAT, glTF light direction and clustered lights are lowered; their guards are gone. Remaining families: text data updates (needs the pin's multi-group native model), device recovery, physics floating origin, Y-sort bookkeeping. | partial |
| RDT-2 | high | Pinned functions hand-copied though lowered elsewhere (camera clamp/inertia, `evaluate_track`, grid atlas, `expandWorldAabbForMesh`, mesh bounds). | All use the lowered versions. | fixed |
| RDT-3 | high | Hand copies without a lowered version (clustered lights, free-camera yaw/pitch, VAT, glTF light direction, mixer, tube/extrude, HDR prefilter setup, Draco/basisu routing). | Lowered except HDR prefilter setup and Draco/basisu routing. | partial |
| RDT-4 | high | Behaviour keyed on mesh names starting with `wheel`. | Declined for now: removing it sinks the racer body (imported positions are offsets over baked worlds). Needs imported node-local transforms, a parent-world matrix and parent×local composition first. | open |
| RDT-5 | med | Pinned WGSL rewritten by regex onto flattened uniform layouts. | Keep pinned structs/bindings; remap by compaction; pinned UBO writers. | open |
| RDT-6 | med | Composed WGSL read back with ~20 regexes. | Typed WGSL reflection (`shader-ir.ts`, `wgsl-layout.ts`). | fixed |
| RDT-7 | med | Regex/spelling checks over pinned TS and packaged JS. | AST readers and one specifier rewriter; 22 → 5 regex sites (one WGSL scale match awaits IR unary minus). | partial |
| RDT-8 | med | `assertPinnedShaderFormulas` guarded formulas no longer copied. | Deleted with its flags. | fixed |
| RDT-9 | med | `shader-ir.ts` regex raw-module fallback; user WGSL constant rewritten by regex. | Full typed WGSL front end; raw path deleted. | fixed |
| RDT-10 | low | Plugin `getCustomCode` had its own evaluator. | Shares the pinned shader-text folding. | fixed |
| RDT-11 | low | Pinned defaults copied into tables and checked. | Material, billboard, post-process and navigation defaults read or emitted from the pin. | fixed |
| RDT-12 | low | Hand SDL blit, stale comment, predeclared shader programs. | Comment fixed. The predeclared programs are live (alpha-card gate); the pinned blit differs in LOD and group, so only a measured vertex lift remains. | partial |
| RDT-13 | low | Grid material and sprite-grid absent-arm defaults are literals (`material-options.ts`, `material.ts`, `intrinsics/sprite.ts`); the node-particle Sprite2D bridge relies on header defaults. | Read them from the pin. | open |
| RDT-14 | med | The clustered-light refresh uses a hand dirty key (view/projection equality, `topologyDirty` bound true) and matches generic JS by source text in its statement hook. | Lower the pin's dirty test with `scene_camera_change_key`; move truncation/push/sort/destructuring into the shared pinned lowerer; match platform calls by symbol. | open |

## Re-derivation in native code (RDN)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| RDN-1 | high | The PAL bakes TRS into vertices and re-picks each draw's world matrix instead of uploading the pin's `worldMatrix`. | Feed generated `MeshUniforms.world`; upload local vertices. | open |
| RDN-2 | high | Camera input dispatch diverged from the pinned handlers. | Handlers and key map lowered; real frame delta; SDL only translates events. | fixed |
| RDN-3 | med | Camera/billboard/sprite/text templates transcribed pinned formulas. | Camera, billboard and sprite lowered; text remains (RDT-1). | partial |
| RDN-4 | med | 61 record defaults copied or invented pinned values. | Option structs written whole by generation carry none; records zeroed; render tasks without `clrColor` (the default task included) clear to the scene's live colour; a scene without a camera clears and draws through a zero scene block and skips what the pin skips; glTF projection writes each absent key's pinned default. Remaining: `create_pbr_material` and the `set_pbr_*` setters still rely on `MaterialRecord` initializers, and an absent clearcoat/sheen/iridescence layer is encoded as zero intensity. | partial |
| RDN-5 | med | Invented environment fallback face. | Measured unused; zero cube bound. | fixed |
| RDN-6 | med | Render bucket rule lacked the pin's opacity/blend arms. | Bucket from the pinned `isTransparent` predicates (fixtures: 0.373 → 0.000, 0.121 → 0.000). | fixed |
| RDN-7 | med | Small pinned functions hand-copied. | Generated from the pin except `pack_morph_deltas`. | partial |
| RDN-8 | med | Pick orchestration restated per backend. | Shared preparation, clears and decode; lowered pointer mapping. | fixed |
| RDN-9 | low | UI composite WGSL duplicated. | One compositor per backend. | fixed |
| RDN-10 | low | Dawn hand-writes bind-group layouts. | One keyed layout cache; sprite UBO size from the generated writer. Remaining: layouts from `.slots`/reflection. | partial |
| RDN-11 | low | Recast wrapper defaults copied without version provenance. | Emitted from the pinned wrapper packages, whose versions are recorded. | fixed |
| RDN-12 | low | The Recast wrapper's query half-extents, generator config transforms and 2048-node path query are hand ports (`pal_navigation_recast.cpp`). | Query half-extents and the 2048-node pool are emitted from the pinned wrapper and read by every search. Remaining: the generator config transforms are still hand-ported. | partial |
| RDN-13 | low | The pin sorts sprite `_layers` in place; native builds a fresh permutation each frame, so ties after an order change differ. | Stable in-place sort. | open |
| RDN-14 | low | Billboard sorting under a floating origin and Sprite2D pivots use float where the pin uses numbers (205/206 identical today). | Double lanes. | open |
| RDN-15 | low | `update_surface_cameras` gives every scene the primary frame delta, wrong for a scene with its own `fixedDeltaMs`. | Per-scene delta. | open |
| RDN-16 | low | Property-animation records store float lanes (`animation-records.hpp`). | Group times, speed, weights, fades and clip rates are double end to end; key times, values, samples and blend buckets stay float where the pin stores into a Float32Array. | fixed |
| RDN-17 | med | Mesh removal leaves physics node poses, property-animation targets, light include/exclude lists, shadow casters, render-task mesh lists and node-material groups naming the mesh; the pin prunes render tasks and material groups and clears `parent`. | Lower the pin's removal pruning. | open |
| RDN-18 | low | A camera-less overlay or utility layer projects through the base camera on Dawn and the SDL_GPU swapchain overlay, and through none on SDL_GPU graph layers; the pin uses each layer's `cfg.cam ?? scene.camera`. | Align both backends on the pin. | open |
| RDN-19 | low | Animation seek harness and glTF group operations (`set_animation_current_time`, `set_animation_speed_ratio`, `go_to_frame`, additive setters) take float where the pin passes numbers. | Double parameters. | open |
| RDN-20 | med | The camera-less pass contract is ~26 `if (camera)` arms per backend, and render-task-base's `cfg.cam ?? scene.camera` / `cfg.clrColor ?? sc.clearColor` resolution is transcribed in each backend. | Lower the pass resolution once into an `upstream::` function; one shared pass-camera builder yielding the zero block; lowered pinned early returns do the per-renderable skips. | open |

## Compiler core (CC)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| CC-1 | high | Nullable resource kinds classified by bare type name. | Declaration-origin checks; user `class Mesh`/`interface Material` compile. | fixed |
| CC-2 | high | `compiler.ts` holds 18.7k lines behind a 437-member interface. | `SceneManifestRecorder`, `BindingScopes`, `ConditionLowerer`, browser predicates in `BrowserErasure`, `DeclarationLowerer` and `PropertyAccessLowerer` own their slices behind narrow contexts (19,183 → 10,725 lines; 448 → 349 service members; output identical). Remaining: closures, async/lifecycle, option adapters, the native-emission registry, assets and the `note*` admissions. | partial |
| CC-3 | high | Minecraft save/load matched by path regex and replaced by native code. | Needs generic support first: absent file-picker globals, escaping Promise `resolve`, `FileReader`, `JSON.parse(text) as T`. | open |
| CC-4 | high | Pinned lowerers diverged from JS semantics; folding written 7 times. | One operator module; `<<`, `^`, `\|0` via `bbl::js`; comparisons shared; pinned and scene-code `Math.max/min` lower through one `math_extreme` at any arity (float writer lanes `math_extreme_lane`; camera controls included); pinned Uint32Array stores use `to_uint32`. | fixed |
| CC-5 | med | Library-global recognition has 4 spellings. | One `libraryGlobal()` (bare names, `globalThis`, `window.`/`self.` members) at 185 sites; user declarations named `Number`, `String`, `Object` or `Map` lower as user code. Remaining: the platform timer arm accepts only bare names, and `undefined` has 12 hand checks. | partial |
| CC-6 | med | Declaration origin decided 8 ways. | One `declarationOrigin()`. | fixed |
| CC-7 | med | Nullable-union rule had no owner. | `presentMembers()`/`nullability()`. | fixed |
| CC-8 | med | Class members found by name in ≥12 loops. | One `ClassMemberTable`. Remaining: inheritance and mutable statics. | partial |
| CC-9 | med | String and presence facts spelled per site. | String tests through `isStringValue` (5 → 32 callers); presence through `optionalPresentCpp`/`presenceCpp` (literal `has_value()` 61 → 12). Remaining: `truthinessCpp`, `optionalFoundCpp` and `conditionFromValue` sites each need a truthiness-versus-presence proof. | partial |
| CC-10 | med | Methods inlined at every call; constant tables wrapped each element. | Tables emit typed literals (tetris `renderer.cpp` 1.96 → 0.83 MB). Method sharing is blocked by `canShareFunctionBody` refusals (function-typed parameters, retained-canvas reads). | partial |
| CC-11 | low | Raw symbol lookups bypass `valueSymbol`. | `resolvedSymbol`/`aliasTarget` replace 19 alias idioms (`getAliasedSymbol` only in `symbols.ts`). Remaining: 93 raw lookups, mostly deliberate unresolved reads; value positions change imported-name behaviour. | partial |
| CC-12 | low | Truthiness/comparison lowering split three ways. | `comparisons.ts` owns operators, folds, boolean comparisons and `instanceof`; `ConditionLowerer` owns conditions, and the static evaluator and data lowerer reach it directly. | fixed |
| CC-13 | low | Literal `renderCanvas` id, silent GitHub asset fallback, `offsetX` as `clientX`. | Canvas keyed on `createEngine`; `--public-url` or refusal; offsets recorded as an adaptation. | fixed |
| CC-14 | high | Silent miscompiles: static blocks dropped, `Object.assign` on handles erased, embedded NUL truncated. | Static blocks and handle `Object.assign` refuse; NUL-containing strings keep their length. | fixed |
| CC-15 | high | `??=` onto a nullable class reference emitted nothing. | Presence-guarded store. | fixed |
| CC-16 | med | Lazy singletons (`let c: C \| null = null; c = new C()`) refused. | Rebound locals store their declared type. | fixed |
| CC-17 | low | `lookupIdentifierValue` restates `bindings.lookupOptional` (55 callers), and 11 context interfaces redeclare `bindings` because two folds narrow it to lookups. | `bindings.lookupOptional` is the one lookup (51 callers moved); the two narrowing folds take a `StaticFoldContext`, so no context redeclares `bindings`. | fixed |
| CC-18 | med | Colour-shape refusals (DEAD-13) are placed per site; the compiler never reads TypeScript assignability diagnostics, which would refuse every off-API object shape at once. | Refuse user sources on assignability diagnostics, measured over the corpus first; at minimum decide colour shape from the contextual type. | open |

## Lowering layer (LW)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| LW-1 | high | Restated pinned strings and ~35k lines of C++ template text. | Same programme as RDT-1. | partial |
| LW-2 | high | Eight overlapping evaluators of pinned TypeScript. | One folding core. Remaining: retire `PinnedReferenceLowerer`; typed program over pinned sources. | partial |
| LW-3 | high | Seven generation-time execution mechanisms; Chromium per bake; JSON passes in children. | In-process JSON passes; one shared Chromium per generation (68 bakes on 35 browsers). | fixed |
| LW-4 | med | WGSL structs parsed by regex; two layout tables. | `reflectWgslStruct` and one `wgsl-layout.ts`. | fixed |
| LW-5 | med | Shader-text builders re-interpreted by an 880-line evaluator. | Sprite, billboard, line and grid builders executed. Remaining: define/vertex fragments and application builders. | partial |
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
| NT-14 | med | The patch record is computed three times (TypeScript, CMake, PowerShell); vcpkg portfiles restate PATCHES lists a regex parser reconciles; builders' variant choice is re-derived by verifiers. | One `cmake -P` record script invoked by builders and doctor; artifacts record their variants; portfiles read PATCHES from the manifest. | open |

## Generated C++ (GC)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| GC-1 | high | Mesh/geometry records append-only (doom tape: 178 → 4,924). | Retired slots are reused under mesh-handle generations (doom 179 records for 178 entries; minecraft 474 for a 474 peak); the memory gate judges occupied records against the meshes the scene draws (doom 178 for 178, tetris 46 for 46, minecraft 455 for 455). Remaining: loader, hierarchy-listed and transform-node records keep their slots. | partial |
| GC-2 | high | The memory gate ran idle and watched only working set. | Gameplay tapes, record-growth and slope gates. | fixed |
| GC-3 | med | `.clang-tidy` enabled 17 checks. | Analyzer groups, exception-escape and enum-init enabled and clean; maintained hits fixed. Remaining generated hits keep optional-access, throwing-static-init, member-init and empty-catch off. | partial |
| GC-4 | med | Generated code indexes records directly (850 sites), so a handle kept past its mesh's retirement reaches the slot's next mesh. | Every generated access goes through `recordAt` → `bbl::handle_at` (registry: 24,699 direct sites → 0); bounds and the mesh generation are checked in every build (≤0.6% of a cold frame), so a retired mesh's handle throws. The check found an SDL_GPU sync of the previous plan after mesh retirement, now fixed. | fixed |
| GC-5 | med | Every `Array<T>` registered a GC node. | Only traceable element types register. Remaining: records without traced edges still declare `gc_trace_edges`. | partial |
| GC-6 | low | 623 loops count with `double`. | Integer counters for canonical loops. | open |
| GC-7 | low | Constant tables wrapped every element. | Typed literals and element-typed tables. | fixed |
| GC-8 | low | Asset lookup inline per fetch site. | One table per asset set. | fixed |
| GC-9 | low | Uninitialised generated locals and scalar fields. | Value-initialised. | fixed |
| GC-10 | low | Most application code stays in `main.cpp`; tuple environments of arity 114. | Blocked with CC-10. | open |
| GC-11 | low | MSVC suppressed C4702 for generated units. | Fallthrough proof; `/wd4702` removed (10 apps build with MSVC). | fixed |
| GC-12 | med | A `switch` over a temporary string bound a dangling `string_view`. | Storage bound before the view. | fixed |
| GC-13 | low | Collection `forEach` copies were `const auto`, rejected by clang-cl `/WX`. | Non-const copies. | fixed |
| GC-14 | low | `float32Literal` rounds through double first; a midpoint can differ from `Math.fround` (`cpp-literals.ts`). | `float32Literal` and `floatLiteral` spell a float32-midpoint double as `Math.fround` stores it; table literals defer to them. | fixed |
| GC-15 | low | Generated `main` catches only `std::exception`. | Route every escape through the application error reporter. | open |
| GC-16 | med | Physics node refs, property-animation targets, animated-mesh bindings and light include/exclude lists name a mesh by slot without its generation (`mesh_slot_handle` stopgap), so the retired-mesh check cannot see them. | Store `MeshHandle`s. | open |
| GC-17 | low | `runtime.hpp` still indexes records by `.value` in render-task, material and animation helpers. | Route them through `handle_at`; keep the slot allocator raw. | open |
| GC-18 | med | `handle_at` checks a generation only when the handle type carries one, so slot-only references (`PhysicsNodeRef`, `mesh_slot_handle` callers) pass unchecked and retirement scans child lists to protect them. | Store `MeshHandle`s (a variant for physics nodes), make a generation-carrying table reject generation-less handles at compile time, delete `mesh_slot_handle`. | open |
| GC-19 | low | Slot reuse waits on `composition_feature_rows_initialized`, and `composition_feature_mesh` falls back to the creation ordinal, because composition rows have two identities. | Assign the row in `store_mesh_record` (clones take their source's). | open |

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
| TL-4 | med | PowerShell packaging re-implements TypeScript helpers. | Move desktop packaging into TypeScript. | open |
| TL-5 | med | Tools import `dist/src` unchecked. | Import-name test. Remaining: `checkJs` reports real errors in `checks/plugins/break-meshes-timing.mjs`, `ocean-controls.mjs` and `tools/android-smoke.mjs` beside inference noise. | partial |
| TL-6 | med | Backend names and `--exe` accepted inconsistently. | One backend parser; `BBLITE_NATIVE_EXE` for every measuring command. | fixed |
| TL-7 | med | Seek handled 3 ways; `parity --seek` could overwrite a golden. | One pose resolver; seeks are diagnostic. | fixed |
| TL-8 | med | `geometry` used weaker staleness and regex task discovery. | Capture provenance and configured output; tasks from the manifest's `copyTasks`. | fixed |
| TL-9 | low | Two JSON report writers. | One record module. | fixed |
| TL-10 | low | Help/parser/doc drift. | Shared flag specs; generated usage. | fixed |
| TL-11 | low | Dead entry points and aliases. | Deleted. | fixed |
| TL-12 | low | Duplicated walkers and runners. | Walkers, runners and the record writer shared in `tooling/`; `validation-resume.ts` deleted. | fixed |
| TL-13 | low | `parity`/`check` wait forever on a Window host in a locked console session (offscreen 905 s, ocean 8,830 s). | Window-host runs without their own limit are killed after 120 s + 50 ms per frame; the timeout names the locked session. | fixed |
| TL-14 | low | `check scene149` fails 1/28 at main (the pin's live resize did not throw #84); scene149 and break-meshes-60 browser observations are stale. | Re-observe. | open |
| TL-15 | low | Package `.staging/` folders accumulate. | A published run removes its staging folder; a failed one keeps it. | fixed |
| TL-16 | low | The memory gate's slope test trips on a single allocation step (quake SDL_GPU once; minecraft while its records stay flat). | Judge a sustained trend. | open |
| TL-17 | low | Window-host runs are bounded by a tool timeout; the native frame clock already sees the occluded or timed-out present and retries forever. | Fail a measured run after a bounded streak with the actual status, then drop the tool timeout. | open |
| TL-18 | med | 18 test files slice `pal_sdl_gpu.cpp`/`pal_dawn.cpp` as text and stub what the slice needs (the camera is non-null), so the camera-less arms are never run by a harness. | Link harnesses against extracted shared stage units (after RDN-20/NT-13). | open |
| TL-19 | low | `build-labsound.ps1` and `build-rmlui.ps1` reset their checkout and re-apply patches on every `demos:release`, recompiling everything (build-sdl-min now records its applied series). | One applied-series record in `bblite-tools.psm1` for every builder. | open |

## Building (BD)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| BD-1 | high | Each native edit recreated every scene's build tree (short ninja path). | Tool paths compare by final spelling. | fixed |
| BD-2 | high | Emission transactions deep-copied compiler state (72.7% of quake generation). | Diff-based capture/rollback (quake −40% CPU); UI metadata answered without a probe. Remaining: journal plain compiler state. | partial |
| BD-3 | med | Largest apps generated last. | Ordered by recorded cost. | fixed |
| BD-4 | high | `demos:release` on Windows failed since 2026-09-18. | Array-preserving parallel arguments. | fixed |
| BD-5 | med | ccache full and path-keyed per worktree. | `base_dir`, 25 GiB. | fixed |
| BD-6 | med | No PCH under ccache. | Clang PCH with cache sloppiness. | fixed |
| BD-7 | med | Every unit receives all feature macros; header folder keyed on all headers. | Per-unit macros and header identity. | open |
| BD-8 | med | Backend units compile once per scene shape. | Capability-independent code in shared units. | open |
| BD-9 | med | `main.cpp` is each large app's critical path. | With GC-10. | open |
| BD-10 | low | Shipping carries SDL software blitting and the MSVC demangler. | Demangler removed. Remaining: SDL blitter references. | partial |
| BD-11 | med | Trimmed SDL records no patch set. | The trimmed SDL records its patch set under NT-7's check. | fixed |
| BD-12 | low | Two SDL trim options are not options. | Removed; the guard requires a declared (BOOL or INTERNAL) option. | fixed |
| BD-13 | low | Packages ship vcpkg SDL's 349 KB licence. | Windows packages ship the trimmed SDL's notices (5,196 B). Remaining: Android/iOS copy vcpkg's notice; the shipping profile still installs vcpkg SDL. | partial |
| BD-14 | low | `--plan` failed before generation. | Plan generates first. | fixed |
| BD-15 | low | Startup failures discarded output. | Output tail; long paths refused. | fixed |
| BD-16 | med | Checkouts of different manifests sharing one vcpkg install reinstall it on every build. | Key the shared install by manifest identity. | open |

## Workers (WK)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| WK-1 | high | Worker messages with Date/Map/Set/typed views compiled then threw `DataCloneError`. | Structured-clone codecs; unsupported types refuse at generation. | fixed |
| WK-2 | med | Class instances cross workers as classes; the browser delivers plain objects without private fields or prototype. | Refused at both message ends, naming the class; no registered program posts one. | fixed |
