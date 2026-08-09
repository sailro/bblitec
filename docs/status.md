# Current status

## Supported vertical slice

The compiler currently supports the primitives example, the authoritative
BoomBox parity scene, and Babylon Lite parity scenes 10, 13, 32, 145, 146, 168,
248, 257, 266, 273, and 274.

| Area | Current support |
| --- | --- |
| Engine | creation, scene registration, run loop |
| Scene | clear color, camera, fixed delta, resource membership, reached before-render callbacks |
| Camera | ArcRotate, FreeCamera, default framing, inertia, pointer and keyboard input |
| Lighting | hemispheric and point lights |
| Geometry | box, ground, generated sphere, typed triangle GLB, packaged `.babylon` geometry |
| glTF | GLB and external glTF packaging, images, samplers, accessors, hierarchy, negative-scale winding, metallic-roughness materials |
| Materials | standard, PBR, and typed reached custom shader variants; Babylon diffuse/ambient/specular/opacity/cube-reflection textures, base color, normal, ORM, emissive, alpha modes, double-sided, alpha testing/discard, conventional blending, alpha-to-coverage |
| Environment | Babylon `.env`, SH irradiance, RGBD mips, BRDF LUT |
| Background | RGBA16F DDS skybox; generated optional transparent ground |
| Frame graph | typed render targets/tasks, PBR and Standard geometry MRTs, viewport shader blits, and MSAA resolve |
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
hemispheric direct lighting, geometric normals when no normal texture exists,
no-IBL shader specialization, and image processing independently of glTF.

| Full MAD | Foreground MAD | Maximum byte difference |
| ---: | ---: | ---: |
| 0.000 | 0.000 | 1 |

Only one color byte differs by one. The local regression ceilings remain
`0.03` full-image MAD and `0.25` foreground MAD. Run
`npm run parity:scene10`.

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

## Babylon Lite scene 32

The KHR_materials_unlit model validates texture/base-color output without PBR
lighting. Unlit remains a feature flag inside the shared PBR pipeline.

| Full MAD | Foreground MAD | Foreground within one byte |
| ---: | ---: | ---: |
| 0.000 | 0.000 | 100.00% |

Preserving the scene clear color through environment loading makes this target
pixel-exact. Regression ceilings are `0.001` full and foreground MAD. Run
`npm run parity:scene32`.

## Babylon Lite scene 168

The pinned MirroredDoubleSided fixture places identical double-sided quads
under identity and negative-scale transforms. The generated loader now
canonicalizes triangle winding for negative-determinant node transforms and
adjusts tangent handedness consistently with the glTF-to-native handedness
conversion.

| Full MAD | Foreground MAD | Maximum byte difference |
| ---: | ---: | ---: |
| 0.023 | 0.130 | 1 |

Regression ceilings are `0.03` full MAD and `0.15` foreground MAD. Run
`npm run parity:scene168`.

## Babylon Lite scene 248

The TextureSettingsTest model validates compile-time packaging of external
glTF buffers and images plus glTF sampler filtering, mip selection, repeat,
clamp, and mirrored-repeat modes. It also exposed two shared renderer bugs:
environment-only scenes received an unintended white direct light, and
double-sided back faces did not flip their shading normals.

| Full MAD | Foreground MAD | Maximum byte difference |
| ---: | ---: | ---: |
| 0.017 | 0.099 | 1 |

Regression ceilings are `0.03` full MAD and `0.15` foreground MAD. Run
`npm run parity:scene248`.

## Babylon Lite scene 257

The Node_NegativeScale_01 generator asset validates negative-scale hierarchy
handling with external buffers, base-color/ORM/normal textures, and generated
vertex normals. For normal-mapped meshes without tangent accessors, the shader
now uses Babylon Lite's derivative cotangent frame.

| Full MAD | Foreground MAD | Foreground within one byte |
| ---: | ---: | ---: |
| 0.009 | 0.066 | 98.22% |

Regression ceilings are `0.02` full MAD and `0.1` foreground MAD. Run
`npm run parity:scene257`.

## Babylon Lite scene 266

The NegativeScaleTest sphere grid validates double-sided dielectric and
metallic PBR materials across mirrored and unmirrored nodes. It confirms that
triangle winding and fragment front-facing normal flips remain consistent for
reflective curved geometry.

| Full MAD | Foreground MAD | Foreground within one byte |
| ---: | ---: | ---: |
| 0.115 | 0.214 | 99.02% |

Residual error is concentrated on reflective raster edges; foreground
interior MAD is `0.158`. Regression ceilings are `0.15` full MAD and `0.3`
foreground MAD. Run `npm run parity:scene266`.

## Babylon Lite scene 273

The runtime material-family target registers a scene containing only generated
Standard box/ground meshes, then uses a fixed `16 ms` delta and
`onBeforeRender` to append the first PBR mesh at frame 20. The renderer detects
the post-registration membership/family change and materializes its GPU
geometry and bindings without rebuilding the scene or using scene-specific
logic.

| Full MAD | Foreground MAD | Maximum byte difference |
| ---: | ---: | ---: |
| 0.000 | 0.000 | 0 |

This also gates generated box/ground topology, plain-scene Standard buckets,
normal-texture absence, and PBR metallic, roughness, direct-intensity, and
environment-intensity fields. The synchronous AOT runtime captures the first
rendered frame after the add (native frame 19); the browser reference retains
the upstream 150-frame asynchronous settle. Regression ceilings are `0.001`
full and foreground MAD. Run `npm run parity:scene273`.

## Babylon Lite scene 274

The alpha-to-coverage target validates generated plane geometry, the reached
custom shader-material uniform shape, depth replacement, 4x MSAA rendering,
and SDL_GPU alpha-to-coverage pipeline state.

| Full MAD | Foreground MAD | Maximum byte difference |
| ---: | ---: | ---: |
| 0.000 | 0.000 | 0 |

The target is pixel-exact. Regression ceilings are `0.001` full and foreground
MAD. Run `npm run parity:scene274`.

## Babylon Lite scene 163

The custom shader alpha-cutout target validates typed reached shader selection,
world-view-projection vertex lowering with a UV varying, circular fragment
discard, conventional source-alpha blending, alpha testing, disabled back-face
culling, and generated 3x3 plane geometry.

| Full MAD | Foreground MAD | Maximum byte difference |
| ---: | ---: | ---: |
| 0.000 | 0.000 | 0 |

The target is pixel-exact. Regression ceilings are `0.001` full and foreground
MAD. Run `npm run parity:scene163`.

## Babylon Lite scene 116

The no-color material-view target validates generated torus geometry,
fixed-size depth-only render-target textures, Standard and PBR no-color
material views, explicit render-task mesh/material overrides, per-task Free
cameras, reverse-depth sampling, and unlit Standard planes displaying the
depth textures.

| Full MAD | Foreground MAD | Maximum byte difference |
| ---: | ---: | ---: |
| 0.000021 | 0.000150 | 19 |

Only eleven pixels differ, all at raster edges; 99.999% of foreground pixels
are within five bytes. Regression ceilings are `0.001` full and foreground MAD.
Run `npm run parity:scene116`.

## Babylon Lite scene 145

The pinned HillValley target validates compile-time `.babylon` packaging,
inline geometry and submeshes, Standard materials, UV2 ambient lightmaps,
alpha-cutout diffuse textures, opacity/specular textures, point lighting,
cube reflections, FreeCamera state, and the same 7+4 geometry-output frame
graph used by scene 146.

| Full MAD | Foreground MAD | Main scene MAD excluding strips |
| ---: | ---: | ---: |
| 5.063 | 5.042 | 2.781 |

The remaining error is concentrated in the geometry impostor strips,
especially the Standard world-position output; the lit HillValley scene is
substantially closer. Regression ceilings are `5.2` full and foreground MAD.
Run `npm run parity:scene145`.

## Babylon Lite scene 146

The Sponza target validates the PBR geometry material view with all eleven
geometry outputs split across 7+4 MRT attachments, optional real color,
independent depth targets, viewport impostor strips, and 4x MSAA resolve.
The source uses an equivalent ArcRotate camera at the official FreeCamera
position so the entry remains statically analyzable.

| Full MAD | Foreground MAD | Foreground interior MAD |
| ---: | ---: | ---: |
| 1.879 | 1.826 | 0.926 |

Per-output residuals are highest for view normal (`7.895`), world normal
(`8.348`), and real color (`5.087`) tile MAD; local/world position, depth,
velocity, reflectivity, and irradiance are substantially closer. Regression
ceilings are `2.0` full and foreground MAD. Run `npm run parity:scene146`.

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
3. Add winding and negative-scale parity targets.
4. Expand glTF material extensions and animation support toward scene 176.
5. Continue shrinking PAL to platform-only mechanics.
