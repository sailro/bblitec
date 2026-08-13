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
- [ ] Move statement, expression, intrinsic, and property lowering into
  focused compiler modules instead of extending the entry compiler monolith.
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
  highlight, independent of `directIntensity`). No gated scene and no
  demo reaches this combination — the tetris rig adds the hemispheric
  first, so its directional key runs in the second slot, which is
  byte-effectively exact (tetris-well) — but the primary directional
  block should be diffed against the pinned
  `singlelight-directional-wgsl.ts` term by term before a scene needs
  it.
- [ ] Port fdlibm/V8 transcendentals (`pow`, `exp`, `cos`, `sin`) for
  bit-exact parity. `pow` gates level 3+ gravity (tetris-logic stays
  below 10 cleared lines so the reached exponent is exact); `cos`/`sin`
  ULPs against V8 are the tetris-blocks six-pixel rotated-silhouette
  floor (0.002 foreground on both backends).
- [ ] Extend array coverage to `splice`, `shift`/`unshift`, `indexOf`,
  and multi-argument `push` when the tetris renderer layer (particles)
  integrates.

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
- [ ] Sparse accessors and additional primitive modes.
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
- [ ] Generalize Standard lighting beyond the reached two-light uniform slice.

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
  custom per-sample resolve.
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
- [ ] Improve missing-tool and stale-output diagnostics.
- [ ] Add `--explain-feature` and generated-code-to-upstream inspection.
- [ ] Document adding a lowerer and curated scene fixture.

## P1 — Demo integration (tetris)

The pinned demo rules (`lab/lite/src/demos/tetris/{game,pieces}.ts`) are
corpus evidence compiled by the tetris-logic parity gate: byte-identical
to the browser reference on both backends under the pinned seeded
`Math.random` contract (mulberry32, seed 1; the capture harness installs
the identical generator, keyed off the generated manifest's
`deterministic-seeded-random` adaptation). Remaining stages:

- [x] Stage 2 (first slice) — `createMeshFromData` from typed arrays with
  the pinned computeAabb bounds fold, static `setThinInstances` matrix
  pools (record transforms stay identity like the demo prototypes), and
  `Float32Array`/`Uint32Array` in the data model, gated by tetris-blocks
  compiling the pinned chamfered-box generator (its inner quad/tri
  closures inline inside the native data function).
- [x] Function-valued parameters: inline function-literal arguments bind
  as callback values and inline at their call sites; early bare returns
  of inlined bodies lower through breakable do/while wrappers (value
  returns stay final-only); mutable tuple locals and numeric fallbacks
  round out the pinned rounded-box generator, which joined the corpus
  and the tetris-blocks gate. Mutable locals also stopped folding to
  their initial static values when bound as inline arguments.
- [x] `loadTexture2D` file textures: compile-time asset materialization,
  the pinned sampler defaults (linear/repeat, invertY true, srgb false,
  mip clamp when mipMaps is false), and base-color attachment onto
  created PBR materials paired with the white factor texel (base color
  requires srgb: true, matching the native slot). The tetris-blocks
  ring wears the demo frame colormap through the demo-exact nearest
  options. Scenes 62/81/83 keep their later blockers (node materials).
- [x] PBR under scene-level directional lights and a second analytic
  slot, derived from the pinned single-light and multi-light blocks
  (`src/material/pbr/fragments/`): the primary slot discriminates
  hemispheric/point/directional at runtime, the second slot accumulates
  through the shared extra-light terms (disabled under glTF multi-light,
  which owns lights past the primary), and the tetris-blocks gate runs
  the demo rig byte-effectively-exactly. Layered (clearcoat/sheen)
  scenes keep the second slot's terms additive outside the layer
  composition; composing them properly stays with the layered
  multi-light TODO.
- [x] Dynamic thin instances — the sanctioned per-frame update path
  replacing the demo's `engine._device` escape hatch (which the
  compiler now recognizes and rejects with a pointer at the sanctioned
  helpers): `setThinInstances` adopts the caller's named array as a
  fixed-capacity pool, `flushThinInstances`/`setThinInstanceCount`
  re-upload the pinned `[0, count)` dirty range through a version-gated
  PAL sync on both backends, and thin-instanced records compose
  mesh.world × instanceWorld through the pinned double-precision
  TRS/parent composition instead of the baked-vertex transform. Gated
  by tetris-well: the scripted rules play one action per frame inside
  `onBeforeRender`, seven fixed-capacity color pools rewrite and flush
  every frame with degenerate hidden slots, the ghost preview varies
  its count, and every pool mesh carries a non-identity record
  transform.
- [x] Particle shader through typed WGSL IR — the demo's line-clear
  particle program compiles verbatim as a scene-local variant
  (tetris-sparks gate: unlit vertex colors, brightness default +
  setShaderFloat, seeded three-axis-rotated burst, byte-identical on
  both backends). The gate exposed and fixed two latent native bugs:
  the shader IR's color attribute location diverged from the shared
  GpuVertex table, and the Euler rotation bake applied X·Y·Z instead
  of the pinned eulerToQuat Z·Y·X order.
- [x] `removeFromScene` and per-frame camera clamping — runtime mesh
  removal drops the scene entry and marks the topology, both backends
  rematch their uploaded mesh entries to the rebuilt render plan by
  source identity (releasing only dropped entries; the SDL append-only
  guard is gone and Dawn's full rebuild already covered it), and the
  camera's target components accept per-frame writes alongside the
  already-supported scalar clamping. Gated by tetris-retire.
- [x] Handle-carrying plain data — a mesh handle stored in a struct or
  array drives its transforms, materials, and scene membership exactly
  like a mesh local, and `splice(index, 1)` removes an entry. Gated by
  tetris-particles, which runs the demo's particle sweep with plain
  functions. The gate also fixed a latent bug: direct mesh transform
  writes never bumped the transform version the backends gate their
  baked-vertex re-upload on.
- [ ] Bind a local from a data path as an alias rather than a copy, so
  the demo's `const p = this.live[i]!; p.life -= dt;` shape compiles.
  The pinned value model makes such locals read-only copies today
  (tetris-particles indexes through the list instead). This is the
  narrow, reached half of the escape-analysis entry above; the hazard
  to settle first is invalidation — a `push` can reallocate the backing
  vector while an alias is live.
- [ ] Stage 2 (remaining) — the class/closure subset for
  `TetrisParticles` (private fields and methods over the now-supported
  particle data) and the renderer record with methods, a getter, and
  `Record<mode, set>` runtime-string indexing. Validate with a
  static-board gate before any game loop.
- [ ] Inlined value returns compile through the default float path in
  compound numeric contexts (a double-to-float-to-double round-trip);
  route inline return expressions through double precision. Parameter
  reassignment inside inlined functions can also still fold a static
  argument; strip static metadata from parameter bindings that are
  reassigned.
- [ ] Stage 3 — wiring: a PAL keyboard contract beyond the camera keys,
  `performance.now` as PAL frame time under fixed delta, erasure for the
  DOM HUD/audio/progress modules, and a scripted-input-tape capture mode
  for interactive goldens (seeded no-input goldens work today).
- [ ] Audit the remaining demos against the same lanes: mosquito-amber
  (≈ scene 176), bath-day/landing-bg/littlest-tokyo/torus-states
  (single-file, near scene shape), then the 4-5k-line games
  (minecraft/platformer/sandblox/freeciv) and the file-format loaders
  (quake/doom/racer) last.

## P1 — Full Babylon Lite corpus audit

The exploratory audit uses the pinned
`95ed3029cc43e479ec924741aea4024e9bf33527` corpus. These entries cover every
scene that did not reach a MAD measurement; measured scenes are dashboarded in
[status](docs/status.md).

Corpus scenes are the preferred validation: a feature is proven by the pinned
Babylon Lite scenes that reach it, not by a project-owned gate. Author a gate
only for a contract no corpus scene exercises (a feature combination the corpus
never composes, or a slice being built ahead of the scene that will use it),
and delete it once corpus scenes cover the contract.

The 188 unmeasured scenes are partitioned by the boundary required to reproduce
their deterministic reference behavior, not by incidental browser helpers.
Capture-inert demo controls and fixed-coordinate picking stay in the first
lane when they can be erased or lowered inside the compiler, asset pipeline,
or renderer. A scene is deferred when its covered behavior needs a new
platform, user-input, or external-service contract.

Scenes 256 and 280 arrived with the 1.20.0 pin and are unaudited: 256 is the
Khronos NormalTangentTest glTF (likely close to the reached PBR slice), 280 is a
node-particle flow-map editor scene (node-particle sources, deferred lane).

**Integrate first (150 scenes):** 4, 9, 11, 12, 15-23, 25-27, 30,
34, 36-39, 43, 50-99, 110-115, 117, 118, 120-129, 140-144, 147-149, 152,
155-162, 165, 177, 179, 200-207, 211, 214, 215, 217-219, 223, 226, 229,
231, 241, 242, 244, 251-253, 260-264, 267-271, 275-279. Scenes 3, 7,
35, and 216 graduated to measured parity gates on 2026-08-12.

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
- [ ] Scene 115: re-audit past the ported camera-target assignment for
  its remaining deterministic-picking blockers.
- [ ] Scenes 11, 144, 152, 157, 158, 179, 229: generalize static array resolution.
- [ ] Scenes 12, 43: fold or explicitly lower the reached browser-dependent conditions.
- [ ] Scenes 15, 67-72, 223: support `createSpotLight`.
- [ ] Scenes 16, 226, 251, 261: extend numeric expression operators.
- [ ] Scene 17: support `Math.atan`.
- [ ] Scenes 18, 25: support Standard ground diffuse textures.
- [ ] Scene 19: support `loadDdsEnvironment`.
- [ ] Scene 20: lower the reached arrow-function value.
- [ ] Scenes 21, 90: support the reached non-identifier variable declarations.
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
- [ ] Scenes 62, 81, 83: support `loadTexture2D`.
- [ ] Scene 63: support reached scene-light insertion.
- [ ] Scenes 66, 214, 215, 271: support `receiveShadows`.
- [ ] Scene 73: support camera viewports.
- [ ] Scenes 74, 76: support `createEffectWrapper`.
- [ ] Scene 75: support the `SCENE_CLEAR_COLOR` shader binding.
- [ ] Scene 86: support `setClipPlane`.
- [ ] Scene 91: support `initializeCsg2Async`.
- [ ] Scene 99: support `enableBoneControl`.
- [ ] Scene 110: support Standard material diffuse textures.
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
- [ ] Scene 231: support `enableStandardVertexColors`.
- [ ] Scene 241: fold the reached query-derived camera alpha.
- [ ] Scene 252: generalize the reached structured argument.
- [ ] Scenes 262-264, 276, 277: support node-particle sources.
- [ ] Scene 267: re-audit past the ported `createMeshFromData` for its
  remaining blockers.
- [ ] Scene 268: support orthographic cameras.
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
- [ ] Scene 9: support nullable glTF fields currently read as strings.
- [ ] Scene 30: support the reached glTF data without a `bufferView`.
- [ ] Scenes 34, 242, 244, 253: extend native glTF animation channel
  coverage (LINEAR/CUBICSPLINE scale landed with Scene 7; STEP channels
  and the remaining audited gaps stay).
- [ ] Scene 37: support the reached glTF data without an image `source`.
- [ ] Scene 260: support the reached non-triangle-list glTF primitive mode.

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
