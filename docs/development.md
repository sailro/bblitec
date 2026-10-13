# Development

## Setup

Requires Node.js 22.13+, CMake 3.24+, Ninja, C++20, vcpkg, PowerShell, a GPU and WebGPU-capable Chromium.
Windows: clang-cl for development and tests; MSVC only for release builds. Linux/macOS: Clang.

```powershell
npm ci
npm run dev:setup
npm run doctor
npm run scene -- process scene1
npm run scene -- parity scene1
```

- `scene` finds CMake through vswhere. Dependency scripts and Android need PATH, `CMAKE_COMMAND` or `-CMake`; on this
  Windows host: `$env:CMAKE_COMMAND = 'C:/Program Files/Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'`.
- Patches: [native/patches/manifest.json](../native/patches/manifest.json) lists each patch series, its builds, purpose and
  upstream state; only `native/patch-identity.cmake` reads it. `npm run patches:check` verifies manifest, files and consumers.
- Built Dawn, LabSound, RmlUi and trimmed-SDL artifacts record source, patches and variants: configure refuses a mismatch,
  warns on an unrecorded artifact; `dev:setup` rebuilds stale ones.

### Linux prerequisites

Install [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/install-ubuntu), Node.js and Chromium.
Ubuntu 24.04:

```sh
sudo apt-get install build-essential clang cmake ninja-build git curl zip unzip \
  pkg-config python3-venv autoconf autoconf-archive automake libtool ccache \
  libltdl-dev libx11-dev libx11-xcb-dev libxft-dev libxext-dev libxrandr-dev libxinerama-dev \
  libxcursor-dev libxi-dev libxfixes-dev libxss-dev libxtst-dev \
  libwayland-dev wayland-protocols libxkbcommon-dev libegl1-mesa-dev \
  libibus-1.0-dev libdbus-1-dev libfontconfig1-dev libvulkan-dev mesa-vulkan-drivers \
  fonts-noto-core fonts-noto-color-emoji

git clone https://github.com/microsoft/vcpkg.git "$HOME/vcpkg"
"$HOME/vcpkg/bootstrap-vcpkg.sh" -disableMetrics
export VCPKG_ROOT="$HOME/vcpkg"
export CMAKE_GENERATOR=Ninja
export CMAKE_BUILD_PARALLEL_LEVEL=3
export VCPKG_MAX_CONCURRENCY=3
```

Needs a graphical session with GPU access; `SDL_VIDEODRIVER=x11|wayland` selects the display. Set `CHROME_PATH`,
`CC`/`CXX` as needed; compiler changes need fresh dependency workspaces.

### macOS prerequisites

Command Line Tools, Clang 18+, CMake, Ninja, Node.js, PowerShell, Git, pkg-config, vcpkg; same exports as Linux plus
`CC`/`CXX` pointing at LLVM. Set `MACOSX_DEPLOYMENT_TARGET` before building dependencies and use fresh caches when it
changes (ARM needs 11+). LLVM libc++ must keep Apple availability annotations: remove
`_LIBCPP_HAS_NO_VENDOR_AVAILABILITY_ANNOTATIONS` from `include/c++/v1/__config_site` if defined. Apple Silicon runtime
validation needs an Apple Silicon host.

### Android

Java 17, SDK platform/build-tools 35, NDK 28.2.13676358, writable `ANDROID_HOME`, the Windows CMake path above.

```powershell
sdkmanager --sdk_root=$env:ANDROID_HOME "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;28.2.13676358"
npm run android -- -Scene torus-states -Sdk C:/Dev/android-sdk -Device <serial> -Install
npm run android -- -Scene torus-states -Backend DAWN -Sdk C:/Dev/android-sdk -Device <serial> -Smoke
npm run android:sweep -- --sdk C:/Dev/android-sdk --device emulator-5554 --capture-only
npm run package:demo -- --platform android --scene torus-states --backend dawn --sdk C:/Dev/android-sdk --device <serial>
npm run demos:release -- --platform android --scene torus-states --backend dawn --sdk C:/Dev/android-sdk --device <serial>
sdkmanager --sdk_root=$env:ANDROID_HOME "emulator" "system-images;android-35;google_apis;x86_64"
avdmanager create avd -n bblite-api35 -k "system-images;android-35;google_apis;x86_64"
emulator -avd bblite-api35 -gpu host -no-snapshot
```

- ABI: arm64-v8a default, x86_64 for `android:sweep`; `-Abi`/`--abi` overrides.
- Backend: SDL_GPU default; `-Backend DAWN|BOTH`; sweeps/releases take `--backend sdl_gpu|dawn`.
- `-Install` launches; `-Smoke` needs exit 0 and a PNG. Output: `artifacts/android/<scene>/<abi>`; dependencies in
  `artifacts/tools/<library>-android-<abi>`, reused by fingerprint; `-DawnDirectory` selects a static Dawn.
- Sweep: builds four APKs concurrently (`--parallel`, `--jobs`), captures serially; `--scene` repeatable; `--render-state`
  checks every renderer frame; evidence in `artifacts/android/sweep/<run-id>`. `--capture-only` skips desktop goldens.
  Run standalone builds outside an active sweep.
- Release packaging publishes a ZIP/receipt under `artifacts/releases` (replaced ones move to `.replaced/`).
- Device-matched Canvas2D atlases: run `node tools/bake-android-sprite-atlas.mjs --adb <adb> --device <serial> --socket
  <socket> --browser-package org.chromium.chrome --output artifacts/device-atlases.json --module <file#export>`
  (`--module` repeatable) against a running Chromium debug socket, then set `BBLITE_SPRITE_ATLAS_BUNDLE` to the file.
  Unset it to bake on the host. Recreate bundles after source changes; outputs are never overwritten.
- Visual qualification: [same-device comparisons](debugging.md#same-device-comparisons).

### iOS

macOS, full Xcode, Clang 18+; `DEVELOPER_DIR` selects Xcode.

```sh
npm run ios -- -Scene scene2 -Device <simulator-udid> -Smoke
npm run ios -- -Scene scene1 -Device <simulator-udid> -Install
```

- Default: `iphonesimulator`, host architecture, Dawn/Metal. `-Sdk iphoneos -Architecture arm64` builds a device bundle;
  SDL_GPU needs SDK 16.4+. `-MinSize` selects [trimmed publishing](#minimal-size-shipping-builds).
- Android and iOS: `-SkipGenerate -UseInstalledDependencies` reuses generated inputs, not binaries;
  `-SweepGeneratedDirectoriesFile` selects the dependency union.
- `BBLITE_IOS_TEST_DEVICE=<udid>` enables the system-emoji fixture on a booted Simulator.

## Core workflow

Commands follow `npm run scene --`. Targets are registry IDs, local TypeScript or HTML paths, or `all`.

| Command | Result |
| --- | --- |
| `help [command]`, `list [--json]`, `show <scene>` | Usage and registry data |
| `show <scene> --activation\|--adaptations\|--provenance` | Feature/evidence inventory |
| `status <scene> [--run]` | Generation, payload and executable stamps |
| `compile <scene\|all>` | C++, WGSL, assets, manifests |
| `build <scene\|all>` | Native build/deployment; no shader compilation |
| `process <scene\|all> [--cold]` | Generate, compile shaders, build; `--cold` redoes work without deleting caches |
| `parity <scene\|all> [--backend sdl_gpu\|dawn]` | Measure against the reference ([ladder](debugging.md#the-ladder)) |
| `check <id> [--observe]` | Interaction check / its browser observation |
| `validate <scene\|all> [--cold]` | Process, parity, status checks; `npm run sweep` = `validate all` |
| `survey <entry.ts\|page.html>` | Refusal census and API readiness of an external entry |
| `clean --report\|--orphans\|--all\|--pch\|--dlls\|--artifacts` | Clean outputs; orphan/all/artifact prune cache inputs unused for `--cache-days` (30); `process <id> --cold` recreates pruned inputs |

- Build dist once with `npm run build`, then `node dist/src/scene-command.js` is faster. Rebuilds refuse while a
  consumer runs.
- Finish generation before native builds and shared-header edits before concurrent builds. Logs go in `artifacts/`.
- Ad-hoc sources use folders by stem and diagnostic-only comparisons. `--site-root <dir>` and `--public-dir <dir>` place
  `/` URLs of sources outside the repository.

## Integrating a curated parity scene

### Sizing a capability before implementing it

`npm run scene -- survey <entry.ts>` writes `artifacts/survey/<directory>-<stem>/`: `census.json` (every refusal with site,
message class, function and cascades; no tree) and `api/report.html` (referenced pinned declarations). Group by shared
capability and probe source shapes before implementing. The compiler's `--coverage <coverage.json>` (with `--out` or
`--survey`) records statement-level retained, refused and rolled-back lowering; it does not prove native support.

### Required files

| File | Data |
| --- | --- |
| `src/scene-registry.ts` | Source, title, pose, gates, attribution |
| `upstream/babylon-lite-corpus.json` | Origins/digests |
| `reference/<id>/babylon-lite-golden.png` | Pinned-browser reference |
| `reference/exact-corpus-manifest.json` | Source/module/image/query provenance |
| `docs/status.md`, `docs/images/scenes/<id>.png` | Measurement and preview (`tools/create-status-preview.mjs`) |
| `checks/<id>.json` | Interaction checks; plugins in `checks/plugins/` |

New scenes need full/foreground MAD below 0.5 on both backends plus interaction checks, and updated registry/corpus
membership tests. Fixture generators: `tools/fixtures/`. ICU changes: `tools/generate-emoji-presentation.mjs`.

## Linting and formatting

```powershell
npm run lint:ts
npm run lint:tools
npm run patches:check
npm run format
npm run format:check
npm run lint -- scene1
npm run lint:cpp -- all --generated --backend both
```

- `lint:ts` (`-- --fix` for safe fixes): type-aware ESLint. `lint:tools`: strict `checkJs` over tools and plugins
  (`tsconfig.tools.json`) and browser init scripts (`tsconfig.browser.json`). `lint:exports` is advisory.
- Native: LLVM 22 clang-tidy/clang-format (PATH or Visual Studio; `CLANG_TIDY`, `CLANG_FORMAT` override).
- `lint:cpp` takes scene IDs, Ninja build dirs or `all`; `--backend`, `--file`, `--jobs`, `--generated`, `--no-cache`. It
  never builds: build the scenes first, on both backends. A PCH older than its inputs is refused. Results:
  `artifacts/code-quality/`; clean units are cached in `artifacts/code-quality-cache/` (30 days).
- Corpus, references, pins, vendored and generated code are excluded from formatting; fixes are never applied to generated files.

## Validation

Run focused checks per unit. Run the full set only for final validation of a compiler PR or on request:

```powershell
npm run lint:ts
npm run lint:tools
npm run format:check
npm run simplify:verify
npm test
npm run sweep
npm run lint:cpp -- all --generated --backend both
node dist/src/scene-command.js neutrality <saved-baseline-directory>
```

- `npm run sweep`: about 20 minutes warm, hours cold. A new worktree starts cold.
- Simplify covers the full diff. Write the record (`npm run simplify:record`, content-hashed in `artifacts/reviews/`)
  after applying findings; source changes invalidate it.
- `npm run status:verify` checks published values, registry names and canvas-only pairs against saved reports.
  Repeatability exceptions live in the neutrality allowlist; scenes with partitioned live text are unchecked.
- Documentation-only changes: link and metadata checks. Rendering checks when executable inputs or measurement contracts change.

## Proving a change moved nothing

- `neutrality <file> --generated --write` saves a generated-byte baseline; `neutrality <file> --generated` compares after
  full regeneration. Native/shader changes compare saved differential reports.
- Ocean needs saved native PNGs at 1280×720; live text regions (GPU timing, frame counter) are reported separately.

## Native builds

- `--backend sdl_gpu|dawn|both` (default both; `BBLITE_BACKEND`), `--compiler auto|clangcl|msvc` (`BBLITE_DEV_COMPILER`),
  `BBLITE_CMAKE_GENERATOR`.
- Build dirs: `native/build-<id>-release`, suffixed `-sdl_gpu`/`-dawn` for one backend. `parity`/`check` measure every
  compiled backend unless `--backend` (or an ambient `BBLITE_GPU_BACKEND`) selects one.
- Generation writes `generated/<id>/features.cmake`; `native/dependency-features.cmake` maps features to vcpkg features
  and units. vcpkg SDL is used unless a trimmed SDL (`BBLITE_SDL_DIR`) replaces it.
- Macros: each feature macro has its own `bblite/features/<name>.hpp` (`src/feature-macros.ts`), included wherever
  tested; composition decisions go to `render_capabilities.hpp`. Guards are plain `#if X`; undefined names are errors
  (`-Wundef`, MSVC `/we4668`). Sources are UTF-8 (MSVC needs `/utf-8`).
- Native fixtures (`test/native-fixture.ts`) take `bblite_core`'s standard and options from `native/CMakeLists.txt` and
  refuse fixtures that restate them. Successful builds are cached in `artifacts/native-fixture-cache/` (30 days);
  `BBLITE_FIXTURE_CACHE=0` disables it.
- vcpkg installs: `artifacts/vcpkg-installed/development-full-<key>` (`BBLITE_VCPKG_INSTALLED_ROOT` relocates), reconciled
  once per `scene build`; three most recent per name kept.
- Worktrees: `tools/setup-worktree.ps1 -Path <path> -Branch <branch> [-SharedVcpkg]`; `-Remove` unlinks junctions first.

### Concurrency and caches

| Variable | Effect |
| --- | --- |
| `BBLITE_PARALLEL_COMPILES` | Generation |
| `BBLITE_PARALLEL_SCENES` | Native scenes |
| `BBLITE_SCENE_BUILD_JOBS` | Jobs per scene (population default 1) |
| `BBLITE_PARALLEL_PARITY` | Comparisons (default 8; audio serialized) |
| `BBLITE_NATIVE_CACHE=0` | Disable ccache (`artifacts/native-cache`, 25 GiB, `BBLITE_NATIVE_CACHE_DIR`) |
| `BBLITE_BAKE_CACHE=0` | Bypass executed bakes (`artifacts/bake-cache`) |

- Defaults use CPU affinity, RAM and Ninja history (`tools/model-build-scheduling.mjs`).
- ccache keys are checkout-relative, so worktrees share hits. Units read content-addressed generated-header folders
  (`native/native-header-cache.cmake`). The clang-cl PCH holds C headers only and keys on absolute paths.
- Other caches: `.cache/assets`, `artifacts/shader-cache` (Tint/DXC).

## Shader compilation

- `process --shader d3d12|vulkan|metal|all|reflection`; default is the host target, or `reflection` for Dawn-only builds.
  Dawn needs no offline binaries or DXC. Overrides: `BBLITE_SHADER_TARGET`, `BBLITE_TINT_PATH`, `DXC_PATH`.
- `pwsh -File tools/build-tint.ps1` builds pinned `tint` and bblite-tint into `artifacts/tools/tint/<identity>`.
  `compile-shaders` refuses any tool whose `provenance.json` does not match the checkout's tool sources.

## Build identity

Measured runs verify generated/native digests, the deployed payload and CMake configuration. CMakeLists edits require
`process` before parity. Payload overrides are diagnostic.

## Minimal-size shipping builds

```powershell
npm run demos:release -- --output artifacts/releases
npm run package:demo -- --scene <id> --build-directory <dir>
npm run package:demo -- --platform ios --scene tetris --jobs 3
```

- `demos:release` options: `--scene <id,id>`, `--workers N`, `--jobs N`, `--plan`. Plans/logs: `artifacts/shipping/`;
  receipts hold bytes, hashes, startup results. `@previous/` is preserved.
- Notices are staged through `src/package-output.ts` and `src/package-notices.ts`.
- The desktop packager runs five frames with GPU validation before publishing. Map sizes with
  `node tools/map-size-report.mjs <executable.map>`.

| Platform | Configuration |
| --- | --- |
| Windows | MSVC, static CRT, SDL_GPU/D3D12, x64-windows-static |
| Linux | Clang/LLD (needs `lld`), SDL_GPU/Vulkan, LTO/strip, no Dawn; glibc, fonts, audio stay system dependencies |
| macOS | Universal x86_64+arm64, SDL_GPU/Metal, LTO/lipo, no Dawn, ad-hoc signing, not notarized; startup runs on the host slice only |
| iOS | ARM64 iPhone+iPad, SDL_GPU/Metal, unsigned `.app`, startup not run |

- Manual builds: `BBLITE_MINSIZE=ON`, matching backend/CRT/triplet, trimmed SDL/Dawn/LabSound/RmlUi artifacts; dependency
  flags `-EnableAudio`, `-EnableGamepad`, `-EnableCodecs`, `-EnableSvg`, `-MinSize`, Windows `-StaticRuntime`. Missing
  subsystems and mismatched artifacts refuse. `BBLITE_PCH` is off; capture is disabled.
- macOS needs both slices: `--build-directory` and `--arm64-build-directory` (defaults
  `native/build-<id>-min-sdl-x86_64`/`-arm64`); dependency builds take `-MacArchitecture`.
- Linux reduced motion needs a D-Bus desktop portal.

## Updating Babylon Lite

Update pin, package lock, corpus catalog and reference provenance together; then `npm run test:upstream`, full
generation, `npm run corpus:verify` and validation. Preview with
`npm run corpus:manifest -- --previous-version <version> --previous-commit <sha>` before `--write`.

## API coverage

```powershell
npm run api -- report --run
npm run api -- report --filter BoxOptions
npm run api -- check
npm run api -- diff --baseline <previous-snapshot.json>
npm run api -- snapshot --write
```

- Inventory: [`upstream/babylon-lite-api.json`](../upstream/babylon-lite-api.json), generated from the pinned
  `index.d.ts` (fingerprints include type dependencies). Semantic cases: [`upstream/api-coverage.json`](../upstream/api-coverage.json)
  with `id`, `level` (`generation|native|parity|refusal`), `scope`, `limitations`, `test: {file, name}`,
  `targets: [{id, fingerprint}]`.
- `report --run` collects evidence from all tests and registered scenes, then runs semantic cases; failed tests or
  missing receipts block publication. `report` alone reuses receipts. Output: `artifacts/api-coverage` (`--output`).
- Only successful lowering, generated pinned bodies, entry adapters and semantic cases earn credit; there is no PAL
  completion percentage. `test:upstream` rejects snapshot drift from the pin.

## Windows troubleshooting

| Failure | Action |
| --- | --- |
| Missing tools | `npm run doctor`; check path overrides |
| LNK1168 | Stop the process holding the executable |
| Long vcpkg paths | Short `--x-buildtrees-root` |
| Wrong compiler/generator | Recreate the build tree |
| Stale binary/payload | `process` the scene |
| Stale dist writer lock | Confirm the PID stopped, delete `artifacts/.dist-writer.lock`, `npm run build` |
