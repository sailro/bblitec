# Architecture

## Compiler pipeline

```text
scene TypeScript
    |
    v
TypeScript AST validation and browser erasure
    |
    +--> reached feature set
    +--> downloaded/materialized assets
    +--> generated main.cpp and features.cmake
    |
    v
pinned Babylon Lite public exports and source maps
    |
    v
reachable upstream modules + dedicated lowerers
    |
    +--> generated typed C++ implementations
    +--> generated render plans and uniforms
    +--> generated HLSL/MSL shader sources
    +--> provenance.json
    |
    v
C++20 runtime + PAL
    |
    v
SDL3 / SDL_GPU
```

`bblitec` is a compiler, not a JavaScript interpreter. Unsupported syntax or
Babylon APIs produce source-located compile errors.

## Upstream reconstruction

The repository pins `@babylonjs/lite@1.18.0` and source commit
`7184feda683072980735f9a180e6f567ee5717ba`. The published package source maps
embed original TypeScript in `sourcesContent`; `UpstreamSourceStore`
reconstructs modules from those maps and resolves public exports.

The BoomBox graph currently reaches 218 runtime modules and roughly 1.35 MiB
of TypeScript. The compiler does not generically lower every module yet.
Dedicated lowerers implement a verified vertical slice and assert that
expected upstream symbols, formulas, and constants still exist.

## Generated Babylon behavior

For the supported BoomBox path, generated output owns:

- engine and scene API wrappers
- scene registration and resource routing
- ArcRotate camera creation, framing, eye position, inertia, and controls
- hemispheric light records and local matrices
- `.env` parsing and spherical-harmonic conversion
- typed GLB/JSON parsing, accessors, geometry, hierarchy, materials, and
  embedded textures
- render-item selection and camera view-projection matrices
- PBR and background uniform preparation
- glTF material alpha and double-sided metadata
- Babylon PBR, IBL, tone mapping, specular AA, DDS skybox, and background
  shader sources

Generated files are written under `generated/<scene>/upstream`. The
`provenance.json` file records the upstream modules and symbols used.

## Platform abstraction layer

Handwritten native code is restricted to platform operations:

- local file reads and path handling
- environment variables and monotonic timing
- SDL window and event translation
- image decoding through SDL_image
- SDL_GPU resource creation, data upload, pipeline binding, command
  submission, presentation, and screenshot readback

`pal_sdl_gpu.cpp` is not intended to contain Babylon scene or material
semantics. Such logic belongs in generated renderer code.

## Typed native runtime

The runtime uses contiguous vectors and typed handles for engine-owned meshes,
materials, lights, cameras, geometry, assets, and scenes. It also provides a
strict subset of TypeScript/Web types:

- `ArrayBuffer`
- typed arrays
- `DataView`
- UTF-8 `TextDecoder`
- immediate AOT `Promise<T>` and `await`
- `JsonValue` variant and typed narrowing

No tracing collector is currently needed. Generated locals use C++ lifetime
rules and engine records live in arenas. Boehm GC is reserved for future
dynamic JavaScript object graphs, escaping closures, and cyclic allocations.

## GPU renderer

SDL_GPU is the default for glTF scenes:

| Platform | Backend | Shader format |
| --- | --- | --- |
| Windows | Direct3D 12 | DXIL |
| Linux / Android | Vulkan | SPIR-V |
| macOS / iOS | Metal | MSL |

Shader sources are emitted into `generated/<scene>/upstream/shaders`. DXIL and
SPIR-V are compiled with DXC; MSL source is emitted directly.

Important cross-API details:

- Babylon `.env` RGBD faces are decoded as
  `pow(rgb, 2.2) / max(alpha, 1/255)`.
- RGBD cubemap rows are vertically reversed during upload to match Babylon's
  WebGPU decode path and SDL_GPU cube sampling.
- DDS skyboxes use RGBA16F, six faces, all mip levels, face-major layout.
- Base-color and emissive textures are sampled as sRGB; normal and
  metallic-roughness textures are linear.
- Material draw buckets honor glTF `OPAQUE`, `MASK`, `BLEND`, alpha cutoff,
  and double-sided flags.
- Screenshot capture renders to a readable color texture, blits to the
  write-only swapchain, then downloads from the readable texture.

## Portability and WebGPU

SDL issue
[`libsdl-org/SDL#10768`](https://github.com/libsdl-org/SDL/issues/10768)
tracks an SDL_GPU WebGPU backend. Experimental forks demonstrate browser
support using Emscripten/Emdawn and Tint-generated WGSL, but upstream support
is still open. It is useful future work, not a stable dependency.

A future general shader pipeline should prefer a common intermediate
representation or Tint/SDL_shadercross flow over maintaining scene-specific
backend emitters.
