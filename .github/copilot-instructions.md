# bblitec repository instructions

## Project purpose

`bblitec` is an experimental compiler that lowers a reachable, statically
analyzable subset of `@babylonjs/lite` TypeScript to C++20. The native runtime
uses SDL3 for platform services and SDL_GPU for rendering.

The goal is not to reimplement Babylon Lite manually. Prefer generated code
derived from the pinned upstream TypeScript. Handwritten C++ belongs only in
the platform abstraction layer (PAL).

## Pinned upstream

- Package: `@babylonjs/lite@1.18.0`
- Source commit: `7184feda683072980735f9a180e6f567ee5717ba`
- Original TypeScript is reconstructed from published source maps.
- Generated files include provenance comments and
  `generated/<scene>/upstream/provenance.json`.

Do not silently update the package or source commit. An upstream update
requires regenerating outputs, reviewing changed formulas/constants, and
rerunning all compiler, build, and parity checks.

## Source ownership

- `src/compiler.ts`: entry-scene AST lowering, feature selection, assets, CMake
  manifest.
- `src/scene-registry.ts`: curated scene metadata, thresholds, references, and
  optional attribution capabilities.
- `src/scene-command.ts`: registered and ad-hoc scene generation/build/parity
  workflow.
- `src/parity-scene.ts`: common parity runner for all scenes.
- `src/upstream-source.ts`: pinned upstream source-map reconstruction.
- `src/upstream-graph.ts`: conservative reachable-module analysis.
- `src/upstream-lower.ts`: generated-source orchestration and provenance.
- `src/lowering/*-lowerer.ts`: dedicated upstream lowerers.
- `src/lowering/templates/`: typed C++ and portable shader templates emitted by
  lowerers.
- `native/include/bblite/`: typed runtime records, handles, TS runtime, PAL
  contracts.
- `native/src/pal.cpp`: filesystem, paths, environment, timing, host engine.
- `native/src/pal_sdl.cpp`: deterministic CPU fallback.
- `native/src/pal_sdl_gpu.cpp`: SDL window/input, GPU resources, uploads,
  pipelines, readback, and command submission.
- `generated/`: disposable compiler output. Never implement fixes directly
  there.

When logic describes Babylon behavior—scene traversal, camera matrices,
material properties, render buckets, PBR uniforms, shader equations, skybox or
ground geometry—it should be generated. When logic calls SDL or an operating
system API, it belongs in PAL.

## Type and language rules

- Explicit TypeScript `any` is forbidden. `test/no-any.test.ts` enforces this.
- Use typed records, discriminated unions, or `ts::JsonValue` narrowing.
- Avoid `as any`, broad casts, and success-shaped fallbacks.
- The native TS runtime is synchronous AOT by design: remote assets are
  materialized during transpilation and `Promise<T>` resolves immediately.
- Keep generated C++ C++20-compatible and warning-clean under MSVC `/W4
  /permissive-`.

## Renderer rules

- SDL_GPU is the default for generated PBR scenes.
- `BBLITE_GPU=0` forces the CPU fallback.
- Backends/artifacts:
  - Direct3D 12: DXIL
  - Vulkan: SPIR-V
  - Metal: MSL
- Generated shader sources live under
  `generated/<scene>/upstream/shaders`.
- The pinned Babylon formulas include GGX, Smith geometry, specular AA, SH
  irradiance, RGBD cubemap decoding, BRDF LUT use, energy conservation,
  exposure, tone mapping, and contrast.
- Babylon RGBD `.env` cubemap images require vertical row reversal when
  uploaded to SDL_GPU.
- DDS skyboxes are RGBA16F cubemaps with face-major, mip-minor layout.
- glTF material handling must be metadata-driven:
  `OPAQUE`, `MASK`, `BLEND`, alpha cutoff, and double-sided state. Do not add
  scene-name, geometry-position, or reference-image heuristics.
- The generated DDS skybox is enabled by default. The generated transparent
  ground is opt-in with `BBLITE_GROUND=1` because the committed Babylon.js
  golden does not compose it identically.

## Build order

Generation must complete before native builds. Do not run generation and a
native build concurrently because `features.cmake`, generated headers, and
shader paths may be stale.

```powershell
npm ci
npm test
npm run scenes:compile
npm run shaders:build
```

Then build the configured native directories sequentially:

```powershell
cmake --build native\build-sdl
cmake --build native\build-boombox
cmake --build native\build-boombox-release
cmake --build native\build-scene10-release
cmake --build native\build-scene13-release
```

On the development Windows machine, MSVC is 14.51 and Windows SDK is
10.0.26100.0. If a debug link fails with `LNK1104: ucrtd.lib`, ensure `LIB`
contains:

```text
<MSVC>\lib\x64
<Windows Kits>\Lib\10.0.26100.0\ucrt\x64
<Windows Kits>\Lib\10.0.26100.0\um\x64
```

Do not build multiple CMake trees concurrently against the same vcpkg install.
An executing debug `.exe` may also cause `LNK1168`.

## Validation

Use the smallest relevant checks, but renderer/compiler changes normally
require:

```powershell
npm test
npm run parity:boombox
npm run parity:boombox:gpu
npm run parity:scene10
npm run parity:scene13
npm run parity:diagnostics
```

Current measured baselines:

- CPU fallback: full MAD `4.452`, foreground MAD `21.191`,
  approximately `5.516 ms/frame`.
- Generated SDL_GPU/D3D12 with Babylon-default 4x MSAA: full MAD `0.447`,
  foreground MAD `2.003`, approximately `0.126 ms` average and `0.089 ms`
  median.
- GPU regression ceilings: full MAD `1.0`, foreground MAD `8.0`.
- Upstream target: full MAD `0.19`, foreground MAD `0.03`, 99% foreground
  pixels within one byte.

Parity reference:

- Playground: `#QCU8DJ#800`
- Resolution: 1280x720, DPR 1
- Background: `[51, 51, 77]`
- Foreground threshold: Euclidean distance `30`

Benchmark mode uses immediate presentation and three frames in flight:

```powershell
$env:BBLITE_BENCHMARK_FRAMES = "2000"
.\native\build-boombox-release\bblite_native.exe
```

## Workflow

- Do not edit generated files as the source of truth.
- Use `npm run scene -- process <source.ts>` for an unregistered scene.
- Add a registry entry only for curated thresholds, custom references,
  environment flags, or attribution capabilities.
- Add tests when extending compiler or lowering behavior.
- Keep lowerers focused; do not rebuild a monolithic compiler class.
- Preserve provenance for generated behavior.
- Record every intentional semantic adaptation in generated `fidelity.json`.
- Keep shader formulas tied to upstream markers in
  `renderer-fidelity.json`; do not tune backend shaders against a golden.
- Avoid unrelated cleanup.
- There is no hosted CI. Complete the documented local validation matrix
  before committing or pushing.
- Batch validated milestones and push intentionally.
