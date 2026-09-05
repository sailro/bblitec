# Development guide

## Requirements

Node.js 22.12+, CMake 3.24+, Ninja, a C++20 compiler, vcpkg, PowerShell,
and a GPU. Browser captures and executed asset bakes need Chrome/Edge with
WebGPU. Windows development uses clang-cl when installed, otherwise MSVC;
shipping uses MSVC. Dawn, Tint, DXC, LabSound and RmlUi are pinned local builds.

## Core workflow

```powershell
npm ci
npm run dev:setup
npm run doctor
npm test
npm run sweep
```

`dev:setup` installs the development dependencies and missing tool artifacts.
After a maintained dependency patch changes, explicitly rebuild that library;
an existing install is not evidence that it contains the current patches.

```powershell
pwsh -File tools/build-rmlui.ps1
npm run scene -- process all
```

On Windows, scene commands discover Visual Studio's CMake, Ninja, compiler,
SDK and vcpkg. Explicit environment variables override discovery. If CMake is
not on PATH in this workspace, set the documented fallback before native work:

```powershell
$env:CMAKE_COMMAND = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
```

| Command | Purpose |
| --- | --- |
| `scene -- list` / `show <id>` | Registry and selected scene configuration |
| `scene -- compile <id\|source.ts\|all>` | Generate C++, shaders, assets and manifests |
| `scene -- build <id\|source.ts\|all>` | Configure/build existing generated output |
| `scene -- process <id\|source.ts\|all>` | Compile, compile shaders, configure and build in order |
| `scene -- parity <id\|all> --differential` | Compare both renderers with the golden and each other |
| `scene -- validate <id\|all>` | Process, parity and published status verification |
| `scene -- clean --orphans` | Remove generated/build entries not owned by the registry |

Commands above are arguments to `npm run scene --`. `npm run sweep` is
`scene -- validate all`. `npm test` is separate. For analysis commands, use
[the diagnostic ladder](debugging.md#the-ladder).

Run generation before shader/native builds. Do not rebuild `dist/` while a
scene command is running from it. For a sequence, run `npm run build` once,
then `node dist/src/scene-command.js ...`. Read command exit codes and retain
full logs; a shell pipeline's last command can hide an earlier failure.

## Integrating a curated parity scene

Read the feature's pinned upstream documentation and source before porting.
Use the exact scene and reached module/asset graph as evidence. Fix compiler,
lowerer or PAL support; do not edit corpus inputs or goldens to make a gate pass.

### What a registered scene owns

| File | Contract |
| --- | --- |
| `src/scene-registry.ts` | Source, title, capture pose, thresholds, host UI and attribution |
| `upstream/babylon-lite-corpus.json` | Pinned source/asset origins and SHA-256 digests |
| `reference/<id>/babylon-lite-golden.png` | Browser reference |
| `reference/exact-corpus-manifest.json` | Source, module, reference and query provenance |
| `docs/status.md` | Verified measured row |
| `docs/images/scenes/<id>.png` | Preview made by `tools/create-status-preview.mjs` |
| Registry/corpus tests | Membership, counts and relationships between paired goldens |

Set thresholds from measurements on both backends. `referenceTimeSeconds`
derives the native seek; `referenceFrame` derives the fixed capture frame.
`referenceSearch` must match the query used by both generation and browser
navigation. Set `canvasThresholds` when UI residuals could conceal 3D regressions.
Finish with [both-backend and interaction checks](debugging.md#before-calling-a-scene-done).

### Sizing a capability before implementing it

Compile the unregistered source first. Read all corpus usages and asset-borne
forms, then identify the pin's activation boundary: core code, explicit API
registration or loader-discovered asset predicate. A first compiler error
identifies only the first blocker. Any isolated probe belongs under `examples/`;
keep the original corpus unchanged and remove disposable probes afterwards.

## Adding a lowerer and its curated fixture

Use a focused lowerer and existing `LoweringContext`, pinned-function/numeric
lowerers, AST contracts, shader composition and IR. Derive behavior instead of
transcribing formulas. Reach the capability at the pin's own trigger and extend
the feature/provenance inventory. Add a focused semantic regression before the
curated fixture. Unsupported shapes must fail with source locations; recorded
adaptations belong in generated `fidelity.json`.

## Updating Babylon Lite

Read the upstream release/source delta, then update the pin, package lock,
corpus catalog and reference provenance together. The package's
`babylonLiteRelease.sourceVersion` is the source commit; a release tag can
refer to a different object. `README.md` is the only prose pin copy.

Run `npm run test:upstream`, then generate the whole registry: contract tests
do not reach every scene path. Check renamed options, moved extension
registration, added statements in restated bodies, and package WGSL transforms.
Preserve semantic contracts when retargeting AST assertions.

Use `npm run corpus:manifest -- --previous-version <version> --previous-commit
<sha>` to inspect explainable module digest changes; add `--write` only after
review. `--previous-tree` selects the prior source tree (default `HEAD`).
Run `npm run corpus:verify` after changing corpus files/manifests. It verifies
origins independently; `--offline` identifies uncached records as unverifiable.
Recapture intentionally changed references, investigate moved pixels, then run
the full validation sequence.

## Ad-hoc scenes

```powershell
npm run scene -- process examples/my-scene.ts
npm run scene -- parity examples/my-scene.ts --recapture-reference
```

Repository-local sources derive `generated/<stem>`,
`native/build-<stem>-release`, `reference/<stem>` and `artifacts/parity/<stem>`.
Add registry entries for durable gates or custom configuration. Ad-hoc parity
without thresholds reports measurements as diagnostic-only.

## Generation and assets

Generation records reached repository inputs in `manifest.json`; feature,
shader and adaptation evidence is described in [architecture](architecture.md).
Remote assets use `.cache/assets`; executed bakes use `artifacts/bake-cache`,
keyed by the pin, input bytes, parameters, producer and execution runtime.
`BBLITE_BAKE_CACHE=0` bypasses bake replay; `CHROME_PATH` selects Chromium.
Generated output is disposable. Fix its source, never the generated file.

## Shader compilation

`process --shader d3d12|vulkan|metal|all` selects offline output; the default is
the host target. `BBLITE_SHADER_TARGET` is its environment equivalent. `build`
does not compile shaders. Dawn-only processing consumes generated WGSL and
skips offline compilation unless an explicit shader target requests it.

Tint/DXC caches live under `artifacts/shader-cache`. Keys include source,
entry/profile, target, transformation script and participating compiler binaries.
The outer stage checkpoint must include the same dependencies before skipping
the compiler. Changed or missing products invalidate reuse. Build after shader
changes to deploy the new payload. Set `TINT_PATH` and `DXC_PATH` for overrides.

## Native builds

Ninja is the development default. `--backend sdl_gpu|dawn|both` selects compiled
renderers; Windows defaults to both and requires installed Dawn. Other hosts
default to SDL_GPU. `--compiler auto|clangcl|msvc` and `BBLITE_DEV_COMPILER`
select the Windows compiler. `BBLITE_CMAKE_GENERATOR` overrides Ninja.

Development shares one full vcpkg install at
`artifacts/vcpkg-installed/development-full`; installation is serialized before
parallel scene configures, which use `VCPKG_MANIFEST_INSTALL=OFF`. Shipping
uses exact static dependencies. Do not concurrently reconcile one vcpkg install
from independent workflows. `BBLITE_VCPKG_INSTALLED_ROOT` relocates the cache.

`tools/setup-worktree.ps1 -Path <path> -Branch <branch>` creates a worktree with
shared disposable caches and separate generated/build outputs. `-Commit <sha>`
selects an existing revision. Use `-SharedVcpkg` only for serialized builds.
Remove these worktrees through the script's `-Remove`, which unlinks junctions
before deletion. Never recursively delete through their cache junctions.

Native outputs include reached assets and shaders beside the executable.
Ninja writes the executable in the build root; multi-config generators use
`Release/`. CMake presets in `native/CMakePresets.json` support manual builds.

## Build switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GENERATED_DIR` | Required generated scene directory |
| `BBLITE_BACKEND` | `SDL_GPU`, `DAWN` or `BOTH` |
| `BBLITE_DAWN_DIR`, `BBLITE_SDL_DIR` | Installed renderer/platform library overrides |
| `BBLITE_LABSOUND_DIR`, `BBLITE_RMLUI_DIR` | Optional subsystem artifact overrides |
| `BBLITE_AUDIO_CAPTURE` | Offline WAV capability; default off in minimal builds |
| `BBLITE_PCH` | Per-tree precompiled headers; default on in development |
| `BBLITE_MINSIZE` | Size optimization, LTO, dead stripping and Windows linker map |
| `VCPKG_TARGET_TRIPLET` | Development `x64-windows`; shipping `x64-windows-static` |

### Concurrency

Population stages use `BBLITE_PARALLEL_COMPILES`, `BBLITE_PARALLEL_SCENES`,
`BBLITE_SCENE_BUILD_JOBS` and `BBLITE_PARALLEL_PARITY`. Defaults derive compile
capacity from CPU affinity and native capacity from CPU/RAM; one native job
per scene and eight concurrent parity runs are the defaults. Single-scene
builds can use the whole machine. Measure local workloads before overriding.

## Minimal-size shipping builds

Shipping selects one scene/backend, static CRT/dependencies and
`BBLITE_MINSIZE=ON`. Optional subsystems and codecs derive from generated
features. PNG remains a base dependency for capture and image I/O.

```powershell
pwsh -File tools/build-sdl-min.ps1
pwsh -File tools/build-dawn-min.ps1
pwsh -File tools/build-labsound.ps1 -StaticRuntime
pwsh -File tools/build-rmlui.ps1 -StaticRuntime
```

Build only dependencies the chosen scene needs. Trimmed SDL variants enable
audio (`-EnableAudio`) or gamepads (`-EnableGamepad`) when reached; their
capability file is checked at configure. Decoded audio or enabled offline
capture needs LabSound's separate `-StaticRuntime -EnableCodecs` artifact.
Core retained UI uses `rmlui-static`; `ui:inline-svg` additionally needs
`build-rmlui.ps1 -StaticRuntime -EnableSvg` and `rmlui-static-svg`.
FreeType is in vcpkg's `ui` feature; LunaSVG is in `ui-svg`. Development keeps
one complete RmlUi artifact. Static and dynamic CRT libraries cannot be mixed.

Configure the generated scene with the static triplet, static CRT, exact
backend and matching dependency directories. For example:

```powershell
& $env:CMAKE_COMMAND -S native -B native/build-scene1-min-sdl `
  -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" `
  -DVCPKG_TARGET_TRIPLET=x64-windows-static `
  '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>' `
  -DBBLITE_GENERATED_DIR="$PWD/generated/scene1" `
  -DBBLITE_BACKEND=SDL_GPU -DBBLITE_MINSIZE=ON `
  -DBBLITE_SDL_DIR="$PWD/artifacts/tools/sdl-min"
& $env:CMAKE_COMMAND --build native/build-scene1-min-sdl --config Release --parallel
```

Attribute sizes with `node tools/map-size-report.mjs <executable.map>`.
Compare core UI, SVG, audio and physics shapes as well as a visual-only scene.
Installed dependency size, linked executable size and packaged payload size
are separate measurements.

## Runtime switches

| Variable | Purpose |
| --- | --- |
| `BBLITE_GPU_BACKEND=dawn` | Runtime choice in a dual build |
| `BBLITE_GPU_DEBUG=1` | GPU validation; prefer diagnostic `--gpu-debug` |
| `BBLITE_SCREENSHOT`, `BBLITE_SCREENSHOT_FRAME`, `BBLITE_MAX_FRAMES` | Capture and frame limit |
| `BBLITE_ANIMATION_SEEK_SECONDS`, `BBLITE_FRAME_DELTA_MS` | Deterministic pose and frame step |
| `BBLITE_ASSET_DIR`, `BBLITE_GPU_SHADER_DIR` | Diagnostic payload overrides |
| `BBLITE_CAPTURE_UI=0` | Canvas-only attribution |
| `BBLITE_RUNTIME_TRACE=1`, `BBLITE_INPUT_REPLAY` | State trace and deterministic input tape |
| `BBLITE_LOCAL_STORAGE_ROOT` | Isolated diagnostic storage |
| `BBLITE_FILE_DIALOG_SAVE_PATH`, `BBLITE_FILE_DIALOG_OPEN_PATH` | Non-interactive file-dialog paths |

ArcRotate uses pointer orbit/pan/wheel; free cameras also use WASD/arrows and
Space/Shift. Diagnostic switches and artifacts are in [debugging](debugging.md).

## Parity

Curated parity requires its committed golden. Only `--recapture-reference`
replaces it. Browser captures use the pinned package and fixed full-page pose,
including retained UI; corpus sources stay unchanged. `--seek <t>` changes both
sides and requires intentional reference recapture when a golden exists.
Use `--without ground|background` for ungated native-only isolation.

`--backend sdl_gpu|dawn` chooses one renderer; `--differential` runs both and
accepts only `--gpu-debug` alongside it. `--exe`/`BBLITE_NATIVE_EXE` select a
specific executable. `--actual` compares an existing PNG. `--no-fail` is a
diagnostic override, never proof that a gate passed.

## Instrumented browser capture

See [capture and uniforms](debugging.md#the-ladder) for browser GPU state.

## Native render capture

See [paired captures](debugging.md#the-ladder).

## Build identity

Before measurement, tools compare the executable's embedded digest against
generated/native sources and check deployed assets/shaders against generation.
Explicit payload overrides are diagnostic paths outside that deployment check.
Build configuration comes from the CMake cache.

Generation rewrites only changed bytes. Scene stamps cover compiler, pin,
arguments, runtime/browser identity and reached inputs; per-file size/mtime
checks allow a warm skip. These are incremental-build checks, not tamper-proof
content verification. Native-source changes refresh the build stamp without
regenerating Babylon behavior. `--cold` forces generation/shader/configure work.

## Proving a change moved nothing

For a compiler-only mechanical refactor, regenerate every scene before taking
each `scene -- neutrality-generated <baseline>` digest (`--write` creates it).
Equal generated bytes plus unchanged native sources establish output neutrality.

For native/shader changes, preserve prior differential reports, run the full
sweep and use `scene -- neutrality <baseline-directory>`. Known repeatability
exceptions are per scene/backend; investigate other moved cells. A fresh clone
or pull requires regenerated output and current patched dependencies first.

Before completing compiler, shader, loader or PAL work:

```powershell
npm run simplify:verify
npm test
npm run scenes:process
npm run scenes:parity
npm run status:verify
```

Run simplify over the complete change before the expensive sweep, apply its
findings, then record the four review angles at the path printed by
`npm run simplify:record`. Records are keyed to the diff. `npm run lint:exports`
is advisory: generated subprocess code can call exports invisible to ts-prune.

## Shipping demo packages

`npm run package:demo -- -Scene <id> -BuildDirectory <dir>` verifies the exact
minimal shape and packages reached assets, backend shaders and dependency
notices. SDL_GPU packages DXIL plus slot sidecars; Dawn packages native WGSL
with its static FXC-only runtime. Compiler intermediates and runtime DLLs do
not belong in the ZIP. Output: `artifacts/releases/`.

## Windows troubleshooting

- Run `doctor` for missing tools and dependency paths.
- Rebuild maintained dependencies after their patches change.
- `LNK1168`: stop the executable locking the output.
- Long vcpkg paths: use a short `--x-buildtrees-root` installation option.
- Compiler/generator/toolchain mismatch: recreate the affected disposable tree.
- Stale payload/stamp: process that scene before measuring it.
- GPU failures: use `--gpu-debug` to print validation errors without SDL prompts.
