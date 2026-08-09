param(
    [string]$OutputRoot = "artifacts\releases",
    [string]$BuildDirectory = "native\build-boombox-release",
    [string]$GeneratedDirectory = "generated\boombox"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outputRootPath = Join-Path $root $OutputRoot
$packageName = "bblitec-boombox-windows-x64"
$packageDirectory = Join-Path $outputRootPath $packageName
$archivePath = Join-Path $outputRootPath "$packageName.zip"
$buildPath = Join-Path $root $BuildDirectory
$generatedPath = Join-Path $root $GeneratedDirectory
$executable = Join-Path $buildPath "bblite_native.exe"
$shaderSource = Join-Path $generatedPath "upstream\shaders"
$assetSource = Join-Path $generatedPath "assets"

foreach ($required in @($executable, $shaderSource, $assetSource)) {
    if (-not (Test-Path $required)) {
        throw "Required portable-demo input not found: $required"
    }
}

if (Test-Path $packageDirectory) {
    Remove-Item $packageDirectory -Recurse -Force
}
if (Test-Path $archivePath) {
    Remove-Item $archivePath -Force
}

$assets = Join-Path $packageDirectory "assets"
$shaders = Join-Path $packageDirectory "shaders"
$licenses = Join-Path $packageDirectory "licenses"
New-Item -ItemType Directory -Path $assets, $shaders, $licenses -Force | Out-Null

Copy-Item $executable (Join-Path $packageDirectory "bblitec-boombox.exe")
foreach ($dll in @("SDL3.dll", "SDL3_image.dll", "libpng16.dll", "z.dll")) {
    $source = Join-Path $buildPath $dll
    if (-not (Test-Path $source)) {
        throw "Required runtime DLL not found: $source"
    }
    Copy-Item $source $packageDirectory
}

$redistRoot = "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Redist\MSVC"
$crtDirectory = Get-ChildItem $redistRoot -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "x64\Microsoft.VC145.CRT" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
if (-not $crtDirectory) {
    throw "MSVC x64 CRT redistributable directory was not found under $redistRoot."
}
Copy-Item (Join-Path $crtDirectory "*.dll") $packageDirectory

Copy-Item (Join-Path $assetSource "*") $assets -Recurse
foreach ($shader in @(
    "pbr.vert.dxil",
    "pbr.frag.dxil",
    "background-ground.frag.dxil",
    "background-skybox.frag.dxil"
)) {
    $source = Join-Path $shaderSource $shader
    if (-not (Test-Path $source)) {
        throw "Required DXIL shader not found: $source"
    }
    Copy-Item $source $shaders
}

$vcpkgShare = Join-Path $root "native\vcpkg_installed\x64-windows\share"
$licensePackages = @{
    "SDL3.txt" = "sdl3"
    "SDL3_image.txt" = "sdl3-image"
    "libpng.txt" = "libpng"
    "zlib.txt" = "zlib"
}
foreach ($entry in $licensePackages.GetEnumerator()) {
    $source = Join-Path $vcpkgShare "$($entry.Value)\copyright"
    if (-not (Test-Path $source)) {
        throw "Dependency license not found: $source"
    }
    Copy-Item $source (Join-Path $licenses $entry.Key)
}

@'
@echo off
setlocal
set "BBLITE_ASSET_DIR=%~dp0assets"
set "BBLITE_GPU_SHADER_DIR=%~dp0shaders"
"%~dp0bblitec-boombox.exe"
if errorlevel 1 pause
'@ | Set-Content (Join-Path $packageDirectory "run-boombox.cmd") -Encoding Ascii

@'
@echo off
setlocal
set "BBLITE_ASSET_DIR=%~dp0assets"
set "BBLITE_GPU_SHADER_DIR=%~dp0shaders"
set "BBLITE_GPU=0"
"%~dp0bblitec-boombox.exe"
if errorlevel 1 pause
'@ | Set-Content (Join-Path $packageDirectory "run-boombox-cpu.cmd") -Encoding Ascii

@"
bblitec BoomBox portable demo (Windows x64)
================================================

Run:
  Double-click run-boombox.cmd.

Controls:
  Left drag            Orbit
  Right/middle drag    Pan
  Mouse wheel          Zoom
  Arrow keys           Orbit fallback
  W / S                Zoom fallback

Troubleshooting:
  - Requires Windows 10/11 and a GPU/driver supported by SDL_GPU.
  - run-boombox-cpu.cmd forces the deterministic SDL_Renderer fallback.
  - Keep the assets and shaders directories beside the executable.

Current D3D12 fidelity baseline:
  Full-image MAD: 0.447
  Foreground MAD: 2.003

Compiler source:
  https://github.com/sailro/bblitec
  @babylonjs/lite 1.18.0
  Pinned upstream commit: 7184feda683072980735f9a180e6f567ee5717ba

Third-party notices are included in the licenses directory.
"@ | Set-Content (Join-Path $packageDirectory "README.txt") -Encoding UTF8

@'
BoomBox model:
https://playground.babylonjs.com/scenes/BoomBox.glb

Babylon environment:
https://assets.babylonjs.com/core/environments/environmentSpecular.env
https://assets.babylonjs.com/core/environments/backgroundGround.png
https://assets.babylonjs.com/core/environments/backgroundSkybox.dds

Babylon Lite BRDF LUT:
https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/packages/babylon-lite/assets/brdf-lut.png
'@ | Set-Content (Join-Path $packageDirectory "ASSET-SOURCES.txt") -Encoding UTF8

Compress-Archive -Path $packageDirectory -DestinationPath $archivePath -CompressionLevel Optimal
Write-Output "Created $archivePath"
