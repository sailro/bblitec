# Repository audit

Scope: the complete repository at `12cd7be`, including previously audited code.
Findings require source evidence and focused checks; a green image gate does
not establish general language coverage or freedom from memory leaks.
`TODO.md` owns future capabilities. This file owns audit defects and closure.

The follow-up implementation is frozen for review. Remaining validation is
listed below; do not restart the audit or expand this batch. A15, A16, the
normalization part of A22 and A28 require separate changes. Evidence labelled
as baseline or audit completion does not validate this follow-up diff.

## Findings and fixes

| ID | Priority | Finding and evidence | Required action | State |
| --- | --- | --- | --- | --- |
| A01 | P1 | Accepted user records, containers and callbacks can contain owning cycles. | Managed allocation tracing and explicit closure environments reclaim tested cycles. Complete generated application validation: specialization, nullable companions and cached native values must report every capture dependency. | In validation |
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
| A15 | P2 | Resource-loop budgets remain advisory (`compiler/statements.ts`): a 64×64 box loop emits 1,601,525 bytes of `main.cpp`. | Separate composition facts from runtime construction, parameterize resource loops, and enforce a total expansion budget when that is impossible. | Open |
| A16 | P2 | `shader-builtins-standard.ts` restates deformation/instance WGSL; shadow/gizmo lowerers restate CSM and geometry math. | Replace transcripts with pinned composition/AST lowering; verify transport and affected depth/shadow/gizmo gates. | Open |
| A17 | P2 | `renderer-lowerer.ts` specializes skybox WGSL with regex/string rewrites despite the shared shader IR. | Typed IR now owns declaration/binding specialization and affine fog relocation. Formatting/name/drift checks pass; scene3 passes both backends with byte-identical baseline images. | Fixed |
| A18 | P2 | Dawn local meshes and shared-cache records allocated GPU resources before ownership was registered (`pal_dawn.cpp`). | Use move-only resource records and register cache ownership before allocation; exercise failed upload, moves and unwinding. Both-backend sweep passed. | Fixed |
| A19 | P2 | Physics and navigation use process-global tables without engine-scoped release (`pal_physics_bullet.cpp`, `pal_navigation_recast.cpp`, `physics-lowerer.ts`). | Owner-scoped worlds/plugins/crowds replace global ownership tables. Real Bullet/Recast checks cover repeated and concurrent owners, stale handles and direct PAL allocation failures. Complete application validation; dependency-internal allocation failure is A28. | In validation |
| A20 | P2 | Audio node/buffer tables retain completed sources until context close (`pal_audio_labsound.cpp`). | Identity-owning handles, recyclable weak registries and a context-owned graph now separate JS/graph retention. Real LabSound tests cover 1,000 discarded one-shots, retained handles/views, filter tails, parameter edges and real-time playback. Complete review and application validation. | In validation |
| A21 | P2 | SDL shader/pipeline and Dawn per-draw binding construction still allocate before ownership is registered (`pal_sdl_gpu.cpp`, `pal_sdl_gpu_frame_graph.cpp`, `DawnDrawState` in `pal_dawn.cpp`). | Immediate shader/pipeline/draw owners cover construction and publication failures; native ownership tests and the 256-target both-backend build sweep passed. A18 covers mesh/cache ownership. | Fixed |
| A22 | P2 | RGBD decoding, normalization thresholds and transmission constants remain handwritten in shared PAL. | RGBD/transmission use pinned AST/typed IR; RGBD checks preserve all 65,536 byte-pair results. Complete application validation. Normalization remains open: preserve GPU float width, thresholds and zero-vector behavior when replacing the remaining formula. | Partial |
| A23 | P2 | PNG/SDL_image remain base dependencies, partly because shipping builds include visual capture; navigation selects a broad library set (`native/CMakeLists.txt`, `native/vcpkg.json`). | Capture is optional; codecs and Recast components follow reach. Core/SVG UI and base/crowd/tile-cache shipping builds run and reject disabled capture. Link inventories confirm partitioning. Complete final backend/sweep checks. | In validation |
| A24 | P2 | Multi-region physics scans the global body table repeatedly (`pal_physics_bullet.cpp`). | Sorted world membership handles pending add/remove/migration and release. Real Bullet trajectory/event/isolation tests and floating-origin gates pass; 32-region velocity-cache benchmark improves from 7.06 to 1.03 ms. | Fixed |
| A25 | P1 | RmlUi builder kept cached FreeType paths after changing dependency roots; a purported static archive still referenced `__imp_FT_*` and failed shipping linkage. | Rediscover cached dependency paths on configure. Rebuilt the affected tree; both shipping packages linked and rendered. | Fixed |
| A26 | P2 | `runNeutralityReport` reported success when current scenes, valid reports or measurement fields were missing (`src/scene-neutrality.ts`). | Fail missing/malformed reports and numeric schema changes, including wobbling scenes. Eleven CLI fixtures passed. | Fixed |
| A27 | P2 | Native CPU capture reported a base matrix before late asset-root transforms (`native/src/pal_render_capture.hpp`); Racer's car pixels changed while captured fields matched. | Share the effective mesh-block builder with both backend uploads; record stage/variant/provenance and deduplicate numeric payloads independently. All 56 captured Racer PBR worlds match the pin. | Fixed |
| A28 | P2 | Injected failure at allocation 25 of a 498-allocation solo-floor Recast build crashes in the pinned dependency. `RecastAlloc.h` has unchecked allocation results in array growth; direct PAL failure coverage does not establish dependency-wide OOM safety. | Isolate the failing stack at pin `599fd0f023181c0a484df2a18cf1d75a3553852e`; correct the dependency's checked allocation path and preserve the reproduction before widening OOM claims. | Open |
| A29 | P2 | Shader cache publication preserved old timestamps when bytes changed, allowing CMake to reuse stale shader snapshots (`tools/compile-shaders.ps1`). | Changed copies now receive a fresh timestamp; identical copies remain untouched. The regression executes the actual PowerShell helpers. Refresh Sandblox's existing deployment and measure parity. | In validation |

## Coverage and evidence

| Area | Checks |
| --- | --- |
| Features | Trace API opt-ins and asset predicates through intrinsic reach, composition, generated manifests and CMake; compare with pinned loader/factory source. |
| Transpiler | Inspect AST/lowering reuse, shader/source text manipulation, repeated emit paths, loop growth, dead exports and dynamic callers. |
| Native | Check shared header dependencies, renderer selection, resource lifetimes and feature-selected subsystem links. |
| Generated C++ | Compile accepted ownership probes; inspect recursion, retained closures, handles, loop emission and resource retirement. |
| Tooling/build | Read cache inputs, diagnostic freshness/exit behavior, dependency manifests, packaging and minimal-build selection. |
| Documentation | Read canonical pages and cross-check limitations against implementation/registry; preserve corpus and goldens. |

Validation evidence is local and reproducible:

- Fresh-main foundation: `C:/Dev/babylonlite-audit-baseline/artifacts/` at
  `12cd7be`, with rebuilt RmlUi. The original audit's completion logs are
  `artifacts/audit/complete-tests.log` and `complete-sweep.log`.
- Follow-up neutrality reference: `artifacts/audit-followup/baseline-parity`;
  compare all 255 registered parity targets. `primitives` is build-only.
- Current unit/native suite: `artifacts/audit-followup/final-tests.log`,
  1,610 passing tests with no skips.
- `artifacts/audit-followup/final-sweep.log`: all 256 scenes generated and built
  with both backends; 254 of 255 parity targets passed. Sandblox refused
  measurement because three deployed skybox shaders were stale. The sweep
  exited with failure and skipped status verification; it is not a green gate.
- `artifacts/audit-followup/dawn-no-capture-verification.json`: final-source
  Dawn-only build rendered, refused disabled capture and excluded image,
  audio, physics and navigation libraries.
- Minimal dependency proof: `artifacts/audit-followup/minimal-verification.json`
  records link libraries, successful runs and explicit capture refusals for
  core/SVG UI and base/crowd/tile-cache navigation. Refresh after native edits.
- Review records in `docs/reviews/` are keyed to the actual diff. The follow-up
  review covered four angles and applied all nine findings.

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
  formulas transpiled. A16 and the open part of A22 identify remaining work.
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

## Remaining validation and handoff

Continue only these bounded checks; further defects should be recorded for a
separate change. The full test suite and both-backend build sweep already ran.

- [x] Focused regression checks and full suite: 1,610 passing, zero skips.
- [x] Four simplify review angles; all nine findings applied.
- [x] Generate and build all 256 registered scenes with both backends.
- [x] Dawn-only build and render with capture disabled.
- [ ] Refresh Sandblox's shader deployment using the normal scene build workflow,
  then run `node dist/src/scene-command.js validate sandblox`. A prior attempt
  to remove two local build stamps was blocked by tool policy and did not run.
- [ ] Resume `node dist/src/scene-command.js validate all` using its checkpoints
  to finish parity and published status verification.
- [ ] Run `node dist/src/scene-command.js neutrality artifacts/audit-followup/baseline-parity`
  for all 255 registered parity targets and `node dist/src/verify-corpus.js`
  for the 948 origin digest rows. Neither final check has run for this batch.
- [ ] Regenerate the core/SVG UI probes from `artifacts/audit/minimal-ui-core.ts`
  and `minimal-ui-svg.ts`; refresh the five static builds with the existing
  `artifacts/audit-followup/build-minimal.mjs`, `build-navigation-minimal.mjs`
  and `smoke-minimal.mjs` scripts, sequentially. Existing core/SVG UI and
  navigation base/crowd/tile-cache results predate the final ownership changes.
- [x] Every deferred defect has a concrete next action.

For native commands, set `CMAKE_COMMAND` as documented in `AGENTS.md`. Do not
rebuild TypeScript during a scene command sequence or run CMake/vcpkg builds
concurrently. Local logs and helper scripts under `artifacts/` are ignored;
the validation counts and limitations above are the portable handoff.
