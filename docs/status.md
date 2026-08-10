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
| Assets | external glTF packaging, embedded PNG/JPEG, `.env`, DDS, reached `.babylon` textures |
| Materials | Standard, PBR, unlit, no-color views, typed custom shader variants |
| Material state | alpha mask/blend/coverage, double-sided, normal/ORM/emissive, reached PBR scalars |
| Frame graph | render targets/tasks, material overrides, depth-only passes, 7+4 geometry MRTs, blits, MSAA resolve |
| Runtime | typed handles/records, immediate AOT promises, typed JSON and binary views |
| Native renderer | SDL_GPU by default; deterministic SDL_Renderer fallback |

Generated behavior is tied to `@babylonjs/lite@1.18.0` at commit
`7184feda683072980735f9a180e6f567ee5717ba`.

## BoomBox baseline

Development Windows machine, D3D12, 1280x720:

| Renderer | Full MAD | Foreground MAD | CPU submission |
| --- | ---: | ---: | ---: |
| CPU fallback | 4.452 | 21.191 | 5.516 ms/frame |
| SDL_GPU, 4x MSAA | 0.447 | 2.003 | 0.119 ms average, 0.083 ms median |

The GPU path is approximately 46 times faster CPU-side. Its remaining error is
mostly foreground edges (`5.314` MAD); foreground interior MAD is `0.479`.
Regression ceilings remain `1.0` full and `8.0` foreground MAD.

## Curated parity scenes

Thresholds live in `src/scene-registry.ts`; run one scene with
`npm run scene -- parity scene<ID>` or all registered parity scenes with
`npm run scenes:parity`.

| Scene | Full MAD | Foreground MAD | Primary coverage |
| ---: | ---: | ---: | --- |
| 10 | 0.000 | 0.000 | generated sphere, no-IBL PBR, geometric normals |
| 13 | 0.016 | 0.136 | material grid, explicit occlusion semantics |
| 32 | 0.000 | 0.000 | `KHR_materials_unlit` |
| 116 | 0.000021 | 0.000150 | no-color material views, depth targets |
| 145 | 5.063 | 5.042 | `.babylon`, Standard geometry outputs |
| 146 | 1.879 | 1.826 | PBR geometry outputs, 7+4 MRT composition |
| 163 | 0.000 | 0.000 | custom shader blend, alpha test, discard |
| 168 | 0.068 | 0.389 | mirrored double-sided winding; 100% within one byte |
| 248 | 0.001 | 0.005 | external glTF and sampler modes |
| 257 | 0.009 | 0.066 | negative-scale hierarchy, generated normals |
| 266 | 0.151 | 0.285 | mirrored spheres; 99.31% within one byte |
| 273 | 0.000 | 0.000 | post-registration material-family addition |
| 274 | 0.000 | 0.000 | 4x-MSAA alpha-to-coverage |

Scene 145's largest residual is the Standard world-position impostor. Scene
146's largest residuals are view/world-normal and real-color tiles. Scene 13's
full-image value includes the known generated-ground composition difference.

## Diagnostics

BoomBox parity can emit:

- draw and triangle-cluster IDs
- world normal, reflectivity, irradiance, IBL
- normalized depth, albedo, and direct light
- background, edge, interior, channel-bias, hotspot, and material attribution

Normalized depth is bit-exact against the Babylon Lite WebGPU oracle. See
[fidelity.md](fidelity.md) for artifact semantics.

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

1. Add scene 8 for HDR environments and PBR glass controls.
2. Replace textual shader variants with a composed WGSL/typed-IR pipeline.
3. Move remaining Babylon draw-bucket decisions out of PAL.
4. Reduce BoomBox and geometry-output residuals with source-based diagnostics.
5. Validate Vulkan/SPIR-V and Metal/MSL on real hardware.
