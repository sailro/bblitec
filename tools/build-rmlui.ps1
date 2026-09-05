# Builds the pinned RmlUi into artifacts/tools/rmlui.
#
# Same shape as build-labsound.ps1, build-tint.ps1 and build-dawn.ps1, and
# for the same reason: vcpkg's rmlui port is neither at the revision the
# backend-neutral UI recorder was validated against nor patched with the
# maintained native/patches/rmlui-*.patch files, so the pin lives in
# upstream/rmlui.json and the library is built once from it instead of
# being re-fetched and re-built inside every UI scene's build tree.
#
# Three deliberate departures from RmlUi's own default build:
#
#   * **Static core only.** The same option set the former per-tree
#     FetchContent configure forced: static libraries, no samples, no Lua
#     bindings, no precompiled headers, no RmlUi-injected compiler flags.
#   * **FreeType and LunaSVG come from the consuming triplet.** rmlui_core
#     records both targets as link interfaces, and every consuming configure
#     resolves them from its own vcpkg install (the `ui` manifest feature --
#     dynamic development triplet or the x64-windows-static mini triplet).
#     This build compiles against that same prefix; -FreetypeRoot retains its
#     historical name and defaults to the shared development install.
#   * **Backends/RmlUi_Platform_SDL.{h,cpp} are installed beside the
#     package.** RmlUi builds its Backends/ directory only under samples
#     and tests and installs none of it, while the scene build compiles
#     that translation unit directly (the file includes nothing else from
#     Backends/). Carrying the pair keeps the artifact self-contained and
#     the .cache checkout disposable.

param(
    [string]$Workspace = "",
    [string]$OutputDirectory = "",
    [string]$FreetypeRoot = "",
    # Only the -StaticRuntime artifact needs vcpkg, to install the
    # static-triplet FreeType headers it compiles against (see below).
    [string]$Vcpkg = $(if ($env:VCPKG_ROOT) { Join-Path $env:VCPKG_ROOT "vcpkg.exe" } else { "" }),
    [switch]$StaticRuntime,
    [switch]$EnableSvg,
    [string]$CMake = $env:CMAKE_COMMAND
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
# Development keeps one complete artifact. Shipping selects SVG only when
# the generated scene reaches ui:inline-svg.
$rmlSvgEnabled = -not $StaticRuntime -or $EnableSvg
$rmlSvgSetting = if ($rmlSvgEnabled) { "ON" } else { "OFF" }
$staticSuffix = if ($EnableSvg) { "-static-svg" } else { "-static" }
if (-not $Workspace) {
    $Workspace = if ($StaticRuntime) {
        ".cache\rmlui$staticSuffix"
    } else {
        ".cache\rmlui"
    }
}
if (-not $OutputDirectory) {
    $OutputDirectory = if ($StaticRuntime) {
        "artifacts\tools\rmlui$staticSuffix"
    } else {
        "artifacts\tools\rmlui"
    }
}
if (-not $FreetypeRoot) {
    $installedRoot = if ($env:BBLITE_VCPKG_INSTALLED_ROOT) {
        $env:BBLITE_VCPKG_INSTALLED_ROOT
    } else {
        Join-Path $root "artifacts\vcpkg-installed"
    }
    if ($StaticRuntime) {
        # The headers decide the linkage, not the consumer: vcpkg's dynamic
        # freetype install patches public-macros.h to spell every FT_EXPORT
        # as __declspec(dllimport), so an archive compiled against the
        # development (x64-windows) headers references __imp_FT_* and can
        # never link into the static shipping executable. The static
        # artifact therefore compiles against a static-triplet install of
        # the same manifest, made once here and reused; the ui feature is
        # what brings freetype in.
        $staticRoot = Join-Path $installedRoot "shipping-static"
        $FreetypeRoot = Join-Path $staticRoot "x64-windows-static"
        $headers = Join-Path $FreetypeRoot "include\ft2build.h"
        $manifestMoved = (Test-Path $headers) -and (
            @("native\vcpkg.json", "native\vcpkg-configuration.json") |
                Where-Object {
                    (Get-Item (Join-Path $root $_)).LastWriteTimeUtc -gt
                        (Get-Item $headers).LastWriteTimeUtc
                }
        ).Count -gt 0
        $svgMissing = $rmlSvgEnabled -and -not (Test-Path (
            Join-Path $FreetypeRoot "share\lunasvg\lunasvgConfig.cmake"))
        if (-not (Test-Path $headers) -or $manifestMoved -or $svgMissing) {
            if (-not $Vcpkg -or -not (Test-Path $Vcpkg)) {
                throw "vcpkg was not found for the static FreeType install. Set VCPKG_ROOT (or pass -Vcpkg), or pass -FreetypeRoot at an x64-windows-static vcpkg install carrying freetype."
            }
            $vcpkgArguments = @(
                "install"
                "--x-manifest-root=$(Join-Path $root 'native')"
                "--x-install-root=$staticRoot"
                "--triplet=x64-windows-static"
                "--x-feature=ui"
            )
            if ($rmlSvgEnabled) { $vcpkgArguments += "--x-feature=ui-svg" }
            & $Vcpkg @vcpkgArguments
            if ($LASTEXITCODE -ne 0) {
                throw "vcpkg could not install the static-triplet manifest for the RmlUi static artifact."
            }
        }
    } else {
        $FreetypeRoot = Join-Path $installedRoot "development-full\x64-windows"
    }
}
if (-not (Test-Path (Join-Path $FreetypeRoot "include\ft2build.h"))) {
    throw "FreeType headers were not found at $FreetypeRoot. Run 'npm run dev:setup' (which installs the development vcpkg manifest), or pass -FreetypeRoot at a vcpkg-installed tree carrying freetype."
}
$lunaSvgConfig = Join-Path $FreetypeRoot "share\lunasvg\lunasvgConfig.cmake"
if ($rmlSvgEnabled -and -not (Test-Path $lunaSvgConfig)) {
    throw "LunaSVG was not found at $FreetypeRoot. Run 'npm run dev:setup' (the ui-svg manifest feature installs it), or pass -FreetypeRoot at a vcpkg-installed tree carrying freetype and lunasvg."
}
if ($StaticRuntime) {
    # vcpkg's port rewrites the `#elif` guarding the dllimport attribute to a
    # literal 1 (dynamic) or 0 (static); the static header still carries the
    # attribute, in the dead arm, so the test is the live arm.
    $macros = Join-Path $FreetypeRoot "include\freetype\config\public-macros.h"
    $macrosText = if (Test-Path $macros) { Get-Content $macros -Raw } else { "" }
    if ($macrosText -match '(?m)^#elif 1\s*$\s*#define FT_PUBLIC_FUNCTION_ATTRIBUTE\s+__declspec\( dllimport \)') {
        throw "FreeType headers at $FreetypeRoot spell FT_EXPORT as dllimport (a dynamic-triplet install); a static artifact compiled against them cannot link. Pass -FreetypeRoot at an x64-windows-static install."
    }
}
$pin = Get-Content (Join-Path $root "upstream\rmlui.json") -Raw |
    ConvertFrom-Json
$workspacePath = [System.IO.Path]::GetFullPath($Workspace, $root)
$source = Join-Path $workspacePath "rmlui"
$build = Join-Path $workspacePath "build"
$output = [System.IO.Path]::GetFullPath($OutputDirectory, $root)

if (-not $CMake) {
    $command = Get-Command cmake -ErrorAction SilentlyContinue
    if ($command) {
        $CMake = $command.Source
    }
}
if (-not $CMake -or -not (Test-Path $CMake)) {
    throw "CMake was not found. Set CMAKE_COMMAND or pass -CMake."
}

# The development artifact must be built with the same compiler the
# development scene builds select (clang-cl when Visual Studio ships it,
# MSVC otherwise): RmlUi is a header-inlining-heavy C++ static library,
# and an MSVC-built archive linked into clang-cl consumers crashed inside
# `Context::Render` on the heavier retained documents. The discovery and
# the PATH/INCLUDE/LIB composition mirror `discoverWindowsBuildTools`
# (src/development-tools.ts); keep the two in step. The -StaticRuntime
# shipping artifact stays on MSVC, the shipping compiler, whose consumers
# are MSVC-built too.
function Get-DevToolchain {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} `
        "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $null }
    $vsRoot = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
    if (-not $vsRoot) { return $null }
    $clang = Join-Path $vsRoot "VC\Tools\Llvm\x64\bin\clang-cl.exe"
    $ninja = Join-Path $vsRoot `
        "Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
    if (-not (Test-Path $clang) -or -not (Test-Path $ninja)) { return $null }
    $msvc = Get-ChildItem (Join-Path $vsRoot "VC\Tools\MSVC") -Directory |
        Sort-Object Name | Select-Object -Last 1
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10"
    $sdk = Get-ChildItem (Join-Path $sdkRoot "Include") -Directory |
        Sort-Object Name | Select-Object -Last 1
    if (-not $msvc -or -not $sdk) { return $null }
    [pscustomobject]@{
        Clang = $clang
        Ninja = $ninja
        Path = @(
            (Split-Path $clang),
            (Join-Path $msvc.FullName "bin\Hostx64\x64"),
            (Join-Path $sdkRoot "bin\$($sdk.Name)\x64"),
            (Split-Path $ninja)
        ) -join ";"
        Include = @(
            (Join-Path $msvc.FullName "include"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\ucrt"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\shared"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\um"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\winrt"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\cppwinrt")
        ) -join ";"
        Lib = @(
            (Join-Path $msvc.FullName "lib\x64"),
            (Join-Path $sdkRoot "Lib\$($sdk.Name)\ucrt\x64"),
            (Join-Path $sdkRoot "Lib\$($sdk.Name)\um\x64")
        ) -join ";"
    }
}

function Sync-PinnedCheckout([string]$path, [string]$repository, [string]$commit, [string]$label) {
    if (-not (Test-Path (Join-Path $path ".git"))) {
        git init $path
        git -C $path remote add origin $repository
        git -C $path config core.longpaths true
    }
    git -C $path fetch --depth 1 origin $commit
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to fetch pinned $label commit $commit."
    }
    git -C $path checkout --force --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to check out pinned $label commit $commit."
    }
}

New-Item -ItemType Directory -Path $workspacePath, $output -Force | Out-Null
Sync-PinnedCheckout $source $pin.repository $pin.commit "RmlUi"

# The same maintained patch-application script the former FetchContent
# configure ran: applies each pinned patch, or verifies it is already
# present, and fails on anything else. docs/ui.md states what each patch
# corrects and the measurement behind it.
foreach ($patch in @(
    "rmlui-premultiplied-rounding.patch",
    "rmlui-css-box-model.patch",
    "rmlui-fractional-letter-spacing.patch"
)) {
    & $CMake `
        "-DRMLUI_SOURCE_DIR=$source" `
        "-DRMLUI_PATCH=$(Join-Path $root "native\patches\$patch")" `
        -P (Join-Path $root "native\apply-rmlui-patch.cmake")
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to apply the pinned RmlUi patch $patch."
    }
}

$configureArguments = @(
    "-S", $source,
    "-B", $build,
    # CMAKE_PREFIX_PATH does not override FindFreetype's cached headers or
    # package directories. Rediscover them when switching dependency roots;
    # otherwise a static artifact can still compile against DLL headers.
    "-U", "FREETYPE_*",
    "-U", "lunasvg_DIR",
    "-U", "plutovg_DIR",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_INSTALL_PREFIX=$output",
    "-DCMAKE_PREFIX_PATH=$FreetypeRoot",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DRMLUI_SAMPLES=OFF",
    "-DRMLUI_LUA_BINDINGS=OFF",
    "-DRMLUI_SVG_PLUGIN=$rmlSvgSetting",
    "-DRMLUI_PRECOMPILED_HEADERS=OFF",
    "-DRMLUI_COMPILER_OPTIONS=OFF",
    # Static archives carry no runtime dependencies; leave the empty
    # runtime-dependency set out of the install entirely.
    "-DRMLUI_INSTALL_RUNTIME_DEPENDENCIES=OFF"
)
if ($StaticRuntime) {
    $configureArguments += @(
        '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>',
        '-DCMAKE_CXX_FLAGS_RELEASE=/O1 /Ob1 /DNDEBUG /Gw /GL',
        '-DCMAKE_C_FLAGS_RELEASE=/O1 /Ob1 /DNDEBUG /Gw /GL'
    )
}
$devToolchain = if ($StaticRuntime) { $null } else { Get-DevToolchain }
$intendedGenerator = if ($devToolchain) { "Ninja" } else { "" }
if ($devToolchain) {
    $env:PATH = "$($devToolchain.Path);$env:PATH"
    $env:INCLUDE = $devToolchain.Include
    $env:LIB = $devToolchain.Lib
    $configureArguments += @(
        "-G", "Ninja",
        "-DCMAKE_MAKE_PROGRAM=$($devToolchain.Ninja)",
        "-DCMAKE_C_COMPILER=$($devToolchain.Clang)",
        "-DCMAKE_CXX_COMPILER=$($devToolchain.Clang)"
    )
}
# CMake refuses a generator change over an existing cache; a build tree
# configured before this selection existed (or after a toolchain change)
# is disposable, so replace it rather than failing the configure.
$cachePath = Join-Path $build "CMakeCache.txt"
if (Test-Path $cachePath) {
    $cachedGenerator = (Select-String -Path $cachePath `
        -Pattern '^CMAKE_GENERATOR:INTERNAL=(.*)$').Matches.Groups[1].Value
    $generatorMatches = if ($intendedGenerator) {
        $cachedGenerator -eq $intendedGenerator
    } else {
        $cachedGenerator -ne "Ninja"
    }
    if (-not $generatorMatches) {
        Remove-Item -Recurse -Force $build
    }
}
& $CMake @configureArguments
if ($LASTEXITCODE -ne 0) {
    throw "RmlUi CMake configuration failed."
}

& $CMake --build $build --config Release --parallel
if ($LASTEXITCODE -ne 0) {
    throw "RmlUi build failed."
}

# Installs the headers, the static rmlui/rmlui_debugger archives, and the
# package config (lib/cmake/RmlUi) that native/CMakeLists.txt consumes
# through find_package at BBLITE_RMLUI_DIR.
& $CMake --install $build --config Release
if ($LASTEXITCODE -ne 0) {
    throw "RmlUi install failed."
}

$backendsOut = Join-Path $output "Backends"
New-Item -ItemType Directory -Path $backendsOut -Force | Out-Null
foreach ($platformFile in @(
    "RmlUi_Platform_SDL.cpp",
    "RmlUi_Platform_SDL.h"
)) {
    Copy-Item -Force (Join-Path $source "Backends\$platformFile") $backendsOut
}
# Both PALs include the SDL_GPU renderer backend's precompiled shader
# header from the Backends tree; carry that directory with the pair.
Copy-Item -Recurse -Force (Join-Path $source "Backends\RmlUi_SDL_GPU") `
    (Join-Path $backendsOut "RmlUi_SDL_GPU")
Copy-Item -Force (Join-Path $source "LICENSE.txt") (Join-Path $output "RmlUi-LICENSE.txt")

$staticRuntimeSetting = if ($StaticRuntime) { "ON" } else { "OFF" }
"set(BBLITE_RMLUI_STATIC_RUNTIME $staticRuntimeSetting)`n" |
    Set-Content (Join-Path $output "bblite-rmlui-features.cmake") -Encoding Ascii

Write-Host "RmlUi installed to $output (commit $($pin.commit))."
