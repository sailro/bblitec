# bblitec audit tracker

Findings of the 2026-08-18 six-axis audit (feature activation, re-derivation,
transpiler structure, native/PAL, documentation, tooling), taken at `main`
d6c360f. Every entry was verified against the code with file:line evidence;
the four highest-stakes correctness claims were independently re-verified.

Rules of this file, mirroring `TODO.md`:

- Only unfinished findings belong here. **Delete an entry when its fix lands**;
  closing an entry must lower the count.
- Entries state the defect and the facts needed to act — not what was tried.
- The **Verified clean** section at the bottom is the exception: it persists,
  so future audits do not re-litigate what was already proven sound.
- Fix priority: work the sections in the order listed under
  [Suggested order](#suggested-order).

## Defects — wrong today

All fourteen defects are closed and validated; the section persists only so
its absence is legible.

## Feature activation

- [ ] **FA-map residual — complete the row citations.** The inventory ships
  (89 rows ×73 scenes, zero unproven provenance), but scene-source rows
  carry a generic `activatedBy` because `context.reachFeature` keeps no
  source locations — thread intrinsic call sites through `CompileManifest`
  to cite file:line. Also record the pinned `MAX_LIGHTS` value itself on
  the refusal row (today only the checked count), and add the two cli
  interleave refusals (scene mesh/material created before a later glTF
  load) that guard the variant key.

## Re-derivation (port, do not re-derive)

Quantified backlog: ~10,700 lines of hand-written C++ template text encoding
upstream semantics (gltf-loader 4,567; renderer ~1,900; in-lowerer ~3,460)
plus ~945 live transcribed WGSL lines, against ~1,100 lines of genuine
mechanisms (`pinned-ubo-writer-lowerer`, `light-lowerer#lowerMatrix`, the
sprite template evaluator) that are the templates to reuse. Two legitimate
shapes only: LOWER (walk the pinned AST) or EXECUTE (run the pin and bake).

- [ ] **RD-1 — Standard material family: wire the PALs and flip.**
  Generation half SHIPPED (`src/pinned-standard-variants.ts`: pin-composed
  variants for all eight material exts, morph, fog, vertex colors, geometry
  MRT; `standard_variants.hpp` UBO mirror keyed off the renderable's own
  `F32(24)` lanes; behind `UpstreamEmitOptions.pinnedStandardVariants`,
  default off, PBR writer byte-identical). Remaining: per-renderable
  selector `(material_index, mesh_features, geometry_task)` in both PALs
  (group 0 reuses the PBR lights UBO — hoist the shared mesh/light blocks
  so a standard-only scene gets them without `pbr_variants.hpp`); close the
  record gaps (`bump_level` stores the inverse, `lightmap_level`,
  `reflection_coord_mode`, standard `alpha` rides `base_color_factor.a`);
  compose the named-throw arms (skeleton/VAT, received shadows, thin
  instances, ESM depth) as scenes need them; then flip the option, delete
  `shader-builtins-standard.ts` + the renderer-lowerer standard emissions
  (:2984/:3038, :2183-2293 light slots, :3361-3375 geometry frags), and
  retire `standardLights`/`standardSpotLights`/`standardLightLists` into
  UBO data (the pinned fragment loops `min(mesh.lc, MAX_LIGHTS)`).
- [ ] **RD-2 — gltf-loader-cpp.ts (XL, round 2+).** Round 1 lowered the
  animation-interpolation leaf (`evaluate.ts` slerp/cubic, emitted at both
  strides) and the sampler table (`gltf-sampler-desc.ts`, by-name
  correspondence, defaults proven by a mini-evaluator) — 163 template lines
  now splice from the pinned AST and the assert-without-flow seam is gone
  for them (4,428 lines left). Remaining leaves: accessor normalization,
  color normalize, extension-default constants
  (dielectric/ior/dispersion/iridescence), the second hand-typed SH-prescale
  copy (the .env path already lowers them), exposure/contrast 0.8/1.2.
- [ ] **RD-3 — renderer-lowerer render-plan C++ (XL, piecewise).**
  ~1,900 template lines: bucketing/sort/pipeline-kind rules, camera matrix
  chain, TRS/quaternion composition, light-slot packing, background geometry,
  texture-transform compose, transmission/extension packing. The monolithic
  `PbrUniforms` extension lanes (:444-764) are now referenced only by
  `pal_render_capture.hpp` and one `sizeof` in `pal_dawn.cpp:4696` — prune
  them. ~75 lines of inline image-skybox WGSL (:3189-3260) are liftable
  strings. Lower the math builders from their pinned modules. Fold in the
  RD-11 residual: the fog vec4 packing order (`fogUniforms` packs
  {mode, start, end, density} read as `.x/.y/.z/.w` by the lifted WGSL)
  is guarded only by fog parity scenes; the order assert belongs beside
  the packing here.
- [ ] **RD-11 — in-lowerer C++ with weak or no pinning (round 2).** Round 1
  anchored animation/camera/scene/light: slerp 0.9995 and the ms→s factor,
  the six camera control constants, the spot half-angle, the point-light
  local matrix, and the directional/hemispheric zeros now FLOW from the
  pinned AST (byte-identical output; presence-only checks upgraded; the
  dead fog-offset asserts replaced by a field-inventory anchor). Remaining:
  factory-lowerer (~1,111: geometry tables asserted against hand-built
  expectations; sphere `z_steps = 2 + segments` unpinned);
  environment-lowerer (SH constants extracted, term structure hand-written;
  scene-sizing pinned by an order-free literal bag); geometry-output-lowerer
  (Y-flip has no upstream assertion). LOWER per function.
- [ ] **RD-12 — pinned-material-input option builders.** Line-for-line
  transcription of the ext `applyMaterial` builders, plus an unguarded
  re-type of the IOR Fresnel at :489/:563. EXECUTE-able (the ext modules are
  default-exported with a stubbable ctx). Strongly gated today by
  `scene -- compose`, but the gate is capture-dependent.
- [ ] **RD-5 — native constants and strings.**
  `pal_camera_controls.hpp:83` freezes Babylon's frame scale evaluated at 60
  FPS as an uncommented constant; `pal_dawn.cpp:3219-3263` embeds the pinned
  MSAA-blit + `ip()` WGSL as C++ strings (lift via `rawWgslLiteral` and ship
  like every other pinned shader); `runtime.hpp` carries Babylon defaults as
  literals incl. a pre-computed sRGB→linear `primary_color` (:879) — derive
  or cite each.

## Transpiler structure

- [ ] **TS-1 — browser-harness ceremony, now ×5.** Identical
  server-listen → Chromium-launch → page-drive → teardown in
  `capture-suite-reference.ts`, `capture-instrumented.ts`,
  `hdr-prefilter-gpu.ts`, `sprite-atlas-packager.ts`, and (added with RD-7)
  `ibl-brdf-lut.ts`. Extract `withBrowserPage()` + `waitForSceneReady()`.
  `browser-path.ts`'s own header records the drift this stack already had
  once.
- [ ] **TS-8/9 — small consolidations.** `transpileForBrowser` (×3, folds
  into TS-1's harness module); `captureDirectory()`/`parityDirectory()`
  path helpers (the artifact-path expressions still repeat across the
  capture/diff/compose call sites). (TS-10's report shapes are covered by
  the shared provenance-stamping `writeReport` — done.)
- [ ] **Monolith remainder — extract `compiler.ts` (now 4,676 lines) along
  the proven seam.** Round 1 moved the expression switch and browser
  erasure (−846 lines, byte-identical by construction). Remaining blocks by
  size: intrinsic option compilers (→ their per-domain intrinsic modules,
  whose context interfaces already declare the methods), shader-material
  options, property-animation compilation, adaptations manifest, assets,
  scopes, emission primitives; `cli.ts`'s inline `.babylon` asset scanning
  (→ `babylon-asset-features.ts`) and variant-composition orchestration
  (→ `compose-pipeline.ts`). Also noted in round 1: the trailing
  `isCanvasLookup`/`isPerformanceNow` block in `isBrowserOnlyExpression` is
  dead (every call-expression path returns above it).

## Native

- [ ] **NA-3 remainder — the transmission mip variant and Dawn's mip-blit
  WGSL.** The chain-length helper is shared now; still open: the
  transmission mips-minus-4 derived two different ways
  (`pal_dawn.cpp` hardcodes 11-4; `pal_sdl_gpu.cpp` derives from the
  swapchain), and Dawn's mip-blit WGSL is a C++ string invisible to shader
  provenance — emit it from generation (pairs with RD-5).
- [ ] **NA-4 — transmission constants + trigger predicate shared.** 1024²,
  −4 mips, repeat-trilinear-aniso-4, first-transmissive-draw predicate —
  duplicated in both backends. Pass mechanics stay per backend.
- [ ] **NA-12 — sprite pinned contracts.** Instance layout offsets/stride
  (generate the layout table beside `sprite_layer.hpp`); the per-frame
  layer sort and blend-homogeneity check → shared helpers; Dawn hardcodes
  the atlas sampler SDL derives from the record.
- [ ] **NA-shared remainder — the two big masses.** Readback row-conversion
  (~250 lines: half→byte, r16f→red, BGRA swap) and mesh-sync dirty policy
  (~235; SDL's inline weights rebuild duplicates shared
  `pack_morph_weights` — call it); CPU benchmark through
  `report_benchmark`. Rule stands: tables and predicates move; pass
  encoding, bind groups, and swapchain stay per backend.
- [ ] **NA-dawn — factor Dawn's pinned draw path.** It is distributed across
  four sites that duplicate each other (write 6053-6148, encode 6382-6449,
  geometry write 2386-2507, geometry encode 7181-7265); SDL has
  `draw_pinned_variant` factored. WebGPU forces the write/encode split; the
  duplication between main-pass and geometry-task arms does not.
- [ ] **NA-polish.** `PinnedGeometryParams` declared before the namespace
  opens (`pal_gpu_shared.hpp:34-37`); `reject_unsupported_frame_options`
  hardcodes "through SDL_GPU" in error text (:1285-1303) — parameterize; the
  capture's `pinned_mesh_block` always uses `pinned_mesh_world()`
  (`pal_render_capture.hpp:1120-1124`) where the draw uses the fuller
  `pinned_draw_world` chain — reuse or document.

## Documentation

## Tooling

- [ ] **TL-gaps — remaining rungs.** ((a) pinned blocks in diff with the
  refused marker, (b) shader-arm hashing with the near-miss divergence
  line, and (e) `scene -- measure` shipped in wave C.)
  (c) Palette matching vs `tex-uploads.json` (zero readers today) with the
  documented mirror map applied. (d) `scene -- probe-variants <id>` (the
  stripped-shader-dir probe; write the recipe into debugging.md
  regardless). (f) `capture --seek-bracket` (±1-frame motion scale).
  (g) `parity --without ground|background` (the bisection ordering
  experiment). (h) `scene -- stability <id> [--runs N] [--single-sample]`
  (the 9/37 wobble check with the never-vs-golden trap built in).
  (i) generated-tree neutrality mode (compile-and-digest with the
  stray-directory footgun handled; the wave-C sync scripted it by hand
  again — `digest-sha1.cjs` in the session scratchpad is the shape).
  (j) the `validate` bundle TODO already asks for.

## Verified clean — do not re-audit

- **PAL isolation, both directions** (CMake TU selection, include graph
  grep-verified backend-type-free shared headers, stub contract,
  `run_engine` dispatch, sprite TUs, CPU-fallback-off): deleting a backend is
  dropping its files. Removing SDL_GPU keeps SDL3 as the platform layer —
  intended. One asymmetry: SDL TUs subtracted from the generated list, Dawn
  TUs added natively.
- **The PBR pinned pipeline end-to-end**: composer executed under Node,
  extensions in the pin's registration order, stages emitted verbatim and
  byte-gated against instrumented browser captures, UBO layouts cross-checked
  against the composer's own `_offsets`, `assertArmsCovered` +
  unwritten-field gates live. Solid skybox, HDR GGX prefilter, sprite path
  (template evaluated, atlas executed), Draco/meshopt (pin's own wasm),
  `lowerMatrix`, and the pin-derived constants that genuinely flow.
- **Pin-access discipline**: one executor (`importPinnedModule`, 24 call
  sites), one glTF→material mapper, one writer-lowerer; all 14 lowerers on
  `LoweringContext` (enforced by `compiler-architecture.test.ts`).
- **Tooling core**: one registry resolver, one browser harness
  (non-perturbation proven byte-for-byte), one PNG/MAD library, build
  identity enforced at every capture (the gap is only reuse, D9),
  differential env save/restore correct, dist-lock interlock coherent, no
  orphaned npm scripts.
- **Docs in the small**: every cited path/symbol/command exists; counts
  consistent (66+6 scenes, 72 previews, TODO corpus arithmetic); pinned pair
  stated exactly where policy says; zero documented-but-unread env vars.
- **Feature predicates matching upstream exactly**: transmission end-to-end
  (incl. the zero-factor-plus-texture agreement), specular/reflectance incl.
  factor-1-clears-IOR, clearcoat/sheen/iridescence/anisotropy option objects
  term-for-term, texture-transform stamps, skybox arms, `.babylon` light
  lists, morph-storage any-target rule, the feature→source cross-check, and
  the registry-parsed extension→module map.

## Suggested order

1. ~~Defects~~ — all fourteen closed 2026-08-18. (Validated: tests +
   corpus-neutral
   generated tree + 70-scene neutrality + packaged-run check. D3's shape as
   landed: pin-implemented extensions, sparse accessors, and the un-lowered
   ORM forms refuse at generation in `specializeGltf`; vertex attributes are
   deliberately not allowlisted — an attribute the pin also ignores renders
   identically on both sides — and the one pair the pin reads that this port
   truncates, `JOINTS_1`/`WEIGHTS_1`, records the `four-influence-skinning`
   fidelity adaptation instead of refusing, because Scene 7's ChibiRex
   carries it inside its gates; that truncation is now also the leading
   suspect for Scene 7's open TODO residual. D4's shape as landed: the
   `staticModules` skeleton record carries upstream's JOINTS_0 conjunct,
   `animatedWorldBounds` is its own emit option keyed on asset animations,
   and `gpuDeformation` deliberately keeps animation presence with the
   palette-as-world rationale written beside it — upstream recomputes node
   worlds live; this port bakes them, so any animated mesh needs the
   deformation transport.)
2. ~~FA-1 + DOC-A/B/C~~ — done 2026-08-18: the per-sample-transmission story
   rewritten across its six pages, the pinned-variant-era boundaries retired,
   the smaller corrections landed; only the DOC-C remainder above and DOC-D/E
   stay open.
3. ~~RD-4/6/7, RD-8/9/10, RD-1 generation half, RD-2/RD-11 round 1~~ done
   2026-08-18 (the pin executes for HDR/DDS/BRDF and the lifted
   background/grid/utility WGSL — scenes 8, 265 and 14 all moved TOWARD
   the golden; the Standard family composes from the pin behind the off
   emit option; the loader animation/sampler leaves and the four anchored
   lowerers flow from the pinned AST). Next: **RD-1 PAL wiring + flip**
   (the flagship's second half), RD-2/RD-3/RD-11 remaining rounds, RD-5,
   RD-12.
4. ~~NA-1, the NA small-table batch, TS-2/3/4, monolith round 1~~ done
   2026-08-18: the texture-slot table is generated (five copies → one, −229
   native lines), the shared native tables landed bit-identically, and
   `compiler.ts` dropped 846 lines along the proven seam. Remaining: TS-1,
   TS-8/9, the NA remainders, monolith rounds 2+.
5. ~~TL-1..12, D10~~ done 2026-08-18 (one strict parser, one backend story,
   one artifact token, everything suffixed, provenance-stamped reports).
   The wave-C batch added (a) pinned blocks and (b) shader-arm attribution
   to `scene -- diff` plus (e) `scene -- measure`, and the
   feature-activation inventory ships per scene. Remaining: the TL-gaps
   rungs (c)-(d) and (f)-(j).

Full prose report with verdicts and method:
<https://claude.ai/code/artifact/eff041d1-9935-40b5-b726-8ccb4f034186>
