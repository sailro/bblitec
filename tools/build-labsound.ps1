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
    [ValidateSet('', 'arm64-v8a', 'x86_64')][string]$AndroidAbi = '',
    [string]$AndroidNdk = $env:ANDROID_NDK_HOME,
    [ValidateSet('', 'x86_64', 'arm64')][string]$MacArchitecture = '',
    [ValidateSet('', 'iphoneos', 'iphonesimulator')][string]$IosSdk = '',
    [ValidateSet('', 'x86_64', 'arm64')][string]$IosArchitecture = '',
    [switch]$StaticRuntime,
    [switch]$MinSize,
    [switch]$CoreOnly,
    [switch]$EnableCodecs,
    [ValidateRange(0, 1024)][int]$Jobs = 0,
    [string]$CMake = $env:CMAKE_COMMAND
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force
$root = Get-RepositoryRoot
if ($AndroidAbi -and ($StaticRuntime -or $MinSize -or $MacArchitecture)) { throw 'Android cannot be combined with desktop target options.' }
if ($IosSdk) {
    if ($AndroidAbi -or $MacArchitecture -or $StaticRuntime) { throw 'iOS cannot be combined with desktop/Android target options.' }
    if (-not $IosArchitecture) { throw 'iOS requires -IosArchitecture.' }
    $iosArguments = @(Get-IosCompilerArguments $IosSdk $IosArchitecture)
} elseif ($IosArchitecture) { throw '-IosArchitecture requires -IosSdk.' }
if ($StaticRuntime -and -not $IsWindows) { throw "-StaticRuntime selects the Windows shipping CRT." }
if ($MinSize -and -not $IsLinux -and -not $IsMacOS) { throw "-MinSize selects Unix shipping; use -StaticRuntime on Windows." }
$minimalBuild = $StaticRuntime -or $MinSize
if (-not $Workspace) {
    $Workspace = if ($minimalBuild) {
        if ($EnableCodecs) {
            ".cache\labsound-static-codecs"
        } else {
            ".cache\labsound-static"
        }
    } else {
        ".cache\labsound"
    }
    if ($MacArchitecture) { $Workspace += "-$MacArchitecture" }
    if ($AndroidAbi) { $Workspace += "-android-$AndroidAbi" }
    if ($IosSdk) { $Workspace += "-ios-$IosSdk-$IosArchitecture" }
}
if (-not $OutputDirectory) {
    $OutputDirectory = if ($minimalBuild) {
        if ($EnableCodecs) {
            "artifacts\tools\labsound-static-codecs"
        } else {
            "artifacts\tools\labsound-static"
        }
    } else {
        "artifacts\tools\labsound"
    }
    if ($MacArchitecture) { $OutputDirectory += "-$MacArchitecture" }
    if ($AndroidAbi) { $OutputDirectory += "-android-$AndroidAbi" }
    if ($IosSdk) { $OutputDirectory += "-ios-$IosSdk-$IosArchitecture" }
}
if ($CoreOnly -and $EnableCodecs) {
    throw "-CoreOnly and -EnableCodecs are mutually exclusive."
}
$pin = Get-Content (Join-Path $root "upstream\labsound.json") -Raw |
    ConvertFrom-Json
$workspacePath = Resolve-RepositoryPath $Workspace
$source = Join-Path $workspacePath "labsound"
$nyquist = Join-Path $workspacePath "libnyquist"
$build = Join-Path $workspacePath "build"
$output = Resolve-RepositoryPath $OutputDirectory
$CMake = Find-CMake $CMake

New-Item -ItemType Directory -Path $workspacePath, $output -Force | Out-Null
Sync-PinnedCheckout $source $pin.repository $pin.commit "LabSound"
Sync-PinnedCheckout `
    $nyquist `
    $pin.dependencies.libnyquist.repository `
    $pin.dependencies.libnyquist.commit `
    "libnyquist"

$coreOnlyBuild = $CoreOnly -or ($minimalBuild -and -not $EnableCodecs)
$patches = Get-MaintainedPatches labsound @(if ($coreOnlyBuild) { "core-only" })
Install-MaintainedPatches $source $patches "LabSound"

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
if ($coreOnlyBuild -and -not $minimalBuild) {
    $configureArguments += if ($IsWindows -and -not $AndroidAbi) {
        '-DCMAKE_CXX_FLAGS_RELEASE=/O2 /DNDEBUG /DLABSOUND_CORE_ONLY'
    } else {
        '-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG -DLABSOUND_CORE_ONLY'
    }
}
if ($MinSize -and -not $IsWindows) {
    $cppFlags = '-Os -DNDEBUG -ffunction-sections -fdata-sections'
    if ($coreOnlyBuild) { $cppFlags += ' -DLABSOUND_CORE_ONLY' }
    $configureArguments += @("-DCMAKE_CXX_FLAGS_RELEASE=$cppFlags",
        '-DCMAKE_C_FLAGS_RELEASE=-Os -DNDEBUG -ffunction-sections -fdata-sections')
}
$configureArguments += if ($AndroidAbi) { @(Get-AndroidCompilerArguments $AndroidAbi $AndroidNdk) } elseif ($IosSdk) { $iosArguments } else { @(Get-PosixCompilerArguments $MacArchitecture) }
& $CMake @configureArguments
if ($LASTEXITCODE -ne 0) {
    throw "LabSound CMake configuration failed."
}

# The core target alone: the bundled backends are replaced by the SDL3
# device in this project's own PAL.
$parallelArguments = Get-BuildParallelArguments $Jobs
& $CMake --build $build --target LabSound --config Release @parallelArguments
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

$labSoundName = if ($IsWindows -and -not $AndroidAbi) { "LabSound.lib" } else { "libLabSound.a" }
$nyquistName = if ($IsWindows -and -not $AndroidAbi) { "libnyquist.lib" } else { "liblibnyquist.a" }
$labSoundLib = Resolve-BuiltLibrary @(
    (Join-Path $build "bin/$labSoundName"),
    (Join-Path $build "bin/Release/$labSoundName")
    if ($IsMacOS) { Join-Path $build "bin/LabSound.framework/Versions/A/LabSound" }
    if ($IosSdk) { Join-Path $build "bin/LabSound.framework/LabSound" }
) "LabSound"
$libraries = @{ $labSoundName = $labSoundLib }
if (-not $coreOnlyBuild) {
    $nyquistLib = Resolve-BuiltLibrary @(
        (Join-Path $build "_deps/libnyquist-build/lib/$nyquistName"),
        (Join-Path $build "_deps/libnyquist-build/lib/Release/$nyquistName")
    ) "libnyquist"
    $libraries[$nyquistName] = $nyquistLib
}

$includeOut = Join-Path $output "include"
$libOut = Join-Path $output "lib"
New-Item -ItemType Directory -Path $includeOut, $libOut -Force | Out-Null
Copy-Item -Recurse -Force (Join-Path $source "include\LabSound") $includeOut
foreach ($name in $libraries.Keys) {
    Copy-Item -Force $libraries[$name] (Join-Path $libOut $name)
}
Copy-Item -Force (Join-Path $source "LICENSE") (Join-Path $output "LabSound-LICENSE.txt")
Copy-Item -Force (Join-Path $source "COPYING") (Join-Path $output "LabSound-COPYING.txt")
if ($coreOnlyBuild) {
    foreach ($obsolete in @(
        (Join-Path $libOut $nyquistName),
        (Join-Path $output "libnyquist-LICENSE.txt"),
        (Join-Path $output "libnyquist-COPYING.txt")
    )) {
        Remove-Item -LiteralPath $obsolete -Force -ErrorAction SilentlyContinue
    }
} else {
    Copy-Item -LiteralPath (Join-Path $nyquist "include\libnyquist") -Destination $includeOut -Recurse -Force
    Copy-Item -Force (Join-Path $nyquist "LICENSE") (Join-Path $output "libnyquist-LICENSE.txt")
    Copy-Item -Force (Join-Path $nyquist "COPYING") (Join-Path $output "libnyquist-COPYING.txt")
}

$minSizeSetting = if ($minimalBuild) { "ON" } else { "OFF" }
$staticRuntimeSetting = if ($StaticRuntime) { "ON" } else { "OFF" }
$coreOnlySetting = if ($coreOnlyBuild) { "ON" } else { "OFF" }
# Native configuration and development setup compare the patch record with the
# pin and the manifest (native/patches/patch-identity.cmake).
$record = @(
    "set(BBLITE_LABSOUND_STATIC_RUNTIME $staticRuntimeSetting)"
    "set(BBLITE_LABSOUND_MINSIZE $minSizeSetting)"
    "set(BBLITE_LABSOUND_CORE_ONLY $coreOnlySetting)"
) + @(Get-PatchRecord labsound $pin.commit $patches)
$record -join "`n" | Set-Content (Join-Path $output "bblite-labsound-features.cmake") -Encoding Ascii

Write-Host "LabSound installed to $output (commit $($pin.commit))."
