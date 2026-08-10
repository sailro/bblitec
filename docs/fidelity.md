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
