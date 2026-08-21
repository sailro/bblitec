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
- [ ] glTF animation: STEP channels, and a group's speed ratio, weight and
  mask.
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
- [ ] Add generation-checked handles and resource lifetime/leak checks.
- [ ] Add dirty flags and incremental GPU updates.
- [ ] Add device-loss and resize-safe resource recreation.
- [ ] Add multiple registered scenes and scene switching.
- [ ] Add headless renderer tests.
- [ ] Add differential tests for camera, environment, material, and transform
  functions.
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

130 corpus scenes remain unregistered; measured scenes are in
[status](docs/status.md). No unregistered scene compiles clean — the
compiler-contract lane gates the rest. Each entry records the first blocker
only; clearing it can expose another.

Refresh the audit by building `dist` once, then compiling each scene directly:
`node dist/src/scene-command.js compile corpus/babylon-lite/lab/lite/src/lite/sceneNNN.ts`.
The command accepts an unregistered path.

**The corpus carries only the shared modules registered scenes import**,
each pinned in `upstream/babylon-lite-scenes.json`. Integrating a scene that
imports one starts by copying it out of the pinned upstream tree and pinning
its SHA-256 beside the scenes. The thirteen shipped node-material graphs are
already there; the remaining node-material, node-particle and skin modules are
not — and a missing module is invisible in a compile probe, because the
compiler reports the unresolved identifier the import would have bound rather
than the import.

**Largest first-blocker clusters** (swept against 1.23.0 on 2026-08-21):
browser-dependent condition 17 (15 of them deferred-lane physics), engine
options beyond msaaSamples/requiredLimits 7, `parseNodeParticleSource` 7,
`receiveShadows` 6, `??` over a non-static-record operand 5, `loadSplat` 5,
Standard image diffuse textures 5 (18, 25, 90, 91, 272), mesh name/id setters
4 (111, 113, 129, 221), `createNavigationPluginAsync` 3. Node materials
shipped thirteen of their twenty-two; each of the nine that remain sits behind
a capability the reached slice refuses.

- [ ] Scene 11's residual is a skinned pose, not its material: the composed
  fragment is byte-identical to the browser's and `scene -- diff` names two
  bone-palette matrices the browser never uploaded, at every seek tried. The
  foreground sits at 0.282 against 0.010 full. Sizing that is the animated-
  skinning determinism axis, which also gates any other skinned glTF.

**Rank by the whole family, not by the first blocker.** Node particles reach
*eleven* scenes once the ones behind a shared-module import are counted (262,
263, 264, 276, 277, 280, 281, 283, 284, 300, 301) — the largest axis after node
materials, and the only one 1.23 grew. Two of those (300, 301) go through the
new NPE-to-Sprite2D bridge, which lands on the sprite path this repository
already owns rather than on a new renderer.

### The eight scenes 1.23.0 added

Audited 2026-08-20 by compile probe. Six import a `shared/` module the corpus
does not carry, so each starts with the same corpus sync the node-material
cluster needs: copy the module out of the pinned tree and pin its SHA-256.

| Scene | First blocker | Family |
| --- | --- | --- |
| 220 | `KHR_mesh_quantization` on Duck.glb | glTF extension, with 11's spec-gloss |
| 250 | `enableGltfCameras` | glTF camera import, new in 1.21 |
| 281 | `parseNodeParticleSource` (+ `shared/scene281-npe`) | node particles |
| 282 | texture pixels from a module function (+ `shared/scene282-standard-uv-transform`) | Standard UV transform |
| 283 | `shared/scene283-npe-multiply-blend` | node particles |
| 284 | `shared/scene284-npe-multiply-add-blend` | node particles |
| 300 | `shared/npe-sprite2d-fixture` | node particles through Sprite2D |
| 301 | `buildNodeParticleSet` (+ `shared/scene283-npe-multiply-blend`) | node particles through Sprite2D |

Scene 282 is the only corpus scene reaching `stdUvTransformExt`, the ninth
Standard extension 1.21 added. `pinned-standard-variants.ts` refuses a material
carrying one by name, so that refusal is what integrating 282 has to lift.

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

**Integrate first (96 scenes):** 4, 12, 16-18, 20, 22, 23, 25, 26, 36, 38, 43,
51-53, 58, 59, 64-66, 72, 73, 83, 86, 90, 91, 99, 111-115, 117, 118, 121-129,
140, 141, 144, 149, 152, 155-158, 165, 179, 200-207, 211, 214, 215, 217-220,
223, 226, 229, 231, 241, 250, 251, 261-264, 269-271, 275-284, 300,
301. Includes static CSG/CSG2, compressed assets
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
- [ ] Scenes 144, 152, 157, 158, 179, 218, 250: address a loader-returned
  collection. One compiler contract covering every shape the corpus uses:
  `for..of` over `entities`/`animationGroups`/`children`, `?? []` over one,
  `.find(pred)` with an arrow, and `[0]`. Scene 21's axis, not an array shape,
  and the largest that is a language contract rather than a subsystem.

  It unblocks seven first blockers and finishes none alone — a strip probe of
  152 lands next on `createAnimationManager({ engine })` and
  `addAnimationGroups`, which no intrinsic carries; 144 wants
  `KHR_materials_pbrSpecularGlossiness`, which scene 11 already ships; 250
  wants `enableGltfCameras` and a browser-derived seek. Size the animation-manager family before committing to
  it as the finisher for 152/157/158.
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
- [ ] Scenes 12, 43: fold or explicitly lower the reached browser-dependent
  conditions.
- [ ] Scenes 171, 174, 175, 226, 251: lower `??` over an operand that is not a
  static record property — 226 `container._gaussianSplats ?? []`, 251
  `xbot.animationGroups ?? []`. Splats, animation groups and the Recast lane sit
  behind them.
- [ ] Scene 120's SDL_GPU residual: 0.024 full / 0.071 region, all of it the
  backend differential (SDL_GPU-vs-Dawn 0.024, max 2, within1 99.97%), where
  Dawn measures 0.001/0.004 against the same golden. Eliminated by
  measurement: the lowered `build_splat_geometry` is bit-identical to the
  pinned JS on the packaged asset (all five payloads and both bounds, checked
  by checksum); the browser's own 224-byte splat UBO matches ours field for
  field (`scene -- uniforms scene120 --size 224`); and recompiling the vertex
  stage with DXC `-Gis` moves it by 0.0002, so it is not fast-math
  reassociation. The residual is edge-weighted (edges 0.142, interior 0.028,
  background 0.000), which points at the projected footprint rather than blend
  accumulation. Not a floor until a pinned line explains it.
- [ ] Extend the splat slice past scene 120's plain `.ply`. `loadSplat` also
  reaches 121 (`splatsData` + `updateData`), 124 (compressed PLY with
  spherical harmonics — the second parser plus `gaussian-splatting-pipeline-sh`
  and its 1..5 rgba32uint SH textures), 125 (`bakeCurrentTransformIntoVertices`)
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
  `pinned-standard-variants.ts` already names. Scenes 18, 25, 90 and 272
  sit behind it and each wants more besides: 18 the shadow family and
  `loadTexture2D`, 25 `loadKtxTexture2D` and `uvScale`, 90 `alphaCutOff`
  plus a static-array loop and a canvas2D data URL built in the entry file,
  272 `cloneTransformNode` and `createSolidTexture2D`.
- [ ] Scene 20: lower an arrow function bound to a name and used as a value.
- [ ] Scene 26: its first blocker is a non-literal string argument;
  image-processing `toneMapping` shipped with scene 87 and `AcesToneMapping`
  is one of the three records `src/pinned-tone-mapping.ts` already reads.
- [ ] Scene 36: support `loadBasisTexture2D`.
- [ ] Scene 38: support `createCylinder`.
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
  - `createTexture2DFromPixels` past its defaults: the `srgb` format and
    the sampler overrides refuse, because no reached call passes options.
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
  - Scene 53: `spriteBlendOpaque`, then depth-hosted layers.
  - Scene 58: its `PLAYER_SPRITE_URL` module constant, then sprite animation.
  - Scenes 205, 206 reach the billboard path but stop at engine options.
  - Scene 117: an unsupported constructor expression, then sprite picking.
  - Scenes 205, 206: engine options.
- [ ] Extend node materials past the slice scenes 60, 61, 63, 67-71, 77-80,
  82, 84, 85, 88 and 89 measure. Each item is a block the composed graph reaches
  and this port refuses by name at generation, so a scene's own error says
  which:
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
  - `ClipPlanesBlock` and `MeshAttributeExistsBlock` (86, which also wants
    `setClipPlane`).
  - alpha blending: the graph's own `alphaMode`, which needs the transparent
    bucket and the sort.
  - a graph reached through `getSceneNNNme()` behind a gzip payload (66, 72,
    73), which is a module function rather than an exported object.
  - `GeometryTextureOutputBlock` (149), the node family's geometry-MRT arm.
  - `MeshAttributeExistsBlock` and `ClipPlanesBlock` (86, which also wants
    `setClipPlane` and a mesh-data module function behind
    `createMeshFromData`).
  - the `inputs` handles, which no reached scene writes: a scene setting one
    would need the node UBO rewritten per frame instead of folded.
  - shadows (65, 66, 72), which are not a node-material contract.

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

- [ ] Build the pinned lights block once per frame rather than once per draw.
  `pinned_lights_block` value-initializes 16 `LightEntry` (1 KB) and copies it
  into a second vector on every call; SDL_GPU calls it from all three composed
  draw paths, where the bytes are identical for every draw in a frame. Dawn
  already treats it as per-frame state in `write_pinned_frame_blocks`. The
  push has to stay per draw, but the build does not. One hoist covering all
  three families, not a per-family change.
- [ ] Scenes 66, 72, 214, 215, 271: support `receiveShadows`.
- [ ] Scene 73: support camera viewports.
- [ ] Scene 75: support the `SCENE_CLEAR_COLOR` shader binding.
- [ ] Scene 86: support `setClipPlane`.
- [ ] Scene 91: support `initializeCsg2Async`.
- [ ] Scene 99: support `enableBoneControl`.
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
- [ ] Scene 144: support `createBloomPostProcessTask`. Its chain is four
  passes over the composite machinery scene 148 shipped, but its merge is
  built by calling `createPostProcessTask` directly with an inline `_shader`,
  which the observation seam does not see: composing bloom needs that seam
  moved from the leaf entry points to `createPostProcessTask` itself, across
  the modules reachable from the composite (`src/upstream-graph.ts` already
  owns reachability). Its merge writer would then lower from `bloom.ts`'s own
  body rather than an effect module. The scene also needs one animation group
  addressed by name (`.find` over a loader collection), `goToFrame`'s optional
  engine argument, and the dragon asset's `KHR_materials_pbrSpecularGlossiness`.
- [ ] Scenes 155, 156: support property-animation blending.
- [ ] Scene 165: the viewProjection + world system-uniform pair, per-instance
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

## P2 — Shader deployment conventions

- [ ] Publish each deployed stage's entry point instead of matching its file
  name. `tools/compile-shaders.ps1` picks the entry point and the register
  convention from three filename prefixes — `variant-`, `postprocess-`,
  `node-` — plus a fourth flag carved out of the first, so the deployment
  convention is encoded twice in two languages and a rename compiles a stage
  at the wrong entry point with no error. Generation already writes
  `upstream/shaders/composition.json` and nothing reads it: add each row's
  entry points and whether it is pin-composed, have the script look the file
  up there, and keep `mainVertex`/`mainFragment` as the fallback for the
  stages this repository authors. Both prefix ladders then delete.

## Documentation maintenance

- [ ] Keep status metrics and the README comparison image synchronized with
  validated results.
- [ ] Update development and repository instructions when build workflows or
  recurring pitfalls change.
- [ ] Keep this file free of history: no completed items, no investigation
  narrative, no before/after measurements.
