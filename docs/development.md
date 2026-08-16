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
npm run scene -- diff scene1
```

`process` runs compile, scene-local shader compilation, CMake configure, and
parallel native build in order.
`diff` captures both renderers and reports where they disagree; see
[debugging](debugging.md) for the ladder it sits in.
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
6. Run the scene in the demo window and move the camera before calling the
   integration done. A gate renders the one pose its author chose, so a
   defect that is off-screen or edge-on there passes a green matrix: orbiting
   found a skybox large enough for the camera's far plane to clip it, and a
   background skybox that breaks into a hard-edged quad once the camera leaves
   the cube. This stays a manual step deliberately — a second capture
   per scene would double the matrix to cover something only a few scenes
   reach. When it finds something, turn it into a measurement rather than a
   screenshot: copy the scene into `examples\`, move its camera there, and
   `parity --recapture-reference` so both sides are compared at that pose.
   Then bisect with the runtime switches before trusting the description the
   defect came with — `BBLITE_GROUND=0` and `BBLITE_BACKGROUND=0` each remove
   one background element, and the one whose removal makes the measurement
   *worse* is not the cause. Both defects above were first attributed to the
   wrong element by eye.

Do not wait for a high MAD investigation to perform this review. Early history
inspection prevents repeating Babylon Lite's own parity debugging and helps
separate a known WebGPU/raster floor from a missing compiler or PAL contract.
Post-pin commits are relevant only to an explicit upstream-version evaluation.

### What a registered scene owns

A curated scene is described by several files that are checked against each
other, so a missing one fails the corpus tests rather than degrading quietly.

| File | What it carries |
| --- | --- |
| `src/scene-registry.ts` | the entry: id, source, title, thresholds, background, native environment |
| `upstream/babylon-lite-scenes.json` | the SHA-256 of the corpus source, proving it matches the pin |
| `reference/<id>/babylon-lite-golden.png` | the browser golden |
| `reference/exact-corpus-manifest.json` | `sourceSha256`, `referenceSha256`, and `moduleSha256` over the browser module the capture harness builds |
| `test/scene-registry.test.ts` | the registry id list in file order, and the curated count the README publishes |
| `docs/images/scenes/scene<N>.png` | a 320x180 preview: a 4x4 box-filtered average of the golden |
| `docs/status.md` | the published row, checked against measurement by `status:verify` |

The README states the curated count twice, and a curated scene is a `sceneNNN`
entry only — primitives and the project-owned regression gates are counted
separately in the same sentence.

Thresholds are set by measurement, not by intent: register with loose values,
measure both backends, then tighten to just above what was measured. Scenes
where Dawn is structurally closer to the golden carry their own
`dawnThresholds`. `backgroundColor` is the scene's clear color rounded to
bytes per channel.

Animated scenes pin a frame rather than a wall-clock moment.
`referenceTimeSeconds` makes the browser harness seek and pause, and
`nativeEnvironment.BBLITE_ANIMATION_SEEK_SECONDS` pairs the native run to the
same time. A golden is only valid for the registry parameters it was captured
under: a reference captured without them carries no seek, so the scene
free-ran, and diffing a seeked native run against it produces a large and
meaningless result. When native and `scene -- capture <id> --seek <t>` agree
but the golden does not, the golden is stale.

### Sizing a capability before implementing it

A blocker names a capability; it does not size one. Compile-probe the scene
first, because the first blocker a scene reports is the first line of its
chain rather than its length. Then answer two questions before choosing a
shape, and let the answers decide it rather than deciding first and checking
after.

1. **Sweep the whole corpus for every usage.** Grep the scene sources, and
   read the *assets* as well whenever the capability is asset-borne — a glTF
   primitive mode or accessor layout appears in no scene source and is still
   reached by a packaged `.glb`. What the sweep is really measuring is
   whether the capability can arrive by more than one route, because that
   decides where an answer is allowed to live: a glTF primitive mode is
   settled entirely by the asset, while a topology that `createLineSystem`
   assigns to geometry built from plain arrays can never be settled at
   packaging time. One scene through one route is a slice; several scenes
   through several routes is an axis, and the two deserve different shapes.
2. **Ask whether Babylon Lite implements it on the core path or behind an
   opt-in boundary.** Upstream splits deliberately and says so in comments:
   `gltf-feature-*.ts` modules are dynamically imported behind a document
   predicate, the Draco decoder is fetched at run time, and
   `pbr-primitive-topology.ts` is a module of its own so that ordinary PBR
   scenes never carry the topology names. A capability upstream keeps off its
   core path must not become unconditional here. The generated loader, plan,
   and shaders are where this project expresses the same boundary, and
   `asset-specializer.ts` already records upstream's own predicates per
   asset, so the gate usually exists before the feature does.

Then arbitrate, and record the arbitration. An exact fold that covers every
reached usage beats a general mechanism, but only while the sweep says the
general form is unreached — so write down in `TODO.md` which usages the fold
does not cover and what would force the general shape. A capability that
compiles away entirely still owes a `docs/fidelity.md` contract explaining why
the folded form and the pinned form agree.

## Updating Babylon Lite

The repository supports one pinned upstream version. Source-located semantic
contract failures are the compatibility report; the project intentionally does
not maintain simultaneous support for multiple Babylon Lite versions, so a bump
is always "move the pin, then fix what the assertions catch".

### 1. Read the upstream delta first

Clone the upstream repository (see `upstream\babylon-lite.json` for the current
pin) and diff the pinned commit against the target release tag before changing
anything:

```powershell
git log --oneline <pinned-sha>..<tag>
git diff --name-status <pinned-sha>..<tag> -- lab/lite/src/lite lab/lite/src/demos
```

A commit subject marked `!` is a breaking API change and predicts most of the
work. The scene diff tells you which registered corpus scenes must be
re-synced: cross-check the changed file list against `src\scene-registry.ts`.

### 2. Move the pin

Update `upstream\babylon-lite.json` (both `version` and `sourceVersion`), the
`package.json` dependency, and the lock file together, then `npm install`.
The README's pinned-upstream line is the only prose copy of the pair, so it
moves with them; no other page restates them.
Copy every changed `lab/lite` file into `corpus\babylon-lite\` — the corpus is
read-only evidence of the pinned tree — and refresh the `sha256` values in
`upstream\babylon-lite-scenes.json`.

### 3. Fix the compatibility report

`npm run test:upstream` reports the failures. They sort into three kinds:

- **Moved contracts.** A lowerer asserts an expression the upstream refactor
  relocated. Check whether the *semantics* moved or only the shape: if the
  formula is unchanged, retarget the assertion at the new path. Do not weaken
  an assertion to make it pass.
- **New or relocated API.** Options that became functions need intrinsics.
  Mirror the pinned setter exactly, and check what the *old* form reached:
  an option that gated a feature must have its setter reach the same feature
  (see the skybox note below).
- **Provenance and pin churn.** Assertions embedding the version or commit sha
  should derive them from `readUpstreamPin()` rather than hardcoding, so the
  next bump does not touch them at all.

### 4. Prove the bump is behavior-neutral

An API refactor should not move a single pixel. Keep the previous goldens,
recapture the affected scenes' browser references, and compare byte for byte:

```powershell
node dist\src\scene-command.js parity scene<N> --recapture-reference
```

A golden that changes means upstream changed behavior, not just shape — treat
that as a finding to investigate and record, not as a golden to accept. A
golden that stays identical while native parity moves means the bump broke
something on the native side.

Then run the full validation sequence. Regenerate everything: a feature that
silently stops being reached only shows up as a parity regression.

### Recorded findings

- **1.18.0 → 1.20.0.** `feat(pbr)!` moved the optional PBR material features
  from `createPbrMaterial` options to opt-in setters (`unlit: true` →
  `setPbrUnlit(material)`, `skyboxMode: true` → `setPbrSkybox(material)`), and
  scenes read the material back off the mesh to call them. The four affected
  corpus scenes rendered byte-identically in the browser, confirming the
  refactor was shape-only. The one native regression was second-order: the
  `skyboxMode` option had also been what reached the `renderer:transmission`
  feature that emits the skybox uniform, so `setPbrSkybox` has to reach it too.
  Scene 178 caught it because it is the only skybox scene with no actual
  transmission — 176 and 212 reached the feature through their own transmissive
  materials and hid the gap.

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

Every `npm run scene -- ...` invocation first re-runs a clean `npm run build`,
so editing TypeScript while one is running risks a mixed `dist`. For a chain of
several operations, build once and call `node dist/src/scene-command.js <op>
<scene>` directly, which leaves `dist` frozen while sources change. Text and
WGSL templates are the exception: generation reads them from `src/` rather than
from `dist`, so a template edit reaches a generation that is already running.

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
after regenerating or recompiling its shaders. The snapshot is a stamped
custom command the executable depends on, so shader-only changes redeploy
beside the executable on single- and multi-config generators while unchanged
builds remain no-op.

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

Scenes build several at a time, but their CMake *configure* steps are
serialized, because that is where vcpkg runs and concurrent vcpkg use is
unreliable — it shares a download and binary cache between otherwise
independent build directories. Compiling and linking touch nothing shared. A
warm tree skips configure entirely, so the lock is normally uncontended.

How many scenes run at once is configurable per stage; see
[Build switches](#build-switches).

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

## Build switches

The CMake cache variables that shape a native build (see
[Minimal-size builds](#minimal-size-builds) for the size-optimized
combination):

| Variable | Default | Purpose |
| --- | --- | --- |
| `BBLITE_GENERATED_DIR` | required | directory produced by bblitec (`main.cpp`, `features.cmake`) |
| `BBLITE_BACKEND` | `SDL_GPU` | compiled GPU backend set: `SDL_GPU`, `DAWN`, or `BOTH`; `scene -- build` defaults to `BOTH` once the Dawn library is installed and honors the `BBLITE_BACKEND` environment variable |
| `BBLITE_DAWN_DIR` | `artifacts/tools/dawn` | installed Dawn package root; point at `artifacts/tools/dawn-min` for the minimal static FXC-only library |
| `BBLITE_SDL_DIR` | empty | subsystem-trimmed static SDL3 root (`tools/build-sdl-min.ps1`); empty selects the toolchain (vcpkg) SDL3 |
| `BBLITE_MINSIZE` | `OFF` | whole-program optimization and dead-stripping (`/GL /Gw`, `/LTCG /OPT:REF /OPT:ICF`) plus a `/MAP` linker map for `tools/map-size-report.mjs` |
| `BBLITE_CPU_FALLBACK` | `ON` | compile the SDL_Renderer CPU fallback; the scene 1 `--cpu` gate requires the default, minimal shapes turn it off |
| `VCPKG_TARGET_TRIPLET` | `x64-windows` | `x64-windows-static` folds SDL/image/codec dependencies into the executable |
| `CMAKE_MSVC_RUNTIME_LIBRARY` | toolchain | pass `MultiThreaded$<$<CONFIG:Debug>:Debug>` with the static triplet; vcpkg does not flip the project's own CRT |

Generation additionally writes `BBLITE_IMAGE_CODECS` into
`features.cmake` (the image codecs the scene's materialized assets
reach). The build maps it onto vcpkg manifest features before
`project()`, so JPEG support is compiled and deployed only for scenes
that actually carry JPEG content; generated directories predating the
list keep the historical png+jpeg set.

### Concurrency

Environment variables read by `scene -- <stage> all`, not CMake cache
variables. Each stage runs several scenes at once; these decide how many. A
single-scene invocation ignores them and takes the whole machine.

| Variable | Default | Bound by |
| --- | --- | --- |
| `BBLITE_PARALLEL_COMPILES` | hardware threads | threads alone — a generating Node process is small |
| `BBLITE_PARALLEL_SCENES` | `min(threads, RAM / 2GB) / jobs` | threads and memory, at roughly 2 GB per MSVC process for the heaviest translation unit |
| `BBLITE_SCENE_BUILD_JOBS` | `1` | measured: see below |
| `BBLITE_PARALLEL_PARITY` | `8` | GPU throughput; a flat number because GPU memory measured too small to bind |

Thread counts come from `availableParallelism()`, which respects CPU affinity
and container limits, rather than the host's processor count.

One job per scene is not an arbitrary choice. Rebuilding all 58 scenes after a
`pal_dawn.cpp` edit, on a 24-core/32-thread host: 246.7s sequential, then
`32x1` 25.9s, `24x1` 28.4s, `16x2` 30.6s, `12x2` 33.6s, `8x3` 42.3s. Splitting
the same budget the other way costs 15-33%, because an incremental rebuild
leaves most scenes with one or two dirty translation units — a second job per
scene has nothing to do while a second scene always does.

Measurement is the one stage whose default is a flat number rather than a
function of the machine, and the reason is that the resource it looks like it
should bind on does not. Each scene creates a GPU device, a swapchain and its
own textures; sampling dedicated GPU memory across a whole sweep puts that at
0.28 GB per concurrent scene — 2.25 GB attributable at eight at a time, 2.09 GB
at sixteen, since scenes finish sooner and fewer overlap. That fits a 4 GB card
beside a desktop, so scaling the default to the adapter would add a platform
probe to guard a limit nothing reaches.

GPU throughput binds instead. All 57 scenes: 195.5s at one, 100.0s at two,
52.8s at four, 33.6s at eight, 26.0s at sixteen — doubling past eight buys 23%.
Eight sits at the knee without assuming a workstation GPU. Every level produced
byte-identical differential reports, so raising it on a known machine is safe.

## Minimal-size builds

The minimal release shape statically links everything into one
executable per backend. Measured on Scene 1: 2.2 MB SDL_GPU and
7.7 MB Dawn, versus 5.9 MB across 17 files and 37.8 MB across 21
files for the dynamic packages, at identical parity.

Build the trimmed dependencies once:

```powershell
pwsh -File tools\build-sdl-min.ps1
pwsh -File tools\build-dawn-min.ps1
```

`build-sdl-min.ps1` compiles the vcpkg-pinned SDL3 version with only
video, events, and SDL_GPU (no audio, joystick, haptic, HIDAPI,
sensor, camera, power, dialog, GL/Vulkan, or SDL_Renderer).
`build-dawn-min.ps1` builds the monolithic static, D3D12-only,
FXC-only Dawn: the package ships no compiler DLLs and resolves
`d3dcompiler_47.dll` from the executable directory or System32, with
the documented FXC-versus-DXC LSB tradeoff
(see [backends](backends.md#empirical-findings)).

Configure with the static triplet:

```powershell
cmake -S native -B native\build-scene1-min-sdl `
  -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT\scripts\buildsystems\vcpkg.cmake" `
  -DVCPKG_TARGET_TRIPLET=x64-windows-static `
  '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>' `
  -DBBLITE_GENERATED_DIR="$PWD\generated\scene1" `
  -DBBLITE_BACKEND=SDL_GPU `
  -DBBLITE_MINSIZE=ON `
  -DBBLITE_SDL_DIR="$PWD\artifacts\tools\sdl-min" `
  -DBBLITE_CPU_FALLBACK=OFF
cmake --build native\build-scene1-min-sdl --config Release --parallel
```

The Dawn shape adds `-DBBLITE_BACKEND=DAWN` and
`-DBBLITE_DAWN_DIR="$PWD\artifacts\tools\dawn-min"`. Package with
`tools/package-demo.ps1 -BuildDirectory <dir> -Variant min`; static
layouts are detected automatically and ship no runtime or CRT DLLs.
Attribute the executable's bytes after any change:

```powershell
node tools\map-size-report.mjs native\build-scene1-min-sdl\Release\bblite_native.map
```

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU=0` | force SDL_Renderer fallback |
| `BBLITE_GPU_BACKEND=dawn` | select the Dawn (WebGPU) render backend |
| `BBLITE_GPU_REQUIRED=1` | fail instead of falling back |
| `BBLITE_GPU_DEBUG=1` | enable the backend GPU validation layer |
| `BBLITE_MSAA=1` | force single-sample rendering for diagnostics, on both backends: it answers whether a difference is multisampling by removing it |
| `BBLITE_BACKGROUND=0` | disable a requested DDS/HDR skybox |
| `BBLITE_GROUND=0` | disable a requested transparent environment ground |
| `BBLITE_MAX_FRAMES=<n>` | automated frame limit |
| `BBLITE_SCREENSHOT=<path>` | capture PNG |
| `BBLITE_SCREENSHOT_FRAME=<n>` | delay callback-driven capture |
| `BBLITE_BENCHMARK_FRAMES=<n>` | benchmark after warmup |
| `BBLITE_ASSET_DIR=<path>` | override asset directory |
| `BBLITE_GPU_SHADER_DIR=<path>` | override shader directory |
| `BBLITE_DEFORMATION_DUMP=<path>` | append first-frame bone palettes and morph weights as hexfloats (SDL_GPU deformation scenes) |
| `BBLITE_RENDER_CAPTURE=<path>` | write the captured frame's full CPU-side description as JSON (both GPU backends) |
| `BBLITE_BUILD_STAMP_OUT=<path>` | write the digest of the sources this executable was built from |

Controls: left-drag orbit, right/middle-drag pan, wheel zoom; arrows and
`W`/`S` are keyboard fallbacks.

## Parity

Corpus reference capture serves a minimal local page containing only the
render canvas; it does not include Babylon Lite's showcase loading overlay.
Relative local imports resolve from the entry source's repository path;
requested `.js` modules transpile on demand from their sibling `.ts`
sources. When the generated manifest records the
`deterministic-seeded-random` adaptation, the page installs the pinned
mulberry32 (seed 1) `Math.random` before the scene module loads, matching
`bbl::js::random_js` in the native runtime.
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
```

`--cpu` is a gate only when the scene registry defines `cpuThresholds`.
Requesting CPU parity for any other scene fails explicitly instead of
reporting an unthresholded pass. Ad-hoc GPU scenes without configured
thresholds remain available, but reports and console output label them
`diagnostic-only`.

Outputs under `artifacts\parity` include the actual image, diff map, hotspots,
JSON report, and optional draw/cluster/diagnostic buffers. Committed goldens
live under `reference\<scene>`.

Both GPU backends serve the attribution captures. `BBLITE_GPU_BACKEND=dawn`
before any of the scene 1 commands renders the draw-id, triangle-cluster, and
PBR diagnostic buffers through Dawn instead of SDL_GPU; the `-gpu` filenames
always reflect whichever backend produced the run. The two backends produce
byte-identical id/cluster buffers and one-LSB-equal PBR buffers, so either
side can attribute a diff.

Render both GPU backends and diff them against each other and the
golden in one report:

```powershell
npm run scene -- parity scene33 --differential
```

Each backend still runs through its standard gates (scenes where Dawn
is structurally closer to the golden carry tighter `dawnThresholds`
in the registry), and `report-differential.json` adds the direct
SDL_GPU-versus-Dawn comparison — backend agreement to one LSB puts a
divergence on the CPU side, disagreement puts it on the GPU side.
`--differential` also composes with `parity all`. It runs each backend in its
own process, because the backend selection is process-global, and those
processes receive only the differential flag — so it does not carry
`--recapture-reference`. Capture a new golden with a plain
`parity <id> --recapture-reference` first, then run the differential.

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
  texels (the 1x1 factor textures), raw bytes for 32-bit-float texel
  rows up to 32 KB (the per-skin bone-matrix textures), and a 4x4
  sample of image uploads
- `draws.json` — draw-call census across pass **and render-bundle**
  encoders (Babylon Lite records mesh draws into bundles; hooking the
  pass encoder alone sees none of them)
- `screenshot.png` — checked byte-for-byte against the committed
  golden when no draw filter is active, proving the hooks are
  non-perturbing

The buffers are recorded as base64, and nothing in the file says what they
mean. Decode them against the layouts the capture already contains:

```powershell
npm run scene -- uniforms scene253 --size 96
```

`uniforms` reads a capture directory, parses the struct declarations out of the
browser's own composed shader modules beside it, and prints every uniform
buffer whose size matches one of them as named fields. That turns "is our
material record right?" into a direct comparison against the values the
browser actually uploaded, rather than an argument about shader text.

A composed fragment declares one struct per material feature set, so several
unrelated layouts can share a size — the base-colour UV transform pair and the
dielectric reflectance slice both occupy 32 bytes. Every candidate is decoded
and labelled with the module it came from rather than one being picked, since
reading plausible values out of the wrong layout is worse than reporting the
ambiguity. `--module <substring>` narrows it once the right fragment is known,
and `--capture <dir>` reads a capture written somewhere other than
`artifacts\capture\<scene>`.

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

## Native render capture

The native half of the same question:

```powershell
npm run scene -- capture scene33 --native
npm run scene -- capture scene33 --native --backend dawn
```

`BBLITE_RENDER_CAPTURE=<path>` makes either backend write the frame it
screenshots as JSON: the scene, camera, environment, light, mesh and
material records, the draw list in submission order with its pipeline and
bucket, and every uniform block it builds. The blocks are rebuilt through
the same generated `build_*_uniforms` functions the frame loop calls with
the same `(scene, engine, camera, item)`, which is why both backends
write byte-identical captures for a scene — and why this describes what
our CPU computed rather than intercepting the graphics API. A backend
that uploaded correct bytes to the wrong slot still looks correct here;
that is what `parity --differential` is for.

The run is subject to the same build-identity checks as a measured parity
run, so a capture cannot silently describe a stale executable.

```powershell
npm run scene -- diff scene33
npm run scene -- diff scene33 --backend dawn --recapture
```

`diff` takes both captures — capturing whichever is missing — and reports
where they part: draw shapes, then uniform values field by field, then
the texture sample expressions in each side's shaders. Native fields are
named through the struct declarations in the scene's own generated
`renderer_plan.hpp`; browser buffers through the structs in the browser's
own composed shaders. See [debugging](debugging.md) for how to read the
report, including why a byte-exact scene still lists entries.

## Build identity

A measurement is only worth its number if the executable was built from the
inputs currently on disk. Three things decide what a run renders, and each is
checked separately because each goes stale differently:

- **Compiled inputs.** Generation digests the generated C++ and the tracked
  native sources into `generated\<scene>\build-inputs.json` and embeds the
  digest through `build_stamp.hpp`. The executable writes it to
  `BBLITE_BUILD_STAMP_OUT` when asked, and `scene -- parity` refuses a binary
  whose stamp no longer matches the tree.
- **Deployed payload.** The shader and asset directories beside the executable
  are compared file by file against the generated tree before a run starts, so
  a shader step that failed without stopping the build cannot be measured.
- **Build configuration.** The CMake cache values are read from the build
  directory rather than embedded, so one generated tree serves the release
  build and a minimal-size build without either looking stale.

The stamp deliberately covers the whole tracked native source set rather than
the subset a configuration compiles: `BBLITE_CPU_FALLBACK=OFF` drops a
translation unit, and the same sources must digest identically either way.

Generation rewrites a file only when its bytes change and prunes what a run no
longer emits, so an unchanged scene rebuilds nothing. `scene -- process`
reconfigures only when the CMake cache differs from the values it would pass;
`--cold` forces the configure regardless.

## Proving a change moved nothing

Most changes are supposed to leave every measured scene where it was, and the
proof should match what the change can possibly affect. The full matrix is not
always the right tool, and for compiler-only work it is strictly weaker than
the cheap one.

**A change confined to TypeScript is proved by the generated tree.** Compile
every registered scene, then digest every file under `generated/`. Byte-
identical generated output plus an untouched `native/` tree means the build
stamps are identical, which means the executables are the same binaries, which
means the measurements cannot have moved. That is an exact proof rather than a
measurement, and it costs a compile pass instead of a build-and-render pass.

Two things break it. A corpus sweep compiles unregistered scenes into new
`generated/sceneNNN` directories and so invalidates the file list — sweep
first, delete the stray directories, then digest. And nothing else may use
`dist/` while `npm run build` runs, because the build removes the directory
first.

**A change that reaches native sources, the PAL, or shader emission has to be
measured**, because generated bytes changing tells you nothing about the
image. Snapshot every `artifacts/parity/*/report-differential.json` before the
run and compare the same files afterwards, cell by cell: reading MAD columns
by eye misses a moved backend delta. `status:verify` performs the published
half of that comparison automatically.

Two scenes need a second run before a moved cell means anything. Scenes 9 and
37 do not render bit-identically on Dawn from one run to the next, by a few
dozen pixels of 921600, so their Dawn columns move for any change and for no
change alike. Re-run those two and compare again; a real regression stays put,
this does not.

There is no hosted CI. During iteration, run only the smallest relevant tests,
generation steps, affected native builds, and scene parity gates. Do not repeat
the complete corpus matrix after every local change.

Before pushing compiler, renderer, shader-interface, loader, animation, or PAL
changes, run the canonical full validation sequence once:

```powershell
npm test
npm run scenes:process
npm run scenes:parity
npm run status:verify
```

`scenes:process` *is* compile, shaders and build. The sequence used to name
the first two separately as well, which ran them twice: with write-if-different
generation the second pass wrote nothing, so it was two and a half minutes
spent re-deriving bytes that were already on disk.

`scenes:parity` runs both backends (`parity all --differential`) because
[status](status.md) publishes an SDL_GPU and a Dawn number for every scene; a
single-backend sweep leaves the second column unverified between manual runs.
On a machine without the pinned Dawn library, run `npm run scene -- parity all`
instead and treat the Dawn column as unmeasured.

`status:verify` compares every published pair, and its severity colour, against
the reports the parity run wrote. The table is checked data, not prose: two rows
had drifted from measurement before this check existed.

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

The payload follows the `BBLITE_BACKEND` the build directory was configured
with (read from its CMake cache): `SDL_GPU` ships offline DXIL/SPIR-V
shaders and no Dawn DLLs, `DAWN` ships WGSL text plus
`webgpu_dawn.dll`/`dxcompiler.dll`/`dxil.dll` and the Dawn license
(no FXC — see [backends](backends.md#building-and-running)), and
`BOTH` ships the dual-backend binary with both shader sets plus a
`run-<scene>-dawn.cmd` launcher. `jpeg62.dll` and the libjpeg-turbo
notice ship only when the scene's `BBLITE_IMAGE_CODECS` reaches JPEG,
and the `run-<scene>-cpu.cmd` launcher only when the build compiled
the CPU fallback (`BBLITE_CPU_FALLBACK`). Statically linked builds
(vcpkg `x64-windows-static` with `BBLITE_MINSIZE`, Dawn from
`tools/build-dawn-min.ps1`) are detected by the absence of runtime
DLLs beside the executable and ship the executable alone; `-Variant`
appends a token to the package name. Text shader intermediates (HLSL,
MSL, reflection dumps) never ship. The archive is written to
`artifacts\releases\bblitec-<scene>-<backend>-windows-x64.zip`, and
the README embeds the scene's current parity numbers when
`artifacts\parity\<scene>` reports exist.

## Windows troubleshooting

- Shader-step failures do not say `error C`: when filtering `process`
  output, also match `Tint HLSL generation failed` and `exited with
  status`, or a scene keeps its stale shaders and executable and parity
  silently validates the previous build. When a validation result looks
  surprisingly unchanged after a shader edit, rerun `process` with full
  output before trusting it.
- `scene -- build` never regenerates: hand-instrumented files under
  `generated\` survive a build (useful for disposable printf debugging)
  but are wiped by the next `compile`/`process`.
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
