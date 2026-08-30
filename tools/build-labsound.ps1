# Builds the pinned LabSound into artifacts/tools/labsound.
#
# Same shape as build-tint.ps1 and build-dawn.ps1, and for the same
# reason: LabSound is not in the vcpkg registry, so the pin lives in
# upstream/labsound.json and the library is built once from it.
#
# Two deliberate departures from LabSound's own default build:
#
#   * **No audio backend is linked.** LabSound ships RtAudio, miniaudio
#     and a mock backend, and every one of them is a second platform
#     dependency. `lab::AudioDevice` is public, so this project's device
#     is SDL3 (native/src/pal_audio_sdl_device.hpp) and the bundled
#     backends never enter the installed library. Only `LabSound` is built.
#     `-CoreOnly` (implied by `-StaticRuntime`) also disables LabSound's global
#     all-node registry, HRTF file loader, and debug encoder; direct reached
#     node constructors remain available without pulling codecs or unrelated
#     DSP into the application.
#   * **libnyquist is pinned by path.** LabSound fetches it at
#     `GIT_TAG master`, which is not reproducible; the pin file records
#     the commit the validated build resolved to and this script checks
#     that revision out itself, then hands it over with
#     `-DLIBNYQUIST_SOURCE_DIR`.

param(
    [string]$Workspace = "",
    [string]$OutputDirectory = "",
    [switch]$StaticRuntime,
    [switch]$CoreOnly,
    [switch]$EnableCodecs,
    [string]$CMake = $env:CMAKE_COMMAND
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $Workspace) {
    $Workspace = if ($StaticRuntime) {
        if ($EnableCodecs) {
            ".cache\labsound-static-codecs"
        } else {
            ".cache\labsound-static"
        }
    } else {
        ".cache\labsound"
    }
}
if (-not $OutputDirectory) {
    $OutputDirectory = if ($StaticRuntime) {
        if ($EnableCodecs) {
            "artifacts\tools\labsound-static-codecs"
        } else {
            "artifacts\tools\labsound-static"
        }
    } else {
        "artifacts\tools\labsound"
    }
}
if ($CoreOnly -and $EnableCodecs) {
    throw "-CoreOnly and -EnableCodecs are mutually exclusive."
}
$pin = Get-Content (Join-Path $root "upstream\labsound.json") -Raw |
    ConvertFrom-Json
$workspacePath = Join-Path $root $Workspace
$source = Join-Path $workspacePath "labsound"
$nyquist = Join-Path $workspacePath "libnyquist"
$build = Join-Path $workspacePath "build"
$output = Join-Path $root $OutputDirectory

if (-not $CMake) {
    $command = Get-Command cmake -ErrorAction SilentlyContinue
    if ($command) {
        $CMake = $command.Source
    }
}
if (-not $CMake -or -not (Test-Path $CMake)) {
    throw "CMake was not found. Set CMAKE_COMMAND or pass -CMake."
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
Sync-PinnedCheckout $source $pin.repository $pin.commit "LabSound"
Sync-PinnedCheckout `
    $nyquist `
    $pin.dependencies.libnyquist.repository `
    $pin.dependencies.libnyquist.commit `
    "libnyquist"

$coreOnlyBuild = $CoreOnly -or ($StaticRuntime -and -not $EnableCodecs)
if ($coreOnlyBuild) {
    $corePatch = Join-Path $root "tools\patches\labsound-core-only.patch"
    git -C $source apply --check $corePatch
    if ($LASTEXITCODE -ne 0) {
        throw "The maintained LabSound core-only patch no longer applies to the pin."
    }
    git -C $source apply $corePatch
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to apply the maintained LabSound core-only patch."
    }
}

$configureArguments = @(
    "-S", $source,
    "-B", $build,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DLIBNYQUIST_SOURCE_DIR=$nyquist",
    "-DLIBNYQUIST_BUILD_EXAMPLE=OFF"
)
if ($StaticRuntime) {
    $cppFlags = '/O1 /Ob1 /DNDEBUG /Gw /GL'
    if ($coreOnlyBuild) {
        $cppFlags += ' /DLABSOUND_CORE_ONLY'
    }
    $configureArguments += @(
        '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>',
        "-DCMAKE_CXX_FLAGS_RELEASE=$cppFlags",
        '-DCMAKE_C_FLAGS_RELEASE=/O1 /Ob1 /DNDEBUG /Gw /GL'
    )
}
if ($coreOnlyBuild -and -not $StaticRuntime) {
    $configureArguments += '-DCMAKE_CXX_FLAGS_RELEASE=/O2 /DNDEBUG /DLABSOUND_CORE_ONLY'
}
& $CMake @configureArguments
if ($LASTEXITCODE -ne 0) {
    throw "LabSound CMake configuration failed."
}

# The core target alone: the bundled backends are replaced by the SDL3
# device in this project's own PAL.
& $CMake --build $build --target LabSound --config Release --parallel
if ($LASTEXITCODE -ne 0) {
    throw "LabSound build failed."
}

# Ninja puts the archives directly in the output directory; a
# multi-config Visual Studio generator puts them under the configuration.
# Same fork build-tint.ps1 takes for its executable.
function Resolve-BuiltLibrary([string[]]$candidates, [string]$label) {
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $found) {
        throw "The $label library was not found after a successful build. Looked in: $($candidates -join ', ')"
    }
    return $found
}

$labSoundLib = Resolve-BuiltLibrary @(
    (Join-Path $build "bin\LabSound.lib"),
    (Join-Path $build "bin\Release\LabSound.lib")
) "LabSound"
$libraries = @($labSoundLib)
if (-not $coreOnlyBuild) {
    $nyquistLib = Resolve-BuiltLibrary @(
        (Join-Path $build "_deps\libnyquist-build\lib\libnyquist.lib"),
        (Join-Path $build "_deps\libnyquist-build\lib\Release\libnyquist.lib")
    ) "libnyquist"
    $libraries += $nyquistLib
}

$includeOut = Join-Path $output "include"
$libOut = Join-Path $output "lib"
New-Item -ItemType Directory -Path $includeOut, $libOut -Force | Out-Null
Copy-Item -Recurse -Force (Join-Path $source "include\LabSound") $includeOut
foreach ($library in $libraries) {
    Copy-Item -Force $library $libOut
}
Copy-Item -Force (Join-Path $source "LICENSE") (Join-Path $output "LabSound-LICENSE.txt")
Copy-Item -Force (Join-Path $source "COPYING") (Join-Path $output "LabSound-COPYING.txt")
if ($coreOnlyBuild) {
    foreach ($obsolete in @(
        (Join-Path $libOut "libnyquist.lib"),
        (Join-Path $output "libnyquist-LICENSE.txt"),
        (Join-Path $output "libnyquist-COPYING.txt")
    )) {
        Remove-Item -LiteralPath $obsolete -Force -ErrorAction SilentlyContinue
    }
} else {
    Copy-Item -Force (Join-Path $nyquist "LICENSE") (Join-Path $output "libnyquist-LICENSE.txt")
    Copy-Item -Force (Join-Path $nyquist "COPYING") (Join-Path $output "libnyquist-COPYING.txt")
}

$staticRuntimeSetting = if ($StaticRuntime) { "ON" } else { "OFF" }
$coreOnlySetting = if ($coreOnlyBuild) { "ON" } else { "OFF" }
"set(BBLITE_LABSOUND_STATIC_RUNTIME $staticRuntimeSetting)`nset(BBLITE_LABSOUND_CORE_ONLY $coreOnlySetting)`n" |
    Set-Content (Join-Path $output "bblite-labsound-features.cmake") -Encoding Ascii

Write-Host "LabSound installed to $output (commit $($pin.commit))."
