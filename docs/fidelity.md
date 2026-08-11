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
opt-in ground composition.

New high-risk adaptations require an explicit record and a focused test.

Curated Babylon Lite inputs are byte-identical, SHA-256-checked snapshots from
the pinned source commit. Never edit, flatten, normalize, or replace them.
Thresholds and goldens are equally immutable during ordinary fixes. Add a
scene or recapture a reference only as an explicit pinned-scene operation.

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
Ground and skybox fragments also use generated WGSL, gated by scene 8 and
BoomBox.
The shared material vertex stage and Standard fragment variants use generated
WGSL as well, gated by scenes 145 and 273.
PBR color, diagnostic, and geometry-output variants now use WGSL through Tint.
The PBR source is a pinned DXC-SPIR-V/Tint transcription of the previously
validated native shader; direct Babylon composer extraction remains the next
provenance improvement.

HDR environments preserve mip zero and use the pinned WebGPU 1024-sample GGX
prefilter for higher mips. The generated package records the pinned module,
shader, source commit, and sample count.

Transmission uses an opaque scene-color copy, dielectric Fresnel
`((ior-1)/(ior+1))²`, and Beer-Lambert volume attenuation
`exp(log(color)/distance*thickness)`. Independent skybox, scene-color, IOR,
volume, and scene 176 gates keep the dependency chain observable.
The generated material records preserve Babylon's distinction between volume
attenuation, thickness-based refraction depth, and glTF-only IOR-to-F0
mapping; direct `createPbrMaterial` refraction options do not implicitly enable
the glTF dielectric adaptations.
The scene-color source is RGBA16F and remains linear through opaque and
transmissive draws; exposure, tone mapping, gamma, and contrast run once in a
final full-screen pass.

Generated ground remains opt-in. Enabling it against the committed scene 13
golden raises full MAD from `0.010` to `8.354`, confirming that the reference
does not compose that background pass equivalently.
Legacy `.env` DDS backgrounds are likewise opt-in with
`BBLITE_BACKGROUND=1`; pinned Babylon Lite BoomBox output keeps the clear
background. Explicit HDR cubemap skyboxes remain enabled by default.

glTF animation uses pinned LINEAR quaternion interpolation and deterministic
time seeking, plus CUBICSPLINE quaternion/translation interpolation where
reached. Morph position/normal deltas are applied before recursive skinning;
generated joint palettes and morph weights drive vertex-shader
positions/normals/tangents. Primitives without source normals remain
deindexed and use a narrow CPU fallback to recompute post-deformation face
normals, while their positions are still GPU-skinned. See
[Architecture](architecture.md#animation-and-deformation) for layout,
specialization, and fallback limits.
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

Scene 151 gates directional-plus-hemispheric Standard lighting and is
pixel-exact. The supported light-count boundary is recorded in
[Status](status.md).

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

BoomBox also emits focused PBR buffers from the production shader:

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

The diagnostic comparison report joins each final-image hotspot to the
available WebGPU-oracle buffer MADs and its attributed shader variant. Base
color and pre-tone HDR are currently native captures only; they are listed as
uncompared artifacts until matching browser readbacks are added.

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
