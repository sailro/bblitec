# Development

## Setup

Requires Node.js 22.12+, CMake 3.24+, Ninja, C++20, vcpkg, PowerShell, a GPU
and WebGPU-capable Chrome/Edge. Windows development uses clang-cl when
available, otherwise MSVC; shipping uses MSVC.

```powershell
npm ci
npm run dev:setup
npm run doctor
```

Rebuild installed dependencies when their maintained patches change.
LabSound uses `tools/patches/labsound-lazy-decoders.patch` to keep its optional file-decoder registry lazy.
For RmlUi: `pwsh -File tools/build-rmlui.ps1`. `scene` commands discover CMake
through vswhere; the `tools/*.ps1` build scripts need it on `PATH`, in
`CMAKE_COMMAND`, or through their `-CMake` parameter.

## Core workflow

Commands follow `npm run scene --`. A scene is a registry ID or a
repository-local TypeScript path; `all` selects the registry.

| Command | Action |
| --- | --- |
| `help` | The usage, generated from the command table |
| `list [--json]` / `show <scene>` | Inspect scene configuration |
| `show <scene> --activation\|--adaptations\|--provenance` | The generated tree's active features and why, adaptations by risk, lowered pinned symbols |
| `status <scene> [--run]` | Generation record current, payload deployed, binary carries the tree's stamp |
| `compile <scene\|all>` | Generate C++, WGSL, assets and manifests |
| `build <scene\|all>` | Build and deploy generated output |
| `process <scene\|all>` | Generate, compile shaders, build |
| `parity <scene\|all> --differential` | Compare both renderers and golden |
| `check <check-id>` / `observe <check-id>` | A declared interaction check (`checks/`) and its browser observation; see [debugging](debugging.md#before-calling-a-scene-done) |
| `validate <scene\|all> [--cold]` | Process, parity, published-status check |
| `clean --report\|--orphans\|--all\|--pch\|--dlls\|--artifacts` | Sizes; unowned trees; owned build trees; duplicated payloads; unowned `artifacts/` entries. Owned trees include `generated/<id>-live`, `native/build-<id>-live-release` and `native/build-<id>-min-*` |

`npm run sweep` runs `validate all`; `npm test` is separate. `scenes:compile`,
`scenes:build`, `scenes:process` and `scenes:parity` are the registry-wide
commands; `upstream:report` runs the upstream tests then a full generation;
`shaders:build` runs the shader step (`src/compile-shaders.ts`) without a
build; `clean:dist` deletes `dist/` when no scene command is running from it.
Build `dist/` once with `npm run build`, then use
`node dist/src/scene-command.js ...` for a sequence. Logs belong in `artifacts/`.

Ad-hoc sources derive `generated/<stem>`, `native/build-<stem>-release`,
`reference/<stem>` and `artifacts/parity/<stem>`. Without configured thresholds,
their image comparisons are diagnostic-only.

## Integrating a curated parity scene

### Sizing a capability before implementing it

Compile the unchanged source first. Identify reached APIs and asset forms;
the first compiler error is only the first blocker. Keep probes separate
from corpus inputs; fix compiler/lowerer/PAL sources.

For a large external project, build a requirements baseline before repeatedly
retrying its entry point. After building `dist`, run
`node tools/project-requirements.mjs <entry.ts> <report.json>` to inventory the
compiler's static import graph, library members, event argument shapes and
language forms. The report includes source hashes and locations. Keep private
reports in an ignored directory. This scan includes potentially unused bodies;
every group starts unassessed, and its counts are not compilation coverage.

Probe uncertain forms independently through `compileSource`, grouping them by
the shared capability they need. Record generation, native build and execution
separately, along with the source/compiler revision. Track closed probes against
a saved baseline and list new discoveries separately; neither a passing probe
nor a file without a reported error establishes whole-application support.
Implement capability batches with focused checks, then retry the unchanged
entry. Use full-corpus validation at the completed batch boundaries below.

| File | Required scene data |
| --- | --- |
| `src/scene-registry.ts` | Source, title, pose, thresholds, attribution |
| `upstream/babylon-lite-corpus.json` | Origins and digests |
| `reference/<id>/babylon-lite-golden.png` | Pinned-browser reference |
| `reference/exact-corpus-manifest.json` | Source/module/image/query provenance |
| `docs/status.md` | Measured row |
| `docs/images/scenes/<id>.png` | Preview from `tools/create-status-preview.mjs` |
| `checks/<id>.json` | Declared interaction check (optional; `checks/plugins/` hold scene-specific arithmetic) |

`tools/fixtures/build-*.mjs` regenerate the committed regression glTF fixtures (each
names its script in `asset.generator`); `tools/generate-emoji-presentation.mjs`
regenerates `native/src/pal_ui_emoji.hpp` after a Node (ICU) upgrade.

Update registry/corpus membership tests. Match `referenceSearch`,
`referenceTimeSeconds` and `referenceFrame` across generation and capture.
Use canvas thresholds when UI could conceal rendering regressions. The
registry gates are per scene; the policy for a new scene is full/foreground MAD
below 0.5 on both backends plus [interaction checks](debugging.md#before-calling-a-scene-done).

## Validation

Use focused checks during implementation and early population generation for
shared changes. Finish the declared batch before its expensive validation:

```powershell
npm run simplify:verify
npm test
npm run sweep
node dist/src/scene-command.js neutrality <saved-baseline-directory>
```

The sweep includes `scenes:process`, `scenes:parity` and `status:verify`.
`status:verify` checks every published MAD against its report, each numbered
row's coverage cell against the registry name, the canvas-only pairs against
`artifacts/parity-canvas/<id>/report-canvas.json`, and prints the wobble-exempt
cells with their newest values instead of comparing them. Preserve prior
differential reports before changes. Investigate moved cells outside measured
scene/backend repeatability exceptions.

Simplify covers the complete diff. Apply findings before the sweep;
`npm run simplify:record` identifies the required record. Keep records limited
to angles, findings and unresolved actions. A record is read only while its
content hash is the branch's diff, so delete the records of merged branches;
`docs/reviews/` holds the open branch's record only. Documentation-only edits
need link and affected metadata checks; rendering runs are needed when
executable inputs or measurement contracts change. `lint:exports` is advisory
because generated subprocess callers may be invisible.

## Proving a change moved nothing

For mechanical compiler refactors, use
`neutrality-generated <file> --write` to save generated-byte baselines.
Regenerate the full registry before each comparison. For native/shader changes,
use the saved differential reports and the validation sequence above.

## Native builds

`--backend sdl_gpu|dawn|both` selects renderers; Windows defaults to both and
requires Dawn. `--compiler auto|clangcl|msvc` selects the Windows compiler.
`BBLITE_DEV_COMPILER` and `BBLITE_CMAKE_GENERATOR` override compiler/generator.

Dual-backend builds use `native/build-<id>-release`; single-backend builds append
`-sdl_gpu` or `-dawn`. Set `BBLITE_BACKEND=SDL_GPU|DAWN|BOTH` to select the same
compiled tree for build, run and status commands. Measuring commands' `--backend`
selects the runtime renderer; `--exe` overrides the compiled-tree selection.

Reached features select dependencies and switches; a scene links nothing it does not reach.

| Feature | Build effect |
| --- | --- |
| `renderer:scene` | `BBLITE_HAS_PBR_RENDERER`; the SDL_GPU and Dawn scene units |
| Packaged image formats | Image features in `native/vcpkg.json`; their `$bblite-image` metadata selects decoding and package notices |
| `loader:gltf`, `loader:babylon`, `data:json` | nlohmann-json |
| `ui:rml` | vcpkg `ui` (FreeType), the pinned RmlUi artifact, DirectWrite, `BBLITE_HAS_UI`; static Windows FreeType keeps SFNT font drivers |
| `ui:inline-svg` | vcpkg `ui-svg` (LunaSVG) and the `-EnableSvg` RmlUi artifact; development builds always include it |
| `text:layout` | vcpkg `text-layout` (HarfBuzz) |
| `text:renderable`, `renderer:text` | `BBLITE_HAS_TEXT` |
| `physics:world` | vcpkg `physics` (Bullet) |
| `shadow:csm` | Cascade records, fitting and receiver paths through `BBLITE_SHADOWS_CSM` |
| `navigation:recast`, `:crowd`, `:tile-cache` | vcpkg `navigation`, `navigation-crowd`, `navigation-tile-cache` |
| `audio:engine`, `audio:decoded-buffer` | Pinned LabSound and libnyquist; direct packaged-buffer reads select container decoders from their bytes, other inputs retain all decoders |
| `platform:window` | `BBLITE_OFFSCREEN_SURFACES` and the window presenters |
| `input:gamepad`, `browser:file`, `audio:engine` | require an SDL build with that subsystem (`tools/build-sdl-min.ps1` flags) |

Development shares `artifacts/vcpkg-installed/development-full`. Reconcile
that install once, then parallelize builds with `VCPKG_MANIFEST_INSTALL=OFF`.
Never reconcile one install concurrently. `BBLITE_VCPKG_INSTALLED_ROOT`
relocates it. `tools/setup-worktree.ps1 -Path <path> -Branch <branch>` creates
isolated outputs and shared caches; `-SharedVcpkg` requires coordinated install
access. Use the script's `-Remove` to unlink cache junctions before deletion.
`text:layout` selects the manifest's HarfBuzz `text-layout` feature.

### Concurrency

| Variable | Stage |
| --- | --- |
| `BBLITE_PARALLEL_COMPILES` | Generation workers |
| `BBLITE_PARALLEL_SCENES` | Concurrent native scenes |
| `BBLITE_SCENE_BUILD_JOBS` | Jobs per scene; population default 1 |
| `BBLITE_PARALLEL_PARITY` | Image comparisons; default 8, audio serialized |

Capacity derives from CPU affinity and CPU/RAM. Native scheduling starts unknown
costs first, then expensive scenes using Ninja history. Measure before overriding
defaults and coordinate independent workflows. Inspect scheduling with
`node tools/model-build-scheduling.mjs <workspace> <workers>`.
Batch shared-header edits before population builds.

Development setup installs pinned ccache. Native builds reuse objects in
`artifacts/native-cache` and skip per-scene PCHs when ccache is active.
Identical generated backend headers share a directory in that cache.
`CCACHE_PATH` selects another executable; `BBLITE_NATIVE_CACHE=0` disables it.
Without ccache, builds use the configured PCH setting. Debug configurations
keep directory-sensitive cache keys.

## Shader compilation

`process --shader d3d12|vulkan|metal|all` selects offline output; default is the
host target. `BBLITE_SHADER_TARGET` is the environment equivalent. Dawn consumes
WGSL and skips offline compilation unless requested. `build` deploys shaders
but does not compile them. `TINT_PATH`/`DXC_PATH` override tools.
Each shader directory reuses a checkpoint of its input and output bytes,
target and compiler identities. Tint and DXC identities are shared across the run.

Assets use `.cache/assets`, executed bakes `artifacts/bake-cache`, and
Tint/DXC `artifacts/shader-cache`. `BBLITE_BAKE_CACHE=0` bypasses bake replay;
`CHROME_PATH` selects Chromium. `--cold` forces generation/shader/configure
work without deleting content caches.

## Build identity

Measured runs check the binary's generated/native digest, deployed payload and
CMake configuration. Generation is keyed by the bytes of what it read (a
checkout that rewrites unchanged files is a hit) and writes changed bytes only;
build outputs are keyed by size and mtime; shader checkpoints use content hashes. Native edits
refresh build stamps. Explicit payload overrides are diagnostic and bypass
normal deployment checks. None of these checks is tamper-proof verification.
`parity` refuses an executable built after a `native/CMakeLists.txt` edit until
`process` refreshes its stamp.

## Minimal-size shipping builds

Build and package all registered application demos with:

```powershell
npm run demos:release -- --output artifacts/releases
```

`--scene <id,id>` selects application demos; `--workers N` and `--jobs N`
bound concurrent builds and jobs per build. `--plan` reads existing generated
features and prints the dependency plan without building or packaging.
The command generates scenes and D3D12 shaders, prepares reached static
dependencies once, then builds with MSVC and packages serially. Each image-codec
set has its own vcpkg install, so SDL_image cannot pull unused decoders from a
shared superset. Fresh CMake caches discard old package paths; stale deployed
payloads are preserved beside their build tree before deployment.

Run one shipping workflow at a time and coordinate dependency installs with
other work. Logs and plans go to `artifacts/shipping/`. Successful replacements
preserve prior packages under the output's `.replaced/`; `@previous/` is untouched.
`SIZE-COMPARISON.md` reports executable and ZIP sizes and changes. Package JSON
receipts contain exact bytes, SHA-256 hashes and the startup-check result.

Use `BBLITE_MINSIZE=ON`, one backend, MSVC, static CRT and
`VCPKG_TARGET_TRIPLET=x64-windows-static`. Set `BBLITE_GENERATED_DIR` and
matching `BBLITE_SDL_DIR`/`BBLITE_DAWN_DIR`, `BBLITE_LABSOUND_DIR`,
`BBLITE_RMLUI_DIR`. Never mix static and dynamic CRT libraries.

Build reached dependencies with `tools/build-sdl-min.ps1`,
`build-dawn-min.ps1`, `build-labsound.ps1 -StaticRuntime` and
`build-rmlui.ps1 -StaticRuntime`. Pick the SDL install by what the scene
reaches: `sdl-min`, `sdl-min-audio`, `sdl-min-gamepad` or
`sdl-min-audio-gamepad`, using `-EnableAudio` for `audio:engine` and
`-EnableGamepad` for `input:gamepad` (a minimal configure warns when the install
carries a subsystem the scene never reaches and refuses the reverse); decoded
audio needs LabSound `-EnableCodecs`; inline SVG needs RmlUi `-EnableSvg`.
Generated features select codecs/navigation libraries.
`BBLITE_VISUAL_CAPTURE`/`BBLITE_AUDIO_CAPTURE` are optional in minimal builds;
disabled runtime requests fail.

Validate sprite and audio shapes with MSVC; clang-cl/PCHs can conceal narrowing
and include issues. Package with
`npm run package:demo -- -Scene <id> -BuildDirectory <dir>`.
The packager runs the staged executable for five frames with GPU validation
from the package directory and refuses a package whose run does not exit
cleanly. It publishes only after the staged run and ZIP creation succeed.
`native/CMakePresets.json` spells the same recipe (`min-sdl`,
`min-sdl-audio-gamepad`, `min-dawn`) for a Visual Studio developer prompt.
`BBLITE_PCH` stays OFF here: the precompile is a serial prefix that costs more
than the parallel parses it saves on a wide host, and this is the one compile of
every unit without a precompiled closure. Output goes to `artifacts/releases/`;
use `node tools/map-size-report.mjs <executable.map>` for linker attribution.

## Updating Babylon Lite

Update the pin, package lock, corpus catalog and reference provenance together.
`babylonLiteRelease.sourceVersion` supplies the source commit. Run
`test:upstream`, full generation, `corpus:verify` and validation.
Use `corpus:manifest -- --previous-version <version> --previous-commit <sha>`
to inspect changes before `--write`. `--offline` cannot verify uncached origins.

## Windows troubleshooting

- Missing tools/dependencies: run `doctor` and check path overrides.
- Patched dependency: rebuild its installed library.
- `LNK1168`: stop the executable holding the output.
- Long vcpkg paths: use a short `--x-buildtrees-root`.
- Wrong compiler/generator: recreate the affected disposable build tree.
- Stale binary/payload: process the scene.

Runtime/capture switches are listed once in [debugging](debugging.md).
