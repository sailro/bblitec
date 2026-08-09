# Current status

## Supported vertical slice

The compiler currently supports the primitives example and the authoritative
BoomBox parity scene.

| Area | Current support |
| --- | --- |
| Engine | creation, scene registration, run loop |
| Scene | clear color, camera, resource membership |
| Camera | ArcRotate, default framing, inertia, pointer and keyboard input |
| Lighting | hemispheric light and matrix |
| Geometry | box, ground, typed triangle GLB |
| glTF | embedded images, accessors, hierarchy, metallic-roughness materials |
| Materials | base color, normal, ORM, emissive, alpha modes, double-sided |
| Environment | Babylon `.env`, SH irradiance, RGBD mips, BRDF LUT |
| Background | RGBA16F DDS skybox; generated optional transparent ground |
| Rendering | generated PBR/IBL shaders and render preparation over SDL_GPU |
| Fallback | deterministic SDL_Renderer CPU path |

## Measured BoomBox results

Development machine:

| Renderer | Full MAD | Foreground MAD | Submission time |
| --- | ---: | ---: | ---: |
| CPU fallback | 4.452 | 21.191 | 5.516 ms/frame |
| Generated SDL_GPU/D3D12 | 0.945 | 7.761 | 0.111 ms average, 0.073 ms median |

The GPU path is approximately 50 times faster CPU-side than the fallback.

Current GPU diff attribution:

| Region | MAD |
| --- | ---: |
| Background | 0.408 |
| Foreground high-gradient/edges | 15.472 |
| Foreground interior | 4.213 |

The residual error is therefore dominated by raster/high-gradient boundaries,
not the environment background. Signed foreground bias is approximately
`[-3.99, -4.13, -4.46]` RGB bytes, so material interiors are also slightly
darker than the reference.

The optional GPU ID pass maps all visible BoomBox pixels to draw ID `1`,
node/mesh `BoomBox`, material `BoomBox_Mat`. Because the source asset is one
large primitive, parity also emits 128-triangle cluster IDs and PBR
intermediate captures for normal, material, direct light, IBL, and depth.

Highest-error triangle clusters in the current capture:

| Cluster | Triangle range | Visible bounds | MAD | Likely region |
| --- | --- | --- | ---: | --- |
| 14 | 1664–1791 | `x=786,y=317,w=11,h=10` | 47.470 | antenna/base edge |
| 15 | 1792–1919 | `x=784,y=221,w=15,h=131` | 36.988 | antenna |
| 34 | 4224–4351 | `x=473,y=366,w=9,h=76` | 33.596 | left silhouette |
| 40 | 4992–5119 | `x=758,y=382,w=49,h=120` | 32.881 | right speaker |
| 43 | 5376–5503 | `x=478,y=345,w=55,h=135` | 28.734 | left body boundary |

Current GPU regression ceilings:

- full-image MAD: `1.0`
- foreground-region MAD: `8.0`

Babylon Lite's upstream goal remains:

- full-image MAD: `0.19`
- foreground-region MAD: `0.03`
- 99% foreground pixels within one byte

## Honest boundary

This is true transpilation for the supported reachable subset, not yet a
universal Babylon Lite compiler.

Remaining compiler work includes:

- general TypeScript lowering for more functions, loops, callbacks, closures,
  and modules
- a general composed-WGSL lowering pipeline
- more glTF extensions, animation, skinning, and morph targets
- render graph features beyond the current scene
- audio, physics, networking, and other Web/platform APIs
- real Vulkan and Metal device validation
- optional browser output when SDL_GPU WebGPU support stabilizes

## Next priorities

1. Replace specialized shader templates with a general Babylon WGSL/IR
   pipeline, potentially using Tint or SDL_shadercross.
2. Validate generated SPIR-V on Vulkan and MSL on Metal hardware.
3. Add a second unrelated glTF scene as a generalization test.
4. Expand glTF material extensions and animation support.
5. Continue shrinking PAL to platform-only mechanics.
