param(
    [string]$Workspace = ".cache\sdl",
    [string]$OutputDirectory = "artifacts\tools\sdl-min",
    [string]$CMake = $env:CMAKE_COMMAND
)

# Builds a subsystem-trimmed static SDL3 for minimal-size release
# packages. The version tracks the vcpkg-installed SDL3 so the trimmed
# library stays ABI-identical to the one SDL3_image was compiled
# against. The engine initializes only SDL_INIT_VIDEO|SDL_INIT_EVENTS
# (native/src/pal_sdl.cpp) and renders through SDL_GPU (D3D12) with an
# SDL_Renderer CPU fallback, so audio, joystick, haptic, HIDAPI,
# sensor, camera, power, dialog, misc, locale, the GL/Vulkan plumbing,
# and the SDL_Renderer core are compiled out entirely. Pair with
# BBLITE_CPU_FALLBACK=OFF: without SDL_RENDER the engine's
# SDL_Renderer CPU fallback cannot link.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

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
    -DSDL_AUDIO=OFF `
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

@{
    repository = $repository
    tag = $tag
    version = $sdlVersion
    variant = "static, MinSizeRel, static CRT, video+events+render+gpu only"
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built minimal SDL $sdlVersion into $output."
