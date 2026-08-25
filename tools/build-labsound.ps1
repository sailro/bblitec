# Builds the pinned LabSound into artifacts/tools/labsound.
#
# Same shape as build-tint.ps1 and build-dawn.ps1, and for the same
# reason: LabSound is not in the vcpkg registry, so the pin lives in
# upstream/labsound.json and the library is built once from it.
#
# Two deliberate departures from LabSound's own default build:
#
#   * **No audio backend is built.** LabSound ships RtAudio, miniaudio
#     and a mock backend, and every one of them is a second platform
#     dependency. `lab::AudioDevice` is public, so this project's device
#     is SDL3 (native/src/pal_audio_sdl_device.hpp) and the bundled
#     backends never compile. Only the `LabSound` core target is built.
#   * **libnyquist is pinned by path.** LabSound fetches it at
#     `GIT_TAG master`, which is not reproducible; the pin file records
#     the commit the validated build resolved to and this script checks
#     that revision out itself, then hands it over with
#     `-DLIBNYQUIST_SOURCE_DIR`.

param(
    [string]$Workspace = ".cache\labsound",
    [string]$OutputDirectory = "artifacts\tools\labsound",
    [string]$CMake = $env:CMAKE_COMMAND
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
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

& $CMake -S $source -B $build `
    -DCMAKE_BUILD_TYPE=Release `
    -DLIBNYQUIST_SOURCE_DIR="$nyquist" `
    -DLIBNYQUIST_BUILD_EXAMPLE=OFF
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
$nyquistLib = Resolve-BuiltLibrary @(
    (Join-Path $build "_deps\libnyquist-build\lib\libnyquist.lib"),
    (Join-Path $build "_deps\libnyquist-build\lib\Release\libnyquist.lib")
) "libnyquist"
$libraries = @($labSoundLib, $nyquistLib)

$includeOut = Join-Path $output "include"
$libOut = Join-Path $output "lib"
New-Item -ItemType Directory -Path $includeOut, $libOut -Force | Out-Null
Copy-Item -Recurse -Force (Join-Path $source "include\LabSound") $includeOut
foreach ($library in $libraries) {
    Copy-Item -Force $library $libOut
}
Copy-Item -Force (Join-Path $source "LICENSE") (Join-Path $output "LabSound-LICENSE.txt")
Copy-Item -Force (Join-Path $source "COPYING") (Join-Path $output "LabSound-COPYING.txt")

Write-Host "LabSound installed to $output (commit $($pin.commit))."
