# AUDIT — 2026-08-24

Findings of the six-axis audit at main `e065f59`, covering the 113 commits since
the 2026-08-19 audit closed (PR #83). Same rules as [TODO](TODO.md): entries are
unfinished work, stated with the facts needed to act; **fixing an entry deletes
it**. Every claim was file:line-verified at the baseline commit; line numbers
drift with edits, the named symbols do not.

Severity: **defect** = wrong today; **drift** = correct today, agrees with the
pin only until upstream changes it; **debt** = violates a house rule or costs
time; **cleanup** = small. IDs keep their audit-axis prefixes (FA/RD activation
and re-derivation, TR transpiler, NA native, TL tooling, BU build, DOC docs).

## Verified sound at this baseline — do not re-audit

- **PAL isolation, re-proven over every post-08-19 surface** (billboard, splat,
  effect, sprite, physics): CMake TU selection, zero cross-backend include
  edges, stubs whose existence turns a selection mistake into a compile-time
  redefinition error, SDL_gpu.h unreachable from Dawn TUs, physics TU
  backend-free. Semantic content ≥95% single-sourced; the per-backend ~23k
  lines are the sanctioned API sequences.
- **Activation triggers mirror the pin everywhere.** Every new family opts in
  at the pin's own factory call / lazily-registered hook; zero second
  detectors, option scans, or text sniffs. The scene-source-vs-asset ownership
  rule held; the asset-join exceptions are still exactly the documented two.
- **No new formula transcriptions.** Five of seven new lowerers are AST folds
  or executed pins; the restaters anchor their folds structurally. The
  "do not type a shader formula out" rule held completely.
- **Tooling core is coherent.** One flag parser (unknown flags error
  everywhere), one backend story, one filename token, one report writer, one
  measured-run spawner, one browser-execution service (one `chromium.launch`),
  one PNG/MAD library; every new subcommand was built on the shared helpers.
- **Dead code is ~zero.** `lint:exports` reports only fixture false positives;
  every generated artifact has a reader; every tool script is referenced; the
  prior audit's dead-feed closures (`sheenAlbedoScaling`/`clearcoatF0Remap`
  now live end-to-end, `pinnedHelpers` gone, flip-era flags gone) held.
- **Docs' mechanical facts verify**: pin pair, curated count (134 ×2),
  status rows, all 143 previews, scripts, subcommands, flags, env vars, paths,
  anchors, and ~20 spot-checked code claims.
- Patch hygiene (LF pinned by `.gitattributes`, overlay versions in lockstep,
  single baseline copy) and the concurrency docs match the code exactly.
- Two 08-19 leftovers closed without entries: the factor-bake double-treatment
  is lowered from the pin with its animated-base-colour hazard handled and
  measured; the glTF-spec sampler defaults remain proof-guarded plumbing
  (`assertAbsentSubstitution`).

## Defects

- [ ] **BU-1 — min-SDL proof pending.** `build-sdl-min.ps1` now applies the
  two project patches after checkout (it previously built stock
  `release-3.4.14`, which rejects the MSAA colour target
  `pal_sdl_gpu.cpp` requests unconditionally); what remains is the proof:
  rebuild `artifacts\tools\sdl-min` with the changed script and run one
  minimal scene-1 build to a frame. The published 2.2 MB scene-1 measurement
  predates both patches and should be refreshed by the same run. Effort: one
  build.
- [ ] **TL-1 / NA-8 — The native render capture cannot see the newest
  renderable families, so `diff` (rung 3) is blind for ~20 shipped scenes.**
  `pal_render_capture.hpp` writes the mesh render plan plus a dedicated splat
  writer and nothing else; `runtime.hpp` holds sprite layers, billboard
  systems, sprite renderers, effect wrappers/renderers as first-class
  renderables. A sprite-only scene refuses `capture --native` outright
  (`src/capture-native.ts`), and a mixed scene (billboards over meshes, node
  particles, effect tasks) produces a capture whose draw census omits those
  draws — `diff` then reports browser-only draw shapes on a byte-exact scene,
  the false-finding class the tool exists to kill. Fix: one writer per family
  mirroring `write_splat_draw_list` (the uniform pairing in `render-diff.ts`
  is generic; splats needed no diff-side change), then drop the no-PBR-plan
  refusal. Effort M (each family S).
- [ ] **TR-4 — `light-lowerer.ts` translates the pinned light matrix at the
  wrong float width and with a NaN-dropping `||`.** Its private walker emits
  `float` locals where the pinned `localMatrixFromDirection` computes JS
  doubles and rounds only at the `Float32Array` stores — the exact class the
  mesh-builder precision fix closed in `factory-lowerer` (scene 23 max error
  33 → 1) — and lowers `||` to a local `value != 0.0f ? value : fallback`,
  missing the NaN arm the shared `bbl::js::or_number` carries
  (`pinned-numeric-lowerer.ts` names this exact trap in a comment). Gates
  measure 0.000 today because every reached light direction is exactly
  representable. Fix: migrate `lowerMatrix` onto `PinnedNumericLowerer`
  (double locals, `or_number`); this is not byte-neutral by design, so it
  takes the parity matrix, not the digest. Effort S–M.
- [ ] **BU-3 — Generator-triggered reconfigures bypass the vcpkg configure
  lock.** `serializeConfigure` wraps only the explicit `cmake -S` call; when
  `CMakeLists.txt` or a scene's `features.cmake` is newer than the cache,
  `cmake --build` re-runs CMake itself — inside the up-to-32-way parallel
  build stage — and a change that flips a vcpkg manifest feature across many
  scenes (codec detection, a physics rollout) triggers concurrent vcpkg
  manifest installs sharing one download/binary cache, the documented
  unreliable condition. Fix: treat that staleness as a cache mismatch and run
  the configure explicitly under the lock before building. Precondition for
  the shared-vcpkg TODO entry. Effort S–M.

## Drift exposure (port-do-not-re-derive, new instances)

The pattern across all three: where a family **emits its constants into
generated code** (billboards) drift is guarded; where a **PAL types them per
backend** (splats, effects) it is not. The fix shape is always "emit it once".

- [ ] **RD-2 / NA-4 — Splat GPU constants are re-typed in both PALs with no
  pin assertion.** The pinned quad `[-2,-2, 2,-2, 2,2, -2,2]`, indices
  `[0,1,2, 0,2,3]`, and nearest/clamp sampler
  (`gaussian-splatting-mesh.ts`) exist as per-backend literals in
  `pal_dawn_splat.hpp` and `pal_sdl_gpu_splat.hpp`, comment-tied only; the
  payload order {centers, cov_a, cov_b, colors} and the ALPHA_COMBINE blend
  are likewise spelled per backend instead of travelling as data the way
  `transparent_blend` does. The billboard family already does this right
  (asserted against the pin, emitted once). The quad half-extent is semantics
  — it is the domain of the fragment's `exp(-dot(k,k))` kernel. Fix: emit
  quad/indices/sampler/blend/payload-order from `splat-lowerer.ts` into the
  generated splat unit both PALs already consume. Effort S.
- [ ] **RD-3 / NA-12 — The effect drivers re-type the pinned surface sample
  count.** Pinned `surface.ts` declares `msaaSamples === 1 ? 1 : 4`; the
  scene renderer reads the 4 from the pin into generated
  `preferred_sample_count()`, but `pal_sdl_gpu_effect.cpp` and
  `pal_dawn_effect.cpp` hardcode `single_sample ? 1 : 4` — and an effect-only
  scene compiles no renderer TU, so nothing generated carries the value
  there. Armed, not detonated (explicit `msaaSamples: 1` still refuses —
  scene 51's tracked blocker). While there: the effect texture-by-name lookup
  + not-set refusal is duplicated ~12 lines per backend
  (`pal_*_effect.hpp`). Fix: emit `preferred_sample_count()` for effect-only
  scenes from the same pinned read; share the texture lookup. Effort S.
- [ ] **RD-4 — Scene-code material defaults are unanchored triplicates: the
  UBO-writer lowerer discards every mapped `?? default`.**
  `pinned-ubo-writer-lowerer.ts` lowers `x ?? d` to `x` alone for a
  record-mapped property ("the record always carries a value"), throwing away
  the pin's default expression it is holding — so the ~80 numeric defaults in
  the pinned PBR writers (`?? 1` clearcoat intensity, the iridescence
  1.0/1.3/100/400 quartet, sheen, subsurface, anisotropy…) are restated as
  bare literals in `compiler/intrinsics/material-options.ts` with no pin
  access, and a third time as `runtime.hpp` member initializers. A pin bump
  that moves one default moves the browser reference and not the native
  record — a silent parity split visible only when a corpus scene omits that
  exact option. The repo already owns the right mechanism twice: the glTF
  lane's `GltfLoweredDefault` and physics' `pinned_default_gravity()`. Fix:
  evaluate the discarded default into a generated
  `pinned_material_defaults` header and have the intrinsics emit the symbol
  (matrix-validated), or minimally assert value-equality at the discard
  against a table the intrinsics consume (guard-only). The billboard lane's
  `DEFAULT_CAPACITY` shares the pattern one size down: value-checked on the
  sprite-2D lane, shape-only on the billboard lane, restated in
  `intrinsics/sprite.ts` and `runtime.hpp`. Effort M (guard S).
- [ ] **RD-5 — `pinned_depth_clear` is hand-typed one line under its
  pin-read twin.** `pinned-depth-state.ts` reads `REVERSE_DEPTH_COMPARE`
  from the pin with an enumerator-refusal table, then types
  `pinned_depth_clear = 0.0f` as a literal; the pin declares
  `_depthClearValue` as readably as the compare. Read it the same way.
  Byte-neutral, digest-provable. Effort S.
- [ ] **RD-6 — A pre-audit compensating pair: `bump_scale` is inverted
  twice.** The `.babylon` loader template stores `1/level`
  (`templates/babylon-loader-cpp.ts`) and `pinned-standard-variants.ts`
  inverts it back at composition; removing both is byte-identical. Sits
  before this audit's baseline — the one live instance of the historical
  cancelling-pair class. Effort S, digest-provable.
- [ ] **FA-2 — The activation inventory lags the new families across its
  other three mechanisms.** Emit-option rows missing: `gpuInstanceColors`,
  `pinnedSkeletonPalette` (a real per-scene transport selection),
  `spriteCustomShaders`, `effects`, `plainSpriteLayer`/`plainBillboardSystem`.
  Composition rows cover PBR/tone/geometry/post-process but none of
  Standard-variant, node-variant, splat, line, sprite/billboard,
  effect-wrapper — six families `SHADER_FAMILIES` itself enumerates. Refusal
  rows carry none of the new families' generation refusals. Fix one mechanism
  at a time, composition rows first (one row per already-computed emit list);
  soften or satisfy the features.md claim in the same change. (The
  capability-define half — the three rowless defines and the closing test —
  landed 2026-08-24.) Effort M.

## Transpiler structure

- [ ] **TR-3 — The remaining private pinned-body→C++ walkers.** The
  operator/math-table folds landed 2026-08-24 (one `PINNED_ASSIGNMENT_OPERATORS`
  / `PINNED_ARITHMETIC_OPERATORS` / `PINNED_MATH_FUNCTIONS` set serves every
  lowerer). What remains are the walker migrations, none of which is
  byte-neutral: `light-lowerer.ts`'s `lowerMatrix` walker (= TR-4, the parity
  wave), `renderer-lowerer.ts` `printPinnedCppExpression` (~59 lines —
  migrating changes parenthesization, so it rides a measured wave),
  `post-process-lowerer.ts`'s translator (~110, differs only in its path
  resolver), and `gltf-lowerer.ts`'s `renderCppExpression` (~250,
  precedence-minimal parenthesization is a real distinguisher) +
  `evaluatePinExpression` (~121). `pinned-ubo-writer-lowerer.ts` stays
  domain-specialized by design. Effort M, parity-validated.
- [ ] **TR-8 — Handle-collection semantics exist as ~12 exact-shape arms.**
  `compileSceneLightPush`/`compileParticleSystemsPush`/
  `compileHandleCollectionFind` (expressions.ts), three `emit*ForOf` +
  `isRecursiveImportedMeshWalk` (statements.ts), five iteration/index targets
  (compiler.ts). Each refuses honestly outside its slice, but "a handle
  collection as a value" is re-derived per shape — exactly what blocks scenes
  158/251 (the user-visible half is TRACKED in TODO). When scene 158 lands,
  introduce one handle-collection value kind (iterate/index/find/push) and
  retire the arms rather than adding a thirteenth. Effort L, feature-coupled.
- [ ] **TR-10/11/12 — The three biggest lowerers are separable along measured
  seams, byte-neutrally.** `gltf-lowerer.ts` (8,439 lines) is ~11 exported
  leaf families (ranges measured in the audit); `renderer-lowerer.ts`'s
  `lowerRenderPlan` is one ~1,700-line method mixing six concerns;
  `factory-lowerer.ts` is two concepts (mesh builders 38–2123 vs
  material/texture factories 2124–3658). All pure code motion, digest-provable;
  doing it makes the remaining TR-3 walker inventory reviewable per module.
  Effort M.
- [ ] **TR-13 — `compiler.ts` extractions, modest.** The `featureSources`
  table + output projection, the scene-material manifest recorders, and the
  emitted-lines/native-function frame management are the remaining
  byte-neutral candidates. Navigational payoff only. Effort M.
- [ ] **TR-15 — `upstream-graph.ts` is production-dead but listed as
  active.** Imported only by `test/upstream.test.ts`;
  `docs/architecture.md`'s ownership table lists it as a live component, and
  TODO plans it for scene 144's bloom observation seam. Mark the table row
  test-only-until-144, or wire it when 144 lands; do not delete. Effort S.

## Native structure

- [ ] **NA-2 — The `RenderPipelineKind` fixed-function decode exists twice
  across backends and twice more inside SDL.** Dawn owns a full
  `pipeline_traits` table; SDL re-derives the same facts as boolean chains in
  `pinned_variant_pipeline` and again in `standard_variant_pipeline` (~75
  semantic lines). The planned glTF-topology suffix on the enum would widen
  the decode at 3+ sites. Fix: one API-neutral traits decode in
  `pal_gpu_shared.hpp` or generated beside the enum; backends keep only the
  enum residue, as the depth compare already does. Effort S.
- [ ] **NA-3 — The billboard program-selection ladder and pass rules are
  duplicated verbatim between the backend pair** (~110 lines): the four-way
  shader-stem ladder, the particle-Multiply exclusivity refusal (prose
  included), depth-write-iff-cutout, the axis-locked system-block rule, the
  mode-4 two-pass orchestration, the `{view_projection, view}` struct. Fix:
  a shared `billboard_draw_plan(system)` (pal_gpu_shared or generated
  `billboard_system.hpp`) returning stems + flags + the refusal; backends
  keep pipeline/bind mechanics. Remaining billboard TODO arms would otherwise
  fork the ladder again. Effort S.
- [ ] **NA-5 — The two backends decide billboard re-upload differently, and
  SDL's cache has no version stamp.** SDL skips sort+upload when the view is
  unchanged (cutout: uploads once); Dawn re-sorts and re-uploads every frame
  (a per-frame O(n log n) cost that is per-frame constant under a static
  camera). Conversely SDL keys its cache on the view alone — a billboard
  appended after the first frame under an unchanged camera would draw from a
  stale buffer on SDL and correctly on Dawn (the sprite twin has
  `uploaded_version`; billboard does not). No reached scene appends today.
  Fix: state one gating rule once, add the version stamp. Effort S.
- [ ] **NA-6 — Geometry-MRT target-list assembly is duplicated four times**
  (both families × both backends, ~120 lines: reserve → per-attachment format
  (blend if transparent) → optional trailing output target → count assert →
  sample-count override), and SDL's `pipeline_for` grid/shader dispatch
  switch is written twice within the file. Fix: shared
  `geometry_target_classes(task, entry)` + hoist the SDL selector. Effort M.
- [ ] **NA-7 — `pinned_scene_block` is rebuilt per draw on SDL** at the same
  three sites as the TRACKED lights-block entry, and its builder runs
  `camera_world_matrix` + `build_view_matrix` per call; Dawn builds it per
  frame. `draw_standard_variant` also recomputes `standard_material_features`
  the selector already computed. Fold both into the tracked lights-hoist
  entry (one hoist, three families) rather than filing a second mechanism.
  Effort S, rides the tracked fix.
- [ ] **NA-11 — The inverse tone-mapping constant is hand-typed in the shared
  header.** `inverse_image_processed_channel` carries
  `1.59057903289794921875f` + the contrast bisection with provenance
  comments; the pin has no inverse to lower, but the constant itself should
  be lifted from the pin's tone-mapping module at generation rather than
  typed. Rides the tracked port-do-not-re-derive umbrella; filed here so the
  renderer leaf sweep picks it up. Effort M, inside the umbrella.

### One-sided backend contracts (2026-08-24 /simplify altitude sweep)

A check or refusal implemented in one PAL and absent from its twin is not an
API difference — it is a contract with one end. All of these take the
measured matrix; several also decide behavior under `BBLITE_MSAA=1`.

- [ ] **NA-15 — SDL's effect task bypasses the MSAA gate.** Dawn sizes the
  effect-task pipeline through `task_sample_count`
  (`pal_dawn.cpp` effect-task encode); SDL passes the raw
  `target_record.samples` (`pal_sdl_gpu.cpp` effect-task site) while its own
  frame-graph textures and post-process program go through the gate — so
  under `BBLITE_MSAA=1` (or a device failing the 4x probe) the texture is
  1-sample and the pipeline is built at 4 (`pal_sdl_gpu_effect.hpp` maps any
  `samples > 1` to exactly 4, where Dawn passes the value through).
  Pipeline/attachment mismatch on a documented diagnostic path. Effort S.
- [ ] **NA-16 — Alpha-to-coverage at one sample: three of four sites lack
  Dawn's guard.** Dawn's shader-material pipeline disables a2c at one sample
  (`samples > 1` conjunct, `pal_dawn.cpp`); SDL enables it unconditionally —
  1-sample a2c quantizes coverage to a ~0.5 cutoff, so the two backends draw
  different pixels under `BBLITE_MSAA=1`. The billboard pair has the guard on
  *neither* side: a cutout+coverage billboard at one sample fails Dawn's
  pipeline validation while SDL builds it. One rule, stated once (the
  pipeline-kind traits home NA-2 proposes fits). Effort S.
- [ ] **NA-17 — Invalid shader-material handle: SDL refuses by name ×2, Dawn
  silently skips the uniform write** (`pal_dawn.cpp` shader-draw arm has no
  `else`) and still encodes the draw with stale or zero uniforms. Give Dawn
  the same named refusal. Effort S.
- [ ] **NA-18 — Standard render-texture resolution is missing from SDL's
  main pass, and `bind_stage_textures` is the one sidecar walker without an
  unmapped-resolution refusal.** Dawn resolves `standard_render_views` for
  every Standard draw and refuses a non-render-target source; SDL's task
  path resolves but its main pass passes the default empty map — a comment
  claims the case "cannot appear here", unenforced — and a null texture
  would bind silently because `bind_stage_textures`
  (`pal_sdl_gpu_shared.hpp`) lacks the refusal its storage and uniform
  siblings have. Add the walker refusal (turns any such gap into a named
  error) and resolve or assert at the main pass. Effort S.
- [ ] **NA-19 — Validation lives on one side each: Dawn validates every
  render-plan item's kind/variant (SDL discovers at draw time or not at
  all — its node path indexes `node_variants` unchecked, plus
  `node_vertex_slots`); SDL guards post-registration material families
  (Dawn's rebuild never consults `material_family_mask`); SDL bounds-checks
  frame-task/target handles (Dawn indexes `engine.frame_tasks[...]` raw at
  four sites — out-of-bounds UB on a bad handle).** Symmetrize each: the
  plan validation and the family guard are shared-code candidates; the
  bounds checks are three-line additions. Effort S–M.
- [ ] **NA-20 — Three flag/probe asymmetries.** `transmission + frame-graph
  tasks` refuses on Dawn and silently renders transmission-less on SDL
  (mutually exclusive arms) — decide which is right and make it symmetric.
  `BBLITE_GPU_DEBUG` is honored by all three SDL drivers and silently
  ignored by Dawn — the third instance of the exact failure mode the
  `FrameOptions` comment names; refuse, map, or document (Dawn's validation
  is always-on, so documenting may be the answer). The 4x MSAA capability
  probe exists on SDL only, and SDL is the *sole* consumer of the generated
  `preferred_sample_count()` — Dawn re-types the 4 (ties into RD-3's
  emit-once fix); a probe-failing device silently renders 1-sample SDL
  against 4-sample Dawn. Effort S each.
- [ ] **NA-22 — `runtime.hpp` restates pin defaults as dead member
  initializers, and generated positional aggregate initializers are
  order-guarded by comments alone.** Generation always fills every field of
  the option structs (torus/ground/sphere dims, the iridescence trio,
  `BillboardSystemOptions`) and no native caller uses the `= {}` defaults —
  so the initializers are unguarded mirror copies waiting for a future
  caller to trust them — while the aggregates' field pairing rests on a "new
  field appends" comment in a `cxx_std_20` build where designated
  initializers would make it compiler-checked. Fix: delete the pin-mirror
  member inits (one live copy: the generated fill) and/or emit designated
  initializers; RD-4's defaults header is the companion. Effort S–M
  (designated-init switch is generated-text-only → matrix). 
- [ ] **NA-21 — Low-priority constant divergences, recorded so they stop
  being re-found**: `create_texture_sampler` W-addressing (SDL repeat vs
  Dawn clamp default, behind a comment claiming exact mirroring) and LOD
  clamp (1000 vs 32) — both inert today; effect empty-`uniform_values`
  fallback (SDL stale slot vs Dawn zeros) and no size-vs-`uniform_bytes`
  validation on either side; Dawn's scene-less drivers pin the engine
  options' size with no zero-extent guard where SDL tracks the swapchain;
  a literal `12` index-buffer size in `pal_dawn_sprite.hpp`. Effort S,
  opportunistic.

## Tooling

- [ ] **TL-14 — The SDL four-uniform-buffer cap is checked only for
  filenames starting `variant-`.** `compile-shaders.ps1` gates the cbuffer
  count + `gp` demotion on that prefix — beside its own comment celebrating
  the death of per-family filename prefixes — so `node-N.*` and `effect-N.*`
  stages are never counted against a failure the script's docstring calls
  silent D3D12 command-buffer corruption; node graphs are the user-authored
  family most likely to grow blocks, and `variant-std-*` fragments already
  sit at exactly 4. Fix: run the already-computed count on every stage and
  refuse >4; move demotion eligibility onto the composition/`SHADER_FAMILIES`
  row where family facts live. Effort S.
- [ ] **TL-15 — Late refusals lose the scene source location the manifest
  already carries.** Refusals raised at composition/lowering time are bare
  `Error`s (the CLI prints `error.message` only), while `featureSites`
  (feature → "file:line") exists with a single consumer. Instances across
  `upstream-lower.ts`, `compose-pipeline.ts`, the node-particle bake and the
  post-process composite refusals; every new *intrinsic* refuses cleanly via
  `context.fail`. Fix: thread `featureSites` into the composition layer and
  prefix late refusals with the owning feature's first-reach site; the two
  cross-family exclusivity refusals can move to the second-reaching
  intrinsic, which holds a real node. Effort S–M.
- [ ] **TL-4 — `compose` and `uniforms` read captures with none of the
  staleness discipline the writers earned, and `compose` writes no report.**
  `diff` refuses stale evidence (seek meta + build stamp); the two readers
  consume the same capture directory raw, so a capture predating a
  scene-source or pin change silently produces ok/GAP verdicts. `compose`
  also neither auto-captures (prints "run scene -- capture" instead) nor
  writes a provenance-carrying JSON like every sibling. Effort M together.
- [ ] **TL-5 — Browser-capture provenance is one field deep.**
  `capture-meta.json` records only `seekSeconds`; the byte-identity verdict
  against the golden is printed and discarded, and `diff` happily reuses a
  browser capture taken from an older scene source or pinned package.
  `corpus-scenes.test.ts` already digests the browser module — write that
  digest and the identity verdict into the sidecar and let the reuse check
  refuse on them. Effort M.
- [ ] **TL-6 — `geometry` never caught up to its siblings' conventions.** No
  `--gpu-debug`; ignores `nativeEnvironment` and honours neither `--exe` nor
  `BBLITE_NATIVE_EXE`; no registry-pose default (an animated scene would
  compare a settled browser pose against native frame 0); cached `-lite.png`
  references reused on bare existence with no seek sidecar. Latent because
  current geometry scenes are static. Effort M.
- [ ] **TL-7 — Seek discipline splits across `stability` and
  `probe-variants`.** `stability` has no `--seek` at all (a wobble check at a
  non-registry pose is impossible); `probe-variants` takes `--seek` but still
  prints its golden-MAD lines unguarded at a moved pose — the two-poses
  comparison `parity` refuses. Effort S.
- [ ] **TL-8 — 23 registry entries spell the measured pose twice, enforced by
  nothing.** `referenceTimeSeconds` and
  `nativeEnvironment.BBLITE_ANIMATION_SEEK_SECONDS` are hand-paired (23
  pairs, 0 mismatches today); drift would split parity (env var) from
  `capture --native`/`diff` (`referenceTimeSeconds`) silently. Derive the env
  var in `withDerivedPaths`, or add a registry test. Related latent seam:
  `compile-shaders.ps1` bakes `generated\$Scene` while the registry permits an
  `output` override (zero scenes use one). Effort S–M.
- [ ] **TL-9 — Attribution buffers hardcode the `-gpu` filename token
  regardless of backend.** Documented as byte-identical across backends so no
  evidence is lost, but the name misstates provenance — the one deviation
  from "one filename token per backend everywhere". Effort S.
- [ ] **TL-10 — There is no diagnosis bundle.** `validate` chains the
  validation stages; nothing chains the diagnosis ladder. A
  `scene -- diagnose <id>` running differential → diff → compose and printing
  the ladder's verdicts in order is mostly composition of existing entry
  points — and, with TL-1, is where "we take too long to find what is wrong"
  actually lives. Effort M.
## Build

- [ ] **BU-5 — The shader stage is a measured 1m50 corpus no-op, fully
  serial, growing linearly with the corpus.** `compile-shaders.ps1` re-runs
  Tint twice per each of 2026 deployed stages on every invocation; only the
  DXC half is content-addressed. Content-address the Tint half exactly like
  the DXC half (key: tint.exe hash, WGSL hash, entry point, format,
  remap-pass identity; store `.hlsl`/`.msl`/reflection/`.slots` in
  `artifacts/shader-cache`), optionally parallelize the loop. Identity is not
  weakened — outputs stay byte-derived and the deployed-payload check still
  guards. Expected 1m50 → ~15 s. The same cache shape also fits the
  deterministic Chromium bakes generation re-executes on every compile (HDR
  prefilter +1.6 s, ten NPE bakes +0.6 s each, Basis ×2 — ~10–15 s CPU per
  `compile all`, and the full penalty on every dev-loop recompile of those
  scenes): key on pin package+version, input bytes, bake parameters and the
  packager-code identity, replay from `artifacts/`. Effort M.
- [ ] **BU-14 — Finish the lazy-import split at the two entry points.** The
  packager half landed 2026-08-24 (`cli.ts` now `await import`s the
  dds/hdr/splat/basis/NPE packagers per asset kind). Remaining, measured:
  `scene-command.js` pays 431 of its 544 ms import cost loading
  playwright-core + typescript through `parity-scene` →
  `capture-suite-reference` on the cached-reference path every parity child
  takes (~67 s CPU per `parity all`) — move the browser-harness import into
  `captureSuiteReference`'s capture branch and make the `compose`/`diff`/
  `uniforms` dispatch import their chains per subcommand; and `cli.ts` still
  eagerly runs `pinned-material-input`'s top-level await (~15 pinned imports,
  57–288 ms) for every scene — gating it behind an exported
  `ensurePinnedLoaderExecution()` must preserve the pin's process-global
  registration timing (scene 12's empty-setter semantics), so it takes its
  own careful pass. Effort S–M.
- [ ] **BU-6 — Every `npm run scene` pays a clean 3.9 s tsc; the canonical
  validation sequence pays it four times.** `build` is `clean:dist && tsc`
  with no up-to-date check (and `--incremental` alone is useless because
  clean deletes the buildinfo). Fix: a staleness *skip* — stamp src/test/
  tsconfig state into `dist/.build-stamp` and skip clean+tsc on match;
  rebuild-more-on-doubt preserves clean-build semantics. Effort S.
- [ ] **BU-10 — No `scene -- clean`; stray trees accumulate.**
  `native\build-sdl` is an 89 MB orphan no current tooling creates;
  `generated/` carries 3 unowned dirs the shader sweep still processes;
  deregistered scenes would persist the same way. Add
  `scene -- clean [--orphans]` deleting build trees and `generated/` dirs no
  registry entry owns. (The shared-`VCPKG_INSTALLED_DIR` work stays in
  [TODO](TODO.md), which now carries the four-combo design; it waits on
  BU-3.) Effort S.
- [ ] **BU-7 — `build_stamp.hpp` reached the GPU-PAL include closure; 143/143
  PAL objects are now distinct.** `pal_render_capture.hpp` includes
  `build_stamp.hpp` and both GPU TUs include it unconditionally, so the
  2026-08-14 "83 distinct objects" measurement no longer holds and every
  compiler-cache option is foreclosed. Cheap first step: the stamp as an
  `extern` defined in a generated TU, restoring GPU-PAL object identity to
  the ~46 `render_capabilities` classes. (The shared-PAL-library and sccache
  declines stand — re-measure only after this and BU-11.) Effort S.
- [ ] **BU-13 — Two min-chain claims are VERIFY-BY-BUILD**: `map-size-report.mjs`
  against a current MSVC `.map` (none exists on disk), and `BBLITE_MINSIZE`
  covering the physics TU (bullet3 verified statically-linked and
  feature-gated; one min configure of scene 40 proves the fold). One build
  each, alongside BU-1's proof.

## Documentation

The 2026-08-24 audit's small-fact defects and all nine regrown dev-log
passages were fixed the same day; what remains is the duplication debt.

- [ ] **DOC-11..14 — The features-vs-fidelity twinning, ~250 duplicated
  lines.** Physics, node particles, node materials (and their smaller
  siblings) each tell their full why-story on both pages. Owner: fidelity for
  contracts/rationale; features keeps the what, the phase split, and the
  refusal lists, with a link. One family per edit wave. Effort M–L.
- [ ] **DOC-15 — The `.slots` sidecar contract lives on five pages**
  (architecture, debugging, backends ×2 sections, features ×2 passages,
  development). Owner: backends for the contract, debugging for the
  read-the-file recipe; everything else one clause + link. Effort M.
- [ ] **DOC-16..29 — Remaining duplication clusters** (each S–M): the
  one-LSB→CPU-side rationale ×3; the 9/37/120 wobble passage duplicated
  wholesale (owner: debugging) and repeated twice more within debugging
  itself; the orbit-then-measure recipe ×3; the "no independent check"
  elaboration verbatim in copilot-instructions; compressed-texture/invertY
  ×4; post-process, fullscreen-effect, line-system, drawn-atlas,
  materials-variants each ×2 (owner: fidelity); copilot's floor-rules
  examples duplicate debugging's.

## Suggested order

The 2026-08-24 quick-win wave (docs facts + dev-log, TR-2/TR-5/RD-1/FA-1/
FA-3 drift guards, the tooling dedups, BU-2/BU-4/BU-9/BU-12, the lazy
packager imports, the min-SDL patch fix) landed the same day, proven by
571/571 tests and a clean-worktree generated-tree digest. What remains:

1. **Proofs**: BU-1's min build (+ BU-13's two VERIFY-BY-BUILD claims ride
   the same session).
2. **Drift guards, native**: RD-2 splat constants, RD-3 effect sample count
   (with NA-20's `preferred_sample_count` consumer), then the one-sided
   contracts NA-15..NA-19 — one measured-matrix wave.
3. **Daily minutes**: BU-5 (Tint + bake cache), BU-6 (tsc skip), BU-14
   (remaining lazy imports), BU-3 then the TODO shared-vcpkg entry.
4. **Diagnosis coverage**: TL-1 capture writers (per family), TL-10 diagnose
   bundle, TL-4/5, then TL-6/7/8.
5. **Structure**: TR-10/11/12 splits (byte-neutral); NA-2/3/6 shares and
   TR-4 + TR-3 walker migrations with the parity matrix.
6. **Docs waves**: the twinning compressions one family at a time
   (DOC-11..15), then the smaller clusters (DOC-16..29).
