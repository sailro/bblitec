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
| Material state | alpha mask/blend/coverage, reflectance, lighting intensities, double-sided, normal scale, transmission, IOR, volume |
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

| Scene | Preview | Full MAD | Foreground MAD | Primary coverage |
| ---: | :---: | ---: | ---: | --- |
| 8 | <img src="images/scenes/scene8.png" alt="Scene 8 rendering" width="120"> | 0.129 | 0.134 | exact 1024-sample HDR GGX, cubemap skybox, glass alpha/reflectance |
| 10 | <img src="images/scenes/scene10.png" alt="Scene 10 rendering" width="120"> | 0.000 | 0.000 | generated sphere, no-IBL PBR, geometric normals |
| 13 | <img src="images/scenes/scene13.png" alt="Scene 13 rendering" width="120"> | 0.010 | 0.081 | material grid, explicit occlusion semantics |
| 32 | <img src="images/scenes/scene32.png" alt="Scene 32 rendering" width="120"> | 0.000 | 0.000 | `KHR_materials_unlit` |
| 116 | <img src="images/scenes/scene116.png" alt="Scene 116 rendering" width="120"> | 0.000021 | 0.000150 | no-color material views, depth targets |
| 145 | <img src="images/scenes/scene145.png" alt="Scene 145 rendering" width="120"> | 1.331 | 1.309 | `.babylon`, Standard geometry outputs, default anisotropy |
| 146 | <img src="images/scenes/scene146.png" alt="Scene 146 rendering" width="120"> | 0.877 | 0.896 | PBR geometry outputs, 7+4 MRT composition |
| 163 | <img src="images/scenes/scene163.png" alt="Scene 163 rendering" width="120"> | 0.000 | 0.000 | custom shader blend, alpha test, discard |
| 168 | <img src="images/scenes/scene168.png" alt="Scene 168 rendering" width="120"> | 0.068 | 0.389 | mirrored double-sided winding; 100% within one byte |
| transmission-skybox | <img src="images/scenes/transmission-skybox.png" alt="PBR skybox rendering" width="120"> | 0.091 | 0.091 | independent PBR skybox-mode gate |
| transmission-scene-color | <img src="images/scenes/transmission-scene-color.png" alt="Scene-color transmission" width="120"> | 0.044 | 0.208 | linear RGBA16F scene-color transmission |
| transmission-ior | <img src="images/scenes/transmission-ior.png" alt="Transmission IOR" width="120"> | 0.115 | 0.302 | refraction IOR without glTF-only dielectric F0 |
| transmission-volume | <img src="images/scenes/transmission-volume.png" alt="Transmission volume" width="120"> | 0.170 | 0.454 | Beer-Lambert volume and independent thickness-as-depth |
| 176 | <img src="images/scenes/scene176.png" alt="Mosquito in Amber" width="120"> | 0.418 | 0.418 | integrated linear transmission, IOR, volume, and scene-color copy |
| 213 | <img src="images/scenes/scene213.png" alt="Scene 213 rendering" width="120"> | 0.001 | 0.012 | GridMaterial opaque/transparent families and ordered draw lists |
| 248 | <img src="images/scenes/scene248.png" alt="Scene 248 rendering" width="120"> | 0.001 | 0.005 | external glTF and sampler modes |
| 249 | <img src="images/scenes/scene249.png" alt="Scene 249 rendering" width="120"> | 0.001 | 0.028 | vertex-color alpha and mask cutoff |
| 257 | <img src="images/scenes/scene257.png" alt="Scene 257 rendering" width="120"> | 0.001 | 0.006 | negative-scale hierarchy, generated normals |
| 266 | <img src="images/scenes/scene266.png" alt="Scene 266 rendering" width="120"> | 0.151 | 0.285 | mirrored spheres; 99.31% within one byte |
| 273 | <img src="images/scenes/scene273.png" alt="Scene 273 rendering" width="120"> | 0.000 | 0.000 | post-registration material-family addition |
| 274 | <img src="images/scenes/scene274.png" alt="Scene 274 rendering" width="120"> | 0.000 | 0.000 | 4x-MSAA alpha-to-coverage |

Scene 145's full-size HillValley render is `0.389` MAD; its aggregate residual
is concentrated in edge coverage inside the six-times-downscaled geometry
preview tiles. Scene 146's largest residuals are
view/world-normal and real-color tiles. Scene 13's
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

Exact position-seeded background dither is intentionally disabled: applying
the pinned formula across different raster backends decorrelates the noise and
raises BoomBox full MAD from `0.311` to `0.399`. The retained no-dither floor is
background `0.300`, edge `1.097`, and interior `0.167` MAD; no further
source-grounded BoomBox fix was identified.

## Shader pipeline

All native GPU shader families originate as WGSL and use pinned Tint. No HLSL
or MSL source templates remain under `src/`.

| Target | Offline path |
| --- | --- |
| D3D12 | WGSL → Tint HLSL → normalized registers/signatures → DXC DXIL |
| Vulkan | WGSL → Tint HLSL → normalization → DXC SPIR-V |
| Metal | WGSL → Tint MSL |

Tint Inspector bindings are checked against generated WGSL. DXIL/SPIR-V
artifacts are content-addressed and reused across scenes. Direct Tint SPIR-V is
deferred until its resource bindings are remapped to SDL_GPU conventions.

## Current boundaries

- one statically analyzable entry file and one engine
- selected TypeScript expressions, assignments, callbacks, and intrinsics
- no general modules/functions/control flow, arbitrary object graphs, or
  runtime module loading
- no animation, skinning, morph targets, physics, audio, or networking
- no general user WGSL; reached custom variants use typed WGSL reflection and
  required pinned Tint HLSL/MSL emission plus DXC DXIL/SPIR-V compilation
- GridMaterial, frame-graph blit/depth, and attribution utilities use
  generated WGSL through Tint
- ground and cubemap-skybox fragments use generated WGSL through Tint
- PBR and Standard material, diagnostic, and geometry variants use WGSL through
  Tint; no HLSL/MSL source templates remain
- D3D12 is validated locally; Vulkan and Metal artifacts are generated but
  still require real-device validation

## Next priorities

1. Validate Vulkan/SPIR-V and Metal/MSL on real hardware.
2. Replace converted native PBR WGSL with direct Babylon composer extraction.
