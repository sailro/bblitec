param(
    [string]$Workspace = ".cache\sdl-multisample",
    [string]$OutputDirectory = "artifacts\tools\sdl-multisample",
    [string]$CMake = $env:CMAKE_COMMAND
)

# Builds the vcpkg-pinned SDL3 version from source with
# libsdl-org/SDL#15838 ("GPU: Allow multisample textures to be read")
# applied, so the SDL_GPU backend can bind the multisampled transmission
# colour target and run the pinned per-sample image-processing pass.
#
# Stock SDL rejects the texture outright:
#   "For multisample textures: usage cannot contain SAMPLER or STORAGE flags"
# The patch relaxes that rule to COMPUTE_STORAGE_WRITE only and gives the
# D3D12 backend a TEXTURE2DMS shader-resource view.
#
# Shared, Release, dynamic CRT: a drop-in for the toolchain SDL3 so the
# vcpkg SDL3_image built against the same version keeps working. Point
# the native build at it with -DBBLITE_SDL_DIR=<OutputDirectory>.
#
# This is evaluation scaffolding for an unmerged upstream patch, not a
# supported build shape. Delete it with the branch once the patch lands.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# Keep in lockstep with the vcpkg baseline's sdl3 version
# (native/vcpkg.json builtin-baseline), so SDL3_image stays ABI-valid.
$sdlVersion = "3.4.14"
$repository = "https://github.com/libsdl-org/SDL.git"
$tag = "release-$sdlVersion"
$patch = Join-Path $PSScriptRoot "sdl-multisample-read.patch"

$workspacePath = if ([System.IO.Path]::IsPathRooted($Workspace)) {
    $Workspace
} else {
    Join-Path $root $Workspace
}
$source = Join-Path $workspacePath "source"
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
if (-not (Test-Path $patch)) {
    throw "Missing patch: $patch"
}

New-Item -ItemType Directory -Path $workspacePath, $output -Force |
    Out-Null
if (-not (Test-Path (Join-Path $source ".git"))) {
    git clone --depth 1 --branch $tag $repository $source
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to clone SDL $tag."
    }
}

# Always re-apply from a clean tree so a rerun cannot stack the patch.
git -C $source checkout --force --detach $tag
if ($LASTEXITCODE -ne 0) {
    throw "Unable to check out SDL tag $tag."
}
git -C $source apply --whitespace=nowarn $patch
if ($LASTEXITCODE -ne 0) {
    throw "Unable to apply $patch to SDL $tag."
}
$applied = git -C $source rev-parse HEAD

& $CMake -S $source -B $build `
    -DCMAKE_BUILD_TYPE=Release `
    "-DCMAKE_INSTALL_PREFIX=$output" `
    -DSDL_SHARED=ON `
    -DSDL_STATIC=OFF `
    -DSDL_TEST_LIBRARY=OFF `
    -DSDL_EXAMPLES=OFF `
    -DSDL_GPU=ON `
    -DSDL_VIDEO=ON
if ($LASTEXITCODE -ne 0) {
    throw "SDL CMake configuration failed."
}

& $CMake --build $build --config Release --parallel
if ($LASTEXITCODE -ne 0) {
    throw "SDL build failed."
}

& $CMake --install $build --config Release
if ($LASTEXITCODE -ne 0) {
    throw "SDL install failed."
}

Copy-Item (Join-Path $source "LICENSE.txt") (Join-Path $output "LICENSE.txt") -Force

@{
    repository = $repository
    tag = $tag
    version = $sdlVersion
    baseCommit = $applied
    patch = "libsdl-org/SDL#15838"
    variant = "shared, Release, dynamic CRT, default subsystems"
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built SDL $sdlVersion + SDL#15838 into $output."
