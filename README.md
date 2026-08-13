# Babylon Lite Native

> Experimental Babylon Lite TypeScript-to-C++ compiler with an SDL3 native
> runtime and dual SDL_GPU / Dawn (WebGPU) render backends.

`bblitec` compiles a statically analyzable subset of `@babylonjs/lite` scene
code into C++20. It reconstructs the pinned upstream TypeScript from source
maps, emits only reached features, materializes remote assets at compile time,
and keeps handwritten C++ at the platform abstraction layer.

**Status:** working research prototype, not a general JavaScript runtime.
Unsupported syntax and APIs fail at compile time with source locations.

![Babylon Lite, Babylon.js, and generated SDL_GPU BoomBox comparison](docs/images/boombox-comparison.png)

## Current proof points

- Pinned upstream: `@babylonjs/lite@1.20.0`,
  commit `95ed3029cc43e479ec924741aea4024e9bf33527`.
- 47 curated Babylon Lite parity scenes, including Scene 1 (BoomBox), plus
  primitives and project-owned differential regression gates.
- External glTF/GLB and a reached `.babylon` slice.
- Named local TypeScript modules plus typed non-recursive helper functions.
- A plain-data language slice — structs, nullable objects, dynamic arrays,
  enums, switch/break/continue, destructuring, spread, runtime Math, and
  seeded deterministic `Math.random` — validated by compiling the pinned
  tetris demo rules byte-identically against the browser reference.
- Generated Standard/PBR/Grid rendering, ordered draw lists, custom alpha
  variants, frame-graph MRT/depth passes, negative transforms, runtime scene
  mutation, property animation, and tree-shaken GPU deformation.
- Exact HDR GGX preprocessing and transmission/IOR/volume scene-color rendering.
- WGSL shaders compiled by pinned Tint for D3D12, Vulkan, and Metal.
- Two complete, mutually validating GPU backends: SDL_GPU over offline-compiled
  shaders, and Dawn (WebGPU) rendering through the browser reference's own
  compiler and rasterization stack — every expressible scene passes on both.

See [current status](docs/status.md) for the supported subset and all measured
scene results.

## Quick start

Requirements: Node.js 22+, CMake 3.24+, a C++20 compiler, vcpkg, PowerShell,
and Chrome/Edge with WebGPU for shader and HDR asset compilation.

```powershell
git clone https://github.com/sailro/bblitec.git
cd bblitec
npm ci
npm test

$env:VCPKG_ROOT = "C:\path\to\vcpkg"
npm run scene -- process scene1
npm run scene -- parity scene1
```

Process an unregistered repository-local scene with derived defaults:

```powershell
npm run scene -- process examples\my-scene.ts
npm run scene -- parity examples\my-scene.ts --recapture-reference
```

`process` performs generation, scene-local shader compilation, CMake
configuration, and a parallel native build. Ninja is the default generator;
set `BBLITE_CMAKE_GENERATOR` to override it. Build trees are disposable and
generator-specific.

## Documentation (start here in a fresh session)

| Page | Purpose |
| --- | --- |
| [Architecture](docs/architecture.md) | Compiler pipeline, ownership boundaries, runtime, renderer |
| [Development](docs/development.md) | Setup, commands, builds, switches, parity, troubleshooting |
| [Fidelity](docs/fidelity.md) | Semantic adaptations, shader contracts, diagnostics |
| [Status](docs/status.md) | Supported subset, measured baselines, known gaps |
| [Backends](docs/backends.md) | The two GPU render backends: architecture, comparison, porting contracts |
| [TODO](TODO.md) | Prioritized future work only |

## Design constraints

- Generate Babylon behavior from pinned upstream sources; PAL owns only OS and
  SDL mechanics.
- Preserve tree shaking, provenance, typed records, and C++20 portability.
- Do not tune shaders or loader behavior against a golden image.
- Keep generated output disposable; fix compiler, lowerer, template, or PAL
  sources instead.

## Acknowledgements

This prototype is not affiliated with or endorsed by Babylon.js. Babylon.js
and Babylon Lite are Apache-2.0 projects. DAWN, SDL, and downloaded assets
retain their respective licenses.
