# bblitec TODO

Only unfinished work belongs here. Completed capabilities and measured
baselines belong in [status](docs/status.md) and Git history.

## Constraints

- derive Babylon behavior from the pinned upstream TypeScript
- keep handwritten C++ at the PAL/resource boundary
- preserve tree shaking, provenance, typed records, and C++20 portability
- do not add scene, geometry, or golden-image heuristics
- validate generation, native builds, and relevant parity gates locally

## P0 — Dual render backends

The Dawn (WebGPU) backend is complete: every scene either backend can
express passes on both at values equal to or better than SDL_GPU (see
[backends](docs/backends.md) for the architecture, the honest
comparison, and the empirical regression guards). Both backends stay
long-term as mutually validating implementations — the direct
Dawn-versus-SDL_GPU diff is the project's decisive diagnostic: two
independent compiler and API stacks agreeing to one LSB isolates
CPU-side from GPU-side causes immediately.

- [ ] Re-enable the pinned position-seeded background dither on Dawn
  (scenes 6/14; scene 7's solid skybox and ground share the same
  disabled dither and reduce to the clear color without it — its
  0.247 full MAD is this floor). The dithered ground/skybox variants
  are now emitted at generation time, but enabling them on Dawn
  measurably regressed scene 6 (0.283 → 0.333 full MAD): the pinned
  dither hash seeds on interpolated world positions whose low bits
  follow the barycentrics, so it only reproduces once the native
  camera view-projection matches the pinned engine bit for bit. The real
  dependency is porting Babylon's camera composition (view from the
  camera world matrix, `mat4PerspectiveLHToRef` reverse-Z, JS-double
  multiply) — which also implies adopting reverse-Z in the native
  main pass (previously verified image-neutral) and would kill the
  VP epsilon differences recorded by the instrumented captures.
- [x] Port the scene 1 diagnostics/attribution outputs to Dawn (draw
  IDs, triangle clusters, PBR diagnostic buffers). Both backends now
  serve `parity:diagnostics` (select with `BBLITE_GPU_BACKEND=dawn`);
  the id and cluster buffers came out byte-identical across backends
  and the PBR buffers agree to one LSB except pre-tone HDR (≤10 ulp
  in the raw halfs from the offline-DXC-versus-Dawn compile split).
  The cluster shader's `enable primitive_index` requires the Dawn
  device to request the primitive-index feature (adapter-gated in
  `pal_dawn`).
- [x] Formalize a backend-differential comparison mode in the parity
  tooling (render both backends, diff them against each other and the
  golden in one report), then review the per-scene thresholds against
  the Dawn columns. `scene parity <id> --differential` writes
  `report-differential.json` with per-backend and backend-delta
  numbers; `dawnThresholds` registry entries gate the Dawn columns.
- [ ] Extend the Dawn integration beyond Windows: the platform surface
  is one HWND branch plus the adapter backend selection and the per-OS
  Dawn library build — the WGSL feeds Dawn directly on every backend,
  so no per-platform shader work exists on this path (unlike the
  SDL_GPU items below).
- [ ] Minimize release-package size beyond the backend split. The
  `BBLITE_BACKEND` selection (SDL_GPU/DAWN/BOTH) and the
  scene-parameterized `package:demo` flow now ship only the compiled
  backend's payload (offline DXIL/SPIR-V versus WGSL text, Dawn DLLs
  only when compiled, no text shader intermediates). Remaining
  directions: measure and trim the Dawn DLL set (webgpu_dawn plus its
  DXC pair dominate the DAWN payload; a DXC-less Dawn build changes
  rendering per the recorded FXC findings, so slimming means Dawn
  build options, not dropping the compiler), strip or compress the
  MSVC CRT set to the DLLs the exe actually imports, drop the SPIR-V
  variants from D3D12-only packages once the packaging flow can
  declare a target driver, and evaluate packed native assets (the P1
  entry below) for asset-payload reduction.

## P1 — TypeScript compiler coverage

### Modules and functions

- [x] Resolve named local multi-file imports and re-exports.
- [ ] Add namespace/default imports and non-static module initialization.
- [ ] Build a typed user-code IR from `ts.Program`/`TypeChecker` symbols.
- [ ] Move statement, expression, and intrinsic lowering into focused
  compiler modules instead of extending the entry compiler monolith.
  Property lowering has moved out: the declared reads live in
  `compiler/properties.ts` and the declared writes in
  `compiler/assignments.ts`, each a table the entry compiler consults
  rather than a chain it extends.
- [x] Generate scene-local custom shader variants from supported WGSL
  IR instead of limiting native emission to predeclared variant names:
  createShaderMaterial compiles the entry file's own WGSL through the
  typed shader IR into a generated per-scene variant table (pipeline
  state from the pinned shader-pipeline mapping, reflected per-stage
  uniform blocks, declared uniform defaults), both PALs build their
  shader pipelines from the table, and uniform writes resolve to
  reflected value offsets at compile time. The reached surface keeps
  the worldViewProjection-only system block; wider system-uniform sets
  (viewProjection + world) stay with scene 165.
- [ ] Extend shader IR to composed PBR/Grid/background fragments, then replace
  the remaining renderer-lowerer source-text contracts with parsed shader IR.
- [x] Lower non-generic typed user functions, defaults, and one final return.
- [x] Support lexical block scopes and safe variable shadowing.
- [x] Lower block-scoped `if`/`else`, numeric `for`, and `while`.
- [x] Unroll `for...of` over statically resolved array literals.
- [x] Emit fully data-typed user functions as real C++ functions with
  native early returns and once-only emission (handle-touching helpers
  keep the inline path); runtime `for` headers carry the incrementor so
  `continue` matches JavaScript.
- [x] Lower runtime iterables over data containers, numeric `switch`,
  `break`, and `continue`. String-literal switch discriminants (input
  handling) stay with the input-layer erasure lane.
- [x] Generalize typed object and array literals into the plain-data
  model: interface structs, `T | null` optionals with checker narrowing,
  dynamic arrays, deep static numeric tables, tuple/struct destructuring
  in for-of, swap destructuring, and object spread in declarations and
  assignments.
- [x] Add string-literal-union enum tags and null narrowing. Discriminated
  unions and numeric-literal narrowing beyond checker null analysis remain.
- [ ] Replace the conservative alias rules (path-bound locals are
  read-only copies; owned locals reject writes after escaping by copy)
  with real escape analysis when a reached scene needs shared mutable
  objects.
- [ ] Close the primary-slot directional specular residual: a
  directional light in the FIRST analytic slot under mid/low roughness
  renders its specular highlight a few percent dim (probe measurement
  2026-08-13: sphere, roughness 0.35, max channel delta 10-15 at the
  highlight, independent of `directIntensity`). No gated scene reaches
  this combination, because a hemispheric light is added first and the
  directional key then runs in the second slot, which is
  byte-effectively exact — but the primary directional
  block should be diffed against the pinned
  `singlelight-directional-wgsl.ts` term by term before a scene needs
  it.
- [ ] Port fdlibm/V8 transcendentals (`pow`, `exp`, `cos`, `sin`) for
  bit-exact parity. `cos`/`sin` ULPs against V8 were the measured
  floor on rotated silhouettes (0.002 foreground on both backends).
- [ ] Inlined value returns compile through the default float path in
  compound numeric contexts (a double-to-float-to-double round-trip);
  route inline return expressions through double precision. Parameter
  reassignment inside inlined functions can also still fold a static
  argument; strip static metadata from parameter bindings that are
  reassigned.
- [ ] Extend array coverage to `shift`/`unshift` and the `indexOf`
  `fromIndex` form when a reached scene needs them (`splice`,
  `indexOf`, and multi-argument `push` have landed).
- [ ] Support off-center orthographic planes: `enableOrthographicCamera`
  accepts explicit `left`/`right`/`bottom`/`top` bounds that replace the
  half-extent derivation, and `disableOrthographicCamera` restores the
  perspective projection. Scene 268 reaches neither, so the compiler
  rejects those planes instead of deriving them silently and the native
  camera record carries one extent. The orthographic branch also lives in
  `build_view_projection` alone, so composing it with an environment
  skybox or ground — which build their own perspective view-projection —
  fails explicitly at generation.

### Closures and async

- [ ] Classify escaping and non-escaping closures.
- [ ] Lower general render/update callbacks.
- [ ] Define ownership for escaping captures.
- [ ] Generalize immediate AOT promises and dynamic-import dispatch.
- [ ] Add a native scheduler only for genuinely runtime-dependent async work.

### Classes and objects

- [ ] Lower the required class/method/getter/setter/inheritance subset.
- [ ] Define object identity and ownership.
- [ ] Add optional GC only for cyclic or JavaScript-managed graphs that cannot
  use deterministic ownership.

## P1 — Assets and materials

### glTF

- [ ] Multiple UV sets and texture-coordinate selection beyond the
  reached TEXCOORD_1 occlusion slice (the loader reads TEXCOORD_1, the
  dedicated uv2 occlusion pair is ported, and the UV set occlusion samples
  from is chosen per material rather than per asset; base color, normal,
  emissive, and metallic-roughness texCoord selection remain
  unsupported).
- [x] Generalize texture transforms beyond one shared scale to per-slot
  offsets, rotations, and independent transforms. Each texture slot carries
  its own `KHR_texture_transform` and each sample computes its own UV, which
  is where the pin keeps it. Two cases stay uncovered because no corpus asset
  reaches them: `KHR_texture_transform.texCoord`, which selects a UV set per
  slot (swept: zero usages across all 46 corpus model URLs), and upstream's
  orm-unpack split, where occlusion samples the ORM image at a transform of
  its own rather than the metallic-roughness one.
- [ ] Vertex colors beyond the reached alpha/mask slice.
- [ ] Sparse accessors, and the point/line/line-strip primitive modes beyond
  the reached triangle-list and triangle-strip pair.
- [ ] Complete glTF animation coverage: scale and STEP channels, multiple
  clips, and richer animation-group controls.
- [ ] glTF cameras. Spot lights load and shade in the PBR extra-light slots
  under the pinned physical cone falloff; the primary slot encodes its kind
  in `lightDirection.w` and carries no cone, so a PBR scene whose FIRST light
  is a spot fails explicitly rather than shading it as a directional light.
  The Standard family shades spot cones under the pinned cosine-and-exponent
  falloff instead (Scene 15), so the exponent is unread only on the PBR path,
  where the attenuation is the physical inverse-square mode and a glTF spot
  carries exponent 1 anyway.
- [ ] KTX2/Basis and compression investigations. `EXT_texture_webp` is
  supported: the loader resolves the alternate image source the extension
  names, and the WebP decoder links only for scenes whose materialized assets
  carry `image/webp`, through the same reached-codec list that gates JPEG.

### Property animation

- [ ] Generalize property bindings beyond reached mesh `position`,
  `position.x`, `scaling`, and `rotationQuaternion` paths.
- [ ] Generalize animation targets beyond meshes while retaining typed
  compile-time path validation.
- [ ] Support multiple direct morph targets and reusable target data.
  The pinned corpus's five direct `createMorphTargets` calls each use one
  position target with nullable normals, so no corpus gate covers the broader
  API surface.

### Material extensions

- [x] Clearcoat, sheen, iridescence, and dispersion.
- [ ] Anisotropy. Specular is measured by Scene 244 for its two factors; its
  two textures stay unreached (see the corpus audit entry).
- [ ] Compose clearcoat/sheen layers with punctual multi-light PBR; the
  combination currently fails explicitly in the renderer lowerer.
- [ ] Require typed metadata specialization, focused tests, and an independent
  parity scene for each extension.
- [ ] Generalize Standard lighting beyond the per-scene unrolled slots. The
  uniform block, the write calls and the fragment now emit one slot per light
  the scene's `.babylon` assets declare (two when they declare fewer, which
  keeps every previously measured scene byte-identical), counted at
  generation because the loader only accepts point lights. The pinned
  template instead declares `array<LightEntry, MAX_LIGHTS>` and loops
  `min(mesh.lc, MAX_LIGHTS)`, so lights created in scene code, lights added
  after registration, and the per-mesh light list all still fall outside
  what is lowered. The per-mesh list is the pressing one and it is what
  `mesh.lc` counts: a `.babylon` light carries `includedOnlyMeshesIds` and
  `excludedMeshesIds`, Scene 9 uses both, and a scene-global slot list
  cannot express either — the uniform shape has to become per-mesh before
  that scene can be measured.
- [ ] Carry a spot light's cone angle into native at the pin's precision. The
  pinned factory computes `Math.cos(angle * 0.5)` in JS doubles and stores the
  result into a float UBO; the compiler passes scalars to intrinsics as
  `static_cast<float>(<double expression>)`, so the cosine is computed from an
  already-rounded angle. Scene 15's `Math.PI / 2` gives bit-identical results
  either way, but sweeping plausible cone angles at 1e-4 spacing, the two
  orders disagree by one ULP for 35% of them — and the cone test is a hard
  `>=` threshold, so one ULP flips whole boundary pixels rather than shading
  them slightly differently. Scenes 18, 22, and 203 pass 1.2, 1.5, and 0.8;
  measure one of them before deciding whether the intrinsic boundary needs a
  double-valued scalar path.
- [ ] Extend scene-code spot lights past the reached colour pair. The pinned
  light also exposes `angle`, `exponent`, and `range` as settable properties;
  no reached scene writes them, so their setters fail explicitly rather than
  being accepted and ignored. Scene 203 is the only corpus scene that writes
  `range` on a spot and it is blocked on engine options. Two compositions stay
  out as well, both for the same reason — the slot component the cone cosine
  takes is the one that says whether the slot holds a light: a spot in the
  FIRST PBR analytic slot, and a spot with Standard geometry outputs.
- [ ] Extend Standard vertex colors beyond the reached RGB slice: the pinned
  `std-vertex-color-fragment.ts` also consumes `vColor.a` under the
  `mesh.hasVertexAlpha` opt-in (output alpha, the vertex-alpha alpha test, and
  the transparent-phase source-over blend), and `standard-renderable.ts`
  composes the fragment for the geometry outputs as well. Scene 267 reaches
  neither; generation fails explicitly on the geometry-output combination, and
  Scene 231 needs the alpha half.

### Shader provenance

- [ ] Replace the pinned converted native PBR WGSL with direct extraction from
  Babylon Lite's full feature composer.

### Packed native assets

- [ ] Define a versioned native scene format with deterministic hashes.
- [ ] Prepack geometry, materials, textures, hierarchy, and animation data.
- [ ] Retain source loaders for development and parity.
- [ ] Measure startup, runtime, and size tradeoffs.

## P1 — Runtime and validation

- [ ] Match pinned per-sample image processing on the multisampled
  transmission target **on the SDL_GPU backend**: upstream's
  `image-processing-task.ts` applies exposure/tonemap/gamma per MSAA
  sample and then averages, while SDL_GPU cannot bind a multisampled
  texture for sampling, so its pass processes the resolved pixel once.
  The Dawn backend now runs the pinned per-sample pass verbatim (scene
  33 foreground 1.457 → 0.123), so this entry tracks only the SDL_GPU
  side of the keep-both-backends direction; it requires SDL_GPU
  multisampled-texture sampling (vendored patch) or an equivalent
  custom per-sample resolve. The gap is now measured rather than
  argued: running both backends single-sampled collapses scene 33's
  backend delta from 0.058/1.365 to 0.000/0.002, so this pass is the
  whole of it.
- [ ] Compose environment/camera sizing from object-local bounds through the
  pinned abs-matrix OBB-to-AABB world transform and add the
  `upperRadiusLimit` ground/skybox override (upstream `scene-size.ts`,
  `mesh-world-bounds.ts`, PR #532). Latent today: every gated scene's baked
  bounds coincide with the pinned result and no corpus scene sets
  `upperRadiusLimit`, so the port must keep all sized scenes bit-identical.
- [ ] Stop advancing scene before-render callbacks on null-swapchain
  iterations (the loop `continue`s without counting the frame, so the scene
  frame counter can drift ahead of the native frame counter and shift
  frame-indexed events such as Scene 273's runtime add). The bounded capture
  grace makes captures immune, but deterministic frame accounting is the
  real contract.
- [ ] Close Scene 7's last sub-pixel silhouette epsilon (~0.5% of
  foreground pixels beyond 5, concentrated on the tongue and eye
  contours). Instrumented bone-texture captures now compare bit for
  bit: after porting the pinned double-precision sampler evaluation
  (including the near-parallel store-then-normalize rounding), four
  of ChibiRex's six skin palettes are bit-identical under the
  documented mirror convention. The two remaining skins belong to
  the only skinned mesh nodes with their own transforms
  (`ChibiRex_Eyes`, `ChibiRex_Tongue`): the pinned mixer composes
  `invMeshWorld × jointWorld × IBM` and the mesh world cancels the
  inverse only up to float rounding, so matching it exactly means
  porting that inverse round-trip (including Babylon's matrix
  inversion algorithm) into the native palette composition.
- [ ] Add generation-checked handles and resource lifetime/leak checks.
- [ ] Add dirty flags and incremental GPU updates.
- [ ] Add device-loss and resize-safe resource recreation.
- [ ] Add multiple registered scenes and scene switching.
- [ ] Add headless renderer tests.
- [ ] Add differential tests for camera, environment, material, and transform
  functions.
- [ ] Close Scene 19's clearcoat rounding bias. The scene measures 0.096 full
  / 0.430 region on both backends, which agree with each other, and the region
  figure is the coat alone: every sphere pixel is within one channel step and
  native is always the brighter side, so roughly 43% of them round up. The
  environment underneath is not implicated — the same scene with
  `setPbrClearCoat` removed measures 0.000 with 99.98% of pixels exact, and an
  instrumented capture shows our harmonics, environment factors, and the whole
  `ccParams`/`ccRefractionParams` pair matching the browser's uploads bit for
  bit. Eliminated by reading the browser's own composed fragment beside ours:
  the layered-colour sum associates the same way, `ccSchlick` is character for
  character identical, the specular-AA and horizon-occlusion terms our
  fragment carries are gated off for this material, and the second analytic
  light slot is empty. What is left is a term-level difference inside the coat
  block; bisect it empirically against the deployed WGSL rather than by
  reading, and note Scene 28 measures the same coat at 0.001/0.016 over a
  glTF asset, so whatever it is only shows on a roughness-0 coat over a
  bright IBL-only sphere.
- [ ] Chase the last sub-0.02 foreground residuals on Scenes 243
  (0.005) and 247 (0.014) only if a structural cause surfaces; both
  former floors are closed by ported pinned contracts (the dedicated
  uv2 occlusion pair, the factor-texture bake at its exact precision
  boundaries, JS-double matrix composition, and the normal-map
  horizon-occlusion gate — see [backends](docs/backends.md) and
  [fidelity](docs/fidelity.md)). What remains is scattered one-LSB
  rounding on sparkle pixels with no directional bias; treat it as
  the same-browser raster floor unless an instrumented capture says
  otherwise.
- [ ] Find why Scenes 9 and 37 do not render bit-identically on Dawn across
  runs. Both are stable on SDL_GPU and both wobble on Dawn with no code change
  at all: three consecutive differential runs of Scene 37 put its
  SDL_GPU-versus-Dawn exact-match count at 920709, 920714, and 920773 of
  921600, and Scene 9 left its baseline cell and returned to it exactly. The
  published values are unaffected — every wobble is far below a rounded
  digit — but it makes the documented neutrality proof ("snapshot every
  `report-differential.json`, compare cell by cell") report these two scenes
  as moved for any change whatsoever, so the proof needs a repeat run to
  separate a real regression from this.
- [ ] Add malformed asset and backend-layout tests.
- [ ] Add a validation bundle command that preserves artifacts on failure.

## P1 — Developer experience

- [ ] Add portable CMake presets.
Sharing the PAL across scenes was investigated on 2026-08-14 and **declined**;
the measurements are kept because they are what a future proposal has to beat.

Every scene still compiles `pal.cpp`, `pal_sdl.cpp`, `pal_sdl_gpu.cpp` and
`pal_dawn.cpp` into its own build directory. Keyed on everything each
translation unit includes -- not on `render_capabilities.hpp`, which has 9
distinct signatures but is not the whole key, because the GPU PALs also include
the per-scene `renderer_plan.hpp` -- the 232 PAL compiles produce 83 distinct
object files: 58 for `pal.cpp` (it embeds the per-scene build stamp), 12 each
for the two GPU PALs, and **one** for `pal_sdl.cpp`.

Two ways to collect that were measured rather than argued:

- `sccache` gives **0%** across scenes. Its key is the preprocessed text, which
  embeds absolute paths: holding the vcpkg path equal, two scenes in the same
  group differ in 8 lines out of 182,905, all `#line` directives naming the
  per-scene include directory. Making it hit needs a shared generated include
  tree *and* a shared `VCPKG_INSTALLED_DIR` first -- two structural changes to
  enable a cache that then saves ~92% of a redundant compile where a shared
  library saves 100%.
- One static library per group avoids the compile entirely, but owns a grouping
  key, a build-ordering rule, and a staleness hazard the build stamp cannot
  catch: the stamp is computed from sources, so a scene linking a stale group
  library would still report a fresh stamp.

What made it not worth the complexity is that parallelism took the cost it was
filed against from 246.7s to 25.9s. Sharing would save perhaps 16s more of a
2m31 validation sequence.

Worth doing on its own merits, unrelated to sharing: the 58 build directories
carry 58 copies of `vcpkg_installed` at 48 MB each, about 2.8 GB. A shared
`VCPKG_INSTALLED_DIR` reclaims nearly all of it and shortens configure.
- [ ] Run `BBLITE_MSAA=1` on scene 116 under SDL_GPU: the single-sample
  frame graph fails there with `SDL_SubmitGPUCommandBufferAndAcquireFence:
  Failed to close command list`, which predates the Dawn work and is
  the only scene where the flag is refused by the backend that has
  always supported it. Dawn runs the same scene single-sampled (its
  frame-graph resolve step becomes a texture copy), so the two
  backends now disagree about the diagnostic itself.
- [ ] Improve missing-tool and stale-output diagnostics.
- [ ] Repair `scene -- geometry`, which has two halves and only the first is
  easy. Scenes 145/146/149 build their copy tasks in a loop, so the names
  never appear literally in the source: `` name: `scene145-impostor-${entry.name}` ``
  over an array of textures. Both halves of the tool scan for
  `name: "..."` and therefore find nothing.
  - **Discovery** is straightforward: the compiler unrolls the loop, so the
    generated tree already contains `scene145-impostor-albedo`,
    `-irradiance`, `-linearVelocity`, `-localPosition`, `-normViewDepth`,
    `-realColor` and the rest. Read them from `generated/<id>` instead of
    from the source.
  - **The browser-side transform is the real work.** It rewrites the scene
    source so one impostor renders full-screen, matching the same quoted
    name and replacing its `viewport: { ... }`. For loop-constructed tasks
    there is no per-task literal to rewrite — the viewport is computed from
    the loop index — so selecting one impostor means transforming the loop
    itself, or driving the reference capture some other way.
  Inert since that upstream change; diagnosed 2026-08-14 but not fixed.
- [ ] Add `--explain-feature` and generated-code-to-upstream inspection.
- [ ] Document adding a lowerer and curated scene fixture.

## P1 — Full Babylon Lite corpus audit

The audit uses the pinned
`95ed3029cc43e479ec924741aea4024e9bf33527` corpus. These entries cover every
scene that did not reach a MAD measurement; measured scenes are dashboarded in
[status](docs/status.md).

Refresh it by building `dist` once and then compiling each unregistered scene
directly, which skips the per-invocation rebuild:
`node dist/src/scene-command.js compile corpus/babylon-lite/lab/lite/src/lite/sceneNNN.ts`.
The command accepts an unregistered path, so nothing has to be added to the
registry to measure it.

**Current inventory:** 63 registered parity scenes and 170 unregistered
corpus scenes. The compiler-contract lane has no compile-clean scenes. Each
entry below records the first blocker only; clearing it can expose another.

**Compile clean (0):** every compile-clean corpus scene is registered. The
compiler-contract lane below is what gates the rest.

**Largest first-blocker clusters:** browser-dependent condition 17 (15 of them
deferred-lane physics), `parseNodeMaterialFromSnippet` 17, `loadSpriteAtlas`
16, engine options beyond msaaSamples/requiredLimits 7, static array literal 6,
numeric operators 6, `parseNodeParticleSource` 6, `receiveShadows` 5,
`loadSplat` 5. Missing intrinsics account for 44% of all failures across 28
distinct names. Several families are split across entries because the message
carries the identifier: Standard diffuse-texture assignment blocks 5 scenes
(18, 25, 90, 110, 272), vector `.set()` on node properties blocks 6 (4, 22, 65,
141, 142, 223), and mesh name/id setters block 4 (111, 113, 129, 221).

**No corpus scene can currently retire the runtime-sweep gate.** Scene 267 now
measures `createMeshFromData` from the corpus, but of the remaining scenes
reaching it (86, 114, 170-175, 231) and of every scene reaching
`setThinInstances` (16, 17, 43, 103, 165, 204, 219, 279) or `removeFromScene`
(129, 173, 271, 272), none compiles yet. `flushThinInstances` and
`setThinInstanceCount` are not referenced anywhere under `corpus/` at this pin,
so a project-owned gate is the only possible validation for those two
contracts.

Corpus scenes are the preferred validation: a feature is proven by the pinned
Babylon Lite scenes that reach it, not by a project-owned gate. Author a gate
only for a contract no corpus scene exercises (a feature combination the corpus
never composes, or a slice being built ahead of the scene that will use it),
and delete it once corpus scenes cover the contract.

The 172 unregistered scenes are partitioned by the boundary required to reproduce
their deterministic reference behavior, not by incidental browser helpers.
Capture-inert demo controls and fixed-coordinate picking stay in the first
lane when they can be erased or lowered inside the compiler, asset pipeline,
or renderer. A scene is deferred when its covered behavior needs a new
platform, user-input, or external-service contract.

**Integrate first (136 scenes):** 4, 11, 12, 16-18, 20-23, 25-27,
36, 38, 39, 43, 50-99, 110-115, 117, 118, 120-129, 140-144, 147-149, 152,
155-158, 160, 162, 165, 177, 179, 200-207, 211, 214, 215, 217-219, 223,
226, 229, 231, 241, 251, 261-264, 269-271, 275-280.

This lane includes static CSG/CSG2, compressed assets and splats,
deterministic picking in Scenes 113-115, 117, 118, and 129, and the
display-only gizmos in Scene 223.

**Defer (34 scenes):** 40-42, 44-49, 100-106, 153, 164, 170-175, 180, 181,
209, 221, 222, 224, 225, 227, 228, 272.

Their required boundaries are listed after the first-wave blocker inventory.

No audited scene currently requires audio, touch, gamepad, AR, or VR. Add any
future scene that does to the deferred lane by default.

Each scene below is listed under its first observed blocker; later compiler or
runtime gaps may remain hidden behind it.

### Integration-first compiler contract gaps

- [ ] Scenes 4, 22, 65, 141, 223: support light position setters.
- [ ] Scene 115: support `Number.isFinite`, which is now its first
  blocker, then re-audit for deterministic picking.
- [ ] Scenes 11, 144, 152, 157, 158, 179: generalize static array
  resolution. Module-level constant arrays now resolve through their own
  initializers (Scene 268 reads one in a loop bound and indexes a color
  table); these scenes reach array shapes that are not static literals.
- [ ] Scene 229: lower the reached spread element, which is its first
  blocker now that module-level constants resolve.
- [ ] Scenes 12, 43: fold or explicitly lower the reached browser-dependent conditions.
- [ ] Scenes 16, 226, 251: extend numeric expression operators.
- [ ] Scenes 18, 25: support Standard ground diffuse textures.
- [ ] Scene 20: lower the reached arrow-function value.
- [ ] Scene 21: support the reached non-identifier variable declarations.
- [ ] Scene 23: support `setPbrAnisotropy`.
- [ ] Scenes 26, 87: support image-processing `toneMapping`.
- [ ] Scene 27: support glTF `selectVariant`.
- [ ] Scene 36: support `loadBasisTexture2D`.
- [ ] Scene 38: support `createCylinder`.
- [ ] Scenes 39, 148: support reached scene-light list mutation.
- [ ] Scenes 50, 52-56, 58, 92-98, 117, 118: support `loadSpriteAtlas`.
- [ ] Scene 51: lower the reached browser-derived numeric value.
- [ ] Scenes 57, 59: support the `CAMERA_POSITION` shader binding.
- [ ] Scenes 60, 61, 64, 67-71, 77-80, 82, 84, 85, 88, 89: support
  node-material snippets.
- [ ] Scenes 62, 81, 83: resolve the module-level texture-URL
  constants they read. `loadTexture2D` itself landed; the blocker moved to
  `SCENE62_TEXTURE_URL` and its siblings.
- [ ] Scene 63: support reached scene-light insertion.
- [ ] Scenes 66, 72, 214, 215, 271: support `receiveShadows`.
- [ ] Scene 73: support camera viewports.
- [ ] Scenes 74, 76: support `createEffectWrapper`.
- [ ] Scene 75: support the `SCENE_CLEAR_COLOR` shader binding.
- [ ] Scene 86: support `setClipPlane`.
- [ ] Scene 91: support `initializeCsg2Async`.
- [ ] Scene 99: support `enableBoneControl`.
- [ ] Scenes 90, 110: support Standard material diffuse textures.
- [ ] Scene 111: support mesh IDs.
- [ ] Scene 112: resolve and lower `addDdsEnvironmentBackground`.
- [ ] Scenes 113, 129: support mesh names.
- [ ] Scene 114: resolve `createMeshFromData` through its local re-export.
- [ ] Scene 149: support the reached constructor expression.
- [ ] Scenes 120, 121, 124-126: support `loadSplat`.
- [ ] Scene 122: support `loadSOG`.
- [ ] Scene 123: support `loadSPZ`.
- [ ] Scenes 127, 128: support `createLinearDepthMaterial`.
- [ ] Scene 140: fold the reached browser-derived boolean.
- [ ] Scene 142: support quaternion setters.
- [ ] Scene 143: support `createBlurPostProcessTask`.
- [ ] Scene 147: support `createCircleOfConfusionPostProcessTask`.
- [ ] Scenes 155, 156: support property-animation blending.
- [ ] Scene 165: beyond the graduated scene-local shader variants
  (scenes 159/161 are measured gates now), it needs the
  viewProjection + world system-uniform pair, per-instance thin-instance
  colors (`setThinInstanceColors` + the instance color vertex stream),
  and an explicit image-neutral lowering decision for
  `enableThinInstanceGpuCulling`.
- [ ] Scenes 160, 162: extend reached shader-material options.
- [ ] Scene 177: support `setPbrIridescence` on a scene-code material.
- [ ] Scenes 17, 217: extend reached PBR material options.
- [ ] Scenes 200, 201: lower the high-precision-matrix helper promise chain.
- [ ] Scenes 202-207: extend reached engine options.
- [ ] Scene 218: support asset-container entity iteration.
- [ ] Scene 219: lower a value return that is not an inlined function's final
  statement.
- [ ] Scene 231: support `enableStandardSkeleton`, which is its first
  blocker now that Standard vertex colors are lowered; behind it sit
  `enableStandardUvOffset`, `createTexture2DFromPixels`, the skeleton
  subpath imports (`createSkeleton`, `updateSkeletonBoneMatrices`), its
  shared `scene231-skin` module, and `mesh.hasVertexAlpha`.
- [ ] Scene 241: fold the reached query-derived camera alpha.
- [ ] Scenes 262-264, 276, 277, 280: support node-particle sources.
- [ ] Scenes 269, 270: support transform nodes.
- [ ] Scene 261: support the reached mesh material assignment.
- [ ] Scene 275: support `loadFont`.
- [ ] Scene 278: support `createLineSystem`.
- [ ] Scene 279: support `createLineMaterial`.

### Integration-first generation and asset packaging gaps

- [ ] Scene 211: support non-string glTF buffer URIs or reject the source contract earlier.

### Integration-first native runtime and loader gaps

- [ ] Port the pinned two-pass `.babylon` parent wiring and geometry-less
  `TransformNode` containers (`load-babylon.ts` second pass); the native
  loader currently skips parented and geometry-less nodes silently. Zero
  effect on gated Scenes 24/145 (HillValley has neither); reached by ungated
  Scenes 9 and 143 (Sponza `.babylon`).
- [x] Scene 9: the Sponza `.babylon` scene. Its recorded blocker — optional
  fields written as JSON `null` rather than omitted — is closed; the loader
  reads every optional string through a null-tolerant helper now. Its texture
  slots turned out to be a shorter lift than the count suggests: Scene 24
  already drives 128 diffuse, 57 ambient, 32 reflection, 2 specular and 1
  opacity texture through the same loader, so of Sponza's six slots only
  **bumpTexture** (13 materials) is unreached. Run in order, each rung the
  scene's next actual blocker:
  1. ~~Three Standard lights~~ done: the uniform block, the write calls and
     the fragment now carry one slot per light a scene's `.babylon` assets
     declare, counted at generation. Sponza draws at region MAD 2.836 with
     67.8% of its pixels already exact.
  2. ~~Per-mesh light lists~~ done: a light resolves its
     `includedOnlyMeshesIds` and `excludedMeshesIds` against the records the
     loader creates, and the Standard slots hold the mesh's light set rather
     than the scene's. Region MAD 2.836 → 1.340, interior 2.089 → 0.585,
     78.1% of the frame exact.
  3. ~~Standard normal mapping~~ done: the pinned cotangent-frame fragment,
     bound as a seventh texture pair after every PBR pair. Region MAD
     1.340 → 0.335 with edges 5.208 → 0.939.
  Scene 9 is a measured gate at 0.330 on both backends, whose direct
  agreement is one channel step. What remains is scattered over the frame
  rather than concentrated anywhere: 91.5% of pixels exact, 96.6% within one
  step, interior 0.217 against edges 0.939.
  Its parented and geometry-less nodes are NOT on this path: all 16 parented
  meshes and all 29 geometry-less ones are bones and camera targets carrying
  no geometry, and native already draws all 32 of the scene's visible meshes.
  The two-pass `.babylon` wiring below stays a latent gap rather than a
  Sponza rung.
  Then register it and measure. Nothing before rung 3 can be gated on this
  scene, so each rung lands proved byte-neutral for the scenes already
  measured rather than by a number of its own.
- [ ] Close Scene 253's iridescence sphere. The scene is a measured gate but
  its region figure carries a defect rather than a floor. The material is the
  only one in the corpus whose `metallicFactor` is animated — which the pin
  routes to ROUGHNESS — and correcting the factor bake below took the scene
  from 0.251/3.841 to 0.128/1.936 on SDL_GPU and 0.086/1.328 on Dawn. What
  remains is a structured interior difference on that sphere alone, with
  iridescence at factor 1 and its index of refraction and maximum thickness
  also animated. Both backends agree with each other to one channel step,
  which places the cause CPU-side.
  Eliminated by measurement, so do not retry: every material uniform (read
  back with `scene -- uniforms scene253 --size 48 --module 21`), the
  refraction parameters, the horizon-occlusion term the reference itself
  emits as 1.0, occlusion strength, the unlit path, environment rotation at 0,
  the image-processing pass, and the animation clock. Note the spheres are
  laid out Volume, Transmission, Iridescence, IOR by node translation — NOT
  in label order, which cost real time.
- [ ] Extend `KHR_materials_specular` past its two factors. Scene 244
  measures `specularFactor` and `specularColorFactor`; `specularTexture` and
  `specularColorTexture` fail explicitly at load rather than being folded
  away. Scene 241 is the only corpus asset that carries them, and it is
  compiler-blocked, so the pinned `metallicReflectanceTexture` /
  `reflectanceTexture` pair — including the `pow(2.2)` the reflectance
  fragment applies to each — stays unreached. The same fragment's
  `occlusionStrength` mix is already the base template's own.
- [ ] Carry primitive topology to the pipeline for the modes a triangle list
  cannot express: points, lines, and line strips. Scene 260 measured the
  triangle strip by expanding it to its triangle list in the loader, which
  works only because both describe the same triangles; a line list
  rasterizes differently and has no such rewrite. The pin keeps the
  authored topology instead — `load-gltf.ts` records a `_topology` index
  (1=points, 2=lines, 3=line-strip, 4=triangle-strip; LINE_LOOP and
  TRIANGLE_FAN unsupported, as in BJS) and `gltf-feature-primitive.ts`
  builds the `GPUPrimitiveState` — so the native shape is a topology suffix
  on the generated `RenderPipelineKind`, which already encodes cull mode and
  winding, plus a field on each PAL's `PipelineKindTraits` and WebGPU's
  `stripIndexFormat`. Topology also arrives without an asset: `createLineSystem`
  sets `mesh._topology = 2` on geometry built from plain arrays and
  `createLineMaterial` sets `_topology: "line-list"` on the material, so this
  is the same axis Scenes 278 and 279 need behind their own intrinsics. The
  generated loader rejects those modes by number today, behind the
  `nonTrianglePrimitives` specialization flag that already mirrors upstream's
  own dynamic-import predicate.

### Deferred external and platform-feature scenes

These stay out of the first integration wave even when the audit currently
reports an earlier compiler error.

#### Physics and navigation

- [ ] Scenes 40-42, 44-49, 100-106, 209: add Havok behind an independent
  physics dependency/PAL boundary. Current first blockers include browser
  conditions, Havok initialization, four-argument calls, and engine options.
- [ ] Scenes 170-175: add Recast navigation behind an explicit dependency
  boundary. Current first blockers include numeric operators and
  `createNavigationPluginAsync`.

#### Browser-hosted UI and advanced input

- [ ] Scene 153: add a runtime 2D-canvas boundary; its final frame is drawn
  directly through `CanvasRenderingContext2D`, not Babylon Lite rendering.
  The current first blocker is the reached one-argument call.
- [ ] Scenes 180, 181: add live HTML text input, sliders, pointer drag, and
  wheel handling for the text demos. The current first blocker is reached
  `void` expression statements.
- [ ] Scenes 221, 222, 224: add pointer-driven gizmo picking and drag routing.
  Current first blockers are mesh names, four-argument calls, and a
  browser-dependent condition.
- [ ] Scene 225: add geospatial camera controls as an advanced-input contract;
  the scene intentionally reaches `attachGeospatialControls` even though the
  reference frame uses a static pose. The current first blocker is
  `createGeospatialCamera`.

#### GPU and surface lifecycle

- [ ] Scene 164: add device-loss recovery and direct GPU-device lifecycle
  access.
- [ ] Scenes 227, 228: add multiple native surfaces/swapchains for
  `createSurface`.
- [ ] Scene 272: add the direct GPU validation-error event contract reached
  through `engine._device` and `GPUUncapturedErrorEvent`; its current first
  blocker is Standard material diffuse textures.

## P1 — Backend portability

### Vulkan

First device run recorded (2026-08-12, Windows NVIDIA through SDL_GPU's
Vulkan driver — enable the vcpkg `sdl3` port's `vulkan` feature to
rebuild the driver in): geometry, camera, vertex uniforms, clip space,
and the Standard material family are already correct (scene 2 is
byte-identical to the golden), while the PBR family mis-shades
(scene 1 darkens roughly one gamma-decode; scene 10 renders
near-black), so the remaining work is shader-interface-level, not
architectural. The generated SPIR-V lands in SDL's expected descriptor
sets but declares each texture/sampler as separate descriptors sharing
one binding, while SDL's Vulkan backend builds combined-image-sampler
descriptors — out of spec even where the driver tolerates it, and the
pinned Tint CLI exposes no combined-sampler emission, so the fix runs
through the Tint SPIR-V writer options or an upstream Tint bump.
Deliberately parked to keep the validation surface small at this
stage.

- [ ] Emit SDL-compatible SPIR-V (combined image samplers at SDL's
  set/binding contract) directly from Tint instead of recompiling
  normalized Tint HLSL with DXC.
- [ ] Localize and fix the PBR-family Vulkan shading divergence
  (Standard is exact; suspects are the separate-sampler aliasing and
  the PBR fragment's cbuffer/array layout).
- [ ] Build and run generated SPIR-V on Linux.
- [ ] Validate depth, clip space, cubemap orientation, and texture color spaces.
- [ ] Validate BRDF LUT and cubemap orientation on Vulkan hardware.
- [ ] Test discrete and integrated adapters.

### Metal

- [ ] Build and run generated MSL on macOS.
- [ ] Validate uniform layout, derivatives, cubemaps, and blending.
- [ ] Validate BRDF LUT and cubemap orientation on Metal hardware.
- [ ] Investigate iOS after macOS is stable.

## P2 — Platform and performance

- [ ] Add touch, gamepad, and fuller keyboard mapping.
- [ ] Inventory and lower static audio playback behind an SDL audio PAL.
- [ ] Add runtime HTTP/files only when compile-time materialization is
  insufficient.
- [ ] Keep physics behind an independent PAL/dependency boundary.
- [ ] Separate CPU submission, GPU execution, decode, and startup timing.
- [ ] Track executable, shader, and asset sizes consistently.
- [ ] Deduplicate resources and batch uploads before investigating meshlets,
  indirect draws, or GPU-driven culling.

## Documentation maintenance

- [ ] Keep status metrics and the README comparison image synchronized with
  validated results.
- [ ] Update development and repository instructions when build workflows or
  recurring pitfalls change.
- [ ] Keep this file free of completed-history checklists.
