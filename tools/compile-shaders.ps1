param(
    [string]$Dxc = $env:DXC_PATH,
    [string]$Scene
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$shaderDirectories = if ($Scene) {
    @((Join-Path $root "generated\$Scene\upstream\shaders"))
} else {
    @(
        Get-ChildItem (Join-Path $root "generated") -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "upstream\shaders" } |
            Where-Object { Test-Path $_ }
    )
}
$shaderDirectories = @($shaderDirectories | Where-Object { Test-Path $_ })
if ($shaderDirectories.Count -eq 0) {
    throw "No generated shader directories found. Run a compile:<scene> command first."
}

if (-not $Dxc) {
    $local = Join-Path $root "tools\shader-compiler\vcpkg_installed\x64-windows\tools\directx-dxc\dxc.exe"
    if (Test-Path $local) {
        $Dxc = $local
    } else {
        $command = Get-Command dxc -ErrorAction SilentlyContinue
        if ($command) {
            $Dxc = $command.Source
        }
    }
}

if (-not $Dxc -or -not (Test-Path $Dxc)) {
    throw "SPIR-V-capable dxc not found. Install tools/shader-compiler/vcpkg.json or set DXC_PATH."
}

$env:PATH = "$(Split-Path -Parent $Dxc);$env:PATH"

$compiled = 0
foreach ($shaderDirectory in $shaderDirectories) {
    foreach ($source in Get-ChildItem $shaderDirectory -Filter "*.hlsl") {
        $profile = if ($source.Name.EndsWith(".vert.hlsl")) { "vs_6_0" } else { "ps_6_0" }
        $outputBase = $source.FullName.Substring(0, $source.FullName.Length - ".hlsl".Length)
        & $Dxc -T $profile -E main -O3 -Fo "$outputBase.dxil" $source.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "DXIL compilation failed for $($source.FullName)."
        }
        & $Dxc "-spirv" "-fspv-target-env=vulkan1.0" -T $profile -E main -O3 -Fo "$outputBase.spv" $source.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "SPIR-V compilation failed for $($source.FullName)."
        }
        $compiled += 1
    }
}

Write-Output "Compiled $compiled HLSL shaders to DXIL and SPIR-V. MSL sources are checked in directly."
