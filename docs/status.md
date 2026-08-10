# Current status

`bblitec` is a real compiler for a deliberately constrained reachable subset
of Babylon Lite. It is not yet a universal TypeScript or Babylon runtime.

## Supported vertical slice

| Area | Current support |
| --- | --- |
| Engine/scene | creation, registration, fixed delta, reached before-render callbacks, runtime append |
| Cameras | ArcRotate, FreeCamera, default framing, native controls |
| Lights | hemispheric and point |
| Geometry | box, ground, plane, sphere, torus, triangle glTF/GLB, reached `.babylon` geometry |
| Assets | external glTF packaging, embedded PNG/JPEG, `.env`, compile-time RGBE HDR cubemaps, DDS, reached `.babylon` textures |
| Materials | Standard, PBR, GridMaterial, unlit, vertex colors, no-color views, typed custom shader variants |
| Material state | alpha mask/blend/coverage, reflectance, lighting intensities, double-sided, normal/ORM/emissive |
| Frame graph | render targets/tasks, material overrides, depth-only passes, 7+4 geometry MRTs, blits, MSAA resolve |
| Runtime | typed handles/records, immediate AOT promises, typed JSON and binary views |
| Native renderer | Generated ordered draw lists over SDL_GPU; deterministic SDL_Renderer fallback |

Generated behavior is tied to `@babylonjs/lite@1.18.0` at commit
`7184feda683072980735f9a180e6f567ee5717ba`.

## BoomBox baseline

Development Windows machine, D3D12, 1280x720:

| Renderer | Full MAD | Foreground MAD | CPU submission |
| --- | ---: | ---: | ---: |
| CPU fallback | 4.452 | 21.191 | 5.516 ms/frame |
| SDL_GPU, 4x MSAA | 0.311 | 0.460 | 0.176 ms average, 0.141 ms median |

The GPU path is approximately 31 times faster CPU-side. Its remaining error is
mostly foreground edges (`1.097` MAD); foreground interior MAD is `0.167`.
Regression ceilings are `0.5` full and `1.0` foreground MAD.

## Curated parity scenes

Thresholds live in `src/scene-registry.ts`; run one scene with
`npm run scene -- parity scene<ID>` or all registered parity scenes with
`npm run scenes:parity`.

| Scene | Full MAD | Foreground MAD | Primary coverage |
| ---: | ---: | ---: | --- |
| 8 | 0.137 | 0.142 | RGBE HDR, cubemap skybox, glass alpha/reflectance, exposure/contrast |
| 10 | 0.000 | 0.000 | generated sphere, no-IBL PBR, geometric normals |
| 13 | 0.010 | 0.081 | material grid, explicit occlusion semantics |
| 32 | 0.000 | 0.000 | `KHR_materials_unlit` |
| 116 | 0.000021 | 0.000150 | no-color material views, depth targets |
| 145 | 5.032 | 5.011 | `.babylon`, Standard geometry outputs |
| 146 | 0.868 | 0.889 | PBR geometry outputs, 7+4 MRT composition |
| 163 | 0.000 | 0.000 | custom shader blend, alpha test, discard |
| 168 | 0.068 | 0.389 | mirrored double-sided winding; 100% within one byte |
| 213 | 0.001 | 0.012 | GridMaterial opaque/transparent families and ordered draw lists |
| 248 | 0.001 | 0.005 | external glTF and sampler modes |
| 249 | 0.001 | 0.028 | vertex-color alpha and mask cutoff |
| 257 | 0.001 | 0.006 | negative-scale hierarchy, generated normals |
| 266 | 0.151 | 0.285 | mirrored spheres; 99.31% within one byte |
| 273 | 0.000 | 0.000 | post-registration material-family addition |
| 274 | 0.000 | 0.000 | 4x-MSAA alpha-to-coverage |

Scene 145's largest residual is the Standard world-position impostor. Scene
146's largest residuals are view/world-normal and real-color tiles. Scene 13's
full-image value includes the known generated-ground composition difference.
Scene 8's skybox outside the glass sphere is effectively exact (`0.00023`
MAD); the remaining error is concentrated on transparent sphere edges.

## Diagnostics

BoomBox parity can emit:

- draw and triangle-cluster IDs
- world normal, reflectivity, irradiance, IBL
- normalized depth, albedo, and direct light
- raw base color and pre-tone HDR (`RGBA16F` raw plus PNG preview)
- background, edge, interior, channel-bias, hotspot, and material attribution

Normalized depth is bit-exact against the Babylon Lite WebGPU oracle. See
[fidelity.md](fidelity.md) for artifact semantics.

Current BoomBox foreground diagnostic MAD: world normal `0.072`, albedo
`0.011`, reflectivity `0.012`, irradiance `0.052`, normalized depth `0.000`.

## Current boundaries

- one statically analyzable entry file and one engine
- selected TypeScript expressions, assignments, callbacks, and intrinsics
- no general modules/functions/control flow, arbitrary object graphs, or
  runtime module loading
- no animation, skinning, morph targets, physics, audio, or networking
- no general user WGSL; custom shaders are typed reached variants
- D3D12 is validated locally; Vulkan and Metal artifacts are generated but
  still require real-device validation

## Next priorities

1. Replace textual shader variants with a composed WGSL/typed-IR pipeline.
2. Add transparent back-to-front sorting to the generated list shape.
3. Replace the deterministic HDR mip fallback with the full pinned GGX prefilter.
4. Reduce BoomBox and geometry-output residuals with source-based diagnostics.
5. Validate Vulkan/SPIR-V and Metal/MSL on real hardware.
