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

Current intentional adaptations include browser-wrapper erasure, immediate AOT
`await`, compile-time asset materialization, SDL input translation, native
shader backends, and opt-in ground composition.

New high-risk adaptations require an explicit record and a focused test.

## Shader contract

Generated shaders preserve upstream markers for:

- GGX distribution and Smith geometry
- BRDF LUT energy conservation
- environment mip selection and RGBD decoding
- SH irradiance
- exposure, tone mapping, gamma, and contrast
- depth, culling, blending, and multisample state

Backend reflection should ultimately verify uniform layout, binding order,
varyings, texture sample types, and pipeline state. The long-term goal is one
composed WGSL/typed-IR pipeline rather than independent textual backends.

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

These diagnostics use two 4x-MSAA passes because SDL_GPU exposes four color
targets. Normalized depth is bit-exact against the Babylon Lite WebGPU oracle.

Scenes 145 and 146 gate the separate production geometry-renderer path: all
eleven geometry texture types, split 7+4 MRT passes, optional real color,
independent depth, viewport copies, and MSAA resolve.

## Validation policy

There is no hosted CI. A validated milestone keeps:

- renderer-specific actual, diff, hotspot, and attribution images
- renderer-specific JSON reports
- manifests, fidelity records, and provenance
- measured local thresholds in `src/scene-registry.ts`

GPU results are device-specific and must record the selected backend. Golden
images are evidence, not tuning targets: fixes must follow upstream semantics
or metadata rather than scene or pixel heuristics.
