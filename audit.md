# Repository audit

Scope: the complete repository at `12cd7be`, including previously audited code.
Findings require source evidence and focused checks; a green image gate does
not establish general language coverage or freedom from memory leaks.
`TODO.md` owns future capabilities. This file owns audit defects and closure.

This pass closes the remaining findings without restarting the repository
audit. The combined change passes the full unit/native suite, all 256 native
builds, all 255 both-backend parity gates and published status verification.
Shipping dependency and observing interaction proofs have been refreshed.
The two historical neutrality differences are retained and investigated below;
strict image neutrality is not claimed.

## Findings and fixes

| ID | Priority | Finding and evidence | Required action | State |
| --- | --- | --- | --- | --- |
| A01 | P1 | Accepted user records, containers and callbacks can contain owning cycles. | Managed allocation tracing and explicit closure environments reclaim tested cycles. Specialization, nullable companions and cached native values report capture dependencies; combined application validation passes. | Fixed |
| A02 | P1 | Stored recursive callbacks captured their own shared function (`src/compiler/user-functions.ts`). | Weak internal reference plus owning outward callback; compiled tests cover recursion, escape, identity, self-disposal and reclamation. | Fixed |
| A03 | P1 | Audio handles pack 16-bit indices, while node/context insertion can exceed their range (`native/src/pal_audio_labsound.cpp`). | Reject exhaustion before allocation. Compiled boundary checks passed. | Fixed |
| A04 | P2 | Shared PAL contained handwritten picking shear, matrix multiplication and Euler rotation, plus an extra float store before root translation (`native/src/pal_gpu_shared.hpp`). | Derive arithmetic through pinned lowerers. Mixed-width/picking/TRS tests pass; all 568 measured active root worlds match the executed pin bit for bit. | Fixed |
| A05 | P2 | `ui:rml` always brought LunaSVG through vcpkg and the builder; `ui:inline-svg` did not trim it. | Separate core UI/SVG dependencies and static artifacts. Both shipping packages link and render; core excludes LunaSVG. | Fixed |
| A06 | P2 | `validationShaderInput` ignored DXC codegen DLLs, bypassing the correctly keyed inner cache. | DLL installation/replacement invalidates D3D12/Vulkan checkpoints; Metal ignores DXC. Regression passed. | Fixed |
| A07 | P2 | `runMemoryReport` succeeded for unmeasured loops, lacked durable reports and accepted conflicting replay flags. | Fail incomplete/unordered/missing samples; write shared-format JSON/raw trace; validate arguments. Runtime checks cover measured and unmeasured loops. | Fixed |
| A08 | P2 | `validateRecord` accepted arbitrary/duplicate angle names. | Require all four distinct review angles. Regression passed. | Fixed |
| A09 | P2 | Baseline compiler UI test reads `pal_ui_rml.cpp` after defaults moved to `pal_ui_defaults.hpp`. | Point the assertion at its source owner. | Fixed |
| A10 | Setup | Installed RmlUi lacked the latest patch after main was pulled. | Rebuilt pristine-main RmlUi; font test and all scene gates passed. Not a source defect. | Resolved |
| A11 | P2 | Documentation repeats history and contradicts current math, picking, sprite-atlas, UI-driver and corpus support. | Consolidated canonical pages/TODO, removed history and 81 obsolete review records, retained current limitations and verified measured tables. | Fixed |
| A12 | P1 | Opacity conversion in our RmlUi patch rounded RGB but truncated alpha: white at opacity 0.5 became `(128,128,128,127)`. | Round effective alpha consistently; test all 256 alpha values at seven opacities. Rebuilt-library and full-page parity checks passed. | Fixed |
| A13 | P2 | `tools/build-if-stale.mjs` skipped compilation when emitted JS was deleted but the input stamp remained. | Persist actual compiler outputs with the input stamp; missing outputs/malformed inventories rebuild. Black-box regression passed. | Fixed |
| A14 | P2 | Dawn-only `process` required and invoked offline Tint/DXC despite consuming WGSL. | Skip offline preflight/compilation unless the user requests a target. A Dawn-only process succeeded with nonexistent DXC/Tint paths. | Fixed |
| A15 | P2 | Resource-loop budgets remain advisory (`compiler/statements.ts`): a 64×64 box loop emits 1,601,525 bytes of `main.cpp`. | Fixed-composition loops now construct natively: the grid emits 1,776 bytes and executes all 4,096 boxes. Cardinality survives alias withdrawal, assignment and rebinding; runtime resources preserve composition alternatives without stale singleton identity. Hard expansion/table limits remain. The complete application matrix passes. | Fixed |
| A16 | P2 | `shader-builtins-standard.ts` restates deformation/instance WGSL; shadow/gizmo lowerers restate CSM and geometry math. | Pinned templates/fragments and ASTs now supply the arithmetic, including PAL's parked-instance predicate. Observing local/world and bounding-target replays caught and fixed world-mode orientation restoration and SDL pick-stencil cycling. Final-source GPU-debug replays and all affected scene gates pass. | Fixed |
| A17 | P2 | `renderer-lowerer.ts` specializes skybox WGSL with regex/string rewrites despite the shared shader IR. | Typed IR now owns declaration/binding specialization and affine fog relocation. Formatting/name/drift checks pass; scene3 passes both backends with byte-identical baseline images. | Fixed |
| A18 | P2 | Dawn local meshes and shared-cache records allocated GPU resources before ownership was registered (`pal_dawn.cpp`). | Use move-only resource records and register cache ownership before allocation; exercise failed upload, moves and unwinding. Both-backend sweep passed. | Fixed |
| A19 | P2 | Physics and navigation use process-global tables without engine-scoped release (`pal_physics_bullet.cpp`, `pal_navigation_recast.cpp`, `physics-lowerer.ts`). | Owner-scoped worlds/plugins/crowds replace global ownership tables. Real Bullet/Recast checks cover repeated and concurrent owners, stale handles and direct PAL allocation failures. Combined application validation passes; dependency-internal allocation failure is A28. | Fixed |
| A20 | P2 | Audio node/buffer tables retain completed sources until context close (`pal_audio_labsound.cpp`). | Identity-owning handles, recyclable weak registries and a context-owned graph now separate JS/graph retention. Real LabSound tests cover 1,000 discarded one-shots, retained handles/views, filter tails, parameter edges and real-time playback. Combined review and application validation pass. | Fixed |
| A21 | P2 | SDL shader/pipeline and Dawn per-draw binding construction still allocate before ownership is registered (`pal_sdl_gpu.cpp`, `pal_sdl_gpu_frame_graph.cpp`, `DawnDrawState` in `pal_dawn.cpp`). | Immediate shader/pipeline/draw owners cover construction and publication failures; native ownership tests and the 256-target both-backend build sweep passed. A18 covers mesh/cache ownership. | Fixed |
| A22 | P2 | RGBD decoding, normalization thresholds and transmission constants remain handwritten in shared PAL. | RGBD/transmission use pinned AST/typed IR. Normalization now projects the same pinned vertex template through the C++ shader emitter, preserving f32 division, the strict threshold and zero result across 100,000 float-pattern probes. The guard is an explicit fidelity adaptation. Combined application validation passes. | Fixed |
| A23 | P2 | PNG/SDL_image remain base dependencies, partly because shipping builds include visual capture; navigation selects a broad library set (`native/CMakeLists.txt`, `native/vcpkg.json`). | Capture is optional; codecs and Recast components follow reach. Refreshed core/SVG UI, base/crowd/tile-cache and Dawn-only builds render and explicitly reject disabled capture. Actual link inventories confirm partitioning; the complete backend matrix passes. | Fixed |
| A24 | P2 | Multi-region physics scans the global body table repeatedly (`pal_physics_bullet.cpp`). | Sorted world membership handles pending add/remove/migration and release. Real Bullet trajectory/event/isolation tests and floating-origin gates pass; 32-region velocity-cache benchmark improves from 7.06 to 1.03 ms. | Fixed |
| A25 | P1 | RmlUi builder kept cached FreeType paths after changing dependency roots; a purported static archive still referenced `__imp_FT_*` and failed shipping linkage. | Rediscover cached dependency paths on configure. Rebuilt the affected tree; both shipping packages linked and rendered. | Fixed |
| A26 | P2 | `runNeutralityReport` reported success when current scenes, valid reports or measurement fields were missing (`src/scene-neutrality.ts`). | Fail missing/malformed reports and numeric schema changes, including wobbling scenes. Eleven CLI fixtures passed. | Fixed |
| A27 | P2 | Native CPU capture reported a base matrix before late asset-root transforms (`native/src/pal_render_capture.hpp`); Racer's car pixels changed while captured fields matched. | Share the effective mesh-block builder with both backend uploads; record stage/variant/provenance and deduplicate numeric payloads independently. All 56 captured Racer PBR worlds match the pin. | Fixed |
| A28 | P2 | Injected failure at allocation 25 of a 498-allocation solo-floor Recast build crashes in the pinned dependency. `RecastAlloc.h` has unchecked allocation results in array growth; direct PAL failure coverage does not establish dependency-wide OOM safety. | The adopted checked-allocation patch fixes the unchanged pin's failing growth and partial construction. All 498 observed build allocations, 53 vector-failure cases and 16 query-allocation cases preserve cleanup/retry contracts. Development/static libraries and applications are rebuilt; shipping and both-backend application gates pass. | Fixed |
| A29 | P2 | Shader cache publication preserved old timestamps when bytes changed, allowing CMake to reuse stale shader snapshots (`tools/compile-shaders.ps1`). | Changed copies receive a fresh timestamp; identical copies remain untouched. The actual PowerShell helpers are covered. Normal Sandblox processing refreshed deployment and passed both-backend full-page and canvas gates. | Fixed |

## Coverage and evidence

| Area | Checks |
| --- | --- |
| Features | Trace API opt-ins and asset predicates through intrinsic reach, composition, generated manifests and CMake; compare with pinned loader/factory source. |
| Transpiler | Inspect AST/lowering reuse, shader/source text manipulation, repeated emit paths, loop growth, dead exports and dynamic callers. |
| Native | Check shared header dependencies, renderer selection, resource lifetimes and feature-selected subsystem links. |
| Generated C++ | Compile accepted ownership probes; inspect recursion, retained closures, handles, loop emission and resource retirement. |
| Tooling/build | Read cache inputs, diagnostic freshness/exit behavior, dependency manifests, packaging and minimal-build selection. |
| Documentation | Read canonical pages and cross-check limitations against implementation/registry; preserve corpus and goldens. |

Validation evidence is local and reproducible. Focused runs cover earlier
implementation checkpoints; the final combined results are identified explicitly:

- Original neutrality reference: `artifacts/audit-followup/baseline-parity`.
  It contains all 255 registered parity targets and eight retired diagnostic
  targets; `primitives` is build-only.
- This change's pre-run snapshot: `artifacts/audit-remaining/baseline-parity`,
  exactly the 255 registered targets. `baseline-inventory.json` preserves their
  source paths and SHA-256 digests.
- `artifacts/audit-remaining/complete-focused.log`: 261 integrated compiler,
  shader and native checks passed without skips at the initial integration.
  `simplify-focused.log` adds the shared-lowering cleanup checks.
- `artifacts/audit-remaining/final-tests.log`: the final combined unit/native
  suite passes all 1,733 tests without failures or skips.
- `artifacts/audit-remaining/final-sweep-with-scene-defaults.log`: all 256 native
  targets build, all 255 differential targets pass their existing SDL_GPU/Dawn
  gates, and published status verifies. All five validation stages pass.
- `artifacts/audit-a15-cardinality/assignment-*.log` covers final cardinality
  and alias fixes, including private generation of unchanged Sandblox.
  `artifacts/array-cardinality-assignment-check/check.exe` exercises eleven
  alias/rebinding controls. The separate grid fixture executes 4,096 native
  constructions; CSM capacity probes check bounds before span construction.
- `artifacts/audit-a15-cardinality/mixed-receivers-colour-proof.json` records
  both plain and receiving PBR colour variants, excluding caster-only views.
- `artifacts/audit-followup/recast-a28-verification.json` records the unchanged
  dependency pin, original failing stack, patch/library hashes, allocation
  outcomes and sequential dynamic/static dependency rebuilds. Its 498 calls
  belong to one solo-floor input, not dependency-wide OOM coverage.
- `artifacts/audit-gizmo-interaction/final-debug/verification.json` asserts six
  interaction phases at its recorded build on both backends with GPU validation:
  local/world pointer drags, bounding-target movement/nonuniform scaling,
  unchanged camera and changed rendered images. No GPU errors were reported.
- `artifacts/audit-remaining/corpus-verify.log`: all 948 origin digest rows
  match; the separate generated row verifies by provenance.
- The four cleanup angles and final source-delta reviews are complete; all sixteen
  findings were applied. The matching record lives in `docs/reviews/`.
  Correctness follow-ups closed the material-count, runtime mesh-identity and
  array-alias/cardinality regressions.
- `artifacts/audit-a15-sweep-repairs/generation-results.json` covers the eleven
  repaired unchanged corpus inputs. Scene 20 retains 2,500 meshes and 150 PBR
  materials with native construction; Scene 90's immutable CSG streams are
  hoisted without weakening the iteration or code-expansion limits.
- `artifacts/audit-remaining/antigravity-validate.log` records both-backend
  presentation after repairing scene defaults lost through runtime collections.
  The native alias fixtures cover mixed enabled/disabled scenes, both collection
  orders, runtime population, conditional selection and repeated registration.
  The generated default graph is shared rather than copied at every call site.
- `artifacts/audit-remaining/shipping-refresh.log` and
  `artifacts/audit-followup/minimal-verification.json`: all five static builds
  render and reject disabled capture. Actual links separate core UI from SVG
  and navigation base from crowd/tile-cache dependencies. The refreshed
  `dawn-no-capture-verification.json` confirms the Dawn-only build renders,
  rejects capture and excludes optional image/audio/physics/navigation links.

Both neutrality commands retain a nonzero result rather than hiding moved
cells. Against the pre-run snapshot, only Scene 145's Dawn raw measurements
move, returning to the original audit-baseline values. Its paired capture
matches all 70 represented native uniform fields and 51 shader arms; five
current multisampled runs and five single-sample runs are each byte-stable.
These checks do not establish a precision floor or reproduce the historical
change in total error.

Against the original audit baseline, only the floating-origin regression's
raw measurements move. They exactly match this pass's pre-run snapshot and
the already-recorded `artifacts/audit-followup/resume-neutrality.log`; the
current paired capture matches all 19 represented native fields and both
shader arms. The diagnostic reports and stability images are retained under
`artifacts/audit-remaining/neutrality-*` and `artifacts/parity/scene145/`.
No neutrality exemptions, corpus inputs, references or thresholds were changed.

Preserve corpus inputs, all 948 origin digest rows, references and thresholds.
Measured process memory is diagnostic evidence, not a proof of leak freedom.

Upstream RmlUi discussions: [spacing](https://github.com/mikke89/RmlUi/issues/1003),
[absolute sizing](https://github.com/mikke89/RmlUi/issues/1004),
[background painting](https://github.com/mikke89/RmlUi/issues/1005), and
[byte rounding](https://github.com/mikke89/RmlUi/issues/1006).

## Architectural conclusions

- API and asset activation are both intentional upstream mechanisms: explicit
  factories/setters register optional hooks; loaders discover extensions from
  document predicates. Preserve that distinction. `feature-activation.ts`
  records runtime reach, asset capabilities, codecs and actual emitted choices.
- PBR/Standard composition already executes pinned builders and loader extension
  mapping. Reuse it; assertions around handwritten formulas do not make those
  formulas transpiled. A16 and A22 now use derived arithmetic while retaining
  explicitly documented transport and platform adaptations.
- Native API/TU separation allows selecting either renderer; shared platform
  services still require SDL. Validate real single-backend configurations in
  addition to reading guards. Share generated semantics and resource-neutral
  planning; backend resource ownership remains backend-specific.
- Follow the [runtime ownership contract](docs/architecture.md#runtime-and-memory).
  A01 validates retained graph reclamation; coarse memory reports cannot prove
  general leak freedom.
- Export scanning is advisory: `executeModuleGraphCall` has a real caller in
  generated subprocess text (`compiler/module-json-sync.ts`). It was retained.
- RmlUi patches are compatibility adaptations with different upstream status:
  padding-box background paint is documented RCSS behavior, byte rounding is
  not specified by CSS, and fractional-spacing work covers the default engine.
  Upstream discussions must state those distinctions and measured limitations.

## Completed validation

The bounded checks below use regenerated final source. Historical movement
remains visible in the neutrality reports and is investigated above, not
removed by changing inputs or widening thresholds.

- [x] A15 compact resource construction, cumulative budgets and compiled grid.
- [x] A22 pinned numeric projection and f32/threshold/degenerate-vector checks.
- [x] A28 original failure reproduction, checked allocation paths and rebuilt
  development/static navigation libraries.
- [x] Finish A16 PAL predicate wiring and observing local/world gizmo and
  bounding-target interaction on both backends.
- [x] Complete the combined correctness review and four simplify angles;
  apply findings and record the actual diff.
- [x] Run the full unit/native suite on final source without skips.
- [x] Refresh Sandblox's deployed shaders through the normal scene workflow.
- [x] Generate/build all 256 scenes, measure all 255 parity targets on both
  backends and verify published status with `scene -- validate all`.
- [x] Compare both neutrality baselines and investigate unexpected moved cells.
- [x] Verify all 948 origin digest rows and preserve the corpus/reference inputs.
- [x] Regenerate `artifacts/audit/minimal-ui-core.ts` and `minimal-ui-svg.ts`;
  refresh the five static builds with `artifacts/audit-followup/build-minimal.mjs`,
  `build-navigation-minimal.mjs` and `smoke-minimal.mjs`, sequentially. Render in
  test-pass mode, confirm disabled-capture refusal and inspect actual links.
- [x] Refresh the Dawn-only no-capture build and its dependency proof.

For native commands, set `CMAKE_COMMAND` as documented in `AGENTS.md`. Do not
rebuild TypeScript during a scene command sequence or run CMake/vcpkg builds
concurrently. Local logs and helper scripts under `artifacts/` are ignored;
the validation counts and limitations above are the portable handoff.

## Subsequent review findings

These findings were identified after the completed audit above.

| ID | Priority | Finding and evidence | Required action | State |
| --- | --- | --- | --- | --- |
| A30 | P2 | Physics raycasts accepted the pin's default/explicit `shouldHitTriggers: false`, but Bullet's closest-hit callback still selected nearer trigger bodies. | Carry the boolean through generated code and filter trigger objects alongside both collision masks before closest-hit selection. The old-code native fixture reproduced the wrong body; pinned Havok and actual Bullet checks now cover omitted/false/true/runtime options, trigger-only misses, body identity, masks and live flag toggles. | Fixed |
