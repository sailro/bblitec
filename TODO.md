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

Both backends are complete and stay long-term as mutually validating
implementations; [backends](docs/backends.md) carries the rationale, the
comparison, and the empirical guards. What is left:

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

- [ ] Add namespace/default imports and non-static module initialization.
- [ ] Build a typed user-code IR from `ts.Program`/`TypeChecker` symbols.
- [ ] Move statement, expression, and intrinsic lowering into focused
  compiler modules instead of extending the entry compiler monolith.
  Property lowering has moved out: the declared reads live in
  `compiler/properties.ts` and the declared writes in
  `compiler/assignments.ts`, each a table the entry compiler consults
  rather than a chain it extends.
- [ ] Extend shader IR to composed PBR/Grid/background fragments, then replace
  the remaining renderer-lowerer source-text contracts with parsed shader IR.
  The surface is 16 marker rewrites over the converted fragment text, 8 of
  them regexes matching a `textureSample` call to redirect it at a
  transform-built UV. That shape is why Scene 39's emissive bug survived: the
  table said which slots to redirect, nothing checked the pinned fragment
  agreed, and the emissive one did not. Convert in that order — parse the
  fragment and re-emit it byte-identically across every generated tree FIRST,
  since that is the gate on whether the IR can carry it at all, then replace
  the per-slot UV redirects with typed rewrites. The structural splices
  (material extensions, fog) insert whole statement blocks and are a later
  step than the call rewrites.
- [ ] Lower string-literal switch discriminants, which belong to the
  input-layer erasure lane (numeric `switch`, `break`, `continue`, and
  runtime iterables over data containers are lowered).
- [ ] Add discriminated unions and numeric-literal narrowing beyond the
  checker's null analysis (string-literal-union enum tags and null narrowing
  are lowered).
- [ ] Generalize the contracts Scene 50 folded at compile time. `??` is
  lowered over a static record property, whose presence in the literal
  decides the value, and a record property carrying a function literal is
  inlined at the call site; neither has a runtime form, so a nullish operand
  that is not a static record property, or a callback that escapes its call
  site, fails explicitly. `canvas.width`/`canvas.height` name the engine's
  configured size, which is the size the surface was created at; a scene
  reading them after a resize would need the live render-target size the
  pinned `getRenderTargetSize` reads instead.
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
- [ ] Cover the two texture-transform cases no corpus asset reaches:
  `KHR_texture_transform.texCoord`, which selects a UV set per slot (swept:
  zero usages across all 46 corpus model URLs), and upstream's orm-unpack
  split, where occlusion samples the ORM image at a transform of its own
  rather than the metallic-roughness one.
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
  Babylon Lite's full feature composer. **This is the entry every hand-written
  shader arm is a symptom of, and it is not a text swap — it is a variant-model
  change.**

  The mechanism is available and proved: `src/shader/shader-composer.ts` is a
  pure function over a `ShaderTemplate` and a `ShaderFragment[]` with no device
  and no browser globals, the pinned package ships it as an ES module, and
  `src/pinned-shader-composer.ts` executes it under test. `createPbrComposer`
  in `material/pbr/pbr-compose.ts` is the pin's own material-to-shader entry
  point, taking `(features, features2, meshFeatures, sceneFeatures, lightMode,
  singleLightType, ...)` over the `pbr-flag-bits.ts` bits.

  **Two of the three pieces are done.**

  *The formulas come from the pin.* The clearcoat, sheen and iridescence
  helpers are no longer transcribed: `pinnedShaderHelpers()` composes real
  variants and lifts the declarations out verbatim, so the emitted fragment
  calls `visibility_Kelemen`, `iri_eval` and
  `normalDistributionFunction_CharlieSheen` under the pin's own names and a
  renamed or removed helper is a build failure. There is deliberately no
  transcribed fallback.

  *The composer is driven correctly.* `pinnedMaterialInputFromGltf` maps a
  glTF material to the shape `_computePbrMaterialFeatures` reads, and 30 of
  the 31 materials across the six instrumented-capture scenes now compose
  **byte-identically** to the fragment the browser recorded — scenes 37, 39,
  244 and 253 at 100%. The one exception is Scene 21's cloth, whose sheen
  comes from `setPbrSheen` in scene code, not from its asset.

  *What remains is the variant model itself* — the third piece, below.

  Meanwhile `src/pinned-material-arms.ts` turns the failure mode into a build
  error: generation composes every glTF material and refuses to emit a
  fragment missing an arm one of them reaches, naming the material. That does
  not make the fragment per-material, but it stops a missed arm from shipping
  silently while it is not.

  What makes it structural is the shape on each side. Babylon composes **one
  fragment per material feature set**: the instrumented capture of Scene 253
  holds 17 distinct fragment bodies for that scene's 14 materials. The
  generated renderer composes **one fragment per scene** and selects behaviour
  inside it from `materialOptions`/`normalOptions` uniform lanes. A single
  fragment cannot express a per-material fork, so every fork upstream makes —
  `useF0Remap`, `hasAlbedoScaling`, `hasSpecularAA`, `hasBaseNormalMap`, the
  `hasIbl`/`hasNormalMap` arms inside each ext — has to be re-expressed here as
  a uniform branch somebody writes by hand. That is why formulas keep getting
  re-derived, and why a missed arm reads as a small systematic shading bias
  rather than as a failure.

  So the remaining work is: adopt per-material shader variants, then let the
  composer produce each one. `pal_dawn.cpp` and `pal_sdl_gpu.cpp` hold a
  single `geometry.pbr_fragment` per scene, so this needs a fragment per
  variant, a variant recorded per renderable, and — the part with real cost —
  the pin's **per-variant material UBO** in place of the monolithic
  `PbrUniforms`, since each variant declares only the fields its own
  extensions contribute, in registration order. `composePinnedPbrVariant`
  already returns that layout as `materialUboSpec`.

  Two inputs the composer needs that the asset cannot supply, both found by
  measurement rather than reasoning:

  - **The light mode is a scene property, not an asset one.** Scene 39's glTF
    declares two `KHR_lights_punctual` lights and *none* of its captured
    fragments composes a light path at all; it only matches at `lightMode 0`.
    Deriving it from the asset is wrong.
  - **Scene-code materials are a second input.** Scene 21's cloth material
    declares no glTF extensions whatsoever and its captured fragment carries
    `sheenParams`, because the scene calls `setPbrSheen`. Reaching it needs
    the scene's own lowered material calls — `compileSheenOptions` in
    `src/compiler/intrinsics/material.ts` already resolves those values at
    compile time, so the input exists; it is not yet carried to the composer.

  Two contracts found while probing, both worth keeping: the environment bit is
  read from `sceneFeatures`, not `features` (`_hasIbl = hasScene(PBR_HAS_ENV)`),
  and the ext fragments reach the composer through the registry `_getPbrExts()`
  that the `setPbr*` entry points populate, not from the feature bits — so
  driving the composer faithfully means reproducing that registration, which is
  the same "an enable\* entry point installs a factory" shape Scene 267 already
  documented.

  A third, learned the expensive way: **the loader is the specification, not
  the glTF format.** Every rule re-derived from what the format "means" was
  wrong, and each one composed a plausible variant missing an arm. A declared
  extension is enabled even with no factor (`isEnabled: true` unconditionally);
  a `KHR_texture_transform: {}` patches nothing so composes no transform; a
  `baseColorFactor` with no image behind it is baked into the texel and
  declares no UBO field; `ior !== 1.5` alone turns the reflectance layer on;
  and an animated pointer can change a material's *shape* — an animated
  occlusion strength registers the reflectance extension, which then takes
  occlusion over entirely.

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
  `mesh-world-bounds.ts`, PR #532). No corpus scene sets `upperRadiusLimit`.
  The sizing itself now has one moved-camera measurement behind it: an
  instrumented capture of Scene 14 at `cam.beta = 0.55` decodes the browser's
  own ground vertex buffer at half-extent `52.8457298` and its mesh UBO at
  root `(1.10339117, -0.00531012891, 0.772171557)`, and the native builder
  prints the same half-extent and a root agreeing to float precision, so the
  baked-bounds shortcut and the pinned OBB-to-AABB transform coincide there as
  well as at the reference pose. The port must keep all sized scenes
  bit-identical at their gated poses.
- [ ] Stop advancing scene before-render callbacks on null-swapchain
  iterations (the loop `continue`s without counting the frame, so the scene
  frame counter can drift ahead of the native frame counter and shift
  frame-indexed events such as Scene 273's runtime add). The bounded capture
  grace makes captures immune, but deterministic frame accounting is the
  real contract. It is an SDL_GPU-only path — `pal_dawn.cpp` treats a surface
  it cannot acquire as an error and so never skips an advanced frame — and
  the fix is a loop reorder rather than a guard: SDL only reports the null
  texture *from* `SDL_WaitAndAcquireGPUSwapchainTexture`, and it documents
  minimization as one example rather than the condition, so the availability
  cannot be tested before the acquisition. The clock advance, the
  before-render callbacks, the per-mesh uploads and the topology update all
  have to move below the acquisition together, since the uploads read the
  state the callbacks write and splitting them would render a frame late.
  What makes that more than a mechanical move is the benchmark bracket:
  `start` sits immediately before the acquisition on both backends and
  [backends](docs/backends.md) publishes the pair as "frame CPU time from
  surface acquire through submit and present", so reordering SDL_GPU alone
  puts the callbacks and uploads inside its bracket and not Dawn's. Land the
  reorder together with a re-measurement of both backends, or move Dawn's
  acquisition to the same place so the two loops stay comparable.
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
- [ ] Share one `VCPKG_INSTALLED_DIR` across build trees. Each build directory
  carries its own 48 MB copy of `vcpkg_installed`, about 2.8 GB across the
  matrix; sharing reclaims nearly all of it and shortens configure.
- [ ] Run `BBLITE_MSAA=1` on scene 116 under SDL_GPU: the single-sample
  frame graph fails there with `SDL_SubmitGPUCommandBufferAndAcquireFence:
  Failed to close command list`, which predates the Dawn work and is
  the only scene where the flag is refused by the backend that has
  always supported it. Dawn runs the same scene single-sampled (its
  frame-graph resolve step becomes a texture copy), so the two
  backends now disagree about the diagnostic itself.
- [ ] Improve missing-tool and stale-output diagnostics.
- [ ] Add `--explain-feature` and generated-code-to-upstream inspection.
- [ ] Document adding a lowerer and curated scene fixture.

## P1 — Full Babylon Lite corpus audit

The audit uses the pinned corpus. These entries cover every scene that did not
reach a MAD measurement; measured scenes are dashboarded in
[status](docs/status.md).

**The corpus carries only the shared modules registered scenes import.**
`lab/lite/src/shared/` and `lab/lite/src/_shared/` hold three files here
(scene252-stdmorph.ts, sprite-atlas-image.ts, sprite-grid.ts), each pinned in
`upstream/babylon-lite-scenes.json` like any scene source, because those are
the ones a registered scene reaches. The node-material cluster still imports
modules that are absent: every such scene reads `../shared/sceneNN-nme.js`.
The compiler reports the missing intrinsic first, so the gap only surfaces
once that intrinsic lands. Integrating from that cluster starts by copying
those modules out of the pinned upstream tree and pinning their SHA-256
beside the scenes, the way the sprite cluster's two already are.

Refresh it by building `dist` once and then compiling each unregistered scene
directly, which skips the per-invocation rebuild:
`node dist/src/scene-command.js compile corpus/babylon-lite/lab/lite/src/lite/sceneNNN.ts`.
The command accepts an unregistered path, so nothing has to be added to the
registry to measure it.

**Current inventory:** 167 corpus scenes remain unregistered; the registered
ones are dashboarded in [status](docs/status.md). The compiler-contract lane
has no compile-clean scenes. Each entry below records the first blocker only;
clearing it can expose another.

**Compile clean (0):** every compile-clean corpus scene is registered. The
compiler-contract lane below is what gates the rest.

**Largest first-blocker clusters**, re-measured across all of them after the
sprite work landed: browser-dependent condition 17 (15 of them
deferred-lane physics), `parseNodeMaterialFromSnippet` 17, engine options
beyond msaaSamples/requiredLimits 7, `parseNodeParticleSource` 6, static array
literal 5, `receiveShadows` 5, `loadSplat` 5, `??` over an operand that is not
a static record property 5, `light.position.set` 4,
`createFacingBillboardSystem` 4, string-literal arguments 3,
`createNavigationPluginAsync` 3. Several families are split across entries
because the message carries the identifier: Standard diffuse-texture assignment
blocks 5 scenes (18, 25, 90, 110, 272), vector `.set()` on node properties
blocks 6 (4, 22, 65, 141, 142, 223), and mesh name/id setters block 4 (111,
113, 129, 221).

`loadSpriteAtlas` has left the table: every one of the 15 scenes behind it now
reports its own next blocker, and they scatter across nine different ones (the
billboard factories, the other blend descriptors, the custom-shader entry
points, `onSceneDispose`, module-level constants). That is the usual shape —
one intrinsic was hiding a cluster, not a queue.

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

The unregistered scenes are partitioned by the boundary required to reproduce
their deterministic reference behavior, not by incidental browser helpers.
Capture-inert demo controls and fixed-coordinate picking stay in the first
lane when they can be erased or lowered inside the compiler, asset pipeline,
or renderer. A scene is deferred when its covered behavior needs a new
platform, user-input, or external-service contract.

**Integrate first (133 scenes):** 4, 11, 12, 16-18, 20, 22, 23, 25-27,
36, 38, 43, 51-99, 110-115, 117, 118, 120-129, 140-144, 147-149, 152,
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
- [ ] Scenes 171, 174, 175, 226, 251: lower `??` over an operand that is not a
  static record property. Scene 50 landed the fold that settles a record
  literal's own optional properties at compile time; these read a container
  instead — 226 `container._gaussianSplats ?? []`, 251 `xbot.animationGroups ??
  []` — and now fail naming that limit rather than the numeric-operator
  message an earlier sweep recorded. Splats, animation groups and the Recast
  navigation lane sit behind them. Scene 16 has moved off this entry: its
  first blocker is an unsupported numeric operator of its own.
- [ ] Scenes 18, 25: support Standard ground diffuse textures.
- [ ] Scene 20: lower the reached arrow-function value. Scene 50 landed the
  narrow case — a function literal written as an object-literal property,
  inlined at the call site — and this is the general one: an arrow bound to a
  name and used as a value.
- [ ] Scene 21: support the reached non-identifier variable declarations.
- [ ] Scene 23: support `setPbrAnisotropy`.
- [ ] Scenes 26, 87: support image-processing `toneMapping`.
- [ ] Scene 27: support glTF `selectVariant`.
- [ ] Scene 36: support `loadBasisTexture2D`.
- [ ] Scene 38: support `createCylinder`.
- [ ] Scene 148: support `createDepthOfFieldPostProcessTask`, which is its
  first blocker now that the scene light-list clear is lowered.
- [ ] Extend the sprite path past the slice Scene 50 measures. The pure-2D
  straight-alpha layer is ported (atlas, grid frames, the Index API's
  instance writer, the pinned WGSL and layer UBO); each item below is a
  separate arm upstream keeps behind its own module or hook, and each fails
  explicitly today rather than being approximated:
  - the other blend descriptors — `spriteBlendPremultiplied` (Scene 51, with
    `premultiplyOnLoad`), `spriteBlendMultiply` (97), `spriteBlendOpaque`
    (53). The native record already carries the pin's factor pairs, so this
    is compiler-side plus one pipeline per distinct blend in a renderer.
  - depth-hosted layers: `addDepthHostedSpriteLayer` with `depth: "test"` /
    `"test-write"` (53), which adds the 14th instance float, the depth
    attachment and the scene bind group, and composes with a `SceneContext`.
  - a `SpriteRenderer` overlaid on a scene (52), which is that composition
    without the depth slot: the sprite pass appends to the scene's frame.
  - `createSprite2DCustomShader` (92, 93), `setSprite2DUvOffset` (96) and
    `setSprite2DCoverageGamma`, each of which is a shader permutation the
    pin installs through a lazily-registered hook.
  - the billboard family (54-57, 59, 94, 95, 98, 118, 205, 206), which is a
    different module set (`billboard-*.js`) sharing only the atlas.
  Both GPU backends already draw the reached slice, so each item above is
  compiler and shader work rather than a second backend.
  - `updateSprite2DIndex`, `removeSprite2DIndex`, `setSprite2DFrameIndex`,
    `clearSprite2DLayer` and the Handle API: the writer is lowered for the
    add arm only, and the update arm's "preserve what was not supplied"
    resolution needs the previous instance read back.
- [ ] The sprite cluster past Scene 50, each line its measured first blocker
  now that `loadSpriteAtlas` and the pure-2D path have landed:
  - Scene 51: a browser-derived numeric value (`Expected number, received
    browser`), with the premultiplied atlas and blend behind it.
  - Scene 52: `onSceneDispose` — and behind it the HUD-over-scene composition
    the native renderers currently refuse.
  - Scene 53: `spriteBlendOpaque`, then depth-hosted layers.
  - Scene 58: its `PLAYER_SPRITE_URL` module constant, then sprite animation.
  - Scene 92: `createSprite2DCustomShader`; 93, 95, 96 want a string-literal
    argument first; 97: `spriteBlendMultiply`.
  - Scene 117: an unsupported constructor expression, then sprite picking.
  - Scenes 205, 206: engine options.
- [ ] The billboard family, which shares only the atlas with the pure-2D path:
  `createFacingBillboardSystem` (54, 55, 98, 118),
  `createAxisLockedBillboardSystem` (56), `createBillboardCustomShader` (94).
  Scenes 57 and 59 sit behind a Vec3-argument shape rather than the
  `CAMERA_POSITION` binding an earlier sweep recorded.
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
- [ ] Scene 261: support the reached `box.material` assignment, which is now
  what fails (the arrow function around it lowers since Scene 50); temporal
  anti-aliasing sits behind it.
- [ ] Scene 275: support `loadFont`.
- [ ] Scene 278: support `createLineSystem`.
- [ ] Scene 279: support `createLineMaterial`.

### Integration-first generation and asset packaging gaps

- [ ] Scene 211: support non-string glTF buffer URIs or reject the source contract earlier.

### Integration-first native runtime and loader gaps

- [ ] Port the pinned two-pass `.babylon` parent wiring and geometry-less
  `TransformNode` containers (`load-babylon.ts` second pass); the native
  loader currently skips parented and geometry-less nodes silently. No
  measured scene is affected: HillValley (Scenes 24/145) has neither, and
  Sponza's 16 parented and 29 geometry-less nodes are all bones and camera
  targets carrying no geometry, so gated Scene 9 already draws all 32 of its
  visible meshes. Reached by the ungated Scene 143.
- [x] **CLOSED.** Scene 253's **transparency** sphere. `whiteFallback` in
  `loader-gltf/animation-pointer-basecolor.ts` is the predicate this entry
  asked for: a base colour factor that is *animated*, on a material with *no
  base colour image*, bakes a fully white `[1,1,1,1]` texel and keeps the real
  factor — alpha included — in the uniform for the pointer writer. Our loader
  baked the factor into the texel *and* left its alpha in the uniform, so the
  0.502 authored alpha multiplied the 0.648 animated one to 0.326 against the
  browser's 0.648. That ratio, 0.5019, is the 0.5052 the images measured.
  Ported as a `collect_animated_base_color` pre-pass — a pre-pass upstream too,
  and for the same reason: materials are built before animations are read.

  Dawn **0.086/1.328 → 0.002/0.030**, SDL_GPU **0.128/1.936 → 0.047/0.681**;
  thresholds tightened to 0.06/0.8 and 0.005/0.05.

  It leaves one thing behind, which is a new entry rather than a residue of
  this one: the backends agreed to one channel step while the alpha defect
  dominated both, and now disagree at MAD 0.044. Scene 253 transmits, and
  SDL_GPU's transmission pass processes the resolved pixel once where the pin
  processes each MSAA sample — the same gap Scene 33 measures — so the SDL_GPU
  side of that entry now has a second scene behind it.

  The original diagnosis, kept because the method is reusable:

  The scene is a measured gate
  but its region figure carries a defect rather than a floor: 0.128/1.936 on
  SDL_GPU and 0.086/1.328 on Dawn, and both backends agree with each other to
  one channel step, which places the cause CPU-side.
  **The sphere is the one labelled Transparency, not the iridescence one this
  entry named until it was measured per object.** Boxing every object in the
  grid and taking its own MAD puts that sphere at **20.582** and leaves every
  other object at or below 1.346 — the iridescence sphere is 0.644 — so it
  carries essentially the whole region figure on its own. Re-measure per
  object before reading any of the history below; the earlier attributions to
  the iridescence and IOR spheres were made from crops.
  Inverting the pinned image processing (exposure 0.8, contrast 1.2, tonemap
  on) and comparing the sphere against the background it composites over, the
  native contribution above that background is **0.5052 / 0.5051 / 0.5054** of
  the browser's across R/G/B. A scalar that constant across channels is the
  alpha composition rather than the shading.
  Both sides carry the same input: the browser's animated material buffer
  (`buffers.json` #230, eight writes) decodes to `baseColorFactor
  (1, 1, 1, 0.647995174)` with `materialAlpha` 1, and the native capture's
  material 4 is `BLEND` with base color `(1, 1, 1, 0.647995174)`. So the
  animated value is not the divergence.
  **The alpha the two sides blend with is measured, not inferred.** Patching
  the deployed `pbr.frag.native.wgsl` to return a term as greyscale with output
  alpha forced to 1 and running it under Dawn, then inverting the pinned image
  processing, reads any shader value directly; an opaque sphere calibrates the
  inversion (alpha 1.0 recovers as 1.00146). That gives, on the transparency
  sphere:

  | term | value |
  | --- | --- |
  | final output alpha | 0.32886 |
  | `v_32`, the base alpha chain | 0.32274 |
  | `v_30.w`, the base-colour texel's alpha | 0.50330 |
  | `base_color_factor.w` in our uniform | 0.647995174 |

  So the texel alpha and the uniform alpha multiply: 0.5033 x 0.648 = 0.326.
  Against the browser's 0.648 that is a ratio of 0.5075, which is the
  0.5052 the images measure. The BLEND arm's specular boost contributes 0.006
  and is not the cause.

  **The texel alpha is the material's LOAD-TIME alpha and the uniform is its
  ANIMATED one.** The asset gives material 4 (`PBRProperties-Transparent`)
  `baseColorFactor [1, 1, 1, 0.5019608]` — exactly the 128/255 in the texel —
  and animates `/materials/4/pbrMetallicRoughness/baseColorFactor`. The
  generated loader bakes the load-time factor into the fallback texel
  (`gltf-loader-cpp.ts`, the `base_color_texture.bytes.empty()` branch) and
  reverts only `.r/.g/.b` to one, leaving `.a` in the uniform for the pointer
  writer to overwrite.

  The answer — `uploadBaseColorFactorTexture` does bake alpha
  (`Math.round(clamp(f[3]) * 255)`), so the bake itself matched, but the
  capture carried no 1x1 texel with alpha 128, which said the animated factor
  was not reaching that path at all. It reaches a *different* one:
  `whiteFallback` swaps the factor for `[1,1,1,1]` before the bake and returns
  the real one to be carried as a uniform field. Note the ORM branch
  immediately above ours documents the *opposite* resolution for its own
  factors — the pointer drives the uniform and the texel keeps the authored
  value — so the two factors did not share an answer, which is exactly why
  this had to be read rather than assumed.
  Eliminated by measurement, so do not retry: every material uniform (read
  back with `scene -- uniforms scene253 --size 48 --module 21`), the
  refraction parameters, the horizon-occlusion term the reference itself
  emits as 1.0 (our `v_99 * v_99` is the pin's `eho` — it squares inside
  `environmentHorizonOcclusion`, we square at the use site), occlusion
  strength, the unlit path, environment rotation at 0, the image-processing
  pass, and the animation clock. `scene -- diff scene253` adds that 65 of 98
  native uniform fields agree exactly and the rest are layout artifacts, so
  the inputs are not it. Note the row-1 spheres are laid out Volume,
  Transmission, Iridescence, IOR by node translation — NOT in label order.
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
