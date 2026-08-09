# Current status

## Supported vertical slice

The compiler currently supports the primitives example, the authoritative
BoomBox parity scene, and Babylon Lite parity scenes 10 and 13.

| Area | Current support |
| --- | --- |
| Engine | creation, scene registration, run loop |
| Scene | clear color, camera, resource membership |
| Camera | ArcRotate, default framing, inertia, pointer and keyboard input |
| Lighting | hemispheric light and matrix |
| Geometry | box, ground, generated sphere, typed triangle GLB |
| glTF | embedded images, accessors, hierarchy, metallic-roughness materials |
| Materials | standard and PBR; base color, normal, ORM, emissive, alpha modes, double-sided |
| Environment | Babylon `.env`, SH irradiance, RGBD mips, BRDF LUT |
| Background | RGBA16F DDS skybox; generated optional transparent ground |
| Rendering | generated PBR/IBL shaders and render preparation over SDL_GPU |
| Fallback | deterministic SDL_Renderer CPU path |

## Measured BoomBox results

Development machine:

| Renderer | Full MAD | Foreground MAD | Submission time |
| --- | ---: | ---: | ---: |
| CPU fallback | 4.452 | 21.191 | 5.516 ms/frame |
| Generated SDL_GPU/D3D12, 4x MSAA | 0.447 | 2.003 | 0.126 ms average, 0.089 ms median |

The GPU path is approximately 44 times faster CPU-side than the fallback.

Current GPU diff attribution:

| Region | MAD |
| --- | ---: |
| Background | 0.324 |
| Foreground high-gradient/edges | 5.314 |
| Foreground interior | 0.479 |

The residual error is therefore dominated by raster/high-gradient boundaries,
not the environment background. Signed foreground bias is approximately
`[0.78, 0.79, 0.76]` RGB bytes.

## Babylon Lite scene 10

The first suite-derived generalization target is the no-environment PBR rough
sphere. It validates generated sphere topology, solid-texture quantization,
hemispheric direct lighting, no-IBL shader specialization, and image
processing independently of glTF.

| Full MAD | Foreground MAD | Maximum byte difference |
| ---: | ---: | ---: |
| 0.025 | 0.239 | 2 |

The local regression ceilings are `0.03` full-image MAD and `0.25`
foreground MAD. Run `npm run parity:scene10`.

## Babylon Lite scene 13

The PBR spheres grid validates multiple glTF materials across metallic,
roughness, and base-color ranges. It exposed that metallic-roughness `R` must
not be used as occlusion unless glTF declares an explicit `occlusionTexture`.

| Full MAD | Foreground MAD | Foreground interior MAD |
| ---: | ---: | ---: |
| 0.636 | 0.313 | 0.178 |

The full-image value is currently dominated by the known generated-ground
composition difference. Initial regression ceilings are `0.7` full MAD and
`0.4` foreground MAD. Run `npm run parity:scene13`.

The optional GPU ID pass maps all visible BoomBox pixels to draw ID `1`,
node/mesh `BoomBox`, material `BoomBox_Mat`. Because the source asset is one
large primitive, parity also emits 128-triangle cluster IDs and PBR
intermediate captures for world normal, reflectivity, irradiance, IBL,
normalized depth, albedo, and direct light.

Current Babylon Lite WebGPU-oracle comparisons:

| Intermediate buffer | Foreground MAD |
| --- | ---: |
| World normal | 0.708 |
| Surface albedo | 1.163 |
| Reflectivity | 2.020 |
| Irradiance | 1.119 |
| Normalized view depth | 0.000 |

Native diagnostic attachments use Babylon Lite's formats, clear values, and
generated 4x MSAA sample count. Normalized depth is now bit-exact across the
full image.

Highest-error triangle clusters in the current capture:

| Cluster | Triangle range | Visible bounds | MAD | Likely region |
| --- | --- | --- | ---: | --- |
| 40 | 4992–5119 | `x=758,y=382,w=49,h=120` | 10.533 | right speaker |
| 12 | 1408–1535 | `x=515,y=301,w=231,h=5` | 9.292 | top control edge |
| 19 | 2304–2431 | `x=790,y=314,w=3,h=5` | 8.769 | right antenna/base edge |
| 34 | 4224–4351 | `x=473,y=366,w=9,h=76` | 7.404 | left silhouette |
| 47 | 5888–6015 | `x=670,y=274,w=137,h=122` | 6.830 | upper-right body |

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
3. Add scene 32 as the next parity-ladder target.
4. Expand glTF material extensions and animation support toward scene 176.
5. Continue shrinking PAL to platform-only mechanics.
