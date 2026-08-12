# bblitec TODO

Only unfinished work belongs here. Completed capabilities and measured
baselines belong in [status](docs/status.md) and Git history.

## Constraints

- derive Babylon behavior from the pinned upstream TypeScript
- keep handwritten C++ at the PAL/resource boundary
- preserve tree shaking, provenance, typed records, and C++20 portability
- do not add scene, geometry, or golden-image heuristics
- validate generation, native builds, and relevant parity gates locally

## P0 — Dawn (WebGPU) render backend

The golden references are produced by Chrome's WebGPU, which is Dawn on
D3D12. Rendering through the pinned Dawn commit (shared with the Tint
pin) makes shader codegen and rasterization structurally match the
reference. Staged migration; SDL_GPU stays the default until Dawn parity
is a strict superset. The SDL_Renderer CPU fallback is out of scope.

Progress, verified findings, ported pinned contracts, and the ordered
remaining work live in [migration](docs/migration.md). Seventeen scenes
pass on Dawn at values equal to or better than SDL_GPU, including
bit-exact scenes 2/10/32/259 and BoomBox at the SDL baseline.

- [ ] Scene 249 mask-edge residual (0.012/0.499, max 7): discard versus
  alpha-to-coverage state or vertex-color interpolation.
- [ ] `.babylon` reflection cubes, scene 8 probe, material extensions,
  deformation/instancing/storage-morph, GridMaterial, shader variants,
  frame graph, transmission with per-sample image processing plus the
  re-enabled pinned dither, diagnostics — see the ordered list in
  [migration](docs/migration.md).
- [ ] Full-matrix Dawn validation, threshold review, and the SDL_GPU
  retirement decision.
- [ ] Migrate scene families behind parity gates (Standard, PBR/IBL,
  backgrounds, frame graph, transmission with per-sample image
  processing, deformation); re-enable the pinned background dither.
- [ ] Retire SDL_GPU and the DXC/normalization/shader-cache machinery
  once Dawn parity is a strict superset; update the docs' backend
  rationale explicitly.

## P0 — Backend portability

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

- [ ] Multiple UV sets and texture-coordinate selection.
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
  transmission target: upstream's `image-processing-task.ts` applies
  exposure/tonemap/gamma per MSAA sample and then averages, while SDL_GPU
  cannot bind a multisampled texture for sampling, so the native pass
  processes the resolved pixel once. Requires SDL_GPU multisampled-texture
  sampling (vendored patch) or an equivalent custom per-sample resolve; this
  bounds the remaining edge bias on Scenes 33, 176, and 212.
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
- [ ] Close the residual morph and instancing raster-edge gaps in Scenes 243
  and 247 without expanding geometry or adding scene-specific tolerances.
  Upstream history review classifies both residuals as achromatic
  Dawn-versus-SDL_GPU 4x-MSAA coverage stepping on deformed or instanced
  silhouettes; interiors are within 2 LSB. Porting the pinned
  storage-buffer morph path produced frames bit-identical to the former
  CPU fallback, ruling out evaluation-place divergence and attributing the
  Scene 243 residual to browser-versus-native shader codegen or raster
  behavior.
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
