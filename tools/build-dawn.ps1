param(
    [string]$Workspace = ".cache\tint",
    [string]$OutputDirectory = "artifacts\tools\dawn",
    [string]$CMake = $env:CMAKE_COMMAND
)

# Builds the pinned Dawn native (WebGPU) runtime library from the same
# commit as the pinned Tint CLI, so native rendering and shader
# compilation share one upstream provenance.

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force
$root = Get-RepositoryRoot
$pin = Get-Content (Join-Path $root "upstream\tint.json") -Raw |
    ConvertFrom-Json
$workspacePath = Resolve-RepositoryPath $Workspace
$source = Join-Path $workspacePath "dawn"
$build = Join-Path $workspacePath "build-dawn"
$output = Resolve-RepositoryPath $OutputDirectory
$CMake = Find-CMake $CMake
if (-not $IsWindows -and -not $IsLinux) { throw "Dawn setup supports Windows and Linux." }
$d3d12 = if ($IsWindows) { "ON" } else { "OFF" }
$vulkan = if ($IsLinux) { "ON" } else { "OFF" }

New-Item -ItemType Directory -Path $workspacePath, $output -Force |
    Out-Null
Sync-PinnedCheckout $source $pin.repository $pin.commit "Dawn"

# We consume the C API. The pin's module probe accepts GCC 13 even though
# CMake cannot scan that compiler's module dependencies.
$compilerArguments = Get-LinuxCompilerArguments
& $CMake -S $source -B $build @compilerArguments `
    -DCMAKE_BUILD_TYPE=Release `
    -DDAWN_SUPPORTS_CXX_MODULES=OFF `
    "-DCMAKE_INSTALL_PREFIX=$output" `
    -DCMAKE_INSTALL_LIBDIR=lib `
    -DDAWN_FETCH_DEPENDENCIES=ON `
    -DDAWN_ENABLE_INSTALL=ON `
    -DDAWN_BUILD_MONOLITHIC_LIBRARY=SHARED `
    "-DDAWN_USE_BUILT_DXC=$d3d12" `
    -DDAWN_ENABLE_D3D11=OFF `
    "-DDAWN_ENABLE_D3D12=$d3d12" `
    "-DDAWN_ENABLE_VULKAN=$vulkan" `
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
    -DTINT_BUILD_IR_BINARY=OFF
if ($LASTEXITCODE -ne 0) {
    throw "Dawn CMake configuration failed."
}

$targets = @("--target", "webgpu_dawn")
$parallelArguments = Get-BuildParallelArguments
if ($IsWindows) { $targets += @("--target", "dxcompiler", "--target", "copy_dxil_dll") }
& $CMake --build $build @targets `
    --config Release `
    @parallelArguments
if ($LASTEXITCODE -ne 0) {
    throw "Dawn build failed."
}

& $CMake --install $build --config Release
if ($LASTEXITCODE -ne 0) {
    throw "Dawn install failed."
}

# Deploy Dawn's own-built DXC and the validator DLL selected by Dawn's
# copy_dxil_dll target. With DAWN_USE_BUILT_DXC the D3D12 backend loads
# both beside webgpu_dawn.dll when use_dxc is enabled.
if ($IsWindows) {
    $builtDxc = Get-ChildItem -Recurse (Join-Path $build "third_party") `
        -Filter "dxcompiler.dll" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "Release" } |
        Select-Object -First 1
    if (-not $builtDxc) {
        $builtDxc = Get-ChildItem -Recurse $build -Filter "dxcompiler.dll" `
            -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $builtDxc) {
        throw "Dawn's built dxcompiler.dll was not found in the build tree."
    }
    Copy-Item $builtDxc.FullName (Join-Path $output "bin") -Force
    $builtDxil = Get-ChildItem (Join-Path $build "Release") `
        -Filter "dxil.dll" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $builtDxil) {
        throw "Dawn's selected dxil.dll was not found in the build tree."
    }
    Copy-Item $builtDxil.FullName (Join-Path $output "bin") -Force
}

# FXC (d3dcompiler_47.dll) is intentionally not installed: it is only
# reached when Dawn force-disables use_dxc on adapters below shader
# model 6, and the PAL preloads it from the executable directory or
# System32 at runtime.

# Install the Dawn license beside the binaries so release packaging
# can redistribute it without the source checkout.
Copy-Item (Join-Path $source "LICENSE") (Join-Path $output "LICENSE.txt") -Force

@{
    repository = $pin.repository
    commit = $pin.commit
    license = $pin.license
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built Dawn $($pin.commit) into $output."
