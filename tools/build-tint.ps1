param(
    [string]$Workspace = ".cache\tint",
    [string]$OutputDirectory = "artifacts\tools\tint",
    [string]$CMake = $env:CMAKE_COMMAND
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pin = Get-Content (Join-Path $root "upstream\tint.json") -Raw |
    ConvertFrom-Json
$workspacePath = Join-Path $root $Workspace
$source = Join-Path $workspacePath "dawn"
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

New-Item -ItemType Directory -Path $workspacePath, $output -Force |
    Out-Null
if (-not (Test-Path (Join-Path $source ".git"))) {
    git init $source
    git -C $source remote add origin $pin.repository
    git -C $source config core.longpaths true
}
git -C $source fetch --depth 1 origin $pin.commit
if ($LASTEXITCODE -ne 0) {
    throw "Unable to fetch pinned Tint commit $($pin.commit)."
}
git -C $source checkout --force --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0) {
    throw "Unable to check out pinned Tint commit $($pin.commit)."
}

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
