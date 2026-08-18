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

Most are latent (unreached by the current corpus): exactly how the
clearcoat-remap class survived before. Each is small; fix with a fixture.

- [ ] **D6 — CPU-fallback contract (narrowed 2026-08-18; euler order is
  fixed).** Two remainders. (a) `pal_sdl.cpp` still re-implements RGBD
  decode (~line 455) beside the shared `decode_rgbd` — blocked on a shared
  header this TU can include: `pal_gpu_shared.hpp` pulls generated renderer
  headers a sprite-only scene does not emit, and `pal_sdl.cpp` compiles for
  every scene. Fold into the NA-shared hoisting. (b) The scene-1
  "smoked_glass" heuristic (`pal_sdl.cpp` ~line 962, BoomBox-lid
  thresholds) violates the no-scene-heuristics invariant, but removing it
  moves the scene-1 CPU gate whose thresholds are evidence — needs an
  explicit maintainer decision on the CPU fallback's contract (faithful
  preview vs labeled approximation).
- [ ] **D8 — DDS skybox contrast arm.** One transcribed background fragment
  serves DDS and HDR skyboxes with both contrast arms; the pinned DDS
  fragment has only the high-contrast arm (`mix(a, f, contrast-1.0)`).
  Diverges at contrast < 1 (all gated scenes use 1.2). Falls out for free
  when the fragments are lifted from the pin (RD-8).
- [ ] **D10 — cross-backend artifact overwrites.** The GPU actual defaults to
  `artifacts/parity/<id>-native.png` — outside the report directory,
  unsuffixed, rewritten by SDL and Dawn alike
  (`scene-registry.ts:1234-1236`), so after a differential run
  `report-gpu.json`'s `files.actual` holds Dawn bytes. `geometry` outputs and
  report carry no backend marker (`geometry-output-diagnostics.ts:125-146`).
  Fix: suffix all per-backend outputs; move the actual into the scene's
  output directory.

## Feature activation

- [ ] **FA-8 — mechanism inconsistencies without a stated rule.**
  (a) clearcoat/sheen = feature OR capability; iridescence/dispersion =
  capability only — write down the implicit rule (a runtime feature exists
  only for scene-source-reachable API). (b) `BBLITE_MATERIAL_DISPERSION` keys
  on extension presence (`asset-specializer.ts:399`) where upstream's
  `needsDispersion` requires factor>0 + refraction + volume — key the define
  on the evaluated predicate. (c) two predicates named `multiLight`
  (`cli.ts:787-788` vs `cli.ts:604`) — rename one. (d) `setPbrSkybox` flips
  `linearImageProcessing` for every variant (`cli.ts:614-620`) where upstream
  marks materials linear only when transmission registers — compose what the
  browser would.
- [ ] **FA-9 — provenance comments that mis-state the predicate they mirror.**
  `asset-specializer.ts:374-379` (`nonTrianglePrimitives` claims the pinned
  predicate; the negative-determinant half is unconditional inline code) and
  :233-235 (dielectric comment omits the `ior !== 1.5` arm, re-creating the
  documented trap). Behavior is right; fix the citations.
- [ ] **FA-10 — unrecorded compile-time freezes.** The variant-set freeze
  (upstream can `rebuildSingle` at run time), the MAX_LIGHTS clamp, and the
  DDS-SH/Draco/meshopt compile-time decodes have no `fidelity.json` id and no
  stated exemption policy (HDR's sibling exists at `compiler.ts:4942-4954`).
  Record them or write the policy beside the adaptation list.
- [ ] **FA-map — emit `generated/<scene>/upstream/feature-activation.json`.**
  One row per activation unit: name, mechanism (runtime feature | capability
  define | codec | emit option | composed arm | mesh bit | run-time gate),
  phase, activating predicate (file:line), upstream provenance, consumers,
  and the refusal behavior of the nearest unsupported neighbour. The CLI
  already holds every input (`cli.ts:479-817` is the only join point). The
  row that cannot cite upstream is the D4 class — the table doubles as a
  drift detector.

## Re-derivation (port, do not re-derive)

Quantified backlog: ~10,700 lines of hand-written C++ template text encoding
upstream semantics (gltf-loader 4,567; renderer ~1,900; in-lowerer ~3,460)
plus ~945 live transcribed WGSL lines, against ~1,100 lines of genuine
mechanisms (`pinned-ubo-writer-lowerer`, `light-lowerer#lowerMatrix`, the
sprite template evaluator) that are the templates to reuse. Two legitimate
shapes only: LOWER (walk the pinned AST) or EXECUTE (run the pin and bake).

- [ ] **RD-1 — Standard material family (the flagship).**
  `src/shader-builtins-standard.ts` (~500 WGSL lines) hand-rewrites
  `createStandardTemplate` + `LIGHTING_FN` with semantics re-encoded (light
  kinds remapped to float thresholds; added attenuation guard); `perturbNormal`
  re-types the exported `WGSL_PERTURB_NORMAL`; `materialVertexWgsl` hand-writes
  the shared vertex stage. The pin exports `composeStandardShader` and the UBO
  writers `writeStdMaterialData`/`writeStandardUvTransformData`
  (`standard-pipeline.js:241`) — the exact analog of the shipped PBR
  migration; writers lower via the existing `pinned-ubo-writer-lowerer`.
- [ ] **RD-8/10 — background + utility WGSL are liftable strings.** Upstream
  ships ground/DDS/HDR-skybox fragments, `WGSL_DITHER`, `WGSL_FOG`, and the
  image-processing `ip()` as plain string literals; lift them with the same
  mechanism the solid skybox in the same file already uses (fixes D8). The
  repo holds four copies of the 1.590579 chain plus a hand-built inverse
  (`pal_gpu_shared.hpp:867-905`).
- [ ] **RD-9 — grid WGSL.** `buildVertexSource`/`buildFragmentSource` are
  private but pure template functions: evaluate the pinned template with
  options bound, the way the sprite lowerer evaluates `makeSpriteWgsl`
  (~60-line evaluator precedent).
- [ ] **RD-2 — gltf-loader-cpp.ts (XL, decompose leaf-first).** 4,567 lines of
  hand-written C++ transcribing the pinned loader: slerp 0.9995, Hermite
  cubic, accessor normalization, the sampler table, dielectric/ior/dispersion
  /iridescence constants, a second hand-typed copy of the SH prescale
  constants (the .env path already lowers them), exposure/contrast 0.8/1.2.
  Key defect in the seam: `gltf-lowerer.ts` asserts pinned shapes
  (e.g. :258-262) but **no asserted value flows into the template** — a pin
  change fails an assertion while stale C++ is still what would be emitted.
  Start with pure leaves: `evaluate.ts` slerp/cubic, `gltf-sampler-desc.ts`,
  color normalize, extension defaults, via the ubo-writer-lowerer pattern.
- [ ] **RD-3 — renderer-lowerer render-plan C++ (XL, piecewise).**
  ~1,900 template lines: bucketing/sort/pipeline-kind rules, camera matrix
  chain, TRS/quaternion composition, light-slot packing, background geometry,
  texture-transform compose, transmission/extension packing. The monolithic
  `PbrUniforms` extension lanes (:444-764) are now referenced only by
  `pal_render_capture.hpp` and one `sizeof` in `pal_dawn.cpp:4696` — prune
  them. ~75 lines of inline image-skybox WGSL (:3189-3260) are liftable
  strings. Lower the math builders from their pinned modules.
- [ ] **RD-11 — in-lowerer C++ with weak or no pinning.** animation-lowerer
  (~292 lines, presence-only assertions, no extraction); camera-lowerer
  (look-at basis hand-written; unpinned 0.01/0.001 inertia constants;
  `lowerOrthographic` asserts a 7-arg shape, emits three stores);
  factory-lowerer (~1,111: geometry tables asserted against hand-built
  expectations; sphere `z_steps = 2 + segments` unpinned);
  environment-lowerer (SH constants extracted, term structure hand-written;
  scene-sizing pinned by an order-free literal bag); geometry-output-lowerer
  (Y-flip has no upstream assertion); light-lowerer (hand-writes
  `std::cos(angle * 0.5f)` at :288 beside its own working AST emitter — the
  known spot-cone ULP TODO); scene-lowerer (fog UBO offsets asserted but
  never emitted). LOWER per function.
- [ ] **RD-12 — pinned-material-input option builders.** Line-for-line
  transcription of the ext `applyMaterial` builders, plus an unguarded
  re-type of the IOR Fresnel at :489/:563. EXECUTE-able (the ext modules are
  default-exported with a stubbable ctx). Strongly gated today by
  `scene -- compose`, but the gate is capture-dependent.
- [ ] **RD-14 — asset-specializer registry regexes.**
  `asset-specializer.ts:167-177` regexes the pinned registry source with a
  hardcoded minified alias `M`; an upstream rename yields a silently empty
  feature map. Walk the AST via the store instead.
- [ ] **RD-15 — shader-material-programs attribution.** The
  `alpha-card`/`circular-cutout` WGSL bodies are re-formatted corpus copies
  (semantically gated by IR comparison at `compiler.ts:2496-2548`, but the
  file never says where the text came from, and the emitted artifact carries
  the table's copy). Attribute and emit from the verified scene text.
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
- [ ] **TS-5 — four hand-rolled argv parsers**, one closure triple-pasted
  inside `scene-command.ts` (:760, :843, :863). One strict `parseFlags`
  (also closes TL-2).
- [ ] **TS-8/9/10 — small consolidations.** `transpileForBrowser` (×3);
  `captureDirectory()`/`parityDirectory()` helpers (path expression ×5);
  exported `ParityReport`/`DifferentialReport` types consumed by
  verify-status.
- [ ] **Monolith — extract `compiler.ts` (5,521 lines) along the proven
  seam.** The `*Context` interfaces already exist and the intrinsic modules
  already declare the option-compiler methods. Order by size: the expression
  switch (958-1600 → `compiler/expressions.ts`), intrinsic option compilers
  (1601-3313 → their per-domain intrinsic modules), browser erasure
  (4245-4588 → self-contained module, cleanest cut), adaptations
  (4825-5016), assets (4083-4208), scopes (5017-5199), emission primitives
  (5421-5443). In `cli.ts`, ~450 lines of business logic want
  `babylon-asset-features.ts` (the `.babylon` twin of asset-specializer,
  currently inline at :324-436) and a `compose-pipeline.ts` (:596-745).
- [ ] **Dead code — remainder.** Decide `composePinnedPbrShader`/
  `pinnedComposer` (production composes through `createPbrComposer`; only
  their own test imports them — keep only if that test is meant as an
  independent pin-contract guard, else delete both plus the test half).
  ~15 `export` keywords on file-local symbols. Add `knip` or `ts-prune` so
  unused exports cannot re-accumulate. (The verified-dead items — the probe,
  the `false ? {…}` block, the empty-template map, `assetDigest`, the
  sprite-atlas pair, the modular-scene examples, `half-float.ts` after both
  packagers went GPU — are deleted.)

## Native

- [ ] **NA-1 — generate the texture-slot table (the LightKind fix at ~5×
  the mass).** The material-field→slot association, per-slot sRGB flags,
  fallback texels, and extension append order exist in five copies:
  `pal_sdl_gpu.cpp:3938-4238`, `pal_dawn.cpp:4716-4881`, the two
  `pinned_resource_for` name maps (`pal_sdl_gpu.cpp:468-544`,
  `pal_dawn.cpp:2063-2155`), and Dawn's comment block (:72-106) — ~530 lines.
  The names half already exists generated (`pbr_variant_bindings`). Emit one
  generated table `{slot, material_field, srgb_rule, fallback_rule,
  pinned_names}`; each backend keeps only enum→API translation.
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
- [ ] **NA-generated-warnings.** Generated `pbr_variants.hpp` no-op writers
  carry an unreferenced `material` parameter (`warning C4100`, e.g.
  scene32:270,353) — the warning-clean rule covers generated C++ too; emit
  `[[maybe_unused]]` on writer parameters a variant's arms never read.
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

- [ ] **DOC-C remainder — flag/switch documentation and two wording items.**
  Document or delete parity `--exe/--actual/--no-fail`, capture `--out`,
  diff `--capture` (its `--seek` is now covered by the reuse-provenance
  text), `BBLITE_NATIVE_EXE`, cli `--width/--height` — pairs with the
  tooling wave's shared parser (TL-9). features.md 347 "PBR carries two
  analytic slots" (under multi-light the shape is the primary slot plus a
  7-entry extras loop, second analytic disabled); features.md
  platform-validation understates the recorded Vulkan findings (TODO's
  Vulkan section carries them).
- [ ] **DOC-D — deduplicate: 31 facts stated in 2-5 places.** Worst: the
  Tint-SPIR-V/DXC limitation (6 pages), differential semantics (5), Dawn's
  no-offline-shaders property (5), capture deferral (4), the capture ladder
  duplicated into copilot-instructions against its own no-duplication rule,
  the orbit/bisect method (3 full copies with both war stories). Owner =
  the canonical page per copilot-instructions' map; non-owners compress to a
  clause + link (the model exists: development.md's minimal-size section
  already links `backends.md#empirical-findings`).

## Tooling

- [ ] **TL-1 — one backend selection story.** parity/geometry/neutrality use
  `BBLITE_GPU_BACKEND` only; diff/capture use `--backend` only and
  `capture-native.ts:73` deliberately strips the env var — so
  `BBLITE_GPU_BACKEND=dawn scene -- diff` silently measures sdl_gpu and
  `parity --backend dawn` is rejected. Accept `--backend` everywhere, honor
  the env var as fallback, warn on override.
- [ ] **TL-2 — one strict parser.** parity rejects unknown flags; diff/
  capture/uniforms ignore them; compose drops all args
  (`scene-command.ts:902-904`); `--differential` silently discards companions
  (:304-309, :332-335). `diff --recapture-reference` — the typo the twin
  names invite — is a silent no-op today. Shared `parseFlags` (TS-5), unknown
  flag = error, incompatible combination = error naming the workaround.
- [ ] **TL-4/5 — one backend token, everything suffixed.** `gpu` in parity
  artifacts vs `sdl_gpu` in capture artifacts; plus D10. Accept both
  spellings on read for one release.
- [ ] **TL-6/8/9/10/11/12 — seam fixes.** `--seek` on parity/geometry
  (currently a registry edit mid-ladder); document diff's `--seek/--capture`;
  unify `--out` vs `--capture`; `--gpu-debug` on capture/diff (hoist the
  two-env-var setup: `BBLITE_GPU_DEBUG=1` + `SDL_ASSERT=always_ignore`);
  a shared `writeReport(kind, payload)` adding `{tool, backend, buildStamp,
  writtenAt}` (five ad-hoc shapes today); compose accepts `--capture` and
  writes `compose.json`; retire parity-scene's direct-exec hook (:738-746,
  bypasses the dist lock); fix the usage string offering `all` where five
  subcommands throw (:911); one test for scene-command argument parsing
  (today: none).
- [ ] **TL-gaps — build the missing rungs (plumbing mostly exists).**
  (a) Fold `pinnedMaterialBlocks`/`pinnedMeshBlocks` into `scene -- diff`
  (the two-listing rule automated; `correspond()` exists; blocks are in the
  capture; flag refused-variant blocks distinctly). (b) Shader-arm hashing in
  diff: normalize+hash capture `shaders/` vs `upstream/pbr-variants/`, report
  matched/one-sided with compose's divergence line. (c) Palette matching vs
  `tex-uploads.json` (zero readers today) with the documented mirror map
  applied. (d) `scene -- probe-variants <id>` (the stripped-shader-dir probe;
  write the recipe into debugging.md regardless). (e) `scene -- measure <png>
  [--background r,g,b]` (~40 lines over parity.ts). (f) `capture
  --seek-bracket` (±1-frame motion scale). (g) `parity --without
  ground|background` (the bisection ordering experiment). (h) `scene --
  stability <id> [--runs N] [--single-sample]` (the 9/37 wobble check with
  the never-vs-golden trap built in). (i) generated-tree neutrality mode
  (compile-and-digest with the stray-directory footgun handled). (j) the
  `validate` bundle TODO already asks for.

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

1. **Defects** — remaining: D8 (falls out of RD-8), D10 (M, pairs with the
   tooling wave), and the D6 contract decision. (D1-D5, D7, D9, D11-D14 and
   D6's euler half closed 2026-08-18, validated: tests + corpus-neutral
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
3. ~~RD-4/6/7~~ done 2026-08-18 (the pin executes for the HDR package, DDS
   harmonics, and BRDF LUT; scenes 8 and 265 both moved TOWARD the golden).
   Next: **RD-8/9/10** (lift the background/grid/utility WGSL), then
   **RD-1** (Standard family) as the flagship; RD-2/RD-3 leaf-by-leaf
   behind it.
4. **NA-1** and the NA small-table batch; TS-1/2/3 clusters; monolith
   extractions opportunistically along the mapped seam.
5. **Tooling**: TL-1/2/4/5 (parser + naming), then the TL-gaps ladder
   upgrades (a)-(c) first — they convert the two most expensive manual
   recipes into `scene -- diff`.

Full prose report with verdicts and method:
<https://claude.ai/code/artifact/eff041d1-9935-40b5-b726-8ccb4f034186>
