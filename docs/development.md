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
npm run scene -- list
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
parallel native build in order.

Aggregate registered-scene workflows are available without duplicating the
registry in `package.json`:

```powershell
npm run scenes:compile
npm run scenes:build
npm run scenes:process
npm run scenes:parity
```

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

Set `BBLITE_CMAKE_GENERATOR` before configuring fresh build directories to
select a generator. On the development Windows machine, a Release BoomBox
benchmark with the same MSVC toolchain measured:

| Workload | Visual Studio 18 | Ninja |
| --- | ---: | ---: |
| clean build | 17.77 s | 4.33 s |
| no-op build | 1.16 s | 0.08 s |
| one-file rebuild | 2.53 s | 2.21 s |

The resulting 1280x720 BoomBox captures were byte-identical (`MAD 0.000`);
both measured `0.311392` MAD against the same Babylon Lite golden.

Ninja is the preferred iteration generator when it is available from an
initialized compiler environment:

```powershell
$env:BBLITE_CMAKE_GENERATOR = "Ninja"
npm run scene -- process boombox
```

Native outputs are self-contained by default: CMake places `assets` and
`shaders` beside the executable, and runtime lookup is relative to that
executable. `BBLITE_ASSET_DIR` and `BBLITE_GPU_SHADER_DIR` remain explicit
overrides for diagnostics and unusual layouts.

Shader compilation uses `artifacts\shader-cache`, keyed by source, profile,
compiler binary, and flags. Identical variants are reused across scenes; the
cache is disposable.

Build the pinned Tint CLI with:

```powershell
pwsh -File tools\build-tint.ps1
```

Reached WGSL shaders require `artifacts\tools\tint\tint.exe` (or `TINT_PATH`).
Tint validates WGSL and emits HLSL/MSL. DXC must compile HLSL to DXIL for
D3D12; it also temporarily emits SPIR-V until Tint resource bindings are
remapped to SDL_GPU's dense texture/sampler convention. Each shader directory
records the selected backend in `shader-compiler.json`.

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU=0` | force SDL_Renderer fallback |
| `BBLITE_GPU_REQUIRED=1` | fail instead of falling back |
| `BBLITE_GPU_DEBUG=1` | enable the backend GPU validation layer |
| `BBLITE_MSAA=1` | force single-sample rendering for diagnostics |
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

Corpus reference capture serves a minimal local page containing only the
render canvas; it does not include Babylon Lite's showcase loading overlay.
The gate waits for `canvas.dataset.ready`, which is set only after awaited
asset loads, scene registration, and `startEngine`, then captures the canvas
alone. A slow or failed load therefore times out instead of recording the
progress bar.

Run a curated scene:

```powershell
npm run scene -- parity scene273
```

Refresh a source-based reference only intentionally:

```powershell
npm run scene -- parity scene273 --recapture-reference
```

BoomBox CPU and GPU runs use the same generic command:

```powershell
npm run scene -- parity boombox --cpu
npm run scene -- parity boombox
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
