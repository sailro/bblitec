param(
    [string]$Dxc = $env:DXC_PATH
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$shaderDirectory = Join-Path $root "native\shaders"

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

& $Dxc -T vs_6_0 -E main -O3 -Fo "$shaderDirectory\boombox.vert.dxil" "$shaderDirectory\boombox.vert.hlsl"
& $Dxc -T ps_6_0 -E main -O3 -Fo "$shaderDirectory\boombox.frag.dxil" "$shaderDirectory\boombox.frag.hlsl"
& $Dxc "-spirv" "-fspv-target-env=vulkan1.0" -T vs_6_0 -E main -O3 -Fo "$shaderDirectory\boombox.vert.spv" "$shaderDirectory\boombox.vert.hlsl"
& $Dxc "-spirv" "-fspv-target-env=vulkan1.0" -T ps_6_0 -E main -O3 -Fo "$shaderDirectory\boombox.frag.spv" "$shaderDirectory\boombox.frag.hlsl"

Write-Output "Compiled DXIL and SPIR-V shaders. MSL sources are checked in directly."
