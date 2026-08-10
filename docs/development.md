# Development guide

## Requirements

- Node.js 22+
- CMake 3.24+
- a C++20 compiler
- vcpkg
- PowerShell and DXC for shader compilation

The documented Windows toolchain is MSVC 14.51 with Windows SDK
10.0.26100.0. Linux and macOS use the same generated sources with their native
CMake generator and SDL_GPU backend.

## Core workflow

```powershell
npm ci
npm test
npm run scenes:list
npm run scenes:compile
npm run shaders:build
```

Use the generic scene command rather than adding scripts for ordinary work:

```powershell
npm run scene -- show boombox
npm run scene -- compile boombox
npm run scene -- build boombox
npm run scene -- process boombox
npm run scene -- parity boombox
```

`process` runs compile, scene-local shader compilation, CMake configure, and
native build in order.

Package aliases such as `compile:scene116` and `parity:scene116` exist for
curated gates; `src/scene-registry.ts` is their source of truth.

## Ad-hoc scenes

A repository-local TypeScript file does not need a registry entry:

```powershell
npm run scene -- process examples\my-scene.ts
npm run scene -- parity examples\my-scene.ts --recapture-reference
```

Derived paths:

| Artifact | Path |
| --- | --- |
| generated output | `generated\my-scene` |
| native build | `native\build-my-scene-release` |
| reference | `reference\my-scene\babylon-lite-golden.png` |
| parity output | `artifacts\parity\my-scene` |

Add a registry entry only for stable thresholds, custom references, native
environment flags, or attribution capabilities.

## Generation and assets

Generation:

- validates the entry TypeScript and reached APIs
- materializes remote assets under `generated\<scene>\assets`
- emits typed C++, headers, scene-local shaders, and CMake features
- writes `manifest.json`, `fidelity.json`, and upstream provenance

`generated\` is disposable. Never fix generated files directly.

Generation must finish before shader compilation and native build. Do not run
those phases concurrently.

## Shader compilation

Install the shader tool manifest once:

```powershell
cd tools\shader-compiler
$env:VCPKG_ROOT = "C:\path\to\vcpkg"
& "$env:VCPKG_ROOT\vcpkg.exe" install
cd ..\..
npm run shaders:build
```

Set `DXC_PATH` when DXC is not discoverable. The Windows SDK DXC may lack
SPIR-V support; the vcpkg `directx-dxc` build is preferred.

Native CMake builds snapshot the reached shader directory. Rebuild a scene
after regenerating or recompiling its shaders.

## Native builds

`scene -- build` configures the registry-derived build directory and invokes
`cmake --build`. Set:

```powershell
$env:VCPKG_ROOT = "C:\path\to\vcpkg"
$env:CMAKE_COMMAND = "C:\path\to\cmake.exe" # only when cmake is not on PATH
```

Manual equivalent:

```powershell
cmake -S native -B native\build-boombox-release `
  -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT\scripts\buildsystems\vcpkg.cmake" `
  -DBBLITE_GENERATED_DIR="$PWD\generated\boombox"
cmake --build native\build-boombox-release --config Release
```

CMake generators are not hardcoded. A fresh Windows tree may use Visual
Studio; Linux commonly uses Unix Makefiles or Ninja. Never reuse one build
directory with a different generator. All build trees are ignored and safe to
delete.

Build scenes sequentially: concurrent vcpkg use is unreliable.

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU=0` | force SDL_Renderer fallback |
| `BBLITE_GPU_REQUIRED=1` | fail instead of falling back |
| `BBLITE_GROUND=1` | enable generated transparent ground |
| `BBLITE_MAX_FRAMES=<n>` | automated frame limit |
| `BBLITE_SCREENSHOT=<path>` | capture PNG |
| `BBLITE_SCREENSHOT_FRAME=<n>` | delay callback-driven capture |
| `BBLITE_BENCHMARK_FRAMES=<n>` | benchmark after warmup |
| `BBLITE_ASSET_DIR=<path>` | override asset directory |
| `BBLITE_GPU_SHADER_DIR=<path>` | override shader directory |

Controls: left-drag orbit, right/middle-drag pan, wheel zoom; arrows and
`W`/`S` are keyboard fallbacks.

## Parity

Run a curated scene:

```powershell
npm run scene -- parity scene273
```

Refresh a source-based reference only intentionally:

```powershell
npm run scene -- parity scene273 --recapture-reference
```

BoomBox has separate CPU and GPU aliases:

```powershell
npm run parity:boombox
npm run parity:boombox:gpu
npm run parity:diagnostics
```

Outputs under `artifacts\parity` include the actual image, diff map, hotspots,
JSON report, and optional draw/cluster/diagnostic buffers. Committed goldens
live under `reference\<scene>`.

There is no hosted CI. Run the smallest relevant local gates and the affected
native builds before committing.

## Portable BoomBox package

```powershell
npm run package:boombox
```

The archive is written to
`artifacts\releases\bblitec-boombox-windows-x64.zip`.

## Windows troubleshooting

- `LNK1168`: stop the specific running executable that locks the output.
- `ucrtd.lib` missing: ensure `LIB` contains the MSVC x64, Windows UCRT x64,
  and Windows UM x64 library directories.
- generator mismatch: delete the affected `native\build-*` directory and
  configure it again.
- stale shader/runtime pair: regenerate shaders, then rebuild the same scene.

## Common mistakes

- editing `generated\`
- adding Babylon semantics to PAL
- using explicit TypeScript `any`
- sampling normal/ORM textures as sRGB
- ignoring alpha mode, cutoff, culling, or draw order
- building while generation is still running
- treating the swapchain as readable
