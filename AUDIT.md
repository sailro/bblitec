# AUDIT — 2026-08-24

Findings of the six-axis audit at main `e065f59`, covering the 113 commits since
the 2026-08-19 audit closed (PR #83). Same rules as [TODO](TODO.md): entries are
unfinished work, stated with the facts needed to act; **fixing an entry deletes
it**. Every claim was file:line-verified at the baseline commit; line numbers
drift with edits, the named symbols do not.

Two fix waves landed the same day and their entries are deleted: the quick-win
wave (docs facts and dev-log, the drift guards TR-2/TR-5/RD-1/FA-1/FA-3, the
tooling dedups, BU-2/BU-4/BU-9/BU-12, lazy packager imports, the min-SDL patch
fix — proven by the test suite plus a clean-worktree generated-tree digest)
and wave 1 (the pin-anchored material-defaults table, the depth-clear read,
refusal source-sites, the activation-inventory backfill, the monolith splits,
the Tint and bake caches, the tsc skip, `diagnose`/`clean`, capture-meta
provenance, seek discipline, the registry pose derivation, the docs
duplication debt — proven by 583/583 tests, a compile-all digest whose only
delta was the intended `feature-activation.json`, warm-cache byte-stability,
and a scene-1 parity/diagnose smoke). The min-SDL and MINSIZE-physics proofs
ran to a frame (BU-1/BU-13 closed; minimal scene 1 measures the published
0.001/0.007).

Severity: **defect** = wrong today; **drift** = correct today, agrees with the
pin only until upstream changes it; **debt** = violates a house rule or costs
time.

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
  measured-run spawner, one browser-execution service, one PNG/MAD library.
- **Dead code is ~zero.** `lint:exports` reports only fixture false positives;
  every generated artifact has a reader; every tool script is referenced.
- **Docs' mechanical facts verify**: pin pair, curated count, status rows,
  previews, scripts, subcommands, flags, env vars, paths, anchors, and ~20
  spot-checked code claims.
- Patch hygiene and the concurrency docs match the code exactly.

## Defects

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

## Drift exposure (port-do-not-re-derive, new instances)

The pattern: where a family **emits its constants into generated code**
(billboards) drift is guarded; where a **PAL types them per backend**
(splats, effects) it is not. The fix shape is always "emit it once".

- [ ] **RD-2 / NA-4 — Splat GPU constants are re-typed in both PALs with no
  pin assertion.** The pinned quad `[-2,-2, 2,-2, 2,2, -2,2]`, indices
  `[0,1,2, 0,2,3]`, and nearest/clamp sampler
  (`gaussian-splatting-mesh.ts`) exist as per-backend literals in
  `pal_dawn_splat.hpp` and `pal_sdl_gpu_splat.hpp`, comment-tied only; the
  payload order {centers, cov_a, cov_b, colors} and the ALPHA_COMBINE blend
  are likewise spelled per backend instead of travelling as data the way
  `transparent_blend` does (the blend needs no new emitted data — it equals
  `transparent_blend`, and both backends own `blend_state_from`; the obstacle
  is include order, fixed by hoisting the translator into the per-backend
  shared headers beside the depth-compare translators). The quad half-extent
  is semantics — the domain of the fragment's `exp(-dot(k,k))` kernel. Fix:
  emit quad/indices/sampler/payload-order from `splat-lowerer.ts` into the
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
- [ ] **RD-6 — A pre-audit compensating pair: `bump_scale` is inverted
  twice.** The `.babylon` loader template stores `1/level`
  (`templates/babylon-loader-cpp.ts`) and `pinned-standard-variants.ts`
  inverts it back at composition; removing both is byte-identical in the
  composed shaders (verify the record value feeds nothing else). The one
  live instance of the historical cancelling-pair class. Effort S.
- [ ] **RD-7 — The scene-code subsurface thickness ground state may diverge
  from the pin.** Found by the defaults-table wiring:
  `compilePbrMaterialOptions` seeds `thickness = 0` while the pinned
  `writeRefractionUBO` reads `thick?.max ?? 1` — so a scene-code material
  with `subsurface.refraction` present and no `thickness` object would write
  thicknessParams max 0 against the pin's 1, IF the composed variant carries
  the lane for that shape at all (the pinned `detect` decides). No reached
  scene hits it; the site carries a marking comment and is excluded from the
  defaults table. Measure the shape (a probe scene), then align or record.
  Effort S, needs a measurement.

## Transpiler structure

- [ ] **TR-3 — The remaining private pinned-body→C++ walkers.** The
  operator/math tables and the monolith splits are done; what remains are the
  walker migrations, none byte-neutral: `light-lowerer.ts`'s `lowerMatrix`
  walker (= TR-4, the parity wave), `renderer-lowerer.ts`
  `printPinnedCppExpression` (~59 lines — migrating changes
  parenthesization), `post-process-lowerer.ts`'s translator (~110, differs
  only in its path resolver), and `src/lowering/gltf/`'s
  `renderCppExpression` (~250, precedence-minimal parenthesization is a real
  distinguisher) + `evaluatePinExpression` (~121).
  `pinned-ubo-writer-lowerer.ts` stays domain-specialized by design.
  Effort M, parity-validated.
- [ ] **TR-8 — Handle-collection semantics exist as ~12 exact-shape arms.**
  `compileSceneLightPush`/`compileParticleSystemsPush`/
  `compileHandleCollectionFind` (expressions.ts), three `emit*ForOf` +
  `isRecursiveImportedMeshWalk` (statements.ts), five iteration/index targets
  (compiler.ts). Each refuses honestly outside its slice, but "a handle
  collection as a value" is re-derived per shape — exactly what blocks scenes
  158/251 (the user-visible half is TRACKED in TODO). **Blocked on feature
  work by design**: when scene 158 lands, introduce one handle-collection
  value kind (iterate/index/find/push) and retire the arms rather than adding
  a thirteenth. Effort L.

## Native structure

- [ ] **NA-2 — The `RenderPipelineKind` fixed-function decode exists twice
  across backends and twice more inside SDL.** Dawn owns a full
  `pipeline_traits` table; SDL re-derives the same facts as boolean chains in
  `pinned_variant_pipeline` and again in `standard_variant_pipeline` (~75
  semantic lines), plus one-off `node_opaque_none` decodes on both sides. The
  planned glTF-topology suffix on the enum would widen the decode at 3+
  sites. Fix: one API-neutral traits decode in `pal_gpu_shared.hpp` or
  generated beside the enum; backends keep only the enum residue, as the
  depth compare already does. Effort S.
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
  (the sort+upload is the only ungated per-frame cost — the UBO rebuilds
  beside it are small stack arrays). Conversely SDL keys its cache on the
  view alone — a billboard appended after the first frame under an unchanged
  camera would draw from a stale buffer on SDL and correctly on Dawn (the
  sprite twin has `uploaded_version`; billboard does not). No reached scene
  appends today. Fix: state one gating rule once, add the version stamp.
  Effort S.
- [ ] **NA-6 — Geometry-MRT target-list assembly is duplicated four times**
  (both families × both backends, ~120 lines: reserve → per-attachment format
  (blend if transparent) → optional trailing output target → count assert →
  sample-count override), and SDL's `pipeline_for` grid/shader dispatch
  switch is written twice within the file (param-vs-state sources are the
  only difference). Fix: shared `geometry_target_classes(task, entry)` +
  hoist the SDL selector. Effort M.
- [ ] **NA-7 — `pinned_scene_block` is rebuilt per draw on SDL** at the same
  three sites as the TRACKED lights-block entry, and its builder runs
  `camera_world_matrix` + `build_view_matrix` per call; Dawn builds it per
  frame. `draw_standard_variant` also recomputes `standard_material_features`
  the selector already computed. Fold both into the tracked lights-hoist
  entry (one hoist, three families). Effort S, rides the tracked fix.
- [ ] **NA-11 — The inverse tone-mapping constant is hand-typed in the shared
  header.** `inverse_image_processed_channel` carries
  `1.59057903289794921875f` + the contrast bisection with provenance
  comments; the pin has no inverse to lower, but the constant itself should
  be lifted from the pin's tone-mapping module at generation rather than
  typed. Rides the tracked port-do-not-re-derive umbrella. Effort M.

### One-sided backend contracts (2026-08-24 /simplify altitude sweep)

A check or refusal implemented in one PAL and absent from its twin is not an
API difference — it is a contract with one end. All of these take the
measured matrix; several also decide behavior under `BBLITE_MSAA=1`.

- [ ] **NA-15 — SDL's effect task bypasses the MSAA gate.** Dawn sizes the
  effect-task pipeline through `task_sample_count`; SDL passes the raw
  `target_record.samples` while its own frame-graph textures and post-process
  program go through the gate — so under `BBLITE_MSAA=1` (or a device failing
  the 4x probe) the texture is 1-sample and the pipeline is built at 4
  (`pal_sdl_gpu_effect.hpp` maps any `samples > 1` to exactly 4, where Dawn
  passes the value through). Pipeline/attachment mismatch on a documented
  diagnostic path. Effort S.
- [ ] **NA-16 — Alpha-to-coverage at one sample: three of four sites lack
  Dawn's guard.** Dawn's shader-material pipeline disables a2c at one sample;
  SDL enables it unconditionally — 1-sample a2c quantizes coverage to a ~0.5
  cutoff, so the two backends draw different pixels under `BBLITE_MSAA=1`.
  The billboard pair has the guard on *neither* side: a cutout+coverage
  billboard at one sample fails Dawn's pipeline validation while SDL builds
  it. One rule, stated once (the pipeline-kind traits home NA-2 proposes
  fits). Effort S.
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
  siblings have. Add the walker refusal and resolve or assert at the main
  pass. Effort S.
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
  the option structs and no native caller uses the `= {}` defaults — the
  initializers are unguarded mirror copies waiting for a future caller to
  trust them — while the aggregates' field pairing rests on a "new field
  appends" comment in a `cxx_std_20` build where designated initializers
  would make it compiler-checked. Fix: delete the pin-mirror member inits
  (one live copy: the generated fill) and/or emit designated initializers.
  The pin-anchored defaults table (`src/lowering/pinned-material-defaults.ts`)
  is the source to check any surviving initializer against. Effort S–M.
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

- [ ] **TL-6 — `geometry` never caught up to its siblings' conventions.** No
  `--gpu-debug`; ignores `nativeEnvironment` and honours neither `--exe` nor
  `BBLITE_NATIVE_EXE`; no registry-pose default (an animated scene would
  compare a settled browser pose against native frame 0); cached `-lite.png`
  references reused on bare existence with no seek sidecar. Latent because
  current geometry scenes are static. Effort M.

## Build

- [ ] **BU-7 — `build_stamp.hpp` reached the GPU-PAL include closure; 143/143
  PAL objects are now distinct.** `pal_render_capture.hpp` includes
  `build_stamp.hpp` and both GPU TUs include it unconditionally, so the
  2026-08-14 "83 distinct objects" measurement no longer holds and every
  compiler-cache option is foreclosed. Cheap first step: the stamp as an
  `extern` defined in a generated TU, restoring GPU-PAL object identity to
  the ~46 `render_capabilities` classes. (The shared-PAL-library and sccache
  declines stand — re-measure only after this and the TODO shared-vcpkg
  entry.) Effort S.
- [ ] **BU-14 — Lazy-load `pinned-material-input`'s top-level await in the
  CLI.** The scene-command and packager halves landed; `cli.ts` still
  eagerly runs the ~15 pinned-module imports (57–288 ms) for every scene.
  Gating it behind an exported `ensurePinnedLoaderExecution()` must preserve
  the pin's process-global registration timing (scene 12's empty-setter
  semantics make registration order observable), so it takes its own careful
  pass with a compose-level test. Effort S–M.

## Suggested order

1. **Wave 2, one measured-matrix run**: the lowerer-side precision items
   (TR-4 + TR-3 walkers, RD-6), the emit-once items (RD-2, RD-3 with NA-20's
   `preferred_sample_count` consumer, NA-11), then the PAL-side shares and
   symmetry (NA-2/3/5/6/7, NA-15..19, NA-22, BU-7), validated together by
   `npm test` + `scenes:process` + `scenes:parity --differential` +
   `status:verify` + `neutrality` against a pre-wave parity snapshot.
2. **Capture coverage**: TL-1/NA-8 writers per family (native + tooling),
   then TL-6's geometry catch-up.
3. **Stragglers**: BU-14's careful half; RD-7's probe measurement; NA-21
   opportunistically.
4. **Blocked**: TR-8 waits for scene 158's collection contract by design.
