param(
    [string]$Workspace = "",
    [string]$OutputDirectory = "",
    [switch]$EnableAudio,
    [string]$CMake = $env:CMAKE_COMMAND
)

# Builds a subsystem-trimmed static SDL3 for minimal-size release
# packages. The version tracks the vcpkg-installed SDL3 so the trimmed
# library stays ABI-identical to the one SDL3_image was compiled
# against. The engine initializes only SDL_INIT_VIDEO|SDL_INIT_EVENTS
# and renders through SDL_GPU (D3D12), so joystick, haptic,
# HIDAPI, sensor, camera, power, dialog, misc, locale, the GL/Vulkan
# plumbing, and the SDL_Renderer core are compiled out entirely.
# SDL_RENDER is one of them: bblitec requires a GPU and has no software
# renderer to link it for. Audio stays off by default; EnableAudio creates a
# separate feature-compatible install for generated scenes that reach it.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not $Workspace) {
    $Workspace = if ($EnableAudio) { ".cache\sdl-audio" } else { ".cache\sdl" }
}
if (-not $OutputDirectory) {
    $OutputDirectory = if ($EnableAudio) {
        "artifacts\tools\sdl-min-audio"
    } else {
        "artifacts\tools\sdl-min"
    }
}
$audioSetting = if ($EnableAudio) { "ON" } else { "OFF" }

# Keep in lockstep with the vcpkg baseline's sdl3 version
# (native/vcpkg.json builtin-baseline).
$sdlVersion = "3.4.14"
$repository = "https://github.com/libsdl-org/SDL.git"
$tag = "release-$sdlVersion"

$workspacePath = if ([System.IO.Path]::IsPathRooted($Workspace)) {
    $Workspace
} else {
    Join-Path $root $Workspace
}
$source = Join-Path $workspacePath "source"
$build = Join-Path $workspacePath "build-min"
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

New-Item -ItemType Directory -Path $workspacePath, $output -Force |
    Out-Null
if (-not (Test-Path (Join-Path $source ".git"))) {
    git clone --depth 1 --branch $tag $repository $source
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to clone SDL $tag."
    }
} else {
    $current = git -C $source describe --tags --exact-match 2>$null
    if ($current -ne $tag) {
        git -C $source fetch --depth 1 origin "refs/tags/${tag}:refs/tags/$tag"
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to fetch SDL tag $tag."
        }
        git -C $source checkout --force --detach $tag
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to check out SDL tag $tag."
        }
    }
}

# The project patches the vcpkg overlay port applies
# (native/vcpkg-overlay-ports/sdl3/portfile.cmake). Stock release-3.4.14
# does not carry them, and a minimal build without them would diverge
# from the vcpkg-installed SDL3 the parity numbers were measured against
# (the multisample-read view and the D3D12 MultisampleEnable line rule).
# The overlay's third patch, fix-freebsd.patch, only rewires the FreeBSD
# pkgconfig install path — vcpkg packaging infrastructure with no effect
# on this Windows build — so it is deliberately not applied here.
# Idempotent: a patch that already sits in the working tree (a re-run on
# a warm workspace) reverse-applies cleanly and is skipped; anything
# else fails loudly rather than building unpatched sources.
$patchNames = @(
    "sdl-multisample-read.patch",
    "d3d12-multisample-lines.patch"
)
foreach ($patchName in $patchNames) {
    $patch = Join-Path $root "native\vcpkg-overlay-ports\sdl3\$patchName"
    if (-not (Test-Path $patch)) {
        throw "SDL patch not found: $patch"
    }
    git -C $source apply --check $patch 2>$null
    if ($LASTEXITCODE -eq 0) {
        git -C $source apply $patch
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to apply SDL patch $patchName."
        }
        Write-Output "Applied SDL patch $patchName."
    } else {
        git -C $source apply --check --reverse $patch 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw (
                "SDL patch $patchName neither applies to $source nor is " +
                "already applied. Delete the workspace and rerun."
            )
        }
        Write-Output "SDL patch $patchName is already applied."
    }
}

& $CMake -S $source -B $build `
    -DCMAKE_BUILD_TYPE=MinSizeRel `
    "-DCMAKE_INSTALL_PREFIX=$output" `
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>' `
    '-DCMAKE_CXX_FLAGS_MINSIZEREL=/O1 /Ob1 /DNDEBUG /Gw /Zc:inline' `
    '-DCMAKE_C_FLAGS_MINSIZEREL=/O1 /Ob1 /DNDEBUG /Gw' `
    -DSDL_SHARED=OFF `
    -DSDL_STATIC=ON `
    -DSDL_TEST_LIBRARY=OFF `
    -DSDL_EXAMPLES=OFF `
    -DSDL_AUDIO=$audioSetting `
    -DSDL_JOYSTICK=OFF `
    -DSDL_HAPTIC=OFF `
    -DSDL_HIDAPI=OFF `
    -DSDL_SENSOR=OFF `
    -DSDL_CAMERA=OFF `
    -DSDL_POWER=OFF `
    -DSDL_DIALOG=OFF `
    -DSDL_MISC=OFF `
    -DSDL_LOCALE=OFF `
    -DSDL_OPENGL=OFF `
    -DSDL_OPENGLES=OFF `
    -DSDL_VULKAN=OFF `
    -DSDL_RENDER_GPU=OFF `
    -DSDL_GPU=ON `
    -DSDL_RENDER=OFF `
    -DSDL_VIDEO=ON
if ($LASTEXITCODE -ne 0) {
    throw "SDL minimal CMake configuration failed."
}

& $CMake --build $build --config MinSizeRel --parallel
if ($LASTEXITCODE -ne 0) {
    throw "SDL minimal build failed."
}

& $CMake --install $build --config MinSizeRel
if ($LASTEXITCODE -ne 0) {
    throw "SDL minimal install failed."
}

Copy-Item (Join-Path $source "LICENSE.txt") (Join-Path $output "LICENSE.txt") -Force

# Native configuration reads this before project() to reject a generated
# scene whose reached feature set is incompatible with the selected trimmed
# dependency. Keep the capability machine-readable rather than inferring it
# from an install-directory name or from a prose provenance field.
"set(BBLITE_SDL_AUDIO $audioSetting)`n" |
    Set-Content (Join-Path $output "bblite-sdl-features.cmake") -Encoding Ascii

@{
    repository = $repository
    tag = $tag
    version = $sdlVersion
    patches = $patchNames
    variant = if ($EnableAudio) {
        "static, MinSizeRel, static CRT, video+events+audio+gpu only"
    } else {
        "static, MinSizeRel, static CRT, video+events+gpu only"
    }
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built minimal SDL $sdlVersion into $output."
