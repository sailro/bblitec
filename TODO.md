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

- [ ] Add namespace/default imports.
- [ ] Build a typed user-code IR from `ts.Program`/`TypeChecker` symbols.
- [ ] Add discriminated unions and numeric-literal narrowing beyond the
  checker's null analysis.
- [ ] Route inline return expressions through double precision: inlined value
  returns compile through the default float path in compound numeric contexts.
  Strip static metadata from parameter bindings that are reassigned inside an
  inlined function.
  The static lane half is done ([fidelity](docs/fidelity.md#shader-contract)).
  What remains is the RUNTIME half: a lane with no static value keeps the
  `static_cast<float>` its first sink baked into `Value.cpp`, right wherever
  that sink is the only one and wrong for the second. Closing it needs the
  width tagged on the Value rather than on the text, and a corpus
  re-measurement, since float wraps still bake into stored cpp there.
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

- [ ] Extend local classes to setters and inheritance.

## P1 — Assets and materials

### Property animation

- [ ] Support multiple direct morph targets and reusable target data. The
  corpus's five direct `createMorphTargets` calls each use one position target
  with nullable normals attached to one mesh, so no corpus gate covers the
  broader surface and the one-target fold is what the sweep supports. What the
  fold does not cover, and what a scene reaching it would force: a second
  target (the deltas buffer is laid out per target and the storage-morph path
  is already uncapped, so this is the compiler's list plus the emitted
  `attach_morph_target`), and one `MorphTargets` value attached to a second
  mesh — upstream both meshes then share ONE weights buffer, so
  `setMorphTargetWeights` moves both, where this port resolves the value to
  the single mesh it was attached to and refuses the second.

### Packed native assets

- [ ] Define a versioned native scene format with deterministic hashes.
- [ ] Prepack geometry, materials, textures, hierarchy, and animation data.
- [ ] Measure startup, runtime, and size tradeoffs.

## P1 — Runtime and validation

- [ ] Fold the hand-typed matrix-times-vector and determinant copies onto
  one emitted pair. `transform_position`/`transform_direction`
  (`native/src/pal_gpu_shared.hpp`) are term-identical to
  `transform_point_raw`/`transform_direction_raw` in
  `src/lowering/templates/gltf-loader-cpp.ts` and to `transform_point`/
  `transform_direction` in `babylon-loader-cpp.ts`, and that loader also
  hand-types `linear_determinant` where `lowerMat4Determinant3` now folds
  the pin's own `mat4Determinant3` — expanded along a different cofactor
  row, so the load-time and run-time answers to "is this mesh mirrored" do
  not even round alike. NOT a case for lowering the pin's
  `transformCoordinatesToRef`/`transformNormalToRef`: those lower to
  DOUBLE, and the reference for the vertex bake is the WGSL stage, which is
  float. What unblocks it is a decision plus a measurement: the two copies
  take a loader-local `Matrix` where the PAL's take
  `std::array<float, 16>`, so one signature has to serve three call sites
  across the generated/PAL boundary, and the byte diff over every glTF and
  `.babylon` scene is what says the fold moved nothing.

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
  and transform math. The project-owned `examples/regression-*.ts`
  gates and `parity --differential` compare whole images, not functions.
- [ ] Add backend-layout tests: nothing checks a compiled stage's `.slots`
  register layout against what the PAL binds.
  Two native-hygiene items sit here rather than in the code, each an
  all-or-nothing sweep this change has no measurement for:
  - **The `std::size_t` sentinel is spelled out about thirty times** across
    `pal_dawn.cpp`, `pal_sdl_gpu.cpp` and `pal_gpu_shared.hpp`, whose
    comments already call it npos without defining one. A `constexpr
    std::size_t npos` there retires every spelling — but converting one site
    and leaving twenty-nine is worse than the status quo, so it wants the
    whole pass.
  - **The two backends' `post_process_program` find-or-create caches are one
    shape over disjoint types**, and their keys genuinely differ (SDL's omits
    `extra_textures`, `uniform_binding` and `uniform_size`). Sharing them
    needs a find-or-create template in `pal_gpu_shared.hpp`, which today
    carries only vertex packing, decode and the variant-key resolvers.

## P1 — Developer experience

- [ ] Add portable CMake presets.
- [ ] Add `--explain-feature`. The inspection half shipped as `scene -- diff`'s
  pinned-block and shader-arm attribution plus the per-scene
  `feature-activation.json`.
- [ ] Document adding a lowerer and curated scene fixture.

## P1 — Full Babylon Lite corpus audit

85 corpus scenes remain unregistered; measured scenes
are in [status](docs/status.md). Each entry below records the **first blocker
only** — clearing it can expose another, so size a scene with the strip probe
in [debugging](docs/debugging.md#sizing-a-scene-before-writing-any-code) before
choosing a shape. Compiling clean is not integration either: scene 206 compiled
clean and measured 0.828, because the sweep answers what a scene *reaches* and
only a capture answers what it renders.

Refresh the audit by building `dist` once, then compiling each scene directly —
the command takes an unregistered path:

```bash
node dist/src/scene-command.js compile corpus/babylon-lite/lab/lite/src/lite/sceneNNN.ts
```

Read the verdict from the exit code. Grepping the output for "error" mis-scores
scenes whose refusal is worded differently.

**The corpus carries only the shared modules registered scenes import**, each
pinned in `upstream/babylon-lite-corpus.json`. Integrating a scene that imports
a new one starts by copying it out of the pinned tree and pinning its SHA-256.
A missing module is invisible in a compile probe: the compiler reports the
unresolved identifier the import would have bound, not the import.

**Rank by contracts-to-clean, not by first blocker.** A strip probe of the
leading candidates at this pin:

| Scenes | Contracts | What they are |
| --- | ---: | --- |
| 166 + 179 | 3 | `if (mesh.material)` truthiness; a closure-returning function (also blocks 20, 214, 215); the clustered-light subsystem |
| 167 | 4 | the same truthiness; `uAng` on a `loadTexture2D` texture; `enablePbrLightmap`/`setPbrLightmap`; folding a runtime `scene.meshes` walk into a compile-time material selection |
| 129 | — | `splat.name`, then `createGpuPicker`/`pickAsync` |

`if (mesh.material)` is the shared contract across 166, 167 and 179; the hook
is `Value.optionalFoundCpp`/`truthinessCpp`, which `compileBoolean` already
consults. Families by distinct scenes their calls touch anywhere in a chain:
the physics body/shape surface 7 (deferred), `createTransformNode` 6,
the navigation tile cache 4, `createUtilityLayer` 4 (deferred), the GPU picker
3 (113 and 115 also want the frame-yield-in-a-loop this runtime refuses by
design), text 3, `createTorusKnot` 3, the sprite animation manager 2 (which
also need two `_shared` modules the corpus does not carry).

### What 1.25.0 added

Three of these are the release's own new subsystems — a clustered spot field,
an opt-in PBR lightmap and a local-cubemap probe array are each a pinned
extension this port does not register at all — and 187 and 304 name whole
families that arrived with the release. Read it as a capability list.

| Scene | First blocker | Family |
| --- | --- | --- |
| 166 | `if (mesh.material)`, then scene 179's `usePhysicalLightFalloff` write | clustered spot lights |
| 167 | `enablePbrLightmap` | the opt-in PBR lightmap extension |
| 186 | `corners.flat` | opt-in PBR local cubemap blending |
| 187 | a non-literal string argument | SMAA |
| 302 | `Number.parseFloat` | node particles with a moving emitter |
| 303 | the public `createGridSpriteAtlas`, which this port reaches only as the fold inside `loadSpriteAtlas` | renderer-native Sprite2D Y-sort |
| 304 | `asset.flowGraphRuntimes` (an owner asset with no data type) | FlowGraph + glTF `KHR_interactivity` |

`186-debug` and `187-debug` are helper modules rather than scenes: they have no
`main()`, so a sweep reports them clean and neither is integrable.

**No registered scene or demo can retire the runtime-sweep gate.** Scene 267
covers its `createMeshFromData` half, Scenes 16 and 279 cover
`setThinInstances`, and Doom/Tetris exercise `removeFromScene`, but no
registered source calls `flushThinInstances` or `setThinInstanceCount`.
Corpus scenes are the preferred validation: author a project-owned gate only
for a contract no corpus scene exercises, and delete it once one does.

Scenes are partitioned by the boundary needed to reproduce their deterministic
reference behaviour, not by incidental browser helpers: capture-inert demo
controls and fixed-coordinate picking stay in the first lane when they can be
erased or lowered, and a scene is deferred when its behaviour needs a new
platform, user-input or external-service contract. No audited scene requires
audio, touch, gamepad, AR or VR; add any future one that does to the deferred
lane by default.

**Integrate first (53 scenes):** 17, 20,
51-53, 58, 59, 64, 66, 72, 73, 83, 86, 90, 91, 99, 111-115, 117, 118, 121-124,
140, 149, 156, 165, 172, 173, 179, 200, 201, 211, 214, 215, 218, 219,
223, 226, 229, 231, 241, 261, 269, 271, 275, 300.
Includes static CSG/CSG2, compressed assets
and splats, deterministic picking (113-115, 117, 118), and display-only
gizmos (223). The navigation scenes moved here
when the toolset did: 170, 171, 174 and 175 are integrated, and what 172
and 173 still
want is compiler contracts and the wrapper's tile-cache arm, not a new
platform boundary.

**Defer (27 scenes):** 41, 42, 44-49, 100-106, 153, 164, 180, 181,
209, 221, 222, 224, 225, 227, 228, 272.

- [ ] Scenes 11 and 152 share one residual: the shark's skinned pose, 0.010
  full and 0.28 foreground, identical on both backends. The composed fragment
  is byte-identical to the browser's and the pose is not a clock offset, so
  the palette is the suspect: this port conjugates the mesh world into it
  where the pin keeps that world on the draw, and both scenes carry the shark
  at a 0.01 root scale where the conjugation loses the most precision. Next
  measurement: the same asset at unit scale.

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
- [ ] Extend the splat slice past what scenes 120, 125, 126, 127, 128 and
  129 measure ([fidelity](docs/fidelity.md#gaussian-splats) carries the
  shipped contracts). What remains, each refusing by name:
  - 121: `splatsData` + `updateData` — the row buffer handed back as a
    mutable `ArrayBuffer` and re-uploaded, which also needs `new
    Float32Array(buf)` over it and an indexed element assignment.
  - 124: a compressed PLY with spherical harmonics — the pin's second
    parser plus `gaussian-splatting-pipeline-sh` and its 1..5 rgba32uint SH
    textures.
  - `loadSOG` (122) needs a ZIP and a WebP decoder; `loadSPZ` (123) needs
    gzip.
  A second `loadSplat` naming a different plugin list also refuses: the
  generated splat stages are one composed module per scene, where upstream
  keys its module cache by the plugin ids. No corpus scene loads two clouds.
  Two review findings sit here rather than in the code, each waiting on
  something a third case would settle: the named-pinned-export registry
  (module map, `has`, `names`, `load`) is written twice, in
  `src/pinned-tone-mapping.ts` and `src/pinned-splat-fragments.ts`, and a
  third such family is what would justify one generic form over two with
  distinct refusal wording; and the SDL splat pass composes a cloud's world
  matrix once in `upload_splat_pass` and again in `record_splat_pass`, which
  removing means caching it on the pass record — state whose invalidation
  nothing measures, for roughly 50ns a frame. The Dawn pair, which sat in
  one function, is hoisted.
- [ ] Extend GPU picking past what scene 129 measures
  ([features](docs/features.md#picking)). The reached slice is one
  non-detailed pick over meshes and one cloud; each remaining arm refuses by
  name:
  - `enableDetailedPicking` and `getPickedNormal` (114, 117): a third
    rgba32uint attachment, the primitive and barycentric readback, and the
    CPU position and normal arrays `detailed-picking.ts` interpolates.
  - `pickAsync`'s `filter`, `discard` and `ignore` options, which select
    `picking-advanced-pipeline.ts` and `picking-ignore.ts`.
  - a thin-instanced, VAT or morph/skeleton candidate: the first two need
    the advanced pipeline's instance-composed id, the third the deform
    projection `deform-picking-projection.ts` builds.
  - `PickingInfo.pickedPoint`, `distance` and `ray`. The pin derives the
    first two from `mat4Invert(vp)` over the sampled NDC and the depth
    attachment, which this port reads back but does not yet consume; the
    record declares neither, so a scene reading one refuses at the property
    rather than getting a zero.
  - a second cloud in one pick: the shear and the id colour are single
    buffers on Dawn, and a second would need the dynamic-offset treatment
    the mesh blocks already get. It throws from the pass rather than
    refusing at generation because no per-scene cloud count exists to
    refuse on -- `splatShaderModule` is singular and the manifest records
    fragments, not call sites.
  - a frame yield inside a hoisted continuation. `startEngine`'s
    continuation runs on the deferred queue, which `advance_frame` drains
    BEFORE the frame's uploads, so `await new Promise(rAF)` inside it is
    erased on a claim that is no longer true and both PALs compensate by
    bringing each cloud's sort current inside the pick
    ([fidelity](docs/fidelity.md#picking-contract)). The fix is for a
    yield inside a deferred body to re-queue to the next frame --
    `run_deferred_callbacks` already moves the queue out before draining,
    so the boundary exists -- which makes `firstSortReady`'s barrier
    truthful by construction and deletes both compensations, including
    Dawn's copy of the frame loop's lazy splat-pass creation.
- [ ] Collapse the rotation record onto the pin's one-lane model. Upstream
  `rotation` is an Euler PROXY over `rotationQuaternion` (`createEulerProxy`,
  `scene/scene-node.ts`), so `composeTrsLocalMatrix` reads the quaternion
  alone; `MeshRecord` and `SplatMeshRecord` carry both lanes and
  `pinned-trs.ts` picks between them
  ([fidelity](docs/fidelity.md#shader-contract)). They agree wherever a scene
  writes one lane, which is every reached scene. **Blocked on a missing
  capability**: the proxy needs `quatToEulerXYZ` folded, which nothing here
  has. Closing it also deletes that Euler arm, moving emitted bytes for every
  mesh in the corpus.

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
  - `removeSprite2DIndex`, `setSprite2DFrameIndex` and the Handle API. The
    writer now carries both arms — `updateSprite2DIndex` and
    `clearSprite2DLayer` shipped with `regression-sprite-layer-arms`, beside
    the three renderer-list entry points — so what these two still want is
    the swap-remove and its saved-size carry, not the preserve rules. The
    billboard writer keeps the add arm only and has the same shape.
  - `createSpriteAtlasFromFrames`, which doom's status bar builds its atlas
    with. **Its blocker is the data model, not the sprite path**: a
    `SpriteAtlasFrameSource` carries `pixels: Uint8Array`, and
    `src/compiler/data-types.ts` maps only `Float32Array` and `Uint32Array`
    (40 references across seven files carry the `f32array`/`u32array` pair;
    a `u8array` kind would join them). Even closed it lands no demo on its
    own: doom's call also needs `Array.map` with an inlined arrow returning a
    struct, a `Map<string, T>`, and the runtime IWAD read none of this
    repository has. `appendSpriteAtlasFrames` sits behind the same gap.
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

- [ ] Resolve SDL_GPU's shadow binding names to their composed rows once per
  variant, the way the Dawn backend already resolves the whole group once.
  Both backends bind group 2 from the same reflected rows, but SDL_GPU binds
  by NAME through the `.slots` sidecar, so `shadow_row_for` walks the
  variant's rows per binding name per stage per receiving draw
  (`shadow_resource_for` walks them twice, once for the map and once for its
  companion sampler). Scene 22's receiver declares six rows and reads eight
  shadow-named bindings, so it is ~100 string compares a frame there and
  grows as `bindings x shadow-lights x receiving draws`. The rows and the
  slot name list are both fixed per variant, so the answer belongs beside the
  slots `ensure_pinned_slots` already caches: a `vector<const
  PinnedShadowBinding*>` parallel to each stage's slot list, filled once. The
  material-slot table is asked first already, so an ordinary base-colour or
  ORM binding no longer pays for it.
- [ ] `shader_stage_block_floats` allocates a `std::vector<float>` per stage
  block per draw (`native/src/pal_gpu_shared.hpp`). Removing it needs a
  caller-owned scratch buffer threaded through both backends and the render
  capture, so it is its own change with its own neutrality proof; at the
  reached draw counts it is a few allocations a frame.
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
  (d) A sprite layer whose instance data moved re-uploads through a
  transfer buffer created and released that same frame
  (`update_buffer`, `pal_sdl_gpu_shared.hpp`), plus its own command-buffer
  submit. `updateSprite2DIndex` and `clearSprite2DLayer` are what put that
  on the per-frame path — before them the corpus only added sprites at
  setup, so the version compare held forever after frame zero. A persistent
  per-layer transfer buffer helps every sprite scene; uploading only the
  dirty span needs a destination offset on `update_buffer`, which hardcodes
  zero, and a dirty range on the record the pin already tracks
  (`_dirtyMin`/`_dirtyMax`) and this port does not.

- [ ] Share the sprite and billboard option-pair emitters. Every
  `Sprite2DProps` field travels as "a value, and whether the caller named
  it", and `sprite2DPropsCpp` now writes that pair seven times;
  `addBillboardSpriteIndex` writes the same six inline
  (`src/compiler/intrinsics/sprite.ts`). Three emitters — an optional
  float, an optional vec4, an optional bool with its default — retire both
  copies. The whole tail cannot be one helper: `BillboardSpriteProps` puts
  `pivot` between `rotation` and `color`. Worth doing when the billboard
  family grows its own update arm, which is the same two-arm shape the 2D
  writer now carries.

- [ ] Carry a `ShaderMaterial`'s own `depthCompare` through lowering.
  `src/material/shader/shader-material.ts` defaults it to `"greater-equal"`
  and `shader-pipeline.ts` reads `sig._depthCompare ?? material.depthCompare`,
  so a scene naming `"less"` is the pin's one per-material opt-out from the
  convention. `ShaderVariantInfo` carries `depth_write` but no compare, and
  both PALs hardcode `pinned_depth_compare`. One pinned factory now names
  one — `createLinearDepthMaterial` passes `"greater-equal"`, which IS the
  convention, so its lowerer checks the two agree instead of carrying the
  value; a factory or scene naming another compare refuses there. Still a
  contract gap rather than a measured defect: no corpus scene names a
  different one.

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
- [ ] Extend the shadow family past the slice scenes 4, 18 and 22 measure.
  The shipped slice is in [features](docs/features.md#shadows); the cascaded
  family (`csm-*`) is reached by no scene at this pin. Each remaining item
  fails by name:
  - a PBR caster through the ESM generator.
    `material/pbr/no-color-view.ts` is the PCF half and ships, gated by
    `regression-shadow-pbr-only`: the compose pipeline appends one caster
    view per PBR caster in the pin's scheduling order, and both PALs give
    the PBR family the shadow pass's own depth state.
    `material/pbr/esm-shadow-view.ts` is the ESM half, and no corpus scene
    casts from a PBR material through that generator, so its
    `_esmShadowDepthCode` reaches no composition here.
  - a caster view's composed arms. The view is drawn on its own caster and
    nowhere else, so it composes over that mesh's attribute set alone --
    but still over every light-mode arm the scene has, and a no-colour
    fragment is `return;` after two texture samples. On
    `regression-shadow-pbr-only` that is three stage pairs where one does
    any work; their vertex stages are byte-identical and their fragments
    differ only in dead declarations ahead of a void entry point. Deploying
    one arm's text for another arm's key would diverge from what the pin
    composes for that key, which is exactly what the `diff` report's
    shader-arm match measures, so the fix is to compose only the arms a
    caster's own draw reaches -- and nothing has measured which those are
    for a non-receiving mesh. Unblocks by measuring that.
  - the generator options past the two factories' own reached sets:
    `normalBias` and `forceRefreshEveryFrame` are unreached, and
    `setShadowCasterMaxCascade` is CSM-only.
  - a caster or receiver that is an imported mesh, and a `receiveShadows`
    the scene computes — the variant is selected at generation, so the
    second would need both fragments composed and a runtime choice.
  - **the shadow map is re-rendered every frame, and the ESM generator
    made that expensive.** Both pinned generators open with the same outer
    gate — `renderEsmShadowMap` returns before the matrix fit, the caster
    pass AND both blur passes when neither the casters' nor the light's
    version moved. This port implements only the inner one: the receiver
    UBO re-uploads solely when its 96 bytes moved, but the passes always
    run. For scene 4 with a static light and an unrotated torus that is a
    1024x1024 caster pass plus two 512x512 33-tap blurs per frame for a
    bit-identical map. The port has the version signal it needs
    (`MeshRecord::transform_version`, which the caster fold already reads
    through `shadow_caster_world`), so the gate is portable; what it needs
    beside it is a way for a frame-graph task to skip its own pass.
  - **a shadow task names its generator on `RenderTaskOptions`, where the
    pin gives the task a camera facade.** `updateShadowCameraBase` pins the
    light-space view and view-projection onto a `Camera` whose caches the
    pass reads straight back, so upstream's shadow pass is an ordinary
    camera pass; here it is a branch in each backend's task loop, beside a
    near-duplicate branch for a task with its own camera. One consumer
    makes that proportionate today; the cascaded generator, which renders
    several light-space passes per light, is where it stops being.
- [ ] Scenes 66, 72, 214, 215, 271: what each still wants beside the
  shadow generator above — 66 morph deltas behind a gzip graph, 72 an NME
  `blockLoader`, 214/215 the cascaded generator plus `createTorusKnot` and
  mulberry32 closures, 271 `unregisterScene` and a frame yield.
- [ ] Correct SDL_image's greyscale palette in the dependency rather than
  at the PAL boundary. A PNG with no `PLTE` of its own is expanded over a
  ramp SDL_image builds as `(i * 255) / ncolors` (`IMG_libpng.c`), where the
  last entry has to land on 255 — so an 8-bit grey 146 decodes as 145 and
  the ramp tops out at 254. Measured on scene 4, whose terrain sat one
  displacement step low across most of the mesh.
  `native/src/pal_sdl.cpp` corrects the ramp where the file carries no
  palette, which is the only case where the right one is derivable; the
  proper home is an overlay port beside the two `native/vcpkg-overlay-ports/sdl3`
  patches, with an upstream issue, so it self-retires by failing to apply.
  It is not there yet only because this vcpkg fetches its registry on
  demand and carries no `ports` tree to base a portfile on.
- [ ] Scenes 47, 111, 164: what each still wants now that the three shadow
  generators, the heightmap ground and the PBR receiver ship —
  47 `createCapsule` and the physics family, 111 a node receiver, and 164
  the ESM generator's remaining options.
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
- [ ] Scene 140: the ESM directional generator above, then a node material.
  Its browser-derived booleans fold for the bare reference query and its
  `ground.receiveShadows` assignment now lowers.
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
  Four of the pin's nine system uniforms also remain: `worldView`,
  `cameraPosition`, `screenSize` and `alphaCutoff`. `view` and `projection`
  shipped with `createLinearDepthMaterial` — a pass hands the block writer
  its own camera and aspect, and `build_scene_projection` answers for the
  orthographic arm — so what the four still want is a source per matrix,
  not a mechanism.
- [ ] Scene 17: extend reached PBR material options.
- [ ] Extend the material-plugin slice past what scene 217 measures
  ([fidelity](docs/fidelity.md#shader-contract) carries the shipped shape).
  Every member past `name` and `getCustomCode` refuses at the declaration, and the
  three that would cost native work are one item rather than seven:
  `getUniforms`/`writeUbo` put fields into the PBR material UBO and build the
  Standard self-managed `pluginUbo`, and `getSamplers`/`bindTextures`/
  `getActiveTextures` declare a texture and sampler pair the composed
  fragment reads — so closing them is one bind-group contract per family,
  reflected from the composed WGSL the way group 2 already is. `priority`,
  `isEnabled` and `defines` fold into the signature and need no native
  counterpart; `isEnabled` additionally needs the pin's own rebuild path,
  since the toggle is a run-time variant change. No corpus scene at this pin
  reaches any of them.
  Four review findings sit here rather than in the code, each waiting on a
  capability that does not exist yet:
  - **The plugin sweep arm composes one dead Standard variant pair on scene
    217.** Its only Standard material carries the plugin, so the unattached
    arm is unselectable — but the compiler keeps no count of Standard
    materials that took a `plugins` write against the Standard materials it
    created, which is what would prove that. The `disableLighting` arm is
    equally dead on the same scene, so the count would trim both or neither.
  - **`getCustomCode` is folded by a walker of its own** where
    `src/lowering/pinned-shader-text.ts` is already a general bounded
    evaluator for a TypeScript function returning shader text — routing
    through it would accept a template literal over a folded constant, and a
    guard written any way but the one comparison the corpus uses. It is
    bound to pinned modules by `(modulePath, symbolName)` and fails through
    `contractError`, which carries a *pinned* source location; scene code
    needs `context.fail(node, …)`. The capability is a supplied-declaration
    entry point plus an injectable failure sink.
  - **`Value.standardMaterial` should be a `materialFamily` lane.** The
    boolean now propagates through the mesh assignment and the
    `mesh.material` read beside `scenePbrMaterialIndex`, which is what
    `material.plugins` needs. What a full lane would additionally close is
    older: `enableMaterialUvTransform` and the Standard texture setters
    accept any `kind: "material"`, so a grid or shader material silently
    takes a Standard-only record write. Closing it means naming the family
    at all five creation sites and refusing on it at every Standard-only
    write.
  - **The distinct-list-to-index registry is written three times** —
    `recordStandardMaterialPlugins`, `compileNodeMaterialOptions`
    (`src/compiler/node-material.ts`) and `reachShaderProgram`
    (`src/compiler/shader-material.ts`) — and the single-statement-of-a-branch
    read five times. Neither has a shared home to call, and each copy keys
    differently, so the shared form needs a key-function parameter; it is an
    extraction across five unrelated modules rather than a call.
- [ ] Scenes 200, 201: lower the high-precision-matrix helper promise chain.
- [ ] Scenes 200, 201, 208, 209: the large-world bakes that remain.
  Read `docs/lite/architecture/35-large-world-rendering.md` in the pinned
  clone first — it is the specification for this entry and names the scene
  behind every bake. Each remaining scene adds one bake: 208 the node-material mesh world, 209 Havok's
  multi-region simulation. 200 and
  201 are the same far-from-origin scene with the mode off and on, and their
  captures MUST diverge (the pin's own parity spec requires cross-golden
  MAD >= 5.0), so they are the pair that proves the path is engaged rather
  than a scene that merely renders; their own first blocker is the
  high-precision-matrix helper promise chain, filed above.
  **The doc drifts from the source in two places, and the source decides
  both.** It describes a `scene._floatingOriginOffset` mirror with a
  per-frame `updateFloatingOriginOffset`, which the pinned
  `floating-origin.ts` says it deleted as net cost without value, deriving
  the offset live from `scene.camera.worldMatrix` instead. And it lists
  "thin-instance per-instance world matrices" among the wired bakes, which
  reads as a per-instance subtraction and is not one: `thin-instance-gpu.ts`
  uploads the stream through the precision-only `packMat4IntoF32`, never
  `packMat4IntoF32WithOffset`, so the whole subtraction stays on
  `mesh.world`. Scene 204's own source says so, and subtracting twice is what
  it warns against.
  What still blocks each of the two:
  - **208** — the node family's mesh world, which is the same
    `mesh_world_eye_relative` the other two families take; `loader:gltf` is
    the one still-refused capability a node scene is likely to reach.
  - **209** — `enableHavokFloatingOrigin`, a multi-region simulation rather
    than a render bake, behind the physics lane below.
- [ ] Scenes 218, 219: recursion (`findSkinned`) carries the reported non-final
  return, and vertex-animation textures (`VatHandle`/`VatClip`) sit behind it.
- [ ] Scene 231: support `enableStandardSkeleton`; behind it sit
  `enableStandardUvOffset`, `createTexture2DFromPixels`, the skeleton subpath
  imports (`createSkeleton`, `updateSkeletonBoneMatrices`), its shared
  `scene231-skin` module, and `mesh.hasVertexAlpha` — the one corpus scene
  that reaches vertex ALPHA at all. The pinned
  `std-vertex-color-fragment.ts` consumes `vColor.a` under that opt-in
  (output alpha, the vertex-alpha alpha test), and `rebuildSingle` derives
  `!shadowOutput && mesh.hasVertexAlpha && (hasVertexColor ||
  tiFragment._alphaBlend)` into `MATERIAL_ALPHA_BLEND | VERTEX_ALPHA` on the
  MATERIAL feature word. Composition already takes the `vertexAlpha` flag and
  `standard_variant_key` already ORs mesh-driven bits at the draw, so those
  two halves are a bit each; what is not yet there is the third — the blend
  bit moves the mesh into the transparent phase with depth writes off, and
  the port's render plan buckets a Standard draw by its material's alpha
  mode rather than by a per-mesh word.
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
- [ ] Scene 269: support `setParent`. Scene 270 ships, so the transform
  node itself, a mesh's `parent` link, `children.push`, the node's own
  ObservableVec3/Quat setters, the parent-chain world and the mirrored-mesh
  opt-in are all reached. What 269 adds is the reparent: `setParent`
  snapshots the child's world, sets the link, then writes the local TRS
  back through `mat4Decompose` (already lowered, for the splat bake) so the
  reflection in a mirrored glTF root survives, and it syncs both
  `children` arrays. Beside it sit a recursive `findNode` walk over
  `SceneNode.children` and a matrix-declared glTF node, whose
  `_localMatrix` `setParent` clears so the decomposed TRS takes over. The
  interaction to measure first is the loader's own winding pass: it rewinds
  a single-sided mirrored primitive's INDICES at load, where the
  mirrored-mesh opt-in flips the pipeline, and a mesh reaching both would
  flip twice.
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
### Deferred external and platform-feature scenes

These stay out of the first integration wave even when the audit reports an
earlier compiler error.

- [ ] Scenes 41-49, 100-106, 209: finish the physics lane. **Scene 40 is
  integrated and published** -- the first corpus physics scene, frozen at
  the pin's own `?captureFrame=120` and measured on both backends. What
  remains is one capability per scene, and none of it is shared plumbing
  any more.
  - **First blockers**, each a per-scene API rather than shared plumbing:
    a non-glTF container's entities (41);
    an aggregate `radius`/`extents` (42, 45, and both want more besides --
    `cloneTransformNode` and `applyPhysicsBodyForce`);
    a Color3 shape (44); an unresolved variable (46);
    `createGroundFromHeightMap` (47); `createPhysicsBody` (48); a
    four-argument call (49); `setPhysicsBodyCollisionEventsEnabled` (100);
    `createPhysicsShape` (101, 102); a `new Map` with no concrete type
    arguments (103); an unsupported
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
  - A physics threshold gates this port's own solver, not agreement with
    the pinned one, and cannot be driven to zero
    ([fidelity](docs/fidelity.md#physics-contract)).
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
- [ ] Scenes 172 and 173: extend the navigation slice past what scenes
  170, 171, 174 and 175 measure. The subsystem is the `navigation:recast`
  PAL over the wrapper's own pinned recastnavigation commit, and it now
  carries the solo-navmesh build over both mesh kinds, off-mesh
  connections, debug geometry, `raycast`, `getClosestPoint`, `computePath`
  and a Detour crowd a scene places, drives and reads
  ([features](docs/features.md)). What remains is each scene's own
  surface, refused by name today, measured by stripped probe at this pin
  rather than read off the first blocker.
  - **Both need the tile cache**: `maxObstacles > 0` selects the
    wrapper's `generateTileCache` build, `addBoxObstacle` /
    `addCylinderObstacle` / `removeObstacle` / `updateNavMeshObstacles`,
    and — before any of that — the obstacle wireframes both scenes draw,
    which want by-reference data arguments and static tuple indexing.
    173 additionally toggles an obstacle a second after ready, which its
    own `?freeze=1` branch never schedules.
  - Unreached by any corpus scene and unlowered: `getAgentVelocity`,
    `findClosestPointWithin`,
    `findRandomPoint`, `findRandomPointAroundCircle`,
    `setNavigationRandomSeed`, `navRayBlocked`, `disposeNavigationPlugin`,
    and `addAgent`'s `reachRadius` (which the pinned module declares and
    forwards nowhere).
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
- [ ] Finish the Web Audio slice. A prototype exists: `bblite/pal_audio.hpp`
  over LabSound with an SDL3 `lab::AudioDevice`, an `audio:engine` feature
  selecting one translation unit, and `examples/audio-probe.ts`. The contracts
  and the measured probe are in
  [fidelity](docs/fidelity.md#audio-contract).

  **No corpus scene reaches audio.** The reach is upstream's seven *game*
  demos, which use the engine for lifecycle only and then build a raw Web
  Audio graph on the context they are handed, plus the module's own Tier-4
  showcase — the one place the sound family, microphone, visualizer and unmute
  UI appear at all. So the seam is the Web Audio API rather than Babylon's
  sound API, and the raw surface those files reach is small: `createGain` (25),
  `createBufferSource` (12), `createBuffer` (7), `createBiquadFilter` (7),
  `createOscillator` (6), `createStereoPanner` (1), `decodeAudioData` (2), and
  three `AudioParam` schedulers (`setValueAtTime` 22,
  `exponentialRampToValueAtTime` 20, `linearRampToValueAtTime` 4).

  What remains:
  - **The PCM comparison gate.** The pinned engine accepts an
    `OfflineAudioContext`, so the browser half exists. Reuse upstream's shape
    rather than inventing one: `docs/lite/architecture/41-audio-engine.md`
    Tier 3 rasterizes offline PCM to a deterministic waveform PNG and diffs it
    against a committed golden, which drops onto this repository's PNG/MAD
    harness directly.
  - `decodeAudioData`, which needs an audio asset materialized at generation
    the way textures are, and a source's `loop`.
  - `setMasterVolume`/`getMasterVolume`, which need `audio-param.ts`'s ramp
    component lowered: the exp/log curve tables, the `MinRampDuration` gate,
    and `setValueCurveAtTime` reaching the PAL as a span.
  - Engine creation inside `void (async () => { try { … } catch { … } })()`,
    which needs both escaping closures and `catch`.
  - A minimal-size build: `build-sdl-min.ps1` sets `SDL_AUDIO=OFF`, so the
    pair is refused at configure. Closing it means a second trimmed-SDL root
    with audio on, and measuring LabSound (~1 MB static before dead-stripping,
    dragging libnyquist in for one encoder call) against the 2.3 MB baseline.
  - Smaller: LabSound logs at TRACE with no hook to route it, and is consumed
    by path rather than `find_package` because its `install(EXPORT)` names
    backend targets this build does not compile.

  Everything else refuses by name — the StaticSound/StreamingSound family,
  buses, spatial, stereo, the analyzer, microphone, unmute UI, visualizer and
  media-stream tap on the Babylon side; the analyser/panner/delay/convolver/
  compressor/wave-shaper factories and `setTargetAtTime` on the Web Audio side.

- [ ] Give a billboard system the F64 anchor mirror the pin keeps. A sprite's
  anchor is stored in `BillboardSystemRecord::instance_data`, a
  `std::vector<float>`, and the floating-origin bake subtracts the eye from
  that already-quantized lane -- the pin keeps a separate `_anchor`
  Float64Array for exactly this reason and says so. The sort depth should
  move onto the eye-relative anchor with it, which is where the pin computes
  it. Blocked on a measurement: scene 205's own source notes that every
  anchor it uses is a multiple of 0.5, so it is lossless in float32 and its
  0.000 proves the plumbing rather than the width. A large-world sprite scene
  with an off-grid anchor would settle it.

- [ ] Widen the remaining matrices the pin's high-precision allocator widens.
  `_setHpmAllocator` is process-global: under it the pin stores every
  `allocateMat4()` in F64, including each light's local matrix, the
  thin-instance parent world, the navmesh merge world, the shadow-caster AABB
  world and the splat world. This port widened the camera's world and a
  node's translation; the rest still compose into `std::array<float, 16>`
  unconditionally, and `MeshRecord::outer_position` is likewise still `Vec3`.
  Scene 204 is the first reached pair and it measures 0.000 on both backends,
  which bounds the thin-instance row rather than closing it: the parent world
  is composed and subtracted in double by `mesh_world_eye_relative` before the
  single float store, so the F32 `instance_parent_matrix` is only the RECORDED
  parent, and 204's is the identity. A floating-origin pool under a
  transformed parent node is what would measure the widening.
  Blocked on a measurement for the rest: no reached scene combines
  high-precision matrix with an imported light, a navmesh, a shadow or a
  splat -- `assertFloatingOriginCapabilities` refuses those pairs outright --
  so there is nothing to measure a widening against.

- [ ] Hoist the floating-origin offset out of the per-draw path. Every
  floating-origin draw calls `arc_rotate_eye_position` through
  `mesh_world_eye_relative`, which for an arc-rotate camera is four
  transcendental calls per draw per pass, where the pin reads three cached
  floats off `cam.worldMatrix`. The offset is frame-constant, and both
  backends already hoist the pass scene and lights blocks for exactly this
  reason -- the fix is one `Vec3d` threaded from beside those blocks through
  `draw_world`, replacing the `(scene, engine)` pair. Blocked on a
  measurement: no reached scene draws enough geometry under floating origin
  for the cost to show, so there is nothing to measure the change against.
  A large-world scene with a real mesh count would settle it.

- [ ] Re-key the vertex upload gate under floating origin. `transformed_vertices`
  bakes an identity transform there, so its output no longer depends on the
  mesh TRS -- but both backends still invalidate on `transform_version`, so a
  moving mesh re-runs the whole per-vertex loop and re-uploads byte-identical
  bytes every frame. Blocked on the same missing measurement: every reached
  floating-origin scene is static, so the path never fires.

- [ ] Separate CPU submission, GPU execution, decode, and startup timing.
- [ ] Track executable, shader, and asset sizes consistently.
- [ ] Deduplicate resources and batch uploads before investigating meshlets,
  indirect draws, or GPU-driven culling.
- [ ] Replace struct-name reference state and duplicated buffer/cache ownership
  with typed identity and one backend-neutral shared-resource lifecycle; measure
  compact geometry keys and binding views before changing their cache ABI.
- [ ] Extend the typed WGSL subset through the reached `const`, `fn`, and `for`
  constructs, then remove the strict raw-source fallback. Until those nodes
  exist, rejecting unsupported reflected members and canonicalizing comments is
  safer than inferring a typed layout the parser cannot represent.
- [ ] Finish the remaining mechanical compiler/runtime consolidation: move the
  mutation/escape walkers and large data-method dispatcher into their owning
  modules, share the `Map`/`Set` container shell, and give capture/draw paths one
  shader-matrix record. Add mutation-during-iteration and capture-equivalence
  tests first; those behavior guards do not exist yet.

## P2 — Dual render backends

Both backends stay long-term as mutually validating implementations;
[backends](docs/backends.md) carries the comparison and the guards.

- [ ] Extend the Dawn integration beyond Windows. The platform surface is one
  HWND branch, the adapter backend selection, and the per-OS Dawn library
  build; the WGSL feeds Dawn directly, so no per-platform shader work exists on
  this path.
- [ ] Reduce the release payload further: trim the Dawn DLL set through Dawn
  build options (a DXC-less build changes rendering, so the compiler stays),
  ship only the CRT DLLs the exe imports, and evaluate packed native assets.
