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

The custom-material WGSL pipeline reflects uniform layout, binding order,
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

**The pin fills two spare scene-block lanes with the canvas size, and so does
this port.** `_packSceneUniforms` writes `eng.canvas.width` into
`vFogColor.w` and `eng.canvas.height` into `_envPad0` on every scene, in the
base pack rather than through a contributor. Nothing in the material families
reads either, which is why the two lanes went unwritten here until a node
graph's `ScreenSizeBlock` read them back through the pin's own
`vec2(scene.vFogColor.w, scene._envPad0)`.

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

**The procedural mesh builders are doubles, and each float32 store is one
the pin performs.** The same rule as the camera's, one layer down.
`create-sphere.ts`, `create-ground.ts` and `create-torus.ts` run their
whole vertex chain in JavaScript numbers -- the normalized step, the angle,
`Math.sin`/`Math.cos`, and the radius product -- and round only where they
store into a `Float32Array`. `factory-lowerer.ts` emits that chain in
`double` with `pi_double`, converts at each store, and builds the position
from the unrounded normal rather than from the one it just stored.
A float chain reads as harmless and is not: the sphere's normals move a few
ulps, which a rougher material absorbs and a mirror-metal one does not.
Scene 23 measured 0.004 with a 33-byte peak on the float chain and 0.002
with every pixel inside one byte on the pin's. Across the corpus the
correction is last-bit: every gate still passes, and the one published row
it moves on both backends is scene 19's foreground, by a thousandth.

The rule starts at the call site, not at the loop: `SphereOptions`,
`GroundOptions` and `TorusOptions` carry their scalars as `double` and
`compileSphereOptions` and friends emit them at that precision, because the
pin halves a diameter as a JavaScript number before the chain rounds. A float
option would make `rx` a float32 neighbour of the pin's `diameterX / 2` --
scenes 116 and 162 pass `1.6` and `0.45`, which are not representable.

`create-box.ts` and `create-plane.ts` need no such care: their vertices are
literals scaled by a halving, which is the last operation before the store and
so rounds to the same float either way.

**The RGBD decode's result type is the pin's storage type.**
`src/loader-env/rgbd-decode.ts` decodes `.env` faces and the BRDF LUT into a
`texture_storage_2d<rgba16float, write>`, so a half *is* the decode's result,
not a packing step a caller may skip. `decode_rgbd` returns halves for that
reason: the SDL_GPU BRDF-LUT path used to upload them as `RGBA32Float` while
the cube and both Dawn paths packed to half, which is more precision than the
pin has and a silent backend delta besides. Aligning it moved 19 SDL_GPU
published rows by a thousandth, all inside their gates.

**A scene's reference pose can be a query string, and both sides read the
same one.** A corpus scene that branches on `?seekTime=` reads
`window.location.search` through `URLSearchParams`, and the branch decides
whether the scene animates at all. `parity.referenceSearch` in the registry
is that query: the reference page is navigated with it, and the compiler
folds `window.location.search` to the same text, so `params.get` and
`params.has` answer from the pin's own parser and the native scene keeps
the branch the reference took. A scene the pin serves bare leaves it unset,
and the query reads as empty. `reference/exact-corpus-manifest.json` records
it beside the module digest, because a navigation parameter is not module
text and two goldens captured at different poses would otherwise share a
provenance.

**The reached slice renders under one depth convention, and it is the
pin's.** `src/engine/render-target.ts` declares `REVERSE_DEPTH_COMPARE =
"greater-equal"`, `mat4PerspectiveLHToRef` maps `near -> 1` and `far -> 0`,
and every family this port reaches takes that pair as its default: PBR,
Standard, node, shader materials, the geometry tasks, the background ground
and the solid skybox. Both backends carry it on every pipeline and clear
depth to zero, so the composed view-projection is equal to the browser's
uploaded matrix in all sixteen elements.

The compare is not typed here. `pinned-depth-state.ts` reads the pin's own
declaration and emits `upstream::pinned_depth_compare`, failing generation on
a spelling this runtime has no enumerator for — the contract
`pinned-blend-table.ts` holds for the pin's blend factors, and the one
`assertPinnedPerspectiveWriter` already holds for the projection half of the
same convention. Each backend translates the enumerator to its own API.

Two arms of the library sit outside the slice and name their own compare: the
pin's shadow targets render standard-Z `less-equal`, and a `ShaderMaterial`
may pass `depthCompare` (its default is `"greater-equal"`; a scene naming one
refuses at compilation today).

`FragDepthBlock` composes because of it: the block hands a graph
`@builtin(frag_depth)`, so the value it returns is a depth in that
convention, and a renderer ordering depth the other way would occlude by its
inverse. Scene 84 measures the block at 0.000 on both backends.

**A depth convention cannot move a coverage mask, but it can move a
varying — through the near-plane clipper.** Unclipped geometry is
unaffected. A triangle that straddles the eye plane is another matter: the
clipper generates new vertices and interpolates their attributes from clip
space, `z` included, so a differing `z` row would shift the interpolated
varying in its last bits across the whole clipped triangle. Scene 7's solid
skybox is where that would show — its cube is centred on the eye, so its
side faces straddle the eye plane — and it is why
`build_solid_skybox_scene_uniforms` still builds its own view-projection
rather than binding the frame's: the pinned vertex stage offsets the cube by
the eye itself, and the clip row that reaches its dither seed has to be
exact rather than merely equivalent.

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
A scene-code material has no separate occlusion image and samples `orm.r` when
its resolved `occlusionStrength` is nonzero. `createPbrMaterial` is
`{...props}`, and `_computePbrMaterialFeatures` owns the
`(mat.occlusionStrength ?? 1) > 0` gate; generation carries the option into
both that pinned feature input and the native material record, defaulting it to
one only when absent. The glTF `_occlusionImage ? 1 : 0` rule belongs to the
loader's own input builder and does not reach the scene-code path. The pin's
internal `_metallicF0Factor` creation property likewise stays distinct from
the public base `reflectance`: a reached non-default is recorded and writes
both native `metallic_f0_factor` and the writer's fallback `specular_weight`,
but stays dormant in shader composition until the later
`setPbrMetallicReflectance` call registers the reflectance extension.
That setter preserves a computed scene colour as native arithmetic, moves its
two optional file images into dedicated material slots, and composes the pin's
metallic-reflectance, reflectance, and alpha-only feature bits per material.
Both images use linear texture views because Babylon's reflectance fragment
applies its own `pow(rgb, 2.2)` decode; their alpha channels remain linear.
Registration is process-global in the pin, so even an empty setter call makes
a non-default creation-time F0 on another material participate in composition;
the same applies when the registering call came from a previously loaded glTF
dielectric rather than from scene code. Repeated scene setter calls accumulate
their conditionally supplied fields exactly as the pinned material object does.
`KHR_materials_variants` is folded to the one selection a scene makes.
`selectVariant` restores every original material and then applies the chosen
variant's mapped entries, so with one static selection the end state is a
per-primitive material index — which generation resolves and the loader
applies, reading the variant order and the per-primitive mappings out of the
document and taking only the chosen name from the scene. The pin's run-time
variant table has no reached mutation to serve, so every shape the fold cannot
represent refuses at generation rather than compiling to a state the pin never
reaches: `getVariantNames` and `resetVariant` are unlowered, a second
differing selection on one asset is refused, a selection on a second asset is
refused because one name is compiled in for the whole scene, and a selection
made from a frame callback is refused because it would fold a per-frame
reassignment into frame zero. An asset carrying the extension that no scene
selects on renders identically on both sides, because the pin reassigns
nothing until `selectVariant` runs. Scene 27 gates it.
A glTF file's animations are one group each, carrying the name, duration and
frame rate `src/animation/animation-group.ts` gives them, and upstream starts
only the first (`isPlaying: clipIndex === 0`) with each looping over its own
length. Two consequences are not guessable from the file. A stopped group
writes nothing at all — upstream's `tickAnimationCore` returns early for one,
so holding its channels at time zero is different: where two clips animate the
same target, a zero write would overwrite the playing clip's value. And a seek
reaches only groups that are not stopped, because the pin's own tick returns
early for one. The project-owned animation-groups gate measures both,
selecting a clip upstream did not start.

**A container's entities are the pin's entity walk, and nothing else.**
`addToScene(scene, container)` recurses over `container.entities`, then does
four more things to the container itself: it pushes the file's animation
groups onto `scene.animationGroups`, appends the per-frame tick that
advances them, takes the file's camera when the scene has none, and takes
its clear colour. A scene iterating `entities` reaches only the first half,
which is what makes the shape worth writing: those scenes drive the same
clips from an `AnimationManager` of their own, and a scene tick would
double-advance them. The pin seeds a glTF container with its root node and
lets each loader feature append its own entities, so adding them one by one
adds the loader's meshes and its lights — which is what the generated call
adds in one step, the entity value being accepted by `addToScene` alone.
That iteration value deliberately represents the complete entity walk. An
indexed value is different: only static `entities[0]` on a glTF container
lowers, as an opaque imported-root identity, because the pin guarantees the
synthetic transform root at index zero before features append lights or other
entities. A dynamic/nonzero index and every `.babylon` container refuse rather
than conflating one root with the complete walk. Scenes 152 and 157 measure the
iteration contract; compiler regressions pin the indexed boundary.

**A manager owns animation time for the groups attached to it, and the
measured seek has to reach it.** Upstream has no seek — the reference
harness writes `currentTime` on each group the registry names and pauses it,
and whoever drives the group applies the pose on its next tick. Native
mirrors that shape rather than the call: a scene registering with an engine
contributes one seeker per manager it created, beside the seeker each
loaded asset already carries.

**The weighted property mixer buckets by the pair the pinned binding
resolved.** `resolvePropertyBinding` returns the object a dotted path landed
on and the final property name, and the mixer keys its accumulator on that
pair — so `position` and `position.x` are different buckets even on one
mesh, since one resolves to the mesh and the other to its position. A
lowered track carries a mesh handle and a closed path enumerator, and
distinct paths resolve to distinct pairs, so the two key the same buckets.
Weights are summed and never normalized, which is upstream's stated choice:
two groups at 0.25 and 0.75 write the weighted sum, and a single group at
0.5 writes half its own value. Scene 155 measures the first.

**The weighted glTF mixer is the same shape one level down, and its
partial-weight rotation blends against the rest pose.** Each contributing
clip's translation and scale accumulate as weighted sums — zeroed on the
first write to a node, so the rest pose is replaced rather than added to —
while rotations accumulate by incremental slerp at `weight / (accumulated +
weight)`, which is what makes the result independent of clip order. A node
whose weights sum below one then slerps from its rest rotation toward the
accumulated one by that sum, and one at or above it is renormalized. The
pose that follows — local matrices, the topological world walk, the skin
palettes — is the same pass a single-clip tick runs, so only the
accumulation is the mixer's. Scene 157 measures walk and run at half weight
each.

**How large a skin stays on the GPU follows its palette's transport.** A
mesh whose palette rides the pinned per-bone texture leaves the uniform
array's bone lanes at the identity — the stage that would read them is not
the stage drawing it. Scene 157's Xbot is 67 joints and measures byte-exact
on both backends. See
[Architecture](architecture.md#animation-and-deformation) for the two
transports and the refusal between them.
A scene's `setPbr*` options reach composition through the pin's own setters,
the way the loader half already runs `setPbrEmissive`: each stamps its props
under the field name its extension's `detect` reads, so the composed arm set
follows from the pinned setter rather than from a field name restated here.
That is what an extension arm depends on — the emissive layer composes on the
presence of `_emissiveColor` alone, carrying no texture and no capability
define.
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
are `+Y` and `-Y`, so an unculled cube renders a hard-edged quadrilateral of
`-Y` — the projection of the plane through the cube centre — over a `+Y`
surround, where the pinned cube shows one continuous sky. No gated pose
reaches it, because every gated camera sits inside its own skybox; Scene 14 at
`cam.beta = 0.55` puts the camera above the cube and reproduces it.

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
Primitives without source normals remain deindexed, and their face normals
are recomputed after deformation while their positions stay GPU-skinned. See
[Architecture](architecture.md#animation-and-deformation) for layout,
specialization, and why that normal cannot come from a vertex stage.
Static `EXT_mesh_gpu_instancing` preserves Babylon Lite's split transform
contract: extension matrices remain local T/R/S data and the node world matrix
is applied separately in the vertex shader.
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
`loadTexture2D` its `Promise.all` awaits, and is the one place where following
the pin moved a published number the wrong way: its full MAD went from 0.32951
to 0.32956, five parts in a hundred thousand of a residual that belongs to
something else entirely. The two backends agree slightly better than they did,
which is what a corrected CPU-side input looks like.

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
texture slot") resolved once at generation. Scenes 74, 75 and 76 measure the
three shapes byte-exact on both backends.

**A line system is a mesh and a shader material, and both halves come from
the pin.** `create-line-system.ts` flattens the polylines at load and hands
the result to `createMeshFromData`, so the flatten is emitted as generated
C++ with each rule it folds asserted against the declaration that states it:
the segment index pair `(vertex - 1, vertex)` written only for
`pointIndex > 0`, the `Math.max(0, line.length - 1) * 2` index count, the
zero normal buffer, and the five validation throws. The material is the
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
composing a different program per flag set. Scenes 278 and 279 measure both
at 0.000 on both backends.

**A line-list on a multisampled target needs D3D12's multisampled line
rule, and SDL_GPU did not ask for it.** Dawn sets
`RasterizerState.MultisampleEnable` from the pipeline's sample count
(`RenderPipelineD3D12.cpp`), which selects the quadrilateral rule that
resolves line coverage against the target's samples; SDL's D3D12 backend
hardcoded it to `FALSE` (`SDL_gpu_d3d12.c`), leaving lines on the aliased
diamond-exit rule whatever the sample count, where its own Vulkan and Metal
backends have no such switch. Measured before the fix: SDL_GPU at 4x was
pixel-identical to SDL_GPU at one sample and to Dawn at one sample, and
scene 278 measured 0.284 full MAD against a byte-exact Dawn. The vendored
overlay port (`native/vcpkg-overlay-ports/sdl3`) now carries that one line
beside libsdl-org/SDL#15838, and both backends measure 0.000. It affects
line rasterization only — triangle coverage is per-sample on a multisampled
target either way — which the corpus-wide neutrality run measures rather
than assumes.

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
it. Scene 282 measures the composed stages byte-identical to the browser's
and every uploaded lane bit-identical; its one differing pixel of 921600 sits
4.0e-6 from a texel boundary, where nearest filtering takes the neighbouring
checker row.

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
reports on both of them and in the browser reference — and the emitted format
table carries the pin's block-compression rows alone, so a file outside them
refuses at the pin's own `if (!format) throw` rather than at an upload that
cannot name what it was handed. Both PALs then translate the pin's own WebGPU
format name, upload the block-padded copy extent the pin computes for each
level (a 2x2 tail mip still occupies one 4x4 block), and generate no mips.
Scene 25 measures byte-exact on both backends, including at a grazing camera
that samples the whole chain.

**A Basis file is transcoded by the pin's own loader and packaged as KTX1.**
`basis-loader.ts` injects the Binomial transcoder from a CDN with a `<script>`
tag and picks its target format from `device.features` — a browser API and a
device question — so generation runs the pinned loader in headless Chromium
and bakes what it uploaded. It is written back as a KTX1 container because
the port already reads one: the transcoded chain is exactly what `parseKtx1`
returns, and the GL enum it is stored under is the pin's own table read
backwards. Recorded per scene as `executed-basis-transcode`, with the drawn
atlas's tradeoff. Scene 36's Mustang transcodes to `bc7-rgba-unorm` at
768x512 with one level, which is what an instrumented capture shows the
browser uploading, and measures byte-exact on both backends.

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

**A node material is compiled by the pin, not re-emitted here.** A Babylon NME
document is a graph, and `material/node/node-emitter.ts` turns it into WGSL
through one emitter per block class — a hundred and three of them, which are
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
`scaledUpdateSpeed = updateSpeed * ratio`. Scenes 283 and 284 register frozen
sets and measure byte-exact on both backends.

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

**`Math.round` is JavaScript's rule, not C's.** The two disagree on every
negative tie: ECMA-262 rounds halves toward +Infinity, so `Math.round(-0.5)`
is `-0`, while `std::round` rounds away from zero and gives `-1`.
`bbl::js::round_js` carries the spec's own rule, written as
`floor(x) + (x - floor(x) >= 0.5)` rather than `floor(x + 0.5)` because that
addition is not exact at large magnitudes. The five integer-valued one-argument
functions also fold at generation over a constant argument, where the folded
value and the emitted call agree exactly; the transcendental ones deliberately
do not, because V8 and a native maths library need not.

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
and it means a physics scene cannot carry a pixel threshold against a Havok
golden at all.

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
bounding-box shape sizing. `physics-lowerer.ts` asserts each of them against
the declaration that states it, including the *order* of the four phases,
which no single expression would catch.

**What a substituted solver is measured by.** Two things, and the split
matters because only one of them needs Havok.

**Solver-independent properties, checkable with no reference at all.**
`BBLITE_PHYSICS_TRACE` writes the per-step pose, and three properties follow
from mechanics rather than from any implementation:

- **Free fall is exact.** Both solvers integrate semi-implicit Euler, so the
  pose after `n` steps has a closed form: `y = y0 - g·dt²·n(n+1)/2`.
  Measured on `examples/physics-drop.ts`, the native run matches it to
  float32 precision (`1e-7` at magnitude 4) for every step before contact.
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

Measured at rest, Bullet against the Havok golden, `examples/physics-drop.ts`:
**921,584 of 921,600 pixels exactly identical** — full MAD 0.000056, region
MAD 0.000127, 15 of the 16 differing pixels within one byte and the last a
single antialiased silhouette pixel at 37. The non-background extent, pixel
count and mean RGB match the golden's exactly. Both GPU backends render the
byte-identical frame. So the substitution costs nothing at all where the two
solvers are both converged, and everything it costs is in the transient —
which is where a future measurement should look, and which needs the scene
to freeze itself at a step count (see [TODO](../TODO.md)).

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
