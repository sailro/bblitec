# bblitec TODO

Only unfinished work belongs here. What is done is in [status](docs/status.md),
the docs, and Git history. Entries state what remains and the facts needed to
act on it — not what was tried.

The 2026-08-18 repository audit tracked its findings separately in
[AUDIT.md](AUDIT.md), under the same delete-when-fixed rule as this file.
Its open entries are closed; what persists there is the verified-clean
record future audits build on.

## Constraints

- derive Babylon behavior from the pinned upstream TypeScript
- keep handwritten C++ at the PAL/resource boundary
- preserve tree shaking, provenance, typed records, and C++20 portability
- do not add scene, geometry, or golden-image heuristics
- validate generation, native builds, and relevant parity gates locally

## P0 — Dual render backends

Both backends stay long-term as mutually validating implementations;
[backends](docs/backends.md) carries the comparison and the guards.

- [ ] Extend the Dawn integration beyond Windows. The platform surface is one
  HWND branch, the adapter backend selection, and the per-OS Dawn library
  build; the WGSL feeds Dawn directly, so no per-platform shader work exists on
  this path.
- [ ] Reduce the release payload further: trim the Dawn DLL set through Dawn
  build options (a DXC-less build changes rendering, so the compiler stays),
  ship only the CRT DLLs the exe imports, drop SPIR-V from D3D12-only packages
  once packaging can declare a target driver, and evaluate packed native assets.

## P1 — TypeScript compiler coverage

### Modules and functions

- [ ] Add namespace/default imports and non-static module initialization.
- [ ] Build a typed user-code IR from `ts.Program`/`TypeChecker` symbols.
- [ ] Move statement, expression, and intrinsic lowering into focused compiler
  modules instead of extending the entry compiler monolith.
- [ ] Extend the typed shader IR to the WGSL still emitted as text outside
  it: the shared material vertex stage (`src/shader-builtins-standard.ts`),
  the sprite pair's binding re-homing shell (`src/shader-builtins-sprite.ts`),
  the grid fragment's option-gate shell (`src/shader-builtins-grid.ts`), and
  the project-owned blit/depth/diagnostic stages in
  `src/shader-builtins-utility.ts`. The pinned bodies inside them are already
  lifted or evaluated from the pin; the shells and the project-owned stages
  are what the IR does not carry.
- [ ] Lower string-literal switch discriminants.
- [ ] Add discriminated unions and numeric-literal narrowing beyond the
  checker's null analysis.
- [ ] Generalize the contracts Scene 50 folds at compile time: a nullish operand
  that is not a static record property, and a callback that escapes its call
  site, both fail explicitly. `canvas.width`/`canvas.height` name the engine's
  configured size; a scene reading them after a resize needs the live
  render-target size from the pinned `getRenderTargetSize`.
- [ ] Replace the conservative alias rules (const path-bound locals alias
  natively and are poisoned when their container is resized; mutable
  path-bound locals are read-only copies; owned locals reject writes after
  escaping by copy) with real escape analysis when a reached scene needs
  shared mutable objects.
- [ ] Close the primary-slot directional specular residual: a directional light
  in the first analytic slot under mid/low roughness renders its specular
  highlight a few percent dim (sphere, roughness 0.35, max channel delta 10-15
  at the highlight, independent of `directIntensity`). No gated scene reaches
  it. Diff the primary directional block against the pinned
  `singlelight-directional-wgsl.ts` term by term.
- [ ] Port fdlibm/V8 transcendentals (`pow`, `exp`, `cos`, `sin`) for bit-exact
  parity. No registered scene reaches the `cos`/`sin` case.
- [ ] Route inline return expressions through double precision: inlined value
  returns compile through the default float path in compound numeric contexts.
  Strip static metadata from parameter bindings that are reassigned inside an
  inlined function.
- [ ] Extend array coverage to `shift`/`unshift` and the `indexOf` `fromIndex`
  form when a reached scene needs them.
- [ ] Support off-center orthographic planes: `enableOrthographicCamera` accepts
  explicit `left`/`right`/`bottom`/`top` bounds replacing the half-extent
  derivation, and `disableOrthographicCamera` restores the perspective
  projection. The native camera record carries one extent. The orthographic
  branch lives in `build_view_projection` alone, so composing it with an
  environment skybox or ground fails at generation.

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

- [ ] Texture-coordinate selection for base color, normal, emissive, and
  metallic-roughness. Only the TEXCOORD_1 occlusion slice is supported.
- [ ] `KHR_texture_transform.texCoord` (selects a UV set per slot; zero usages
  across all 46 corpus model URLs) and upstream's orm-unpack split, where
  occlusion samples the ORM image at a transform of its own.
- [ ] Vertex colors beyond the reached alpha/mask slice.
- [ ] Sparse accessors, and the point/line/line-strip primitive modes.
- [ ] glTF animation: STEP channels, multiple clips, richer animation-group
  controls.
- [ ] glTF cameras. A PBR scene whose first light is a spot fails explicitly:
  the primary analytic slot encodes the light kind in `lightDirection.w` and
  carries no cone.
- [ ] KTX2/Basis and compression investigations.

### Property animation

- [ ] Generalize property bindings beyond mesh `position`, `position.x`,
  `scaling`, and `rotationQuaternion`.
- [ ] Generalize animation targets beyond meshes while retaining typed
  compile-time path validation.
- [ ] Support multiple direct morph targets and reusable target data. The
  corpus's five direct `createMorphTargets` calls each use one position target
  with nullable normals, so no corpus gate covers the broader surface.

### Material extensions

- [ ] Anisotropy, including `setPbrAnisotropy`.
- [ ] Require typed metadata specialization, focused tests, and an independent
  parity scene for each extension.
- [ ] Carry a spot light's cone angle at the pin's precision. The pinned factory
  computes `Math.cos(angle * 0.5)` in doubles into a float UBO; the compiler
  passes scalars as `static_cast<float>(<double expression>)`, so the cosine is
  computed from an already-rounded angle. The two orders disagree by one ULP for
  35% of plausible cone angles at 1e-4 spacing, and the cone test is a hard `>=`
  threshold, so one ULP flips boundary pixels. Scenes 18, 22, and 203 pass 1.2,
  1.5, and 0.8; measure one before deciding whether the intrinsic boundary needs
  a double-valued scalar path.
- [ ] Extend scene-code spot lights past the reached colour pair: the pinned
  light also exposes `angle`, `exponent`, and `range` as settable properties,
  whose setters fail explicitly. One composition stays out: a spot landing in
  the first PBR analytic slot refuses at run time, because that slot encodes
  the light kind in `lightDirection.w` and carries no cone.
- [ ] Extend Standard vertex colors past RGB: the pinned
  `std-vertex-color-fragment.ts` also consumes `vColor.a` under the
  `mesh.hasVertexAlpha` opt-in (output alpha, the vertex-alpha alpha test, the
  transparent-phase source-over blend). Composition already takes the
  `vertexAlpha` flag; the compiler always passes false because the
  `hasVertexAlpha` setter is not lowered.

### Packed native assets

- [ ] Define a versioned native scene format with deterministic hashes.
- [ ] Prepack geometry, materials, textures, hierarchy, and animation data.
- [ ] Retain source loaders for development and parity.
- [ ] Measure startup, runtime, and size tradeoffs.

## P1 — Runtime and validation

- [ ] Drop the vendored SDL patch once upstream ships it.
  `native/vcpkg-overlay-ports/sdl3` is the registry's own port at the manifest's
  `builtin-baseline` with
  [libsdl-org/SDL#15838](https://github.com/libsdl-org/SDL/pull/15838) appended
  to its `PATCHES` list, selected by `native/vcpkg-configuration.json`. Without
  it SDL refuses a multisample texture carrying a read usage and the SDL_GPU
  backend cannot run the pinned per-sample image-processing pass. **3.6.0 is the
  release to watch**; when it carries the patch, move `builtin-baseline` to a
  registry commit containing it and delete both paths. Verify a candidate
  release by creating a 4x multisample texture with
  `SDL_GPU_TEXTUREUSAGE_GRAPHICS_STORAGE_READ` (the shape the per-sample pass
  needs) before moving the baseline.
- [ ] Compose environment/camera sizing from object-local bounds through the
  pinned abs-matrix OBB-to-AABB world transform, and add the `upperRadiusLimit`
  ground/skybox override (upstream `scene-size.ts`, `mesh-world-bounds.ts`,
  PR #532). No corpus scene sets `upperRadiusLimit`. The blocker is the input,
  not the arithmetic: `expandWorldAabbForMesh` composes each object-local box
  through the mesh world matrix while the loader feeds it the tight AABB of
  already-baked vertices, which is strictly smaller wherever a node carries
  rotation. This closes once the loader records each primitive's local box
  beside its node matrix. The port must keep every sized scene bit-identical at
  its gated pose.
- [ ] Name Scene 7's remaining foreground residual: 543 pixels beyond 5 on the
  belly scute ridges, tiles (608,384)/(608,400)/(608,368). A sub-pixel shift
  explains 4.8% of it, so it is shading, not silhouette. The bone palettes are
  excluded — the two skins that differ from the browser's bone textures differ
  by exactly the mesh node translation, which the pin cancels against
  `MeshUniforms.world`. New suspect (2026-08-18 audit): the asset carries
  JOINTS_1/WEIGHTS_1, so the browser skins eight influences per vertex
  (`MSH_HAS_SKELETON_8`) where the generated loader truncates to four — now
  recorded per scene as the `four-influence-skinning` adaptation. The dropped
  tail weights matter exactly at blend regions like ridge creases, which is
  where the residual sits. Test by summing the second pair's weights over the
  residual tiles' vertices before implementing anything.
- [ ] Add generation-checked handles and resource lifetime/leak checks.
- [ ] Add dirty flags and incremental GPU updates.
- [ ] Add device-loss and resize-safe resource recreation.
- [ ] Add multiple registered scenes and scene switching.
- [ ] Add headless renderer tests.
- [ ] Add differential tests for camera, environment, material, and transform
  functions.
- [ ] Find why Scenes 9 and 37 do not render bit-identically on Dawn across
  runs. Scoped to Dawn's multisampled geometry pass: SDL_GPU and Dawn under
  `BBLITE_MSAA=1` are bit-identical across runs, only 4x Dawn moves, by 11-70
  pixels of 921600, every one of them exactly ±1, on high-gradient pixels in a
  band around x∈[460,785] y∈[280,355]. The asset carries no animations or skins
  and the registry pins no clock; the Dawn image-processing pass sums samples in
  a fixed order, so the samples differ rather than the average; every geometry
  attachment uses `LoadOp_Clear`. What is left is per-sample coverage or
  per-sample depth. Next step: an instrumented capture of the multisampled
  attachment rather than the resolved frame. Scene 37 reproduces every run.
  `scene -- neutrality` excludes these two scenes' Dawn cells; delete that
  exclusion with this entry.
- [ ] Add malformed asset and backend-layout tests.

## P1 — Developer experience

- [ ] Add portable CMake presets.
- [ ] Share one `VCPKG_INSTALLED_DIR` across build trees. Each build directory
  carries its own 48 MB copy of `vcpkg_installed`, about 2.8 GB across the
  matrix.
- [ ] Improve missing-tool and stale-output diagnostics.
- [ ] Add `--explain-feature` and generated-code-to-upstream inspection.
- [ ] Document adding a lowerer and curated scene fixture.

## P1 — Full Babylon Lite corpus audit

167 corpus scenes remain unregistered; measured scenes are in
[status](docs/status.md). No unregistered scene compiles clean — the
compiler-contract lane gates the rest. Each entry records the first blocker
only; clearing it can expose another.

Refresh the audit by building `dist` once, then compiling each scene directly:
`node dist/src/scene-command.js compile corpus/babylon-lite/lab/lite/src/lite/sceneNNN.ts`.
The command accepts an unregistered path.

**The corpus carries only the shared modules registered scenes import.**
`lab/lite/src/shared/` and `lab/lite/src/_shared/` hold three files
(scene252-stdmorph.ts, sprite-atlas-image.ts, sprite-grid.ts), each pinned in
`upstream/babylon-lite-scenes.json`. The node-material cluster imports absent
modules (`../shared/sceneNN-nme.js`); integrating from it starts by copying
those out of the pinned upstream tree and pinning their SHA-256 beside the
scenes.

**Largest first-blocker clusters:** browser-dependent condition 17 (15 of them
deferred-lane physics), `parseNodeMaterialFromSnippet` 17, engine options beyond
msaaSamples/requiredLimits 7, `parseNodeParticleSource` 6, static array literal
5, `receiveShadows` 5, `loadSplat` 5, `??` over a non-static-record operand 5,
`light.position.set` 4, `createFacingBillboardSystem` 4, string-literal
arguments 3, `createNavigationPluginAsync` 3. Standard diffuse-texture
assignment blocks 5 (18, 25, 90, 110, 272), vector `.set()` on node properties
blocks 6 (4, 22, 65, 141, 142, 223), mesh name/id setters block 4 (111, 113,
129, 221).

**No corpus scene can retire the runtime-sweep gate.** Of the scenes reaching
`createMeshFromData` (86, 114, 170-175, 231), `setThinInstances` (16, 17, 43,
103, 165, 204, 219, 279) or `removeFromScene` (129, 173, 271, 272), none
compiles. `flushThinInstances` and `setThinInstanceCount` are unreferenced under
`corpus/` at this pin, so a project-owned gate is their only validation.

Corpus scenes are the preferred validation: a feature is proven by the pinned
scenes that reach it. Author a gate only for a contract no corpus scene
exercises, and delete it once corpus scenes cover that contract.

Scenes are partitioned by the boundary required to reproduce their deterministic
reference behavior, not by incidental browser helpers. Capture-inert demo
controls and fixed-coordinate picking stay in the first lane when they can be
erased or lowered inside the compiler, asset pipeline, or renderer. A scene is
deferred when its covered behavior needs a new platform, user-input, or
external-service contract.

**Integrate first (133 scenes):** 4, 11, 12, 16-18, 20, 22, 23, 25-27, 36, 38,
43, 51-99, 110-115, 117, 118, 120-129, 140-144, 147-149, 152, 155-158, 160, 162,
165, 177, 179, 200-207, 211, 214, 215, 217-219, 223, 226, 229, 231, 241, 251,
261-264, 269-271, 275-280. Includes static CSG/CSG2, compressed assets and
splats, deterministic picking (113-115, 117, 118, 129), and display-only gizmos
(223).

**Defer (34 scenes):** 40-42, 44-49, 100-106, 153, 164, 170-175, 180, 181, 209,
221, 222, 224, 225, 227, 228, 272.

No audited scene requires audio, touch, gamepad, AR, or VR. Add any future scene
that does to the deferred lane by default.

### Integration-first compiler contract gaps

- [ ] Scenes 4, 22, 65, 141, 223: support light position setters.
- [ ] Scene 115: support `Number.isFinite`, then re-audit for deterministic
  picking.
- [ ] Scenes 11, 144, 152, 157, 158, 179: generalize static array resolution to
  array shapes that are not static literals.
- [ ] Scene 229: lower the reached spread element.
- [ ] Scenes 12, 43: fold or explicitly lower the reached browser-dependent
  conditions.
- [ ] Scenes 171, 174, 175, 226, 251: lower `??` over an operand that is not a
  static record property — 226 `container._gaussianSplats ?? []`, 251
  `xbot.animationGroups ?? []`. Splats, animation groups and the Recast lane sit
  behind them.
- [ ] Scenes 18, 25: support Standard ground diffuse textures.
- [ ] Scene 20: lower an arrow function bound to a name and used as a value.
- [ ] Scenes 26, 87: support image-processing `toneMapping`.
- [ ] Scene 27: support glTF `selectVariant`.
- [ ] Scene 36: support `loadBasisTexture2D`.
- [ ] Scene 38: support `createCylinder`.
- [ ] Scene 148: support `createDepthOfFieldPostProcessTask`.
- [ ] Extend the sprite path past the slice Scene 50 measures. Each item is a
  separate arm upstream keeps behind its own module or hook, and each fails
  explicitly today:
  - the other blend descriptors — `spriteBlendPremultiplied` (51, with
    `premultiplyOnLoad`), `spriteBlendMultiply` (97), `spriteBlendOpaque` (53).
    The native record carries the pin's factor pairs, so this is compiler-side
    plus one pipeline per distinct blend.
  - depth-hosted layers: `addDepthHostedSpriteLayer` with `depth: "test"` /
    `"test-write"` (53), which adds the 14th instance float, the depth
    attachment and the scene bind group, and composes with a `SceneContext`.
  - a `SpriteRenderer` overlaid on a scene (52) — that composition without the
    depth slot: the sprite pass appends to the scene's frame.
  - `createSprite2DCustomShader` (92, 93), `setSprite2DUvOffset` (96) and
    `setSprite2DCoverageGamma`, each a shader permutation the pin installs
    through a lazily-registered hook.
  - `updateSprite2DIndex`, `removeSprite2DIndex`, `setSprite2DFrameIndex`,
    `clearSprite2DLayer` and the Handle API: the writer is lowered for the add
    arm only; the update arm's "preserve what was not supplied" resolution needs
    the previous instance read back.
- [ ] The sprite cluster past Scene 50, each its measured first blocker:
  - Scene 51: a browser-derived numeric value, with the premultiplied atlas and
    blend behind it.
  - Scene 52: `onSceneDispose`, then the HUD-over-scene composition the native
    renderers refuse.
  - Scene 53: `spriteBlendOpaque`, then depth-hosted layers.
  - Scene 58: its `PLAYER_SPRITE_URL` module constant, then sprite animation.
  - Scene 92: `createSprite2DCustomShader`; 93, 95, 96 want a string-literal
    argument first; 97: `spriteBlendMultiply`.
  - Scene 117: an unsupported constructor expression, then sprite picking.
  - Scenes 205, 206: engine options.
- [ ] The billboard family, a different module set (`billboard-*.js`) sharing
  only the atlas: `createFacingBillboardSystem` (54, 55, 98, 118),
  `createAxisLockedBillboardSystem` (56), `createBillboardCustomShader` (94).
  Scenes 57 and 59 sit behind a Vec3-argument shape.
- [ ] Scenes 60, 61, 64, 67-71, 77-80, 82, 84, 85, 88, 89: support node-material
  snippets.
- [ ] Scenes 62, 81, 83: resolve the module-level texture-URL constants
  (`SCENE62_TEXTURE_URL` and siblings).
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
- [ ] Scene 165: the viewProjection + world system-uniform pair, per-instance
  thin-instance colors (`setThinInstanceColors` plus the instance color vertex
  stream), and an explicit image-neutral lowering decision for
  `enableThinInstanceGpuCulling`.
- [ ] Scenes 160, 162: extend reached shader-material options.
- [ ] Scene 177: support `setPbrIridescence` on a scene-code material.
- [ ] Scenes 17, 217: extend reached PBR material options.
- [ ] Scenes 200, 201: lower the high-precision-matrix helper promise chain.
- [ ] Scenes 202-207: extend reached engine options.
- [ ] Scene 218: support asset-container entity iteration.
- [ ] Scene 219: lower a value return that is not an inlined function's final
  statement.
- [ ] Scene 231: support `enableStandardSkeleton`; behind it sit
  `enableStandardUvOffset`, `createTexture2DFromPixels`, the skeleton subpath
  imports (`createSkeleton`, `updateSkeletonBoneMatrices`), its shared
  `scene231-skin` module, and `mesh.hasVertexAlpha`.
- [ ] Scene 241: fold the reached query-derived camera alpha.
- [ ] Scenes 262-264, 276, 277, 280: support node-particle sources.
- [ ] Scenes 269, 270: support transform nodes.
- [ ] Scene 261: support the reached `box.material` assignment; temporal
  anti-aliasing sits behind it.
- [ ] Scene 275: support `loadFont`.
- [ ] Scene 278: support `createLineSystem`.
- [ ] Scene 279: support `createLineMaterial`.

### Integration-first generation and asset packaging gaps

- [ ] Scene 211: support non-string glTF buffer URIs or reject the source
  contract earlier.

### Integration-first native runtime and loader gaps

- [ ] Port the pinned two-pass `.babylon` parent wiring and geometry-less
  `TransformNode` containers (`load-babylon.ts` second pass); the native loader
  skips parented and geometry-less nodes silently. No measured scene is
  affected. Reached by the ungated Scene 143.
- [ ] Extend `KHR_materials_specular` past its two factors: `specularTexture`
  and `specularColorTexture` fail explicitly at load. Scene 241 is the only
  corpus asset carrying them and is compiler-blocked, so the pinned
  `metallicReflectanceTexture` / `reflectanceTexture` pair — including the
  `pow(2.2)` the reflectance fragment applies to each — stays unreached.
- [ ] Carry primitive topology to the pipeline for points, lines, and line
  strips. `load-gltf.ts` records a `_topology` index (1=points, 2=lines,
  3=line-strip, 4=triangle-strip; LINE_LOOP and TRIANGLE_FAN unsupported) and
  `gltf-feature-primitive.ts` builds the `GPUPrimitiveState`, so the native
  shape is a topology suffix on the generated `RenderPipelineKind` — which
  already encodes cull mode and winding — plus a field on each PAL's
  `PipelineKindTraits` and WebGPU's `stripIndexFormat`. Topology also arrives
  without an asset: `createLineSystem` sets `mesh._topology = 2` on geometry
  built from plain arrays and `createLineMaterial` sets
  `_topology: "line-list"`, so this is the axis Scenes 278 and 279 need. The
  generated loader rejects those modes by number behind the
  `nonTrianglePrimitives` specialization flag.

### Deferred external and platform-feature scenes

These stay out of the first integration wave even when the audit reports an
earlier compiler error.

- [ ] Scenes 40-42, 44-49, 100-106, 209: add Havok behind an independent physics
  dependency/PAL boundary. First blockers include browser conditions, Havok
  initialization, four-argument calls, and engine options.
- [ ] Scenes 170-175: add Recast navigation behind an explicit dependency
  boundary. First blockers include numeric operators and
  `createNavigationPluginAsync`.
- [ ] Scene 153: add a runtime 2D-canvas boundary; its final frame is drawn
  through `CanvasRenderingContext2D`, not Babylon Lite rendering. First blocker:
  the reached one-argument call.
- [ ] Scenes 180, 181: add live HTML text input, sliders, pointer drag, and
  wheel handling. First blocker: reached `void` expression statements.
- [ ] Scenes 221, 222, 224: add pointer-driven gizmo picking and drag routing.
  First blockers: mesh names, four-argument calls, a browser-dependent
  condition.
- [ ] Scene 225: add geospatial camera controls; the scene reaches
  `attachGeospatialControls` even though its reference frame is a static pose.
  First blocker: `createGeospatialCamera`.
- [ ] Scene 164: add device-loss recovery and direct GPU-device lifecycle
  access.
- [ ] Scenes 227, 228: add multiple native surfaces/swapchains for
  `createSurface`.
- [ ] Scene 272: add the direct GPU validation-error event contract reached
  through `engine._device` and `GPUUncapturedErrorEvent`. First blocker:
  Standard material diffuse textures.

## P1 — Backend portability

### Vulkan

Windows NVIDIA through SDL_GPU's Vulkan driver (enable the vcpkg `sdl3` port's
`vulkan` feature): geometry, camera, vertex uniforms, clip space and the
Standard family are correct (scene 2 byte-identical to the golden); the PBR
family mis-shades (scene 1 darkens roughly one gamma-decode, scene 10 renders
near-black). The generated SPIR-V lands in SDL's expected descriptor sets but
declares each texture/sampler as separate descriptors sharing one binding, while
SDL's Vulkan backend builds combined-image-sampler descriptors. The pinned Tint
CLI exposes no combined-sampler emission.

- [ ] Emit SDL-compatible SPIR-V (combined image samplers at SDL's set/binding
  contract) directly from Tint instead of recompiling normalized Tint HLSL with
  DXC.
- [ ] Localize and fix the PBR-family Vulkan shading divergence. Suspects: the
  separate-sampler aliasing and the PBR fragment's cbuffer/array layout.
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
- [ ] Keep this file free of history: no completed items, no investigation
  narrative, no before/after measurements.
