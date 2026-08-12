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
  (scenes 6/14; identical codegen makes it reproducible and should
  take both scenes below their SDL floors). Needs the dithered shader
  variant emitted at generation time.
- [ ] Port the scene 1 diagnostics/attribution outputs to Dawn (draw
  IDs, triangle clusters, PBR diagnostic buffers); today
  `parity:diagnostics` renders them through SDL_GPU only.
- [ ] Formalize a backend-differential comparison mode in the parity
  tooling (render both backends, diff them against each other and the
  golden in one report), then review the per-scene thresholds against
  the Dawn columns.
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
- [ ] Generate scene-local custom shader variants from supported WGSL IR
  instead of limiting native emission to predeclared variant names.
- [ ] Extend shader IR to composed PBR/Grid/background fragments, then replace
  the remaining renderer-lowerer source-text contracts with parsed shader IR.
- [x] Lower non-generic typed user functions, defaults, and one final return.
- [x] Support lexical block scopes and safe variable shadowing.
- [x] Lower block-scoped `if`/`else`, numeric `for`, and `while`.
- [x] Unroll `for...of` over statically resolved array literals.
- [ ] Lower runtime iterables, `switch`, `break`, and `continue`.
- [ ] Generalize typed object and array literals.
- [ ] Add enums, discriminated unions, and narrowing.

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

## P1 — Full Babylon Lite corpus audit

The exploratory audit uses the pinned
`7184feda683072980735f9a180e6f567ee5717ba` corpus. These entries cover every
scene that did not reach a MAD measurement; measured scenes are dashboarded in
[status](docs/status.md). Each scene is listed under its first observed
blocker; later compiler or runtime gaps may remain hidden behind it.

### Compiler contract gaps

- [ ] Scenes 3, 216: support `setFog`.
- [ ] Scenes 4, 22, 65, 141: support light position setters.
- [ ] Scenes 7, 115: support camera target assignment.
- [ ] Scenes 11, 144, 152, 157, 158, 179, 229: generalize static array resolution.
- [ ] Scenes 12, 40-47, 100-106, 224: fold or explicitly lower the reached browser-dependent conditions.
- [ ] Scenes 15, 67-72, 223: support `createSpotLight`.
- [ ] Scenes 16, 171, 174, 175, 226, 251, 261: extend numeric expression operators.
- [ ] Scene 17: support `Math.atan`.
- [ ] Scenes 18, 25: support Standard ground diffuse textures.
- [ ] Scene 19: support `loadDdsEnvironment`.
- [ ] Scene 20: lower the reached arrow-function value.
- [ ] Scenes 21, 90: support the reached non-identifier variable declarations.
- [ ] Scene 23: support `Math.cos` with runtime numeric arguments.
- [ ] Scenes 26, 87: support image-processing `toneMapping`.
- [ ] Scene 27: support glTF `selectVariant`.
- [ ] Scene 35: expose camera target values.
- [ ] Scene 36: support `loadBasisTexture2D`.
- [ ] Scene 38: support `createCylinder`.
- [ ] Scenes 39, 148: support reached scene-light list mutation.
- [ ] Scene 48: support or explicitly classify Havok physics initialization.
- [ ] Scenes 49, 222: support the reached four-argument intrinsic calls.
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
- [ ] Scene 153: support the reached one-argument call.
- [ ] Scenes 155, 156: support property-animation blending.
- [ ] Scenes 159, 161, 165: generate the reached shader-material variants from typed shader IR.
- [ ] Scenes 160, 162: extend reached shader-material options.
- [ ] Scene 164: classify or lower reached GPU-device access.
- [ ] Scenes 170, 172, 173: support `createNavigationPluginAsync`.
- [ ] Scenes 177, 217: extend reached PBR material options.
- [ ] Scenes 180, 181: support reached `void` expression statements.
- [ ] Scenes 200, 201: lower the high-precision-matrix helper promise chain.
- [ ] Scenes 202-207, 209: extend reached engine options.
- [ ] Scenes 218, 219: support asset-container entity iteration.
- [ ] Scene 221: support mesh names.
- [ ] Scene 225: support `createGeospatialCamera`.
- [ ] Scenes 227, 228: support `createSurface`.
- [ ] Scene 231: support `enableStandardVertexColors`.
- [ ] Scene 241: fold the reached query-derived camera alpha.
- [ ] Scene 252: generalize the reached structured argument.
- [ ] Scenes 262-264, 276, 277: support node-particle sources.
- [ ] Scene 267: support `createMeshFromData`.
- [ ] Scene 268: support orthographic cameras.
- [ ] Scene 269: support transform nodes.
- [ ] Scene 270: support the reached mesh scaling setter.
- [ ] Scene 272: support Standard material diffuse textures.
- [ ] Scene 275: support `loadFont`.
- [ ] Scene 278: support `createLineSystem`.
- [ ] Scene 279: support `createLineMaterial`.

### Generation and asset packaging gaps

- [ ] Scene 211: support non-string glTF buffer URIs or reject the source contract earlier.

### Native runtime and loader gaps

- [ ] Port the pinned two-pass `.babylon` parent wiring and geometry-less
  `TransformNode` containers (`load-babylon.ts` second pass); the native
  loader currently skips parented and geometry-less nodes silently. Zero
  effect on gated Scenes 24/145 (HillValley has neither); reached by ungated
  Scenes 9 and 143 (Sponza `.babylon`).
- [ ] Scene 9: support nullable glTF fields currently read as strings.
- [ ] Scene 30: support the reached glTF data without a `bufferView`.
- [ ] Scenes 34, 242, 244, 253: extend native glTF animation channel coverage.
- [ ] Scene 37: support the reached glTF data without an image `source`.
- [ ] Scene 260: support the reached non-triangle-list glTF primitive mode.

## P1 — Backend portability

### Vulkan

- [ ] Emit SDL-compatible SPIR-V directly from Tint instead of recompiling
  normalized Tint HLSL with DXC.
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
