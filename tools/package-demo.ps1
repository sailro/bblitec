param(
    [string]$Scene = "scene1",
    [string]$OutputRoot = "artifacts\releases",
    [string]$BuildDirectory = "",
    [ValidateSet("", "SDL_GPU", "DAWN", "BOTH")]
    [string]$ExpectBackend = "",
    [string]$Variant = ""
)

# Packages a portable Windows demo for one numbered scene. The payload
# follows the backend the build directory was configured with
# (BBLITE_BACKEND): SDL_GPU ships offline DXIL/SPIR-V shaders and no
# Dawn DLLs, DAWN ships WGSL text plus the Dawn runtime DLLs, and BOTH
# ships the dual-backend development binary with both shader sets.
# Statically linked builds (vcpkg x64-windows-static + BBLITE_MINSIZE,
# Dawn from tools/build-dawn-min.ps1) are detected by the absence of
# SDL3.dll / webgpu_dawn.dll beside the executable and ship no runtime
# or CRT DLLs. -Variant appends a token to the package name
# (for example -Variant min).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $BuildDirectory) {
    $BuildDirectory = "native\build-$Scene-release"
}
$buildPath = Join-Path $root $BuildDirectory
$upstreamPin = Get-Content (
    Join-Path $root "upstream\babylon-lite.json"
) -Raw | ConvertFrom-Json

$cacheFile = Join-Path $buildPath "CMakeCache.txt"
if (-not (Test-Path $cacheFile)) {
    throw "CMake cache not found: $cacheFile. Build the scene first (npm run scene -- process $Scene)."
}
$backendEntry = Select-String -Path $cacheFile -Pattern "^BBLITE_BACKEND:\w+=(.+)$" |
    Select-Object -First 1
if (-not $backendEntry) {
    throw "BBLITE_BACKEND is not recorded in $cacheFile. Reconfigure the scene with the current toolchain (npm run scene -- process $Scene)."
}
$backend = $backendEntry.Matches[0].Groups[1].Value.Trim()
if ($backend -notin @("SDL_GPU", "DAWN", "BOTH")) {
    throw "Unsupported BBLITE_BACKEND '$backend' in $cacheFile."
}
if ($ExpectBackend -and $backend -ne $ExpectBackend) {
    throw "Build directory $BuildDirectory was configured with BBLITE_BACKEND=$backend, not $ExpectBackend."
}

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

$backendToken = $backend.ToLowerInvariant().Replace("_", "-")
if ($Variant) {
    $backendToken = "$backendToken-$($Variant.ToLowerInvariant())"
}
$outputRootPath = Join-Path $root $OutputRoot
$packageName = "bblitec-$Scene-$backendToken-windows-x64"
$packageDirectory = Join-Path $outputRootPath $packageName
$archivePath = Join-Path $outputRootPath "$packageName.zip"
$exeName = "bblitec-$Scene.exe"

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

Copy-Item $executable (Join-Path $packageDirectory $exeName)
# Statically linked builds carry SDL (and Dawn) inside the executable:
# no runtime DLLs sit beside it and no CRT redistributable is needed.
# Dynamic builds ship the full DLL set exactly as before.
$sdlShared = Test-Path (Join-Path $runtimeDirectory "SDL3.dll")
$dawnShared = ($backend -ne "SDL_GPU") -and
    (Test-Path (Join-Path $runtimeDirectory "webgpu_dawn.dll"))
$runtimeDlls = @()
if ($sdlShared) {
    $runtimeDlls += @(
        "SDL3.dll",
        "SDL3_image.dll",
        "jpeg62.dll",
        "libpng16.dll",
        "z.dll"
    )
}
if ($dawnShared) {
    # Dawn resolves its built DXC DLLs module-relative with hardened
    # LoadLibraryEx flags; all three must sit beside the executable.
    # FXC (d3dcompiler_47.dll) is not shipped - the PAL preloads it
    # from the executable directory or System32.
    $runtimeDlls += @(
        "webgpu_dawn.dll",
        "dxcompiler.dll",
        "dxil.dll"
    )
}
foreach ($dll in $runtimeDlls) {
    $source = Join-Path $runtimeDirectory $dll
    if (-not (Test-Path $source)) {
        throw "Required runtime DLL not found: $source"
    }
    Copy-Item $source $packageDirectory
}

if ($sdlShared) {
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
}

Copy-Item (Join-Path $assetSource "*") $assets -Recurse

# The runtime reads only its compiled backend's shader formats:
# SDL_GPU loads offline .dxil (D3D12) or .spv (Vulkan); Dawn compiles
# the .native.wgsl text in-process. Text intermediates (.hlsl, .msl,
# reflection dumps, tool manifests) are development artifacts.
$shaderPatterns = switch ($backend) {
    "SDL_GPU" { @("*.dxil", "*.spv") }
    "DAWN" { @("*.native.wgsl") }
    "BOTH" { @("*.dxil", "*.spv", "*.native.wgsl") }
}
$shaderFiles = Get-ChildItem $shaderSource -File |
    Where-Object {
        $file = $_
        ($shaderPatterns | Where-Object { $file.Name -like $_ }).Count -gt 0
    }
if (-not $shaderFiles) {
    throw "No shader payload matched $($shaderPatterns -join ', ') under $shaderSource."
}
$shaderFiles | ForEach-Object { Copy-Item $_.FullName $shaders }

# Third-party notices apply to static and dynamic linkage alike. The
# vcpkg share tree lives in the build directory for manifest builds
# (keyed by the configured triplet) with the legacy shared tree as a
# fallback.
$tripletEntry = Select-String -Path $cacheFile -Pattern "^VCPKG_TARGET_TRIPLET:\w+=(.+)$" |
    Select-Object -First 1
$triplet = if ($tripletEntry) {
    $tripletEntry.Matches[0].Groups[1].Value.Trim()
} else {
    "x64-windows"
}
$vcpkgShare = @(
    (Join-Path $buildPath "vcpkg_installed\$triplet\share"),
    (Join-Path $root "native\vcpkg_installed\x64-windows\share")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vcpkgShare) {
    throw "vcpkg share directory with dependency licenses was not found for $BuildDirectory."
}
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
if ($backend -ne "SDL_GPU") {
    $dawnDirEntry = Select-String -Path $cacheFile -Pattern "^BBLITE_DAWN_DIR:\w+=(.+)$" |
        Select-Object -First 1
    $dawnDir = if ($dawnDirEntry) {
        $dawnDirEntry.Matches[0].Groups[1].Value.Trim()
    } else {
        Join-Path $root "artifacts\tools\dawn"
    }
    $dawnLicense = Join-Path $dawnDir "LICENSE.txt"
    if (-not (Test-Path $dawnLicense)) {
        throw "Dawn license not found: $dawnLicense. Rebuild the Dawn library (tools/build-dawn.ps1 or tools/build-dawn-min.ps1)."
    }
    Copy-Item $dawnLicense (Join-Path $licenses "Dawn.txt")
}

$primaryLines = @(
    "@echo off",
    "setlocal"
)
if ($backend -ne "DAWN") {
    $primaryLines += 'set "SDL_GPU_DRIVER=direct3d12"'
}
$primaryLines += @(
    "`"%~dp0$exeName`" > `"%~dp0bblitec-$Scene.log`" 2>&1",
    'set "RESULT=%ERRORLEVEL%"',
    "type `"%~dp0bblitec-$Scene.log`"",
    'if not "%RESULT%"=="0" pause',
    "exit /b %RESULT%"
)
$primaryLines -join "`r`n" |
    Set-Content (Join-Path $packageDirectory "run-$Scene.cmd") -Encoding Ascii

if ($backend -eq "BOTH") {
    @(
        "@echo off",
        "setlocal",
        'set "BBLITE_GPU_BACKEND=dawn"',
        "`"%~dp0$exeName`" > `"%~dp0bblitec-$Scene.log`" 2>&1",
        'set "RESULT=%ERRORLEVEL%"',
        "type `"%~dp0bblitec-$Scene.log`"",
        'if not "%RESULT%"=="0" pause',
        "exit /b %RESULT%"
    ) -join "`r`n" |
        Set-Content (Join-Path $packageDirectory "run-$Scene-dawn.cmd") -Encoding Ascii
}

@(
    "@echo off",
    "setlocal",
    'set "BBLITE_GPU=0"',
    "`"%~dp0$exeName`"",
    "if errorlevel 1 pause"
) -join "`r`n" |
    Set-Content (Join-Path $packageDirectory "run-$Scene-cpu.cmd") -Encoding Ascii

$backendDescription = switch ($backend) {
    "SDL_GPU" { "SDL_GPU over Direct3D 12 with offline-compiled shaders" }
    "DAWN" { "Dawn (Chrome's WebGPU) over Direct3D 12, compiling WGSL at startup" }
    "BOTH" { "SDL_GPU by default; run-$Scene-dawn.cmd selects the Dawn (WebGPU) backend" }
}

$fidelityLines = @()
foreach ($report in @(
    @{ Path = "artifacts\parity\$Scene\report-gpu.json"; Label = "SDL_GPU" },
    @{ Path = "artifacts\parity\$Scene\report-dawn.json"; Label = "Dawn" }
)) {
    $reportPath = Join-Path $root $report.Path
    if (Test-Path $reportPath) {
        $parsed = Get-Content $reportPath -Raw | ConvertFrom-Json
        $fidelityLines += "  $($report.Label): full-image MAD $([math]::Round($parsed.full.mad, 3)), foreground MAD $([math]::Round($parsed.region.mad, 3))"
    }
}
$fidelitySection = if ($fidelityLines) {
    "Current D3D12 fidelity baseline (versus the pinned browser reference):`r`n" +
        ($fidelityLines -join "`r`n") + "`r`n`r`n"
} else {
    ""
}

$fxcNote = if (($backend -ne "SDL_GPU") -and -not $dawnShared) {
    "`r`n  - Shaders compile through the Windows D3D compiler (d3dcompiler_47.dll), resolved from System32."
} else {
    ""
}

@"
bblitec $Scene portable demo (Windows x64)
================================================

Backend: $backendDescription

Run:
  Double-click run-$Scene.cmd.
  It automatically falls back to the deterministic SDL_Renderer
  implementation when the GPU backend is unavailable.

Controls:
  Left drag            Orbit
  Right/middle drag    Pan
  Mouse wheel          Zoom
  Arrow keys           Orbit fallback
  W / S                Zoom fallback

Troubleshooting:
  - Requires Windows 10/11.
  - run-$Scene-cpu.cmd forces the deterministic SDL_Renderer fallback.
  - bblitec-$Scene.log records startup errors and fallback information.
  - Keep the assets and shaders directories beside the executable.$fxcNote

$($fidelitySection)Compiler source:
  https://github.com/sailro/bblitec
  $($upstreamPin.package) $($upstreamPin.version)
  Pinned upstream commit: $($upstreamPin.sourceVersion)

Third-party notices are included in the licenses directory.
"@ | Set-Content (Join-Path $packageDirectory "README.txt") -Encoding UTF8

$manifestPath = Join-Path $root "generated\$Scene\manifest.json"
if (Test-Path $manifestPath) {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $assetSources = @(
        $manifest.assets |
            Where-Object { $_.source -match "^https?://" } |
            ForEach-Object { $_.source } |
            Sort-Object -Unique
    )
    if ($assetSources) {
        ($assetSources -join "`r`n") + "`r`n" |
            Set-Content (Join-Path $packageDirectory "ASSET-SOURCES.txt") -Encoding UTF8
    }
}

Compress-Archive -Path $packageDirectory -DestinationPath $archivePath -CompressionLevel Optimal
Write-Output "Created $archivePath ($backend payload)"
