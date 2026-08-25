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
- [ ] Route inline return expressions through double precision: inlined value
  returns compile through the default float path in compound numeric contexts.
  Strip static metadata from parameter bindings that are reassigned inside an
  inlined function. Same family, found by scene 175's tube: a record's number
  lanes are compiled at the default float width when the record is built, so
  a double sink consuming a lane later gets a float-truncated expression (a
  `static_cast<float>` baked into `Value.cpp`, or a static lane formatted
  `0.1f`) where the pin computes in JS doubles — ~1e-8 on the tube path, sub-
  gate but wrong-by-construction. The fix is a width model, not a call-site
  patch: keep `Value.cpp` at JS-double width (or tag the formatted width) and
  let each sink cast once, then re-measure the whole corpus — float wraps
  currently bake into stored cpp all over, so this moves bytes everywhere.
- [ ] Support off-center orthographic planes: `enableOrthographicCamera` accepts
  explicit `left`/`right`/`bottom`/`top` bounds replacing the half-extent
  derivation, and `disableOrthographicCamera` restores the perspective
  projection. The native camera record carries one extent. The orthographic
  branch lives in `build_view_projection` alone, so composing it with an
  environment skybox or ground fails at generation.

### Closures and async

- [ ] Classify escaping and non-escaping closures. A callback that escapes
  its call site fails explicitly today; every reached instance (scene 52's
  `onSceneDispose`, scene 300's `renderer._beforeUpdate.push`, the
  `EffectRenderer` per-frame `update`) is tracked by its own entry.
- [ ] Lower general render/update callbacks.
- [ ] Define ownership for escaping captures.
- [ ] Generalize immediate AOT promises and dynamic-import dispatch.

### Classes and objects

- [ ] Lower the required class/method/getter/setter/inheritance subset.

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

- [ ] Drop the vendored SDL patches once upstream ships them.
  `native/vcpkg-overlay-ports/sdl3` is the registry's own port at the manifest's
  `builtin-baseline` with two entries appended to its `PATCHES` list, selected
  by `native/vcpkg-configuration.json`.
  [libsdl-org/SDL#15838](https://github.com/libsdl-org/SDL/pull/15838) is the
  first: without it SDL refuses a multisample texture carrying a read usage and
  the SDL_GPU backend cannot run the pinned per-sample image-processing pass.
  **3.6.0 is the release to watch**; verify a candidate release by creating a 4x
  multisample texture with `SDL_GPU_TEXTUREUSAGE_GRAPHICS_STORAGE_READ` (the
  shape the per-sample pass needs) before moving the baseline.
  `d3d12-multisample-lines.patch` is the second and is **this project's own**,
  with no upstream pull request behind it yet: SDL's D3D12 backend hardcodes
  `RasterizerState.MultisampleEnable = FALSE`, which keeps a line-list on the
  aliased diamond-exit rule at any sample count, where its Vulkan and Metal
  backends rasterize lines against the target's samples and Dawn sets the flag
  from the sample count. Reported upstream as
  [libsdl-org/SDL#16182](https://github.com/libsdl-org/SDL/issues/16182) with
  [#16183](https://github.com/libsdl-org/SDL/pull/16183), so this one has a
  convergence path too; the measurement, including the A/B on two line-free
  scenes and the documentation claim it contradicts, is in
  [backends](docs/backends.md#measured-contracts).
  Delete this file and `native/vcpkg-overlay-ports` once a release carries both,
  and move the baseline to it.
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
  carries its own ~49 MB copy of `vcpkg_installed` (~140 trees, ~9 GB as of
  2026-08-24). Exactly four manifest-feature combos exist across the corpus
  (png; png+jpeg; png+webp; png+physics), so the stable shape is one shared
  install dir per combo — a single shared dir would thrash, because vcpkg
  reconciles the installed set to each configure's feature list. Fix the
  configure-lock bypass first: `serializeConfigure` wraps only the explicit
  `cmake -S` call, and when `CMakeLists.txt` or a scene's `features.cmake`
  is newer than the cache, `cmake --build` re-runs CMake itself inside the
  parallel build stage — so a change flipping a vcpkg manifest feature
  across many scenes triggers concurrent manifest installs sharing one
  download/binary cache, the documented unreliable condition. Treat that
  staleness as a cache mismatch and run the configure explicitly under the
  lock before building.
- [ ] Add `--explain-feature`. The inspection half shipped as `scene -- diff`'s
  pinned-block and shader-arm attribution plus the per-scene
  `feature-activation.json`.
- [ ] Document adding a lowerer and curated scene fixture.

## P1 — Full Babylon Lite corpus audit

106 corpus scenes remain unregistered; measured scenes are in
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

**Largest first-blocker clusters** (swept against 1.23.0 on 2026-08-23, after
scenes 25 and 36; the physics lane re-swept after the prototype below):
a folded value compared against a mutable counter 7 (all physics),
engine options beyond msaaSamples/requiredLimits 7 (large-world),
`receiveShadows` 6 (the `??` cluster is gone — the operator now lowers
over the data model, and its five scenes re-probed onto mesh names ×3,
`container._gaussianSplats`, and a group's `mask`),
PBR options beyond the reached set 3, a four-argument call 3, an unsupported
constructor expression 3, `createNavigationPluginAsync` 3.
Node materials shipped twenty of the thirty-one scenes reaching
`parseNodeMaterialFromSnippet`; of the eleven that remain, eight sit behind a
capability the reached slice refuses and three (111, 140, 141) behind blockers
unrelated to node materials.

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

Seven of the eight shipped. One remains.

| Scene | First blocker | Family |
| --- | --- | --- |
| 300 | an `OffscreenCanvas` construction in `shared/npe-sprite2d-fixture` | node particles through Sprite2D |

**No corpus scene can retire the runtime-sweep gate.** Scene 267 covers its
`createMeshFromData` half and scene 279 its `setThinInstances` half, but of
the remaining scenes reaching `setThinInstances` (16, 17, 43, 103, 165, 204,
219) or `removeFromScene` (129, 173, 271, 272) none compiles, and
`flushThinInstances` and `setThinInstanceCount` are unreferenced under
`corpus/` at this pin — so a project-owned gate stays their only validation.

Corpus scenes are the preferred validation: a feature is proven by the pinned
scenes that reach it. Author a gate only for a contract no corpus scene
exercises, and delete it once corpus scenes cover that contract.

Scenes are partitioned by the boundary required to reproduce their deterministic
reference behavior, not by incidental browser helpers. Capture-inert demo
controls and fixed-coordinate picking stay in the first lane when they can be
erased or lowered inside the compiler, asset pipeline, or renderer. A scene is
deferred when its covered behavior needs a new platform, user-input, or
external-service contract.

**Integrate first (72 scenes):** 4, 16-18, 20, 22, 38, 43,
51-53, 58, 59, 64-66, 72, 73, 83, 86, 90, 91, 99, 111-115, 117, 118, 121-129,
140, 141, 144, 149, 156, 165, 179, 200-207, 211, 214, 215, 217-219,
223, 226, 229, 231, 241, 251, 261, 269-271, 275, 300.
Includes static CSG/CSG2, compressed assets
and splats, deterministic picking (113-115, 117, 118, 129), and display-only
gizmos (223). The eight 1.23.0 added are all first-lane: none needs a platform,
user-input or external-service contract.

**Defer (32 scenes):** 41, 42, 44-49, 100-106, 153, 164, 170-174, 180, 181,
209, 221, 222, 224, 225, 227, 228, 272.

No audited scene requires audio, touch, gamepad, AR, or VR. Add any future scene
that does to the deferred lane by default. Audio's own reach is upstream's
demos rather than its scenes, which is why the Web Audio entry sits in P2
below rather than blocking a scene here.

### Integration-first compiler contract gaps

- [ ] Scene 115: lower the definite-assignment declaration
  `let resolveFrozen!: () => void`; query-derived `Number.isFinite` conditions
  now fold to the native reference environment before the selected value arm
  lowers.
- [ ] Extend `setPbrMetallicReflectance` beyond Scene 12's slice: the upstream
  `f0Factor` and `specularWeight` options still refuse explicitly.
- [ ] Extend imported hierarchy/root clones beyond Scene 12's exact slice.
  The flattened visitor accepts only an effect-free recursive assignment of a
  scene-created PBR material; order-sensitive effects and other material
  families refuse. Roots with imported light or camera descendants refuse
  rather than truncating them. Root rotation/scaling need a full
  post-deformation outer matrix; animated morph clones need shared weights
  with an independent node world; and direct mesh/other transform-node clone
  shapes remain explicitly refused.
- [ ] Scene 229: lower the reached spread element.
- [ ] Scene 250: support `enableGltfCameras` — the loader's `_camera` feature,
  new in 1.21. One scene, self-contained, and the only glTF camera import in
  the corpus.
- [ ] Extend the Standard UV transform past what scene 282 measures. The
  channel writer is lowered from the pin's own AST, so the arithmetic covers
  all seven channels, but three inputs the fold does not reach would force a
  wider shape: `material.uvOffset` (the `enableStandardUvOffset()` resolver,
  which no reached scene installs, so both components read their `?? 0` arm),
  the lightmap channel's `legacyFlipV` (the generated loader fills no lightmap
  slot, so the table folds that conjunct to false), and `rebuildMaterial`,
  which is what upstream requires to move a transform after the renderable is
  built — a scene writing one after binding refuses instead.
- [ ] Extend `setEnvironmentRotation` to textured DDS/ENV and HDR environment
  skyboxes. Scene 12's lighting-only environment now lowers, and solid-colour
  or image skyboxes are rotation-invariant or unrelated; the remaining
  textured environment skybox arms need the pin's skybox rotation patch in the
  native background shaders.
- [ ] Scene 251: lower a group's `mask` assignment (`walk.mask`), the
  glTF-animation entry's slice; its earlier `??` blockers are gone now
  that the operator lowers over the data model.
- [ ] Extend the splat slice past scene 120's plain `.ply`. `loadSplat` also
  reaches 121 (`splatsData` + `updateData`), 124 (compressed PLY with
  spherical harmonics — the second parser plus `gaussian-splatting-pipeline-sh`
  and its 1..5 rgba32uint SH textures), 125 (a write to a splat mesh's
  `position`, with `bakeCurrentTransformIntoVertices` behind it)
  and 126 (a `GsShaderFragment` plugin spliced into the pin's own stage, which
  `applyGsFragments` mangles field names for). `loadSOG` (122) needs a ZIP and
  a WebP decoder; `loadSPZ` (123) needs gzip. 127/128 add
  `createLinearDepthMaterial`, 129 adds `.name`.
- [ ] `renderer:pbr` is the feature that names the SCENE RENDER LOOP, not the
  PBR material family: `featureSources` maps it to `src/pal_sdl_gpu.cpp`, and
  `addBillboardSystem` and `loadSplat` both reach it for scenes with no PBR
  material at all. The reach is right and the name is not; renaming it to
  something like `renderer:scene` touches every manifest and every feature
  table, so it is filed rather than done inside a scene integration.
- [ ] Extend `material.diffuseTexture` past the sources scenes 110, 282, 25
  and 36 measure. Two refuse by name: a depth-only
  `createRenderTargetTexture` output, and a geometry task's attachment.
  `rtt.ts` forks on the attachment, giving a colour view `invertY: true`
  plus the bilinear sampler and a depth view `invertY: false` plus the
  nearest one, and the setter folds the colour arm; a geometry attachment is
  refused on ownership rather than aspect. An image texture whose own `srgb`
  option is set refuses too: the slot's encoding is the family's, and no
  reached scene asks for the other. Scenes 18, 90 and 272 block here and each
  wants more besides: 18 the shadow family, 90 CSG and a canvas2D data URL
  built in the entry file, 272 `cloneTransformNode` and
  `createSolidTexture2D`.
- [ ] Scene 20: lower an arrow function bound to a name and used as a value.
- [ ] Scenes 38, 43: support `createCylinder`. 43's `createTube` blocker
  cleared with scene 175's tube slice; re-probe it for the next one.
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
  - Scene 51: accept the reached explicit `msaaSamples: 1`; its browser-derived
    `1 | 4` selection now folds to `1` for the bare reference query, with the
    premultiplied atlas and blend behind it.
  - Scene 52: `onSceneDispose`, then the HUD-over-scene composition the native
    renderers refuse.
  - Scene 53: depth-hosted layers, then `spriteBlendOpaque`. Its
    before-render loop also re-reads `canvas.width`/`canvas.height` to
    detect resizes, where the compile-time fold to the configured size is
    only pose-equivalent: integrating it needs those reads, in callback
    context, lowered to the live render-target size (the engine already
    acquires it every frame; the pinned `getRenderTargetSize` is the same
    read, and no corpus scene calls it today).
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
- [ ] Scenes 65, 66, 72, 214, 215, 271: support `receiveShadows`.
- [ ] Scene 73: support camera viewports.
- [ ] Scene 86: support `setClipPlane`, then the mesh-data module function
  behind its `createMeshFromData`.
- [ ] Scene 91: support `initializeCsg2Async`.
- [ ] Scene 99: support `enableBoneControl`.
- [ ] Scene 111: support mesh IDs.
- [ ] Scene 112: `addDdsEnvironmentBackground`, then `KHR_texture_basisu`.
  Each KTX2 image transcodes at generation as a `.basis` file already does,
  packaged as the KTX1 container the runtime reads, so the generated glTF
  loader sniffs that magic and fills `TextureData::compressed` instead of
  decoding. `uploadKtx2Texture2D` takes sRGB per call and caches by
  `index:sRGB`, so an image feeding both a base-colour and a linear slot
  transcodes twice. Its six materials share one packed `OcclusionRoughMetal`
  image, so the loader's `OffscreenCanvas` ORM composite is not reached.
- [ ] Scenes 113, 129: support mesh names.
- [ ] Scene 114: resolve `createMeshFromData` through its local re-export.
- [ ] Scene 149: support the reached constructor expression.
- [ ] Scene 140: support the reached `ground.receiveShadows` assignment. Its
  browser-derived booleans now fold for the bare reference query.
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
- [ ] Scene 165: a `createShaderMaterial` call with no `name`, then the
  viewProjection + world system-uniform pair, per-instance
  thin-instance colors (`setThinInstanceColors` plus the instance color vertex
  stream), and an explicit image-neutral lowering decision for
  `enableThinInstanceGpuCulling`.
- [ ] Extend the line slice past what scenes 278 and 279 measure. The
  polylines themselves are the scene's own static literals, materialized as
  the nested data the generated flatten reads, so a system whose points are
  computed at load refuses with a source location — the pin builds its
  buffers at load and this port could too, but no reached scene needs it.
  Each remaining entry fails by name: `createLines` and the
  `createDashedLines`/`updateDashedLines` pair (whose spacing is its own
  pinned derivation over a retained dash count), `setLineMaterialColor`, a
  `LineMaterialOptions.depthCompare`, and the per-instance
  `setThinInstanceColor` twin — which is also what lets the record copy the
  colour array where the matrix pool keeps the caller's own. No corpus scene
  at this pin reaches any of them.

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
- [ ] Scenes 218, 219: recursion (`findSkinned`) carries the reported non-final
  return, and vertex-animation textures (`VatHandle`/`VatClip`) sit behind it.
- [ ] Scene 231: support `enableStandardSkeleton`; behind it sit
  `enableStandardUvOffset`, `createTexture2DFromPixels`, the skeleton subpath
  imports (`createSkeleton`, `updateSkeletonBoneMatrices`), its shared
  `scene231-skin` module, and `mesh.hasVertexAlpha`.
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

### Integration-first generation and asset packaging gaps

- [ ] Scene 211: support non-string glTF buffer URIs or reject the source
  contract earlier.

### Integration-first native runtime and loader gaps

- [ ] Port the pinned two-pass `.babylon` parent wiring and geometry-less
  `TransformNode` containers (`load-babylon.ts` second pass); the native loader
  skips parented and geometry-less nodes silently. No measured scene is
  affected. Reached by Scene 143, whose Sponza load hits neither.
- [ ] Lower `KHR_materials_anisotropy` from glTF assets. Scene 241 now reaches
  the loader after its query-derived `isNaN` predicates fold, and its
  AnimationPointerUVs fixture is the first corpus asset carrying the
  extension.
- [ ] Extend `KHR_materials_specular` past its two factors: `specularTexture`
  and `specularColorTexture` fail explicitly at load. Scene 241 is the only
  corpus asset carrying them and is blocked earlier by its anisotropy
  extension, so the pinned
  `metallicReflectanceTexture` / `reflectanceTexture` pair — including the
  `pow(2.2)` the reflectance fragment applies to each — stays unreached.
- [ ] Carry primitive topology to the pipeline for glTF points, lines, and
  line strips. `load-gltf.ts` records a `_topology` index (1=points, 2=lines,
  3=line-strip, 4=triangle-strip; LINE_LOOP and TRIANGLE_FAN unsupported) and
  `gltf-feature-primitive.ts` builds the `GPUPrimitiveState`; the generated
  loader still rejects those modes by number behind the
  `nonTrianglePrimitives` specialization flag. The *material* half shipped
  with scenes 278/279: a shader material carries the pin's own
  `_topology ?? "triangle-list"` into its pipeline on both backends
  (`ShaderVariantInfo::topology`), so what remains is the asset half — a
  loaded primitive's mode reaching the composed families, which is a
  topology suffix on the generated `RenderPipelineKind` (it already encodes
  cull mode and winding) plus WebGPU's `stripIndexFormat`. No corpus scene
  reaches it: the asset lane is unmeasured until one does.

### Deferred external and platform-feature scenes

These stay out of the first integration wave even when the audit reports an
earlier compiler error.

- [ ] Scenes 41-49, 100-106, 209: finish the physics lane. **Scene 40 is
  integrated and published** -- the first corpus physics scene, frozen at
  the pin's own `?captureFrame=120` and measured on both backends. What
  remains is one capability per scene, and none of it is shared plumbing
  any more.
  - **What the lane no longer stops on.** The freeze (`stopEngine`, the
    zero-delay `setTimeout`, a checker-narrowed nullable) is lowered
    ([fidelity](docs/fidelity.md#physics-contract)); every remaining blocker
    below is a per-scene API.
  - **First blockers, re-swept after that landed** -- each is now a scene
    API rather than capture plumbing: a non-glTF container's entities (41);
    an aggregate `radius`/`extents` (42, 45, and both want more besides --
    `cloneTransformNode` and `applyPhysicsBodyForce`); `createTube` (43);
    a Color3 shape (44); an unresolved variable (46);
    `createGroundFromHeightMap` (47); `createPhysicsBody` (48); a
    four-argument call (49); `setPhysicsBodyCollisionEventsEnabled` (100);
    `createPhysicsShape` (101, 102); `mesh.pickable` (103); an unsupported
    constructor expression (104, 105); `PhysicsMotionType` read as a value
    into an array (106); and engine options (209, behind large-world
    rendering).
  - **Extend the aggregate options past the three that are lowered.** The
    pin's own `_buildShapeParams` resolves `radius`, `extents`, `center`,
    `pointA` and `pointB` as explicit overrides of the bounds-derived
    value, each through the same `??` the lowered ones use. Swept across
    the corpus: `mass` 18, `extents` 7, `restitution` 6, `radius` 4,
    `friction` 4, `pointA`/`pointB`/`center` 1 each. Adding them is small
    and faithful, and lands no scene on its own, which is why it is filed
    rather than done -- every scene that passes one also wants something
    else.
  - **What a physics scene's threshold can and cannot mean.** Scene 40
    measures 0.332/0.777 against the Havok golden, and that number is the
    distance between two SOLVERS, not between this port and Babylon Lite
    ([fidelity](docs/fidelity.md#physics-contract)). It cannot be driven to
    zero. Worth knowing: Babylon Native faces the same problem -- it links
    Ammo, which is Bullet compiled to WebAssembly -- and answers it by
    generating its reference images from its own renderer and comparing
    with a per-channel tolerance of 25 plus an allowed percentage of
    differing pixels. That is a regression gate against itself rather than
    a fidelity gate, and it is the alternative if the published browser
    golden ever proves more misleading than useful here.
  - **Bullet's own gaps before this is more than a prototype**: the
    `double-precision` vcpkg feature is unevaluated (the transform chain
    around it is double, the solver is float), and nothing yet measures a
    stack or a constrained body, where the two solvers' convergence
    differs most.
  - **Beyond the reached slice**, each refusing by name: mesh and
    convex-hull shapes (the pin's own `MeshAccumulator`), container shapes,
    the `startAsleep` and `isTriggerShape` options, `disposePhysics`, and
    every body control past creation (impulse, velocity, motion-type
    switching, teleport). A capsule or cylinder whose segment is not
    Y-aligned refuses in the PAL rather than standing upright.
- [ ] Scenes 170-174: extend the navigation slice past what scene 175
  measures. The subsystem shipped with 175 — the `navigation:recast` PAL
  over the wrapper's own pinned recastnavigation commit, the solo-navmesh
  build, debug geometry, and `raycast` ([features](docs/features.md)) — so
  what remains is each scene's own surface, refused by name today: crowds
  and agents, `computePath`, `getClosestPointToMesh`, off-mesh connections,
  tiled meshes and the tile cache with obstacles.
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
- [ ] Finish the Web Audio slice. A working prototype is on this branch:
  `bblite/pal_audio.hpp` over LabSound with an SDL3 `lab::AudioDevice`
  (`native/src/pal_audio_sdl_device.hpp`), an `audio:engine` runtime feature
  selecting one translation unit, and `examples/audio-probe.ts` compiling to a
  scene that opens a device and plays a scheduled triad. The contracts are in
  [fidelity](docs/fidelity.md#audio-contract); the adaptation is recorded as
  `substituted-audio-engine`. **The corpus reaches none of it**: no `sceneNNN`
  scene uses audio at all. The reach, swept over the whole pinned tree for all
  38 exported audio symbols, is nine files: upstream's seven *game* demos
  (tetris, quake, doom, minecraft, platformer, racer, sandblox), which use the
  engine for lifecycle only; `lab/lite/src/demos/audio-demo.ts`, the module's
  own Tier-4 showcase, which is the one place `createSoundAsync`/`playSound`,
  the microphone, the visualizer and the unmute UI are reached at all; and
  `packages/babylon-lite-compat/src/audio/`, a Babylon.js-classic-shaped
  wrapper in a separate package no corpus scene imports (out of scope here,
  recorded so the next sweep does not rediscover it).
  - **The seam is the pin's own, and it is the Web Audio API rather than
    Babylon's sound API.** Every *game* demo uses the Lite engine for
    lifecycle only -- `createAudioEngineAsync`, `engine.audioContext`,
    `createSoundSourceAsync`, `unlockAudioEngineAsync` -- then builds its own
    raw graph on the context. Only the module's own showcase reaches the sound
    family, which is what makes refusing it the right call rather than a gap. The whole raw surface those eight files reach is
    small: `createGain` (25), `createBufferSource` (12), `createBuffer` (7),
    `createBiquadFilter` (7), `createOscillator` (6), `createStereoPanner` (1),
    `decodeAudioData` (2), and three `AudioParam` schedulers
    (`setValueAtTime` 22, `exponentialRampToValueAtTime` 20,
    `linearRampToValueAtTime` 4).
  - **What is measured**: `BBLITE_AUDIO_CAPTURE` renders the scene's graph
    offline at the end of `run_engine` and writes 32-bit float WAV from the
    same bus the reported peak/RMS is measured on. `examples/audio-probe.ts`
    gives 48000 frames at 48 kHz, peak 0.032524, RMS 0.004254, byte-identical
    across runs, per-100 ms RMS rising monotonically as its own
    `exponentialRampToValueAtTime` says. The pinned engine accepts an
    `OfflineAudioContext` for the same reason, so the browser half of a PCM
    comparison exists -- **that comparison is the gate this slice still
    lacks**, and it is the next thing worth building. Upstream has already
    built the picture-shaped version of it and this port should reuse the
    shape rather than invent one: `docs/lite/architecture/41-audio-engine.md`
    Tier 3 rasterizes the offline PCM to a deterministic waveform PNG and
    diffs it against a committed golden
    (`tests/lite/audio/visual/waveform-golden.test.ts`, a pngjs rasterizer,
    thick band, position-tolerant within 2 px, goldens under
    `reference/lite/audio/<case>.png`). That drops onto this repository's
    existing PNG/MAD harness directly.
  - **The next capability is the buffer family.** `createBuffer`,
    `getChannelData`, a source's `buffer` and `loop` all refuse by name, and
    the PAL declares none of them, because the blocker is one thing: the
    plain-data model has no borrowed float span, so a scene cannot write
    samples into PAL-owned memory. Every demo that plays a recorded sound
    needs it. `decodeAudioData` needs a second thing besides -- an audio
    asset materialized at generation, the way textures are.
  - **`setMasterVolume` and `getMasterVolume` refuse**, and closing that means
    lowering `audio-param.ts`'s ramp component: the exp/log curve tables, the
    `MinRampDuration` gate, and `setValueCurveAtTime` reaching the PAL as a
    span. The PAL entry point is deliberately absent until then rather than
    declared and unused.
  - **Everything else refuses by name**: the whole StaticSound/StreamingSound
    family, buses, spatial, stereo, the analyzer, the microphone, the unmute
    UI, the visualizer and the media-stream tap on the Babylon side; the
    analyser/panner/delay/convolver/compressor/wave-shaper factories and
    `setTargetAtTime` on the Web Audio side.
  - **The two blockers that keep the demos out of reach**, both language rather
    than audio: `sound.ts` in every demo dispatches effects through a
    string-literal `switch` (still unlowered, P1 above) and creates its engine
    inside `void (async () => { try { ... } catch { ... } })()`, which needs
    both escaping closures and `catch`. Sizing an audio demo means sizing those
    first.
  - **Still open, smaller**: LabSound logs at TRACE to stdout with no hook to
    route it; `libnyquist` is fetched by LabSound's own CMake at `GIT_TAG
    master`, so `tools/build-labsound.ps1` pins the commit itself and passes it
    back through `LIBNYQUIST_SOURCE_DIR`; and LabSound is consumed by path
    rather than through `find_package`, because its `install(EXPORT)` names
    every backend target including the two this build does not compile.
  - **Neutrality, measured**: with the change applied, `compile all` moves
    exactly 438 generated files -- `build-inputs.json`, `build_stamp.hpp` and
    `feature-activation.json`, one of each per registered scene, and nothing
    else. The first two are the tracked-native-source digest, which any new PAL
    translation unit moves by construction; the third gains the `audio:engine`
    row every scene's inventory lists whether or not it reaches it. No
    generated C++, shader, manifest or fidelity record moved. The stamp moving
    does mean every scene's binary needs rebuilding before its parity number is
    trustworthy again, so `npm run scenes:parity` is owed before this pushes.

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
