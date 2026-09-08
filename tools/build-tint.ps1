param(
    [string]$Workspace = ".cache\tint",
    [string]$OutputDirectory = "artifacts\tools\tint",
    [string]$CMake = $env:CMAKE_COMMAND
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force
$root = Get-RepositoryRoot
$pin = Get-Content (Join-Path $root "upstream\tint.json") -Raw |
    ConvertFrom-Json
$workspacePath = Resolve-RepositoryPath $Workspace
$source = Join-Path $workspacePath "dawn"
$build = Join-Path $workspacePath "build"
$output = Resolve-RepositoryPath $OutputDirectory
$CMake = Find-CMake $CMake

New-Item -ItemType Directory -Path $workspacePath, $output -Force |
    Out-Null
Sync-PinnedCheckout $source $pin.repository $pin.commit "Tint"

& $CMake -S $source -B $build `
    -DDAWN_FETCH_DEPENDENCIES=ON `
    -DDAWN_ENABLE_D3D11=OFF `
    -DDAWN_ENABLE_D3D12=OFF `
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
    -DDAWN_BUILD_MONOLITHIC_LIBRARY=OFF `
    -DTINT_BUILD_TESTS=OFF `
    -DTINT_BUILD_BENCHMARKS=OFF `
    -DTINT_BUILD_IR_BINARY=OFF `
    -DTINT_BUILD_CMD_TOOLS=ON `
    -DTINT_BUILD_WGSL_READER=ON `
    -DTINT_BUILD_WGSL_WRITER=ON `
    -DTINT_BUILD_HLSL_WRITER=ON `
    -DTINT_BUILD_MSL_WRITER=ON `
    -DTINT_BUILD_SPV_WRITER=ON `
    -DTINT_BUILD_SPV_READER=ON `
    -DTINT_BUILD_GLSL_WRITER=OFF `
    -DTINT_BUILD_GLSL_VALIDATOR=OFF
if ($LASTEXITCODE -ne 0) {
    throw "Tint CMake configuration failed."
}

& $CMake --build $build `
    --target tint_cmd_tint_cmd `
    --config Release `
    --parallel
if ($LASTEXITCODE -ne 0) {
    throw "Tint build failed."
}

$executableName = if ($IsWindows) { "tint.exe" } else { "tint" }
$candidates = @(
    (Join-Path $build "Release\$executableName"),
    (Join-Path $build $executableName)
)
$executable = $candidates |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
if (-not $executable) {
    throw "The Tint executable was not found after a successful build."
}

Copy-Item $executable (Join-Path $output $executableName) -Force
Copy-Item (Join-Path $source "LICENSE") (Join-Path $output "LICENSE.txt") -Force
@{
    repository = $pin.repository
    commit = $pin.commit
    license = $pin.license
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built Tint $($pin.commit) at $(Join-Path $output $executableName)."
