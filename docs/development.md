# Development guide

## Install and test

```powershell
npm ci
npm test
```

The test suite validates the compiler, parity math, pinned upstream source
reconstruction, asset specialization, lowerers, generated render plans, and
the no-`any` rule.

## Generate scenes

```powershell
npm run scenes:list
npm run scenes:compile
```

Individual aliases remain available:

```powershell
npm run compile:example
npm run compile:boombox
npm run compile:scene10
npm run compile:scene13
npm run compile:scene32
npm run compile:scene116
npm run compile:scene145
npm run compile:scene146
npm run compile:scene163
npm run compile:scene168
npm run compile:scene248
npm run compile:scene257
npm run compile:scene266
npm run compile:scene273
npm run compile:scene274
```

Unregistered scene files use derived defaults and do not require a registry
edit:

```powershell
npm run scene -- show examples\my-scene.ts
npm run scene -- compile examples\my-scene.ts
npm run scene -- process examples\my-scene.ts
```

For `examples\my-scene.ts`, defaults are:

- scene ID: `my-scene`
- generated output: `generated\my-scene`
- native build directory: `native\build-my-scene-release`
- reference: `reference\my-scene\babylon-lite-golden.png`
- parity artifacts: `artifacts\parity\my-scene`

`process` runs generation, shader compilation, CMake configuration, and the
native build. It compiles only that scene's shader directory. Set `VCPKG_ROOT`
when CMake cannot discover the vcpkg toolchain;
set `CMAKE_COMMAND` when `cmake` is not on `PATH`.

Parity can also run without registration:

```powershell
npm run scene -- parity examples\my-scene.ts --recapture-reference
```

Add a registry entry only when the scene needs stable thresholds, a custom
reference source, native environment flags, or diagnostic attribution.

Generation:

- analyzes the entry TypeScript
- downloads remote assets into `generated/<scene>/assets`
- emits typed C++ and headers
- emits scene-local shaders
- writes `features.cmake`, `manifest.json`, and `provenance.json`

Always generate before building. Parallel generation and native builds can
consume a stale `features.cmake`.

## Compile shaders

The shader tool manifest is `tools/shader-compiler/vcpkg.json`.

```powershell
cd tools\shader-compiler
$env:VCPKG_ROOT = "C:\path\to\vcpkg"
& "$env:VCPKG_ROOT\vcpkg.exe" install
cd ..\..
npm run shaders:build
```

The Windows SDK DXC may not support SPIR-V. Use the vcpkg
`directx-dxc` executable or set `DXC_PATH`.

## Build native targets

Configure with a vcpkg toolchain and the desired generated scene:

```powershell
cmake -S native -B native\build-boombox-release `
  -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT\scripts\buildsystems\vcpkg.cmake" `
  -DBBLITE_GENERATED_DIR="$PWD\generated\boombox"
cmake --build native\build-boombox-release
```

Existing development build directories:

- `native\build-sdl`: primitive/debug target
- `native\build-boombox`: BoomBox/debug target
- `native\build-boombox-release`: BoomBox/Release target
- `native\build-scene10-release`: Babylon Lite scene 10/Release target
- `native\build-scene13-release`: Babylon Lite scene 13/Release target
- `native\build-scene32-release`: Babylon Lite scene 32/Release target
- `native\build-scene116-release`: Babylon Lite scene 116/Release target
- `native\build-scene145-release`: Babylon Lite scene 145/Release target
- `native\build-scene146-release`: Babylon Lite scene 146/Release target
- `native\build-scene163-release`: Babylon Lite scene 163/Release target
- `native\build-scene168-release`: Babylon Lite scene 168/Release target
- `native\build-scene248-release`: Babylon Lite scene 248/Release target
- `native\build-scene257-release`: Babylon Lite scene 257/Release target
- `native\build-scene266-release`: Babylon Lite scene 266/Release target
- `native\build-scene273-release`: Babylon Lite scene 273/Release target
- `native\build-scene274-release`: Babylon Lite scene 274/Release target

Build them sequentially. Concurrent vcpkg/CMake work against the same install
root is unreliable.

### Windows linker troubleshooting

An executing debug executable may lock the output and cause `LNK1168`.

If `ucrtd.lib` is not found, define MSVC and SDK paths in the same shell:

```powershell
$env:LIB = @(
  "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231\lib\x64",
  "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64",
  "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64"
) -join ";"
```

## Runtime controls and switches

- left drag: orbit
- right/middle drag: pan
- wheel: zoom
- arrows: orbit fallback
- `W` / `S`: zoom fallback
- `BBLITE_GPU=0`: force CPU fallback
- `BBLITE_GROUND=1`: enable generated transparent ground
- `BBLITE_MAX_FRAMES=<n>`: automated frame limit
- `BBLITE_SCREENSHOT=<path>`: deterministic PNG capture
- `BBLITE_SCREENSHOT_FRAME=<zero-based n>`: defer capture until a callback-driven scene settles
- `BBLITE_BENCHMARK_FRAMES=<n>`: warm up, disable vsync, and report
  submission timing
- `BBLITE_ASSET_DIR=<path>`: override the compiled asset directory
- `BBLITE_GPU_SHADER_DIR=<path>`: override the compiled shader directory

## Portable BoomBox demo

After building `native\build-boombox-release` and compiling shaders:

```powershell
npm run package:boombox
```

This creates
`artifacts\releases\bblitec-boombox-windows-x64.zip` containing the executable,
assets, DXIL shaders, SDL/PNG/zlib/MSVC runtime DLLs, launchers, usage notes,
asset sources, and dependency licenses. The default launcher requests Direct3D
12 and falls back to SDL_Renderer when SDL_GPU initialization fails.

## Visual parity

Refresh the reference only intentionally:

```powershell
npm run parity:reference -- --force
```

Run both renderers:

```powershell
npm run parity:boombox
npm run parity:boombox:gpu
npm run parity:scene10
npm run parity:scene13
npm run parity:scene32
npm run parity:scene116
npm run parity:scene145
npm run parity:scene146
npm run parity:scene163
npm run parity:scene168
npm run parity:scene248
npm run parity:scene257
npm run parity:scene266
npm run parity:scene273
npm run parity:scene274
```

All scene metadata lives in `src/scene-registry.ts`. Parity capabilities such
as draw IDs, triangle clusters, and diagnostic MRTs are enabled per scene in
that registry and consumed by the common `parity-scene` runner.

There is no hosted CI. CPU parity and GPU parity are local gates; GPU reports
must always record the backend and driver used.

Outputs are written to `artifacts/parity`:

- actual PNG
- renderer-specific diff map (`diff-map-cpu.png` or `diff-map-gpu.png`)
- annotated hotspot map (`hotspots-cpu.png` or `hotspots-gpu.png`)
- lossless and colorized GPU draw-ID maps (`draw-ids-gpu.png` and
  `draw-ids-visual-gpu.png`)
- lossless and colorized triangle-cluster maps
- world-normal, reflectivity, irradiance, IBL, normalized-depth, albedo, and
  direct-light captures from the production PBR shader's diagnostics variant
- renderer-specific JSON report (`report-cpu.json` or `report-gpu.json`)

Reports include background/edge/interior attribution, signed channel bias, and
the highest-error foreground tiles. See [fidelity.md](fidelity.md).

The committed golden is
`reference/boombox/babylon-ref-golden.png`.

## Common mistakes

- Editing `generated/` instead of a compiler/lowerer/template source.
- Adding handwritten Babylon semantics to PAL.
- Using explicit TypeScript `any`.
- Treating the swapchain as readable; SDL_GPU swapchain textures are
  write-only.
- Forgetting RGBD cubemap vertical orientation.
- Sampling metallic-roughness or normal textures as sRGB.
- Ignoring glTF alpha mode, alpha cutoff, or double-sided state.
- Benchmarking with vsync enabled.
- Running generation and build in parallel.
- Committing or pushing without completing the relevant local validation.
