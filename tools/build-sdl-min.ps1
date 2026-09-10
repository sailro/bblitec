param(
    [string]$Workspace = "",
    [string]$OutputDirectory = "",
    [switch]$EnableAudio,
    [switch]$EnableGamepad,
    [string]$CMake = $env:CMAKE_COMMAND
)

# Builds a subsystem-trimmed static SDL3 for minimal-size release
# packages. The version tracks the vcpkg-installed SDL3 so the trimmed
# library stays ABI-identical to the one SDL3_image was compiled
# against. The engine initializes only SDL_INIT_VIDEO|SDL_INIT_EVENTS
# and renders through SDL_GPU (D3D12), so joystick, haptic,
# HIDAPI, sensor, camera, power, misc, locale, the GL/Vulkan
# plumbing, and the SDL_Renderer core are compiled out entirely.
# SDL's portable dialog subsystem remains available for browser:file scenes;
# static dead stripping removes it from executables that do not reach the PAL.
# SDL_RENDER is one of them: bblitec requires a GPU and has no software
# renderer to link it for. Audio stays off by default; EnableAudio creates a
# separate feature-compatible install for generated scenes that reach it,
# and EnableGamepad likewise keeps joystick and HIDAPI for input:gamepad.

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force
$root = Get-RepositoryRoot
$enabledFeatures = @(
    if ($EnableAudio) { "audio" }
    if ($EnableGamepad) { "gamepad" }
)
# Preserves the established sdl-min-audio and sdl-min-gamepad directory names.
$featureSuffix = if ($enabledFeatures.Count -gt 0) {
    "-" + ($enabledFeatures -join "-")
} else {
    ""
}

if (-not $Workspace) {
    $Workspace = ".cache\sdl$featureSuffix"
}
if (-not $OutputDirectory) {
    $OutputDirectory = "artifacts\tools\sdl-min$featureSuffix"
}
$audioSetting = if ($EnableAudio) { "ON" } else { "OFF" }
$gamepadSetting = if ($EnableGamepad) { "ON" } else { "OFF" }
$variantFeatures = @("video", "events", "dialogs") + $enabledFeatures + @("gpu")

# Keep in lockstep with the vcpkg baseline's sdl3 version
# (native/vcpkg.json builtin-baseline).
$sdlVersion = "3.4.14"
$repository = "https://github.com/libsdl-org/SDL.git"
$tag = "release-$sdlVersion"

$workspacePath = Resolve-RepositoryPath $Workspace
$source = Join-Path $workspacePath "source"
$build = Join-Path $workspacePath "build-min"
$output = Resolve-RepositoryPath $OutputDirectory
$CMake = Find-CMake $CMake

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
# (multisample reads, line rasterization and descriptor heap rollover).
# The overlay's fix-freebsd.patch only rewires the FreeBSD
# pkgconfig install path — vcpkg packaging infrastructure with no effect
# on this Windows build — so it is deliberately not applied here.
# Idempotent: a patch that already sits in the working tree (a re-run on
# a warm workspace) reverse-applies cleanly and is skipped; anything
# else fails loudly rather than building unpatched sources.
# The static-no-dynapi patch is this build's own, kept beside the other script-only
# patch under tools/patches rather than in the overlay port (whose whole
# directory keys the development vcpkg install); its header says why the
# static shipping SDL turns the dynamic API off, and docs/development.md
# carries what it measured.
$patches = @(
    (Join-Path $root "native\vcpkg-overlay-ports\sdl3\sdl-multisample-read.patch"),
    (Join-Path $root "native\vcpkg-overlay-ports\sdl3\d3d12-multisample-lines.patch"),
    (Join-Path $root "native\vcpkg-overlay-ports\sdl3\d3d12-descriptor-heaps.patch"),
    (Join-Path $root "tools\patches\sdl-static-no-dynapi.patch")
)
foreach ($patch in $patches) {
    $patchName = Split-Path -Leaf $patch
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

# One table drives the configure and the check after it: every entry is
# passed as "-D<name>=<value>" and read back from the cache CMake wrote,
# so an option that reached CMake as PowerShell text instead of its value
# is refused before anything is compiled -- CMake's if() treats any
# non-false string as true, which would silently keep the subsystem.
$sdlOptions = [ordered]@{
    SDL_SHARED = "OFF"
    SDL_STATIC = "ON"
    SDL_TEST_LIBRARY = "OFF"
    SDL_EXAMPLES = "OFF"
    SDL_AUDIO = $audioSetting
    SDL_JOYSTICK = $gamepadSetting
    SDL_HAPTIC = "OFF"
    SDL_HIDAPI = $gamepadSetting
    SDL_SENSOR = "OFF"
    SDL_CAMERA = "OFF"
    SDL_POWER = "OFF"
    SDL_DIALOG = "ON"
    SDL_MISC = "OFF"
    SDL_LOCALE = "OFF"
    SDL_OPENGL = "OFF"
    SDL_OPENGLES = "OFF"
    SDL_VULKAN = "OFF"
    SDL_RENDER_GPU = "OFF"
    SDL_GPU = "ON"
    SDL_RENDER = "OFF"
    SDL_VIDEO = "ON"
}
$configureArguments = @(
    "-S", $source,
    "-B", $build,
    "-DCMAKE_BUILD_TYPE=MinSizeRel",
    "-DCMAKE_INSTALL_PREFIX=$output",
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>',
    '-DCMAKE_CXX_FLAGS_MINSIZEREL=/O1 /Ob1 /DNDEBUG /Gw /Zc:inline',
    '-DCMAKE_C_FLAGS_MINSIZEREL=/O1 /Ob1 /DNDEBUG /Gw'
)
foreach ($option in $sdlOptions.GetEnumerator()) {
    $configureArguments += "-D$($option.Key)=$($option.Value)"
}
& $CMake @configureArguments
if ($LASTEXITCODE -ne 0) {
    throw "SDL minimal CMake configuration failed."
}

$cache = Read-CMakeCache (Join-Path $build "CMakeCache.txt")
foreach ($option in $sdlOptions.GetEnumerator()) {
    $actual = $cache[$option.Key]
    if ($actual -ne $option.Value) {
        throw (
            "The SDL cache records $($option.Key)=$actual where " +
            "$($option.Value) was requested; the option did not reach " +
            "CMake as a value. Refusing to build a mis-trimmed SDL."
        )
    }
}
$unexpanded = @(
    $cache.GetEnumerator() |
        Where-Object { $_.Key -like "SDL_*" -and $_.Value.Contains('$') }
)
if ($unexpanded.Count -gt 0) {
    $listing = ($unexpanded | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ", "
    throw "SDL cache entries hold unexpanded script text: $listing"
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
@(
    "set(BBLITE_SDL_AUDIO $audioSetting)"
    "set(BBLITE_SDL_GAMEPAD $gamepadSetting)"
    "set(BBLITE_SDL_DIALOG ON)"
) -join "`n" |
    Set-Content (Join-Path $output "bblite-sdl-features.cmake") -Encoding Ascii

@{
    repository = $repository
    tag = $tag
    version = $sdlVersion
    patches = @($patches | ForEach-Object { Split-Path -Leaf $_ })
    variant = "static, MinSizeRel, static CRT, $($variantFeatures -join '+') only"
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built minimal SDL $sdlVersion into $output."
