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
| `upstream/shaders/shader-compiler.json` | pinned compiler backend and executable hashes |

Current intentional adaptations include browser-wrapper erasure, immediate AOT
`await`, compile-time asset materialization (drawn sprite atlases and HDR
cubemaps included), the SDL platform boundary, the native shader backends,
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
`computeSH`, Draco and meshopt decoded by the pin's own decoder builds — are
deliberately not recorded per scene, because the browser and the native
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

The original Babylon Lite parity history is supporting evidence for numbered
scenes because those scenes were built as Lite-versus-Babylon Legacy
differential tests. Review the scene pair, introduction PR, review discussion,
and pre-pin follow-up fixes during integration. Historical MAD floors and root
cause notes help classify native residuals, but generated behavior must still
be derived from the pinned source rather than copied from an old workaround.

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

The custom-material WGSL pipeline now reflects uniform layout, binding order,
attributes, varyings, stages, and entry points; PAL shader creation consumes
the reflected uniform-buffer counts. Pinned Tint emits native HLSL/MSL from
the specialized WGSL; register normalization and DXC produce SDL-compatible
DXIL/SPIR-V.
The project-owned `audit-shader-frame-graph` differential gate is pixel-exact
against pinned Babylon Lite and verifies that alpha-card and circular-cutout
materials retain their pipelines and uniforms when a frame-graph render task
mirrors the scene. It is regression coverage, not upstream corpus coverage.
GridMaterial WGSL is built by evaluating the pinned template functions at the
reached option sets, with scene 213 gating its dynamic native specialization.
Ground and skybox fragments are lifted from the pinned modules' own string
literals, gated by Scenes 1 and 8.
The shared material vertex stage is generated WGSL, and Standard draws run
both stages of the pin's own composed variants — `standard_variants.hpp`
plus the deployed `variant-std-*` files — gated by scenes 145 and 273.
The PBR body itself is Babylon's own, on every draw. Generation composes one
fragment per renderable feature set through the pinned composer — the stages
under `upstream/pbr-variants/` are its output byte for byte, gated by a test
that matches them against the browser's captured fragments — and both
backends execute them for the whole corpus: every extension arm, all three
light modes, tone mapping, fog, tangent frames, skins and morphs, thin
instances, transmission with the pin's own linear passes and refraction grab,
the geometry-output MRT arms, and the no-color depth views. Each variant
carries the pin's own per-variant material UBO, mirrored field for field with
a static_assert per offset, and filled by writers lowered from the pin's
`_writeMaterialData` and each extension's `writeUbo`. The transcribed PBR
fragment is deleted; a PBR draw that resolves no variant is an error naming
its mesh and material, never a fallback.

The layer helpers arrive the same way. `visibility_Kelemen`,
`getR0RemappedForClearCoat`, `ccSchlick`,
`normalDistributionFunction_CharlieSheen`, `visibility_Ashikhmin`, and the
whole `iri_*` thin-film stack with its `IRI_XYZ_TO_REC709` matrix are not
transcribed anywhere: they reach the deployed stages inside the pin's own
composed fragments, under the pin's own names. There is deliberately no
transcribed fallback — a fallback is the copy that drifts — so a helper the
pin renames or drops fails generation, through the composition itself or a
marker assertion naming it, instead of becoming a shading bias.

The same composer is used as a cross-check on the emitted set. Generation
runs every glTF material the scene loads through the pin's own
`_computePbrMaterialFeatures` and refuses to emit a variant set missing an
arm one of them composes, naming the material and the arm
(`src/pinned-material-arms.ts` `assertArmsCovered`). The variants are
per renderable already; the check is what keeps a missed arm a generation
error instead of the small systematic shading bias it would otherwise
render as, which is the failure mode every entry in the layer section below
shares.

HDR environments preserve mip zero and use the pinned WebGPU 1024-sample GGX
prefilter for higher mips. The generated package records the pinned module,
shader, source commit, and sample count.
`EXT_lights_image_based` likewise materializes Babylon Lite's 256-square,
1024-sample BRDF integration directly as RGBA16F and uploads decoded RGBD
cubemap faces with the same half-float quantization as WebGPU.

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
  the result into base F0 by the iridescence intensity (Scene 178)

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
IEC formula measurably disagreed with the GPU's table; scene 255
gates the texel-level port. The record keeps the raw alpha for the
pinned blend semantics.
An **animated** base color factor inverts that bake. `whiteFallback` in
`animation-pointer-basecolor.ts` swaps the factor for `[1,1,1,1]` before
the upload whenever a `KHR_animation_pointer` channel drives it and the
material has no base color image, and hands the real factor back to be
carried as a UBO field for the pointer writer to overwrite. Baking it as
well applies the factor twice — the authored value in the texel and the
animated value in the uniform, against the browser's uniform alone; Scene
253 gates it. Because materials are built before
animations are read, the answer has to be gathered in a pre-pass, which is
what upstream does and what the generated loader now does.
Environment horizon occlusion applies only to normal-mapped materials:
the pinned `ibl-fragment` composes `eho = 1.0` without a normal map,
and each material's composed variant carries whichever arm its features
produce, so the factor follows the material by construction. Scene 247's
metallic teapots gate this — applying the
polynomial unconditionally darkened silhouette speculars by one MSAA
sample step across the instance field.
Node TRS and world-matrix composition run in double precision and
round once per component at the float32 store, matching JavaScript's
number semantics in the pinned `mat4ComposeInto` and matrix multiply;
this makes native glTF instance matrices bit-identical to the
browser's uploaded thin-instance buffers.

**The camera's scalars are doubles, and each float32 store in the chain is
one the pin performs.** `alpha`, `beta`, `radius`, `target`, `position`,
`fov`, `nearPlane` and `farPlane` are plain JavaScript numbers upstream,
which `src/camera/camera.ts` reads into the view and projection writers at
that precision before storing into the `allocateMat4()` `Float32Array`
caches. `CameraRecord` keeps them as `double` and `Vec3d`, and the chain
reproduces the pinned stores in order: `camera_world_matrix`
(`mat4LookAtWorldLHToRef` over the eye `arc-rotate.ts` composes),
`build_view_matrix` (`getViewMatrix`, reading that float32 world matrix
back), `mat4PerspectiveLHToRef`, `mat4MultiplyInto`. A float record would
round one store early, and that is not a rounding-sized difference:
`Math.PI / 2` has `cos = 6.1e-17` as a double and `-4.4e-8` as its float32
neighbour, which moves the whole second row of the view matrix.

**The clip-z row is the one departure, and it reaches nothing else.** The
pinned perspective maps `near -> 1` and `far -> 0`; the native main pass
keeps `near -> 0`. `mat4PerspectiveLHToRef` writes only `[0]`, `[5]`,
`[10]`, `[11]` and `[14]`, so in the composed view-projection clip `x`,
`y` and `w` are products of rows `[0]`, `[5]` and the view's own `z` row,
and `[10]`/`[14]` reach clip `z` alone. Against the browser's uploaded
matrix, that is the whole of the difference: thirteen of the sixteen
elements are equal bit for bit and the three that are not are that row.

**A depth convention cannot move a coverage mask, but it can move a
varying — through the near-plane clipper.** Unclipped geometry is
unaffected, which is why the position-seeded dither reproduces without
adopting reverse-Z. A triangle that straddles the eye plane is another
matter: the clipper generates new vertices and interpolates their
attributes from clip space, `z` included, so a differing `z` row shifts
the interpolated varying in its last bits across the whole clipped
triangle. Scene 7's solid skybox measures it exactly: its cube is centred
on the eye, so its side faces straddle the eye plane, and the `+X` face
carries ±1 errors thinning to zero at the untouched vertices until the
draw binds the pin's own reverse-Z row. That is why
`build_solid_skybox_scene_uniforms` builds its own view-projection: the
draw writes no depth and is first in the pass, so the convention reaches
its clipping without reaching any depth test. Grounds cannot take the
same route — they test against the opaque pass — so a ground quad the
camera stands inside keeps this residual until the renderer adopts the
pinned convention outright.

**The pinned background dither reproduces on both backends, and which
fragment carries it is a pinned fork.** `WGSL_DITHER` seeds
`fract(sin(dot(worldPosition.xy, k)) * K)` on the interpolated world
position, whose low bits follow the barycentrics, so it reproduces only
where the composed view-projection agrees with the pinned engine bit for
bit. It is the whole of the background residual on a scene whose
background is otherwise flat: Scene 6 measures 0.314 background
attribution without it and 0.000 with it, on SDL_GPU as well as Dawn —
offline DXC compiles the hash to the same result the browser's compiler
does.

The fork is upstream's. `background-ground.ts` and
`background-dds-skybox.ts` prefix `WGSL_DITHER` (behind their shared
`enableNoise`, whose default is `true` and which no corpus scene sets),
`background-solid-skybox.ts` prefixes it unconditionally, and
`background-hdr-skybox.ts` — the arm an environment cubemap skybox takes
— composes none at all. One generated fragment serves the DDS and
environment skyboxes, so each PAL picks the dithered variant except when
`skybox_uses_environment`. Dithering the environment arm is not a small
error: it puts ±1 on roughly half the background pixels of Scenes 8 and
21, which is 0.129 to 0.343 and 0.330 to 0.537 full MAD.

**The solid-colour skybox is a third arm and carries its own pair of
stages, taken from the pinned package rather than composed here.** A scene
that loads an `.env` environment and names no DDS or `.env` skybox — and
does not pass `skipSkybox` — reaches `buildSolidSkyboxRenderable`, a cube
shaded from the scene clear colour with the dither added unconditionally
and no image processing at all. Its vertex stage is the one arm that is
not root-positioned: `(mesh.world * vec4(pos, 0)) + scene.vEyePosition`
drops the world translation through `w = 0` and follows the camera, so
the dither seed is `pos + eye` rather than the DDS arm's
`pos + rootPosition`. Both stages ship as `?raw` string literals with no
source-map entry, so generation reads them out of the packaged module and
re-emits the pin's own struct members and statement bodies; only the
`@group`/`@binding` declarations are re-addressed, because SDL_GPU fixes
vertex uniforms at register space 1 and fragment uniforms at space 3
where the pin binds at WebGPU groups 0 and 1. The native mesh block is
the pin's 96-byte layout field for field, which is why a render capture
pairs against the browser's own upload. Scenes 7 and 146 reach it.
glTF occlusion follows Babylon's `buildDefaultPbrTexturesExt` contract: an
`occlusionTexture` on TEXCOORD_1 without a metallic-roughness image keeps the
factor-driven ORM slot and binds the occlusion image through a dedicated
texture pair sampled at uv2 (the pinned `occlusionOverride` replaces the ORM
red channel; the native loader reads TEXCOORD_1 for this), while a TEXCOORD_0
occlusion image without a metallic-roughness image becomes the ORM texture
itself with the glTF metallic and roughness factors reverting to the engine
defaults of 1.0, exactly as `assemblePbrPropsExt` passes them only alongside a
metallic-roughness image. Distinct occlusion and metallic-roughness images
(upstream's canvas composite) and occlusion on TEXCOORD_1 alongside a
metallic-roughness texture stay unreached and fail explicitly. Scene 243
gates the uv2 pair through MorphStressTest's baked-AO platform.
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

**The background skybox cube culls back faces; only the image skybox does
not.** The DDS, HDR, and solid background skyboxes build their pipeline through
the pinned `createDefaultPipelineDescriptor`, whose `_cullMode` default is
`"back"`, and none of them overrides it; `skybox-cubemap.ts` is the one that
passes `_cullMode: "none"` explicitly, so the `loadSkybox` image skybox keeps
it. The distinction only becomes visible once the camera leaves the cube. From
inside, each ray meets exactly one face and the near plane clips the rest, so
an unculled cube renders identically; from outside, the entry and the exit face
are both rasterized, and because the skybox writes no depth the later face in
index order wins rather than the nearer one. The two faces last in that order
are `+Y` and `-Y`, which is what an unculled cube showed: a hard-edged
quadrilateral of `-Y` — the projection of the plane through the cube centre —
over a `+Y` surround, where the pinned cube shows one continuous sky. No gated
pose reaches it, because every gated camera sits inside its own skybox; Scene
14 at `cam.beta = 0.55` puts the camera above the cube and reproduces it.

Embedded image-based lights evaluate SH unclamped. Environment rotation
affects SH and cubemap lookup directions, while horizon occlusion
intentionally uses the unrotated reflection vector.

glTF animation uses pinned LINEAR quaternion interpolation and deterministic
time seeking, plus CUBICSPLINE quaternion/translation interpolation where
reached. Morph position/normal deltas are applied before recursive skinning;
generated joint palettes and morph weights drive the deformation stage.
Every morphed mesh uses Babylon's pinned uncapped storage-buffer path
(`morph-fragment-core.ts`) — the pin's one morph mechanism, compiled in for
any morph target at all: a flat 6-float delta buffer and a weights
buffer with the 16-byte `{count, vertexCount}` header, accumulated in
ascending target order before skinning, with source-marker assertions
pinning the loop, indexing, and header ABI. Scene 243 gates it.
Primitives without source normals remain
deindexed and use a narrow CPU fallback to recompute post-deformation face
normals, while their positions are still GPU-skinned. See
[Architecture](architecture.md#animation-and-deformation) for layout,
specialization, and fallback limits.
Static `EXT_mesh_gpu_instancing` preserves Babylon Lite's split transform
contract: extension matrices remain local T/R/S data and the node world matrix
is applied separately in the vertex shader.
The project-owned `regression-track-clamp` gate is pixel-exact at 3 seconds
and verifies that shorter translation, rotation, and morph-weight channels
hold their final values while a separate channel determines the animation
duration.
An audited static-skin experiment was not retained: applying skin deformation
without an animation array diverged from the pinned Babylon Lite output, so it
would require an explicit fidelity adaptation rather than an ordinary fix.

Pinned property animations compile static clips and groups into typed native
records. LINEAR scalar/vector interpolation, quaternion slerp, STEP holds,
frame/time ranges, looping, speed ratios, and deterministic group seeking are
generated from the reached Babylon Lite APIs.

Direct `createMorphTargets` accepts one position target, nullable normal
deltas, one initial weight, and one mesh attachment. It rides the same
pinned storage-buffer morph path as glTF. `createSphereData` returns arrays derived
from the generated sphere geometry, so procedural delta functions consume the
same base positions the renderer draws. Scene 252 is the StandardMaterial
parity gate for this contract.

Scene 151 gates directional-plus-hemispheric Standard lighting and is
pixel-exact. The supported light-count boundary is recorded in
[Features](features.md#lights).

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
them. Scene 15 is the spot parity gate, byte-identical across both backends.

**The emissive texture is sampled at the raw UV, never through its own
transform.** Every other slot samples through the UV its
`KHR_texture_transform` builds, and the emissive slot's transform is parsed,
animated and uploaded exactly like them — but
`createEmissiveColorFragment` hardcodes
`textureSample(emissiveTexture,emissiveSampler,input.uv)`, and the composed
shader an instrumented capture recovers computes `emissiveUV` on the line
above and then ignores it. The generated fragment matches that. It is only
observable when a material carries both an emissive texture and a non-identity
emissive transform, which in this corpus means Scene 39, whose water animates
one: sampling through the transform scrolls an emissive texture the browser
holds still.

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
different fragments rather than one fragment with a uniform. It is worth a
material amount of light: Scene 19's white dielectric sphere has a base F0 of
0.04, and its ior-2.0 coat remaps that to 0.0204, so omitting the slot left
every sphere pixel one channel step bright. Scene 19 gates the remap and Scene
28 gates its absence.

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
native reader serves both. Two differences from the HDR loader are the pin's
own and are carried through: a DDS environment uses LOD generation scale 0.8
rather than 1.0, and it writes no image-processing state at all, where the HDR
loader sets exposure, contrast, and tone mapping.

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

DXC stays mandatory on the SDL_GPU offline paths — Tint emits no DXIL, and
Vulkan temporarily recompiles normalized Tint HLSL through DXC
([features](features.md#stage-2-compiling-wgsl-for-the-device) tabulates the
paths and the binding-remap gap).

Tint HLSL is normalized before DXC so texture and sampler registers are dense
and corresponding, as required by SDL_GPU. D3D system-value inputs are ordered
to preserve the vertex/fragment signature convention used by the existing
native pipelines. Tint discard statements are lowered to `clip(-1.0)` to avoid
a D3D12 command-list failure in multisampled pipelines while preserving
fragment-kill semantics.

## Parity reports

Reports separate CPU and GPU renderers and include:

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
each triangle then owns. Scenes 240, 246, 255, 259 and the track-clamp gate
measure the fold byte-exact on both backends.
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
browser's own stack, renders it byte-identical to the golden. Point, line and
line-strip modes describe primitives no triangle list can express and fail at
load by mode number. All of it is gated on the `nonTrianglePrimitives`
specialization flag, which is the predicate behind Babylon Lite's own
dynamically imported `gltf-feature-primitive.js`: a scene whose assets are all
triangle lists emits a loader that carries no topology handling at all, which
is where upstream keeps it too.
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
The full-resolution attachment maxima remain `0.067` and `0.057`; use
`npm run scene -- geometry scene145|scene146` to inspect them individually.

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
