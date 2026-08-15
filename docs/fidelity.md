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
| `upstream/renderer-fidelity.json` | shader bindings, formats, formulas, invariants |
| `upstream/shaders/shader-material-reflection.json` | reached custom WGSL entry points, interfaces, and uniform layouts |
| `upstream/shaders/*.wgsl` | reached custom material source before typed IR lowering |
| `upstream/shaders/*.native.wgsl` | SDL binding, location, and depth specialization passed to Tint |
| `upstream/shaders/*.tint-reflection.txt` | Tint entry-point resource bindings checked against native WGSL |
| `upstream/shaders/shader-compiler.json` | pinned compiler backend and executable hashes |

Current intentional adaptations include browser-wrapper erasure, immediate AOT
`await`, compile-time asset materialization, SDL input translation, native
shader backends, disabled cross-backend position-seeded background dither, and
opt-in ground composition. Scenes reaching the plain-data language slice add
the value-copy object model (`plain-data-value-model`: path-bound locals are
read-only copies, object parameters alias by native reference, sparse arrays
zero-initialize) and the pinned seeded `Math.random`
(`deterministic-seeded-random`: mulberry32 over seed 1 on both the native
runtime and the browser reference capture).

New high-risk adaptations require an explicit record and a focused test.

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
GridMaterial now uses generated WGSL and Tint, with scene 213 gating its
dynamic native specialization.
Ground and skybox fragments also use generated WGSL, gated by Scenes 1 and 8.
The shared material vertex stage and Standard fragment variants use generated
WGSL as well, gated by scenes 145 and 273.
PBR color, diagnostic, and geometry-output variants now use WGSL through Tint.
The PBR source is a pinned DXC-SPIR-V/Tint transcription of the previously
validated native shader; direct Babylon composer extraction remains the next
provenance improvement.

HDR environments preserve mip zero and use the pinned WebGPU 1024-sample GGX
prefilter for higher mips. The generated package records the pinned module,
shader, source commit, and sample count.
`EXT_lights_image_based` likewise materializes Babylon Lite's 256-square,
1024-sample BRDF integration directly as RGBA16F and uploads decoded RGBD
cubemap faces with the same half-float quantization as WebGPU.

Transmission uses an opaque scene-color copy, dielectric Fresnel
`((ior-1)/(ior+1))²`, and Beer-Lambert volume attenuation
`exp(log(color)/distance*thickness)`. Independent skybox, scene-color, IOR,
volume, and scene 176 gates keep the dependency chain observable. With 4x
MSAA, PAL resolves and stores the opaque color attachment for the copy, then
reloads the preserved multisample color and depth attachments before
transmissive draws resume.
`KHR_materials_dispersion` reuses that path and splits the refracted ray into
per-RGB indices with Babylon's `spread = 0.04 * (20/dispersion) * (ior-1)`;
Scene 212 gates it.

Clearcoat, sheen, and iridescence are metadata-driven PBR layers selected by
`extensionsUsed` and lowered into the shared PBR fragment:

- clearcoat adds a GGX/Kelemen direct lobe plus a Jones analytical IBL lobe and
  attenuates the base layer by `1 - F(ccF0) * intensity`; the glTF loader
  disables Babylon's base-F0 remap, so intensity zero degenerates exactly to
  the base composition (Scene 28)
- sheen uses the Charlie distribution with Ashikhmin visibility, samples the
  BRDF LUT blue channel at sheen roughness, and scales the base layer by
  `1 - maxSheenColor * brdf.b` (Scene 29)
- iridescence evaluates Babylon's thin-film airy summation in XYZ and blends
  the result into base F0 by the iridescence intensity (Scene 178)

Neutral white intensity/roughness textures and a flat coat-normal flag keep a
single generated variant numerically identical to Babylon Lite's per-material
shader variants. Combining a clearcoat or sheen layer with punctual
multi-light PBR is not lowered and fails explicitly.
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
IEC formula measurably disagreed with the GPU's table (scene 255
regressed 0.101 to 0.249 before the texel-level port took it to
0.000). The record keeps the raw alpha for the pinned blend
semantics.
Environment horizon occlusion applies only to normal-mapped materials:
the pinned `ibl-fragment` composes `eho = 1.0` without a normal map,
and the native fragment gates the same factor on the has-normal-map
uniform. Scene 247's metallic teapots gate this — applying the
polynomial unconditionally darkened silhouette speculars by one MSAA
sample step across the instance field.
Node TRS and world-matrix composition run in double precision and
round once per component at the float32 store, matching JavaScript's
number semantics in the pinned `mat4ComposeInto` and matrix multiply;
this makes native glTF instance matrices bit-identical to the
browser's uploaded thin-instance buffers.
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
This final pass is a recorded adaptation: pinned Babylon Lite keeps the
transmission target multisampled to the end and applies image processing per
MSAA sample before averaging (`image-processing-task.ts` samples
`texture_multisampled_2d` and divides after the `ip()` loop), while SDL_GPU
cannot bind a multisampled texture for sampling, so the native pass processes
the hardware-resolved pixel once. Because tone mapping and gamma are concave,
the native result is brighter than the pinned per-sample average exactly on
raster edges; this bounds the residual edge bias on transmission scenes 33,
176, and 212 and cannot close without per-sample access to the resolved
attachment.
Punctual glTF point lights use inverse-square falloff for the primary and
additional generated light paths. Their diffuse and specular sums remain
separate through transmission and transparent-alpha composition, and
transmissive materials retain their authored alpha/depth state while moving
after the scene-color grab.

Requested generated grounds render by default. Their mesh is translated to the
computed scene root while Babylon Lite's fade calculation deliberately keeps
`backgroundCenter` at the world origin; Scenes 1, 6, 13, and 14 gate that
distinction. Requested DDS skyboxes use Babylon's finite root-positioned cube
and normal scene view-projection. Grounds and DDS/HDR skyboxes can be disabled
independently with `BBLITE_GROUND=0` and `BBLITE_BACKGROUND=0`.

Embedded image-based lights evaluate SH without the transcription's former
`[0,4]` clamp. Environment rotation affects SH and cubemap lookup directions,
while horizon occlusion intentionally uses the unrotated reflection vector.

glTF animation uses pinned LINEAR quaternion interpolation and deterministic
time seeking, plus CUBICSPLINE quaternion/translation interpolation where
reached. Morph position/normal deltas are applied before recursive skinning;
generated joint palettes and morph weights drive vertex-shader
positions/normals/tangents. Meshes above the two-slot vertex-attribute
morph slice use Babylon's pinned uncapped storage-buffer path
(`morph-fragment-core.ts`): a flat 6-float delta buffer and a weights
buffer with the 16-byte `{count, vertexCount}` header, accumulated in
ascending target order before skinning, with source-marker assertions
pinning the loop, indexing, and header ABI. Scene 243 gates it and renders
bit-identically to the former CPU fallback. Primitives without source normals remain
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
deltas, one initial weight, and one mesh attachment. It uses the same
deformation vertex layout as glTF. `createSphereData` returns arrays derived
from the generated sphere geometry, so procedural delta functions consume the
same base positions the renderer draws. Scene 252 is the StandardMaterial
parity gate for this contract.

Scene 151 gates directional-plus-hemispheric Standard lighting and is
pixel-exact. The supported light-count boundary is recorded in
[Features](features.md#lights).

**An unrolled Standard light slot says whether it holds a light; the pinned
loop says how many there are.** Babylon Lite declares
`array<LightEntry, MAX_LIGHTS>` and walks `min(mesh.lc, MAX_LIGHTS)` of it, so
a slot past the count is never read and needs no marking. The generated
fragment unrolls one slot per reached light instead, which means an unwritten
slot is evaluated and has to identify itself. It does so through a component
the pinned lighting function does not read for the light kinds in that slot:
normally `vLightDirection.w`, which every written light sets to one. A spot
light takes that component for its cone cosine, so a scene reaching one tags
empty slots in the kind component instead — the pinned kinds are 0 point,
1 directional, 2 spot and 3 hemispheric, and the generated writer leaves -1
there. Both forms evaluate the same lights to the same values; only the
component carrying "this slot is empty" moves, and it moves only for the
scenes that need the cone. Scene 15 is the parity gate, byte-identical across
both backends.

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
one: sampling through the transform scrolled an emissive texture the browser
holds still, and cost 0.581 of region MAD until the sample was put back on the
raw UV.

**Sheen is composed as one of two pinned models, chosen at generation.**
`createSheenFragment` takes a `hasAlbedoScaling` flag and builds materially
different arithmetic from it, so it is a fragment fork rather than a uniform.
The `true` arm, which a glTF `KHR_materials_sheen` material reaches, scales
the base layer by `1 - shMax * shBrdf.b`, treats the tint texture as linear,
and multiplies the environment term by specular and horizon occlusion. The
`false` arm, which is what `setPbrSheen` defaults to, reads the tint through
`pow(rgb, 2.2)`, takes roughness from the tint texture's alpha because it
declares no separate roughness map, attenuates the lobe by `1 - dielectricF0`,
and leaves the base layer alone. The generated fragment carries whichever arm
the scene reaches — the legacy one also drops the sheen roughness texture's
binding pair and UV transform, since nothing samples them. Scene 29 gates the
glTF arm and Scene 21 the legacy one; a scene composing both would need two
fragments and fails at generation instead.

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
20, so the compiler passes zero rather than substituting a size of its own.
It previously substituted 1000, which built a skybox large enough for a
camera's far plane to clip — invisible from a scene's reference pose and a
straight-edged hole in the background as soon as the camera moved.

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

Two glTF material contracts are expressed in a shape that differs from the
pinned one while producing the same values, and each holds for a stated reason.

**Per-texture UV transforms are emitted per scene, not per material.** Babylon
Lite attaches `uScale`/`vScale`/`uOffset`/`vOffset`/`uAng` to each texture
wrapper and compiles the per-texture UV matrices into the materials that carry
one, so a material with no transform never gains the fields. The generated
fragment is per scene here, so it declares one matrix and offset pair for every
slot it samples and every material fills them, identity where the asset
declares no transform. Identity reduces the transform to the raw varying
exactly — the matrix is `(1, 0, 0, 1)` and the offset is zero, so each
coordinate is one product plus a zero term — which is why scenes that reach the
extension on some materials and not others are unaffected. Rotation is composed
in double before the float store, matching a `Math.cos` result reaching a
`Float32Array`.

**A glTF index of refraction folds into the material's reflectance.** The pin
keeps reflectance at its default and scales it with `metallicF0Factor`, so
`KHR_materials_ior` sets the factor to `((ior-1)/(ior+1))^2 / 0.04` and the
product is the dielectric F0. The loader stores that product directly instead,
which is the same value while nothing else scales F0. `KHR_materials_specular`
is the second scale, so a material declaring it separates the two again: the
factor becomes the extension's `specularFactor` and reflectance returns to its
default, which is also how the pin resolves the two extensions against each
other — the specular factor overwrites the one the index of refraction seeded.

DXC cannot be removed from the D3D12 path because Tint does not emit DXIL.
Tint does emit SPIR-V, but its separate WGSL texture/sampler binding numbers do
not directly satisfy SDL_GPU's dense corresponding-slot contract. Vulkan
therefore still uses normalized Tint HLSL through DXC pending a verified
binding-remap transform.

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

Registry-enabled scenes can emit draw IDs and triangle-cluster IDs. Reports
join those IDs to glTF nodes, meshes, materials, alpha mode, and double-sided
state.

Scene 1 also emits focused PBR buffers from the production shader:

- world normal
- reflectivity
- irradiance and IBL
- normalized view depth
- albedo and direct light
- raw base color
- final pre-tone-map HDR, including a tightly packed RGBA16F sidecar

These diagnostics use two 4x-MSAA passes because SDL_GPU exposes four color
targets. Normalized depth is bit-exact against the Babylon Lite WebGPU oracle.

Scenes 145 and 146 gate the separate production geometry-renderer path: all
eleven geometry texture types, split 7+4 MRT passes, optional real color,
independent depth, viewport copies, and MSAA resolve.
Frame-graph depth targets select a supported D32/D24 sampled depth format,
matching Babylon Lite's `depth32float` geometry-target contract instead of the
former hardcoded D16 adaptation.
The `scene geometry` diagnostic command selects each existing copy task
full-screen in the capture harness and native PAL without modifying curated
scene sources. It emits per-attachment Babylon Lite/native/diff images and a
JSON report under `artifacts/parity/<scene>/geometry`.
Standard double-sided materials disable culling but do not flip fragment
normals. Matching that pinned distinction reduced scene 145 full-resolution
view/world-normal MAD from `1.459`/`1.446` to `0.002`/`0.003`.
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
Standard bump maps build the pinned cotangent frame from screen-space
derivatives (`shader/wgsl-helpers.ts` `WGSL_PERTURB_NORMAL`), so a mesh needs
no tangent attribute, and the interpolated normal is scaled by 1 over the
texture's `level` before the frame is built. The pair binds after every PBR
texture pair, which fixes its index while none of those exist; generation
fails explicitly on a scene composing bump mapping with transmission or a PBR
material extension, because the fragment would then need its binding computed
rather than fixed. A material with no bump map samples a flat
(128, 128, 255) texel and keeps its interpolated normal.
A `.babylon` light applies to the meshes its `includedOnlyMeshesIds` names, or
to every mesh its `excludedMeshesIds` does not, resolved at load against the
records the loader creates. The Standard uniform slots therefore hold the
light set of the mesh being drawn, which is the set the pinned template's
`min(mesh.lc, MAX_LIGHTS)` loop walks.
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
Standard vertex colors follow the pinned `enableStandardVertexColors` opt-in:
the generated Standard fragment declares the `color` attribute and multiplies
the base color by its RGB only for a scene that reaches the call, so every
other Standard scene keeps a byte-identical fragment. Upstream composes that
fragment per mesh, for meshes carrying a color buffer; native geometry defaults
every vertex color to white, which multiplies as the identity, so the
scene-level gate renders the same image. Scene 267 gates it and is byte-exact
on both backends.

Scenes 145 and 146 resolve each geometry attachment at full resolution, then
bilinearly downscale it into one of twelve preview regions on a 4x-MSAA target
before the final mosaic resolve. Babylon Lite floors each normalized viewport
edge to integer target pixels and applies the same rectangle as a scissor.
SDL_GPU previously received fractional viewport bounds without that scissor,
which introduced partial-sample coverage at tile boundaries. Preserving the
JavaScript double-precision viewport expressions and the pinned floor/scissor
contract reduced scene 145 full MAD from `1.077` to `0.063` and scene 146 from
`0.845` to `0.021`, without another pass or a scene-specific path. The
full-resolution attachment maxima remain `0.067` and `0.057`; use
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
resources. Screenshot/diagnostic capture is deferred until the following frame
so upload and readback are never submitted in the same D3D12 command list.
