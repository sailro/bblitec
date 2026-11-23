# Reconcile a desktop mini dependency with the same artifact stamp as the mobile lanes.
param(
    [Parameter(Mandatory)][ValidateSet('sdl3', 'labsound', 'rmlui')][string]$Library,
    [Parameter(Mandatory)][string]$ToolchainIdentity,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [int]$Jobs,
    [string]$MacArchitecture,
    [string]$FreetypeRoot,
    [switch]$EnableAudio, [switch]$EnableGamepad, [switch]$EnableCodecs, [switch]$EnableSvg
)
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot/bblite-tools.psm1" -Force
$root = Get-RepositoryRoot
Assert-ContainedPath $root $OutputDirectory
$options = @{}
foreach ($key in @('MacArchitecture', 'FreetypeRoot', 'EnableAudio', 'EnableGamepad', 'EnableCodecs', 'EnableSvg')) {
    if ($PSBoundParameters[$key]) { $options[$key] = $PSBoundParameters[$key] }
}
$variants = @()
$extraInputs = @()
switch ($Library) {
    sdl3 {
        $variants = @('trimmed')
        $archive = if ($IsWindows) { 'SDL3-static.lib' } else { 'libSDL3.a' }
        $required = @("lib/$archive", 'bblite-sdl-features.cmake', 'LICENSE.txt', 'NOTICES.txt')
    }
    labsound {
        $archive = if ($IsWindows) { 'LabSound.lib' } else { 'libLabSound.a' }
        $required = @("lib/$archive", 'bblite-labsound-features.cmake', 'include/LabSound/LabSound.h')
        if ($EnableCodecs) {
            $required += if ($IsWindows) { 'lib/libnyquist.lib' } else { 'lib/liblibnyquist.a' }
        } else { $variants = @('core-only') }
    }
    rmlui {
        $archive = if ($IsWindows) { 'rmlui.lib' } else { 'librmlui.a' }
        $required = @("lib/$archive", 'lib/cmake/RmlUi/RmlUiConfig.cmake', 'bblite-rmlui-features.cmake', 'Backends/RmlUi_Platform_SDL.cpp')
        $extraInputs = @(@('freetype') + $(if ($EnableSvg) { @('lunasvg') }) |
            ForEach-Object { "$FreetypeRoot/share/$_/vcpkg_abi_info.txt" })
    }
}
if ($Library -ne 'sdl3') {
    $options[$(if ($IsWindows) { 'StaticRuntime' } else { 'MinSize' })] = $true
}
$identity = @($ToolchainIdentity) + @($options.Keys | Sort-Object | ForEach-Object { "$_=$($options[$_])" })
$inputs = @(Get-DependencyInputs $Library $variants) + $extraInputs + @($PSCommandPath)
Build-DependencyArtifact $Library $OutputDirectory $identity $inputs $required {
    if ((Test-Path -LiteralPath $OutputDirectory) -and (Get-ChildItem -LiteralPath $OutputDirectory -Force)) {
        throw "Refusing to rebuild $Library at $OutputDirectory with a missing or mismatched artifact stamp. Move it aside first."
    }
    $workspace = Join-Path $root ".cache/shipping/$([guid]::NewGuid())"
    Assert-ContainedPath $root $workspace
    $manifest = Get-Content "$root/native/patches/manifest.json" -Raw | ConvertFrom-Json
    & (Join-Path $root $manifest.libraries.$Library.builder) -Workspace $workspace -OutputDirectory $OutputDirectory -Jobs $Jobs @options
}
$state = @(Invoke-PatchIdentity state $Library -Artifact $OutputDirectory -RequiredVariants $variants)
if ($state[0] -ne 'current') { throw "$Library at ${OutputDirectory}: $($state -join ' ')" }
