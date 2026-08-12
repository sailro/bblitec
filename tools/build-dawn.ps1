param(
    [string]$Workspace = ".cache\tint",
    [string]$OutputDirectory = "artifacts\tools\dawn",
    [string]$CMake = $env:CMAKE_COMMAND
)

# Builds the pinned Dawn native (WebGPU) runtime library from the same
# commit as the pinned Tint CLI, so native rendering and shader
# compilation share one upstream provenance.

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
$build = Join-Path $workspacePath "build-dawn"
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
    -DCMAKE_BUILD_TYPE=Release `
    "-DCMAKE_INSTALL_PREFIX=$output" `
    -DDAWN_FETCH_DEPENDENCIES=ON `
    -DDAWN_ENABLE_INSTALL=ON `
    -DDAWN_BUILD_MONOLITHIC_LIBRARY=SHARED `
    -DDAWN_USE_BUILT_DXC=ON `
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
    -DTINT_BUILD_IR_BINARY=OFF
if ($LASTEXITCODE -ne 0) {
    throw "Dawn CMake configuration failed."
}

& $CMake --build $build `
    --target webgpu_dawn `
    --config Release `
    --parallel
if ($LASTEXITCODE -ne 0) {
    throw "Dawn build failed."
}

& $CMake --install $build --config Release
if ($LASTEXITCODE -ne 0) {
    throw "Dawn install failed."
}

# Dawn's D3D12 backend loads FXC relative to the webgpu_dawn module,
# mirroring Chrome's deployment of the SDK compiler beside chrome.dll.
$fxc = Get-ChildItem `
    "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\d3dcompiler_47.dll" |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if (-not $fxc) {
    throw "d3dcompiler_47.dll was not found in a Windows SDK."
}
Copy-Item $fxc.FullName (Join-Path $output "bin") -Force

@{
    repository = $pin.repository
    commit = $pin.commit
    license = $pin.license
    fxc = $fxc.FullName
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built Dawn $($pin.commit) into $output."
