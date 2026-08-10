param(
    [string]$OutputRoot = "artifacts\releases",
    [string]$BuildDirectory = "native\build-boombox-release"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outputRootPath = Join-Path $root $OutputRoot
$packageName = "bblitec-boombox-windows-x64"
$packageDirectory = Join-Path $outputRootPath $packageName
$archivePath = Join-Path $outputRootPath "$packageName.zip"
$buildPath = Join-Path $root $BuildDirectory
$executable = @(
    (Join-Path $buildPath "bblite_native.exe"),
    (Join-Path $buildPath "Release\bblite_native.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $executable) {
    throw "Required portable-demo executable not found under: $buildPath"
}
$runtimeDirectory = Split-Path -Parent $executable
$shaderSource = Join-Path $runtimeDirectory "shaders"
$assetSource = Join-Path $runtimeDirectory "assets"

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
foreach ($dll in @(
    "SDL3.dll",
    "SDL3_image.dll",
    "jpeg62.dll",
    "libpng16.dll",
    "z.dll"
)) {
    $source = Join-Path $runtimeDirectory $dll
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
Copy-Item (Join-Path $shaderSource "*") $shaders -Recurse

$vcpkgShare = Join-Path $root "native\vcpkg_installed\x64-windows\share"
$licensePackages = @{
    "SDL3.txt" = "sdl3"
    "SDL3_image.txt" = "sdl3-image"
    "libjpeg-turbo.txt" = "libjpeg-turbo"
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
set "SDL_GPU_DRIVER=direct3d12"
"%~dp0bblitec-boombox.exe" > "%~dp0bblitec-boombox.log" 2>&1
set "RESULT=%ERRORLEVEL%"
type "%~dp0bblitec-boombox.log"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
'@ | Set-Content (Join-Path $packageDirectory "run-boombox.cmd") -Encoding Ascii

@'
@echo off
setlocal
set "BBLITE_GPU=0"
"%~dp0bblitec-boombox.exe"
if errorlevel 1 pause
'@ | Set-Content (Join-Path $packageDirectory "run-boombox-cpu.cmd") -Encoding Ascii

@"
bblitec BoomBox portable demo (Windows x64)
================================================

Run:
  Double-click run-boombox.cmd.
  It uses Direct3D 12 when available and automatically falls back to SDL_Renderer.

Controls:
  Left drag            Orbit
  Right/middle drag    Pan
  Mouse wheel          Zoom
  Arrow keys           Orbit fallback
  W / S                Zoom fallback

Troubleshooting:
  - Requires Windows 10/11.
  - run-boombox-cpu.cmd forces the deterministic SDL_Renderer fallback.
  - bblitec-boombox.log records startup errors and fallback information.
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
