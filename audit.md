# Repository audit

Scope: the complete repository at `12cd7be`, including previously audited code.
Findings require source evidence and focused checks; a green image gate does
not establish general language coverage or freedom from memory leaks.
`TODO.md` owns future capabilities. This file owns audit defects and closure.

## Findings and fixes

| ID | Priority | Finding and evidence | Required action | State |
| --- | --- | --- | --- | --- |
| A01 | P1 | `Ref<T>` uses reference counting, and accepted user records can contain owning cycles (`native/include/bblite/js_data.hpp`; accepted self-link probe). | Define and enforce cycle ownership; verify reclamation for self-links, mutual links and callback/record cycles. | Open |
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
| A17 | P2 | `renderer-lowerer.ts` specializes skybox WGSL with regex/string rewrites despite the shared shader IR. | Transform declarations, bindings, identity-world and fog nodes through the common IR; test formatting/name changes and semantic drift. | Open |
| A18 | P2 | Dawn local meshes and shared-cache records allocated GPU resources before ownership was registered (`pal_dawn.cpp`). | Use move-only resource records and register cache ownership before allocation; exercise failed upload, moves and unwinding. Both-backend sweep passed. | Fixed |
| A19 | P2 | Physics and navigation use process-global tables without engine-scoped release (`pal_physics_bullet.cpp`, `pal_navigation_recast.cpp`, `physics-lowerer.ts`). | Introduce owner-scoped sessions and complete body/shape/crowd/plugin disposal; test repeated and concurrent engines. Global clearing would invalidate another engine's handles. | Open |
| A20 | P2 | Audio node/buffer tables retain completed sources until context close (`pal_audio_labsound.cpp`). | Define recyclable handles that distinguish JS ownership, graph retention and finished sources; test sustained one-shot playback with retained old handles. | Open |
| A21 | P2 | SDL shader/pipeline and Dawn per-draw binding construction still allocate before ownership is registered (`pal_sdl_gpu.cpp`, `pal_sdl_gpu_frame_graph.cpp`, `DawnDrawState` in `pal_dawn.cpp`). | Introduce immediate owners at construction boundaries; inject failures between allocations and publication. A18 closes mesh/cache ownership only. | Open |
| A22 | P2 | RGBD decoding, normalization thresholds and transmission constants remain handwritten in shared PAL. | Derive expressions/constants from pinned source or typed shader IR; preserve GPU float width and verify decoded bytes. | Open |
| A23 | P2 | PNG/SDL_image remain base dependencies, partly because shipping builds include visual capture; navigation selects a broad library set (`native/CMakeLists.txt`, `native/vcpkg.json`). | Separate capture from shipping capabilities; derive image codecs and navigation libraries from reach. Compare cold builds, linker maps and payloads. | Open |
| A24 | P2 | Multi-region physics scans the global body table repeatedly (`pal_physics_bullet.cpp`). | Maintain world-owned membership through add/remove/migration; verify trajectories/events and benchmark multiple populated regions. | Open |
| A25 | P1 | RmlUi builder kept cached FreeType paths after changing dependency roots; a purported static archive still referenced `__imp_FT_*` and failed shipping linkage. | Rediscover cached dependency paths on configure. Rebuilt the affected tree; both shipping packages linked and rendered. | Fixed |
| A26 | P2 | `runNeutralityReport` reported success when current scenes, valid reports or measurement fields were missing (`src/scene-neutrality.ts`). | Fail missing/malformed reports and numeric schema changes, including wobbling scenes. Eleven CLI fixtures passed. | Fixed |
| A27 | P2 | Native CPU capture reported a base matrix before late asset-root transforms (`native/src/pal_render_capture.hpp`); Racer's car pixels changed while captured fields matched. | Share the effective mesh-block builder with both backend uploads; record stage/variant/provenance and deduplicate numeric payloads independently. All 56 captured Racer PBR worlds match the pin. | Fixed |

## Coverage and evidence

| Area | Checks |
| --- | --- |
| Features | Trace API opt-ins and asset predicates through intrinsic reach, composition, generated manifests and CMake; compare with pinned loader/factory source. |
| Transpiler | Inspect AST/lowering reuse, shader/source text manipulation, repeated emit paths, loop growth, dead exports and dynamic callers. |
| Native | Check shared header dependencies, renderer selection, resource lifetimes and feature-selected subsystem links. |
| Generated C++ | Compile accepted ownership probes; inspect recursion, retained closures, handles, loop emission and resource retirement. |
| Tooling/build | Read cache inputs, diagnostic freshness/exit behavior, dependency manifests, packaging and minimal-build selection. |
| Documentation | Read canonical pages and cross-check limitations against implementation/registry; preserve corpus and goldens. |

Fresh baseline: pristine `12cd7be` in an isolated worktree, after rebuilding
RmlUi. All 256 build targets passed generation (99 s), shaders (68 s) and
both-backend builds (466 s); 255 parity targets passed differential comparison
(206 s) and status verification. `primitives` is the sole target without parity.
The full test suite passed 1,559/1,560 with no skips; its only failure was A09.
The earlier font/lazy-test failures did not recur. Baseline logs/reports live
under `C:/Dev/babylonlite-audit-baseline/artifacts/`; focused audit evidence is
under `artifacts/audit/`. Corpus origin verification passed all 948 digest rows.

Shipping probes use a visual-only sphere plus core UI or inline SVG. Their
SDL-only static executables are 4,226,048 and 4,622,336 bytes; packaged ZIPs
are 2,201,580 and 2,396,896 bytes. Core has no LunaSVG/PlutoVG link entries;
neither package includes audio/physics/navigation libraries or runtime DLLs.
Both packaged executables produced inspected screenshots. Remaining baseline
PNG/capture costs are A23, so these are measured trims, not optimal-size claims.

Four independent simplify angles covered the complete diff. Applied findings
remove matrix adapters/dead glTF wiring, reuse shared function lowering, rely
on owning mesh destructors, retain callback identity without recursive heap
allocation, persist compiler outputs, and remove duplicate docs/unused metadata.
The final incremental review also removed repeated draw-convention lookups
and metadata-dependent duplication in numeric reports. All nine simplify
findings were applied. After regeneration, the full suite passed 1,578/1,578,
with no skips (`artifacts/audit/complete-tests.log`).

The final scene sweep passed generation for 256 targets (87 s), both-backend
builds for 256 targets (157 s), differential parity for 255 targets (179 s)
and published status verification; offline shaders reused their valid cache.
Evidence: `artifacts/audit/complete-sweep.log`. Separate coverage
validation checked all 765 reports against current generated stamps. Neutrality
comparison found 241 identical scenes, ten with previously measured variation
and four application demos with changed pixels; no coverage was skipped.

Doom, Voxel Sandbox and Platformer's UI-free images stayed byte-identical;
their full-page changes follow corrected RmlUi opacity rounding. Racer's car
also changes because its small simultaneous pitch/yaw/roll exposed the old
rotation order. A controlled single-binary old/new switch reproduced both
images exactly; full root composition and capture were then checked against
the executed pin. Racer canvas MAD rounds to 0.004 on both backends, previously
0.003. This is a semantic correction, not an image-neutral change or a claim
that every golden metric improves. References and thresholds were preserved.

The measured memory probe completed 300 Dawn frames with 0.0 MB post-warm-up
working-set growth; the scene-less scene 74 loop correctly failed as unmeasured.
Both wrote JSON and raw traces. These checks validate the reporter, not lifetime
correctness for every program.

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
  formulas transpiled. A16/A17 identify remaining independent implementations.
- Native API/TU separation allows selecting either renderer; shared platform
  services still require SDL. Validate real single-backend configurations in
  addition to reading guards. Share generated semantics and resource-neutral
  planning; backend resource ownership remains backend-specific.
- Typed handles, checked byte views and RAII prevent several error classes, but
  reference counting cannot reclaim arbitrary accepted object cycles. A01 is
  a confirmed leak, not hypothetical future JavaScript coverage. Memory reports
  are coarse diagnostics; they cannot prove general leak freedom.
- Export scanning is advisory: `executeModuleGraphCall` has a real caller in
  generated subprocess text (`compiler/module-json-sync.ts`). It was retained.
- RmlUi patches are compatibility adaptations with different upstream status:
  padding-box background paint is documented RCSS behavior, byte rounding is
  not specified by CSS, and fractional-spacing work covers the default engine.
  Upstream discussions must state those distinctions and measured limitations.

## Completion checks

- [x] Focused regression checks for applied code changes.
- [x] Four simplify review angles over the complete diff; findings resolved.
- [x] Full test suite, registered scene generation/build and differential parity.
- [x] Published status verification and parity baseline comparison.
- [x] Core-UI/SVG minimal dependency checks and standalone backend builds.
- [x] Every remaining defect has a concrete next action.
