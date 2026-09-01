# bblitec TODO

Only unfinished work belongs here. What is done is in [status](docs/status.md),
the docs, and Git history. Entries state what remains and the facts needed to
act on it — not what was tried. While an audit is open, its remaining
findings live in [AUDIT.md](AUDIT.md), not here.

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
  its call site fails explicitly unless a reached API owns a specialized
  retained form; scene 300's `renderer._beforeUpdate.push` and the
  `EffectRenderer` per-frame `update` are tracked by their own entries.
- [ ] Collapse a run of adjacent EMPTY continuation parts into one counted
  re-queue. A constant-trip frame-yield loop now unrolls into one
  `defer_start_continuation` per iteration, and a body whose only statement
  is the yield leaves every one of those lambdas empty — scene 261's
  `for (let i = 0; i < 160; i++) await nextFrame()` would emit 161 nested
  shells. Two costs, and only the first is closed. The emitted whitespace
  was quadratic (115 KB at 160 boundaries, 92% of it leading spaces); the
  nesting now stops adding columns past eight levels, which is linear and
  moves no byte for any registered scene (the deepest is six). What remains
  is the DEPTH: MSVC refuses at 43 nested lambdas with
  `C1061: compiler limit: blocks nested too deeply` — bisected, 42 compiles
  — and shipping builds use MSVC, where the development default clang-cl
  accepts 320. No registered scene comes near it (scenes 113/114/115/118
  emit nine), so this is a ceiling to close before one does, not a defect
  today. The shape: a `defer_start_continuation_after(engine, k, cb)` beside
  the counted `defer_capture_until` the drain already uses, which turns 160
  shells into one call at depth two. It re-pins the module digest of scenes
  129 and 271, whose continuations already carry adjacent empty parts, so it
  is its own change with its own recapture.
  One asymmetry to settle in the same pass: `containsFrameYield` is OR-ed
  into `requiresStaticIteration` at one of that predicate's call sites, so
  the budgeted-uniform arm and the `for-of` arm still answer the pre-change
  question. That is narrow rather than wrong — a yield in a loop those two
  lower still refuses by name — but extending it widens what they accept,
  which needs the scene that first wants it to measure against.
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
  and move the baseline to it. `native/vcpkg-overlay-ports/sdl3-image` is the
  same recipe for SDL_image's greyscale-ramp defect
  (`png-grey-ramp-last-index.patch`; the drafted upstream issue is the entry
  fee for its convergence path) — it self-retires by failing to apply when a
  release carries the fix.
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
- [ ] Reclaim retired live-shadow topology state. Replacing a generator now
  removes its task from the scene and both PALs rebuild only active task draw
  lists, but the engine retains the old task, render target, generator caster
  views, and their copied `MaterialRecord` texture payloads. Reusing those
  slots requires generation-checked handles (so a retained source handle
  cannot alias a replacement) plus a GPU binding path that resolves a caster
  view's textures through `source_material` before the copied payload can be
  dropped.
- [ ] Make compiler shape probes non-emitting and symbol-aware. Native string
  dispatch currently calls `compileValue` to decide whether to inline, while
  expando-write and catch-binding scans match broad source text/property names.
  A shared probe transaction must roll back emitted lines *and* compiler state;
  owner/catch matching then needs canonical TypeScript symbols. Use that same
  lookup boundary to remove the duplicate function/alias resolver and fold the
  two loop-control subtree walks into one result.
- [ ] Normalize the source path Tint's reflection sidecar embeds. A
  `*.tint-reflection.txt` replayed from the shader cache carries the
  absolute path of whichever scene FIRST compiled that identical variant
  (scene4's names break-meshes'), so shared-variant sidecars flip with
  compile order and churn generated-tree digests. Rewrite the requesting
  path on replay, or strip it at record time.
- [ ] Add backend-layout tests: nothing checks a compiled stage's `.slots`
  register layout against what the PAL binds.
  Two native-hygiene items sit here rather than in the code:
  - **Node-only morph graphs compile the generic renderer's morph storage
    superset too**: generic mesh, background and skybox layouts need a
    second capability derived only from source/asset morphs beside
    `BBLITE_GPU_MORPH_STORAGE` (which must keep the shared zero-target
    buffers for reflected node bindings). Splitting touches both PALs'
    layouts, bind groups and draw paths; the missing guard is a
    backend-layout test (node-only graph keeps its reflected pair, generic
    group 0 stays empty) plus corpus parity on generic morph and background
    scenes.
  - **Pinned node binding reflection scans each composed WGSL variant once
    per row family** (morph, shadow, environment); consolidating onto one
    reflected binding map needs a shared reflected-row contract plus
    doctored-variant tests that retain the existing diagnostics and error
    attribution.

## P1 — Developer experience

## P1 — Full Babylon Lite corpus audit

57 corpus scenes remain unregistered; measured scenes
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


Families by distinct scenes their calls touch anywhere in a chain:
the physics body/shape surface 6 (deferred), `createTransformNode` 7,
`createUtilityLayer` 5 (223 integrates first; the rest are deferred), the GPU
picker 5 (113 and 115 also want the frame-yield-in-a-loop this runtime refuses
by design), text 3, `createTorusKnot` 3, the sprite animation manager 2 (which
also need two `_shared` modules the corpus does not carry).

### What 1.25.0 added

Three of these are the release's own new subsystems — a clustered spot field,
an opt-in PBR lightmap and a local-cubemap probe array are each a pinned
extension this port does not register at all — and 187 and 304 name whole
families that arrived with the release. Read it as a capability list.

| Scene | First blocker | Family |
| --- | --- | --- |
| 186 | `corners.flat` | opt-in PBR local cubemap blending |
| 187 | a non-literal string argument | SMAA |
| 302 | an unresolved `SCENE302_CLEAR_COLOR` from the shared module the corpus does not carry | node particles with a moving emitter |
| 303 | `enableSprite2DYSort` | renderer-native Sprite2D Y-sort |
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

**Integrate first (26 scenes):**
73, 86, 90, 91, 112-115, 118, 121-124,
140, 149, 214, 215, 218, 219,
223, 226, 231, 241, 261, 275, 300.
Includes static CSG/CSG2, compressed assets
and splats, deterministic picking (113-115, 118), and display-only
gizmos (223). Every navigation scene the corpus carries is now
integrated.

**Defer (26 scenes):** 41, 42, 44-49, 101-106, 153, 164, 180, 181,
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
  Two review findings sit here: the named-pinned-export registry (module
  map, `has`, `names`, `load`) is written twice — `src/pinned-tone-mapping.ts`
  and `src/pinned-splat-fragments.ts` — and a third such family would justify
  one generic form over the two distinct refusal wordings.
- [ ] Extend GPU picking past what scene 129 measures
  ([features](docs/features.md#picking)). The reached slice is one
  non-detailed pick over meshes and one cloud; each remaining arm refuses by
  name:
  - `enableDetailedPicking` and `getPickedNormal` (114): a third
    rgba32uint attachment, the primitive and barycentric readback, and the
    CPU position and normal arrays `detailed-picking.ts` interpolates.
  - `pickAsync`'s `filter`, `discard` and `ignore` options, which select
    `picking-advanced-pipeline.ts` and `picking-ignore.ts`.
  - a thin-instanced, VAT or morph/skeleton candidate: the first two need
    the advanced pipeline's instance-composed id, the third the deform
    projection `deform-picking-projection.ts` builds.
  - `PickingInfo.distance` and detailed picking's `ray`. Basic
    `pickedPoint` is reached: both backends consume the sampled depth and run
    the pin's inverse-VP reconstruction. The pin derives `distance` from that
    point and the camera origin; the native record does not yet declare it,
    so a scene reading it refuses at the property rather than getting a zero.
    A non-detailed pick has a null `ray` upstream and needs no native ray.
  - a second cloud in one pick: the shear and the id colour are single
    buffers on Dawn, and a second would need the dynamic-offset treatment
    the mesh blocks already get. It throws from the pass rather than
    refusing at generation because no per-scene cloud count exists to
    refuse on -- `splatShaderModule` is singular and the manifest records
    fragments, not call sites.
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

- [ ] Extend `material.diffuseTexture` past the sources scenes 18, 25, 36,
  110 and 282 measure. Two refuse by name: a depth-only
  `createRenderTargetTexture` output, and a geometry task's attachment.
  `rtt.ts` forks on the attachment, giving a colour view `invertY: true`
  plus the bilinear sampler and a depth view `invertY: false` plus the
  nearest one, and the setter folds the colour arm; a geometry attachment is
  refused on ownership rather than aspect. An image texture whose own `srgb`
  option is set refuses too: the slot's encoding is the family's, and no
  reached scene asks for the other. Scenes 90 and 272 block here and each
  wants more besides: 90 CSG and a canvas2D data URL built in the entry file,
  272 `cloneTransformNode` and `createSolidTexture2D`.
- [ ] Extend the sprite path past the slice scenes 50-53, 58 and 117 measure.
  Each item is a separate arm upstream keeps behind its own module or hook,
  and each fails explicitly today:
  - `setSprite2DCoverageGamma`, a shader permutation the pin installs
    through a lazily-registered hook, as the custom shaders do.
  - a `depth: "test"` Sprite2D layer mixed with another transparent
    renderable family. Scene 53 reaches only the fixed-order-100 `_direct`
    `test-write` arm; the generic transparent arm must join the shared
    camera-depth/order bucket rather than the current family hard slot.
  - `createTexture2DFromPixels`'s `srgb` format, which picks
    `rgba8unorm-srgb` and so changes how a texel decodes rather than how it
    is sampled. The four sampler overrides shipped with scenes 283/284/301;
    no reached call passes `srgb`.
  - the Handle API. Its index siblings are done — `removeSprite2DIndex` and
    `setSprite2DFrameIndex` shipped with the swap-remove and its id
    reindexing (scenes 58, 59) — so the handle-object form is what remains
    unreached.
  - `createSpriteAtlasFromFrames`, which doom's status bar builds its atlas
    with. It lands no demo on its own: doom's call also needs `Array.map`
    with an inlined arrow returning a struct, a `Map<string, T>`, and the
    runtime IWAD read none of this repository has.
    `appendSpriteAtlasFrames` sits behind the same gap. (The data model is
    no longer the blocker — `src/compiler/data-types.ts` carries `u8array`
    beside the `f32array`/`u32array` pair.)
  - the billboard arms past the two orientations, two depth paths and the
    custom shader that scenes 54-57, 59, 94 and 98 measure. Scene 118
    needs `marker.name`.
- [ ] Extend node materials past the slice scenes 60-72, 77-85 and
  87-89 measure. Each item is a block the composed graph reaches and
  this port refuses by name at generation, though a scene whose first blocker
  is elsewhere reports that instead:
  - `ClipPlanesBlock` and `MeshAttributeExistsBlock` (86).
  - alpha blending: the graph's own `alphaMode`, which needs the transparent
    bucket and the sort.
  - `GeometryTextureOutputBlock` (149), the node family's geometry-MRT arm.
  - the `inputs` handles, which no reached scene writes: a scene setting one
    would need the node UBO rewritten per frame instead of folded.

- [ ] Extend the fullscreen-effect slice past scenes 74, 75 and 76. Each item
  fails by name today; the refusal list is in
  [features](docs/features.md#fullscreen-effects). Of it,
  `textureSampleType`, `viewDimension` and `samplerType` are what a
  cascade-array depth sampler needs. `unregisterEffectRenderer`,
  `disposeEffectRenderer` and `disposeEffectWrapper` are unlowered because
  the reached slice never detaches one.

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

- [ ] Extend the shadow family past the slice scenes 4, 18, 22, 65, 66, 141,
  207 and 271 measure. The shipped slice is in
  [features](docs/features.md#shadows), including the CSM single-map
  adaptation Racer gates; farther cascades and cross-cascade blending are the
  omitted half. Each remaining item fails by name:
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
  - the generator options past the four factories' own reached sets:
    `normalBias` refuses on all four, and `forceRefreshEveryFrame` on the
    two PCF factories — the ESM and CSM factories honour it: it disables
    the pinned outer refresh gate, so the task re-renders every frame
    (break-meshes reaches it). `setShadowCasterMaxCascade` is CSM-only.
  - a caster or receiver that is an imported mesh, and a `receiveShadows`
    the scene computes — the variant is selected at generation, so the
    second would need both fragments composed and a runtime choice.
  - **a shadow task names its generator on `RenderTaskOptions`, where the
    pin gives the task a camera facade.** `updateShadowCameraBase` pins the
    light-space view and view-projection onto a `Camera` whose caches the
    pass reads straight back, so upstream's shadow pass is an ordinary
    camera pass; here it is a branch in each backend's task loop, beside a
    near-duplicate branch for a task with its own camera. Single-map
    generators keep that proportionate; a cascaded generator rendering
    several light-space passes per light is where it stops being.
- [ ] Scenes 214 and 215: replace the `csm-single-map-near-cascade`
  adaptation with the pin's real cascade array. `createTorusKnot` shipped and
  is byte-exact — `regression-torus-knot` is scene 214 with only the generator
  removed and measures 0.000 on both backends, while 214 measures 9.670 and
  215 measures 3.365, identically on both. The whole residual is the
  adaptation: the browser's own splits at that camera are
  `[1255.375, 2550.25, 4250.125, 10000]`, `update_csm_single_map_shadow`
  reproduces them exactly, and every ground point sits at view depth
  1334-3066, so cascade 0 holds no ground and native draws no ground shadow at
  all. Sized against the capture, five pieces:
  - **the split loop.** The body computes `p = 1/N` only; it needs the
    `prevSplit` slice and four transform/view/near-far sets. Everything else
    there (invert, corners, centroid, light-space AABB, eye, caster-Z
    tighten, ortho, texel snap, bias split) is already the pin's.
  - **a `depth32float` `texture_2d_array` map, one caster pass per cascade.**
    `ShadowGeneratorRecord` holds one `TaskHandle` and one caster matrix pair,
    and `RenderTargetOptions` carries neither a layered depth nor the pin's
    `_ownsDepthTexture: false` borrow — which both PALs must honour in
    creation *and* release, or a borrowed depth is freed twice. SDL_GPU needs
    no workaround: `SDL_GPUDepthStencilTargetInfo` carries a `layer`.
  - **the group-2 reflection.** `shadowBindingSlotOrNull` matches
    `^shadow(Tex|Samp|Comp|Info)_(\d+)$` and the composed rows are
    `csmTex_0`/`csmComp_0`/`csmInfo_0`, so every CSM row drops out and both
    PALs would build an empty layout against a shader declaring three
    bindings. `texture_depth_2d_array` also needs a fourth
    `PinnedBindingKind` (today every `texture_depth*` maps to
    `textureDepth2d`), and the info row's size is hardcoded to
    `sizeof(ShadowInfoUniforms)` — 96 bytes against the CSM block's 320 — so
    the row has to carry its own.
  - **the receiver factories.** The fragment text is the pin's, but
    `createShadowFragment` has no CSM arm: `createStdShadowFragment` and
    `createPbrShadowFragment` filter for `"csm"` slots and call
    `getCsmStdReceiverFactory()!` / `getCsmPbrReceiverFactory()!`, a non-null
    assertion on a registry the pinned generator factory populates — so an
    unpopulated one is a TypeError at compose time rather than a refusal.
    `src/compiler/intrinsics/shadow.ts` declares CSM as
    `kind: "pcf-directional"` today and flips with the same change.
  - **cross-cascade blending**, which is not deferrable here: both scenes pass
    `cascadeBlendPercentage: 0.1`.
  Still refusing by name afterwards, none reached by these two: node-material
  CSM receivers (`node-shadow.ts` has no CSM arm), `setShadowCasterMaxCascade`,
  `enableCsmStaticCache`, `getCsmReceiverTexture`/`onCsmReceiverUpdate`,
  `stabilizeCascades`, and the `worldSpaceBias` clip-offset arm.
  `docs/lite/architecture/17-cascaded-shadow.md` says PBR renderables ignore
  CSM in v1; the pin disagrees (`pbr-csm-shadow-fragment`) and scene 215 is a
  PBR receiver, so the source decides.
- [ ] Scenes 47, 164: what each still wants now that the shadow generators,
  the heightmap ground and the PBR receiver ship — 47 `createCapsule` and
  the physics family, and 164 the ESM generator's remaining options.
- [ ] Scene 73: support camera viewports, then its container flatten. The
  flatten is written as a recursive closure rather than the worklist the
  lowering proves, so it needs either a second arrangement of the same
  contracts or the walk evaluated over the document's node tree at
  generation, which would accept any pure spelling.
- [ ] Scene 86: support `setClipPlane`, then the mesh-data module function
  behind its `createMeshFromData`.
- [ ] Scene 91: support `initializeCsg2Async`.
- [ ] Scene 112: `addDdsEnvironmentBackground`, then `KHR_texture_basisu`.
  Each KTX2 image transcodes at generation as a `.basis` file already does,
  packaged as the KTX1 container the runtime reads, so the generated glTF
  loader sniffs that magic and fills `TextureData::compressed` instead of
  decoding. `uploadKtx2Texture2D` takes sRGB per call and caches by
  `index:sRGB`, so an image feeding both a base-colour and a linear slot
  transcodes twice. Its six materials share one packed `OcclusionRoughMetal`
  image, so the loader's `OffscreenCanvas` ORM composite is not reached.
- [ ] Scenes 113 and 114: past the frame-yield contract, which now unrolls
  their `waitFrames(4)`, each wants one thing already sized above — 113
  `enableDetailedPicking`/`getPickedNormal` plus the N-ary `Math.hypot` the
  hypot-spelling entry blocks, and 114 `setPbrUnlit`'s static-tint
  requirement. Both are arms of the GPU-picking entry below rather than
  scenes of their own.
- [ ] Scene 149: `break`/`continue` in the consuming loop over a container's
  mesh walk (the walk itself lowers), then the node family's
  `GeometryTextureOutputBlock`. Needs `shared/scene149-nme.ts` copied out of
  the pinned tree and pinned.
- [ ] Scene 140: the PCF directional generator's refused
  `forceRefreshEveryFrame` option (scene140.ts:73), then a node material.
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

- [ ] Extend shader-material options past the slice scenes 159-163 and 165
  measure. `samplers` and `defines` shipped, and 165's thin-instance colour
  lane ships — of `useThinInstanceColors` only the material-side `_tic`
  opt-out key still refuses. Each remaining option fails by name.
  A sampler is a bare string binding a 2D float texture the fragment reads:
  a typed `ShaderSamplerDecl` (its `sampleType`, `viewDimension: "2d-array"`
  and `comparison` each change the declared WGSL texture and sampler types),
  a sampler the vertex stage reads (SDL_GPU gives a vertex texture its own
  register space), `storageBuffers`, `blend`/`blendMode`, `transmissive`,
  `depthCompare`, `depthOnlyFragment`, `depthBias`/`depthBiasSlopeScale`,
  `stencil` and `plugins` are all unreached and
  unlowered. `setShaderMatrix`, `setShaderStorageBuffer`,
  `enableShaderMaterialUniformCaching` and `enableShaderUniformRangeUpdates`
  likewise. No corpus scene reaches any of them at this pin.
  Four of the pin's nine system uniforms also remain: `worldView`,
  `cameraPosition`, `screenSize` and `alphaCutoff`. `view` and `projection`
  shipped with `createLinearDepthMaterial` — a pass hands the block writer
  its own camera and aspect, and `build_scene_projection` answers for the
  orthographic arm — so what the four still want is a source per matrix,
  not a mechanism.
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
  Four review findings sit here, each waiting on a capability that does not
  exist yet:
  - **The plugin sweep arm composes one dead Standard variant pair on scene
    217** (its only Standard material carries the plugin). Trimming it needs
    a count of Standard materials that took a `plugins` write against those
    created, which the compiler does not keep; the `disableLighting` arm is
    equally dead there, so the count would trim both or neither.
  - **`getCustomCode` is folded by a walker of its own** where
    `src/lowering/pinned-shader-text.ts` is already a general bounded
    evaluator — routing through it would accept a template literal over a
    folded constant and any guard spelling. Missing: a supplied-declaration
    entry point plus an injectable failure sink (it is keyed by
    `(modulePath, symbolName)` and fails through `contractError`'s *pinned*
    location, where scene code needs `context.fail(node, …)`).
  - **`Value.standardMaterial` should be a `materialFamily` lane.** The
    boolean already propagates through the mesh assignment and the
    `mesh.material` read, which is what `material.plugins` needs; a full
    lane would also close the older gap where `enableMaterialUvTransform`
    and the Standard texture setters accept any `kind: "material"`, so a
    grid or shader material silently takes a Standard-only record write.
    Closing it means naming the family at all five creation sites and
    refusing at every Standard-only write.
  - **The distinct-list-to-index registry is written three times** —
    `recordStandardMaterialPlugins` (`scene-materials.ts`),
    `compileNodeMaterialOptions` (`node-material.ts`), `reachShaderProgram`
    (`shader-material.ts`) — and the single-statement-of-a-branch read five
    times; each copy keys differently, so the shared form needs a
    key-function parameter — an extraction across five unrelated modules
    rather than a call.
- [ ] Scene 209: the last large-world bake — `enableHavokFloatingOrigin`, a
  multi-region simulation rather than a render bake, behind the physics lane
  below. Read `docs/lite/architecture/35-large-world-rendering.md` in the
  pinned clone first: it is the specification for the bake, and where it
  drifts from the pinned source (the deleted `_floatingOriginOffset` mirror,
  the thin-instance stream that is precision-only, not offset-subtracting)
  the source decides.
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
- [ ] Scene 300's whole remaining chain is one mechanism plus two fixture
  shapes:
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
- [ ] Scene 261: `createTaaPostProcessTask`. Its 160-frame accumulation loop
  now unrolls, and the `: Mesh` annotation on a handle-valued declaration is
  the other half — generalizing the `handle:"texture"` exemption broke
  freeciv and platformer, so it wants the annotation carried rather than the
  exemption widened.
- [ ] Scene 275: support `loadFont`.

### Integration-first native runtime and loader gaps

- [ ] Port the pinned two-pass `.babylon` parent wiring and geometry-less
  `TransformNode` containers (`load-babylon.ts` second pass); the native loader
  skips parented and geometry-less nodes silently. No measured scene is
  affected. Reached by Scene 143, whose Sponza load hits neither.
- [ ] Lower `KHR_materials_anisotropy` from glTF assets. Scene 241 now reaches
  the loader after its query-derived `isNaN` predicates fold, and its
  AnimationPointerUVs fixture is the first corpus asset carrying the
  extension. A full asset strip also exposed the follow-on family: nine
  materials use textured `KHR_materials_diffuse_transmission`, including two
  transformed texture pairs. That is not a scalar loader addition; it needs
  the PBR2 translucency feature bits, material UBO vectors, shader/PAL
  bindings, and animation-pointer plumbing before Scene 241 is a bounded
  integration candidate.
- [ ] Extend `KHR_materials_specular` past its two factors: `specularTexture`
  and `specularColorTexture` fail explicitly at load. Scene 241 is the only
  corpus asset carrying them and is blocked earlier by its anisotropy
  extension, so the pinned
  `metallicReflectanceTexture` / `reflectanceTexture` pair — including the
  `pow(2.2)` the reflectance fragment applies to each — stays unreached.
### Deferred external and platform-feature scenes

These stay out of the first integration wave even when the audit reports an
earlier compiler error.

- [ ] Scenes 41-49, 101-106, 209: finish the physics lane. **Scenes 40 and
  100 are integrated and published** -- 40 the sphere drop and 100 the same
  drop with a registered collision event, both frozen at the pin's own
  `?captureFrame=120` and measured on both backends. What remains is one
  capability per scene, and none of it is shared plumbing any more.
  - **First blockers**, each a per-scene API rather than shared plumbing:
    a non-glTF container's entities (41);
    an aggregate `radius`/`extents` (42, 45, and both want more besides --
    `cloneTransformNode` and `applyPhysicsBodyForce`);
    a Color3 shape (44); an unresolved variable (46);
    `createGroundFromHeightMap` (47); `createPhysicsBody` (48); a
    four-argument call (49);
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

## P2 — Platform and performance

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
  - `setMasterVolume`/`getMasterVolume`, which need `audio-param.ts`'s ramp
    component lowered: the exp/log curve tables, the `MinRampDuration` gate,
    and `setValueCurveAtTime` reaching the PAL as a span.
  - Engine creation inside `void (async () => { try { … } catch { … } })()`,
    which needs both escaping closures and `catch`.
  - Smaller: LabSound is consumed
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

- [ ] Extend the typed WGSL subset through the reached `const`, `fn`, and `for`
  constructs, then remove the strict raw-source fallback. Until those nodes
  exist, rejecting unsupported reflected members and canonicalizing comments is
  safer than inferring a typed layout the parser cannot represent.
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
