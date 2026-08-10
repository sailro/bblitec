# Babylon Lite Native

> Experimental Babylon Lite TypeScript-to-C++ compiler with an SDL3/SDL_GPU
> native runtime.

`bblitec` compiles a statically analyzable subset of `@babylonjs/lite` scene
code into C++20. It reconstructs the pinned upstream TypeScript from source
maps, emits only reached features, materializes remote assets at compile time,
and keeps handwritten C++ at the platform abstraction layer.

**Status:** working research prototype, not a general JavaScript runtime.
Unsupported syntax and APIs fail at compile time with source locations.

![Babylon Lite, Babylon.js, and generated SDL_GPU BoomBox comparison](docs/images/boombox-comparison.png)

## Current proof points

- Pinned upstream: `@babylonjs/lite@1.18.0`,
  commit `7184feda683072980735f9a180e6f567ee5717ba`.
- 24 curated Babylon Lite parity scenes plus BoomBox and primitives.
- External glTF/GLB and a reached `.babylon` slice.
- Generated Standard/PBR/Grid rendering, ordered draw lists, custom alpha
  variants, frame-graph MRT/depth passes, negative transforms, and runtime
  scene mutation.
- Exact HDR GGX preprocessing and transmission/IOR/volume scene-color rendering.
- WGSL shaders compiled by pinned Tint for D3D12, Vulkan, and Metal.
- BoomBox D3D12 baseline: `0.001` full MAD, `0.015` foreground MAD,
  `0.176 ms` average CPU submission.

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
npm run scene -- process boombox
npm run scene -- parity boombox
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

## Documentation

| Page | Purpose |
| --- | --- |
| [Architecture](docs/architecture.md) | Compiler pipeline, ownership boundaries, runtime, renderer |
| [Development](docs/development.md) | Setup, commands, builds, switches, parity, troubleshooting |
| [Fidelity](docs/fidelity.md) | Semantic adaptations, shader contracts, diagnostics |
| [Status](docs/status.md) | Supported subset, measured baselines, known gaps |
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
and Babylon Lite are Apache-2.0 projects. SDL, SDL_image, nlohmann-json, and
downloaded assets retain their respective licenses.
