# Fidelity strategy

Visual parity has two independent sources of risk:

1. TypeScript/Babylon semantics may change while being lowered to C++.
2. Babylon's WGSL/WebGPU rendering must be represented on D3D12, Vulkan, and
   Metal without changing formulas, bindings, color spaces, or raster state.

Treating the final screenshot as one number hides which layer is responsible.
`bblitec` therefore records adaptations and produces layered diff attribution.

## Semantic fidelity

Every generated scene now contains:

- `manifest.json`: features, runtime/generated sources, assets, and adaptation
  records
- `fidelity.json`: the scene's intentional semantic adaptations
- `upstream/provenance.json`: upstream modules and symbols used by lowerers

An adaptation record states:

- source semantics
- native semantics
- fidelity risk
- validation mechanisms

Current intentional adaptations include:

- browser entry-wrapper and instrumentation erasure
- synchronous AOT `await`
- compile-time remote asset materialization
- SDL platform/input translation
- WGSL-to-native shader backend translation
- opt-in environment ground composition

High-risk adaptations should not remain implicit. New adaptations require a
manifest entry and focused tests.

## Improving semantic confidence

The next levels of validation should be:

1. **Pure-function differential tests:** execute upstream TypeScript and
   generated C++ for camera math, environment parsing, material formulas, and
   transforms against the same randomized inputs.
2. **Scene trace comparison:** record ordered Babylon API calls and resulting
   typed records in JavaScript, then compare them with generated C++ records.
3. **Asset canonicalization tests:** compare parsed accessors, hierarchy,
   materials, and bounds before rendering.
4. **Mutation/inertia traces:** compare camera and scene state over many
   frames, not only the final screenshot.
5. **Property tests:** check invariants such as normalized normals, valid
   handles, monotonic mip offsets, and stable registration.

This separates transpiler defects from renderer defects before pixels are
involved.

## Shader fidelity

`generated/<scene>/upstream/renderer-fidelity.json` records:

- WGSL as the source language
- emitted source and compiled backend formats
- SDL_GPU binding-space contract
- texture color-space contract
- upstream formula markers and native behavior
- validation associated with each invariant

Current invariants cover:

- GGX distribution and Smith geometry
- BRDF LUT energy conservation
- environment mip selection
- RGBD cubemap vertical orientation
- exposure, tone mapping, gamma, and contrast

The long-term solution is not to maintain independent hand-edited HLSL and MSL
equations. The compiler should parse Babylon's composed WGSL into a typed IR,
then use one backend pipeline—potentially Tint or SDL_shadercross—to produce
WGSL, HLSL/DXIL, SPIR-V, and MSL.

Backend reflection must verify:

- uniform sizes and alignment
- resource binding order
- varying locations and interpolation
- texture dimensions and sample types
- depth, culling, and blend state

## Locating residual visual differences

Parity reports are renderer-specific:

- `report-cpu.json`
- `report-gpu.json`
- `diff-map-cpu.png`
- `diff-map-gpu.png`
- `hotspots-cpu.png`
- `hotspots-gpu.png`
- `draw-ids-gpu.png`
- `draw-ids-visual-gpu.png`

Each report includes:

- total and foreground MAD
- per-channel MAD
- signed foreground RGB bias
- background MAD
- foreground high-gradient/edge MAD
- foreground interior MAD
- the twelve highest-MAD foreground tiles

Interpretation:

| Signal | Likely layer |
| --- | --- |
| Background MAD | clear color, skybox, ground, tone mapping |
| Foreground edge MAD | camera matrices, winding, culling, depth, coverage, MSAA |
| Foreground interior MAD | material inputs, BRDF, texture color spaces, IBL |
| Uniform signed RGB bias | exposure, gamma, tone mapping, color conversion |
| Localized hotspot | one material, texture region, mesh, or transparency path |

GPU parity also captures a lossless draw-ID buffer. Stable IDs are emitted
from glTF node/mesh/primitive order, and reports contain `drawAttribution` and
`hotspotAttribution` joined with node, mesh, material, alpha mode, and
double-sided metadata.

BoomBox contains one large primitive and one material, so parity additionally
captures stable 128-triangle cluster IDs. The report maps cluster ranges and
hotspots back to the glTF render item.

The same production PBR shader is macro-specialized into a diagnostics MRT
variant that captures depth, encoded world normal, roughness/metallic/AO,
direct light, and IBL. The next fidelity step is capturing equivalent
intermediates from Babylon WebGPU and comparing each buffer directly.

## Validation artifact meaning

There is no hosted CI. Local validation output must keep renderer modes
separate and retain:

- renderer-specific actual, diff, hotspot, and ID images
- renderer-specific parity reports
- compile manifest and adaptation ledger
- provenance
- renderer fidelity contract

GPU parity is device-specific and the report records the selected driver.
