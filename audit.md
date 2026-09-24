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
| FA-5 | med | Macros have two owners and three guard styles with opposite defaults; no `-Wundef`. | Always define 0/1, `#if X` only, `-Wundef`//we4668. | open |
| FA-6 | med | Camera/light gizmo factories and morph-shadow bounds emitted without reach. | `gizmo:camera`/`gizmo:light` and `shadow:morph-bounds` gate emission and native records. | fixed |
| FA-7 | low | `loadBabylon` reached `camera:free` with `loadCamera: false`. | Camera parser emitted only when cameras load. | fixed |
| FA-8 | low | Activation records embedded absolute checkout paths. | Repository-relative POSIX paths. | fixed |

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
| RDT-11 | low | Pinned defaults copied into tables and checked. | Material defaults and billboard epsilon read from the pin; post-process and navigation in progress. | partial |
| RDT-12 | low | Hand SDL blit, stale comment, predeclared shader programs. | Comment fixed. The predeclared programs are live (alpha-card gate); the pinned blit differs in LOD and group, so only a measured vertex lift remains. | partial |

## Re-derivation in native code (RDN)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| RDN-1 | high | The PAL bakes TRS into vertices and re-picks each draw's world matrix instead of uploading the pin's `worldMatrix`. | Feed generated `MeshUniforms.world`; upload local vertices. | open |
| RDN-2 | high | Camera input dispatch diverged from the pinned handlers. | Handlers and key map lowered; real frame delta; SDL only translates events. | fixed |
| RDN-3 | med | Camera/billboard/sprite/text templates transcribed pinned formulas. | Camera, billboard and sprite lowered; text remains (RDT-1). | partial |
| RDN-4 | med | 61 record defaults copied or invented pinned values. | Option structs written whole by generation carry none; records zeroed; explicit no-camera origin. Remaining: glTF material fallbacks, frame-loop no-camera arm, render-task `clrColor` fallback. | partial |
| RDN-5 | med | Invented environment fallback face. | Measured unused; zero cube bound. | fixed |
| RDN-6 | med | Render bucket rule lacked the pin's opacity/blend arms. | Bucket from the pinned `isTransparent` predicates (fixtures: 0.373 → 0.000, 0.121 → 0.000). | fixed |
| RDN-7 | med | Small pinned functions hand-copied. | Generated from the pin except `pack_morph_deltas`. | partial |
| RDN-8 | med | Pick orchestration restated per backend. | Shared preparation, clears and decode; lowered pointer mapping. | fixed |
| RDN-9 | low | UI composite WGSL duplicated. | One compositor per backend. | fixed |
| RDN-10 | low | Dawn hand-writes bind-group layouts. | One keyed layout cache; sprite UBO size from the generated writer. Remaining: layouts from `.slots`/reflection. | partial |
| RDN-11 | low | Recast wrapper defaults copied without version provenance. | In progress with RDT-11. | open |

## Compiler core (CC)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| CC-1 | high | Nullable resource kinds classified by bare type name. | Declaration-origin checks; user `class Mesh`/`interface Material` compile. | fixed |
| CC-2 | high | `compiler.ts` holds 18.7k lines behind a 437-member interface. | Extract recorder, scopes, declarations, property access, conditions, browser predicates. | open |
| CC-3 | high | Minecraft save/load matched by path regex and replaced by native code. | Needs generic support first: absent file-picker globals, escaping Promise `resolve`, `FileReader`, `JSON.parse(text) as T`. | open |
| CC-4 | high | Pinned lowerers diverged from JS semantics; folding written 7 times. | One operator module; `<<`, `^`, `\|0` via `bbl::js`; comparisons shared. Remaining: pinned `Math.max/min` via `math_extreme`. | partial |
| CC-5 | med | Library-global recognition has 4 spellings. | One `libraryGlobal()`. | open |
| CC-6 | med | Declaration origin decided 8 ways. | One `declarationOrigin()`. | fixed |
| CC-7 | med | Nullable-union rule had no owner. | `presentMembers()`/`nullability()`. | fixed |
| CC-8 | med | Class members found by name in ≥12 loops. | One `ClassMemberTable`. Remaining: inheritance and mutable statics. | partial |
| CC-9 | med | String and presence facts spelled per site. | Shared accessors. | open |
| CC-10 | med | Methods inlined at every call; constant tables wrapped each element. | Tables emit typed literals (tetris `renderer.cpp` 1.96 → 0.83 MB). Method sharing is blocked by `canShareFunctionBody` refusals (function-typed parameters, retained-canvas reads). | partial |
| CC-11 | low | Raw symbol lookups bypass `valueSymbol`. | `resolvedSymbol()` in classification files. | partial |
| CC-12 | low | Truthiness/comparison lowering split three ways. | `comparisons.ts` owns operators and folds. Remaining: condition lowerer extraction. | partial |
| CC-13 | low | Literal `renderCanvas` id, silent GitHub asset fallback, `offsetX` as `clientX`. | Canvas keyed on `createEngine`; `--public-url` or refusal; offsets recorded as an adaptation. | fixed |
| CC-14 | high | Silent miscompiles: static blocks dropped, `Object.assign` on handles erased, embedded NUL truncated. | Static blocks and handle `Object.assign` refuse; NUL-containing strings keep their length. | fixed |
| CC-15 | high | `??=` onto a nullable class reference emitted nothing. | Presence-guarded store. | fixed |
| CC-16 | med | Lazy singletons (`let c: C \| null = null; c = new C()`) refused. | Rebound locals store their declared type. | fixed |

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

## Native PAL (NT)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| NT-1 | high | Two near-copy UI compositors per backend. | One compositor per backend (−1,152 lines). | fixed |
| NT-2 | med | `pal_gpu_shared.hpp` is a 6,476-line header with ≥15 concerns. | Split by concern; non-template bodies in one unit. | open |
| NT-3 | med | One Dawn layout-cache set per material family. | One keyed layout cache. | fixed |
| NT-4 | med | Feature families written twice inside two monoliths. | Paired family units, then shared orchestration. | open |
| NT-5 | low | Enum mappings duplicated within each backend. | One formats header per backend. | fixed |
| NT-6 | low | Standalone Run classes repeat phase boilerplate. | `RendererRun<Derived>`. | fixed |
| NT-7 | high | Dawn/LabSound patch changes neither rebuilt nor refused installs. | Patch digests recorded and checked at configure and setup. | open |
| NT-8 | med | Patches in 3 places, 5 mechanisms, no inventory. | `native/patches/manifest.json` and `patches:check`. | open |
| NT-9 | med | RmlUi order by `zz` prefixes; zero-context hunks. | Numbered patches with context. | open |
| NT-10 | low | Patches lack purpose headers; stale upstream notes. | Headers mirrored in the manifest. | open |
| NT-11 | low | Single-backend builds deployed both backends' shaders. | Deploy and payload checks filter by compiled backend. | fixed |
| NT-12 | low | 8-way backend `#if` matrix. | `pal_gpu_dispatch.hpp` table. | fixed |

## Generated C++ (GC)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| GC-1 | high | Mesh/geometry records append-only (doom tape: 178 → 4,924). | Recycle retired slots with generation-checked handles. | open |
| GC-2 | high | The memory gate ran idle and watched only working set. | Gameplay tapes, record-growth and slope gates (doom and minecraft fail until GC-1). | fixed |
| GC-3 | med | `.clang-tidy` enabled 17 checks. | Analyzer groups, exception-escape and enum-init enabled and clean; maintained hits fixed. Remaining generated hits keep optional-access, throwing-static-init, member-init and empty-catch off. | partial |
| GC-4 | med | Generated code indexes records directly (850 sites). | Emit `bbl::handle_at` through one helper. | open |
| GC-5 | med | Every `Array<T>` registered a GC node. | Only traceable element types register. Remaining: records without traced edges still declare `gc_trace_edges`. | partial |
| GC-6 | low | 623 loops count with `double`. | Integer counters for canonical loops. | open |
| GC-7 | low | Constant tables wrapped every element. | Typed literals and element-typed tables. | fixed |
| GC-8 | low | Asset lookup inline per fetch site. | One table per asset set. | fixed |
| GC-9 | low | Uninitialised generated locals and scalar fields. | Value-initialised. | fixed |
| GC-10 | low | Most application code stays in `main.cpp`; tuple environments of arity 114. | Blocked with CC-10. | open |
| GC-11 | low | MSVC suppressed C4702 for generated units. | Fallthrough proof; `/wd4702` removed (10 apps build with MSVC). | fixed |
| GC-12 | med | A `switch` over a temporary string bound a dangling `string_view`. | Storage bound before the view. | fixed |
| GC-13 | low | Collection `forEach` copies were `const auto`, rejected by clang-cl `/WX`. | Non-const copies. | fixed |

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
| TL-5 | med | Tools import `dist/src` unchecked. | Import-name test; full `checkJs` would flag inference noise. | partial |
| TL-6 | med | Backend names and `--exe` accepted inconsistently. | One backend parser; `BBLITE_NATIVE_EXE` for every measuring command. | fixed |
| TL-7 | med | Seek handled 3 ways; `parity --seek` could overwrite a golden. | One pose resolver; seeks are diagnostic. | fixed |
| TL-8 | med | `geometry` used weaker staleness and regex task discovery. | Capture provenance and configured output. Remaining: manifest copy-task names. | partial |
| TL-9 | low | Two JSON report writers. | One record module. | fixed |
| TL-10 | low | Help/parser/doc drift. | Shared flag specs; generated usage. | fixed |
| TL-11 | low | Dead entry points and aliases. | Deleted. | fixed |
| TL-12 | low | Duplicated walkers and runners. | Shared in tooling. | partial |

## Building (BD)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| BD-1 | high | Each native edit recreated every scene's build tree (short ninja path). | Tool paths compare by final spelling. | fixed |
| BD-2 | high | Emission transactions deep-copied compiler state (72.7% of quake generation). | Diff-based capture/rollback (quake −40% CPU). Remaining: journal plain compiler state; answer UI metadata without a probe. | partial |
| BD-3 | med | Largest apps generated last. | Ordered by recorded cost. | fixed |
| BD-4 | high | `demos:release` on Windows failed since 2026-09-18. | Array-preserving parallel arguments. | fixed |
| BD-5 | med | ccache full and path-keyed per worktree. | `base_dir`, 25 GiB. | open |
| BD-6 | med | No PCH under ccache. | Clang PCH with cache sloppiness. | open |
| BD-7 | med | Every unit receives all feature macros; header folder keyed on all headers. | Per-unit macros and header identity. | open |
| BD-8 | med | Backend units compile once per scene shape. | Capability-independent code in shared units. | open |
| BD-9 | med | `main.cpp` is each large app's critical path. | With GC-10. | open |
| BD-10 | low | Shipping carries SDL software blitting and the MSVC demangler. | Demangler removed. Remaining: SDL blitter references. | partial |
| BD-11 | med | Trimmed SDL records no patch set. | With NT-7. | open |
| BD-12 | low | Two SDL trim options are not options. | Removed; guard requires a declared option. | open |
| BD-13 | low | Packages ship vcpkg SDL's 349 KB licence. | Trimmed SDL notices. | open |
| BD-14 | low | `--plan` failed before generation. | Plan generates first. | open |
| BD-15 | low | Startup failures discarded output. | Output tail; long paths refused. | open |

## Workers (WK)

| ID | Sev | Finding | Resolution | Status |
| --- | --- | --- | --- | --- |
| WK-1 | high | Worker messages with Date/Map/Set/typed views compiled then threw `DataCloneError`. | Structured-clone codecs; unsupported types refuse at generation. | fixed |
