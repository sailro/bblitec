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
For RmlUi: `pwsh -File tools/build-rmlui.ps1`. `scene` commands discover CMake
through vswhere; the `tools/*.ps1` build scripts need it on `PATH`, in
`CMAKE_COMMAND`, or through their `-CMake` parameter.

## Core workflow

Commands follow `npm run scene --`. A scene is a registry ID or a
repository-local TypeScript path; `all` selects the registry.

| Command | Action |
| --- | --- |
| `list` / `show <scene>` | Inspect scene configuration |
| `compile <scene\|all>` | Generate C++, WGSL, assets and manifests |
| `build <scene\|all>` | Build and deploy generated output |
| `process <scene\|all>` | Generate, compile shaders, build |
| `parity <scene\|all> --differential` | Compare both renderers and golden |
| `validate <scene\|all>` | Process, parity, published-status check |
| `clean --orphans` | Remove outputs outside the registry |

`npm run sweep` runs `validate all`; `npm test` is separate.
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

| File | Required scene data |
| --- | --- |
| `src/scene-registry.ts` | Source, title, pose, thresholds, diagnostics |
| `upstream/babylon-lite-corpus.json` | Origins and digests |
| `reference/<id>/babylon-lite-golden.png` | Pinned-browser reference |
| `reference/exact-corpus-manifest.json` | Source/module/image/query provenance |
| `docs/status.md` | Measured row |
| `docs/images/scenes/<id>.png` | Preview from `tools/create-status-preview.mjs` |

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
Preserve prior differential reports before changes. Investigate moved cells
outside measured scene/backend repeatability exceptions.

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

Reached features select dependencies and switches; a scene links nothing it does not reach.

| Feature | Build effect |
| --- | --- |
| `renderer:scene` | `BBLITE_HAS_PBR_RENDERER`; the SDL_GPU and Dawn scene units |
| Packaged image formats | vcpkg `png`, `jpeg`, `webp` (SDL_image codecs) |
| `loader:gltf`, `loader:babylon`, `data:json` | nlohmann-json |
| `ui:rml` | vcpkg `ui` (FreeType), the pinned RmlUi artifact, DirectWrite, `BBLITE_HAS_UI` |
| `ui:inline-svg` | vcpkg `ui-svg` (LunaSVG) and the `-EnableSvg` RmlUi artifact; development builds always include it |
| `text:layout` | vcpkg `text-layout` (HarfBuzz) |
| `text:renderable`, `renderer:text` | `BBLITE_HAS_TEXT` |
| `physics:world` | vcpkg `physics` (Bullet) |
| `navigation:recast`, `:crowd`, `:tile-cache` | vcpkg `navigation`, `navigation-crowd`, `navigation-tile-cache` |
| `audio:engine`, `audio:decoded-buffer` | the pinned LabSound artifact; libnyquist for decoded buffers or capture |
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

## Shader compilation

`process --shader d3d12|vulkan|metal|all` selects offline output; default is the
host target. `BBLITE_SHADER_TARGET` is the environment equivalent. Dawn consumes
WGSL and skips offline compilation unless requested. `build` deploys shaders
but does not compile them. `TINT_PATH`/`DXC_PATH` override tools.

Assets use `.cache/assets`, executed bakes `artifacts/bake-cache`, and
Tint/DXC `artifacts/shader-cache`. `BBLITE_BAKE_CACHE=0` bypasses bake replay;
`CHROME_PATH` selects Chromium. `--cold` forces generation/shader/configure
work without deleting content caches.

## Build identity

Measured runs check the binary's generated/native digest, deployed payload and
CMake configuration. Generation skips unchanged inputs and writes changed bytes
only; native edits refresh build stamps. Explicit payload overrides are
diagnostic and bypass normal deployment checks. Size/mtime reuse checks are
incremental-build checks, not tamper-proof verification.

## Minimal-size shipping builds

Use `BBLITE_MINSIZE=ON`, one backend, MSVC, static CRT and
`VCPKG_TARGET_TRIPLET=x64-windows-static`. Set `BBLITE_GENERATED_DIR` and
matching `BBLITE_SDL_DIR`/`BBLITE_DAWN_DIR`, `BBLITE_LABSOUND_DIR`,
`BBLITE_RMLUI_DIR`. Never mix static and dynamic CRT libraries.

Build reached dependencies with `tools/build-sdl-min.ps1`,
`build-dawn-min.ps1`, `build-labsound.ps1 -StaticRuntime` and
`build-rmlui.ps1 -StaticRuntime`. SDL audio/gamepads require their enable flags;
decoded audio needs LabSound `-EnableCodecs`; inline SVG needs RmlUi
`-EnableSvg`. Generated features select codecs/navigation libraries.
`BBLITE_VISUAL_CAPTURE`/`BBLITE_AUDIO_CAPTURE` are optional in minimal builds;
disabled runtime requests fail.

Validate sprite and audio shapes with MSVC; clang-cl/PCHs can conceal narrowing
and include issues. Package with
`npm run package:demo -- -Scene <id> -BuildDirectory <dir>`.
Output goes to `artifacts/releases/`; use
`node tools/map-size-report.mjs <executable.map>` for linker attribution.

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
