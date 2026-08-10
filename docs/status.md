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
| CPU fallback | <span style="color:#cf222e">2.075</span> | <span style="color:#cf222e">21.204</span> | 5.516 ms/frame |
| SDL_GPU, 4x MSAA | <span style="color:#1a7f37">0.001</span> | <span style="color:#1a7f37">0.015</span> | 0.176 ms average, 0.141 ms median |

The GPU path is approximately 31 times faster CPU-side. Against the pinned
Babylon Lite output, BoomBox rendering is effectively exact. Regression
ceilings are `0.01` full and `0.03` foreground MAD.

## Curated parity scenes

Thresholds live in `src/scene-registry.ts`; run one scene with
`npm run scene -- parity scene<ID>` or all registered parity scenes with
`npm run scenes:parity`.

MAD severity: <span style="color:#1a7f37">green below 0.500</span>,
<span style="color:#9a6700">yellow from 0.500 to below 1.000</span>, and
<span style="color:#cf222e">red above 1.000</span>.

| Scene | Preview | Full MAD | Foreground MAD | Primary coverage |
| ---: | :---: | ---: | ---: | --- |
| 8 | <img src="images/scenes/scene8.png" alt="Scene 8 rendering" width="120"> | <span style="color:#1a7f37">0.129</span> | <span style="color:#1a7f37">0.134</span> | exact 1024-sample HDR GGX, cubemap skybox, glass alpha/reflectance |
| 10 | <img src="images/scenes/scene10.png" alt="Scene 10 rendering" width="120"> | <span style="color:#1a7f37">0.000</span> | <span style="color:#1a7f37">0.000</span> | generated sphere, no-IBL PBR, geometric normals |
| 13 | <img src="images/scenes/scene13.png" alt="Scene 13 rendering" width="120"> | <span style="color:#1a7f37">0.010</span> | <span style="color:#1a7f37">0.081</span> | material grid, explicit occlusion semantics |
| 32 | <img src="images/scenes/scene32.png" alt="Scene 32 rendering" width="120"> | <span style="color:#1a7f37">0.000</span> | <span style="color:#1a7f37">0.000</span> | `KHR_materials_unlit` |
| 116 | <img src="images/scenes/scene116.png" alt="Scene 116 rendering" width="120"> | <span style="color:#1a7f37">0.000</span> | <span style="color:#1a7f37">0.000</span> | no-color material views, depth targets |
| 145 | <img src="images/scenes/scene145.png" alt="Scene 145 rendering" width="120"> | <span style="color:#cf222e">1.124</span> | <span style="color:#cf222e">1.118</span> | `.babylon`, Standard geometry outputs, default anisotropy |
| 146 | <img src="images/scenes/scene146.png" alt="Scene 146 rendering" width="120"> | <span style="color:#9a6700">0.845</span> | <span style="color:#9a6700">0.865</span> | PBR geometry outputs, 7+4 MRT composition |
| 163 | <img src="images/scenes/scene163.png" alt="Scene 163 rendering" width="120"> | <span style="color:#1a7f37">0.000</span> | <span style="color:#1a7f37">0.000</span> | custom shader blend, alpha test, discard |
| 168 | <img src="images/scenes/scene168.png" alt="Scene 168 rendering" width="120"> | <span style="color:#1a7f37">0.068</span> | <span style="color:#1a7f37">0.389</span> | mirrored double-sided winding; 100% within one byte |
| transmission-skybox | <img src="images/scenes/transmission-skybox.png" alt="PBR skybox rendering" width="120"> | <span style="color:#1a7f37">0.091</span> | <span style="color:#1a7f37">0.091</span> | independent PBR skybox-mode gate |
| transmission-scene-color | <img src="images/scenes/transmission-scene-color.png" alt="Scene-color transmission" width="120"> | <span style="color:#1a7f37">0.044</span> | <span style="color:#1a7f37">0.208</span> | linear RGBA16F scene-color transmission |
| transmission-ior | <img src="images/scenes/transmission-ior.png" alt="Transmission IOR" width="120"> | <span style="color:#1a7f37">0.115</span> | <span style="color:#1a7f37">0.302</span> | refraction IOR without glTF-only dielectric F0 |
| transmission-volume | <img src="images/scenes/transmission-volume.png" alt="Transmission volume" width="120"> | <span style="color:#1a7f37">0.170</span> | <span style="color:#1a7f37">0.454</span> | Beer-Lambert volume and independent thickness-as-depth |
| 176 | <img src="images/scenes/scene176.png" alt="Mosquito in Amber" width="120"> | <span style="color:#1a7f37">0.418</span> | <span style="color:#1a7f37">0.418</span> | integrated linear transmission, IOR, volume, and scene-color copy |
| 213 | <img src="images/scenes/scene213.png" alt="Scene 213 rendering" width="120"> | <span style="color:#1a7f37">0.000</span> | <span style="color:#1a7f37">0.001</span> | GridMaterial opaque/transparent families and ordered draw lists |
| 248 | <img src="images/scenes/scene248.png" alt="Scene 248 rendering" width="120"> | <span style="color:#1a7f37">0.001</span> | <span style="color:#1a7f37">0.005</span> | external glTF and sampler modes |
| 249 | <img src="images/scenes/scene249.png" alt="Scene 249 rendering" width="120"> | <span style="color:#1a7f37">0.001</span> | <span style="color:#1a7f37">0.024</span> | vertex-color alpha and mask cutoff |
| 257 | <img src="images/scenes/scene257.png" alt="Scene 257 rendering" width="120"> | <span style="color:#1a7f37">0.001</span> | <span style="color:#1a7f37">0.006</span> | negative-scale hierarchy, generated normals |
| 266 | <img src="images/scenes/scene266.png" alt="Scene 266 rendering" width="120"> | <span style="color:#1a7f37">0.130</span> | <span style="color:#1a7f37">0.247</span> | mirrored spheres; 99.46% within one byte |
| 273 | <img src="images/scenes/scene273.png" alt="Scene 273 rendering" width="120"> | <span style="color:#1a7f37">0.000</span> | <span style="color:#1a7f37">0.000</span> | post-registration material-family addition |
| 274 | <img src="images/scenes/scene274.png" alt="Scene 274 rendering" width="120"> | <span style="color:#1a7f37">0.000</span> | <span style="color:#1a7f37">0.000</span> | 4x-MSAA alpha-to-coverage |

Scene 145's full-size HillValley render is `0.101` MAD; its aggregate residual
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

Current BoomBox foreground diagnostic MAD: world normal `0.011`, albedo
`0.000`, reflectivity `0.000`, irradiance `0.040`, normalized depth `0.000`.

Legacy `.env` DDS backgrounds are opt-in so the default native composition
matches pinned Babylon Lite; explicit HDR skyboxes remain enabled by default.

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
