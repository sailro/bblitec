# Development

## Setup

Requires Node.js 22.13+, CMake 3.24+, Ninja, C++20, vcpkg, PowerShell, a GPU and WebGPU-capable Chromium.
Windows uses clang-cl/MSVC for development and MSVC for shipping; Linux/macOS default to Clang.

```powershell
npm ci
npm run dev:setup
npm run doctor
npm run scene -- process scene1
npm run scene -- parity scene1
```

On this Windows checkout, set CMake before native commands:

```powershell
$env:CMAKE_COMMAND = 'C:/Program Files/Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
```

`scene` discovers CMake through vswhere; dependency scripts accept PATH, CMAKE_COMMAND or `-CMake`.
`native/patch-identity.cmake` alone reads the patch series of
[native/patches/manifest.json](../native/patches/manifest.json), for the overlay portfiles, the
dependency scripts, configure and doctor. Built Dawn, LabSound, RmlUi and trimmed-SDL artifacts record
their source, patch set and variants; configure refuses a record that differs and warns on an
unrecorded artifact, and `dev:setup` rebuilds a stale one. A dependency script whose checkout already
carries its series leaves the source untouched, so a repeated run recompiles nothing.

### Linux prerequisites

Install [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/install-ubuntu),
Node.js and Chromium. Ubuntu 24.04 native packages:

```sh
sudo apt-get install build-essential clang cmake ninja-build git curl zip unzip \
  pkg-config python3-venv autoconf autoconf-archive automake libtool ccache \
  libltdl-dev libx11-dev libx11-xcb-dev libxft-dev libxext-dev libxrandr-dev libxinerama-dev \
  libxcursor-dev libxi-dev libxfixes-dev libxss-dev libxtst-dev \
  libwayland-dev wayland-protocols libxkbcommon-dev libegl1-mesa-dev \
  libibus-1.0-dev libfontconfig1-dev libvulkan-dev mesa-vulkan-drivers \
  fonts-noto-core fonts-noto-color-emoji

git clone https://github.com/microsoft/vcpkg.git "$HOME/vcpkg"
"$HOME/vcpkg/bootstrap-vcpkg.sh" -disableMetrics
export VCPKG_ROOT="$HOME/vcpkg"
export CMAKE_GENERATOR=Ninja
export CMAKE_BUILD_PARALLEL_LEVEL=3
export VCPKG_MAX_CONCURRENCY=3
```

Generation/browser capture and native scenes need a graphical session, GPU-device access and
X11/Wayland authorization. `SDL_VIDEODRIVER=x11|wayland` selects the display path.
Set `CHROME_PATH` and `CC`/`CXX` as needed. Compiler changes require compatible dependency workspaces.
Fontconfig/FreeType metrics can differ from Windows/browser references.

### macOS prerequisites

Install Apple's Command Line Tools, Clang 18+, CMake, Ninja, Node.js, PowerShell, Git, pkg-config and vcpkg.
Native scenes need a logged-in graphical session. DXC/offline metal compilation is unnecessary.

```sh
export VCPKG_ROOT="$HOME/vcpkg"
export CC=/path/to/llvm/bin/clang
export CXX=/path/to/llvm/bin/clang++
export CMAKE_GENERATOR=Ninja
export CMAKE_BUILD_PARALLEL_LEVEL=3
export VCPKG_MAX_CONCURRENCY=3
```

Set `MACOSX_DEPLOYMENT_TARGET` before building dependencies. Use fresh caches when changing it.
On older systems, LLVM libc++ must retain Apple's availability annotations; installations defining
`_LIBCPP_HAS_NO_VENDOR_AVAILABILITY_ANNOTATIONS` may emit unavailable runtime symbols. A dedicated
LLVM configuration can remove that define from `include/c++/v1/__config_site`, retaining a backup.

Development uses host x64-osx/arm64-osx dependencies. Boost.Charconv provides floating formatting on
systems lacking floating `to_chars`. Maintained Dawn patches support older SDK capability checks. Apple
Silicon runtime validation requires an Apple Silicon host.

### Android

Requires Java 17, SDK platform/build-tools 35 and NDK 28.2.13676358.
Set ANDROID_HOME to a writable SDK; Android Studio is optional. Use the Windows CMake path above.

```powershell
sdkmanager --sdk_root=$env:ANDROID_HOME "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;28.2.13676358"
npm run android -- -Scene torus-states -Sdk C:/Dev/android-sdk -Device <serial> -Install
npm run android -- -Scene torus-states -Backend DAWN -Sdk C:/Dev/android-sdk -Device <serial> -Smoke
npm run android:sweep -- --sdk C:/Dev/android-sdk --device emulator-5554
npm run package:demo -- --platform android --scene torus-states --backend dawn --sdk C:/Dev/android-sdk --device <serial>
npm run demos:release -- --platform android --scene torus-states --backend dawn --sdk C:/Dev/android-sdk --device <serial>
```

`android`, `package:demo` and `demos:release` default to arm64-v8a; `android:sweep` defaults to x86_64;
`-Abi`/`--abi` overrides. SDL_GPU is the default renderer; `-Backend DAWN` builds Dawn only and
`-Backend BOTH` both (`-Smoke` then checks each); sweeps and releases take `--backend sdl_gpu|dawn`.
Debug intents select a compiled renderer with `BBLITE_GPU_BACKEND=sdl_gpu|dawn`. `-Install` opens the
app; `-Smoke` requires native exit 0 and a PNG. APKs/logs are in `artifacts/android/<scene>/<abi>`
(`-dawn`/`-both` suffixes); development installs share one application ID, release packages each have
their own. Reached UI/audio dependencies and Dawn (monolithic/static at the Tint pin, WGSL only) build
into `artifacts/tools/<library>-android-<abi>` and are reused by input fingerprint; `-DawnDirectory`
selects a compatible static install.

Packaging builds Release code into a debug-signed APK with assets/notices, validates it on `--device` and
publishes a ZIP/receipt under `artifacts/releases` (replaced packages move to `.replaced/`). The sweep
prepares sources, shaders and one dependency set, builds four APKs concurrently (`--parallel`, `--jobs`),
then captures serially at the registered pose and golden dimensions, reporting unsupported features,
failures and mismatches separately; `--scene` is repeatable and evidence is in
`artifacts/android/sweep/<run-id>`. Release workflows serialize dependency and device work; run
standalone builds outside an active sweep. Device-local measurements:
[same-device diagnosis](debugging.md#same-device-rendering-comparisons).

Use adb devices -l to select an authorized, unlocked phone or a Vulkan-capable emulator:

```powershell
sdkmanager --sdk_root=$env:ANDROID_HOME "emulator" "system-images;android-35;google_apis;x86_64"
avdmanager create avd -n bblite-api35 -k "system-images;android-35;google_apis;x86_64"
emulator -avd bblite-api35 -gpu host -no-snapshot
```

See [limits](features.md#android).

### iOS

Requires macOS, full Xcode and Clang 18+. `DEVELOPER_DIR` selects Xcode; `CC`/`CXX` select Clang.

```sh
npm run ios -- -Scene scene2 -Device <simulator-udid> -Smoke
npm run ios -- -Scene scene1 -Device <simulator-udid> -Install
```

The default is `iphonesimulator`, host architecture, Dawn/Metal. `-Install` launches the selected app;
`-Smoke` requires a matching exit marker, build stamp and GPU readback.
`-Sdk iphoneos -Architecture arm64` selects a device bundle; SDL_GPU requires SDK 16.4+.
`-MinSize` selects [trimmed device publishing](#minimal-size-shipping-builds).

Static dependencies are SDK/architecture-specific. Generation and shared dependency preparation precede
parallel builds; on Android and iOS, `-SkipGenerate -UseInstalledDependencies` reuses those inputs, not
native binaries.
`-SweepGeneratedDirectoriesFile` selects the dependency union; `-DawnDirectory` selects a compatible Dawn install.
`BBLITE_IOS_TEST_DEVICE=<udid>` enables the headless system-emoji fixture on a booted Simulator.

## Core workflow

Commands follow `npm run scene --`. Targets are registry IDs, local TypeScript paths or `all`.

| Command | Result |
| --- | --- |
| `help`, `list [--json]`, `show <scene>` | Usage and registry data |
| `show <scene> --activation\|--adaptations\|--provenance` | Feature/evidence inventory |
| `status <scene> [--run]` | Generation, payload and executable stamps |
| `compile <scene\|all>` | C++, WGSL, assets, manifests |
| `build <scene\|all>` | Native build/deployment; no shader compilation |
| `process <scene\|all>` | Generate, compile shaders, build |
| `parity <scene\|all> [--backend sdl_gpu\|dawn]` | Both backends (or one) against the reference, and their differential |
| `check <id> [--observe]` | Declared interaction check / its browser observation |
| `validate <scene\|all> [--cold]` | Process, parity, status checks |
| `survey <entry.ts>` | Compile census and API readiness of an external entry |
| `clean --report\|--orphans\|--all\|--pch\|--dlls\|--artifacts` | Inspect/clean selected outputs; `--artifacts` keeps the tools' roots |

Diagnosis commands are in [debugging](debugging.md#the-ladder).

Build dist once with `npm run build`; repeated commands can use `node dist/src/scene-command.js`.
Never rebuild/delete dist during its runs. Finish generation before native builds; finish shared-header
edits before concurrent builds. Logs belong in ignored `artifacts/`.

`npm run sweep` is `validate all`; tests are separate. Ad-hoc sources use generated/build/reference
folders by stem and have diagnostic-only comparisons without configured thresholds.

## Integrating a curated parity scene

### Sizing a capability before implementing it

```powershell
npm run scene -- survey <entry.ts>
```

The survey writes `artifacts/survey/<directory>-<stem>/`: `census.json` lists every compile refusal the
lowering reaches (site, message, message class, enclosing function, cascades) and writes no tree;
`api/report.html` lists the pinned declarations the entry references, credited by the evidence
`npm run api -- report --run` collected. Group findings by shared capability and run independent
source-shape probes before implementation batches.

| File | Required data |
| --- | --- |
| `src/scene-registry.ts` | Source, title, pose, gates, attribution |
| `upstream/babylon-lite-corpus.json` | Origins/digests |
| `reference/<id>/babylon-lite-golden.png` | Pinned-browser reference |
| `reference/exact-corpus-manifest.json` | Source/module/image/query provenance |
| `docs/status.md`, `docs/images/scenes/<id>.png` | Current measurement and preview |
| `checks/<id>.json` | Interaction phases/expectations; plugins in `checks/plugins/` |

Match the [reference pose](fidelity.md#the-reference-pose). New scenes need full/foreground MAD below
0.5 on both backends plus interaction checks. Update registry/corpus membership tests. Fixture
generators are in `tools/fixtures/`; previews use `tools/create-status-preview.mjs`; ICU changes require
`tools/generate-emoji-presentation.mjs`.

## Linting and formatting

`npm ci` installs pinned ESLint/typescript-eslint and Prettier. Native checks require LLVM 22's
clang-tidy and clang-format, discovered on PATH or in Visual Studio. `CLANG_TIDY` and `CLANG_FORMAT`
override their executable paths; Unix versioned names such as `clang-tidy-22` are supported.

```powershell
npm run lint:ts
npm run lint:tools
npm run patches:check
npm run format
npm run format:check
npm run scene -- build scene1 --backend both
npm run lint -- scene1
```

ESLint checks maintained compiler, tooling and test code with type-aware TypeScript rules.
`npm run lint:ts -- --fix` applies safe fixes. `lint:tools` type-checks the JavaScript tools and check
plugins (`tsconfig.tools.json`, strict `checkJs`) against the declarations the build emits for
`dist/src`. Prettier leaves embedded source strings unchanged.
`patches:check` verifies the patch manifest against the patch files, their headers and every consumer.
clang-format formats maintained native sources and C++ test fixtures without sorting includes.
Corpus, example scenes, references, source pins, vendored code and generated output are excluded.

`lint:cpp` accepts scene IDs, Ninja build directories, or `all` (the full scene/demo registry).
`--backend sdl_gpu|dawn|both` selects registered build directories; `--file <source>` and `--jobs <count>`
bound the work. CMake exports `compile_commands.json`; clang-tidy uses its flags and includes and fails
on diagnostics. Missing builds or matching sources are errors; lint never generates or builds scenes.
Each run writes logs, clang-tidy YAML diagnostics and a JSON result index to `artifacts/code-quality/`.

`.clang-tidy` enables only checks that pass on maintained and generated code; its header names the checks
still off and the generated output that reports them. By default, native lint checks handwritten
translation units and headers. `--generated` includes the
build's emitted C++ and cached generated headers without changing their bytes:

```powershell
npm run lint:cpp -- all --generated --backend both
```

Generate and build the selected scenes first; a build covers only its reached features and platform, so
use both backends and the affected subsystem configurations. Suggested fixes are never applied to
generated files.

## Validation

Use focused checks per unit. Run the full checks below at integration milestones or on explicit request;
do not repeat them after individual fixes:

```powershell
npm run lint:ts
npm run lint:tools
npm run format:check
npm run lint:cpp -- <representative-native-build-directory>
npm run simplify:verify
npm test
npm run sweep
node dist/src/scene-command.js neutrality <saved-baseline-directory>
```

Simplify covers the full diff; `npm run simplify:record` identifies its content-hashed record.
`docs/reviews/` holds the record of the most recent reviewed change. Status verification checks
published measurements, registry names and canvas gates; measured repeatability exceptions live in the
neutrality allowlist.

Documentation-only changes require link and affected metadata checks. Rendering checks are required
when executable inputs or measurement contracts change. `lint:exports` is advisory.

## Proving a change moved nothing

`neutrality <file> --generated --write` saves a generated-byte baseline and `neutrality <file> --generated`
compares against it after full registry regeneration. Native/shader changes use saved differential
reports and the validation sequence above.

## Native builds

`--backend sdl_gpu|dawn|both` selects compiled renderers; development defaults to both.
`--compiler auto|clangcl|msvc` selects the Windows compiler. Environment equivalents are
`BBLITE_BACKEND`, `BBLITE_DEV_COMPILER` and `BBLITE_CMAKE_GENERATOR`.

Dual builds use `native/build-<id>-release`; single-backend folders append `-sdl_gpu`/`-dawn`.
`parity` and `check` measure every backend the build compiles; `--backend sdl_gpu|dawn` (any case, `gpu`
means `sdl_gpu`) or an ambient `BBLITE_GPU_BACKEND` selects one. `BBLITE_NATIVE_EXE` overrides the executable.

Generation writes reached features and image codecs to `generated/<id>/features.cmake`;
`native/dependency-features.cmake` maps them to `native/vcpkg.json` manifest features and native units.
vcpkg's SDL is the `sdl` feature, requested unless a trimmed SDL artifact (`BBLITE_SDL_DIR`, every shipping
build) replaces it.
Each native macro has one owner and is defined, 0 or 1, wherever it is tested: CMake defines build options,
generation writes each feature-keyed macro to its own `bblite/features/<name>.hpp` (`src/feature-macros.ts`),
which every file testing it includes, and its composition decisions to `render_capabilities.hpp`. Guards are
plain `#if X`; an undefined name in a project unit's `#if` is a compile error (`-Wundef`, MSVC `/we4668` with
SDK and dependency headers external). Native test fixtures (`test/native-fixture.ts`) build the same way:
their `/D` feature macros become those headers, and `/we4668` applies.

Development shares `artifacts/vcpkg-installed/development-full-<key>`, keyed by `native/vcpkg.json`,
its configuration and the overlay ports; `BBLITE_VCPKG_INSTALLED_ROOT` relocates the root. Each
`scene build` reconciles it once, before any configure (configures never run vcpkg), when the features,
triplet or vcpkg changed; shipping installs are keyed the same way, and the three most recently used
installs per name are kept. `tools/setup-worktree.ps1 -Path <path> -Branch <branch>` isolates
outputs/shares caches; `-SharedVcpkg` junctions the install root, so checkouts of different manifests
share it without reinstalling. Use `-Remove` to unlink junctions before removing a worktree.

### Concurrency

| Variable | Stage |
| --- | --- |
| BBLITE_PARALLEL_COMPILES | Generation |
| BBLITE_PARALLEL_SCENES | Native scenes |
| BBLITE_SCENE_BUILD_JOBS | Jobs per scene; population default 1 |
| BBLITE_PARALLEL_PARITY | Comparisons; default 8, audio serialized |

Defaults use CPU affinity/RAM and Ninja history. `tools/model-build-scheduling.mjs` inspects scheduling.
Native ccache stores objects in `artifacts/native-cache` (CMake `BBLITE_NATIVE_CACHE_DIR`, 25 GiB);
`BBLITE_NATIVE_CACHE=0` disables it. Keys are relative to the checkout, so worktrees share hits, and Clang
builds keep the precompiled header under the cache. Each repository unit reads a content-addressed folder
holding exactly the generated headers its include closure names (`native/native-header-cache.cmake`), so a
generated header rebuilds only its includers and a unit hits across scenes whose inputs to it agree; debug
keys retain directory identity.

## Shader compilation

`process --shader d3d12|vulkan|metal|all` selects offline targets; default is the host target.
`BBLITE_SHADER_TARGET`, `TINT_PATH` and `DXC_PATH` override defaults. Dawn uses WGSL.
Shader checkpoints include input/output bytes and compiler identity.

| Cache | Location |
| --- | --- |
| Assets | `.cache/assets` |
| Executed bakes | `artifacts/bake-cache` |
| Tint/DXC | `artifacts/shader-cache` |

`BBLITE_BAKE_CACHE=0` bypasses bakes. `--cold` forces generation/shader/configuration work without deleting caches.

## Build identity

Measured runs verify generated/native digests, the deployed payload (the compiled backends' shader files
and assets) and CMake configuration. Generation and
shaders use content identity; native outputs also use size/mtime. Native edits refresh build stamps.
CMakeLists edits require process before parity. Explicit payload overrides are diagnostic.

## Minimal-size shipping builds

```powershell
npm run demos:release -- --output artifacts/releases
```

Options: `--scene <id,id>`, `--workers N`, `--jobs N`, `--plan` (generates, then prints the plan). The workflow owns dependency installation,
prepares reached static dependencies, and builds and packages application demos. Plans/logs live in
`artifacts/shipping/`; receipts include bytes, hashes and startup results. Replaced packages go to
`.replaced/`; `@previous/` is preserved. Every platform stages, archives, publishes and credits its
dependencies' notices through `src/package-output.ts` and `src/package-notices.ts`.

| Platform | Shipping configuration |
| --- | --- |
| Windows | MSVC, static CRT, SDL_GPU/D3D12, x64-windows-static |
| Linux | Clang/LLD, SDL_GPU/Vulkan, section GC/LTO/strip; host glibc/ABI, fonts and audio remain dependencies |
| macOS | Universal x86_64+arm64, Clang/Ninja, SDL_GPU/Metal, LTO/dead-strip/lipo, ad-hoc signing |
| iOS | ARM64 iPhone+iPad, SDL_GPU/Metal, trimmed static dependencies, LTO/dead-strip, unsigned `.app` |

Linux/macOS packages omit Dawn and retain executable permissions. RUNTIME-LIBRARIES.txt lists host
libraries/frameworks. Linux requires `lld` for shipping. macOS packages are not Developer ID signed or
notarized; both slices must share payload/settings and have no external dynamic dependencies. Startup
runs only on the build host's architecture. ARM requires deployment target 11+.

Manual builds use `BBLITE_MINSIZE=ON`, matching backend/CRT/triplet, generated directory and trimmed
SDL/Dawn/LabSound/RmlUi artifacts. Dependency flags include `-EnableAudio`, `-EnableGamepad`,
`-EnableCodecs`, `-EnableSvg`, `-MinSize` and Windows `-StaticRuntime`. Missing reached subsystems refuse,
as do artifacts whose recorded source or patch set differs.
`BBLITE_PCH` is off; capture options are explicit and disabled capture requests fail.

```powershell
npm run package:demo -- --scene <id> --build-directory <dir>
```

macOS packaging requires both slices via `--build-directory <intel>` and `--arm64-build-directory <arm>`;
defaults are `native/build-<id>-min-sdl-x86_64` and `native/build-<id>-min-sdl-arm64`.
Dependency builds accept `-MacArchitecture`; use matching vcpkg and CMAKE_OSX_ARCHITECTURES.

```sh
npm run package:demo -- --platform ios --scene tetris --jobs 3
npm run demos:release -- --platform ios --scene tetris,platformer --jobs 3
```

iOS packages contain Metal shaders and reached static dependencies with capture disabled; each ZIP holds
an iPhone/iPad device app. Receipts record hashes, sizes and `startup.status=not-run`.

The desktop packager runs the staged executable for five frames with GPU validation, then publishes the ZIP
only after success. CMake presets provide Windows developer-prompt recipes. Linker size attribution:
`node tools/map-size-report.mjs <executable.map>`.

## Updating Babylon Lite

Update pin, package lock, corpus catalog and reference provenance together. Run test:upstream,
full generation, corpus:verify and validation. `corpus:manifest -- --previous-version <version>
--previous-commit <sha>` previews changes before `--write`; offline mode cannot verify uncached origins.

API updates: `npm run api -- diff`, update affected cases/fingerprints, then
`npm run api -- snapshot --write` and `npm run api -- report --run`.
`test:upstream` rejects snapshot or coverage-target drift from the installed pin.

## API coverage

```powershell
npm run api -- report --run
npm run api -- report --filter BoxOptions
npm run api -- check
npm run api -- diff --baseline <previous-snapshot.json>
```

Reports, logs and receipts live in ignored `artifacts/api-coverage` (`--output <directory>` relocates);
[features](features.md#api-coverage-inventory) owns the metrics. `report --run` collects compiler evidence
from all tests and registered scenes/demos (registered query and host companion), then runs semantic cases;
missing corpus entries, failed/skipped tests or missing scene receipts block publication. `report` reuses
current receipts and runs no tests or native programs.

Semantic cases contain `id`, `level` (`generation`, `native`, `parity`, `refusal`), `scope`, `limitations`,
`test: {file, name}`, and `targets: [{id, fingerprint}]`. Targets describe the named test's assertions.
Receipts bind cases, pin/descriptor, compiler/runtime/test/tooling/corpus inputs and Node/platform identity;
changed external toolchains/assets and other hosts require separate qualification. Snapshot acceptance is explicit.

## Windows troubleshooting

| Failure | Action |
| --- | --- |
| Missing tools/dependencies | doctor; verify path overrides |
| LNK1168 | Stop the executable holding the output |
| Long vcpkg paths | Short --x-buildtrees-root |
| Wrong compiler/generator | Recreate the affected disposable build tree |
| Stale binary/payload | Process the scene |

Runtime switches and captures: [debugging](debugging.md).
