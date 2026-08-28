# Fidelity strategy

Parity can fail in two independent layers:

1. TypeScript/Babylon semantics are lowered incorrectly.
2. Correct Babylon shader semantics diverge on a native GPU backend.

`bblitec` records both instead of treating the final screenshot as a single
opaque score.

## Semantic contract

Generated scenes contain:

| Artifact | Purpose |
| --- | --- |
| `manifest.json` | reached features, sources, assets, adaptations |
| `fidelity.json` | intentional source-to-native semantic differences |
| `upstream/provenance.json` | pinned upstream modules and symbols |
| `upstream/feature-activation.json` | every activation unit across all mechanisms, its reaching call site or asset, and the pinned module it mirrors |
| `upstream/shaders/composition.json` | the composed pinned shader modules deployed with the scene |
| `upstream/renderer-fidelity.json` | shader bindings, formats, formulas, invariants |
| `upstream/shaders/shader-material-reflection.json` | reached custom WGSL entry points, interfaces, and uniform layouts |
| `upstream/shaders/*.wgsl` | reached custom material source before typed IR lowering |
| `upstream/shaders/*.native.wgsl` | the deployed stages passed to Tint: custom and generated WGSL specialized for SDL bindings, locations, and depth; pinned composed variants unchanged in the pin's own scheme |
| `upstream/shaders/*.tint-reflection.txt` | Tint entry-point resource bindings checked against native WGSL |
| `upstream/shaders/shader-compiler.json` | selected offline target and participating compiler hashes |

Current intentional adaptations include browser-wrapper erasure, immediate AOT
`await`, compile-time asset materialization (drawn sprite atlases, HDR
cubemaps and transcoded Basis textures included), the SDL platform boundary,
the native shader backends,
and four-influence skinning for an asset carrying `JOINTS_1`/`WEIGHTS_1`
(`four-influence-skinning`: the pinned loader skins eight influences, the
generated loader keeps the first pair and drops the tail weights). Scenes
reaching the plain-data language slice add
the value-copy object model (`plain-data-value-model`: a const local bound to
a container element or member binds a native reference and is poisoned by a
later structural mutation of that container; mutable path-bound locals stay
copies that reject writes; object parameters pass by native reference; sparse
arrays zero-initialize) and the pinned seeded `Math.random`
(`deterministic-seeded-random`: mulberry32 over seed 1 on both the native
runtime and the browser reference capture).

New high-risk adaptations require an explicit record and a focused test.

The recorded set is semantic *divergences* only. Compile-time folds that are
bit-identical by construction — the DDS harmonics projected by the pin's own
`computeSH`, Draco and meshopt decoded by the pin's own decoder builds, the
quantized and sparse accessors rewritten by the pin's own `preParse` hooks —
are deliberately not recorded per scene, because the browser and the native
build read the same bytes. Two freezes sit at the boundary and are stated
here instead of per scene: the composed variant set is closed at generation
(upstream can rebuild a material's shader at run time; a run-time material
change that needs an uncomposed variant refuses), and an asset carrying more
punctual light nodes than the pinned `MAX_LIGHTS` refuses at generation
where upstream would grow the constant.

Curated Babylon Lite inputs are byte-identical, SHA-256-checked snapshots from
the pinned source commit. Never edit, flatten, normalize, or replace them.
Thresholds and goldens are equally immutable during ordinary fixes. Add a
scene or recapture a reference only as an explicit pinned-scene operation.

Upstream's own parity history is supporting evidence for numbered scenes,
which were built as Lite-versus-Babylon Legacy differential tests. Review the
scene pair, introduction PR, review discussion, and pre-pin follow-up fixes
during integration. Upstream MAD floors and root-cause notes help classify
native residuals, but generated behavior must still be derived from the pinned
source rather than copied from an upstream workaround.

## Shader contract

Generated shaders preserve upstream markers for:

- GGX distribution and Smith geometry
- BRDF LUT energy conservation
- environment mip selection and RGBD decoding
- RGBE parsing, HDR cubemap projection, and infinite-distance skybox sampling
- SH irradiance
- exposure, tone mapping, gamma, and contrast
- depth, culling, blending, and multisample state
- GridMaterial object-space derivatives, major/minor lines, hard/cosine line
  paths, max-line composition, and transparent opacity

### Where a shader comes from

Nothing here transcribes a formula. Each family names where its text is
composed and which scene gates it; [status](status.md) carries the numbers.

| Family | Origin | Gate |
| --- | --- | --- |
| PBR colour and geometry variants | the pin's own composer, one fragment per renderable feature set | the whole corpus |
| Standard variants | the same composer, `variant-std-*` | 145, 273 |
| Shared material vertex stage | generated WGSL | — |
| Ground, skybox | lifted from the pinned modules' string literals | 1, 8 |
| GridMaterial | the pinned template functions evaluated at the reached option set | 213 |
| Custom material | the entry file's WGSL through the typed shader IR | 159-163 |

The project-owned `audit-shader-frame-graph` differential gate is pixel-exact
against pinned Babylon Lite and verifies that alpha-card and circular-cutout
materials retain their pipelines and uniforms when a frame-graph render task
mirrors the scene. It is regression coverage, not upstream corpus coverage.

The custom-material pipeline reflects uniform layout, binding order,
attributes, varyings, stages and entry points, and PAL shader creation
consumes the reflected uniform-buffer counts. Pinned Tint emits the
target-selected HLSL or MSL; register normalization and DXC produce the
SDL-compatible DXIL or SPIR-V.

Each composed variant carries the pin's own material UBO, mirrored field for
field with a `static_assert` per offset and filled by writers lowered from
`_writeMaterialData` and each extension's `writeUbo`. The transcribed PBR
fragment is deleted: a draw resolving no variant is an error naming its mesh
and material, never a fallback.

The layer helpers arrive inside those fragments under the pin's own names —
`visibility_Kelemen`, `getR0RemappedForClearCoat`, `ccSchlick`,
`normalDistributionFunction_CharlieSheen`, `visibility_Ashikhmin`, and the
`iri_*` thin-film stack with its `IRI_XYZ_TO_REC709` matrix. There is
deliberately no transcribed fallback, because a fallback is the copy that
drifts, so a helper the pin renames or drops fails generation instead of
becoming a shading bias.

The composer is also the cross-check on the emitted set:
`assertArmsCovered` (`src/pinned-material-arms.ts`) runs every glTF material
through `_computePbrMaterialFeatures` and refuses a variant set missing an arm
one of them composes, naming the material and the arm. That is what keeps a
missed arm a generation error rather than the small systematic shading bias it
would otherwise render as — the failure mode every entry below shares.

### Numeric width

One rule, in five places: **a value is held at the pin's own JavaScript-number
width, and each `static_cast<float>` is a store the pin performs.** Rounding
early is not a rounding-sized error.

- **Lanes.** A tuple element or static record property outlives the expression
  that filled it, so its width belongs to its sink: `castNumber` writes the
  folded static value at each sink's own width. Scene 206's box translations
  reached the double `MeshRecord::position` as `5000002.5` — the float32 ULP
  at five million is half a unit — measuring 0.828 against 0.000 written wide.
  A number in an ordinary expression position is consumed where it is written.
- **Camera scalars.** `alpha`, `beta`, `radius`, `target`, `position`, `fov`,
  `nearPlane` and `farPlane` are JavaScript numbers upstream, so `CameraRecord`
  keeps `double`/`Vec3d` and the chain reproduces the pinned stores in order:
  `camera_world_matrix`, `build_view_matrix`, `mat4PerspectiveLHToRef`,
  `mat4MultiplyInto`. `Math.PI / 2` has `cos = 6.1e-17` as a double and
  `-4.4e-8` as its float32 neighbour, which moves the view matrix's second row.
- **A spot cone.** The pinned factory computes `Math.cos(angle * 0.5)` in
  JavaScript numbers and only its light-UBO store rounds, so the native factory
  keeps the half-angle product double; rounding at the call boundary moves the
  hard `cosAngle >= cosHalfAngle` edge.
- **The procedural builders.** `create-sphere.ts`, `create-ground.ts` and
  `create-torus.ts` run the whole vertex chain in JavaScript numbers and round
  only at a `Float32Array` store; the emitted chain uses `pi_double` and builds
  each position from the unrounded normal. A float chain measures 0.004 with a
  33-byte peak against the pin's 0.002. The rule starts at the call site, since
  the pin halves a diameter before the chain rounds. `create-box.ts` and
  `create-plane.ts` need no care: their vertices are literals scaled by a
  halving, the last operation before the store.
- **Node TRS and world matrices** compose in double and round once per
  component at the store, which is what makes native glTF instance matrices
  bit-identical to the browser's uploaded thin-instance buffers.

Two conversions are the pin's rule rather than C's: `Math.round` rounds halves
toward +Infinity (`bbl::js::round_js`), and `Math.hypot` is
implementation-approximated by the spec, so `bbl::js::hypot_js` is the plain
root of the sum of squares — recorded as `splat-hypot-approximation`.

**The RGBD decode's result type is the pin's storage type.**
`rgbd-decode.ts` decodes `.env` faces and the BRDF LUT into a
`texture_storage_2d<rgba16float, write>`, so a half *is* the result rather than
a packing step a caller may skip. Both backends upload halves on every path;
a float32 upload would carry more precision than the pin has.

### The reference pose

**A scene's pose can be a query string, and both sides read the same one.** A
corpus scene branching on `?seekTime=` reads `window.location.search`, and the
branch decides whether it animates at all. `parity.referenceSearch` is that
query: the reference page is navigated with it and the compiler folds the same
text, so `params.get`/`params.has` answer from the pin's own parser.
`reference/exact-corpus-manifest.json` records it beside the module digest,
because a navigation parameter is not module text and two goldens captured at
different poses would otherwise share a provenance.

### Depth

**The reached slice renders under one convention, and it is the pin's.**
`render-target.ts` declares `REVERSE_DEPTH_COMPARE = "greater-equal"` and
`mat4PerspectiveLHToRef` maps `near -> 1`, `far -> 0`. Every family takes that
pair — PBR, Standard, node, shader materials, geometry tasks, background ground
and solid skybox — and both backends clear depth to zero, so the composed
view-projection equals the browser's uploaded matrix in all sixteen elements.

The compare is not typed here: `pinned-depth-state.ts` reads the pin's own
declaration and emits `upstream::pinned_depth_compare`, failing generation on a
spelling this runtime has no enumerator for — the contract
`pinned-blend-table.ts` holds for blend factors. The same module anchors the
projection half beside the clear value, shape-asserting the reverse-Z rows so a
remapped range fails by name rather than leaving consumers keyed to a far plane
of 0 stale.

Two arms name their own compare: shadow targets render standard-Z `less-equal`
(below), and a `ShaderMaterial` may pass `depthCompare` — unreached, and a
scene naming one refuses. `FragDepthBlock` composes *because* of the
convention: the block hands a graph `@builtin(frag_depth)`, so a renderer
ordering depth the other way would occlude by its inverse.

**A depth convention cannot move a coverage mask, but it can move a varying,
through the near-plane clipper.** A triangle straddling the eye plane gets new
vertices whose attributes interpolate from clip space, `z` included, so a
differing `z` row shifts the interpolated varying across the whole clipped
triangle. Scene 7's solid skybox is the case — its cube is centred on the eye —
and why `build_solid_skybox_scene_uniforms` builds its own view-projection
rather than binding the frame's: the pinned vertex stage offsets the cube by
the eye, and the clip row reaching its dither seed has to be exact.

### Shadows

**A shadow map is the pin's one standard-Z target, and its bias reaches one of
two matrices.** `createShadowRenderTarget` names `dFormat: "depth32float"`,
`_depthCompare: "less-equal"` and `_depthClearValue: 1` at one sample, so a
caster pass is the one place this port clears depth to 1 and compares the other
way. The compare and the clear are *emitted* from that declaration
(`shadow_map_depth_compare`, `shadow_map_depth_clear`) for the reason the
`pinned_depth_state.hpp` pair they are the exception to is: a PAL constant
agrees with the pin only until it moves. The format and sample count are
checked rather than emitted, since both decide which texture a backend creates.

`renderPcfShadowMap` packs the *unbiased* view-projection into `sg._lightMatrix`
— what the receiver samples with — and hands `biasViewProjection`'s copy to the
shadow camera, which is what the caster renders through. Babylon's clip-space
linear bias (halved for WebGPU's [0, 1] range, added into each column's z row)
in both would shift the comparison twice, so the two stay apart on the record.
The light-space basis, the spot volume from `light.angle`, the 4x4 multiply and
the bias are each lowered from their own declarations, and the cone angle is
written wherever `cos_half_angle` is.

**A receiver is a composed variant, not a uniform lane.**
`_computeMeshFeatures(mesh, receiveShadows)` turns `mesh.receiveShadows &&
hasSomeShadows` into `MSH_RECEIVE_SHADOWS`, and `rebuildSingle` splices
`createStdShadowFragment(slots)` after the vertex-colour fragment and before the
thin-instance one — so the varyings, the group-2 bindings and the nine-tap
comparison filter are named after each light's index in `scene.lights`. The
depth-only view of the same mesh drops the bit, because `rebuildSingle` derives
`receiveShadows` as `!shadowOutput && ...`.

That group 2 costs SDL_GPU a uniform slot it does not have — scene, lights,
mesh and mat spend all four before `shadowInfo_N` arrives — so it takes the
geometry tasks' `gp` treatment: demoted to a read-only storage buffer for the
SDL-facing artifacts alone, while the `.native.wgsl` Dawn consumes keeps the
pin's uniform declaration. The layouts agree because every member is
16-byte-aligned, which is the argument that licenses the `gp` demotion too.

### Background

**The pinned dither reproduces on both backends, and which fragment carries it
is a pinned fork.** `WGSL_DITHER` seeds `fract(sin(dot(worldPosition.xy, k)) *
K)` on the interpolated world position, whose low bits follow the barycentrics,
so it reproduces only where the composed view-projection agrees with the pinned
engine bit for bit. On a scene whose background is otherwise flat it is the
whole residual: scene 6 attributes 0.314 to the background without it.

The fork is upstream's. `background-ground.ts` and `background-dds-skybox.ts`
prefix it behind their shared `enableNoise` (default `true`, unset by every
corpus scene), `background-solid-skybox.ts` prefixes it unconditionally, and
`background-hdr-skybox.ts` — the environment-cubemap arm — composes none. One
generated fragment serves the DDS and environment skyboxes, so each PAL picks
the dithered variant except under `skybox_uses_environment`. Dithering the
environment arm puts ±1 on roughly half the background pixels of scenes 8 and
21: 0.129 to 0.343 and 0.330 to 0.537 full MAD.

**The solid-colour skybox is a third arm with its own pair of stages, taken
from the pinned package rather than composed.** A scene loading an `.env`
environment that names no DDS or `.env` skybox and passes no `skipSkybox`
reaches `buildSolidSkyboxRenderable`: a cube shaded from the clear colour, the
dither unconditional, no image processing. Its vertex stage is the one arm that
is not root-positioned — `(mesh.world * vec4(pos, 0)) + scene.vEyePosition`
drops the world translation through `w = 0` and follows the camera, so the
dither seed is `pos + eye` rather than the DDS arm's `pos + rootPosition`. Both
stages ship as `?raw` literals with no source-map entry, so generation reads
them out of the packaged module and re-emits the pin's struct members and
statement bodies; only the `@group`/`@binding` declarations are re-addressed,
because SDL_GPU fixes vertex uniforms at space 1 and fragment at space 3 where
the pin binds WebGPU groups 0 and 1. The native mesh block is the pin's 96-byte
layout field for field.

**The background cube culls back faces; only the image skybox does not.** The
DDS, HDR and solid skyboxes build through `createDefaultPipelineDescriptor`,
whose `_cullMode` default is `"back"`; `skybox-cubemap.ts` passes `"none"`
explicitly, so `loadSkybox` keeps it. It is invisible from inside — each ray
meets one face and the near plane clips the rest — and from outside an unculled
cube rasterizes entry and exit faces, and since the skybox writes no depth the
later face in index order wins. The last two in that order are `+Y` and `-Y`,
so it renders a hard-edged quadrilateral of `-Y` over a `+Y` surround. No gated
pose reaches it; scene 14 at `cam.beta = 0.55` does.

### glTF material inputs

Clearcoat, sheen, and iridescence are metadata-driven PBR layers selected by
`extensionsUsed` and composed into each material's own pinned variant:

- clearcoat adds a GGX/Kelemen direct lobe plus a Jones analytical IBL lobe and
  attenuates the base layer by `1 - F(ccF0) * intensity`; the glTF loader
  disables Babylon's base-F0 remap, so intensity zero degenerates exactly to
  the base composition (Scene 28), while a coat created in scene code keeps it
  (Scene 19) — see the fork below
- sheen uses the Charlie distribution with Ashikhmin visibility, samples the
  BRDF LUT blue channel at sheen roughness, and scales the base layer by
  `1 - maxSheenColor * brdf.b` (Scene 29)
- iridescence evaluates Babylon's thin-film airy summation in XYZ and blends
  the result into base F0 by the iridescence intensity (Scene 178 from the
  asset, Scene 177 from `setPbrIridescence`, where an omitted intensity is the
  writer's own default 1 rather than the glTF loader's `iridescenceFactor ?? 0`)

Each layer's per-material forks — the coat's base-F0 remap, the sheen model —
compose different variants rather than one fragment with a uniform, exactly
as the sections below record.
Texture-less PBR factors follow Babylon's factor-texture bake:
`uploadBaseColorFactorTexture` and `uploadOrmFactorTexture` write the
factors into 1x1 8-bit texels (base color through `linearToSrgbByte`,
metallic/roughness as linear bytes) and leave the shader uniforms at
their defaults, so the browser shades with the quantized values.
Native mirrors each path at its exact precision boundary:
metallic/roughness quantize on the record (`round(f * 255) / 255` —
the unorm decode is that division, so the white fallback times the
quantized uniform is bit-equal to the baked texel), while the base
color bakes the pinned sRGB bytes into the fallback texel itself with
the shader uniform reverted to white, because the hardware sRGB
decode of those bytes is the reference — a CPU transcription of the
IEC formula measurably disagrees with the GPU's table; scene 255
gates the texel-level port. The record keeps the raw alpha for the
pinned blend semantics.
**The base-colour slot's encoding is its texture's, not its family's.**
`loadTexture2D` picks `rgba8unorm-srgb` or `rgba8unorm` from its caller's
own `srgb` option and the format then lives on the `Texture2D`, so the
material samples what the scene loaded: the glTF loader passes true for this
slot, the texture-less factor bake writes an sRGB texel, a
`createSolidTexture2D` texel is linear and sampled without decode, and a
scene that decodes its own albedo in the fragment (`setPbrGammaAlbedo`,
whose extension contributes `pow(rgb, 2.2)` and nothing else) loads the
linear one. The record carries that choice as one lane rather than the slot
assuming an image is sRGB, which is what lets those five cases share one
rule; Scene 22 gates the linear-image arm and every glTF scene the sRGB one.

An **animated** base color factor inverts that bake. `whiteFallback` in
`animation-pointer-basecolor.ts` swaps the factor for `[1,1,1,1]` before
the upload whenever a `KHR_animation_pointer` channel drives it and the
material has no base color image, and hands the real factor back to be
carried as a UBO field for the pointer writer to overwrite. Baking it as
well applies the factor twice — the authored value in the texel and the
animated value in the uniform, against the browser's uniform alone; Scene
253 gates it. Because materials are built before animations are read, the
answer is gathered in a pre-pass, as upstream gathers it.
Environment horizon occlusion applies only to normal-mapped materials:
the pinned `ibl-fragment` composes `eho = 1.0` without a normal map,
and each material's composed variant carries whichever arm its features
produce, so the factor follows the material by construction. Scene 247's
metallic teapots gate this; applying the polynomial unconditionally
darkens silhouette speculars there by one MSAA sample step across the
instance field.
Node TRS and world-matrix composition run in double precision and
round once per component at the float32 store, matching JavaScript's
number semantics in the pinned `mat4ComposeInto` and matrix multiply;
this makes native glTF instance matrices bit-identical to the
browser's uploaded thin-instance buffers.

**Every texture slot samples the UV set its own `textureInfo` names.**
`assemblePbrPropsExt` folds the six into one `_uv2Mask` — base colour 1, ORM 2,
normal 4, emissive 8, spec-gloss 16, occlusion 32 — and `createPbrTemplateExt`
decodes it into the fragment's own `input.uv`/`input.uv2` reads, gated on the
mesh carrying TEXCOORD_1. Generation executes both, so the selection is the
pin's and is composed into the stage rather than uploaded: the loader carries
no texCoord for the five slots a UV set alone resolves.
`KHR_texture_transform.texCoord` overrides the slot's own. A `texCoord` of 2 or
more needs nothing, since `wrapTexCoord` stamps only 1 and both sides sample
UV0.

Occlusion is the slot a UV set cannot resolve alone, and follows
`buildDefaultPbrTexturesExt` arm for arm:

| Asset shape | What binds |
| --- | --- |
| TEXCOORD_1 occlusion, no metallic-roughness image | the factor-driven ORM slot stays; the image binds through a dedicated uv2 pair (`occlusionOverride` replaces the ORM red channel) |
| TEXCOORD_0 occlusion, no metallic-roughness image | the occlusion image becomes the ORM texture at the *occlusion* slot's transform, metallic and roughness reverting to 1.0 |
| beside a metallic-roughness texture sharing its image | a second carrier whenever the two can be sampled apart — the uv2 pair, or `occlusionNeedsSplit` (a distinct texture object or its own transform) sampling `ormTexture` again at `occlUV` |

The record therefore carries `occlusion_transform` apart from `orm_transform`;
they agree wherever a material gives both slots the same transform, which is
every corpus material reaching them. Two shapes stay refused because upstream
renders them no better: distinct occlusion and metallic-roughness *images*
composite on a canvas upstream, and occlusion on TEXCOORD_1 naming the **same
texture object** as metallic-roughness sets mask bit 32 while building no
carrier, so the fragment declares a binding with no texture behind it — a
WebGPU validation failure. Occlusion is also the one slot refusing a `texCoord`
of 2 or more rather than mirroring it: `assemblePbrPropsExt` records the value
while `wrapTexCoord` leaves the bit clear, so upstream shades from a factor
texel. Gated by scene 243 (uv2 pair), scene 29 (orm-unpack split) and the
glTF UV-sets gate (all seven arms).

A scene-code material has no separate occlusion image and samples `orm.r` when
its resolved `occlusionStrength` is nonzero: `_computePbrMaterialFeatures` owns
the `(mat.occlusionStrength ?? 1) > 0` gate, and generation carries the option
into both the pinned feature input and the native record. The glTF
`_occlusionImage ? 1 : 0` rule belongs to the loader's input builder and does
not reach scene code. The pin's internal `_metallicF0Factor` stays distinct
from the public `reflectance`: a reached non-default writes both
`metallic_f0_factor` and the writer's fallback `specular_weight`, but stays
dormant in composition until `setPbrMetallicReflectance` registers the
reflectance extension. Registration is process-global in the pin, so even an
empty setter call makes a non-default creation-time F0 on another material
participate — likewise when the registering call came from a previously loaded
glTF dielectric. Repeated setter calls accumulate their conditionally supplied
fields exactly as the pinned material object does.

**A scene's `setPbr*` options reach composition through the pin's own
setters**, the way the loader half already runs `setPbrEmissive`: each stamps
its props under the field name its extension's `detect` reads, so the composed
arm set follows from the pinned setter rather than a field name restated here.
That is what an extension arm depends on — the emissive layer composes on the
presence of `_emissiveColor` alone, carrying no texture and no capability
define.

**`KHR_materials_variants` folds to the one selection a scene makes.**
`selectVariant` restores every original material then applies the chosen
variant's mapped entries, so one static selection ends at a per-primitive
material index, which generation resolves and the loader applies. The pin's
run-time variant table has no reached mutation to serve, so every shape the
fold cannot represent refuses: `getVariantNames` and `resetVariant` are
unlowered, a second differing selection or a selection on a second asset is
refused (one name is compiled in for the whole scene), and one made from a
frame callback would fold a per-frame reassignment into frame zero. An asset
carrying the extension that no scene selects on renders identically, because
the pin reassigns nothing until `selectVariant` runs. Gated by scene 27.

### Animation

A glTF file's animations are one group each, carrying the name, duration and
frame rate `animation-group.ts` gives them; upstream starts only the first
(`isPlaying: clipIndex === 0`), each looping over its own length. Two
consequences are not guessable from the file: a **stopped group writes nothing
at all** — `tickAnimationCore` returns early, so holding its channels at time
zero would overwrite a playing clip's value on a shared target — and **a seek
reaches only groups that are not stopped**, for the same early return.

**A container's entities are the pin's entity walk, and nothing else.**
`addToScene(scene, container)` recurses over `container.entities`, then does
four more things to the container: pushes the file's animation groups onto
`scene.animationGroups`, appends the per-frame tick that advances them, takes
the file's camera when the scene has none, and takes its clear colour. A scene
iterating `entities` reaches only the first half — which is the point, because
those scenes drive the same clips from an `AnimationManager` of their own and a
scene tick would double-advance them. Only static `entities[0]` on a glTF
container lowers, as an opaque imported-root identity, because the pin
guarantees the synthetic transform root at index zero; a dynamic or nonzero
index and every `.babylon` container refuse rather than conflating one root
with the complete walk.

**A manager owns animation time for the groups attached to it, and the measured
seek has to reach it.** Upstream has no seek: the harness writes `currentTime`
on each named group and pauses it, and whoever drives the group applies the
pose on its next tick. Native mirrors the shape rather than the call — a scene
registering with an engine contributes one seeker per manager it created,
beside the seeker each loaded asset already carries.

**The weighted property mixer buckets by the pair the pinned binding resolved.**
`resolvePropertyBinding` returns the object a dotted path landed on and the
final property name, and the mixer keys its accumulator on that pair — so
`position` and `position.x` are different buckets on one mesh. Weights are
summed and never normalized, which is upstream's stated choice: two groups at
0.25 and 0.75 write the weighted sum, and a single group at 0.5 writes half its
own value.

**The weighted glTF mixer is the same shape one level down, and its
partial-weight rotation blends against the rest pose.** Translation and scale
accumulate as weighted sums, zeroed on the first write to a node so the rest
pose is replaced rather than added to; rotations accumulate by incremental
slerp at `weight / (accumulated + weight)`, which makes the result independent
of clip order. A node whose weights sum below one slerps from its rest rotation
toward the accumulated one by that sum; at or above one it is renormalized. The
pose that follows is the same pass a single-clip tick runs.

**A group's `speedRatio` scales the future, not the past.** Upstream
accumulates `time += (deltaMs / 1000) * speedRatio`, so a write moves what
follows and leaves the pose already reached alone. The scene's master-clock
fan-out derives a clip time rather than accumulating one, so the writer
re-anchors: it records the clip time and the master clock at the write, and the
derived time is that base plus the scaled span since. At the default ratio with
no write this is the elapsed clock it always was. A **seek** is the deliberate
exception — the harness pins a pose by writing `currentTime`, which no ratio
scales — so the native seek takes the clock as the clip time and leaves the
ratio to the tick. No seek-pinned gate can therefore observe a ratio.

**An `AnimationGroupMask` resolves at the write, where the pin resolves it
lazily.** `animationGroupMaskRetainsTarget` retains a name when listing it and
including agree, and `resolveAnimationMask` turns that into a per-node skip
flag; the generated writer runs the same rule over the asset's own node names.
A masked channel is skipped and the node keeps the rest TRS the controller
resets to, which the generated pose pass restores for masked nodes alone since
every other animated node is overwritten by its own track. The names and mode
fold because they are constants in every reachable shape — the pin's
re-resolution exists to notice a `names` array that moves, which a compiled
scene cannot do. `group.mask` refuses anything but a
`createAnimationGroupMask` value, and a mode outside the enum fails by name.

`goToFrame`'s third argument is the pin's `engine`, and its only effect is the
guard `engine || !group._stopped || !group._gltfMixer`: a glTF group always
carries the mixer, so what is left is that a stopped group is posed when the
caller passed an engine and skipped when it did not. The native call takes that
as a boolean.

**How large a skin stays on the GPU follows its palette's transport.** A mesh
whose palette rides the pinned per-bone texture leaves the uniform array's bone
lanes at the identity, because the stage that would read them is not the stage
drawing it. [Architecture](architecture.md#animation-and-deformation) carries
the two transports and the refusal between them.
### Transmission and draw order

Transmission uses an opaque scene-color copy, dielectric Fresnel
`((ior-1)/(ior+1))²`, and Beer-Lambert volume attenuation
`exp(log(color)/distance*thickness)`. Scenes 30, 33, 176, and 212 gate the
dependency chain. With 4x
MSAA, PAL resolves and stores the opaque color attachment for the copy, then
reloads the preserved multisample color and depth attachments before
transmissive draws resume.
`KHR_materials_dispersion` reuses that path and splits the refracted ray into
per-RGB indices with Babylon's `spread = 0.04 * (20/dispersion) * (ior-1)`;
Scene 212 gates it.

The generated material records preserve Babylon's distinction between volume
attenuation, thickness-based refraction depth, and glTF-only IOR-to-F0
mapping; direct `createPbrMaterial` refraction options do not implicitly enable
the glTF dielectric adaptations.
The scene-color source is RGBA16F and remains linear through opaque and
transmissive draws; exposure, tone mapping, gamma, and contrast run once in a
final full-screen pass. The scene-color grab is sampled through the pinned
repeat-addressing trilinear sampler, so refracted UVs outside the screen wrap
exactly as upstream's `getTrilinearAnisotropicSampler` does.
This final pass runs the pin's own shape on both backends: pinned Babylon
Lite keeps the transmission target multisampled to the end and applies image
processing per MSAA sample before averaging (`image-processing-task.ts`
samples `texture_multisampled_2d` and divides after the `ip()` loop). The
fragment is lifted at generation from that task's own literals and both
backends execute it: Dawn compiles it at startup like every other stage, and
SDL_GPU binds the multisampled colour
attachment for sampling through the vendored SDL patch
(`native/vcpkg-overlay-ports/sdl3`, SDL#15838) and runs the same per-sample
fragment at 4x; the resolved-pixel single-sample fragment remains only as the
`BBLITE_MSAA=1` and stock-SDL fallback. The remaining backend split on
transmission scenes is the scene-colour *grab*: SDL_GPU resolves and copies
the opaque colour into the refraction texture where the pin reads the
multisampled attachment directly.
Punctual glTF point lights use inverse-square falloff for the primary and
additional generated light paths. Their diffuse and specular sums remain
separate through transmission and transparent-alpha composition, and
transmissive materials retain their authored alpha/depth state while moving
after the scene-color grab.

Draw order is the pin's own. Opaque draws keep the pinned append order:
every renderable module stamps one shared `renderOrder`, so the pinned
stable sort is the identity on the emitted list, and generation refuses the
moment the stamps disagree. Transparent draws sort by the pinned view-space
depth of each mesh's world translation, lowered from
`sortTransparentBindings`' own distance assignment and comparator.

### Environment and background

Requested generated grounds render by default. Their mesh is translated to the
computed scene root while Babylon Lite's fade calculation deliberately keeps
`backgroundCenter` at the world origin; Scenes 1, 6, 13, and 14 gate that
distinction. Requested DDS skyboxes use Babylon's finite root-positioned cube
and normal scene view-projection. Which skybox a scene gets is decided at
generation from the two URLs and the pinned `skipSkybox` flag, exactly as
`load-env.ts`'s deferred builder decides it: a `.dds` URL takes the DDS arm, a
URL naming the `.env` itself takes the environment cubemap, and a scene naming
neither and skipping neither gets the solid-colour cube. Grounds and
DDS/HDR/solid-colour skyboxes can be disabled independently with
`BBLITE_GROUND=0` and `BBLITE_BACKGROUND=0`.

Embedded image-based lights evaluate SH unclamped. Environment rotation
affects SH and cubemap lookup directions, while horizon occlusion
intentionally uses the unrotated reflection vector.

### Deformation and instancing

glTF animation uses pinned LINEAR quaternion interpolation and deterministic
time seeking, plus CUBICSPLINE quaternion/translation interpolation where
reached, and STEP on every channel the loader carries. STEP has no arithmetic
to lower — it selects one stored key and copies it — so what is pinned is the
key it selects: `evaluateSampler` takes the later key once the time reaches
its own (`t >= t1 ? idx + 1 : idx`) and the earlier one inside the span, and
generation asserts that selection against the pin's own branch rather than
restating it. `track_key_at` already returns exactly those two keys, so the
generated `sample_step_*` arm is a choice between its own pair.

Morph position/normal deltas are applied before recursive skinning;
generated joint palettes and morph weights drive the deformation stage.
Every morphed mesh uses Babylon's pinned uncapped storage-buffer path
(`morph-fragment-core.ts`) — the pin's one morph mechanism, compiled in for
any morph target at all: a flat 6-float delta buffer and a weights
buffer with the 16-byte `{count, vertexCount}` header, accumulated in
ascending target order before skinning, with source-marker assertions
pinning the loop, indexing, and header ABI. Scene 243 gates it.
Primitives without source normals remain deindexed, and their face normals
are recomputed after deformation while their positions stay GPU-skinned. See
[Architecture](architecture.md#animation-and-deformation) for layout,
specialization, and why that normal cannot come from a vertex stage.
Static `EXT_mesh_gpu_instancing` preserves Babylon Lite's split transform
contract: extension matrices remain local T/R/S data and the node world matrix
is applied separately in the vertex shader.

**A thin-instance stream is uploaded unoffset, so the whole floating-origin
subtraction stays on `mesh.world`.** `thin-instance-gpu.ts` packs the
per-instance matrices through the precision-only `packMat4IntoF32`, never
`packMat4IntoF32WithOffset` — the pin composes `finalWorld = mesh.world *
instanceWorld` and the large coordinate lives entirely in the first factor,
so subtracting per instance as well would bias the translation twice. The
large-world page lists "thin-instance per-instance world matrices" among its
wired bakes, which reads the other way; the source decides, and scene 204's
own comment says the same thing the source does. `instance_parent_draw_world`
is where this port states it: with the mode off the parent world is composed
by `build_instance_parent_world` and the clone offset added after it, and
with the mode on the recorded parent alone is handed to
`mesh_world_eye_relative`, which composes the record's TRS once and subtracts
the eye in double before the single float store. Composing the TRS in both
would apply it twice.

**A coloured thin-instance pool composes the Standard family's own colour
slot.** `_computeMeshFeatures` sets `MSH_HAS_INSTANCE_COLOR` from
`mesh.thinInstances.colors`, so the bit rides the pool bit and arrives with
the same call; `createThinInstanceFragment(hasInstanceColor)` then declares
the `instanceColor` attribute and the `vInstanceColor` varying. What
`rebuildSingle` does next is the Standard family's alone: it spreads that
fragment into a copy whose only slot is a `BC` one — "Standard applies
instance color to final color (BC), not to baseColor (AT) like PBR", as its
own comment says — so the base-colour slot the shared fragment carries never
reaches a Standard variant. That rewrite lives inline in the renderable
rather than in a named export, so the slot text is lifted from the pinned
declaration: a pin that moves it, drops it or renames it fails generation
instead of composing a fragment whose instance colour silently stops
applying. The colour lane is its own instance-stepped buffer, which both backends
already bound for the transcribed `useThinInstanceColors` path and now bind
for the composed variants too.

**Where that lane sits is the pin's, and it is taken rather than
restated.** `createThinInstanceFragment` declares each attribute's
`_bufferGroup`, `_arrayStride`, `_stepMode` and `_offset` -- `ti-matrix` at
stride 64 for the four world columns, `ti-color` at 16 for the RGBA lane --
while the composed WGSL keeps only the location, the name and the type. So
the layout half never reaches a variant's reflected attribute row, and both
PALs would otherwise type it out. `pinnedInstanceAttributes` EXECUTES that
factory -- the same call both compositions already make -- and emits its rows
as `pinned_instance_attributes`, which `pinned_vertex_input` and
`vertex_stream_stride` read. A moved stride or a shifted offset therefore
moves both backends without either restating it, and a lane that stopped
being a per-instance float4 fails generation by name.

The group NAMES are the pin's too, and are emitted beside the rows as
`pinned_instance_groups`. What stays each backend's is only which SLOT a
group binds at -- the pin assigns none -- stated once in
`vertex_stream_group` and proved against the pin by three `static_assert`s:
a renamed group leaves its stride lookup at zero and a third group leaves
the list longer than the two streams a backend declares, so either one stops
the build rather than binding the wrong buffer at the right slot. Scene 204
gates the rendering half.
The project-owned `regression-track-clamp` gate is pixel-exact at 3 seconds
and verifies that shorter translation, rotation, and morph-weight channels
hold their final values while a separate channel determines the animation
duration.
Skin deformation applied without an animation array diverges from the pinned
Babylon Lite output, so that shape is unsupported: reaching it would require
an explicit fidelity adaptation rather than an ordinary fix.

Pinned property animations compile static clips and groups into typed native
records. LINEAR scalar/vector interpolation, quaternion slerp, STEP holds,
frame/time ranges, looping, speed ratios, and deterministic group seeking are
generated from the reached Babylon Lite APIs.

Direct `createMorphTargets` accepts one position target, nullable normal
deltas, one initial weight, and one mesh attachment. It rides the same
pinned storage-buffer morph path as glTF. `createSphereData` and the rendered
sphere now consume the same arrays produced by an AST lowering of the pinned
`createSphereData` body, so procedural delta functions consume exactly the
base positions the renderer draws. The ground and torus builders use that
same translation path for their pinned typed-array bodies. JavaScript-number
locals remain doubles, `Math.sin`/`Math.cos` remain double calls, and each
`static_cast<float>` or `static_cast<std::uint32_t>` is emitted only at the
corresponding `F32` or `U32` indexed store. A structural gate derives the
`F32` store count from each pinned function and requires it to match every
emitted float narrowing. Scene 23 measures the sphere chain under a
mirror-metal anisotropic material, Scene 15 gates ground, and Scene 162 gates
torus on both native backends. Scene 252 remains the StandardMaterial morph
contract gate.

Scene 151 gates directional-plus-hemispheric Standard lighting; the
light-count boundary is in [features](features.md#lights).

### Lights

**The pin fills two spare scene-block lanes with the canvas size, and so does
this port.** `_packSceneUniforms` writes `eng.canvas.width` into
`vFogColor.w` and `eng.canvas.height` into `_envPad0` on every scene, in the
base pack rather than through a contributor. Nothing in the material families
reads either, which is why the two lanes went unwritten here until a node
graph's `ScreenSizeBlock` read them back through the pin's own
`vec2(scene.vFogColor.w, scene._envPad0)`.

**Standard lighting is the pin's own loop over the pin's own entries.** The
composed Standard fragment declares `array<LightEntry, MAX_LIGHTS>` and walks
`min(mesh.lc, MAX_LIGHTS)` of it through the per-mesh selection `mli()`, so a
slot past the count is never read and needs no marking — light count, kind
dispatch (the tag in `vLightData.w`) and per-mesh light lists are all UBO
data. The entries are filled by writers lowered from each pinned light's own
`_writeLightUbo`, reading direction and position out of the pin's own light
world matrix (`local_matrix_from_direction`): the spot exponent lands in
`vLightSpecular.w`, its cone cosine in `vLightDirection.w`, and a hemispheric
light's ground colour reuses `vLightDirection`, exactly where the pin puts
them. Scene 15 is the spot gate.

### Textures

**An image texture asks for anisotropic filtering only when nothing in its
chain is nearest.** `loadTexture2D` builds its sampler with
`maxAnisotropy: allLinear ? 4 : 1`, where `allLinear` folds in the mip filter
it derives as `mipMaps ? "linear" : "nearest"` — so turning mips off turns
anisotropy off with them. The upstream module page states a flat
`maxAnisotropy: 4`; the pinned source is the fork, and the port lowers from
the source. The magnitude is not rounding: scene 62's crate on a UV sphere
measures 0.031 full MAD with anisotropy 1 against 0.000 with the pin's rule,
all of it at the poles and the silhouette where the UV compression is
extreme. The glTF sampler path already carries the same rule
([backends](backends.md#ported-pinned-contracts)); this is the scene-code
loader's own copy of it, and a contract assertion on the pinned expression
fails generation if either arm moves. Scenes 62 and 81 gate it, and scenes
160 and 162 gate its absence — both pass `mipMaps: false`, which is the arm
that keeps anisotropy at one. Scene 21 reaches it too, through the
`loadTexture2D` its `Promise.all` awaits.

**A node graph's texture bindings are the pin's allocation, and the scene
supplies the images by name.** `compileNodePipeline` draws each
`TextureBlock`/`ImageSourceBlock` pair out of the same running binding counter
the node UBO and the environment take, so the numbers belong to the
composition; `parseNodeMaterialFromSnippet` then looks each declared binding
up in `options.textures` by the sanitized block name. Both halves are kept:
the generated variant table carries the pair and the name, and
`create_node_material` performs the same name join the pin performs when it
fills `_textureSlots`. Generation additionally refuses a binding the record
omits and a name the graph declares no binding for, which upstream raises at
the first render instead. Two calls sharing one graph must name the same
bindings, because the composed variant declares one set.

**A tone mapping is a value, not a flag.** `material/pbr/tone-mapping.ts`
declares `{ id, helpersWGSL, callWGSL }` and each algorithm is one exported
record in its own module, so a bundle carries only the curve it references and
`pbr-renderable.ts` composes
`scene.imageProcessing.toneMapping ?? StandardToneMapping` into the fragment.
This port reads the same records rather than restating one: a scene assigning
`imageProcessing.toneMapping` selects which export's WGSL reaches the composer,
and an unset selection reaches the pin's own default by the same `??`. The
composed arm set is closed at generation, so a scene selecting two different
curves refuses. A node graph's `ImageProcessingBlock` is untouched by the
selection — it reads `sceneU.vImageInfos.w` and carries the standard
exponential curve inline — which is why scene 87 composes identically either
way and the selection is a PBR-family contract.

**A solid texture is rounded once, where the pin rounds it.**
`createSolidTexture2D` writes `Math.round(channel * 255)` into a 1x1
`rgba8unorm` sampled without decode, so the byte *is* the texture and the
float is only how the caller spelled it. The lowered `create_solid_texture`
performs that rounding under a contract asserting the pin's four rounded
channels, and `SolidTexture` carries the resulting texel beside the float —
so a slot that bakes the texture into a fallback and a slot that uploads it
read the same bytes, and neither PAL knows the formula. Scenes 6, 21 and 76
reach it through three different consumers.

### Composed programs

**A fullscreen effect is the pin's own vertex stage around the caller's
fragment, and the pass state is checked rather than restated.**
`createEffectWrapper` builds one shader module as the default vertex stage,
one newline, then the caller's fragment, so generation lifts that constant
out of the pinned module and performs the same concatenation;
the fullscreen triangle, its `uv` varying and both entry-point names are the
pin's text, not a transcription. Everything else the pin decides about the
pass is fixed-function, or a default the frontend restates beside the
descriptor it reads — invisible to a text diff either way, so all of it is
asserted at generation instead: the `triangle-list` topology, the sample count
taken from the *output target's* signature, the two entry points, the single
three-vertex draw in each of the pin's own recorders, the `
` template
joining the two stages, `align4` and the sixteen-byte uniform default, both
arms of `matchesBinding`, the wrapper's own name default, and the clear flag
and colour on both the renderer and the task. The
`EffectBindingLayout` array is the authority on group 0 — the pin reflects
nothing out of the WGSL — so it travels whole into the generated table, with a
sampler's `textureBinding` fallback ("the texture it names, or the first
texture slot") resolved once at generation. Gated by scenes 74, 75 and 76.

**A line system is a mesh and a shader material, and both halves come from
the pin.** `create-line-system.ts` flattens the polylines at load and hands
the result to `createMeshFromData`, so the flatten is emitted as generated
C++ with each rule it folds asserted against the declaration that states it:
the segment index pair `(vertex - 1, vertex)` written only for
`pointIndex > 0`, the `Math.max(0, line.length - 1) * 2` index count, the
zero normal buffer (the shared mesh uploader requires one while the line
shader binds no normal), and the five validation throws. The material is the
program `line-material.ts` composes: its two stages are folded out of that
module's own `vertexSource`/`fragmentSource` builders — the same evaluator
the sprite composers go through — and its declarations and fixed-function
state are read off the `createShaderMaterial` call it makes, so the deployed
WGSL is the pin's text for the permutation the scene reached. Two of the
pin's own stamps fold away with a reason: `mesh._topology = 2` is glTF
bookkeeping the port carries on the material instead, and
`mesh.hasVertexAlpha` is read only by the Standard family, which no line
mesh reaches. The variant's *identity* is the permutation rather than the
name, because the pin names every line material `"LineMaterial"` while
composing a different program per flag set. Gated by scenes 278 and 279.

**A line-list on a multisampled target needs D3D12's multisampled line
rule.** SDL's D3D12 backend hardcodes
`RasterizerState.MultisampleEnable = FALSE` (`SDL_gpu_d3d12.c`), leaving line
lists on the aliased diamond-exit rule at any sample count, where Dawn sets
the flag from the pipeline's sample count and SDL's own Vulkan and Metal
backends have no such switch. The vendored overlay port
(`native/vcpkg-overlay-ports/sdl3`) carries the one-line fix beside
libsdl-org/SDL#15838; the isolating measurement and the triangle-edge A/B are
in [backends](backends.md#measured-contracts).

### Gaussian splats

**A Gaussian-splat shader plugin is spliced by the pin's own splicer, and
that splicer is executed rather than restated.** `loadSplat(scene, url,
fragments)` passes a list of `GsShaderFragment` records — pure data, either
one of `gs-depth-fragments.ts`'s own exports or a record the scene declares
— and `applyGsFragments` in `gaussian-splatting-pipeline.ts` turns the list
plus the packaged WGSL into the module the browser compiles. Two things in
its own body decide that it is executed here: it concatenates several
plugins into one slot, and it then runs a thirty-five-entry field-name
mangler over the whole spliced string so a plugin written against
`u.projection` agrees with a base the bundler already shortened to `u.p`. A
second copy of that table would agree with upstream only until it moved.
The composed module is byte-identical to the one an instrumented capture
shows the browser compiling for scenes 126, 127 and 128.

The split into two deployed stages then carries two more things across than
the stock module's does: the helper functions upstream splices at
`GS_FRAGMENT_DEFINITIONS`, which sit between the two entry points, and the
uniform block, because a plugin body may read it — `getOrCreatePipeline`
declares binding 0 `VERTEX | FRAGMENT` while the four data textures stay
vertex-only, so the uniform is the one resource a fragment plugin is
allowed to reach. It is declared whenever plugins are applied and left for
the compiler to drop when nothing reads it: SDL_GPU pushes it to the
fragment stage exactly when `splat.frag.slots` says the block survived, the
same authority every other stage's bindings come from. Generation refuses a
composed module whose vertex half the splice moved, which is what turns the
mangler's idempotence on an already-shortened base from an assumption into
a check.

**A splat cloud's world matrix is the pin's own TRS composition.** A
`GaussianSplattingMesh` is a `SceneNode`, so `composeTrsLocalMatrix` builds
its world matrix like every other node's; the native record carries the same
TRS field names and `build_splat_world` is the same emitted composition the
thin-instance parent world already uses, over one home rather than two.
Nothing caches it: the sort's own depth-transform gate and the UBO writer
both re-derive it per frame, so a position write needs no version bump.
Scene 127 measures it.

**The transform bake is folded, and its TRS reset turns on an Euler proxy.**
`bakeTransformIntoVertices` is arithmetic over the same 32-byte rows the
geometry build reads -- a per-splat `mat4TransformCoord`, a scale by the
matrix's X basis length, and a quaternion multiply repacked to four bytes --
so it folds for the reason the geometry build does: its shape is the
contract. The rotation it multiplies by comes from `mat4Decompose`, folded
with `mat4Determinant3` and `_quatFromRotationBasis` beside it and
specialized to the rotation its one caller reads; that specialization is
licensed by an assertion on `mat4ToRotationQuat`'s own body rather than by
inspection. Two statements are asserted instead of emitted: the pin copies
`mesh.splatsData` and hands the copy to `updateData`, while this port
rewrites the caller's rows in place and rebuilds the geometry itself, which
is the same end state only while the pin still does both.

The reset is where the two records differ and where the difference matters.
Upstream `mesh.rotation` is an **Euler proxy** over `rotationQuaternion`
(`createEulerProxy`, `scene-node.ts`): a component write re-applies the whole
cached triple through `eulerToQuat`, so there is no separate Euler storage
and clearing the quaternion clears the rotation. This port keeps the two as
record lanes, with `build_splat_world` preferring the quaternion only while
one is set -- so the emitted reset clears the Euler lane as well. Leaving it
would compose the rotation a second time, which is the one way a faithful
per-statement port of that function renders wrong. Gated by scene 125, whose
remaining max of two bytes is the multisampled splat band — the two backends
differ from each other by the same amount.

**A linear-depth material is folded from the pinned factory that builds
it.** `render/linear-depth-material.ts` is one `createShaderMaterial` call
over two module-scope WGSL constants, so this port reaches it the way it
reaches `createLineMaterial`: the stages come from the constants the call
references, the attribute and uniform lists from the call, and the
fixed-function state from the properties beside them. Its `depthCompare` is
checked against the pin's own `REVERSE_DEPTH_COMPARE` rather than against a
spelling typed here, because that agreement is what makes the fold
legitimate — a `ShaderMaterial`'s own compare is not carried through
lowering, so a factory naming another one has to refuse instead.

Its stages read `view` and `projection` as their own matrices, which is why
both joined the system-uniform table. They are the two factors of the
product the pass already built, so each pass builds all three from one
camera and hands them over together — `build_scene_projection` is the branch
`build_view_projection` itself takes, so the orthographic arm is answered
too. Carrying them as one value is what stops the three coming from two
sources: a shadow caster pass renders through the light's biased
view-projection and the generator holds a light-space view but no separate
projection, so it offers what it has and a stage declaring the missing
factor fails by name rather than silently reading the frame camera's.

**A quantized glTF is dequantized by the pin's own hook, at generation.**
`KHR_mesh_quantization` is implemented upstream as a single `preParse` that
rewrites every quantized accessor into a freshly appended tightly-packed
FLOAT bufferView, so the rest of the loader never learns the asset was
quantized. It reads nothing but the document and its binary chunk, which is
what makes running the pinned module at generation the same answer rather
than a second implementation of it: `dequantizeGeometry` hands it the
packaged GLB's own chunks and writes back what it returned, then drops the
extension from `extensionsUsed`/`extensionsRequired` because the bytes no
longer carry it. The conversion rule is role-agnostic and the pin states why:
unnormalized unsigned VEC2/VEC3 storage must be rewritten tight or strided,
because the core loader's UV paths always divide unsigned integer data by
65535. Scene 220's Duck reaches all three arms — a normalized BYTE normal, an
unnormalized strided USHORT position, and an unnormalized USHORT UV the
material's `KHR_texture_transform` rescales.

**The Standard UV transform is a mesh-phase extension, and its bit joins the
variant key from a hook rather than from a detector.** `stdUvTransformExt`
carries no `_detect` at all: `enableMaterialUvTransform` marks the material
and `_meshFeatures(meshFeatures, material)` turns that mark into
`STD_HAS_UV_TRANSFORM`, which `buildStandardMeshRenderables` ORs onto the
material's own word before composing and before keying its caches. So the
generated selector is keyed by that ORed word too, and the runtime derivation
lowers the hook beside the eight `_detect` bodies — refusing one that reads
its mesh-feature parameter, because the record-side derivation carries only
the material. Registering the extension is free for every other scene (an
unmarked material contributes nothing and `_computeStandardMaterialFeatures`
skips an extension with no `_detect`), so it registers unconditionally and
keeps the process-global registry independent of which scene composes first;
what is gated on reach is the emitted derivation line, where the pin's own
opt-in lives.

The block itself is lowered from `writeChannel`'s own AST, and two things are
folded because their shape is the contract: the `CHANNELS` table, read out of
the pinned module and unrolled into its seven calls, and the first conjunct
of `legacyFlipV`, which that same table decides. The pin computes in
JavaScript doubles and rounds once at its `Float32Array` store, so the
emitted writer's locals are doubles and the store is the single
`static_cast<float>` — the same rule the camera scalars and the pinned
matrices take. `material.uvOffset` reads its `?? 0` arm, because
`enableStandardUvOffset()` installs the resolver and no reached scene calls
it. Scene 282 measures the composed stages byte-identical to the browser's,
every uploaded lane bit-identical, and every pixel exact. Its one differing
pixel of 921600 sat 4.0e-6 from a texel boundary, where nearest filtering
took the neighbouring checker row — and that 4e-6 was the transform's own
`uScale` reaching this double lane as a float literal, which the lane rule
above now writes at the sink's width.

**A compressed texture's blocks are uploaded as the container carries them,
and which container is fetched is generation's one answer to a device
question.** `ktx-loader.ts` parses a KTX1 header, slices its mip chain and
resolves `glInternalFormat` through `compressed-formats.ts`; all three are
plain data over the file, so the parser is lowered to C++ and runs at load,
exactly as the `.env` container parser does. What cannot run at load is the
*selection*: `loadKtxTexture2D` keeps the suffixes whose feature
`device.features` reports and tries them in order, and a native build has no
network for a second candidate. Generation resolves it over the compiled
backends' feature set — block compression, which is what a D3D12 adapter
reports on both of them and in the browser reference
(`texture-compression-bc`, and neither ASTC nor ETC2) — and the emitted format
table carries the pin's block-compression rows alone, so a file outside them
refuses at the pin's own `if (!format) throw` rather than at an upload that
cannot name what it was handed. Both PALs then translate the pin's own WebGPU
format name, upload the block-padded copy extent the pin computes for each
level (a 2x2 tail mip still occupies one 4x4 block), and generate no mips.
Gated by scene 25, at a grazing camera that samples the whole chain.

**A Basis file is transcoded by the pin's own loader and packaged as KTX1.**
`basis-loader.ts` injects the Binomial transcoder from a CDN with a `<script>`
tag and picks its target format from `device.features` — a browser API and a
device question — so generation runs the pinned loader in headless Chromium
and bakes what it uploaded. It is written back as a KTX1 container because
the port already reads one: the transcoded chain is exactly what `parseKtx1`
returns, and the GL enum it is stored under is the pin's own table read
backwards. Recorded per scene as `executed-basis-transcode`, with the drawn atlas's
tradeoff. Scene 36's Mustang transcodes to `bc7-rgba-unorm` at 768x512 with
one level, which is what the browser uploads.

**A texture-object `invertY` is a UV-block flip, and the two compressed
loaders disagree about it.** `Texture2D.invertY` states that the texel data
is stored top-down and must be flipped when sampled, "applied at UV-transform
time in the material, so compressed-format textures remain correct" — an
in-place row swap over blocks being impossible. `basis-loader.ts` sets it and
`ktx-loader.ts` does not, so a Standard material sampling a Basis texture
flips its UV block and one sampling a KTX texture does not. The native record
keeps that property (`uv_invert_y`) apart from the upload flip (`invert_y`)
for the same reason the render-target arm does.

**A render target sampled as a Standard diffuse texture flips V in the UV
block, not at upload.** `createRenderTargetTexture` returns its colour
attachment as a `Texture2D` carrying `invertY: true`, and
`isStandardUvInverted` reads that property off the diffuse texture to decide
the sign `writeStandardUvTransformData` gives the material's UV scale. A
loaded image never carries it — `loadTexture2D`'s own `invertY` option
drives the flipped upload copy and nothing else — which is why the native
record keeps `uv_invert_y` and `invert_y` as separate fields, and why
reading the upload flag here would flip every textured Standard sample.
Scene 110 gates the render-target arm and scenes 9 and 24 the absence.

**The emissive slot samples through its own UV like every other slot** —
`emissiveUV` under its transform, `input.uv2` under a `texCoord` of 1 —
and the composed variants carry whichever arm the material reaches. Scene
39, whose water animates the emissive transform, gates it.

**The bitangent is a varying.** `pbr-template.ts`'s `tangentBlock` builds
`B_local = cross(N_local, T_local) * tangent.w` before the world and skin
transform and carries it as `worldBitangent`; the fragment composes
`mat3x3(worldTangent, worldBitangent, worldNormal)` from the raw varyings and
normalizes the sampled normal before the frame. `cross` is preserved only by a
similarity and a weight-blended skin matrix is not one, so the frame cannot be
rebuilt from the transformed pair. The mesh world is baked into the vertices
here and conjugated into the palette (`native_matrix`) rather than uploaded as
`MeshUniforms.world`, so the vertex stage reaches the same value by
`M·I·M⁻¹ · M·B = M·I·B`. Scenes 1, 5, 7, 14, 29, 33, 146, and 176 measure it.

**A coat rewrites the base F0 unless the coat came from glTF.** A layer over a
base changes the interface the base reflects off, so `createClearcoatFragment`
composes a `makeF0Remap` slot that runs before the base shades: it takes
`colorF0` through `getR0RemappedForClearCoat` with the coat's
`(1 - ior, 1 + ior)` pair and mixes by the coat intensity. The slot is dropped
only for the `PBR2_CC_F0_REMAP_OFF` bit, and the single thing that sets it is
`gltf-ext-clearcoat.ts` passing `useF0Remap: false`, so the choice is decided
by where the coat came from rather than by any value. `setPbrClearCoat` does
not expose `useF0Remap`, which is why the generated fragment carries the remap
for a scene-code coat and omits it for a glTF one, and why the two are
different fragments rather than one fragment with a uniform. The magnitude is
material: Scene 19's white dielectric sphere has a base F0 of 0.04, and its
ior-2.0 coat remaps that to 0.0204, so omitting the slot puts every sphere
pixel one channel step bright. Scene 19 gates the remap and Scene 28 gates its
absence.

**Sheen is composed as one of two pinned models, chosen at generation.**
`createSheenFragment` takes a `hasAlbedoScaling` flag and builds materially
different arithmetic from it, so it is a fragment fork rather than a uniform.
The `true` arm, which a glTF `KHR_materials_sheen` material reaches, scales
the base layer by `1 - shMax * shBrdf.b`, treats the tint texture as linear,
and multiplies the environment term by specular and horizon occlusion. The
`false` arm, which is what `setPbrSheen` defaults to, reads the tint through
`pow(rgb, 2.2)`, takes roughness from the tint texture's alpha because it
declares no separate roughness map, attenuates the lobe by `1 - dielectricF0`,
and leaves the base layer alone. Each composed variant carries whichever arm
its material reaches — the legacy one also drops the sheen roughness
texture's binding pair and UV transform, since nothing samples them. Scene 29
gates the glTF arm and Scene 21 the legacy one; a scene reaching both
composes two variants, one per material, like any other fork.

**A material plugin is folded from the scene and spliced by the pin.** The
two halves are separated the way the fidelity rule separates them.
`MaterialPlugin` is a plain object upstream and everything the bridges read
off one for the reached slice is a constant the scene wrote — its `name`, and
the WGSL `getCustomCode(shaderType)` returns per injection point — so it is
folded from the scene's own AST, with each point name checked against the
pin's own `FRAG_POINT_TO_SLOTS` and `VERT_POINT_TO_SLOT` rather than a list
retyped here. Everything downstream is executed: `buildPluginFragment` maps
each point onto its template slot, concatenates two plugins that share one,
and the two bridges number a signature. Scene 217's composed Standard and PBR
fragments are byte-identical to the ones an instrumented capture shows the
browser compiling.

`enableMaterialPlugins(scene)` is where the port reaches the feature, because
it is where the pin does: it is the only thing that registers the bridges,
which is what makes a plugin-free scene byte-identical to a build without the
plugin system. A scene that attaches plugins and never calls it composes
plugin-free here too.

**The signature index rides each family's own key.** `pbrPluginExt.detect`
returns it in `features2`, which `_computePbrMaterialFeatures` already runs
for every material this port derives, and a PBR draw resolves its variant by
material index — so nothing about a PBR plugin reaches the runtime.
`stdPluginExt` has no `detect` to use: Standard's feature computation is not
extension-extensible, so `registerStdPlugins` walks the scene's meshes and
pre-bakes `_computeStandardMaterialFeatures(mat) | (idx << PLUGIN_INDEX_SHIFT)`
into each plugin material's cached `_renderFeatures`, which `rebuildSingle`
then reads back. This port has no pin meshes to walk, so it numbers the lists
itself, hands `registerStdPlugins` one stand-in material per list in that
order, and refuses generation if the pin disagreed about a single index. The
number then rides `MaterialRecord::plugin_signature_index` and the generated
`standard_material_features` shifts it back in at the same position, because
the Standard variant selector's key is that derived word.

### Node materials

**A node material is compiled by the pin, not re-emitted here.** A Babylon NME
document is a graph, and `material/node/node-emitter.ts` turns it into WGSL
through one emitter per block class — over a hundred of them, which are
the graph's semantics rather than formulas to restate. So the pin's own
`parseNodeMaterialFromSnippet` runs at generation against a recording device
(`src/pinned-node-material.ts`): every device call on `compileNodePipeline`'s
path happens after the module text is assembled, which is what makes four stub
methods enough, and a pin that started deciding the text from something a real
device answers would fail here rather than compose something else. What
deploys is that module, entered at the pin's own `vs_main`/`fs_main`; what the
generated `node_variants.hpp` carries is a transcript of the same run — the
uniform block's layout, the vertex inputs and the cull state the compiler
produced.

Two of that transcript's parts are folds with a stated reason. The **uniform
block is a constant**: `writeNodeUBO` scatters each named input's values at the
offset the pin's layout gave it, and the `inputs` handles that would change one
are not lowered, so generation bakes what the pin's own writer would have
written. And the **mesh block rides the identity world** where the pin passes
`mesh.worldMatrix`, because a scene-code mesh bakes its node transform into its
vertices here — the same argument the Standard family's draws already make, and
the same one that keeps `receivesShadow` at the pin's default, since
`receiveShadows` has no lowered setter.

The graph itself arrives two ways and each gets the answer it deserves. A
module exporting the document as a literal is read as data, which is the fold
and cannot drift. A module that builds its graph at load — id counters,
spread-composed inputs, arrays it pushes into — is code this compiler does not
lower, so it is executed instead, under Node.

That last word is the whole difference from the two executed asset kinds
beside it. A drawn atlas and a computed pixel buffer produce *pixels*, so they
run in the engine the golden runs them in and each records an adaptation
saying the bytes depend on that Chrome. A graph is structure: an object of
numbers, strings and arrays, built from counters and `push`, with no Math and
no browser API in any of the seven corpus modules that write one. Two
ECMAScript engines cannot disagree about it, so there is no adaptation to
record — and a module reaching past plain data fails at its own import rather
than being executed against a shim.

### Node particles

**A node-particle simulation is executed and its state baked; everything
that draws that state is folded.** `particle/node/npe-build.ts` walks a graph
and dynamically imports one evaluator per block class, each installing
getters and update steps onto the system as JavaScript closures — so there is
no shape to fold, and this compiler lowers no closures. The value is fragile
past any rounding argument as well: every corpus scene installs its own
deterministic `Math.random` seeded through `Math.sin`, which is not
bit-portable between V8 and a native maths library, and the graph consumes
that sequence in an order the block walk decides. A native simulation would
draw a different sequence within a few hundred calls and diverge into a
different set of particles, not a slightly different one. Generation runs the
pin's own parser, builder and simulation in headless Chromium and bakes the
particle buffer; the tradeoff is the drawn atlas's, recorded per scene as
`executed-node-particle-simulation`.

What is *not* executed is the bridge. `createParticleBillboard` and
`syncParticleBillboard` are lowered from their own declarations, each rule
asserted: the grid atlas takes the sprite sheet's cell size when it has one
and the texture's own otherwise, the system is built at `buffer.capacity` on
`blendForMode(system.blendMode)`, and the sync writes exactly five props per
live particle (`position`, `sizeWorld` as `size * scale`, `color`, `rotation`
and the sheet's `cellIndex`). The pin's own `clearBillboardSprites` is the
identity where the generated sync runs — the billboard the generated builder
just made carries no sprites — so a second sync is refused at generation
rather than doubling every particle.

**A registered node-particle set is folded, and the fold is MEASURED rather
than argued.** `registerNodeParticleSet` appends a callback that animates and
re-synchronizes every frame, so a frozen bake can only answer for it when
that step is the identity. Whether it is depends on the graph's own update
blocks, which is not a question this port can settle by reading: instead the
bake driver takes each registered system's state, calls
`animateParticleSystem(system, 1)` once more, and compares every column the
sync reads. Generation refuses a registration whose columns moved, and refuses
one whose `updateSpeed` is not zero — the two together are what make the
per-frame callback provably the identity for any ratio, since
`scaledUpdateSpeed = updateSpeed * ratio`. Gated by scenes 283 and 284.

**The exact particle blends are a second mapping, and both are read as data.**
`particle-billboard.ts`'s own `blendForMode` maps three modes to public
billboard descriptors and degrades the rest to Add; `particle-blend.ts`'s
`createParticleBlend` resolves all five to private descriptors, including
Multiply (`dst`/`zero`) and MultiplyAdd. `particle-sprite-2d.ts` carries a
third mapping onto the 2D descriptors, whose alpha factors differ from the
billboard ones. All three are emitted from their own declarations, so a factor
the pin edits changes what is emitted and an arm it adds fails generation.
Which mapping a system takes is the set's own answer — the enabler installs
it per system — and it rides the native descriptor as the pin's own
`_particlePasses` count rather than as a mode number, because that is the
field the pin's registrar forks on.

**Mode 4 is two passes over one renderable.** The pin wraps the Multiply
draw with a stock Add pipeline, a second bind group and a second copy of the
system uniform block, then draws the same instances again and restores the
primary pipeline so a caller caching it stays correct. Both backends do
exactly that: one instance buffer, one index buffer, two pipelines, and the
Add blend built where the pin builds it — `createParticleBlend(2)`, resolved
by the generated builder rather than by either PAL. Scene 284 measures it.

**The Multiply fragment is the pin's own module, not a fragment arm.**
`particle-billboard-renderable.ts` writes a whole WGSL module of its own so a
Multiply-only bundle declares no `SpriteFx` block at all, and
`particle-sprite-2d-blend-modes.ts` carries the 2D twin with the layer's
`L.opacityMul` in place of the system's. Generation evaluates the first
builder and lifts the second's body into the pin's own sprite composer, so
both stages are the pin's text: `baseColor.rgb * sourceAlpha + white * (1 -
sourceAlpha)`, which is what makes a zero-alpha texel leave the destination
unchanged under destination-colour blending. Scenes 283, 284 and 301 measure
all three shapes byte-exact.

**A particle buffer is generation-time state.** The simulation runs at
generation, so `buffer.alive` and every column exist only there. A scene that
writes a column after the freeze is editing the state the bake hands on, and
one that checks the live count is asserting about it: both move to the bake
driver and emit nothing native. The guard's message does not travel with it —
the corpus writes it as a template over the very count it rejects, and the
driver knows that count, so it reports the real one.

The five integer-valued one-argument `Math` functions fold at generation over
a constant argument, where the folded value and the emitted call agree
exactly; the transcendental ones deliberately do not, because V8 and a native
maths library need not.

**A particle graph's texture is a `loadTexture2D`, not a `loadSpriteAtlas`.**
`ParticleTextureSourceBlock` loads through `loadTexture2D` with `invertY`
alone, so its atlas keeps that loader's sampler: repeat addressing, a full
mip chain, and the pinned `maxAnisotropy: allLinear ? 4 : 1` rule resolving
to 4. `loadSpriteAtlas` pins the opposite — clamp, no chain, anisotropy 1 —
and the difference is not rounding: with the chain absent scene 262 measures
0.006 full MAD, edge-weighted at 0.266, and 0.000 with it. Both backends read
the chain off the record's own mip filter, which is the pin's
`mipMaps ? "linear" : "nearest"` and therefore says whether the loader built
one.

**The scene's camera is an input to a flow-map build.**
`UpdateFlowMapBlock` derives the view-projection from `scene.camera` while
the graph is built, and the pin leaves the prepared matrix unavailable — so
the update silently does nothing — when the scene has no camera. Generation's
driver therefore replays the scene's own camera construction, and a flow-map
build whose camera is not a static arc-rotate construction refuses rather
than simulating with the update disabled. Scene 280 measures 1.555 full MAD
without the camera and 0.000 with it.

### Sprites

**A sprite atlas that is drawn rather than fetched is executed, not
reimplemented.** `lab/lite/src/_shared/sprite-atlas-image.ts` builds its
256x128 atlas with canvas2D — rotated wedges, `arc`, `hsl` — and returns a
data URL, so there is no file to download and the pixels are a browser
rasterizer's antialiasing rather than a formula. Generation serves the pinned
module from a local server, calls its exported factory in headless Chromium,
and bakes the PNG the data URL carries as a generated asset. Nothing about the
drawing is transcribed. The tradeoff is the HDR prefilter's and is the same
one: the baked bytes depend on the Chrome that compiled them. It is recorded
per scene as the `drawn-sprite-atlas` adaptation.

The frames are not baked with them. `createGridSpriteAtlas` partitions
whatever texture the loader was handed, so the generated loader decodes the
PNG and runs the pinned derivation over its own width and height — a changed
atlas needs no compiler change. `loadSpriteAtlas` fixes the sampler the pin
fixes (clamp on both axes, no mip chain, filter from `sampling`), and the
texture is `rgba8unorm` with `srgb` off, so the atlas texels reach the blend
stage as the bytes on disk.

**A sprite layer is drawn by its own renderer, not by the scene.** Upstream's
`SpriteRenderer` implements `RenderingContext` directly and registers on the
engine rather than on a `SceneContext`, opens its own single-sample swapchain
pass, and draws one instanced quad per layer. Native mirrors that: a scene
registering a sprite renderer and no scene compiles no scene renderer at all,
and the sprite pass is a separate translation unit. The instance layout is the
pinned pure-2D one — thirteen floats, 52 bytes, position/size/uvMin/uvMax/
rotation/colour — and the layer UBO is the pinned sixteen floats. The reached
slice is the straight-alpha blend on `depth: "none"` layers; depth-hosted
layers, the other blend descriptors, custom shaders, uv scroll and coverage
gamma are all behind upstream's own hooks and none is emitted. Both GPU
backends draw it, from one generated WGSL pair and one instance layout, and
on this scene they agree byte for byte with each other and with the golden.

**One writer, two arms — because only the writer can see the previous
sprite.** `writeInstance` is shared upstream by `addSprite2DIndex` and
`updateSprite2DIndex`, and the argument that differs is `prev`: null on an
add, and the slot's own floats on an update. Every unsupplied field reads
from it, so this port shares one writer too rather than resolving defaults
at the two call sites — a caller cannot resolve them, since the previous
value lives in native memory. Each preserve rule takes its value from a
different place and the shapes are asserted against the pinned declaration:
position and rotation from the instance floats, the UV endpoints from the
slot (whose *order* carries the flip, which is what lets a frame change keep
a mirrored sprite mirrored), and the true size from the CPU-side shadow —
which exists precisely because `visible: false` is stored by zeroing the GPU
size, so the instance data cannot answer what size to restore. Two arms are
deliberately not symmetric: a supplied `frame` resets the size to that
frame's own `sourceSizePx`, discarding an explicitly set one, and an update
that supplies no colour writes no colour floats at all.
`clearSprite2DLayer` matches its early return as well as its body — an
already-empty layer does not bump the version, so a per-frame clear on an
idle layer re-uploads nothing.

**A renderer's layer list is mutable, and each layer's GPU record moves
with it.** Both backends build one record per layer — pipeline, instance
buffer, atlas binding — and `addSpriteRendererLayer`,
`removeSpriteRendererLayer` and `disposeSpriteRenderer` all move that list.
The pin keys `sr._layerGpu` by the layer object, so adding one compiles only
the new layer's pipeline and removing one disposes only that layer's entry;
this port keys by handle for the same reason, and a `layers_version` bump is
what makes it walk the list again. Rebuilding the whole set instead would be
observable rather than merely wasteful: a layer's `elapsed_ms` is the clock
its custom shader's `fx.time` reads, and a rebuild would restart it for
layers nobody touched.

Releasing the records that are dropped needs no wait on either backend, and
for two different reasons: SDL_GPU documents every `SDL_ReleaseGPU*` as
freeing "as soon as it is safe to do so", and a WebGPU object is
reference-counted with a submitted command buffer holding its own reference.
(The mesh-set rebuild in the Dawn scene renderer *does* wait, because it
re-uploads *into* buffers in-flight work reads — a different hazard.)

Unregistering moves one more thing: the frame's clear belongs to whichever
rendering context is at the *front* of the registered list, which is what
`startEngine` walks, so both drivers re-derive it per frame. Reading it once
at startup keeps clearing with a disposed renderer's colour — measured at
29.105 full MAD against 0.000 on the gate below. The one case upstream
leaves to the canvas is every renderer being disposed: it draws nothing and
the page keeps its last pixels, which a swapchain cannot answer on its first
frame, so the helper falls back to a default-constructed record and the
pinned `createSpriteRenderer` defaults come off its own initializers. No
reached scene disposes its last renderer.

`regression-sprite-layer-arms` measures all of it at 0.000 on both backends,
and each half is A/B-proven rather than assumed: it grows the list from three
layers to four, gives one late layer an additive blend, and disposes the
renderer registered *first*. With the synchronisation removed both backends
fault (`0xC0000005`); with the clear owner read once at startup the frame
paints the disposed renderer's colour.

### Environment packaging

HDR environments preserve mip zero and use the pinned WebGPU 1024-sample GGX
prefilter for higher mips. The generated package records the pinned module,
shader, source commit, and sample count.
`EXT_lights_image_based` likewise materializes Babylon Lite's 256-square,
1024-sample BRDF integration directly as RGBA16F and uploads decoded RGBD
cubemap faces with the same half-float quantization as WebGPU.

**A skybox size of zero asks the loader for the pinned default.** The
generated loader resolves an unset `skyboxSize` to `createDefaultEnvironment`'s
20, so the compiler passes zero rather than substituting a size of its own —
a compiler-substituted size builds a skybox the camera's far plane can clip,
invisible from the reference pose and a straight-edged hole in the background
as soon as the camera moves.

**A DDS environment's irradiance harmonics are projected at compile time.**
Babylon Lite's `loadDdsEnvironment` uploads the file's mip chain as the
specular cube and projects the first nine spherical harmonics out of mip 0
while the page loads, weighting each texel by the solid angle it subtends.
Both halves are decided entirely by the asset, so `src/dds-packager.ts` does
them once during generation and the runtime reads a package instead of a
container format — the same split the HDR path already uses. The projection is
reproduced rather than approximated: the 27 floats the package carries are
bit-identical to the ones an instrumented capture shows the browser uploading
for Scene 19. The package is the format the HDR path emits, so the DDS file's
face-major mip chain is transposed to mip-major during generation and one
native reader serves both. One difference from the HDR loader is the pin's own
and is carried through: a DDS environment writes no image-processing state at
all, where the HDR loader sets exposure, contrast, and tone mapping.

**All three environment routes now share one LOD generation scale, and it is
read rather than restated.** `.env` and DDS have always passed `0.8` to
`assembleEnvironmentTextures`; the HDR loader passed `1.0` until 1.25.0 named
the value `HDR_LOD_GENERATION_SCALE` in `hdr-ibl-pipeline.ts` and set it to
Babylon.js's own `0.8`, calling the old value a mismatch with the
roughness-to-prefiltered-mip mapping. The scale is a *value* the loader hands
over, so the emitted `lod_generation_scale` comes from the argument's own
expression — a named constant is followed to the module that declares it,
which is what turned that move into a generation failure rather than a
silently different reflection blur.

Scene 8 is the one reached HDR environment and it measures byte-identical
either way, which is a fact about the scene rather than about the scale: its
sphere is `microSurface: 1`, so `log2(cubemapDim * alphaG)` is negative
before the scale multiplies it and `clamp(specLod, 0.0, maxLod)` returns mip
zero for both values. A rougher HDR-lit surface is what would measure the
difference, and the corpus has none.

Per-texture UV transforms follow the pin's own per-material rule: generation
executes the pinned `wrapTexture` and `needsGltfUvTransform`, so a material
with no transform never gains the fields, and each carrying slot's fields are
filled by writers lowered from the pin's own `writeUvTransform` family.
Rotation is composed in double before the float store, matching a `Math.cos`
result reaching a `Float32Array`.

One glTF material contract is expressed in a shape that differs from the
pinned one while producing the same values, and it holds for a stated reason.

**A glTF index of refraction folds into the material's reflectance.** The pin
keeps reflectance at its default and scales it with `metallicF0Factor`, so
`KHR_materials_ior` sets the factor to `((ior-1)/(ior+1))^2 / 0.04` and the
product is the dielectric F0. The loader stores that product directly instead,
which is the same value while nothing else scales F0. `KHR_materials_specular`
is the second scale, so a material declaring it separates the two again: the
factor becomes the extension's `specularFactor` and reflectance returns to its
default, which is also how the pin resolves the two extensions against each
other — the specular factor overwrites the one the index of refraction seeded.

DXC stays mandatory on the SDL_GPU D3D12 and Vulkan offline paths — Tint
emits no DXIL, and Vulkan temporarily recompiles normalized Tint HLSL through DXC
([features](features.md#stage-2-compiling-wgsl-for-the-device) tabulates the
paths and the binding-remap gap).

Tint HLSL is normalized before DXC so texture and sampler registers are dense
and corresponding, as required by SDL_GPU. D3D system-value inputs are ordered
to preserve the vertex/fragment signature convention used by the existing
native pipelines. Tint discard statements are lowered to `clip(-1.0)` to avoid
a D3D12 command-list failure in multisampled pipelines while preserving
fragment-kill semantics.

## Physics contract

**The pinned physics layer is generated; the solver under it is not the
pin's, and that is the only divergence here a measurement cannot close.**

Everything else this repository records is bit-faithful by construction — a
fold whose shape is the contract, or a value executed in the engine the
golden runs it in. A substituted rigid-body solver is neither. Havok V2 and
Bullet resolve contacts and converge their constraint solvers differently,
so a body's pose after N steps is a *different number* rather than a
rounding of the same one, and the difference compounds with every bounce.
It is recorded per scene as `substituted-physics-solver`, at `high` risk,
and it means a physics scene's threshold can never be driven toward zero.
Scene 40 carries one, measured just above the distance between the two
solvers: it gates this port's own solver against that distance rather than
asserting agreement with the pinned one.

**Why the substitution, and why at this seam.** `createHavokWorld(scene,
hknp)` takes the solver module as a parameter and the pinned layer calls
only `HP_*` entry points on it, so upstream already separated its
rigid-body *semantics* from the library that integrates them. The port
keeps that line exactly: `src/physics/havok.ts` is lowered like any other
pinned module, and the `HP_*` surface becomes
`native/include/bblite/pal_physics.hpp`. No generated code names a solver.
The Havok WASM module is a proprietary binary this project cannot
redistribute; Bullet is Zlib and is the closest available relative of the
reference, since Babylon's legacy `AmmoJSPlugin` is Bullet compiled to
WebAssembly.

**What IS pinned, and is emitted from the pinned declarations rather than
restated:** the step gate `_fixedDeltaMs > 0 ? _fixedDeltaMs : deltaMs`, the
non-finite/non-positive rejection, the `Math.min(stepMs, MAX_STEP_MS) /
1000` tunnelling clamp with `MAX_STEP_MS` read from its own declaration, the
`gravity ?? { x: 0, y: -9.81, z: 0 }` default, the `?? 0.2` friction and
restitution defaults, all three motion/shape/prestep enumerations with the
pin's own numbering, the aggregate's ordering (shape, body, shape
assignment, material, then mass — upstream comments that ordering because
mass derives from the shape), the `mass === 0` static rule, and the
shape sizing `_buildShapeParams` derives.

That derivation is translated expression by expression from its own AST. Two
things specialize, and both are the ones the three helpers it replaced in
1.25.0 already specialized: the optional bound pair becomes the native
geometry record's `present` flag with each `??` taking the pin's own literal
fallback, and every component widens from its stored float into the
JavaScript-number double the pin computes in. Everything else is the pin's
expression — the four scale terms, the scaled extents, the centre the sphere
and box cases share, and the segment a capsule and a cylinder span. The last
A capsule and a cylinder span the mesh's own scaled Y range at
`extents.x * 0.5`. `physics-lowerer.ts` asserts
every remaining restated rule against the declaration that states it,
including the *order* of the four phases, which no single expression would
catch, and `setPhysicsShapeMaterial`'s static-friction default, which is what
licenses the emitted aggregate writing one friction into both material
channels. Scene 40 directly gates the translated centre, ground extents, and
sphere radius on both backends.

**What a substituted solver is measured by.** Two things, and the split
matters because only one of them needs Havok.

**Solver-independent properties, checkable with no reference at all.**
`BBLITE_PHYSICS_TRACE` writes the per-step pose, and three properties follow
from mechanics rather than from any implementation:

- **Free fall is exact for the integrator this solver uses.** Bullet
  integrates semi-implicit Euler, so the pose after `n` steps has a closed
  form: `y = y0 - g·dt²·n(n+1)/2`. Measured on `examples/physics-drop.ts`,
  the native run matches it to float32 precision (`1e-7` at magnitude 4) for
  every step before contact. The pinned solver does *not* integrate that way,
  which is the first of the two divergences measured below.
- **A resting body settles at its geometric height.** A sphere of radius 1
  on a ground plane at `y = 0` rests at exactly `y = 1.0`. That is what the
  degenerate-box handling below is measured against.
- **Restitution matches the analytic rebound.** The reached 0.75 coefficient
  puts the first apex within 0.3% of `v²/2g`.

**A pixel comparison against Havok, at a pose where phase does not matter.**
`@babylonjs/havok` is a browser-only devDependency — it is never linked,
never shipped, and reaches nothing in the native binary — so the reference
page can run the pinned physics layer against the real solver and produce a
golden. A *mid-flight* pose cannot be compared: the browser harness
screenshots three seconds after `dataset.ready`, and a free-running
simulation is at an arbitrary step by then, so the two sides are at
different moments and the number means nothing (measured that way,
`examples/physics-drop.ts` reports MAD 2.396, which is phase, not error).
A **resting** pose has no phase: the configuration is static and any
remaining difference is real.

That comparison is also what validates the degenerate-box sink below: the
resting height is not merely analytically plausible, it is the height the
reference puts the sphere at.

**Measured at a moving pose, which is the number that matters.** Scene 40 is
the corpus scene this lane starts at, and the pin's own parity spec freezes
it at `?captureFrame=120` — mid-flight, after two bounces. Both sides stop
themselves at that step, so the comparison is controlled. Measured:

| | Scene 40 at step 120 |
| --- | --- |
| Full / region MAD | 0.332 / 0.777 |
| Pixels exactly equal | 97.74% of the image, 95.07% of the foreground region |
| Where the difference is | edges 11.803, interior 0.559, background 0.032 |
| Displacement | the sphere sits **5 px lower** than the golden's |
| SDL_GPU versus Dawn | 0.000, byte-identical |

Read that as one fact: after 120 steps and two bounces the two solvers put
the sphere a few pixels apart, the silhouette is where the difference lives,
and the shading and both GPU backends agree. It is a solver difference and
nothing else — the backends agreeing to zero puts all of it on the CPU side.
No threshold on this scene can be driven toward zero, and the one it carries
is a regression gate on *this port's* solver rather than a claim about
agreement with the pinned one.

**Measured at rest**, where the configuration is static and phase drops out,
Bullet against the Havok golden, `examples/physics-drop.ts`:
**921,584 of 921,600 pixels exactly identical** — full MAD 0.000056, region
MAD 0.000127, 15 of the 16 differing pixels within one byte and the last a
single antialiased silhouette pixel at 37. The non-background extent, pixel
count and mean RGB match the golden's exactly. Both GPU backends render the
byte-identical frame. So the substitution costs nothing at all where the two
solvers are both converged, and everything it costs is in the transient —
which is where a future measurement should look, and which needs the scene
to freeze itself at a step count (see [TODO](../TODO.md)).

**Which of the two divergences is a setting, and which is not.** The
difference from the pinned solver was decomposed on scene 40 by rendering the
native scene frozen at the same step as the reference and comparing the
sphere's top scanline directly, so no screen-to-world fit sits inside the
measurement. Both sides bounce at the same step -- native step 46, reference
`?captureFrame=47` -- and that one-frame index shift is the two harnesses'
own counters rather than the solvers'.

*The fall is an integrator-order difference, and no setting reaches it.*
Every `btContactSolverInfo` value the Bullet community names for contact
agreement was swept against the per-step trace, which is exact and needs no
reference at all:

| Perturbation | Steps changed | Mean distance from the golden |
| --- | --- | --- |
| none, Bullet's own defaults | — | **5.0 px** |
| `m_restitutionVelocityThreshold` `0.2` to `0` or `0.01` | 0 of 120 | 5.0 px |
| `m_numIterations` `10` to `50` or `200` | 0 of 120 | 5.0 px |
| `m_numIterations` `10` to `1` | 73 of 120 | 5.0 px, sub-pixel |
| `m_linearSlop` `0.005` to `0` | 0 of 120 | 5.0 px |
| `m_linearSlop` `0.005` to `0.05` | 73 of 120 | 12.2 px |
| `m_erp` `0.2` to `0.8` | 0 of 120 | 5.0 px |
| `m_erp2` to `0.8` | 73 of 120 | 6.7 px |
| `m_splitImpulse` off | 72 of 120 | 35.4 px |

Three are *inert* at their defaults here: the impact is far above the
restitution threshold, a single contact point converges in well under ten
iterations, and `m_erp` is unused while split impulse is on. Every
perturbation that *is* live moves away from the golden. The shipped
configuration is Bullet's own defaults because they measured closest, not
because they were selected against the image.

*What the fall difference actually is.* Semi-implicit Euler advances the
position by the already-updated velocity, so it lags the exact solution for a
constant acceleration by `½·a·dt²` every step. Adding exactly that term back
-- as a probe, never as shipped code -- moves the fall and first impact from
`+2, +3, +4` px to `-1, -1, 0` px, and reproduces the whole bounce profile
within one pixel across five consecutive frames. So the pinned solver
integrates constant acceleration to second order and Bullet does not, and
Bullet exposes no flag for it: it is a property of the integrator rather than
a setting.

*It stays unadopted.* The same probe makes the phase after the bounce
markedly worse -- `-6, -13, -21, -28, -32` px against the defaults'
`-2, -6, -10, -11` -- because the rebound impulse is a contact-solver
difference that a position correction perturbs rather than fixes. It buys the
phase already matched to a few pixels and pays for it in the phase that is
not, so the residual stays characterised rather than tuned. Neither the pin
nor upstream's own `ammoJSPlugin` sets anything on its solver beyond gravity
and per-body friction and restitution, so there is no upstream-blessed
configuration to adopt either.

**The degenerate ground box is a real seam.** `createGround` builds a mesh
with a zero-thickness Y extent, and `createPhysicsAggregate(ground, BOX)`
sizes the shape from exactly that box — a plane in Havok's tolerance model
and a zero-volume box in Bullet's, which cannot resolve a contact at all. The
PAL grows any axis below Bullet's own `CONVEX_DISTANCE_MARGIN` to it and
sinks the centre by the same amount, so the box's +axis face stays exactly
where the mesh puts it. Measured: with the sink a unit sphere rests at
`1.000`, without it at `1.040`.

Two things this port does *not* do here, both because they were checked
rather than assumed. It does not read the constructed shape's effective
extent back to compute the sink: `btBoxShape` maintains
`m_implicitShapeDimensions + margin == the constructor argument` (`setMargin`
re-adds the old margin before subtracting the new one), so
`getHalfExtentsWithMargin()` returns its own input and the read-back would be
an identity dressed as a derivation. And it does not set a margin on any
shape, because Bullet's per-shape margin is not one convention — a
`btSphereShape`'s margin *is* its radius, so a single value applied across
shape kinds moves surfaces rather than aligning them.

The sink direction is the one scene assumption in the PAL: it always moves
the centre along the -axis, so the +axis face is the contact surface. That is
right for a ground and wrong for a thin ceiling, and a scene has no way to
say which it meant. No reached scene builds one; a corpus scene that does
should make the anchor face explicit at the seam rather than inherit this
default.

**A scene freezes itself, and both sides honour the same freeze.** Every
corpus physics scene counts its own steps and calls `stopEngine` from a
zero-delay `setTimeout` at the step its `?captureFrame=` query names, so
what pins the pose is the scene rather than the harness. Both are lowered
rather than erased: `stopEngine` is a flag the frame conductor reads, and
`setTimeout(cb, 0)` is a one-shot callback it drains after the frame's own
callbacks — the boundary a browser runs a zero-delay timeout at. Once
stopped the conductor advances nothing and keeps presenting the frozen
frame while a capture is pending, which is the native equivalent of the
browser harness screenshotting a canvas whose render loop has been
cancelled. Seventeen of the corpus's twenty-one `setTimeout` call sites
pass a delay of 0, which is the reached slice; the four real waits (scenes
44, 48, 156 and 173) refuse rather than becoming "next frame", which would
be a different scene. Babylon Native, which embeds a JavaScript engine and
must serve any delay, needs a timer thread and a time-ordered queue for
this; none of that applies where the frame conductor is the only thread.

**Two ordering repairs belong to the PAL, not to the semantics.** The pin
configures a body in Havok's order — create, motion type, add to world,
transform, shape, material, mass — and Havok reads each write live. Bullet
takes a body's collision group, its broadphase proxy and its gravity from
the state it had when it was *added*, and a shape's centre offset is not
known when the transform is written. Both are absorbed in
`pal_physics_bullet.cpp` by re-adding the body and re-applying the recorded
transform; the pin's order is preserved above them. Neither is a semantic
change, and each was found by measurement rather than by reading: without
the first the sphere never falls, without the second it rests 0.04 high.

**Havok's combine modes are applied, not approximated.** The pin passes
`MaterialCombine.MINIMUM` for friction and `MAXIMUM` for restitution.
Bullet's default is the product of the pair, so both rules are applied on
the contact manifold callback instead.

Three more PAL-level equivalences are documented where they happen in
`pal_physics_bullet.cpp`: the step is pinned to a single sub-step
(`stepSimulation(seconds, 0, seconds)`, quoting the pin's own no-substepping
comment), a kinematic `SetTargetQTransform` maps to `set_transform` (no
corpus scene exercises an ACTION prestep yet), and a material whose static
and dynamic friction differ refuses rather than averaging.

## Audio contract

**The seam is the pin's own, and it is the Web Audio API.**
`packages/babylon-lite/src/audio/` is a behavioural port of Babylon.js
AudioV2 whose entire platform reach is `AudioContext`, `GainNode`,
`PannerNode`, `StereoPannerNode`, `AnalyserNode`,
`AudioBufferSourceNode` and `AudioParam`, plus the `document`/`navigator`
hooks in the modules this port refuses. Where `createHavokWorld(scene,
hknp)` takes its solver as a parameter, audio takes the *browser* — so
`native/include/bblite/pal_audio.hpp` mirrors Web Audio, and buses, the
sound sub-graph, ramp shapes and the sound state machine stay Babylon
behaviour.

**No corpus scene reaches it.** The reach is upstream's seven *game* demos,
which use the Lite engine for lifecycle only (`createAudioEngineAsync`,
`engine.audioContext`, `createSoundSourceAsync`,
`unlockAudioEngineAsync`) and then build their own raw Web Audio graph on
the context they are handed. The eighth consumer is `audio-demo.ts`, the
audio module's own Tier-4 showcase, and it is the one place
`createSoundAsync`/`playSound`, the microphone, the visualizer and the
unmute UI are reached at all; upstream marks it manual and
non-deterministic, never a gate. Nothing published is gated on audio, and
the slice is a prototype: [TODO](../TODO.md) carries what remains.

**The engine's output graph is folded, and the fold is gated.**
`createAudioEngineAsync` builds `mainBus -> mainOut -> ctx.destination`
— three statements — so the shape is the contract and
`src/compiler/intrinsics/audio.ts` emits it at the reaching call site.
`src/lowering/audio-lowerer.ts` is the other half of that bargain: it
emits nothing and asserts every statement against the pinned declaration
that states it, including the one the fold omits
(`setMainOutVolume(engine._mainOut, engine._volume)`, inert only because
`_volume` defaults to `options.volume ?? 1`, which is therefore what gets
checked). A moved contract fails generation naming the declaration.

**`setMasterVolume` refuses, because the pin has no un-ramped form.**
`setMainOutVolume` goes through `setRampTarget`, whose shape defaults to
`"linear"` and whose duration defaults to the engine's `_rampDuration`
(0.01 s) — above `MinRampDuration`, so even a call passing no options
schedules `cancelScheduledValues(0)` and a two-point
`setValueCurveAtTime`. An instantaneous write would be a substituted
behaviour wearing a subset's clothes, so the call refuses until
`audio-param.ts`'s curve component is lowered.

**The engine under the seam is LabSound, and that is the one thing here
a measurement cannot close by construction.** LabSound is a fork of
WebKit's own WebAudio implementation with the copyleft code removed, so
the node graph, the parameter timeline and the panner math are the same
algorithms rather than a second design — the relationship navigation has
with recastnavigation rather than the one physics has with Bullet. It is
still a different codebase from the one that produced the references,
and it has diverged for a decade, so agreement is expected rather than
guaranteed. Recorded per scene as `substituted-audio-engine`. Two
divergences are known and translated in the PAL: a `StereoPannerNode`'s
`pan` is declared with default 0.5 over 0..1 where Web Audio specifies
0.0 over -1..1 (only the descriptor differs — the DSP clamps to [-1, 1]
and `setValue` does not enforce a range — so an unset panner would sit
right of centre), and a context's rate and channel count are the
device's, because `new AudioContext()` takes neither.

**Audio produces no pixels, so it is measured as PCM.**
`BBLITE_AUDIO_CAPTURE=<path.wav>` makes every context the scene creates
render offline: the same graph, no device, no thread, and the clock
advances only inside the render, which happens at the end of
`pal::run_engine` — the one place a run ends, the same seam
`CaptureGate` takes a screenshot at. The WAV and the reported
frames/peak/RMS come from one captured bus, so they are the same bytes
by construction. `examples/audio-probe.ts` measures 48000 frames at
48 kHz, peak 0.032524, RMS 0.004254, byte-identical across runs, with
the per-100 ms RMS rising monotonically as its own
`exponentialRampToValueAtTime` says. The pinned engine accepts an
`OfflineAudioContext` through `createAudioEngineAsync({ audioContext })`
for exactly this reason, so the browser half of a PCM comparison already
exists; that comparison is the gate this slice still lacks.

## What is measured: the canvas, not the page

**DOM content is out of scope.** A parity measurement compares the native
frame against the browser's `#renderCanvas` and nothing else. Before every
golden screenshot the capture hides the canvas's siblings
(`hideNonCanvasChrome`, `src/browser-harness.ts`), so anything a demo page
draws in HTML is absent from both sides of the comparison.

This is a real limitation, not a formatting choice:

- **The native runtime has no DOM and never will at this seam.** It draws a
  frame; it does not lay out or paint HTML. A page widget left in the golden
  would measure a browser control against a renderer that cannot have one.
- **Scenes do append their own controls.** Scene 4 is the reached case — two
  toggle buttons positioned over the canvas. They are 19,800 pixels at
  MAD 51 against 0.000 everywhere else in that scene, so they would have
  been the whole of its residual.
- **A scene whose rendered output DEPENDS on that DOM is not integrable
  as-is.** The controls are hidden, not clicked: whatever the page shows on
  load is what is measured. A scene needing a button pressed first would
  need its pose expressed in scene source, the way every other reached
  scene's is.

Hiding is done at capture time and touches nothing else — not the scene, not
the canvas, not anything the scene drew into it. For a page with no such
elements it is a no-op, which is why re-capturing an already-shipped scene
reproduces its committed golden byte for byte.

## Parity reports

Reports name the backend they measured and include:

- full and foreground RGB MAD
- exact and within-1/3/5-byte ratios
- per-channel MAD and signed foreground bias
- background, high-gradient edge, and interior MAD
- highest-error tiles
- renderer/backend metadata

Interpretation:

| Signal | Likely source |
| --- | --- |
| background | clear color, skybox, ground, image processing |
| edges | camera, winding, depth, coverage, MSAA |
| interior | material inputs, color spaces, BRDF, IBL |
| uniform RGB bias | exposure, gamma, tone mapping |
| localized hotspot | one draw, material, texture, or mesh region |

## Attribution

Registry-enabled scenes can emit draw IDs and triangle-cluster IDs — the
`--id-diagnostics` generation option adds the ID outputs to the composed
shaders. Reports
join those IDs to glTF nodes, meshes, materials, alpha mode, and double-sided
state.

**A post-process pass draws the module the pin composed, and reads the
parameters the pin's own writer places.** Every effect Babylon Lite ships is
one `createPostProcessTask` differing only in a `_shader` record, so the
factory is *executed* at generation against a descriptor-only render target
and the pin's own `getShaderModule` concatenates the module that deploys —
byte-identical to the one an instrumented capture shows the browser
compiling for Scenes 142 and 143. Executing rather than folding is the
blur's doing: its kernel decides how many taps the vertex stage carries, and
each tap's offset and weight is a Gaussian evaluated in doubles and printed
through the pin's own `toFixed(7)`, so folding would mean restating an
integration, a rounding rule and a formatter. The uniform half is lowered
instead, from each effect's own `writeUniforms` body, because its values
depend on the real attachments — the blur's delta is the direction over the
output extent, the chromatic aberration's screen size is the source's — and
because the pin's split between mutating a parameter and uploading the block
is what `updateUniforms` means. Two rules the emitted pass takes from the
pin rather than from its siblings: the pipeline's sample count is the
*output target's*, and the normalized viewport rounds its far edges up where
a copy task's rounds them down.

**A composite's inline pass is read off the composite, because the pass
publishes nothing.** Every post-process the pin ships builds its pass through
a leaf factory whose module declares the `_shader` — except bloom's merge,
which `bloom.ts` builds by calling `createPostProcessTask` directly with a
`_shader` written inline. That closure captures the composite's own `params`,
so the merge task carries no `weight` to read and its own module carries no
default to check: both are declared inside `createBloomPostProcessTask`. The
observation therefore watches `createPostProcessTask` beside the leaves — the
seam is keyed by relative specifier, so that entry point is nameable like any
other — marks the pass it produced, and reads its parameters off the composite
the factory returned. The effect row names the pinned function that declares
its `_shader`, which is what keeps its own name out of the composite table's
key space.

**A name a pinned module declares is read off that declaration.** A pinned
body may reach a module-scope `const` of its own file — `extract-highlights.ts`
raises its threshold to gamma space through `TO_GAMMA_SPACE` — and the
translator resolves such a name against the module being lowered rather than
requiring every caller to pre-bind it. The initializer is lowered rather than
folded, so the arithmetic stays the pin's, and a constant this translator
cannot lower fails by the name that reads it. Only what the module does NOT
declare — an import, or a value the caller owns — travels through the caller's
bindings, which is the rule `pinned-shader-text.ts` already states for the
shader-text evaluator.

**A depth attachment another task owns is loaded, not cleared.** The pin's
geometry renderer publishes its depth as an eager wrapper target, and
`createRenderTask`'s `const loadOp = (config.depth ? depthSrc._eager : ...)`
turns that eagerness into a load: the borrowing task neither builds nor
disposes the attachment, and the task that wrote it stores rather than
discards it. Scene 147 reaches it, sharing one depth buffer between the
geometry pass that produces its normalized view depth and the colour pass
whose result the circle of confusion ignores.

`attachControl` and `attachFreeControl` register input on the camera they
are handed and make no camera the scene's, which is what lets Scene 142
render its right eye through the scene camera and its left through a render
task's own. A task with its own camera carries its own copy of the pin's
per-pass scene block; a second camera moves the view-projection and the eye
position and no other value in it.

Scenes 145 and 146 gate the separate production geometry-renderer path: all
eleven geometry texture types, split 7+4 MRT passes, optional real color,
independent depth, viewport copies, and MSAA resolve.
Frame-graph depth targets select a supported D32/D24 sampled depth format,
matching Babylon Lite's `depth32float` geometry-target contract.
The `scene geometry` diagnostic command selects each existing copy task
full-screen in the capture harness and native PAL without modifying curated
scene sources. It emits per-attachment Babylon Lite/native/diff images and a
JSON report under `artifacts/parity/<scene>/geometry`. Both sides select by
task *name*: the native frame loop reads `BBLITE_COPY_TASK` and the capture
harness serves a module that re-exports the pinned package with
`createCopyToTextureTask` wrapped, so a name carries the same meaning through
either path. Selecting by name rather than by rewriting the scene source is
what reaches Scenes 145, 146, and 149, whose copy tasks are built in a loop
over a texture array — their names exist only as
`` `sceneNNN-impostor-${entry.name}` `` and their viewports are computed from
the loop index, so no per-task literal exists to rewrite. The task list comes
from the generated entry point, where the compiler has already unrolled that
loop.
Standard double-sided materials disable culling but do not flip fragment
normals; scene 145's full-resolution view/world-normal attachments gate the
distinction.
Mirrored double-sided PBR meshes retain their authored index order and select
a clockwise front-face pipeline, preserving Babylon Lite's
`front_facing`-driven normal flip in Scenes 168 and 266.
A glTF primitive with no `NORMAL` accessor takes the pinned `_flatNormal`
path, which composes `normalize(cross(dpdx(worldPos), dpdy(worldPos)))` into
the fragment. World position interpolates linearly across a triangle, so that
expression is constant over the face; the native loader folds it by
un-indexing the primitive and baking the face normal into the three vertices
each triangle then owns. Gated by scenes 240, 246, 255, 259 and the track-clamp gate.
Triangle-strip primitives (glTF mode 5) expand to the triangle list they
describe as the loader builds the index run: primitive `i` is
`(i, i+1, i+2)` with odd `i` swapped, the expansion every WebGPU, Vulkan and
D3D rasterizer performs, so the triangles, their winding and their submission
order match what the pinned engine hands to `topology: "triangle-strip"`.
glTF forbids an index equal to the component type's maximum precisely so
clients need not handle primitive restart, which makes the run contiguous.
The expansion belongs to the loader rather than the pipeline because a face
normal needs each triangle to own its vertices, and Scene 260 — a strip with
no `NORMAL` — needs both. Dawn, which compiles and rasterizes through the
browser's own stack, renders it byte-identical to the golden.

Points (mode 0), lines (mode 1) and line strips (mode 3) describe primitives no
triangle list can express, so they reach the pipeline as themselves. The
fixed-function state is `buildPrimitiveState`'s own: the topology, `cullMode:
"none"` for every one of them — points and lines have no faces to cull — and
WebGPU's `stripIndexFormat` beside a line strip, which the loader's uint32
index buffer settles. Each is one `RenderPipelineKind` per blend state rather
than one per cull and winding combination, because neither of those reaches a
primitive without faces. Three triangle-list rules are skipped with them: the
divisible-by-three index count (a line list is divisible by two and a point
list by nothing), the mirrored-transform winding swap, and the flat-normal
deindex. That last one is a refusal rather than a skip — the pin's own
flat-normal expression is
`normalize(cross(dpdx(worldPos), dpdy(worldPos)))`, which needs a fragment
quad with area to differentiate over, and a one-pixel line gives it none — so a
non-triangle primitive with no `NORMAL` accessor fails at load. LINE_LOOP (2)
and TRIANGLE_FAN (6) are the two modes WebGPU has no topology for at all;
upstream leaves them as a triangle list, matching a legacy engine that cannot
render them either, which draws a different shape rather than the authored one,
so they are refused rather than mirrored.

Only the pinned colour pipeline carries a topology: the depth-only pipelines a
transmission grab pre-passes through, and the geometry-output tasks, are built
at a triangle list for every draw they take. A scene reaching both a
point-or-line primitive and one of those passes therefore refuses at
generation, rather than silently pre-passing a line as a triangle.

All of it is gated on the `nonTrianglePrimitives`
specialization flag, which is the predicate behind Babylon Lite's own
dynamically imported `gltf-feature-primitive.js`: a scene whose assets are all
triangle lists emits a loader that carries no topology handling at all, which
is where upstream keeps it too. The glTF topology gate measures all three
modes beside the triangle list they draw next to, each carrying vertex
colours.
Standard bump maps compose the pin's own `normal-map-fragment`
(`HAS_BUMP_TEXTURE`), whose `WGSL_PERTURB_NORMAL` helper builds the cotangent
frame from screen-space derivatives, so a mesh needs no tangent attribute,
and the interpolated normal is scaled by 1 over the texture's `level` before
the frame is built. The pair binds through the generated texture-slot table
(`material_texture_slots.hpp`), whose rows append in a fixed order — the base
slots, then the transmission, extension, uv2-occlusion, Standard bump and 2D
reflection pairs — so no existing slot index moves when one appears, and each
variant's bindings are reflected from its own composed WGSL. A material with
no bump map composes a variant that never declares the pair and keeps its
interpolated normal.
A `.babylon` light applies to the meshes its `includedOnlyMeshesIds` names, or
to every mesh its `excludedMeshesIds` does not, resolved at load against the
records the loader creates. The per-mesh count and index selection uploaded
with each draw therefore hold the light set of the mesh being drawn, which is
the set the pinned template's `min(mesh.lc, MAX_LIGHTS)` loop walks.
`KHR_node_visibility` is materialized per mesh rather than tested per draw.
The pinned `setSubtreeVisible` writes the flag on a node and every descendant
at set time, so the loader bakes the ancestor cascade into each mesh record
and the render path and default-camera framing each test one boolean.
`KHR_animation_pointer` material targets write the record the fragment reads
back every frame: base color factor, emissive factor, and the
`KHR_materials_emissive_strength` scalar. That strength folds into the
emissive factor at load, so animating either half keeps both apart and redoes
the product whenever one moves. Their samplers are LINEAR, and the writers are
gated on a scene whose animations actually name a material, matching the
pinned split where the base pointer module resolves node targets and material
targets pull their own.
`KHR_animation_pointer` also reaches `/nodes/N/extensions/`
`KHR_node_visibility/visible`, which the pinned base module resolves without
its material, light, or camera companions; the sampler must be STEP, because
the animated value is a boolean and interpolating one has no meaning. Every
other pointer fails at load naming the pointer it could not resolve.
An animated primitive keeps local vertices and receives its node matrix each
frame, so the box the loader accumulates while reading it is local, while a
static primitive bakes that matrix into its vertices and accumulates a world
box. The loader records the world box separately, transforming the local one
through the node matrix the way the pinned `expandWorldAabbForMesh` does, so
that framing an animated asset with the default camera sizes it where the
geometry actually is. Scene 7, the other scene composing the two, frames
identically either way because its animated root sits at the origin.
A public scene-code `boundMin` or `boundMax` assignment replaces that side of
the mesh's object-local box before the same world transform is applied. It is
not folded into procedural dimensions: doing so dropped Scene 26's tiny light
sphere override from default-camera framing and made the dragon visibly too
large. Keeping the two optional sides on `MeshRecord` reproduces the pinned
frame before the sphere later moves with its point light.
Orthographic cameras write the pinned reverse-Z off-center projection term by
term, with the four planes derived from the half-extent and the render target's
aspect ratio. The pinned writer runs in JavaScript doubles into a
`Float32Array` cache, so the native branch computes in double and stores float,
which reproduces Scene 268 exactly on both backends. Only the scene projection
takes that branch: environment skyboxes and grounds build their own perspective
view-projection, and generation fails on the combination.
Standard vertex colors follow the pinned `enableStandardVertexColors` opt-in
and compose per mesh, exactly as upstream does: under the opt-in, a mesh
carrying a colour buffer sets the vertex-colour bit in the generated
mesh-feature table, and only its variants compose the pin's own
`_stdVertexColorFragment` — the RGB multiply against the diffuse. The
fragment's `vertexAlpha` half stays off, because the `mesh.hasVertexAlpha`
setter is not lowered. Scene 267 gates it and is byte-exact
on both backends.

Scenes 145 and 146 resolve each geometry attachment at full resolution, then
bilinearly downscale it into one of twelve preview regions on a 4x-MSAA target
before the final mosaic resolve. Babylon Lite floors each normalized viewport
edge to integer target pixels and applies the same rectangle as a scissor.
Fractional viewport bounds without that scissor introduce partial-sample
coverage at tile boundaries, so native preserves the JavaScript
double-precision viewport expressions and the pinned floor/scissor contract.
Inspect the full-resolution attachments with
`npm run scene -- geometry scene145|scene146`.

## Validation policy

There is no hosted CI. A validated milestone keeps:

- renderer-specific actual, diff, hotspot, and attribution images
- renderer-specific JSON reports
- manifests, fidelity records, and provenance
- measured local thresholds in `src/scene-registry.ts`

GPU results are device-specific and must record the selected backend. Golden
images are evidence, not tuning targets: fixes must follow upstream semantics
or metadata rather than scene or pixel heuristics.

On Windows, runtime topology changes wait for GPU idle before appending
resources, and screenshot/diagnostic capture defers one frame
([architecture](architecture.md#renderer) carries the deferral contract and
its bounded grace period).
