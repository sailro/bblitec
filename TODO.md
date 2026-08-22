# bblitec TODO

Only unfinished work belongs here. What is done is in [status](docs/status.md),
the docs, and Git history. Entries state what remains and the facts needed to
act on it — not what was tried.

## Constraints

- derive Babylon behavior from the pinned upstream TypeScript
- keep handwritten C++ at the PAL/resource boundary
- preserve tree shaking, provenance, typed records, and C++20 portability
- do not add scene, geometry, or golden-image heuristics
- validate generation, native builds, and relevant parity gates locally

## P1 — TypeScript compiler coverage

### Modules and functions

- [ ] Add namespace/default imports and non-static module initialization.
- [ ] Build a typed user-code IR from `ts.Program`/`TypeChecker` symbols.
- [ ] Lower string-literal switch discriminants.
- [ ] Add discriminated unions and numeric-literal narrowing beyond the
  checker's null analysis.
- [ ] Generalize the contracts Scene 50 folds at compile time: a nullish operand
  that is not a static record property, and a callback that escapes its call
  site, both fail explicitly. `canvas.width`/`canvas.height` name the engine's
  configured size; a scene reading them after a resize needs the live
  render-target size from the pinned `getRenderTargetSize`.
- [ ] Route inline return expressions through double precision: inlined value
  returns compile through the default float path in compound numeric contexts.
  Strip static metadata from parameter bindings that are reassigned inside an
  inlined function.
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

### Classes and objects

- [ ] Lower the required class/method/getter/setter/inheritance subset.

## P1 — Port, do not re-derive

- [ ] Retire the hand-written C++ that encodes upstream semantics, leaf by
  leaf. Two shapes are legitimate — LOWER (walk the pinned AST) or EXECUTE
  (run the pin and bake); a re-typed formula agrees only until upstream
  changes it. The templates in `src/lowering/templates/` are 5,319 lines,
  of which `gltf-loader-cpp.ts` alone is 4,548, and `renderer-lowerer.ts`
  is 4,516. `pinned-ubo-writer-lowerer.ts` and `pinned-shader-composer.ts`
  are the mechanisms to reuse. Each leaf is its own measurement: lower or
  execute it, then prove the generated tree moved only where intended.

## P1 — Assets and materials

### glTF

- [ ] Texture-coordinate selection for base color, normal, emissive, and
  metallic-roughness. Only the TEXCOORD_1 occlusion slice is supported.
- [ ] `KHR_texture_transform.texCoord` (selects a UV set per slot; zero usages
  across all 46 corpus model URLs) and upstream's orm-unpack split, where
  occlusion samples the ORM image at a transform of its own.
- [ ] Vertex colors beyond the reached alpha/mask slice.
- [ ] Sparse accessors, and the point/line/line-strip primitive modes.
- [ ] glTF animation: STEP channels, and a group's speed ratio, weight and
  mask.

### Property animation

- [ ] Generalize property bindings beyond mesh `position`, `position.x`,
  `scaling`, and `rotationQuaternion`.
- [ ] Generalize animation targets beyond meshes while retaining typed
  compile-time path validation.
- [ ] Support multiple direct morph targets and reusable target data. The
  corpus's five direct `createMorphTargets` calls each use one position target
  with nullable normals, so no corpus gate covers the broader surface.

### Material extensions

- [ ] Close the primary-slot directional specular residual: a directional light
  in the first analytic slot under mid/low roughness renders its specular
  highlight a few percent dim (sphere, roughness 0.35, max channel delta 10-15
  at the highlight, independent of `directIntensity`). No gated scene reaches
  it. Diff the primary directional block against the pinned
  `singlelight-directional-wgsl.ts` term by term.

- [ ] Anisotropy, including `setPbrAnisotropy`.
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
- [ ] Add generation-checked handles and resource lifetime/leak checks.
- [ ] Add dirty flags and incremental GPU updates.
- [ ] Add device-loss and resize-safe resource recreation.
- [ ] Add multiple registered scenes and scene switching.
- [ ] Add headless renderer tests.
- [ ] Add per-function differential tests for camera, environment, material
  and transform math. The seven project-owned `examples/regression-*.ts`
  gates and `parity --differential` compare whole images, not functions.
- [ ] Add backend-layout tests: nothing checks a compiled stage's `.slots`
  register layout against what the PAL binds.

## P1 — Developer experience

- [ ] Add portable CMake presets.
- [ ] Share one `VCPKG_INSTALLED_DIR` across build trees. Each build directory
  carries its own ~49 MB copy of `vcpkg_installed`: 133 trees, 7.6 GB.
- [ ] Clear the one MSVC /W4 warning the generated glTF loader carries:
  `C4456: declaration of 'world' hides previous local declaration`, where
  the animated-world-bounds arm names a `Vec3 world` inside the
  node-world walk's `std::vector<Matrix> world`. Nineteen generated trees
  compile it — sixteen scenes and three regression fixtures. A rename in
  the emitted text is the whole fix; it is a mechanical
  change to every glTF scene's generated bytes, so it wants its own
  neutrality pass rather than riding a feature.
- [ ] Add `--explain-feature`. The inspection half shipped as `scene -- diff`'s
  pinned-block and shader-arm attribution plus the per-scene
  `feature-activation.json`.
- [ ] Document adding a lowerer and curated scene fixture.

## P1 — Full Babylon Lite corpus audit

117 corpus scenes remain unregistered; measured scenes are in
[status](docs/status.md). No unregistered scene compiles clean — the
compiler-contract lane gates the rest. Each entry records the first blocker
only; clearing it can expose another.

Refresh the audit by building `dist` once, then compiling each scene directly:
`node dist/src/scene-command.js compile corpus/babylon-lite/lab/lite/src/lite/sceneNNN.ts`.
The command accepts an unregistered path.

**The corpus carries only the shared modules registered scenes import**,
each pinned in `upstream/babylon-lite-scenes.json`. Integrating a scene that
imports one starts by copying it out of the pinned upstream tree and pinning
its SHA-256 beside the scenes. The twenty shipped node-material graphs and the
ten shipped node-particle graphs are already there, as is scene 300's Sprite2D
fixture; the remaining node-material and skin modules are not — and a missing
module is invisible in a compile probe, because
the compiler reports the unresolved identifier the import would have bound
rather than the import.

**Largest first-blocker clusters** (swept against 1.23.0 on 2026-08-22, after
the animation-manager wave): `Number(...)` as a call 9 (all deferred-lane
physics), engine options beyond msaaSamples/requiredLimits 7 (large-world),
`receiveShadows` 6, `??` over a non-static-record operand 6, `HavokPhysics` 5,
PBR options beyond the reached set 3, a four-argument call 3, an unsupported
constructor expression 3, `createNavigationPluginAsync` 3.
Node materials shipped twenty of the thirty-one scenes reaching
`parseNodeMaterialFromSnippet`; of the eleven that remain, eight sit behind a
capability the reached slice refuses and three (111, 140, 141) behind blockers
unrelated to node materials. Node particles shipped ten of their eleven; only
scene 300 remains, behind the drawn atlas its graph is handed.

- [ ] Scenes 11 and 152 share one residual: the shark's skinned pose, 0.010
  full and 0.28 foreground, identical on both backends. The composed fragment
  is byte-identical to the browser's and the pose is not a clock offset, so
  the palette is the suspect: this port conjugates the mesh world into it
  where the pin keeps that world on the draw, and both scenes carry the shark
  at a 0.01 root scale where the conjugation loses the most precision. Next
  measurement: the same asset at unit scale.

**Rank by the whole family, not by the first blocker.** Node particles reached
*eleven* scenes (262, 263, 264, 276, 277, 280, 281, 283, 284, 300, 301) and ten
have shipped: seven as the frozen bake drawn through billboards, then the exact
Multiply and MultiplyAdd blends and the pure-2D Sprite2D bridge. Only 300
remains, and its blocker is an asset mechanism rather than a render one.

### The eight scenes 1.23.0 added

Four of the eight shipped. Of the four that remain, only 282 needs the corpus
sync the node-material cluster needs — copy its `shared/` module out of the
pinned tree and pin its SHA-256.

| Scene | First blocker | Family |
| --- | --- | --- |
| 220 | `KHR_mesh_quantization` on Duck.glb | glTF extension, with 11's spec-gloss |
| 250 | `enableGltfCameras` | glTF camera import, new in 1.21 |
| 282 | texture pixels from a module function (+ `shared/scene282-standard-uv-transform`) | Standard UV transform |
| 300 | an `OffscreenCanvas` construction in `shared/npe-sprite2d-fixture` | node particles through Sprite2D |

Scene 282 is the only corpus scene reaching `stdUvTransformExt`, the ninth
Standard extension 1.21 added. `pinned-standard-variants.ts` refuses a material
carrying one by name, so that refusal is what integrating 282 has to lift.

**No corpus scene can retire the runtime-sweep gate.** Scene 267 covers its
`createMeshFromData` half, but of the scenes reaching `setThinInstances` (16,
17, 43, 103, 165, 204, 219, 279) or `removeFromScene` (129, 173, 271, 272)
none compiles, and `flushThinInstances` and `setThinInstanceCount` are
unreferenced under `corpus/` at this pin — so a project-owned gate stays their
only validation.

Corpus scenes are the preferred validation: a feature is proven by the pinned
scenes that reach it. Author a gate only for a contract no corpus scene
exercises, and delete it once corpus scenes cover that contract.

Scenes are partitioned by the boundary required to reproduce their deterministic
reference behavior, not by incidental browser helpers. Capture-inert demo
controls and fixed-coordinate picking stay in the first lane when they can be
erased or lowered inside the compiler, asset pipeline, or renderer. A scene is
deferred when its covered behavior needs a new platform, user-input, or
external-service contract.

**Integrate first (83 scenes):** 4, 12, 16-18, 20, 22, 23, 25, 26, 36, 38, 43,
51-53, 58, 59, 64-66, 72, 73, 83, 86, 90, 91, 99, 111-115, 117, 118, 121-129,
140, 141, 144, 149, 156, 158, 165, 179, 200-207, 211, 214, 215, 217-220,
223, 226, 229, 231, 241, 250, 251, 261, 269-271, 275, 278, 279, 282, 300.
Includes static CSG/CSG2, compressed assets
and splats, deterministic picking (113-115, 117, 118, 129), and display-only
gizmos (223). The eight 1.23.0 added are all first-lane: none needs a platform,
user-input or external-service contract.

**Defer (34 scenes):** 40-42, 44-49, 100-106, 153, 164, 170-175, 180, 181, 209,
221, 222, 224, 225, 227, 228, 272.

No audited scene requires audio, touch, gamepad, AR, or VR. Add any future scene
that does to the deferred lane by default.

### Integration-first compiler contract gaps

- [ ] Scene 115: support `Number.isFinite`, then re-audit for deterministic
  picking.
- [ ] Scenes 158, 218, 269: the loader-returned-collection shapes still
  unreached. Iterating `entities` and `animationGroups`, `?? []` over one and
  `.find(pred)` with an arrow shipped with scenes 152 and 157; what remains is
  and `.find(pred)` with an arrow shipped with scenes 152 and 157; what remains is
  a collection passed to a user function (158's `requireGroup`) and `[0]`
  (218). Each is the same value travelling further than a call argument, so
  they belong together. Scene 269 is past the axis — its first blocker is
  `createTransformNode`, with 270 — as is 144, whose first blocker is
  `goToFrame`'s three-argument form, and 250's is `enableGltfCameras` alone.
- [ ] Scene 229: lower the reached spread element.
- [ ] Scene 250: support `enableGltfCameras` — the loader's `_camera` feature,
  new in 1.21. One scene, self-contained, and the only glTF camera import in
  the corpus.
- [ ] Scene 220: lower `KHR_mesh_quantization` plus `KHR_texture_transform`
  (Duck). It refuses without a source location, so a compile probe reports it
  last; it is not a compiler contract.
  `KHR_materials_pbrSpecularGlossiness` shipped with scene 11 and is the
  template: run the pinned extension at generation, project its base-workflow
  overrides, append the texture slot after the layered extensions so no index
  moves, and let the pin compose the fragment.
- [ ] Scene 282: support the Standard UV transform. The pin gates it behind
  `enableMaterialUvTransform()`, which registers `stdUvTransformExt` — the
  ninth Standard extension, and the one `pinned-standard-variants.ts` refuses
  by name. Its texture also comes from a module function the compiler must run
  at generation, which is the first blocker.
- [ ] Scene 12: fold or explicitly lower the reached browser-dependent
  condition.
- [ ] Scenes 158, 171, 174, 175, 226, 251: lower `??` over an operand that is
  not a static record property — 226 `container._gaussianSplats ?? []`, 158
  and 251 `xbot.animationGroups ?? []`. Splats, animation groups and the
  Recast lane sit behind them.
- [ ] Scene 120's SDL_GPU residual: 0.024 full / 0.071 region against Dawn's
  0.001/0.004 on the same golden, so it is entirely the backend differential.
  It is edge-weighted (edges 0.142, interior 0.028, background 0.000), which
  points at the projected footprint rather than blend accumulation. Ruled out
  by measurement: the lowered `build_splat_geometry` (checksum-identical to
  the pinned JS on the packaged asset), the splat UBO (field-for-field against
  the browser's), and DXC fast-math reassociation. Not a floor until a pinned
  line explains it.
- [ ] Extend the splat slice past scene 120's plain `.ply`. `loadSplat` also
  reaches 121 (`splatsData` + `updateData`), 124 (compressed PLY with
  spherical harmonics — the second parser plus `gaussian-splatting-pipeline-sh`
  and its 1..5 rgba32uint SH textures), 125 (a write to a splat mesh's
  `position`, with `bakeCurrentTransformIntoVertices` behind it)
  and 126 (a `GsShaderFragment` plugin spliced into the pin's own stage, which
  `applyGsFragments` mangles field names for). `loadSOG` (122) needs a ZIP and
  a WebP decoder; `loadSPZ` (123) needs gzip. 127/128 add
  `createLinearDepthMaterial`, 129 adds `.name`.
- [ ] The native render capture records no splat draw, so `scene -- diff` on a
  splat scene reports "0 draws" and its shader/uniform comparison is empty
  even though the render is correct. The draw list the capture walks is the
  render plan's; a splat is a scene renderable outside it.
- [ ] `renderer:pbr` is the feature that names the SCENE RENDER LOOP, not the
  PBR material family: `featureSources` maps it to `src/pal_sdl_gpu.cpp`, and
  `addBillboardSystem` and `loadSplat` both reach it for scenes with no PBR
  material at all. The reach is right and the name is not; renaming it to
  something like `renderer:scene` touches every manifest and every feature
  table, so it is filed rather than done inside a scene integration.
- [ ] Extend `material.diffuseTexture` past the colour render target scene
  110 measures. Three sources refuse by name: an image texture, a
  depth-only `createRenderTargetTexture` output, and a geometry task's
  attachment. `rtt.ts` forks on the attachment, giving a colour view
  `invertY: true` plus the bilinear sampler and a depth view
  `invertY: false` plus the nearest one, and the setter folds the colour
  arm; a geometry attachment is refused on ownership rather than aspect.
  The record and the loader already carry the
  image half (`base_color_texture`, filled by the `.babylon` loader), so a
  scene-code write adds that write plus the right `uv_invert_y`: false for
  `loadTexture2D`, true for the KTX2/Basis and texture-array uploads
  `pinned-standard-variants.ts` already names. Scenes 18 and 272 block here
  and each wants more besides: 18 the shadow family and `loadTexture2D`,
  272 `cloneTransformNode` and `createSolidTexture2D`. Scenes 25 and 90
  block earlier, on `loadKtxTexture2D` and on a canvas2D data URL built in
  the entry file.
- [ ] Scene 20: lower an arrow function bound to a name and used as a value.
- [ ] Scene 26: its first blocker is a non-literal string argument;
  image-processing `toneMapping` shipped with scene 87 and `AcesToneMapping`
  is one of the three records `src/pinned-tone-mapping.ts` already reads.
- [ ] Scene 36: support `loadBasisTexture2D`.
- [ ] Scenes 38, 43: support `createCylinder` and `createTube`.
- [ ] Extend the sprite path past the slice Scene 50 measures. Each item is a
  separate arm upstream keeps behind its own module or hook, and each fails
  explicitly today:
  - `spriteBlendPremultiplied` still needs scene 51's premultiplied atlas:
    `premultiplyOnLoad` decodes the image with premultiplied alpha and
    `premultipliedAlpha` marks the record, which together drive the pin's
    `_premultipliedOpacity` fade. The descriptor itself is lowered.
  - depth-hosted layers: `addDepthHostedSpriteLayer` with `depth: "test"` /
    `"test-write"` (53), which adds the 14th instance float, the depth
    attachment and the scene bind group, and composes with a `SceneContext`.
  - a `SpriteRenderer` overlaid on a scene (52) — that composition without the
    depth slot: the sprite pass appends to the scene's frame.
  - `setSprite2DCoverageGamma`, a shader permutation the pin installs
    through a lazily-registered hook, as the custom shaders do.
  - `createTexture2DFromPixels`'s `srgb` format, which picks
    `rgba8unorm-srgb` and so changes how a texel decodes rather than how it
    is sampled. The four sampler overrides shipped with scenes 283/284/301;
    no reached call passes `srgb`.
  - `updateSprite2DIndex`, `removeSprite2DIndex`, `setSprite2DFrameIndex`,
    `clearSprite2DLayer` and the Handle API: the writer is lowered for the add
    arm only; the update arm's "preserve what was not supplied" resolution needs
    the previous instance read back. The billboard writer has the same shape
    and the same gap.
  - the billboard arms past the two orientations, two depth paths and the
    custom shader that scenes 54, 55, 56, 57, 94 and 98 measure. Scene 118
    needs `marker.name`; scene 59 wants the sprite animation manager; scene
    206 is a cutout system behind large-world rendering.
- [ ] The sprite cluster past Scene 50, each its measured first blocker:
  - Scene 51: a browser-derived numeric value, with the premultiplied atlas and
    blend behind it.
  - Scene 52: `onSceneDispose`, then the HUD-over-scene composition the native
    renderers refuse.
  - Scene 53: depth-hosted layers, then `spriteBlendOpaque`.
  - Scene 58: its `PLAYER_SPRITE_URL` module constant, then sprite animation.
  - Scenes 205, 206 reach the billboard path but stop at engine options.
  - Scene 117: an unsupported constructor expression, then sprite picking.
- [ ] Extend node materials past the slice scenes 60-63, 67-71, 77-82, 84, 85,
  87, 88 and 89 measure. Each item is a block the composed graph reaches and
  this port refuses by name at generation, though a scene whose first blocker
  is elsewhere reports that instead:
  - a scene-supplied `blockLoader` (73, 83), which is the pin's bundle-size
    device: the scene passes a function mapping each block class name to a
    dynamic import of the pin's own emitter module, so `loadGraphEmitters`
    pulls only what the graph reaches. It composes the same module the default
    registry does *when* every arm maps to the pin's own emitter, and nothing
    static proves that of an arbitrary function. The shape that would: read
    the switch statically, refuse any arm whose import is not a pinned
    `material/node/blocks/*.js` emitter, and compose with exactly those.
    73 additionally wants camera viewports and a loader-returned collection.
  - `MorphTargetsBlock` (64, 66), two vertex storage bindings.
  - `ClipPlanesBlock` and `MeshAttributeExistsBlock` (86).
  - alpha blending: the graph's own `alphaMode`, which needs the transparent
    bucket and the sort.
  - a graph reached through `getSceneNNNme()` behind a gzip payload (64, 66,
    72, 73), which is a module function rather than an exported object.
  - `GeometryTextureOutputBlock` (149), the node family's geometry-MRT arm.
  - the `inputs` handles, which no reached scene writes: a scene setting one
    would need the node UBO rewritten per frame instead of folded.

- [ ] Extend the fullscreen-effect slice past scenes 74, 75 and 76. Each item
  fails by name today: a custom `vertexWGSL`, an `EffectWrapperOptions.blend`
  state, the `EffectRenderer`'s per-frame `update` callback, the per-binding
  record form of `setEffectUniforms`, an effect texture from anything but
  `createSolidTexture2D`, and the `EffectBindingLayout` fields past the five
  the corpus writes (`visibility`, `textureSampleType`, `viewDimension`,
  `samplerType` — the last three are what a cascade-array depth sampler
  needs). `unregisterEffectRenderer`, `disposeEffectRenderer` and
  `disposeEffectWrapper` are unlowered because the reached slice never
  detaches one. The whole `UniformEffectWrapper` family — the pin's smaller
  uniform-only frame-graph path — is unreached: it is `createEffectWrapper`
  with one uniform binding at zero and no texture machinery, so it would
  compose onto the same table rather than needing a second one.

- [ ] Keep a `data:` asset's payload out of the generated manifest. An asset's
  `source` is its URL, and for a data URL the URL *is* the base64 payload, so
  it rides `registerAsset`'s key, `hash(source)` and `manifest.json` verbatim
  — scene 81's manifest is 6.3 KB, nearly all of it the inline atlas, and the
  generated-tree byte diff the neutrality proof compares carries it. The
  repository already has the shape: `"generated:pinned-ibl-brdf-lut"` and the
  executed-module markers are opaque source strings only `materializeAsset`
  resolves. Registering a data URL the same way keeps the bytes in one place.
  Nothing is wrong today; it stops scaling at the first large inline texture.

- [ ] Three per-frame costs the scene-less drivers share with their siblings,
  filed together because fixing one family alone would make the tree less
  consistent rather than more. (a) `pal_sdl_gpu_sprite.cpp` and
  `pal_sdl_gpu_effect.cpp` render offscreen and blit the full screen to the
  swapchain every frame for a capture that happens at most once; gating the
  offscreen path on a requested screenshot drops a full-screen copy per frame
  and stops inflating `--benchmark`. (b) Material textures are decoded and
  uploaded per *mesh*, so two meshes sharing one material decode the same PNG
  twice at load — true of the shader, node and slot paths on both backends.
  (c) A module carrying both entry points deploys twice under two stems with
  identical bytes; SDL_GPU needs both compiles, Dawn loads only one, so the
  second file is dead weight there. The post-process family does all three.

- [ ] Carry a `ShaderMaterial`'s own `depthCompare` through lowering.
  `src/material/shader/shader-material.ts` defaults it to `"greater-equal"`
  and `shader-pipeline.ts` reads `sig._depthCompare ?? material.depthCompare`,
  so a scene naming `"less"` is the pin's one per-material opt-out from the
  convention. `ShaderVariantInfo` carries `depth_write` but no compare, and
  both PALs hardcode `pinned_depth_compare`; no corpus scene names one yet,
  so this is a contract gap rather than a measured defect.

- [ ] Build the node group-1 layout from the reflected binding table rather
  than by hand. `variantBindings` (src/pinned-pbr-variant-cpp.ts) already
  yields `{binding, name, kind, vertex, fragment}` rows from composed WGSL,
  and both `pinned_draw_layout_for` and `standard_draw_layout_for` are one
  generic walk over it with a `kind` switch; `node_draw_layout_for` is the
  only composed family still choosing `viewDimension` and `sampler.type` in
  C++. Two frictions to settle first: the reflector drops bindings 0 and 1 by
  the PBR mesh/material convention while a node `nodeU` sits at binding 1, and
  a node module is one text deployed to both stages, so a reflected row would
  widen the env pair's visibility from fragment-only to vertex|fragment. Until
  then each node capability served adds another hand-written block.

- [ ] Narrow the weighted glTF mixer's track walks to each clip's own
  range. It walks all of `rotation_tracks`/`translation_tracks`/
  `scale_tracks` once per blended clip and rejects the rest by
  `track.clip`: Xbot at two clips is ~920 track visits per frame of which
  ~790 are pure rejects, about 110 KB of cache traffic, and it grows
  linearly with attached clips. The loader appends tracks clip by clip in
  ascending order, so each clip's are one contiguous run — record
  `[first, last)` per clip beside the vectors and iterate that, keeping
  the `track.clip` test so correctness never depends on the grouping.
- [ ] Build the pinned lights block once per frame rather than once per draw.
  `pinned_lights_block` value-initializes 16 `LightEntry` (1 KB) and copies it
  into a second vector on every call; SDL_GPU calls it from all three composed
  draw paths, where the bytes are identical for every draw in a frame. Dawn
  already treats it as per-frame state in `write_pinned_frame_blocks`. The
  push has to stay per draw, but the build does not. One hoist covering all
  three families, not a per-family change.
- [ ] Scenes 65, 66, 72, 214, 215, 271: support `receiveShadows`.
- [ ] Scene 73: support camera viewports.
- [ ] Scene 86: support `setClipPlane`, then the mesh-data module function
  behind its `createMeshFromData`.
- [ ] Scene 91: support `initializeCsg2Async`.
- [ ] Scene 99: support `enableBoneControl`.
- [ ] Scene 111: support mesh IDs.
- [ ] Scene 112: resolve and lower `addDdsEnvironmentBackground`.
- [ ] Scenes 113, 129: support mesh names.
- [ ] Scene 114: resolve `createMeshFromData` through its local re-export.
- [ ] Scene 149: support the reached constructor expression.
- [ ] Scene 140: fold the reached browser-derived boolean.
- [ ] Scene 144: support `createBloomPostProcessTask`. Its chain is four
  passes over the composite machinery scene 148 shipped, but its merge is
  built by calling `createPostProcessTask` directly with an inline `_shader`,
  which the observation seam does not see: composing bloom needs that seam
  moved from the leaf entry points to `createPostProcessTask` itself, across
  the modules reachable from the composite (`src/upstream-graph.ts` already
  owns reachability). Its merge writer would then lower from `bloom.ts`'s own
  body rather than an effect module. The scene also needs `goToFrame`'s
  optional engine argument — its current first blocker — and the dragon
  asset's `KHR_materials_pbrSpecularGlossiness`.
- [ ] Scene 156: the deterministic cross-fade. Property-animation blending
  shipped with scene 155; 156 adds `crossFadeAnimationGroups` and the
  manager's `_preUpdate` weight-fade jobs
  (`src/animation/animation-weight-fade.ts`), reached through a
  `setTimeout` the browser fires by wall clock. Its own frozen branch is the
  deterministic one — it steps the manager by explicit millisecond amounts —
  and the reference harness cannot reach that branch, so integrating 156
  means giving the harness the scene's own `seekTime` query parameter and
  lowering the branch behind it, rather than lowering `setTimeout`. That
  same parameter would retire `referenceAnimationGroups`: scenes 152, 155
  and 157 each carry a frozen branch doing exactly what the harness now
  injects, so serving the query parameter would reach the scene's own
  code instead of splicing group expressions from the registry. That is
  upstream's own parity mechanism —
  `docs/lite/architecture/39-animation-parity-testing.md` gates the freeze
  behind a query param, pauses at an exact frame count and signals with
  `canvas.dataset.animationFrozen`, which is the shape this harness
  already injects — so the work is making the native side fold the same
  parameter to the measured pose rather than erasing the branch.
- [ ] Scene 158: additive poses over the weighted skeleton mixer. Measured
  chain, in order: a collection bound to a local (above), `requireGroup`
  passing it to a user function that `.find`s and throws, `group.currentTime`
  as an assignment, `setAnimationAdditive`, and the mixer's additive arm —
  `accumulateAdditiveGroup` samples each channel at the clip time and at the
  additive reference time, adds the weighted difference for translation and
  scale, and for rotation multiplies `reference^-1 * sample` onto the base
  before slerping by the weight. The seek needs one refinement with it: the
  asset seeker moves every clip that is not stopped, and 158 pins its
  additive pose with `pauseAnimation`, so a paused clip has to stay where the
  scene put it.
- [ ] Scene 165: a `createShaderMaterial` call with no `name`, then the
  viewProjection + world system-uniform pair, per-instance
  thin-instance colors (`setThinInstanceColors` plus the instance color vertex
  stream), and an explicit image-neutral lowering decision for
  `enableThinInstanceGpuCulling`.
- [ ] Extend shader-material options past the slice scenes 159-163 measure.
  `samplers` and `defines` shipped; each remaining option fails by name.
  A sampler is a bare string binding a 2D float texture the fragment reads:
  a typed `ShaderSamplerDecl` (its `sampleType`, `viewDimension: "2d-array"`
  and `comparison` each change the declared WGSL texture and sampler types),
  a sampler the vertex stage reads (SDL_GPU gives a vertex texture its own
  register space), `storageBuffers`, `blend`/`blendMode`, `transmissive`,
  `depthCompare`, `depthOnlyFragment`, `depthBias`/`depthBiasSlopeScale`,
  `useThinInstanceColors`, `stencil` and `plugins` are all unreached and
  unlowered. `setShaderMatrix`, `setShaderStorageBuffer`,
  `enableShaderMaterialUniformCaching` and `enableShaderUniformRangeUpdates`
  likewise. No corpus scene reaches any of them at this pin.
- [ ] Scenes 17, 217: extend reached PBR material options.
- [ ] Scenes 200, 201: lower the high-precision-matrix helper promise chain.
- [ ] Scenes 200-209: large-world rendering (`useHighPrecisionMatrix` +
  `useFloatingOrigin`). Read
  `docs/lite/architecture/35-large-world-rendering.md` in the pinned clone
  first — it is the specification for this entry and names the scene behind
  every bake. Accepting the two engine options is the small half; the pin
  itself throws from `createEngine` when floating origin is set without the
  high-precision matrix, so the compiler should refuse the same pair.
  Foundation: three subtractions of the active camera's world position, all in
  F64 before the single F32 store — the view matrix subtracts it before
  `R_inv * -cameraPos` (and its own upload must NOT subtract again, or the
  translation is double-biased), the mesh-world UBO subtracts it at the pack
  boundary, and `vEyePosition` becomes `cameraWorld - offset`. Each further
  scene then adds one bake: 202/203 the positional light entries, 204
  thin-instance world matrices, 205/206 the sprite and billboard anchors on
  both upload paths, 207 the shadow light-space matrix, 208 the node-material
  mesh world, 209 Havok's multi-region simulation. 200 and 201 are the same
  far-from-origin scene with the mode off and on, and their captures MUST
  diverge (the pin's own parity spec requires cross-golden MAD >= 5.0), so
  they are the pair that proves the path is engaged rather than a scene that
  merely renders.
  **What makes this bigger than those sites here**: a static primitive bakes
  its node transform into its vertices, and the generated `main.cpp` stores
  the position as a `float` literal, so at these scenes' `OFFSET` of
  5,000,000 the precision is gone before any matrix exists. The pin keeps
  vertices local and applies a world matrix per draw, which is exactly the
  model the offset subtraction assumes. Scene-code mesh emission has to stop
  baking world translation into vertices before any of the above recovers
  anything.
  Note the doc drifts from the source in one place: it describes a
  `scene._floatingOriginOffset` mirror with a per-frame
  `updateFloatingOriginOffset`, which the pinned `floating-origin.ts` says it
  deleted as net cost without value, deriving the offset live from
  `scene.camera.worldMatrix` instead. Lower from the source.
- [ ] Scene 219: recursion (`findSkinned`) carries the reported non-final
  return, and vertex-animation textures (`VatHandle`/`VatClip`) sit behind it.
- [ ] Scene 231: support `enableStandardSkeleton`; behind it sit
  `enableStandardUvOffset`, `createTexture2DFromPixels`, the skeleton subpath
  imports (`createSkeleton`, `updateSkeletonBoneMatrices`), its shared
  `scene231-skin` module, and `mesh.hasVertexAlpha`.
- [ ] Scene 241: support `isNaN`, which guards the scene's own query-parameter
  fold over `camAlpha`, `camBeta`, `camRadius`, `camTX/TY/TZ` and `camFov`.
- [ ] Scene 300 is the last node-particle scene, and its whole remaining
  chain is one mechanism plus two fixture shapes:
  - an **executed atlas URL flowing into a graph**.
    `createNpeSprite2DOrientationAtlasUrl()` draws a 128x64 atlas with
    `OffscreenCanvas` and returns a `URL.createObjectURL` blob, which the
    scene passes to `createNpeSprite2DGraph(flareUrl)` — so the graph's own
    `ParticleTextureSourceBlock` loads it. The executed-module machinery
    already bakes a drawn atlas, but only from a `data:` URL returned to the
    compiler; here the value is a graph factory ARGUMENT, and the driver has
    to call the same export so the pin loads the same image. The three parts:
    accept an executed-module call as a graph factory argument, read a blob
    URL back inside the page that made it, and join the baked asset to the
    system whose texture came from that argument.
  - `system._spriteSheet = { cellWidth, cellHeight, cellIndex, update }`
    installed after the freeze, which the bake reads for the atlas cell size
    and the per-particle frame. It is another generation-time write, beside
    the column writes `src/compiler/particle-buffer.ts` already carries.
  - `renderer._beforeUpdate.push(<closure>)`, which the scene uses only to
    publish live state through the canvas dataset.
  Its fixture is `skipParity` upstream (Babylon.js has no pure-2D renderer),
  so its golden is the Lite page like every other scene here.
- [ ] Extend the node-particle slice past what scenes 262, 263, 264, 276,
  277, 280, 281, 283, 284 and 301 measure. Each remaining item fails by name:
  - a **live** set: a registration whose per-frame step actually moves
    particles. Generation measures this rather than assuming it — the driver
    steps each registered system once more and compares every column the sync
    reads — so what refuses is a set the scene did not freeze.
  - `parseNodeParticleSetFromSnippet`, the emitter world matrix, a second
    `createParticleBillboard` or `syncParticleBillboard` on one system, and a
    flow-map build whose scene camera is not a static arc-rotate construction.
  - a node-particle texture block asking for a flipped upload
    (`invertY` on the block): the sprite atlas record carries no upload flip,
    and no reached graph sets it.
  - the pure-2D bridge's `view` layer option and the manual
    `createParticleSprite2DBridge` / `syncParticleSprite2DBridge` /
    `disposeNodeParticleSet2DBinding` entry points, none of which a corpus
    scene reaches: the two that do go through the managed registrars.
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
  affected. Reached by Scene 143, whose Sponza load hits neither.
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
  dependency/PAL boundary. First blockers: `Number(...)` as a call (40-42,
  44, 45, 47, 100, 101, 106), `HavokPhysics` (48, 102-105), a four-argument
  call (49), engine options (209), and an unresolved variable (46).
- [ ] Scenes 170-175: add Recast navigation behind an explicit dependency
  boundary. First blockers: `createNavigationPluginAsync` (170, 172, 173) and
  `??` over a non-static-record operand (171, 174, 175).
- [ ] Scene 153: add a runtime 2D-canvas boundary; its final frame is drawn
  through `CanvasRenderingContext2D`, not Babylon Lite rendering. First blocker:
  animation manager options past `engine`.
- [ ] Scenes 180, 181: add live HTML text input, sliders, pointer drag, and
  wheel handling. First blocker: reached `void` expression statements.
- [ ] Scenes 221, 222, 224: add pointer-driven gizmo picking and drag routing.
  First blockers: mesh names (221) and four-argument calls (222, 224).
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
- [ ] Test discrete and integrated adapters.

### Metal

- [ ] Build and run generated MSL on macOS.
- [ ] Validate uniform layout, derivatives, cubemaps, and blending.
- [ ] Investigate iOS after macOS is stable.

## P2 — Platform and performance

- [ ] Add touch, gamepad, and fuller keyboard mapping.
- [ ] Inventory and lower static audio playback behind an SDL audio PAL.
- [ ] Separate CPU submission, GPU execution, decode, and startup timing.
- [ ] Track executable, shader, and asset sizes consistently.
- [ ] Deduplicate resources and batch uploads before investigating meshlets,
  indirect draws, or GPU-driven culling.

## P2 — Dual render backends

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
