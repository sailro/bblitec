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
  reached TEXCOORD_1 occlusion slice (the loader reads TEXCOORD_1 and
  the dedicated uv2 occlusion pair is ported; base color, normal,
  emissive, and metallic-roughness texCoord selection remain
  unsupported).
- [ ] Generalize texture transforms beyond one shared scale to per-slot
  offsets, rotations, and independent transforms.
- [ ] Vertex colors beyond the reached alpha/mask slice.
- [ ] Sparse accessors, and the point/line/line-strip primitive modes beyond
  the reached triangle-list and triangle-strip pair.
- [ ] Complete glTF animation coverage: scale and STEP channels, multiple
  clips, and richer animation-group controls.
- [ ] glTF cameras and spot lights.
- [ ] KTX2/Basis and compression investigations.

### Property animation

- [ ] Generalize property bindings beyond reached mesh `position`,
  `position.x`, `scaling`, and `rotationQuaternion` paths.
- [ ] Generalize animation targets beyond meshes while retaining typed
  compile-time path validation.

### Material extensions

- [x] Clearcoat, sheen, iridescence, and dispersion.
- [ ] Specular and anisotropy.
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
  what is lowered.
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

**Swept 2026-08-13:** 184 unregistered scenes compiled, 8 clean and 176
blocked across 80 distinct first blockers. Scenes 267, 268, 256, 30, 260 and
34 have since graduated to measured gates, leaving 178 unregistered, re-swept
unchanged on 2026-08-14 (the same clean set, same clusters). The lane partition
below was written from reading and holds up: no scene in the compiler-contract
lane compiles, so the compiler has not silently outgrown its inventory. Each
scene's entry is its FIRST blocker; clearing one may expose another.

**Compile clean (4):** 9, 242, 244, 253. All four are past the compiler
and blocked downstream in the loader/runtime lane. Four of the original eight
graduated on 2026-08-14: scene 256, the only one with no downstream blocker at
all; scene 30 once generation-time Draco decoding, texture-transform offsets
and the undeclared-tangent decision landed; and scene 260 once the loader read
the glTF primitive mode; and scene 34 with the two glTF visibility extensions.

Each of the original eight was **run**, not just read, and three carried
misleading labels — scene 30 was Draco rather than "an accessor without a
`bufferView`", and 34/242/244/253 are four distinct `KHR_animation_pointer`
contracts rather than one animation-channel gap. Run a candidate before scoping
it; the first blocker a scene reports is the first line of its chain, not its
size.

**Largest first-blocker clusters:** `loadSpriteAtlas` 16, browser-dependent
condition 17 (15 of them deferred-lane physics), `parseNodeMaterialFromSnippet`
12, `createSpotLight` 8, engine options beyond msaaSamples/requiredLimits 7,
static array literal 6, `parseNodeParticleSource` 6, numeric operators 6,
`loadSplat` 5. Missing intrinsics account for 45% of all failures across 30
distinct names. Several families are split across entries because the message
carries the identifier: Standard diffuse-texture assignment blocks 5 scenes
(18, 25, 90, 110, 272), mesh name/id setters block 4 (111, 113, 129, 221), and
vector `.set()` on node properties blocks 5 (4, 22, 65, 141, 142).

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

The 180 unmeasured scenes are partitioned by the boundary required to reproduce
their deterministic reference behavior, not by incidental browser helpers.
Capture-inert demo controls and fixed-coordinate picking stay in the first
lane when they can be erased or lowered inside the compiler, asset pipeline,
or renderer. A scene is deferred when its covered behavior needs a new
platform, user-input, or external-service contract.

Scenes 256 and 280 arrived with the 1.20.0 pin: 256 is a measured gate as of
2026-08-14, and 280 blocks on `parseNodeParticleSource` as expected.

**Integrate first (145 scenes):** 4, 9, 11, 12, 15-23, 25-27,
36-39, 43, 50-99, 110-115, 117, 118, 120-129, 140-144, 147-149, 152,
155-162, 165, 177, 179, 200-207, 211, 214, 215, 217-219, 223, 226, 229,
231, 241, 242, 244, 251-253, 261-264, 269-271, 275-279. Scenes 3, 7,
35, and 216 graduated to measured parity gates on 2026-08-12, and Scenes
267, 268, 256, 30, 260 and 34 on 2026-08-14.

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

- [ ] Scenes 4, 22, 65, 141: support light position setters.
- [ ] Scene 115: support `Number.isFinite`, which is now its first
  blocker, then re-audit for deterministic picking.
- [ ] Scenes 11, 144, 152, 157, 158, 179: generalize static array
  resolution. Module-level constant arrays now resolve through their own
  initializers (Scene 268 reads one in a loop bound and indexes a color
  table); these scenes reach array shapes that are not static literals.
- [ ] Scene 229: lower the reached spread element, which is its first
  blocker now that module-level constants resolve.
- [ ] Scenes 12, 43: fold or explicitly lower the reached browser-dependent conditions.
- [ ] Scenes 15, 67-72, 223: support `createSpotLight`.
- [ ] Scenes 16, 226, 251, 261: extend numeric expression operators.
- [ ] Scene 17: support `Math.atan`.
- [ ] Scenes 18, 25: support Standard ground diffuse textures.
- [ ] Scene 19: support `loadDdsEnvironment`.
- [ ] Scene 20: lower the reached arrow-function value.
- [ ] Scene 21: support the reached non-identifier variable declarations.
- [ ] Scene 23: support `Math.cos` with runtime numeric arguments.
- [ ] Scenes 26, 87: support image-processing `toneMapping`.
- [ ] Scene 27: support glTF `selectVariant`.
- [ ] Scene 36: support `loadBasisTexture2D`.
- [ ] Scene 38: support `createCylinder`.
- [ ] Scenes 39, 148: support reached scene-light list mutation.
- [ ] Scenes 50, 52-56, 58, 92-98, 117, 118: support `loadSpriteAtlas`.
- [ ] Scene 51: lower the reached browser-derived numeric value.
- [ ] Scenes 57, 59: support the `CAMERA_POSITION` shader binding.
- [ ] Scenes 60, 61, 64, 77-80, 82, 84, 85, 88, 89: support node-material snippets.
- [ ] Scenes 62, 81, 83: resolve the module-level texture-URL
  constants they read. `loadTexture2D` itself landed; the blocker moved to
  `SCENE62_TEXTURE_URL` and its siblings.
- [ ] Scene 63: support reached scene-light insertion.
- [ ] Scenes 66, 214, 215, 271: support `receiveShadows`.
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
- [ ] Scenes 114, 149: support the reached constructor expressions.
- [ ] Scenes 120, 121, 124-126: support `loadSplat`.
- [ ] Scene 122: support `loadSOG`.
- [ ] Scene 123: support `loadSPZ`.
- [ ] Scenes 127, 128: support `createLinearDepthMaterial`.
- [ ] Scene 140: support numeric conditional expressions in this context.
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
- [ ] Scenes 177, 217: extend reached PBR material options.
- [ ] Scenes 200, 201: lower the high-precision-matrix helper promise chain.
- [ ] Scenes 202-207: extend reached engine options.
- [ ] Scenes 218, 219: support asset-container entity iteration.
- [ ] Scene 231: support `enableStandardSkeleton`, which is its first
  blocker now that Standard vertex colors are lowered; behind it sit
  `enableStandardUvOffset`, `createTexture2DFromPixels`, the skeleton
  subpath imports (`createSkeleton`, `updateSkeletonBoneMatrices`), its
  shared `scene231-skin` module, and `mesh.hasVertexAlpha`.
- [ ] Scene 241: fold the reached query-derived camera alpha.
- [ ] Scene 252: generalize the reached structured argument.
- [ ] Scenes 262-264, 276, 277: support node-particle sources.
- [ ] Scene 269: support transform nodes.
- [ ] Scene 270: support the reached mesh scaling setter.
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
- [ ] Scene 9: the Sponza `.babylon` scene. Its recorded blocker — optional
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
  2. Parented and geometry-less nodes: 16 of its 98 meshes carry a
     `parentId` and 29 have no geometry, and the loader silently skips both
     (the two-pass `.babylon` wiring entry below).
  3. Standard normal mapping for the 13 `bumpTexture` materials.
  4. Localize the residual, which concentrates on the surfaces the three
     point lights reach: two thirds of the frame is already byte-exact, so
     the base pass and its textures agree and something in the point-light
     terms does not. Attenuation and `range` are the first suspects.
  Then register it and measure. Nothing before rung 3 can be gated on this
  scene, so each rung lands proved byte-neutral for the scenes already
  measured rather than by a number of its own.
- [ ] Scenes 242, 244, 253: extend `KHR_animation_pointer` beyond the node
  visibility target Scene 34 measures. The channel `path` is `pointer` and
  the target is a JSON pointer into the document rather than a node TRS
  field; the pinned base module resolves node-visibility and node-TRS
  pointers itself and pulls `animation-pointer-basecolor`,
  `animation-pointer-ext` and `animation-pointer-lights` for the rest, which
  is the same split these three scenes need. Counted by pointer shape rather
  than by channel, smallest first:
  - Scene 242, nine channels of three shapes — material `emissiveFactor`, `baseColorFactor`
    and `KHR_materials_emissive_strength/emissiveStrength`: animated material
    uniforms.
  - Scene 244, two channels of two shapes — `KHR_texture_transform/rotation`
    on a normal texture and on a volume thickness texture, so it needs
    animated UV transforms plus clearcoat/specular/transmission/volume.
  - Scene 253, sixty-nine channels across **thirty-four** distinct shapes:
    camera perspective and orthographic planes, `KHR_lights_punctual` color,
    intensity, range and cone angles, node TRS and weights, and about ten
    material extensions. Last, not first.
  All three seek to a fixed frame and pause for capture, so a gate needs the
  value each pointer resolves to at that frame rather than a live animation
  system.
- [ ] Scene 37: it now fails during generation on `PBR material-extension
  marker changed: occlusion uv2 inner signature`, before the loader gap it
  was recorded under. That reads as marker drift rather than a missing
  feature, and it is the one scene whose position moved backwards.
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
