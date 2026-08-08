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
npm run compile:example
npm run compile:boombox
```

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
- `BBLITE_BENCHMARK_FRAMES=<n>`: warm up, disable vsync, and report
  submission timing

## Visual parity

Refresh the reference only intentionally:

```powershell
npm run parity:reference -- --force
```

Run both renderers:

```powershell
npm run parity:boombox
npm run parity:boombox:gpu
```

CI runs the deterministic CPU comparison. Treat GPU parity as a local/device
gate until hosted runners provide a stable backend and driver baseline.

Outputs are written to `artifacts/parity`:

- actual PNG
- diff map
- JSON report

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
- Pushing every intermediate commit and consuming limited CI compute.
