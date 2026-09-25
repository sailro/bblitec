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
# Tint's own checkout: the `tint` series (the HLSL writer option bblite-tint
# sets) is Tint's alone, so tools/build-dawn.ps1's checkout beside it, and the
# Dawn it builds, never carry it and neither builder resets the other's tree.
$source = Join-Path $workspacePath "tint-source"
$CMake = Find-CMake $CMake
$variants = @("tint")
$series = @(Get-MaintainedPatches dawn $variants $CMake)

# Every source a build reads, by repository-relative path and SHA-256: this
# script, the pin, the wrapper and the series (src/tint-tool.ts reads the same
# set from a checkout and uses only a tool recording exactly it). Each set
# builds in its own workspace directories into its own output directory, both
# named by its digest, so checkouts with other tool sources never overwrite
# this one's build or tool, and one checkout's build serves every checkout
# with the same sources.
$sourceFiles = @(
    (Join-Path $PSScriptRoot "build-tint.ps1"),
    (Join-Path $root "upstream/tint.json")
) + @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "tint-sdl") -Recurse -File | ForEach-Object FullName) +
    @($series | ForEach-Object Path)
$digests = @{}
foreach ($file in $sourceFiles) {
    $relative = [IO.Path]::GetRelativePath($root, [IO.Path]::GetFullPath($file)).Replace('\', '/')
    $digests[$relative] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}
$names = [string[]]@($digests.Keys)
[Array]::Sort($names, [StringComparer]::Ordinal)
$sources = [ordered]@{}
foreach ($name in $names) { $sources[$name] = $digests[$name] }
$identity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(
    (@($names | ForEach-Object { "$($_):$($sources[$_])" }) -join "`n")))).Substring(0, 16).ToLowerInvariant()
$build = Join-Path $workspacePath "build-tint-$identity"
$output = Join-Path (Resolve-RepositoryPath $OutputDirectory) $identity

New-Item -ItemType Directory -Path $workspacePath, $output -Force |
    Out-Null
Sync-PatchedCheckout $source $pin.repository $pin.commit "Tint" dawn $variants $CMake | Out-Null

# tools/tint-sdl wraps the checkout: it builds the pinned `tint` command and
# bblite-tint, the offline compiler's SDL_GPU writer driver. A configured build
# records its source directory, so the wrapper is staged in the workspace, which
# every worktree sharing it names alike; only changed bytes are rewritten, so a
# finished build rebuilds nothing.
$wrapper = Join-Path $workspacePath "tint-sdl-$identity"
Copy-ArtifactItem (Join-Path $PSScriptRoot "tint-sdl") $wrapper
$compilerArguments = Get-PosixCompilerArguments
& $CMake -S $wrapper -B $build @compilerArguments `
    "-DBBLITE_DAWN_SOURCE=$source" `
    -DCMAKE_BUILD_TYPE=Release `
    -DDAWN_SUPPORTS_CXX_MODULES=OFF `
    -DDAWN_FETCH_DEPENDENCIES=ON `
    -DDAWN_ENABLE_D3D11=OFF `
    -DDAWN_ENABLE_D3D12=OFF `
    -DDAWN_ENABLE_VULKAN=OFF `
    -DDAWN_ENABLE_METAL=OFF `
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

$parallelArguments = Get-BuildParallelArguments
& $CMake --build $build `
    --target tint_cmd_tint_cmd bblite_tint `
    --config Release `
    @parallelArguments
if ($LASTEXITCODE -ne 0) {
    throw "Tint build failed."
}

# Multi-config generators add the configuration directory.
function Find-BuiltExecutable([string]$Directory, [string]$Name) {
    $file = if ($IsWindows) { "$Name.exe" } else { $Name }
    $executable = @((Join-Path $Directory "Release\$file"), (Join-Path $Directory $file)) |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (-not $executable) {
        throw "$file was not found under $Directory after a successful build."
    }
    Copy-Item -LiteralPath $executable (Join-Path $output $file) -Force
    return Join-Path $output $file
}

# Dawn sets its executables' directory to its own binary directory.
$tint = Find-BuiltExecutable (Join-Path $build "dawn") "tint"
$bbliteTint = Find-BuiltExecutable $build "bblite-tint"
Copy-Item (Join-Path $source "LICENSE") (Join-Path $output "LICENSE.txt") -Force
[ordered]@{
    repository = $pin.repository
    commit = $pin.commit
    license = $pin.license
    identity = $identity
    sources = $sources
    patches = @($series | ForEach-Object { $_.Name })
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built Tint $($pin.commit) at $tint and $bbliteTint."
