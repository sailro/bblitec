# Development

## Setup

Requires Node.js 22.12+, CMake 3.24+, Ninja, C++20, vcpkg, PowerShell, a GPU and WebGPU-capable Chromium.
Windows uses clang-cl/MSVC for development and MSVC for shipping; Linux/macOS default to Clang.

```powershell
npm ci
npm run dev:setup
npm run doctor
npm run scene -- process scene1
npm run scene -- parity scene1 --differential
```

On this Windows checkout, set CMake before native commands:

```powershell
$env:CMAKE_COMMAND = 'C:/Program Files/Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
```

`scene` discovers CMake through vswhere; dependency scripts accept PATH, CMAKE_COMMAND or `-CMake`.
Rebuild installed dependencies after maintained patches change, including `pwsh -File tools/build-rmlui.ps1`.

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

Both backends use Vulkan. Generation/browser capture and native scenes need a graphical session,
GPU-device access and X11/Wayland authorization. `SDL_VIDEODRIVER=x11|wayland` selects the display path.
Set `CHROME_PATH` and `CC`/`CXX` as needed. Compiler changes require compatible dependency workspaces.
Fontconfig/FreeType metrics can differ from Windows/browser references.

### macOS prerequisites

Install Apple's Command Line Tools, Clang 18+, CMake, Ninja, Node.js, PowerShell, Git, pkg-config and vcpkg.
Both backends use Metal/Cocoa in a logged-in graphical session. DXC/offline metal compilation is unnecessary.

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

Development uses host x64-osx/arm64-osx dependencies. CoreText/FreeType supplies fonts; Boost.Charconv
provides floating formatting on systems lacking floating `to_chars`. Maintained Dawn patches support
older SDK capability checks. Apple Silicon runtime validation requires an Apple Silicon host.

### Android

Requires Java 17, SDK platform/build-tools 35 and NDK 28.2.13676358.
Set ANDROID_HOME to a writable SDK; Android Studio is optional. Use the Windows CMake path above.

```powershell
sdkmanager --sdk_root=$env:ANDROID_HOME "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;28.2.13676358"
npm run android -- -Scene torus-states -Sdk C:/Dev/android-sdk -Device <serial> -Install
npm run android -- -Scene torus-states -Backend DAWN -Sdk C:/Dev/android-sdk -Device <serial> -Smoke
npm run android:sweep -- --sdk C:/Dev/android-sdk --device emulator-5554
npm run package:demo -- -Platform android -Scene torus-states -ExpectBackend DAWN -Sdk C:/Dev/android-sdk -Device <serial>
npm run demos:release -- --platform android --scene torus-states --backend dawn --sdk C:/Dev/android-sdk --device <serial>
```

ARM64 is the default; use -Abi x86_64 (--abi x86_64 for npm workflows) for emulators.
SDL_GPU remains the default. -Backend DAWN builds Dawn only; -Backend BOTH includes both renderers.
Sweeps and release workflows select one renderer with --backend sdl_gpu|dawn.
-Install opens the app; -Smoke requires native exit 0 and a PNG. APKs/logs are in
artifacts/android/<scene>/<abi>, with -dawn/-both suffixes for those build variants.
-Smoke checks both renderers in a BOTH APK. Debug intents select a compiled renderer with
BBLITE_GPU_BACKEND=sdl_gpu|dawn; unavailable selections refuse.
Development installs share the default application ID.
Reached UI/audio dependencies and selected Dawn build automatically into artifacts/tools/<library>-android-<abi>.
Dawn is monolithic/static at the Tint pin and consumes WGSL without offline shader compilation.
-DawnDirectory selects a compatible static install.
Their input fingerprints permit reuse; sweep workers consume one prepared dependency set.

Packaging builds Release native code in a debug-signed APK, embeds assets/notices, validates the
staged APK on --device, and publishes a ZIP/receipt under artifacts/releases. Each demo has its own
application ID. Existing packages move to .replaced/.
Android release workflows serialize shared dependency and device work.

The sweep completes source/shader generation and dependency preparation before building four APKs concurrently, then captures serially at the
registered pose and golden dimensions. It preserves thresholds, restores display size and distinguishes
unsupported features, failures and mismatches. --scene is repeatable; --parallel and --jobs control builds.
Evidence is in artifacts/android/sweep/<run-id>. Standalone builds must run outside an active sweep.
-SkipGenerate -UseInstalledDependencies reuses prepared source, shaders and dependencies, not native binaries.
For device-local rendering measurements instead of registered-reference comparisons, see
[same-device diagnosis](debugging.md#same-device-rendering-comparisons).

Use adb devices -l to select an authorized, unlocked phone or a Vulkan-capable emulator:

```powershell
sdkmanager --sdk_root=$env:ANDROID_HOME "emulator" "system-images;android-35;google_apis;x86_64"
avdmanager create avd -n bblite-api35 -k "system-images;android-35;google_apis;x86_64"
emulator -avd bblite-api35 -gpu host -no-snapshot
```

Emulator captures do not qualify physical-device performance. See [limits](features.md#android).

### iOS

Requires macOS, full Xcode and Clang 18+. `DEVELOPER_DIR` selects Xcode; `CC`/`CXX` select Clang.

```sh
npm run ios -- -Scene scene2 -Device <simulator-udid> -Smoke
npm run ios -- -Scene scene1 -Device <simulator-udid> -Install
```

The default is `iphonesimulator`, host architecture, Dawn/Metal. `-Install` launches the selected app;
`-Smoke` requires a matching exit marker, build stamp and GPU readback. SDL_GPU/BOTH refuse on Simulator.
`-Sdk iphoneos -Architecture arm64` selects an unsigned device bundle; SDL_GPU requires SDK 16.4+.
`-MinSize` selects [trimmed device publishing](#minimal-size-shipping-builds).

Static dependencies are SDK/architecture-specific. Generation and shared dependency preparation precede
parallel builds; `-SkipGenerate -UseInstalledDependencies` reuses those inputs, not native binaries.
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
| `parity <scene\|all> --differential` | Both backends against the reference |
| `check <id>`, `observe <id>` | Declared interaction check/browser observation |
| `validate <scene\|all> [--cold]` | Process, parity, status checks |
| `clean --report\|--orphans\|--all\|--pch\|--dlls\|--artifacts` | Inspect/clean selected outputs |

Build dist once with `npm run build`; repeated commands can use `node dist/src/scene-command.js`.
Never rebuild/delete dist during its runs. Finish generation before native builds; finish shared-header
edits before concurrent builds. Logs belong in ignored `artifacts/`.

`npm run sweep` is `validate all`; tests are separate. Ad-hoc sources use generated/build/reference
folders by stem and have diagnostic-only comparisons without configured thresholds.

## Integrating a curated parity scene

### Sizing a capability before implementing it

```powershell
node tools/project-requirements.mjs <entry.ts> <ignored-report.json>
node dist/src/cli.js <entry.ts> --survey <ignored-census.json>
node tools/project-progress.mjs <ignored-acceptance-ledger.json> [ignored-progress.md]
```

The scan inventories imports, library members, event shapes and language forms with source hashes/sites.
It includes potentially unused bodies and does not prove compilation. Group findings by shared capability,
match TODOs, and run independent source-shape probes before implementation batches. Record generation,
native build and execution separately. Retry the unchanged entry at batch boundaries.

The survey lowers the entry past every compile refusal: each statement runs in an emission transaction,
a refusal rolls it back and is recorded, and lowering continues. The census lists every refusal reached
(site, message, message class, enclosing function, cascades from refused declarations) with attempted and
refused lowering counts; it writes no tree. Refusals inside speculative probes belong to the probe, storage
replays keep only their final attempt, and an error outside statement lowering ends the survey as incomplete.
Nested statement transactions journal into every open transaction, so a survey of a large entry costs up to
about 1.6 times its generation.

Progress is closed acceptance groups / fixed baseline groups, with equal credit per group. Every inventoried
requirement needs one owner. Closure requires passing evidence with file hashes and completed dependencies;
100% includes full generation, native builds, execution and validation. Document scope additions explicitly.
This measures verified delivery, not effort or remaining time. Keep private ledgers and reports in artifacts.

| File | Required data |
| --- | --- |
| `src/scene-registry.ts` | Source, title, pose, gates, attribution |
| `upstream/babylon-lite-corpus.json` | Origins/digests |
| `reference/<id>/babylon-lite-golden.png` | Pinned-browser reference |
| `reference/exact-corpus-manifest.json` | Source/module/image/query provenance |
| `docs/status.md`, `docs/images/scenes/<id>.png` | Current measurement and preview |
| `checks/<id>.json` | Interaction phases/expectations; plugins in `checks/plugins/` |

Match source queries, reference time/frame and canvas size. New scenes need full/foreground MAD below
0.5 on both backends plus interaction checks. Canvas-only gates supplement UI-heavy scenes.
Update registry/corpus membership tests. Fixture generators are in `tools/fixtures/`; previews use
`tools/create-status-preview.mjs`; ICU changes require `tools/generate-emoji-presentation.mjs`.

## Validation

Use focused checks per unit. Run the full checks below at integration milestones or on explicit request;
do not repeat them after individual fixes:

```powershell
npm run simplify:verify
npm test
npm run sweep
node dist/src/scene-command.js neutrality <saved-baseline-directory>
```

Simplify covers the full diff; `npm run simplify:record` identifies its content-hashed record.
`docs/reviews/` contains the open branch's record only. Status verification checks published measurements,
registry names and canvas gates; measured repeatability exceptions live in the neutrality allowlist.
There is no hosted CI.

Documentation-only changes require link and affected metadata checks. Rendering checks are required
when executable inputs or measurement contracts change. `lint:exports` is advisory.

## Proving a change moved nothing

`neutrality-generated <file> --write` saves generated-byte baselines. Compare after full registry
regeneration. Native/shader changes use saved differential reports and the validation sequence above.

## Native builds

`--backend sdl_gpu|dawn|both` selects compiled renderers; development defaults to both.
`--compiler auto|clangcl|msvc` selects the Windows compiler. Environment equivalents are
`BBLITE_BACKEND`, `BBLITE_DEV_COMPILER` and `BBLITE_CMAKE_GENERATOR`.

Dual builds use `native/build-<id>-release`; single-backend folders append `-sdl_gpu`/`-dawn`.
Measuring commands' `--backend` chooses the runtime renderer; `--exe` overrides the binary.

| Reached feature | Dependency/build effect |
| --- | --- |
| renderer:scene | PBR renderer and selected backend units |
| Image formats | Codecs/notices from `native/vcpkg.json` |
| glTF / Babylon / JSON | nlohmann-json |
| ui:rml | FreeType, pinned RmlUi, platform fonts |
| ui:inline-svg | LunaSVG and RmlUi `-EnableSvg` |
| text:layout / text rendering | HarfBuzz / BBLITE_HAS_TEXT |
| physics:world | Bullet |
| navigation / crowd / tile-cache | Corresponding Recast/Detour features |
| audio | LabSound/libnyquist; byte-selected codecs where known |
| platform:window | Offscreen surfaces and presenters |
| gamepad / files / audio | Matching SDL subsystem |

Development shares `artifacts/vcpkg-installed/development-full`. Reconcile an install once, never
concurrently; parallel builds use `VCPKG_MANIFEST_INSTALL=OFF`. `BBLITE_VCPKG_INSTALLED_ROOT` relocates it.
`tools/setup-worktree.ps1 -Path <path> -Branch <branch>` isolates outputs/shares caches; `-SharedVcpkg`
needs coordinated installation. Use `-Remove` to unlink junctions before removing a worktree.

### Concurrency

| Variable | Stage |
| --- | --- |
| BBLITE_PARALLEL_COMPILES | Generation |
| BBLITE_PARALLEL_SCENES | Native scenes |
| BBLITE_SCENE_BUILD_JOBS | Jobs per scene; population default 1 |
| BBLITE_PARALLEL_PARITY | Comparisons; default 8, audio serialized |

Defaults use CPU affinity/RAM and Ninja history. `tools/model-build-scheduling.mjs` inspects scheduling.
Native ccache uses `artifacts/native-cache`; `CCACHE_PATH` overrides it and `BBLITE_NATIVE_CACHE=0`
disables it. Identical generated headers share cache storage. Debug keys retain directory identity.

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

Measured runs verify generated/native digests, deployed payload and CMake configuration. Generation and
shaders use content identity; native outputs also use size/mtime. Native edits refresh build stamps.
CMakeLists edits require process before parity. Explicit payload overrides are diagnostic.

## Minimal-size shipping builds

```powershell
npm run demos:release -- --output artifacts/releases
```

Options: `--scene <id,id>`, `--workers N`, `--jobs N`, `--plan`. One workflow owns dependency installation.
It prepares reached static dependencies, builds and packages application demos. Plans/logs live in
`artifacts/shipping/`; receipts include bytes, hashes and startup results. Replaced packages go to
`.replaced/`; `@previous/` is preserved.

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
`-EnableCodecs`, `-EnableSvg`, `-MinSize` and Windows `-StaticRuntime`. Missing reached subsystems refuse.
`BBLITE_PCH` is off; capture options are explicit and disabled capture requests fail.

```powershell
npm run package:demo -- -Scene <id> -BuildDirectory <dir>
```

macOS packaging requires both slices via `-BuildDirectory <intel>` and `-Arm64BuildDirectory <arm>`;
defaults are `native/build-<id>-min-sdl-x86_64` and `native/build-<id>-min-sdl-arm64`.
Dependency builds accept `-MacArchitecture`; use matching vcpkg and CMAKE_OSX_ARCHITECTURES.

```sh
npm run package:demo -- -Platform ios -Scene tetris -Jobs 3
npm run demos:release -- --platform ios --scene tetris,platformer --jobs 3
```

iOS publishing requires SDK 16.4+. Packages contain Metal shaders and reached static dependencies;
capture is disabled. Each ZIP contains an unsigned iPhone/iPad app, not a Simulator binary.
Receipts record hashes, sizes and `startup.status=not-run`; [device qualification](features.md#ios) is incomplete.

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
npm run api -- report --project <entry.ts>
npm run api -- check
npm run api -- diff --baseline <previous-snapshot.json>
```

Searchable HTML/JSON reports, logs and receipts live in ignored `artifacts/api-coverage`;
`--output <directory>` changes the destination. [Features](features.md#api-coverage-inventory) owns the metrics.
`--project` restricts the report to the declarations one external entry references, scanned against this
repository's pin and credited by the collected receipts; collect them at the current inputs first, or the
report marks its evidence stale. Its readiness lists supported use sites and declarations, referenced exported
functions without a routing hook, and imported names the pin does not export. It writes under
`artifacts/api-coverage/projects/<directory>-<entry>` and collects nothing.

`report --run` collects compiler evidence from all tests and registered scenes/demos, then runs semantic cases.
Scenes use their registered query and host companion. Missing corpus entries, failed/skipped tests or missing
scene receipts prevent publication. Collection leaves native outputs intact.
`report` reuses current receipts, scans corpus/fixture references (including unused code), and probes
entry routing with omitted arguments. It executes no test suite or native programs.

Semantic cases contain `id`, `level` (`generation`, `native`, `parity`, `refusal`), `scope`, `limitations`,
`test: {file, name}`, and `targets: [{id, fingerprint}]`. Targets describe the named test's assertions.
Receipts bind cases, pin/descriptor, compiler/runtime/test/tooling/corpus inputs and Node/platform identity;
changed external toolchains/assets and other hosts require separate qualification. Snapshot acceptance is explicit.

## Windows troubleshooting

| Failure | Action |
| --- | --- |
| Missing tools/dependencies | doctor; verify path overrides |
| Patched dependency | Rebuild its installed artifact |
| LNK1168 | Stop the executable holding the output |
| Long vcpkg paths | Short --x-buildtrees-root |
| Wrong compiler/generator | Recreate the affected disposable build tree |
| Stale binary/payload | Process the scene |

Runtime switches and captures: [debugging](debugging.md).
