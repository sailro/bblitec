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
```

The scan inventories imports, library members, event shapes and language forms with source hashes/sites.
It includes potentially unused bodies and does not prove compilation. Group findings by shared capability,
match TODOs, and run independent source-shape probes before implementation batches. Record generation,
native build and execution separately. Retry the unchanged entry at batch boundaries.

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

Use focused checks during a batch; completed implementation batches require:

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

The packager runs the staged executable for five frames with GPU validation, then publishes the ZIP
only after success. CMake presets provide Windows developer-prompt recipes. Linker size attribution:
`node tools/map-size-report.mjs <executable.map>`.

## Updating Babylon Lite

Update pin, package lock, corpus catalog and reference provenance together. Run test:upstream,
full generation, corpus:verify and validation. `corpus:manifest -- --previous-version <version>
--previous-commit <sha>` previews changes before `--write`; offline mode cannot verify uncached origins.

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
