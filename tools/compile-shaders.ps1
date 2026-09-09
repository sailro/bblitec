param(
    [string]$Dxc = $env:DXC_PATH,
    [string]$Tint = $env:TINT_PATH,
    [string]$Scene,
    [string]$Target = $env:BBLITE_SHADER_TARGET
)

$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & node tools/build-if-stale.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $shaderArguments = @('dist/src/compile-shaders.js')
    if ($Scene) { $shaderArguments += @('--scene', $Scene) }
    if ($Target) { $shaderArguments += @('--target', $Target) }
    if ($Dxc) { $shaderArguments += @('--dxc', $Dxc) }
    if ($Tint) { $shaderArguments += @('--tint', $Tint) }
    & node @shaderArguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
