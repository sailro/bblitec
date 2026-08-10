# Architecture

## Pipeline

```text
scene TypeScript
    -> AST validation and browser erasure
    -> reached features and materialized assets
    -> pinned Babylon Lite source reconstruction
    -> dedicated lowerers
    -> generated C++20, shaders, manifests, provenance
    -> typed runtime + PAL
    -> SDL3 / SDL_GPU
```

`bblitec` is a compiler, not an interpreter. Unsupported syntax or Babylon APIs
produce source-located errors.

The repository pins `@babylonjs/lite@1.18.0` and source commit
`7184feda683072980735f9a180e6f567ee5717ba`. Original TypeScript is recovered
from published source maps. Lowerers assert expected upstream symbols,
constants, and formulas before emitting code.

## Ownership

| Layer | Owns |
| --- | --- |
| Entry compiler | AST validation, feature selection, assets, generated main/CMake manifest |
| Upstream lowerers | Babylon semantics, typed records, render plans, uniforms, shader variants |
| Native runtime | handles, engine-owned records, immediate AOT TypeScript/Web primitives |
| PAL | files, paths, environment, clocks, SDL window/input, GPU resources and commands |

Babylon behavior must not migrate into PAL. SDL and operating-system mechanics
must not migrate into generated code.

## Scene orchestration

`src/scene-registry.ts` defines curated source/output/build paths, references,
thresholds, environment overrides, and optional attribution. The same workflow
also accepts unregistered repository-local TypeScript and derives defaults.

`src/scene-command.ts` provides compile, build, process, and parity operations.
`src/parity-scene.ts` is the common comparison runner. Generated output is
scene-local under `generated\<scene>`.

## Generated behavior

The current generated slice includes:

- engine, scene, camera, light, mesh, and material APIs
- external glTF packaging and typed GLB loading
- the HillValley-required `.babylon` loader slice
- Standard/PBR material records, no-color views, and typed custom shaders
- negative-transform winding, generated normals, and cotangent normal mapping
- `.env`/DDS environment parsing and background passes
- render buckets, camera matrices, uniforms, and frame-graph tasks
- Standard/PBR geometry MRTs, depth-only passes, blits, and MSAA resolve
- HLSL/MSL shader sources tied to pinned WGSL formulas

Each scene records:

- `manifest.json`: features, sources, assets, adaptations
- `fidelity.json`: intentional semantic adaptations
- `upstream/provenance.json`: upstream modules and symbols
- `upstream/renderer-fidelity.json`: shader contracts and invariants

## Runtime and memory

Engine-owned data uses contiguous vectors and typed handles. The native
TypeScript subset provides typed arrays, `DataView`, `TextDecoder`, typed JSON,
and immediate AOT `Promise<T>`.

The supported subset does not need tracing GC: locals use C++ lifetimes and
engine records live in arenas. A collector remains optional future work for
escaping closures, cyclic objects, or other genuinely dynamic JavaScript
graphs.

## Renderer

SDL_GPU is the default native renderer:

| Platform | Backend | Artifact |
| --- | --- | --- |
| Windows | Direct3D 12 | DXIL |
| Linux / Android | Vulkan | SPIR-V |
| macOS / iOS | Metal | MSL |

Important contracts:

- base-color/emissive textures are sRGB; normal/ORM textures are linear
- `.env` RGBD cubemap rows are vertically reversed for SDL_GPU upload
- DDS skyboxes are RGBA16F with face-major, mip-minor layout
- alpha mode, cutoff, blending, culling, and coverage are material-driven
- screenshot capture uses a readable target, then blits to the swapchain
- native builds snapshot reached shaders to avoid cross-scene drift

The SDL_Renderer path remains a deterministic CPU fallback.

## Future direction

The largest architectural gap is the shader pipeline. The current typed
variants should converge on a composed WGSL or shader IR with backend
reflection, ideally using Tint or SDL_shadercross. Vulkan, Metal, and browser
WebGPU still require hardware validation; SDL's upstream WebGPU backend remains
experimental.
