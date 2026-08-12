param(
    [string]$Workspace = ".cache\tint",
    [string]$OutputDirectory = "artifacts\tools\dawn-min",
    [string]$CMake = $env:CMAKE_COMMAND
)

# Builds a minimal-footprint variant of the pinned Dawn library for
# size-optimized release packages: monolithic STATIC library folded
# into the executable, D3D12 only, MinSizeRel, static MSVC runtime,
# and no built DXC. Without DAWN_USE_BUILT_DXC Dawn force-disables the
# use_dxc toggle and compiles through FXC (d3dcompiler_47.dll), which
# it resolves from the executable directory or System32 - so the
# package ships no compiler DLLs at all. Parity note: FXC instead of
# DXC carries the documented ~1 LSB deltas on lit surfaces
# (docs/backends.md, "Shader compiler identity is the parity
# linchpin"); the differential-gate library remains
# tools/build-dawn.ps1.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pin = Get-Content (Join-Path $root "upstream\tint.json") -Raw |
    ConvertFrom-Json
$workspacePath = if ([System.IO.Path]::IsPathRooted($Workspace)) {
    $Workspace
} else {
    Join-Path $root $Workspace
}
$source = Join-Path $workspacePath "dawn"
$build = Join-Path $workspacePath "build-dawn-min"
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
    git init $source
    git -C $source remote add origin $pin.repository
    git -C $source config core.longpaths true
}
$head = git -C $source rev-parse HEAD
if ($head -ne $pin.commit) {
    git -C $source fetch --depth 1 origin $pin.commit
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to fetch pinned Dawn commit $($pin.commit)."
    }
    git -C $source checkout --force --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to check out pinned Dawn commit $($pin.commit)."
    }
}

& $CMake -S $source -B $build `
    -DCMAKE_BUILD_TYPE=MinSizeRel `
    "-DCMAKE_INSTALL_PREFIX=$output" `
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>' `
    -DABSL_MSVC_STATIC_RUNTIME=ON `
    '-DCMAKE_CXX_FLAGS_MINSIZEREL=/O1 /Ob1 /DNDEBUG /Gw /Zc:inline' `
    '-DCMAKE_C_FLAGS_MINSIZEREL=/O1 /Ob1 /DNDEBUG /Gw' `
    -DDAWN_FETCH_DEPENDENCIES=ON `
    -DDAWN_ENABLE_INSTALL=ON `
    -DDAWN_BUILD_MONOLITHIC_LIBRARY=STATIC `
    -DDAWN_ENABLE_D3D11=OFF `
    -DDAWN_ENABLE_D3D12=ON `
    -DDAWN_ENABLE_VULKAN=OFF `
    -DDAWN_ENABLE_NULL=OFF `
    -DDAWN_ENABLE_DESKTOP_GL=OFF `
    -DDAWN_ENABLE_OPENGLES=OFF `
    -DDAWN_USE_WINDOWS_UI=OFF `
    -DDAWN_USE_GLFW=OFF `
    -DDAWN_BUILD_SAMPLES=OFF `
    -DDAWN_BUILD_TESTS=OFF `
    -DDAWN_BUILD_BENCHMARKS=OFF `
    -DDAWN_BUILD_PROTOBUF=OFF `
    -DTINT_BUILD_TESTS=OFF `
    -DTINT_BUILD_BENCHMARKS=OFF `
    -DTINT_BUILD_CMD_TOOLS=OFF `
    -DTINT_BUILD_IR_BINARY=OFF `
    -DTINT_BUILD_GLSL_VALIDATOR=OFF
if ($LASTEXITCODE -ne 0) {
    throw "Dawn minimal CMake configuration failed."
}

& $CMake --build $build `
    --target webgpu_dawn `
    --config MinSizeRel `
    --parallel
if ($LASTEXITCODE -ne 0) {
    throw "Dawn minimal build failed."
}

& $CMake --install $build --config MinSizeRel
if ($LASTEXITCODE -ne 0) {
    throw "Dawn minimal install failed."
}

# Install the Dawn license beside the library so release packaging can
# redistribute it without the source checkout (static linking still
# requires the notice).
Copy-Item (Join-Path $source "LICENSE") (Join-Path $output "LICENSE.txt") -Force

@{
    repository = $pin.repository
    commit = $pin.commit
    license = $pin.license
    variant = "monolithic-static, MinSizeRel, static CRT, D3D12 only, FXC (no built DXC)"
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built minimal Dawn $($pin.commit) into $output."
