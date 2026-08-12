# Development guide

## Requirements

- Node.js 22+
- CMake 3.24+
- Ninja
- a C++20 compiler
- vcpkg
- PowerShell and DXC for shader compilation
- Chrome or Edge with WebGPU for exact HDR GGX asset prefiltering and browser references

The documented Windows toolchain is MSVC 14.51 with Windows SDK
10.0.26100.0. Linux and macOS use the same generated sources with their native
CMake generator and SDL_GPU backend.

## Core workflow

```powershell
npm ci
npm test
npm run scene -- list
```

Use the generic scene command rather than adding scripts for ordinary work:

```powershell
npm run scene -- show scene1
npm run scene -- compile scene1
npm run scene -- build scene1
npm run scene -- process scene1
npm run scene -- parity scene1
npm run scene -- geometry scene145 --recapture-reference
```

`process` runs compile, scene-local shader compilation, CMake configure, and
parallel native build in order.
`geometry` captures each existing geometry-output copy task full-screen in
Babylon Lite and native without changing the curated scene source.

HDR scene compilation launches headless Chromium to run the pinned
1024-sample GGX compute shader. Set `CHROME_PATH` when Chrome/Edge is not in a
standard location.

Aggregate registered-scene workflows are registry-driven through
`scenes:compile`, `scenes:build`, `scenes:process`, and `scenes:parity`.

Registered Babylon Lite inputs live under `corpus\babylon-lite` and must match
`upstream\babylon-lite-scenes.json` byte-for-byte. They are read-only evidence;
compiler gaps are fixed in the compiler rather than by adapting a scene.

## Integrating a curated parity scene

Numbered scenes are Babylon Lite-versus-Babylon Legacy differential tests, not
just feature samples. Investigate their Babylon Lite history as soon as a
scene is considered for integration, before implementing native fixes:

1. Trace both `lab/lite/src/lite/scene<N>.ts` and
   `lab/lite/src/bjs/scene<N>.ts` through renames with `git log --follow`.
2. Read the original parity pull request, inline reviews, and discussion.
   Record the measured MAD, accepted backend floor, known residual regions,
   rejected approaches, and any reference-page corrections.
3. Trace the reached loader, material, shader, animation, and frame-graph
   modules from that introduction through the pinned source commit. Later
   pre-pin fixes often document the exact Babylon Legacy semantic mismatch.
4. Verify every historical claim against the pinned source. History explains
   intent and failed approaches; it does not override the current source
   contract.
5. Carry useful evidence into the scene dashboard note, focused tests, or
   `TODO.md` before setting a curated threshold.

Do not wait for a high MAD investigation to perform this review. Early history
inspection prevents repeating Babylon Lite's own parity debugging and helps
separate a known WebGPU/raster floor from a missing compiler or PAL contract.
Post-pin commits are relevant only to an explicit upstream-version evaluation.

## Updating Babylon Lite

The repository supports one pinned upstream version. To evaluate an update:

1. Update `upstream\babylon-lite.json`, the package dependency, and lock file
   together.
2. Run `npm ci`, then `npm run test:upstream` to expose moved symbols and
   changed AST contracts across all lowerers.
3. Review changed formulas, defaults, module paths, curated source URLs, and
   generated provenance; do not add version branches to preserve the old pin.
4. Regenerate all scenes and complete the relevant compiler, native, shader,
   and parity matrix before accepting the new pin.

Source-located semantic contract failures are the compatibility report. The
project intentionally does not maintain simultaneous support for multiple
Babylon Lite versions.

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

For project-owned local glTF fixtures used by both the browser oracle and the
compiler, keep binary payloads embedded and reference the `.gltf` from an
`examples` scene with a repository-root-safe path such as
`../examples/assets/<fixture>.gltf`.

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
after regenerating or recompiling its shaders. The snapshot updates a generated
link source owned by the executable, so shader-only changes redeploy beside the
executable on single- and multi-config generators while unchanged builds
remain no-op.

## Native builds

`scene -- build` configures the registry-derived build directory and invokes
`cmake --build`. Set:

```powershell
$env:VCPKG_ROOT = "C:\path\to\vcpkg"
$env:CMAKE_COMMAND = "C:\path\to\cmake.exe" # only when cmake is not on PATH
```

Manual equivalent:

```powershell
cmake -S native -B native\build-scene1-release `
  -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT\scripts\buildsystems\vcpkg.cmake" `
  -DBBLITE_GENERATED_DIR="$PWD\generated\scene1"
cmake --build native\build-scene1-release --config Release
```

Ninja is the default on every platform. On Windows, the scene command locates
Visual Studio, the latest MSVC toolset, the Windows SDK, and Visual Studio's
bundled Ninja without requiring a Developer Command Prompt. Set
`BBLITE_CMAKE_GENERATOR` to override the default. Never reuse one build
directory with a different generator; all build trees are ignored and safe to
delete.

Build scenes sequentially: concurrent vcpkg use is unreliable.

Set `VCPKG_ROOT` before configuring a new build directory. If a directory was
first configured without the toolchain, delete that specific
`native\build-<scene>-release` directory and configure it again; adding the
toolchain to an existing cache is not reliable.

The default follows this Release Scene 1 benchmark on the development Windows
machine using the same MSVC toolchain:

| Workload | Visual Studio 18 | Ninja |
| --- | ---: | ---: |
| clean build | 17.77 s | 4.33 s |
| no-op build | 1.16 s | 0.08 s |
| one-file rebuild | 2.53 s | 2.21 s |

The resulting 1280x720 Scene 1 captures were byte-identical (`MAD 0.000`);
both measure `0.001` full MAD against the pinned Babylon Lite golden.

Override the generator only when needed:

```powershell
$env:BBLITE_CMAKE_GENERATOR = "Visual Studio 18 2026"
npm run scene -- process scene1
```

Ninja places `bblite_native.exe` directly in the build directory; multi-config
Visual Studio generators place it under `Release`.

Native outputs are self-contained by default: CMake places `assets` and
`shaders` beside the executable, and runtime lookup is relative to that
executable. `BBLITE_ASSET_DIR` and `BBLITE_GPU_SHADER_DIR` remain explicit
overrides for diagnostics and unusual layouts.

Shader compilation uses `artifacts\shader-cache`, keyed by source, profile,
DXC executable/codegen DLLs, and the exact invocation flags. DXIL and SPIR-V
are validated and atomically published, so interrupted or malformed entries
are rebuilt instead of reused. Identical variants are reused across scenes;
the cache is disposable.

Build the pinned Tint CLI with:

```powershell
pwsh -File tools\build-tint.ps1
```

Build the pinned Dawn library (same source pin, shared checkout) with
`pwsh -File tools\build-dawn.ps1`. The CMake `BBLITE_BACKEND`
selection (`SDL_GPU`, `DAWN`, or `BOTH`) picks the compiled backend
set: scene builds default to `BOTH` once `artifacts\tools\dawn`
exists and `SDL_GPU` otherwise, and the `BBLITE_BACKEND` environment
variable overrides the default. In `BOTH` builds
`BBLITE_GPU_BACKEND=dawn` selects Dawn at runtime — the parity
harness forwards the environment and labels its reports with the
active backend; single-backend builds default to their compiled
backend and fail explicitly when the other one is requested. See
[backends](backends.md).

Reached WGSL shaders require `artifacts\tools\tint\tint.exe` (or `TINT_PATH`).
Tint validates WGSL and emits HLSL/MSL. DXC must compile HLSL to DXIL for
D3D12; it also temporarily emits SPIR-V until Tint resource bindings are
remapped to SDL_GPU's dense texture/sampler convention. Each shader directory
records the selected backend in `shader-compiler.json`.

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU=0` | force SDL_Renderer fallback |
| `BBLITE_GPU_BACKEND=dawn` | select the Dawn (WebGPU) render backend |
| `BBLITE_GPU_REQUIRED=1` | fail instead of falling back |
| `BBLITE_GPU_DEBUG=1` | enable the backend GPU validation layer |
| `BBLITE_MSAA=1` | force single-sample rendering for diagnostics |
| `BBLITE_BACKGROUND=0` | disable a requested DDS/HDR skybox |
| `BBLITE_GROUND=0` | disable a requested transparent environment ground |
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

Registered scenes require their curated reference to exist. Ordinary parity
fails instead of recreating a missing golden; only
`--recapture-reference` authorizes an intentional replacement. Ad-hoc scenes
retain the bootstrap behavior shown above.

Scene 1 CPU and GPU runs use the same generic command:

```powershell
npm run scene -- parity scene1 --cpu
npm run scene -- parity scene1
npm run parity:diagnostics
```

`--cpu` is a gate only when the scene registry defines `cpuThresholds`.
Requesting CPU parity for any other scene fails explicitly instead of
reporting an unthresholded pass. Ad-hoc GPU scenes without configured
thresholds remain available, but reports and console output label them
`diagnostic-only`.

Outputs under `artifacts\parity` include the actual image, diff map, hotspots,
JSON report, and optional draw/cluster/diagnostic buffers. Committed goldens
live under `reference\<scene>`.

## Instrumented browser capture

When a parity residual resists chain reasoning, capture the browser's
actual GPU state instead of theorizing about it:

```powershell
npm run scene -- capture scene247
npm run scene -- capture scene247 --skip-draw 12096
```

The command renders the scene through the pinned package exactly like
the reference capture, with every WebGPU entry point hooked, and
writes to `artifacts\capture\<scene>`:

- `shaders/*.wgsl` — the browser's composed shader modules
- `buffers.json` / `buffers-summary.txt` — every buffer with its
  size, usage, and uploaded bytes (base64; the last eight writes per
  buffer)
- `tex-uploads.json` — texture uploads, including raw bytes for small
  texels (the 1x1 factor textures) and a 4x4 sample of image uploads
- `draws.json` — draw-call census across pass **and render-bundle**
  encoders (Babylon Lite records mesh draws into bundles; hooking the
  pass encoder alone sees none of them)
- `screenshot.png` — checked byte-for-byte against the committed
  golden when no draw filter is active, proving the hooks are
  non-perturbing

`--seek` overrides the registry's `referenceTimeSeconds`, and
`--skip-draw <indexCount>` drops matching draws for per-draw
isolation; pair it with a matching temporary filter in the native
frame loop to localize a residual to a single draw. The recorded
buffer bytes support bit-level comparison against native uploads —
weights, morph deltas, instance matrices, material UBOs, and factor
texels. This workflow resolved the scene 243 occlusion gap and the
scene 247 shading contracts recorded in
[backends](backends.md#empirical-findings) and
[fidelity](fidelity.md).

There is no hosted CI. During iteration, run only the smallest relevant tests,
generation steps, affected native builds, and scene parity gates. Do not repeat
the complete corpus matrix after every local change.

Before pushing compiler, renderer, shader-interface, loader, animation, or PAL
changes, run the canonical full validation sequence once:

```powershell
npm test
npm run scenes:compile
npm run shaders:build
npm run scenes:process
npm run scenes:parity
npm run parity:diagnostics
```

Do not run generation and native builds concurrently. Do not build multiple
CMake trees concurrently against the same vcpkg installation.

Current deterministic animation gates:

| Scene | Seek | Coverage |
| ---: | ---: | --- |
| 5 | 2.0 s | morph targets plus skeleton |
| 151 | 0.5 s | grouped position/scaling/quaternion property tracks |
| 154 | 0.75 s | LINEAR versus STEP property interpolation |
| 240 | 0.5 s | glTF node transform |
| 245 | 1.0 s | recursive skeleton hierarchy |

`referenceTimeSeconds`, `referenceFrameRate`, and optional
`referenceAnimationGroups` in `src/scene-registry.ts` describe browser
capture seeking. Native parity uses `BBLITE_ANIMATION_SEEK_SECONDS`. Capture
metadata must match the pinned scene's own frame rate and explicit groups;
glTF scenes usually seek `scene.animationGroups`.

## Portable demo packages

Package any built numbered scene:

```powershell
npm run package:demo -- -Scene scene243
```

`npm run package:boombox` remains the Scene 1 shorthand. The payload
follows the `BBLITE_BACKEND` the build directory was configured with
(read from its CMake cache): `SDL_GPU` ships offline DXIL/SPIR-V
shaders and no Dawn DLLs, `DAWN` ships WGSL text plus
`webgpu_dawn.dll`/`dxcompiler.dll`/`dxil.dll`/`d3dcompiler_47.dll`
and the Dawn license, and `BOTH` ships the dual-backend binary with
both shader sets plus a `run-<scene>-dawn.cmd` launcher. Text shader
intermediates (HLSL, MSL, reflection dumps) never ship. The archive
is written to
`artifacts\releases\bblitec-<scene>-<backend>-windows-x64.zip`, and
the README embeds the scene's current parity numbers when
`artifacts\parity\<scene>` reports exist.

## Windows troubleshooting

- `LNK1168`: stop the specific running executable that locks the output.
- `ucrtd.lib` missing: ensure `LIB` contains the MSVC x64, Windows UCRT x64,
  and Windows UM x64 library directories.
- generator mismatch: delete the affected `native\build-*` directory and
  configure it again.
- stale shader/runtime pair: regenerate shaders, then rebuild the same scene.
- new build cannot find SDL/nlohmann-json: set `VCPKG_ROOT`, delete only that
  build directory, and reconfigure.
- D3D12 command-list failure during screenshot after runtime mesh append:
  capture must occur after the topology-update frame; PAL now defers it
  automatically.

## Common mistakes

- editing `generated\`
- adding Babylon semantics to PAL
- using explicit TypeScript `any`
- sampling normal/ORM textures as sRGB
- ignoring alpha mode, cutoff, culling, or draw order
- building while generation is still running
- treating the swapchain as readable
- changing thresholds, references, or scene inputs to hide a semantic bug
