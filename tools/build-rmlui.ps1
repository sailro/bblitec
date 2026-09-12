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
#   * **Static core only.** Static libraries, no samples, no Lua bindings,
#     no precompiled headers, no RmlUi-injected compiler flags.
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
#
# The artifact records what it was built from -- the pinned commit and
# every patch with its SHA-256 -- in bblite-rmlui-features.cmake, and
# native/CMakeLists.txt refuses an artifact whose record differs from the
# current pin and patch directory: a stale artifact would ship UI
# behaviour the development validation never saw.

param(
    [string]$Workspace = "",
    [string]$OutputDirectory = "",
    [string]$FreetypeRoot = "",
    # Only the -StaticRuntime artifact needs vcpkg, to install the
    # static-triplet FreeType headers it compiles against (see below).
    [string]$Vcpkg = $(if ($env:VCPKG_ROOT) { Join-Path $env:VCPKG_ROOT "vcpkg.exe" } else { "" }),
    [switch]$StaticRuntime,
    [switch]$EnableSvg,
    [ValidateRange(0, 1024)][int]$Jobs = 0,
    [string]$CMake = $env:CMAKE_COMMAND
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force
$root = Get-RepositoryRoot
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
$workspacePath = Resolve-RepositoryPath $Workspace
$source = Join-Path $workspacePath "rmlui"
$build = Join-Path $workspacePath "build"
$output = Resolve-RepositoryPath $OutputDirectory
$CMake = Find-CMake $CMake

# The maintained patches are the files under native/patches, and the pin
# names the same set: a patch added to one place and not the other is a
# refusal here, not a silently different library. Name order is application
# order; background clipping extends the earlier box-model patch.
$patchDirectory = Join-Path $root "native\patches"
$patches = @(Get-ChildItem $patchDirectory -Filter "rmlui-*.patch" -File | Sort-Object Name)
if ($patches.Count -eq 0) {
    throw "No rmlui-*.patch files were found under $patchDirectory."
}
$pinnedPatches = @($pin.patches | Sort-Object)
$directoryPatches = @($patches | ForEach-Object { $_.Name })
if (($pinnedPatches -join ";") -ne ($directoryPatches -join ";")) {
    throw (
        "upstream/rmlui.json names the patches [$($pinnedPatches -join ', ')] " +
        "but native/patches holds [$($directoryPatches -join ', ')]; " +
        "bring the two in step before building."
    )
}

New-Item -ItemType Directory -Path $workspacePath, $output -Force | Out-Null
Sync-PinnedCheckout $source $pin.repository $pin.commit "RmlUi"

# The maintained patch-application script: applies each pinned patch, or
# verifies it is already present, and fails on anything else. docs/ui.md
# states what each patch corrects and the measurement behind it.
foreach ($patch in $patches) {
    & $CMake `
        "-DRMLUI_SOURCE_DIR=$source" `
        "-DRMLUI_PATCH=$($patch.FullName)" `
        -P (Join-Path $root "native\apply-rmlui-patch.cmake")
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to apply the pinned RmlUi patch $($patch.Name)."
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
# The development artifact is built with the compiler the development
# scene builds select (Get-DevToolchain, tools/bblite-tools.psm1); the
# -StaticRuntime shipping artifact stays on MSVC, the shipping compiler,
# whose consumers are MSVC-built too.
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
    $cachedGenerator = (Read-CMakeCache $cachePath)["CMAKE_GENERATOR"]
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

$buildArguments = @("--build", $build, "--config", "Release", "--parallel")
if ($Jobs) { $buildArguments += "$Jobs" }
& $CMake @buildArguments
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

# Native configuration reads this record and refuses the artifact when the
# pin or a patch moved since it was built. The patch set is "name=sha256"
# per file, in name order, as CMake recomputes it over native/patches.
$staticRuntimeSetting = if ($StaticRuntime) { "ON" } else { "OFF" }
$patchRecord = @(
    $patches | ForEach-Object {
        $digest = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$($_.Name)=$digest"
    }
) -join ";"
@(
    "set(BBLITE_RMLUI_STATIC_RUNTIME $staticRuntimeSetting)"
    "set(BBLITE_RMLUI_COMMIT `"$($pin.commit)`")"
    "set(BBLITE_RMLUI_PATCHES `"$patchRecord`")"
) -join "`n" |
    Set-Content (Join-Path $output "bblite-rmlui-features.cmake") -Encoding Ascii

Write-Host "RmlUi installed to $output (commit $($pin.commit), $($patches.Count) patches)."
