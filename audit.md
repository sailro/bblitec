# Audit

Scope: activation, pinned-source ownership, compiler reuse, native PALs and patches, generated C++, documentation,
iteration time and minimal packages. Reference: [Babylon Lite pin](upstream/babylon-lite.json).

This file owns audit remediation; [TODO](TODO.md#qualification) owns runtime/platform qualification.
Checked items are implemented and have focused verification. Evidence is in ignored `artifacts/audit-fixes/` and
`artifacts/canvas-layout-fix/`; initial audit probes are in `artifacts/audit-2026-11-09/`.

## Assessment

| Area | Confirmed state | Boundary |
| --- | --- | --- |
| Activation | Reached APIs and pinned loader predicates have separate owners. Skin/morph capability is distinct from animation transport. | Asset joins are conservative; runtime preloads retain the pin's per-mesh thin/VAT exclusions. |
| Engine behavior | Morph-shadow bounds, VAT counting and prepared validation use shared pinned AST lowering. | This does not certify every engine adapter as a whole-function translation. Native resource/record adaptation retains explicit contracts. |
| Compiler | Shared operators, symbols, syntax, storage and evaluation order serve purpose-specific lowerers. Declaration projection uses metadata/tokens; admitted mesh walks use symbol-aware fingerprints. | The compiler remains a bounded TypeScript subset, not a complete JavaScript engine. |
| PALs | Frame phases, synchronization, capture and readback share owners; device commands and resource lifetimes remain backend-specific. | Existing `scene1` compile databases exclude the other renderer's units. Physical renderer removal and every platform/feature combination are not qualified. |
| Patches | Inventory is consistent: 109 patches over seven libraries. All 69 RmlUi patches apply in order to a clean export of its exact pin; the rebuilt artifact records that series. | Applicability is not runtime qualification. No patch was proved obsolete or safe to merge/remove. |
| Memory | Focused ownership, GC, Promise, worker and reclamation fixtures have passing evidence. | No leak-free claim: sanitizer, sustained GPU/library lifetime and generation-exhaustion gates remain below. |
| Builds / size | Feature-driven dependencies, backend-filtered deployment and shipping profiles have passing focused tests. A forced dist rebuild bypasses metadata reuse without bypassing locks. | Current minimum release sizes and optimal native iteration time require controlled measurements. |
| Dead code | Confirmed module-internal exports are local. Dynamic CSG2 entry ownership is explicit. | No unreachable implementation was proved. Manual regression-asset generators remain live. |
| Documentation | Capability boundaries, TODO ownership and source-document references are reconciled. | Measurements stay in status; platform qualification stays in TODO. |

## Remediation

### F1 — morph-shadow policy

- [x] Lower the pinned morph-bounds method through shared body lowering rather than maintain a native formula/guard.

Owner: [morph-shadow-bounds.ts](src/lowering/morph-shadow-bounds.ts). The native adapter supplies cached ranges,
optional weight reads and output storage. Accumulation remains double until the float output boundary.

Verification: [morph-shadow-bounds.test.ts](test/morph-shadow-bounds.test.ts) compares actual pinned/native results
for missing, zero, negative, finite and `NaN` weights, and checks source guard/arithmetic changes. Shadow-refresh
and skeleton-shadow-bounds fixtures also pass. Scene parity is a separate gate below.

### F2 — VAT source ownership

- [x] Lower `clipFrameCount` with the existing pinned-function lowerer.
- [x] Lower prepared-VAT validation predicates/control flow from source; keep native record/upload ownership separate.

Owners: [vat-lowerer.ts](src/lowering/vat-lowerer.ts), [vat-prepared.ts](src/lowering/vat-prepared.ts).
The glTF model supplies duration and an absent own frame rate; the pin selects its default. Native frame-count
narrowing rejects nonfinite/overflowing extents. Upload texture identity, byte copies and resource ownership remain
native adapters.

Shared lowering handles an absent specialized `||` operand without converting its numeric result to a boolean.
[VAT tests](test/vat-lowering.test.ts) exercise source arithmetic/default/validation changes;
[prepared-payload tests](test/render-features.test.ts) compare errors, captures and texture sharing with the pin.

### F3 — geometry deformation activation

- [x] Separate skin/morph capability from the animation/local-vertex transport aggregate.

[Asset specialization](src/asset-specializer.ts) supplies `vertexDeformation`; the
[velocity join](src/asset-feature-join.ts) consumes it. `gpuDeformation` still includes animation transport.

[Packaged-asset tests](test/asset-specializer.test.ts) cover plain, animated, skinned and morphed documents, each
with and without explicit velocity enablement. They check reasons, manifest features and CMake projection.
[Geometry-velocity tests](test/geometry-velocity.test.ts) retain runtime thin/VAT exclusions and shader contracts.

### C1 — structured declaration projection

- [x] Replace declaration/clock regex reparsing with native declaration metadata and existing C++ tokens.

Owners: [native-declarations.ts](src/compiler/native-declarations.ts),
[output-projection.ts](src/compiler/output-projection.ts). Projection preserves complete source spans through
multiline/deferred blocks and indexes candidates by declaration name. Uniform-label storage supplies metadata too.

[Projection tests](test/physics-viewer-lowerer.test.ts) cover templates, optional storage, deferred multiline
initializers, unread clocks and retained observable/effectful initializers. Filename regexes and JavaScript RegExp
support are not source-semantic reparsing and are not removal targets.

### C2 — mesh-walk identity

- [x] Deduplicate admitted walkers by symbol-aware normalized syntax while preserving executable packaging text.

Owners: [syntax.ts](src/compiler/syntax.ts), [handle-collections.ts](src/compiler/handle-collections.ts).
The existing fingerprint visitor owns traversal; locals/parameters normalize, member names and external bindings
remain distinct. The identity map participates in emission rollback.

[Mesh-walk tests](test/gltf-mesh-walks.test.ts) cover actual for-of admission, formatting/comments, alpha-renaming,
different member/external identities, traversal order and journal rollback.

### C3 — exports

- [x] Localize 26 confirmed module-internal exports and remove the redundant `UiMediaConditions` re-export.
- [x] Declare generated child-script entry points explicitly in the advisory export inventory.

`executeCsg2Bake` remains exported with `@dynamicEntryPoint`; the
[inventory](src/unused-exports.ts) recognizes that tag on functions only.
[Tests](test/unused-exports.test.ts) retain ordinary unused-name reporting, inferred types and dynamic imports.
Manual `tools/fixtures/` generators and their live assets are retained.

### B1 — dist reuse

- [x] Provide and test a forced rebuild path for metadata-preserving source restoration.

Command ownership: [development](docs/development.md#core-workflow). The unmodified fast default uses metadata;
forcing a build still acquires the writer gate. [Tests](test/build-if-stale.test.ts) cover preserved size/time,
missing outputs, concurrent writers and compiler failure.

Measured wrapper times on this host: warm no-op 190–208 ms; forced compiler rebuild 26.479 s
(`artifacts/audit-fixes/build-timing.json`). These are not native-build or package-size benchmarks.

### D1–D2 — documentation

- [x] Correct lazy-module await, class/dynamic-`this` method-value and overlay capability boundaries.
- [x] Track unqualified `playroom` physics/fidelity without duplicating measurements.
- [x] Request a reproducible sanitizer lane rather than imply one is maintained.
- [x] Replace stale source references to removed TODO explanations with the owning numeric/physics contracts.
- [x] Keep README/TODO links to this ledger; keep capabilities, deviations and measurements in their owning pages.

Owners: [features](docs/features.md), [TODO](TODO.md), [fidelity](docs/fidelity.md), [status](docs/status.md).

## Shared owners

| Concern | Reuse |
| --- | --- |
| AST bindings, symbols, type facts | `compiler/syntax.ts`, `symbols.ts`, `type-facts.ts` |
| Numeric operators, coercions, Math | `lowering/pinned-operators.ts`, `compiler/math-intrinsics.ts` |
| Storage and evaluation order | `compiler/data-types.ts`, `data-lowering.ts`, `data-sinks/`, `evaluation-order.ts` |
| Pinned numeric bodies / record libraries | `lowering/pinned-function-lowerer.ts`, `pinned-body-lowerer.ts`, `pinned-numeric-lowerer.ts`, `pinned-record-lowerer.ts` |
| PBR/Standard and diagnostic vertex policy | Pinned composers, `PinnedShaderBuilders`, `pinned-material-vertex.ts`; native interfaces in `shader-builtins-standard.ts` |
| Frame, synchronization and image policy | `pal_frame_conductor.hpp`, `pal_scene_synchronize.hpp`, `pal_gpu_frame.*`, `pal_gpu_images.*` |
| Device/resource transport | Separate `pal_sdl_gpu*` and `pal_dawn*` owners |
| Patch order / identity | `native/patches/manifest.json`, `native/patch-identity.cmake` |

Shared array-binding admission serves prepared VAT and pinned record iteration. AST-owned source slicing for
execution is not itself a defect. Do not merge distinct compiler phases or backend lifetimes merely for textual reuse.

## Verification and qualification

- Focused remediation suites: 209 passed, none skipped (`artifacts/audit-fixes/final-focused-tests.log`).
- Full fast suite: 1,159 passed, two platform skips, no failures (`artifacts/audit-fixes/fast-tests.log`).
- TypeScript/tool checks and formatting pass; clang-format checked 724 maintained native files.
- Generated/native clang-tidy passes on both backends: 7,025 invocations cover 14,922 compilation contexts
  (`artifacts/canvas-layout-fix/final-native-lint.log`).
- Unused-export inventory is empty; API pin, patch inventory and local documentation links pass.
- Full dual-backend sweep passes all five stages: 367 scenes generated/built, 366 parity scenes within their gates,
  and published status verified (`artifacts/canvas-layout-fix/full-sweep-2.log`).
- Shader integration: 39 passed, two skipped. Skips require a current matching browser PBR capture and opt-in
  Metal/Vulkan storage-array fixtures on macOS/Linux.
- Saved full/foreground MADs are unchanged on both backends for `scene140`, `scene218`, `scene219`,
  `regression-vat-time`, `regression-vat-bone-texture` and `regression-geometry-velocity-preload`.
- Exact comparison: 350 scenes have identical report cells; 27 of 732 backend MAD rows vary within measured
  repeatability/live-text categories, with no unexcused movement (`artifacts/canvas-layout-fix/mad-comparison-final.log`).
- Repeatability/status regression tests: 33 passed. The measured Dawn-only `scene347` exception is owned by
  [scene-neutrality.ts](src/scene-neutrality.ts); SDL_GPU remains strict.
- Compiler/projection regression suites pass 689 tests, including observed-clock lowering and unread-clock erasure.
- Full native suite: 5,146 passed, no failures, five platform skips (`artifacts/canvas-layout-fix/native-tests.log`).
  Skips cover macOS time zones/motion preferences, Linux motion preferences, Metal workgroup storage and iOS emoji.
- Canvas replaced/shrink-to-fit sizing matches the browser across 31 cases and 37 states, including live backing-size
  changes. The original repaint assertions/deadline and all 64 related canvas/layout tests pass. Owners:
  [canvas PAL](native/src/pal_ui_rml.cpp), [shared RmlUi sizing patch](native/patches/rmlui/0069-replaced-intrinsic-contributions.patch),
  [browser/native fixture](test/ui-canvas-layout.test.ts).
- Four-angle cleanup review: one duplicated binding validator extracted into shared syntax; no other accepted findings.
- Source/Tint pins, reference images and thresholds are unchanged.

Remaining gates:

- [ ] Complete the [sanitizer and platform/lifetime qualification work](TODO.md#qualification).
- [ ] Fault-inject mesh generation exhaustion at `store_mesh_record` and define an exhausted-slot policy.
  Its unsigned increment can wrap; practical stale-handle aliasing is not qualified.
- [ ] Build fresh minimal packages for `scene1`, `tetris`, `minecraft`, `doom` and `trogir-streaming`; inspect link maps,
  source/dependency lists, assets/shaders, notices and startup receipts.
- [ ] Measure cold, warm, one-source-edit and added-scene native builds at fixed concurrency.
- [ ] Qualify input sequences beyond the native fixtures; full-image parity does not establish interaction coverage.

Desktop overlay-port invalidation is covered by install-root fingerprints/configuration checks; mobile triplets use
explicit overlay-aware configure paths. Unknown prebuilt provenance remains owned by TODO, not a new undocumented fallback.
