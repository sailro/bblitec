# Audit

Findings of the 2026-09-23 audit at main `8407fa11`. Evidence cites that commit.
Status: `open`, `partial`, `fixed`, `declined` (reason given). Capability gaps live in
[TODO](TODO.md); this file tracks structural findings until they close.

## Feature activation (FA)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| FA-1 | high | Asset facts join the feature list after compilation (`cli.ts:1040-1236`) or are ORed at 7 consumers; `compileAdaptations` (`compiler.ts:1404`) runs first, so asset-only reach misses adaptations (scene226 lacks the 3 splat adaptations). | One `joinAssetFeatures()` before adaptations; one declarative implication table; features projected once. | open |
| FA-2 | high | Transmission activates from reach/asset ORs and emitted-literal comparisons (`material.ts:500-505`), not the composed refraction arm (`pinned-material-arms.ts:236`, unread); 5 skybox-only trees compile the transmission path. | Define from `composedArms.transmission`; `setPbrSkybox` stops reaching transmission. | open |
| FA-3 | med | `feature-activation.ts` re-derives 33 rows; 15 runtime features have no reader, 8 claim false readers. | Inventory projects the recorded plan; reader claims tested. | open |
| FA-4 | med | Asset conditions restated (`asset-specializer.ts:537-660`) though packaging runs the pinned registry; GLBs parsed ≥5 times. | Record triggered registry rows at packaging; parse once. | open |
| FA-5 | med | Macros have two owners and three guard styles with opposite defaults; no `-Wundef`; `BBLITE_HAS_SHADOWS` feature lists disagree. | Always define 0/1, `#if X` only, `-Wundef`//we4668. | open |
| FA-6 | med | Camera/light gizmo factories and morph-shadow bounds emitted without reach (6/7 and 20/21 trees). | Gate on `gizmo:camera`/`gizmo:light` and a `shadow:morph-bounds` feature. | open |
| FA-7 | low | `loadBabylon` reaches `camera:free` even with `loadCamera: false` (scenes 9/41/143). | Reach only when cameras load. | open |
| FA-8 | low | Activation records embed absolute checkout paths (manifest/fidelity/feature-activation JSON). | Repository-relative POSIX paths. | open |

## Re-derivation in TypeScript (RDT)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| RDT-1 | high | 1,362 AST-shape assertions restate ~2,000 lines of pinned TypeScript to guard hand-written C++ templates (e.g. `renderer-lowerer.ts:748-790` guards a depth term the emitted sort does not use). | Lower guarded bodies (`lowerPinnedFunction[Parts]`, `lowerPinnedBody`) and delete template + guard; guard count is the ratchet. | open |
| RDT-2 | high | Pinned functions hand-copied though already lowered elsewhere: camera clamp/inertia, `evaluate_track`, grid atlas ×2, `expandWorldAabbForMesh` ×2, mesh-builder bounds. | Use the lowered versions. | open |
| RDT-3 | high | Hand copies with no lowered version, some unguarded: clustered lights, free-camera yaw/pitch, VAT `setInstances`, glTF animated light direction (wrong branch), HDR prefilter setup, sprite instance writer/Y-sort, animation mixer, tube/extrude, Draco/basisu routing. | Lower or execute the pinned functions. | open |
| RDT-4 | high | Behaviour keyed on mesh names starting with `wheel` (`scene-lowerer.ts:1930`, `gltf-loader-cpp.ts:1103`). | Decide from API reach (rotation writes to imported meshes). | open |
| RDT-5 | med | Pinned WGSL rewritten by regex onto hand-designed flattened uniform layouts (background, grid, utility, splat). | Keep pinned structs/bindings; remap by compaction; pinned UBO writers. | open |
| RDT-6 | med | Composed WGSL read back with ~20 regexes (`pinned-pbr-variant-cpp.ts`) beside a typed parser. | Typed WGSL reflection. | open |
| RDT-7 | med | Regex/spelling checks over pinned TS and packaged JS (22 regex sites, 39 text checks). | AST tests and one AST import rewriter. | open |
| RDT-8 | med | `assertPinnedShaderFormulas` (275 lines) guards formulas no longer copied; 4 flags feed nothing else. | Delete. | open |
| RDT-9 | med | `shader-ir.ts` keeps a ~255-line regex raw-module fallback; user WGSL constant rewritten by regex (`compiler.ts:10714`). | Typed parser coverage; delete raw path. | open |
| RDT-10 | low | Plugin `getCustomCode` has its own ~250-line evaluator (`material-plugin.ts:1407-1660`). | Share the pinned shader-text evaluation. | open |
| RDT-11 | low | Pinned defaults copied into tables then checked (`pinned-material-defaults.ts`, `post-process-effects.ts`, navigation). | Read values from the pin. | open |
| RDT-12 | low | Hand SDL blit beside the pinned `BLIT_SHADER`; stale fog comment; unused predeclared shader programs. | Lift the pinned blit; delete leftovers. | open |

## Re-derivation in native code (RDN)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| RDN-1 | high | PAL bakes TRS into vertices and re-picks each draw's world matrix (~10 functions in `pal_gpu_shared.hpp`) instead of uploading the pin's `worldMatrix`. | Feed generated `MeshUniforms.world`; upload local vertices. | open |
| RDN-2 | high | `pal_camera_controls.hpp` dispatch diverges from pinned handlers (FreeCamera buttons, ArcRotate middle drag, hand key map, fixed 1000/60 ms step). | Lower the pinned handlers; pass real frame delta. | open |
| RDN-3 | med | Camera/billboard/sprite/text C++ templates transcribe pinned formulas behind shape asserts (same mechanism as RDT-1). | See RDT-1. | open |
| RDN-4 | med | 61 record default initializers copy (or invent) pinned values; default camera record read live by floating origin. | Generated factories are the only writers; optional no-camera path. | open |
| RDN-5 | med | `environment_fallback_face {0.15,0.16,0.2}` exists in no pinned module. | Measure; zero or derive from `PBR_HAS_ENV`. | open |
| RDN-6 | med | `derive_material_alpha_mode` lacks the pin's opacity-texture/blend arms. | Bucket from lowered pinned feature predicate. | open |
| RDN-7 | med | Small pinned functions hand-copied (sprite pick, layer order, billboard pick uniforms, pick id codec, morph packing). | `lowerPinnedFunction` into the upstream unit. | open |
| RDN-8 | med | Pick orchestration restated per backend (375/566 lines). | Hoist the backend-neutral half. | open |
| RDN-9 | low | UI composite WGSL duplicated byte-for-byte in two Dawn files. | One helper (with NT-1). | open |
| RDN-10 | low | Dawn hand-writes 39 bind-group layouts; SDL reads `.slots`. | Layouts from reflected tables. | open |
| RDN-11 | low | Recast wrapper defaults copied without version provenance. | Record/assert library version. | open |

## Compiler core (CC)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| CC-1 | high | Nullable resource kinds classified by bare type name: user `class Mesh`/`interface Material` refuse as engine handles (`compiler.ts:487-549, 2042`). | Provenance-checked `pinnedHandleKind`/DOM checks. | open |
| CC-2 | high | `compiler.ts` holds 18.7k lines/695 members behind a 437-member `LoweringServices`; core lowering is not where architecture.md says. | Extract recorder, scopes, declarations, property access, conditions, browser predicates. | open |
| CC-3 | high | Minecraft save/load matched by name and path regex and replaced by hand-written native code (`compiler.ts:11073-11147`). | Transpile the module; delete the contract and `js_voxel_file.hpp`. | open |
| CC-4 | high | Pinned lowerers are a second translator with divergent semantics (`Math.min/max` NaN/−0, `<<`, `x\|0`); folding written 7 times. | One `js-operators` module; then a shared expression core. | open |
| CC-5 | med | Library-global recognition has 4 spellings (~230 sites). | One `libraryGlobal()` in `symbols.ts`. | open |
| CC-6 | med | Declaration origin decided 8 ways that disagree (`lib.dom.iterable`, Babylon path substring). | One `declarationOrigin()`. | open |
| CC-7 | med | Nullable-union member rule has no owner (50 flag tests, 3 re-derivations). | `presentMembers()`/`nullability()` in `type-facts.ts`. | open |
| CC-8 | med | Class members found by name in ≥12 loops; no inheritance; mutable statics refuse. | One `ClassMemberTable`. | open |
| CC-9 | med | String and presence facts spelled per site (224 string checks vs 6 `isStringValue` uses). | Shared accessors. | open |
| CC-10 | med | Class methods inlined at every call (quake 185 bodies); constant Float32 tables wrap every element in `static_cast<float>` (tetris `renderer.cpp` 1.96 MB). | Shared method bodies by default; float literals. | open |
| CC-11 | low | 120 raw `getSymbolAtLocation` calls bypass `valueSymbol`. | Route through the resolver. | open |
| CC-12 | low | Truthiness/comparison lowering split three ways. | One condition lowerer. | open |
| CC-13 | low | Generic paths key on `"renderCanvas"`, silently resolve missing root assets to GitHub, map `offsetX` to `clientX`. | Key on the engine canvas; refuse; target-relative offsets. | open |
| CC-14 | high | Silent miscompiles: class `static {}` blocks dropped; `Object.assign` on engine handles erases writes; embedded NUL truncates. | Refuse explicitly. | open |

## Lowering layer (LW)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| LW-1 | high | 1,298 restated pinned strings and ~35k lines of C++ template text; whole pinned bodies copied (device recovery 613 lines, text data update 361). | Same programme as RDT-1; add `lowerPinnedExpression`; ratchet the counts. | open |
| LW-2 | high | Eight overlapping translators/evaluators of pinned TypeScript; `PinnedReferenceLowerer` serves one family. | One folding core; retire the reference lowerer; typed program over pinned sources. | open |
| LW-3 | high | Seven generation-time execution mechanisms; Chromium launched per call at 10 sites; JSON passes spawn ~300 ms children. | In-process `node:vm`; one page pool per generation. | open |
| LW-4 | med | WGSL structs parsed by regex at 8 sites; two uniform-layout tables (compiler imports the diagnostic one). | `shader-ir` reflection + one `wgsl-layout` module. | open |
| LW-5 | med | Pinned shader-text builders re-interpreted by an 880-line evaluator. | Execute the builders. | open |
| LW-6 | med | Sprite/billboard keep private attribute tables, UBO walkers, sorts; blend and option-default readers copied. | Shared emitters/readers; lower pinned writers and sorts. | open |
| LW-7 | med | Feature→source mapping stated twice (91-row table + 90-branch ladder); features typed `string[]`. | Table owns emission; typed features. | open |
| LW-8 | med | Regex/text scans over pinned source where AST helpers exist. | AST helpers. | open |
| LW-9 | med | Pinned constants read 7 ways, ~19 private reader copies. | Public `pinnedConstant` family in `context.ts`. | open |
| LW-10 | low | Dead lowering exports (`pinnedComputeAabbHeader`, `gltf/shared.ts` helpers). | Delete. | open |

## Native PAL (NT)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| NT-1 | high | Two near-copy UI compositors per backend (scene host vs sprite/Window host). | One compositor per backend. | open |
| NT-2 | med | `pal_gpu_shared.hpp` is a 6,476-line header with ≥15 concerns, compiled by 25 includers. | Split by concern; non-template bodies in one unit. | open |
| NT-3 | med | Dawn keeps one layout-cache set per material family (9 factories). | One keyed layout cache. | open |
| NT-4 | med | Feature families written twice inside two monoliths (14.2k/11.9k lines; `encode` 1,846/2,598 lines). | Paired family units, then shared orchestration. | open |
| NT-5 | low | GPU enum mappings duplicated inside each backend. | One formats header per backend. | open |
| NT-6 | low | Sprite/effect/frame-graph Run classes repeat ~310 lines of phase boilerplate. | Shared run base. | open |
| NT-7 | high | Dawn/LabSound patch changes neither rebuild nor refuse stale installs. | Patch-hash identity checked at configure and setup. | open |
| NT-8 | med | Patches in 3 places, 5 mechanisms, no inventory; SDL list written twice. | One manifest + `patches:check`. | open |
| NT-9 | med | RmlUi order encoded in `zz`/`zzz`/`zzzz` names; 7 zero-context hunks. | Numbered patches; regenerated with context. | open |
| NT-10 | low | 41/50 patches lack a purpose header; two stale upstream-status notes. | Headers mirrored in the manifest. | open |
| NT-11 | low | Single-backend builds deploy both backends' shader payloads. | Filter by compiled backend. | open |
| NT-12 | low | Backend dispatch is an 8-way `#if` matrix across 6 sites. | One dispatch table per backend. | open |

## Generated C++ (GC)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| GC-1 | high | Mesh/geometry records are append-only: doom's gameplay tape grows mesh records 178 → 4,924 while the scene holds 178. | Recycle slots with generation-checked handles. | open |
| GC-2 | high | The `memory` gate runs idle and only watches working set (32 MB), so record growth passes. | Record-count and slope gates; gameplay tapes. | open |
| GC-3 | med | `.clang-tidy` enables 17 checks; a broader safety set finds ~90 actionable hits (exception-escape in `~CollectOnExit`, unchecked optionals, zero-initialised WebGPU enums). | Widen the gate; fix or justify. | open |
| GC-4 | med | Generated code indexes records directly (850 sites), so checked handles never cover it. | Emit `bbl::handle_at` through one helper. | open |
| GC-5 | med | Every `Array<T>` registers a GC node even for acyclic `T` (idle doom: ~2,300 GC allocations per frame). | Register only traceable element types. | open |
| GC-6 | low | 623 of 1,238 generated loops count with `double`. | Integer counters for canonical loops. | open |
| GC-7 | low | Constant tables emit `static_cast<float>` per element and store integer tables as `double` (same as CC-10b). | Float literals; element-typed tables. | open |
| GC-8 | low | Packaged-asset lookup emitted inline per fetch site (quake: 28 copies). | One lookup per realm. | open |
| GC-9 | low | Uninitialised generated locals and record fields. | Value-initialise. | open |
| GC-10 | low | Inlining leaves 82% of quake in `main.cpp`, a 5,371-line closure body, tuple environments of arity 114 (with CC-10a). | Out-of-line method bodies; named environments. | open |
| GC-11 | low | MSVC suppresses C4702 for generated units because of unconditional fallthrough throws. | Emit the tail only when needed; drop `/wd4702`. | open |

## Dead code (DEAD)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| DEAD-1 | med | 12 functions and `upstream-graph.ts` used only by their tests. | Delete or move to test helpers. | open |
| DEAD-2 | med | 11 exported functions referenced nowhere. | Delete. | open |
| DEAD-3 | med | Goldens/previews of 5 deregistered scenes; unregistered `examples/physics-drop.ts`. | Delete. | open |
| DEAD-4 | med | 12 unused test fixtures (~730 lines). | Delete. | open |
| DEAD-5 | low | 5 unreferenced native functions; unused `BBLITE_MAIN_OPT`, `BBLITE_COMPUTE_ONE_SHOT`. | Delete. | open |
| DEAD-6 | low | Native symbols only fixtures call. | Point fixtures at product API. | open |
| DEAD-7 | low | Legacy `classStyles` spelling kept by 4 UI companions. | Migrate and delete. | open |
| DEAD-8 | low | 10 self-described "legacy" compiler paths. | Measure; delete unreached. | open |
| DEAD-9 | low | 258 exports used only in their own file. | Drop exports; `ts-prune -u`. | open |
| DEAD-10 | low | Unused parameters, duplicated small helpers, silently passing tests. | Remove; share; report skips. | open |

## Documentation (DOC)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| DOC-1 | high | ~58 of 94 TODO entries restate Limits owned by features/ui/fidelity. | TODO keeps internal work, qualification and performance. | open |
| DOC-2 | high | ~20 code comments cite removed doc/TODO text. | State the fact or delete the pointer. | open |
| DOC-3 | high | 32 facts stated in 2-5 documents. | One owner each. | open |
| DOC-4 | med | 10 wrong facts (Android ABI default, `CCACHE_PATH`, dependency table, artifact paths, patch lists, worktree guidance). | Correct. | open |
| DOC-5 | med | TODO bundles, wrong owners, vague or done items. | Split, fix owners, delete done. | open |
| DOC-6 | low | `status.md` is 28% of doc bytes; physics rows repeat one note 8 times. | One intro sentence; status read on demand. | open |

## Tooling and CLI (TL)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| TL-1 | high | `clean --artifacts` deletes 10 live artifact roots (incl. `native-cache`). | One artifact-root table shared by writers and clean. | open |
| TL-2 | med | 8 of 25 scene commands restate others (stability, uniforms, compose, observe, neutrality-generated, geometry, probe-variants). | 20 commands; merged modes. | open |
| TL-3 | med | Four sizing tools; `project-requirements.mjs` rows are all "unassessed". | One survey command. | open |
| TL-4 | med | PowerShell packaging re-implements TypeScript helpers; TS→PS→`node -e` loops. | Desktop packaging in TypeScript. | open |
| TL-5 | med | 15 untyped `.mjs` files import 22 `dist/src` modules unchecked. | Type-check tools. | open |
| TL-6 | med | Backend names and `--exe` accepted inconsistently; unknown backends coerced. | One parser; shared measuring flags. | open |
| TL-7 | med | Seek handled 3 ways; `parity --seek` can overwrite a tracked golden. | One pose resolver; diagnostic-only seek. | open |
| TL-8 | med | `geometry` uses weaker staleness, regex task discovery, fixed output path. | Capture provenance and manifest tasks. | open |
| TL-9 | low | Two JSON report writers; hand-spelled report names. | One record writer. | open |
| TL-10 | low | Help/parser/doc drift (duplicate flag specs, no-op `--backend`, missing usage). | Shared specs; tests. | open |
| TL-11 | low | Dead entry points/aliases (`compile-shaders.ps1`, `upstream:report`, `shaders:build`, `scenes:*`). | Delete. | open |
| TL-12 | low | 9 file walkers, 2 process runners, 2 codec-metadata readers. | Share. | open |

## Building (BD)

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| BD-1 | high | After any native edit each scene deletes and recreates its build tree: CMake rewrites ninja to its short DOS path and `cachePathKey` (`build-stamp.ts:326-379`) sees a new tool (288/290 trees in the last sweep). | Canonicalise with `realpathSync.native`. | fixed |
| BD-2 | high | Every emission transaction deep-copies reachable compiler state: 72.7% of quake's generation CPU (34.2 s per one-literal edit vs 4.45 s native). | Copy-on-write journal for the remaining state. | open |
| BD-3 | med | Generation runs in registry order, so the 14 largest apps start last. | Order by recorded generation cost. | open |
| BD-4 | high | `demos:release` on Windows has failed since 2026-09-18: `--parallel` reaches CMake one character at a time (`bblite-tools.psm1:230-237`). | Return an array; test the splat. | fixed |
| BD-5 | med | ccache is full at 5 GiB and keys absolute worktree paths (0/20 hits in a fresh worktree). | `base_dir` and a larger `max_size`. | open |
| BD-6 | med | Dev builds disable the PCH whenever ccache is present; a cache miss costs 35% more CPU than no cache, the PCH saves 42%. | PCH-compatible caching or an iterate mode. | open |
| BD-7 | med | Every unit receives all ~60 feature macros and the generated-header folder is keyed on all headers, so objects rarely match across scenes (598 distinct of 3,995 upstream units). | Per-unit macros and header identity. | open |
| BD-8 | med | `pal_dawn.cpp`/`pal_sdl_gpu.cpp` compile once per scene shape (167 variants); one shared-header edit ≈ 2,700 CPU-s population-wide. | Move capability-independent code into shared units. | open |
| BD-9 | med | `main.cpp` remains each large app's critical path (quake 1.68 MB); one `application.hpp` recompiles every unit (with GC-10). | Closure bodies in owning units; per-source declarations. | open |
| BD-10 | low | Shipping exe carries ~480 KiB of SDL software blitting and 88.7 KiB of the MSVC demangler (`typeid(...).name()`, `js_gc.hpp:308`). | Fixed message; trim SDL references. | open |
| BD-11 | med | The trimmed SDL artifact records no patch set; the shared one lacks two patches without any refusal. | Patch digests checked at configure (with NT-7). | open |
| BD-12 | low | `SDL_LOCALE`/`SDL_MISC` trims are not SDL options; the guard passes them. | Remove; require BOOL type. | open |
| BD-13 | low | Packages ship vcpkg SDL's 349 KB licence and always the nlohmann notice. | Trimmed SDL licence; reached notices only. | open |
| BD-14 | low | `demos:release --plan` fails before generation. | Generate or refuse clearly. | open |
| BD-15 | low | Package startup failures discard program output. | Print the output tail; reject long paths. | open |
