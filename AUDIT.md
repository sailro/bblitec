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

- [ ] **D1 — emissive texture slot gated by the emissive factor.**
  `src/pinned-material-input.ts:233-235` builds the `emissive` slot only when
  `gltfEmissiveApplies(material)`; upstream wraps the texture whenever
  `_emissiveImage` exists (`gltf-pbr-builder-ext.js:54`), and `_hasTx` (:76)
  and uv2Mask bit 8 (:87) read that wrapper. An emissive texture with factor
  `[1,1,1]` plus `KHR_texture_transform` or TEXCOORD_1 composes a fragment
  missing the transform/uv2 arm. Fix: drop the gate in `pinnedTextureSlots`
  (keep it for `_emissiveColor`); fix the contradicting comment at :145-153
  (the correct statement is at :689-694); add the fixture.
- [ ] **D2 — static `KHR_materials_emissive_strength` never forces
  `_emissiveColor`.** Upstream's extension calls
  `setPbrEmissive(layer, factor×strength)` whenever declared
  (`gltf-ext-emissive-strength.js`); here only `gltfEmissiveApplies` or the
  animated pointer set it (`src/pinned-material-input.ts:723-726`). A strength
  asset with white factor composes no emissive term at all. Fix: declared
  extension ⇒ `_emissiveColor = factor×strength`, mirroring ext-runs-first.
- [ ] **D3 — unhandled asset features drop silently.**
  `KHR_materials_pbrSpecularGlossiness` composes the metallic-roughness
  fragment and renders wrong with no error (upstream: registry row →
  `gltf-ext-spec-gloss.js` → `PBR_HAS_SPEC_GLOSS`; no mapping in src/).
  `JOINTS_1`/`WEIGHTS_1` 8-influence skinning ignored
  (`gltf-loader-cpp.ts:2377-2398` reads a fixed attribute set; upstream sets
  `MSH_HAS_SKELETON_8`). Same class: `KHR_materials_diffuse_transmission`,
  `KHR_texture_basisu`, thin-instance colors. Meanwhile sparse accessors and
  split-ORM refuse at *run time* (`gltf-loader-cpp.ts:1983-1986, 1551-1556`)
  though the specializer knows at generation. Fix: an
  `extensionsUsed`/attribute allowlist in `specializeGltf` that fails
  generation for anything unhandled; move the run-time refusals to generation.
- [ ] **D4 — `gpuDeformation` keyed on animation presence.** The only
  specializer predicate with no upstream citation
  (`src/asset-specializer.ts:361-363`; `src/cli.ts:748-752` adds
  morph-targets). Upstream keys skeleton on `skins + JOINTS_0`
  (`gltf-feature-registry.js:31-32`). A skinned-but-unanimated asset composes
  skeleton variants while `BBLITE_GPU_DEFORMATION=0` compiles the PAL arm out.
  The `staticModules` record also drops the `JOINTS_0` conjunct
  (`asset-specializer.ts:200`), and `test/asset-specializer.test.ts:45-52`
  pins the divergent boundary. Fix: split into `animatedWorldBounds :=
  animations` (the loader parameter is literally named that,
  `gltf-lowerer.ts:120`) and `gpuDeformation :=` upstream's skins/morph
  predicates; fix the skins conjunct and the test; add provenance comments.
- [ ] **D5 — Dawn has no no-environment fallback cube.** SDL uploads the pinned
  `{0.15f, 0.16f, 0.2f, 1}` face (`pal_sdl_gpu.cpp:1498-1507`); Dawn's
  `upload_environment` early-returns (`pal_dawn.cpp:1331`) leaving its
  zero-initialized cube. `docs/backends.md` lists the fallback as a ported
  contract. Fix: shared constant + shared has-environment rule in
  `pal_gpu_shared.hpp`.
- [ ] **D6 — CPU fallback drift.** `pal_sdl.cpp:222-233` composes euler
  X→Y→Z where the shared pinned helper is Z→Y→X
  (`pal_gpu_shared.hpp:129-155`); `pal_sdl.cpp:437-469` re-implements RGBD
  decode beside the shared one; `pal_sdl.cpp:944-949` carries a scene-1
  "smoked_glass" heuristic (BoomBox-lid thresholds), against the repository's
  no-scene-heuristics invariant. Fix minimum: align euler, reuse
  `decode_rgbd`, delete the heuristic or decide the fallback's contract
  explicitly (faithful preview vs labeled approximation).
- [ ] **D7 — packaged SDL_GPU PBR demos throw.** `tools/package-demo.ps1`'s
  SDL_GPU/BOTH payload patterns (`*.dxil`, `*.spv`[, `*.native.wgsl`]) omit
  `*.slots`, which the pinned-variant draw path requires
  (`pal_sdl_gpu.cpp:305-354`). Fix: add the pattern; package scene1 and run it
  as the check.
- [ ] **D8 — DDS skybox contrast arm.** One transcribed background fragment
  serves DDS and HDR skyboxes with both contrast arms; the pinned DDS
  fragment has only the high-contrast arm (`mix(a, f, contrast-1.0)`).
  Diverges at contrast < 1 (all gated scenes use 1.2). Falls out for free
  when the fragments are lifted from the pin (RD-8).
- [ ] **D9 — `scene -- diff` trusts any capture on disk.** The native capture
  embeds `buildStamp` (`render-diff.ts:116`; written by
  `pal_render_capture.hpp`) but the reuse path never compares it
  (`scene-command.ts:771,781`), and a `--seek` change does not invalidate
  reuse. `verify-status.ts:76-95` prefers `report-differential.json` over
  fresher single-backend reports regardless of mtime. Fix: compare embedded
  stamp (and a recorded seek) on reuse, auto-recapture or refuse; prefer the
  newest report source or flag disagreement.
- [ ] **D10 — cross-backend artifact overwrites.** The GPU actual defaults to
  `artifacts/parity/<id>-native.png` — outside the report directory,
  unsuffixed, rewritten by SDL and Dawn alike
  (`scene-registry.ts:1234-1236`), so after a differential run
  `report-gpu.json`'s `files.actual` holds Dawn bytes. `geometry` outputs and
  report carry no backend marker (`geometry-output-diagnostics.ts:125-146`).
  Fix: suffix all per-backend outputs; move the actual into the scene's
  output directory.
- [ ] **D11 — MAX_LIGHTS frozen and silently clamped.** Upstream grows it per
  asset (`setMaxLights`, `gltf-feature-lights-punctual.js:37-39`); native
  writers `break` past 16 (`pal_gpu_shared.hpp:644-682`) and excess lights go
  unlit with no generation-time check and no fidelity record. Fix: count
  light nodes in the specializer; refuse (or emit the grown constant) at
  generation.
- [ ] **D12 — occlusion-carrier split tests `_hasTx` where upstream tests
  transform declaration.** `src/pinned-material-input.ts:246-250` vs
  `occlusionNeedsSplit` (`gltf-pbr-builder-ext.js:16-23`:
  `occ.extensions?.KHR_texture_transform != null`). A declared-but-empty
  transform splits upstream but not here. Fix: test declaration; fixture.
- [ ] **D13 — three float-literal formatters, two of them wrong at the edge.**
  `static-evaluator.ts:812-824` and `data-types.ts:967-972` use
  `Number.isInteger` and emit `1e+21.0f` (invalid C++) for integer-valued
  exponent-notation numbers; `lowering/context.ts:547-560` handles it. Fix:
  one shared literal module with the context.ts semantics (see TS-6/7).
- [ ] **D14 — two half-float encoders round differently.** `ibl-brdf-lut.ts`
  uses `Math.round`; `hdr-packager.ts` rounds nearest-even. One authority.

## Feature activation

- [ ] **FA-1 — the documented activation boundary is false.**
  `docs/features.md:136-137` and `docs/architecture.md:269-270` say no asset
  fact can reach the feature list; `src/cli.ts:564-595` joins asset-borne
  `light:*` kinds and `environment:ibl` into it and re-renders features.cmake
  (rationale only in the comment at cli.ts:559-563: light features select
  `light_*.cpp` translation units). Fix the docs to name the two exceptions
  and the reason.
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

- [ ] **RD-4 — hdr-packager (do first, sets the pattern).** `parseRgbe`,
  `computeSphericalHarmonics`, `shToPolynomial` re-type upstream functions
  that are **exported** (`hdr-parser.js`, `spherical-harmonics.js`) — direct
  Node imports today. `preScalePolynomial` constants ↔
  `ibl-env-assembly.js`. Mip 0 comes from a JS transcription of the pinned
  equirect compute while mips 1+ already execute the pinned shader in
  Chromium — route mip 0 through the same harness. Current
  `test/hdr-packager.test.ts` sha256 goldens are self-referential (a pin
  change leaves them green); replace with pin-comparison.
- [ ] **RD-1 — Standard material family (the flagship).**
  `src/shader-builtins-standard.ts` (~500 WGSL lines) hand-rewrites
  `createStandardTemplate` + `LIGHTING_FN` with semantics re-encoded (light
  kinds remapped to float thresholds; added attenuation guard); `perturbNormal`
  re-types the exported `WGSL_PERTURB_NORMAL`; `materialVertexWgsl` hand-writes
  the shared vertex stage. The pin exports `composeStandardShader` and the UBO
  writers `writeStdMaterialData`/`writeStandardUvTransformData`
  (`standard-pipeline.js:241`) — the exact analog of the shipped PBR
  migration; writers lower via the existing `pinned-ubo-writer-lowerer`.
- [ ] **RD-6 — dds-packager computeSH.** ~120 lines re-typing the pin's
  internal `computeSH` (`load-dds-env.js`); good provenance comments, **no
  test at all**; bit-exact executable alternative proven. EXECUTE.
- [ ] **RD-7 — ibl-brdf-lut.** JS re-derivation of the pinned `brdfLutWGSL`
  compute feeding the shipped `.rgba16f`; upstream `generateBrdfLut` is
  exported and the Chromium WebGPU harness exists. EXECUTE.
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

- [ ] **TS-1 — browser-harness ceremony ×4.** Identical
  server-listen → Chromium-launch → page-drive → teardown in
  `capture-suite-reference.ts:270-321`, `capture-instrumented.ts:214-259`,
  `hdr-prefilter-gpu.ts:209-230`, `sprite-atlas-packager.ts:105-136`.
  Extract `withBrowserPage()` + `waitForSceneReady()` (~120-150 lines
  removed). `browser-path.ts`'s own header records the drift this stack
  already had once.
- [ ] **TS-2 — two `buffers.json` decoders, already drifted.**
  `capture-uniforms.ts` (accepts `bytes ?? data`, uniform-usage only) vs
  `render-diff.ts` (`data` + `mappedWrites`, small storage buffers) plus two
  WGSL layout implementations — a mapped-at-creation buffer decodes in `diff`
  and is invisible to `uniforms`, a dead end mid-ladder. One capture-decoder
  module; `render-diff` already imports `parseWgslStructs` from there.
- [ ] **TS-3 — GLB/glTF document reading ×4-5 + duplicated animated-pointer
  contract.** `glbDocument` twice under the same name
  (`pinned-material-arms.ts:117-137`, `scene-compose-report.ts:61-74`), plus
  `cli.ts:250-264`, `asset-specializer.ts:139-142`,
  `compressed-geometry.ts:27`; `asObject`/`asNumber` re-declared in four
  files; and `materialSubjects` duplicated between generation and the compose
  gate **with the four animated-pointer regex literals repeated** — a fifth
  pointer added to one side silently unsyncs the gate. One `gltf-document.ts`
  + one exported `materialSubjects`.
- [ ] **TS-4 — native-run spawn ceremony ×2.** `parity-scene.ts:206-281` vs
  `capture-native.ts:65-102`: same npm-env filtering, same env assembly, same
  spawnSync/error shape; each has options the other lacks. Extend `runNative`
  with capture options.
- [ ] **TS-5 — four hand-rolled argv parsers**, one closure triple-pasted
  inside `scene-command.ts` (:760, :843, :863). One strict `parseFlags`
  (also closes TL-2).
- [ ] **TS-6/7 — one `cpp-literals.ts`** for float/double literals (D13) and
  the ×3 identifier-sanitize regex (`compiler.ts:5423`, `data-types.ts:134`,
  `native-functions.ts:444`).
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
- [ ] **Dead code (verified zero references).** Delete:
  `tools/sdl-multisample-probe.c` (or name it in the SDL-3.6.0 TODO entry as
  the verification tool); `hdrGgxPrefilterReferenceWgsl`
  (`hdr-prefilter-gpu.ts:35-134`); the `false ? {…}` diagnostics block
  (`parity-scene.ts:532-549`) and its orphaned `artifacts/parity/scene1`
  outputs; `renderer-lowerer.ts:148,3000-3004` (empty `sources` map toward a
  deleted template directory); `assetDigest` (`compressed-geometry.ts:512`);
  `getSpriteAtlasProvenance`, `readPngSize` (`sprite-atlas-packager.ts`).
  Decide: `composePinnedPbrShader`/`pinnedComposer` (production uses
  `createPbrComposer`; only its own test imports it — keep only if the test
  is meant as a pin-contract guard); `examples/modular-scene.ts` pair;
  ~15 `export` keywords on file-local symbols. Add `knip` or `ts-prune` so
  unused exports cannot re-accumulate.

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
- [ ] **NA-3 — mip policy.** Chain-length formula hand-written ×4 + the
  transmission mips-minus-4 derived two different ways
  (`pal_dawn.cpp:4374-4378` hardcodes 11-4; `pal_sdl_gpu.cpp:1785-1795`
  derives). Shared helper; emit Dawn's mip-blit WGSL from generation
  (currently a C++ string invisible to shader provenance).
- [ ] **NA-4 — transmission constants + trigger predicate shared.** 1024²,
  −4 mips, repeat-trilinear-aniso-4, first-transmissive-draw predicate —
  duplicated at `pal_sdl_gpu.cpp:1759-1804,5973-6024` and
  `pal_dawn.cpp:4374-4402,6610-6631`. Pass mechanics stay per backend.
- [ ] **NA-5/6/7 — small shared tables.** Geometry attachment format-class +
  clear rules (×2); blend-factor 4-tuples per bucket (restated at every
  pipeline site); skybox family sub-order + back-cull default (×2; the Dawn
  comment at `pal_dawn.cpp:4917-4921` claiming SDL keeps the undithered
  fragment is stale — fix in passing).
- [ ] **NA-12/13/14/15 — finish started extractions.** Sprite instance layout
  /sort/blend-check (generate the layout table; Dawn hardcodes the atlas
  sampler SDL derives from the record); `skeleton_draw`/`world_from_palette`/
  `mirrored_vertices` boolean derivation (×2 → one shared helper feeding the
  already-shared `pinned_draw_world`); bone-palette texture layout constants;
  diagnostic id/cluster uniform structs + packing (×2; `advance_cluster_range`
  already shared).
- [ ] **NA-shared — hoist the non-API masses into `pal_gpu_shared.hpp`.**
  Readback row-conversion (~250 lines), mesh-sync dirty policy (~235; SDL's
  inline weights rebuild at :4377-4404 duplicates shared
  `pack_morph_weights` — call it), shader-variant stage-block gather loop
  (×4 incl. `pal_render_capture.hpp:827-857`), ModelVertex→GpuVertex quad
  packing (×4), run-flag interpretation (×3 incl. `pal_sdl.cpp:1181-1190`),
  sprite-alongside-scene refusal (×2 identical), CPU benchmark through
  `report_benchmark`. Rule: tables and predicates move; pass encoding, bind
  groups, and swapchain stay per backend (the mutually-validating surface).
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

- [ ] **DOC-A — rewrite the per-sample-transmission story (six pages).**
  The vendored SDL patch shipped per-sample image processing on SDL_GPU
  (`pal_sdl_gpu.cpp:2649-2676, 6435-6443`); the resolved-pixel pass is now
  the stock-SDL/1× fallback. Stale copies: `fidelity.md` ~294-303 ("cannot
  close without per-sample access" — keep only the scene-color-grab half,
  which does still resolve-then-copy); `status.md` scene-253 note
  (contradicted by its own 0.001/0.003 row — delete); `backends.md` 115-123
  (stale numbers, names "IOR/volume/scene-color gates" that do not exist in
  the registry, "Dawn equal or better on every scene" falsified by scenes
  31/242/247 foreground cells), 274-284 (dangling "the P1 entry below"),
  80-84 (dawnThresholds justification), 71-77 (the dual-sweep recipe —
  `scenes:parity` already runs both backends; the second invocation is a
  redundant repeat); `architecture.md` 347-360 ("uniquely expresses" — only
  the multisampled grab remains Dawn-only).
- [ ] **DOC-B — retire the pinned-variant-era boundaries (three pages +
  TODO).** "Clearcoat/sheen + punctual multi-light fails explicitly" no
  longer exists anywhere in src (variants compose every arm under all three
  light modes; scene 253 green) — delete from `features.md` 516-517,
  `fidelity.md` 148-149, `TODO.md` 122-123. `fidelity.md` 135-148 still
  describes "a single generated variant", contradicting its own variant
  section (78-90) — rewrite the layer intro. `TODO.md` 38-43 ("16 marker
  rewrites / 8 regexes") describes machinery deleted with the transcription
  (`renderer-lowerer.ts` has zero `.replace(` left; the ~23 remaining markers
  are assertions) — re-scope to what remains (Grid/background/Standard
  fragments still emitted as text outside the typed shader IR). `TODO.md`
  294 (scene 21) is done — delete. `architecture.md` 211 ("directional/
  hemispheric two-light Standard") and `features.md` 506-507 understate
  shipped Standard lighting (scene 9: three point lights; scene 15: two
  spots; slot count = max(2, declared `.babylon` point lights)).
- [ ] **DOC-C — smaller corrections.** development.md animation-gate table
  lists 5 of 18 seeking scenes (point at the registry); `BBLITE_BACKGROUND`
  descriptions omit the solid skybox in development.md:536 and
  fidelity.md:314 (features.md has it right); runtime-switch table missing
  `BBLITE_ANIMATION_SEEK_SECONDS` (features.md points readers at that table
  for it), `BBLITE_TEST_PASS`, `BBLITE_ID_BUFFER`, `BBLITE_CLUSTER_BUFFER`,
  `BBLITE_COPY_TASK`; document or delete parity `--exe/--actual/--no-fail`,
  capture `--out`, diff `--capture/--seek`, `BBLITE_NATIVE_EXE`, cli
  `--width/--height`; architecture.md's "complete source map" omits 11
  existing files (`pal_render_capture.hpp`, `pal_camera_controls.hpp`, sprite
  hpps, `compiler/classes.ts`, `compiler/promises.ts`, the four pinned-*
  variant/mesh/scene modules, `pinned-ubo-writer-lowerer.ts`); debugging.md
  130-133 describes a block-pairing algorithm `render-diff.ts:15-23`
  explicitly does not implement, and its artifact table (324-327) names
  `report.json`/`*-diff.png`/`*-hotspots.png` where the code writes
  `report-{gpu,dawn,cpu}.json`/`diff-map-<sfx>.png`/`hotspots-<sfx>.png`;
  README omits Ninja and DXC from requirements; status.md rows 39/50
  mis-ordered, scene-253 row missing trailing pipe, no blank line before the
  gates heading, gate table alignment differs, two coverage cells are
  narratives; `scene-neutrality.ts:5` credits backends.md for a procedure in
  development.md; features.md 347 "PBR carries two analytic slots" (under
  multi-light: primary + 7-entry extras loop, second analytic disabled);
  features.md platform-validation understates the recorded Vulkan findings.
- [ ] **DOC-D — deduplicate: 31 facts stated in 2-5 places.** Worst: the
  Tint-SPIR-V/DXC limitation (6 pages), differential semantics (5), Dawn's
  no-offline-shaders property (5), capture deferral (4), the capture ladder
  duplicated into copilot-instructions against its own no-duplication rule,
  the orbit/bisect method (3 full copies with both war stories). Owner =
  the canonical page per copilot-instructions' map; non-owners compress to a
  clause + link (the model exists: development.md's minimal-size section
  already links `backends.md#empirical-findings`).
- [ ] **DOC-E — strip dev-log/history (~45 passages).** Delete pure war
  stories ("this cost an hour on scene 242" debugging.md:64, the
  benchmark-bracket migration backends.md:135-144, "used to name the first
  two separately" development.md:806-809). Compress before/after MAD pairs to
  the surviving contract (scene-243 five-suspects narrative, viewport
  1.077→0.063 pairs — whose "after" values are stale vs status.md anyway,
  scene-255 0.101→0.249→0.000, solid-skybox clip-z forensics, scene-14
  7.312→0.339, scene-39 0.581). Keep measured evidence for live contracts
  (dither magnitudes, VS-vs-Ninja and concurrency benchmarks, the 1.18→1.20
  findings, TODO's distilled residual entries). The test: does a maintainer
  need it to act today?

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

1. **Defects** D1-D14 (a day or two of S-sized fixes; D3/D4 are M).
2. **FA-1 + DOC-A/B** — make the docs true again (the two migration
   clusters), delete the completed TODO entries.
3. **RD-4 → RD-6/7 → RD-8/9/10** — the EXECUTE quick wins, then
   **RD-1** (Standard family) as the flagship; RD-2/RD-3 leaf-by-leaf
   behind it.
4. **NA-1** and the NA small-table batch; TS-1/2/3 clusters; monolith
   extractions opportunistically along the mapped seam.
5. **Tooling**: TL-1/2/4/5 (parser + naming), then the TL-gaps ladder
   upgrades (a)-(c) first — they convert the two most expensive manual
   recipes into `scene -- diff`.

Full prose report with verdicts and method:
<https://claude.ai/code/artifact/eff041d1-9935-40b5-b726-8ccb4f034186>
