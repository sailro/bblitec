param([string]$Workspace, [string]$OutputDirectory, [int]$Jobs)
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot/bblite-tools.psm1" -Force
if ($Jobs -ne 1) { throw 'The disposable fixture requires one job.' }
Add-Content "$PSScriptRoot/builder-calls.txt" 'built'
New-Item -ItemType Directory "$OutputDirectory/lib" -Force | Out-Null
$archive = if ($IsWindows) { 'SDL3-static.lib' } else { 'libSDL3.a' }
foreach ($file in @("lib/$archive", 'LICENSE.txt', 'NOTICES.txt')) {
    Set-Content "$OutputDirectory/$file" 'disposable fixture'
}
Get-PatchRecord sdl3 @('trimmed') | Set-Content "$OutputDirectory/bblite-sdl-features.cmake"
