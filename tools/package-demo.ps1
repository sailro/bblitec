param(
    [string]$Scene = "scene1",
    [string]$OutputRoot = "artifacts\releases",
    [string]$BuildDirectory = "",
    [ValidateSet("", "SDL_GPU", "DAWN")]
    [string]$ExpectBackend = ""
)

# Packages the shipping build for one generated scene target. Shipping means the
# exact, statically linked BBLITE_MINSIZE shape; full development builds and
# dual-backend differential binaries are deliberately rejected. The payload
# follows the single backend the build directory was configured with
# (BBLITE_BACKEND): SDL_GPU ships offline D3D12 DXIL shaders, while DAWN
# ships WGSL text. Dawn comes from tools/build-dawn-min.ps1. The package
# ships no runtime or CRT DLLs.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if ($Scene -notmatch '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$') {
    throw (
        "Shipping requires a generated scene id made from lowercase letters, " +
        "digits, and interior hyphens; got '$Scene'."
    )
}
if (-not $BuildDirectory) {
    $BuildDirectory = "native\build-$Scene-min-sdl"
}
$buildPath = Join-Path $root $BuildDirectory
$upstreamPin = Get-Content (
    Join-Path $root "upstream\babylon-lite.json"
) -Raw | ConvertFrom-Json

$cacheFile = Join-Path $buildPath "CMakeCache.txt"
if (-not (Test-Path $cacheFile)) {
    throw "CMake cache not found: $cacheFile. Configure and build the exact mini tree described in docs/development.md#minimal-size-shipping-builds."
}
$cache = @{}
foreach ($line in Get-Content $cacheFile) {
    if ($line -match '^([^:]+):[^=]+=(.*)$') {
        $cache[$Matches[1]] = $Matches[2].Trim()
    }
}
$backend = $cache["BBLITE_BACKEND"]
if ($null -eq $backend) {
    throw "BBLITE_BACKEND is not recorded in $cacheFile. Reconfigure the exact mini tree with the current toolchain."
}
if ($backend -notin @("SDL_GPU", "DAWN", "BOTH")) {
    throw "Unsupported BBLITE_BACKEND '$backend' in $cacheFile."
}
if ($backend -eq "BOTH") {
    throw "Shipping requires a single backend; $BuildDirectory was configured with BBLITE_BACKEND=BOTH."
}
if ($ExpectBackend -and $backend -ne $ExpectBackend) {
    throw "Build directory $BuildDirectory was configured with BBLITE_BACKEND=$backend, not $ExpectBackend."
}
$minSize = $cache["BBLITE_MINSIZE"]
if ($minSize -ne "ON") {
    throw "Shipping requires BBLITE_MINSIZE=ON; configure the exact mini build before packaging."
}
$triplet = $cache["VCPKG_TARGET_TRIPLET"]
if ($triplet -ne "x64-windows-static") {
    throw "Shipping requires VCPKG_TARGET_TRIPLET=x64-windows-static; got '$triplet'."
}
$runtime = $cache["CMAKE_MSVC_RUNTIME_LIBRARY"]
if ($runtime -notmatch '^MultiThreaded(?:Debug)?(?:\$<.*>)?$') {
    throw "Shipping requires the static MSVC runtime (CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded); got '$runtime'."
}
# Every per-scene read below (features, deployed-payload comparison) must
# describe the same generated tree the executable was built from, so a
# cache naming a different one is refused rather than silently packaged.
$generatedDirectory = $cache["BBLITE_GENERATED_DIR"]
if (-not $generatedDirectory) {
    throw "BBLITE_GENERATED_DIR is not recorded in $cacheFile. Reconfigure the exact mini tree with the current toolchain."
}
$generatedDirectory = [System.IO.Path]::GetFullPath($generatedDirectory)
$expectedGenerated = [System.IO.Path]::GetFullPath(
    (Join-Path $root "generated\$Scene")
)
if (-not [string]::Equals(
    $generatedDirectory,
    $expectedGenerated,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "Build directory $BuildDirectory was configured against $generatedDirectory, not $expectedGenerated. Reconfigure the mini tree for the packaged scene."
}
# Image codecs the generation reached (BBLITE_IMAGE_CODECS in the
# scene's features.cmake). Generated directories predating codec
# tree-shaking carry no list and keep the historical png+jpeg set.
# The physics/navigation/ui flags mirror the runtime-feature tokens
# native/CMakeLists.txt keys its vcpkg manifest features on, so the
# notice set below follows exactly what the build linked.
$jpegReached = $true
$pngReached = $true
$webpReached = $false
$audioReached = $false
$audioDecoded = $false
$physicsReached = $false
$navigationReached = $false
$uiReached = $false
$uiSvgReached = $false
$audioCapture = $cache["BBLITE_AUDIO_CAPTURE"] -eq "ON"
$visualCapture = $cache["BBLITE_VISUAL_CAPTURE"] -ne "OFF"
$featuresPath = Join-Path $generatedDirectory "features.cmake"
if (Test-Path $featuresPath) {
    $featuresText = Get-Content $featuresPath -Raw
    $audioReached = $featuresText -match '"audio:engine"'
    $audioDecoded = $featuresText -match '"audio:decoded-buffer"'
    $physicsReached = $featuresText -match '"physics:world"'
    $navigationReached = $featuresText -match '"navigation:recast"'
    $uiReached = $featuresText -match '"ui:rml"'
    $uiSvgReached = $featuresText -match '"ui:inline-svg"'
    if ($featuresText -match "BBLITE_IMAGE_CODECS") {
        $pngReached = $featuresText -match '(?s)BBLITE_IMAGE_CODECS[^)]*"png"'
        $jpegReached = $featuresText -match '(?s)BBLITE_IMAGE_CODECS[^)]*"jpeg"'
        $webpReached = $featuresText -match '(?s)BBLITE_IMAGE_CODECS[^)]*"webp"'
    }
}

$executable = @(
    (Join-Path $buildPath "bblite_native.exe"),
    (Join-Path $buildPath "Release\bblite_native.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $executable) {
    throw "Required shipping executable not found under: $buildPath"
}
$runtimeDirectory = Split-Path -Parent $executable
$shaderSource = Join-Path $runtimeDirectory "shaders"
$assetSource = Join-Path $runtimeDirectory "assets"
foreach ($required in @($executable, $shaderSource)) {
    if (-not (Test-Path $required)) {
        throw "Required shipping input not found: $required"
    }
}

# The CMake asset deploy merges rather than mirrors (native/CMakeLists.txt
# records why beside the target), so a reused build tree can still hold
# files the generated tree no longer owns — the exact leftover a pin bump
# produces. A package ships only what the current generation owns; refuse
# the stale tree instead of guessing.
$orphans = @()
foreach ($payload in @(
    @{
        Source = Join-Path $generatedDirectory "assets"
        Deployed = $assetSource
    },
    @{
        Source = Join-Path $generatedDirectory "upstream\shaders"
        Deployed = $shaderSource
    }
)) {
    if (-not (Test-Path $payload.Deployed)) { continue }
    $owned = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    if (Test-Path $payload.Source) {
        foreach ($file in Get-ChildItem $payload.Source -File -Recurse) {
            [void]$owned.Add(
                [System.IO.Path]::GetRelativePath($payload.Source, $file.FullName)
            )
        }
    }
    foreach ($file in Get-ChildItem $payload.Deployed -File -Recurse) {
        # The build's own dot-named marker files (the shader snapshot
        # stamp) are deployment machinery, not payload.
        if ($file.Name.StartsWith(".")) { continue }
        $relative = [System.IO.Path]::GetRelativePath(
            $payload.Deployed, $file.FullName
        )
        if (-not $owned.Contains($relative)) {
            $orphans += (Join-Path $payload.Deployed $relative)
        }
    }
}
if ($orphans.Count -gt 0) {
    throw "Deployed payload holds files the generated tree no longer owns: $($orphans -join ', '). The deploy merges rather than mirrors; delete these files and rebuild the mini tree before packaging."
}

$backendToken = $backend.ToLowerInvariant().Replace("_", "-")
$outputRootPath = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
    [System.IO.Path]::GetFullPath($OutputRoot)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $root $OutputRoot))
}
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
$sdlShared = Test-Path (Join-Path $runtimeDirectory "SDL3.dll")
$dawnShared = ($backend -eq "DAWN") -and
    (Test-Path (Join-Path $runtimeDirectory "webgpu_dawn.dll"))
if ($sdlShared -or $dawnShared) {
    throw "Shipping requires the fully static mini dependencies; runtime DLLs were found beside $executable."
}

if (Test-Path $assetSource) {
    Copy-Item (Join-Path $assetSource "*") $assets -Recurse
}

# The runtime reads only its compiled backend's shader formats:
# The portable Windows launcher below pins SDL_GPU to D3D12, so SDL_GPU loads
# offline .dxil plus the .slots
# sidecars naming each pinned variant's register order (the PAL binds by
# that file, never by the WGSL); Dawn compiles the .native.wgsl text
# in-process. Text intermediates (.hlsl, .msl, reflection dumps, tool
# manifests) are development artifacts.
$shaderPatterns = switch ($backend) {
    "SDL_GPU" { @("*.dxil", "*.slots") }
    "DAWN" { @("*.native.wgsl") }
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

# Third-party notices apply to every linked dependency. The
# vcpkg share tree is named by VCPKG_INSTALLED_DIR in current scene builds,
# lived in the build directory in older manifest builds, and used one legacy
# native-wide tree before that.
$installedDir = if ($cache.ContainsKey("VCPKG_INSTALLED_DIR")) {
    $cache["VCPKG_INSTALLED_DIR"]
} else {
    ""
}
$vcpkgShare = @(
    $(if ($installedDir) { Join-Path $installedDir "$triplet\share" }),
    (Join-Path $buildPath "vcpkg_installed\$triplet\share"),
    (Join-Path $root "native\vcpkg_installed\x64-windows\share")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vcpkgShare) {
    throw "vcpkg share directory with dependency licenses was not found for $BuildDirectory."
}
$licensePackages = @{
    "SDL3.txt" = "sdl3"
    "nlohmann-json.txt" = "nlohmann-json"
}
if ($pngReached -or $jpegReached -or $webpReached -or $visualCapture) {
    $licensePackages["SDL3_image.txt"] = "sdl3-image"
}
if ($pngReached -or $visualCapture) {
    $licensePackages["libpng.txt"] = "libpng"
    $licensePackages["zlib.txt"] = "zlib"
}
if ($jpegReached) {
    $licensePackages["libjpeg-turbo.txt"] = "libjpeg-turbo"
}
if ($webpReached) {
    $licensePackages["libwebp.txt"] = "libwebp"
}
if ($physicsReached) {
    $licensePackages["bullet3.txt"] = "bullet3"
}
if ($navigationReached) {
    $licensePackages["recastnavigation.txt"] = "recastnavigation"
}
if ($uiReached) {
    $licensePackages["FreeType.txt"] = "freetype"
}
if ($uiSvgReached) {
    $licensePackages["LunaSVG.txt"] = "lunasvg"
    $licensePackages["PlutoVG.txt"] = "plutovg"
}
foreach ($entry in $licensePackages.GetEnumerator()) {
    $source = Join-Path $vcpkgShare "$($entry.Value)\copyright"
    if (-not (Test-Path $source)) {
        throw "Dependency license not found: $source"
    }
    Copy-Item $source (Join-Path $licenses $entry.Key)
}
if ($uiReached) {
    # RmlUi arrives as the pinned artifact (upstream/rmlui.json, built by
    # tools/build-rmlui.ps1), not vcpkg, so its license travels inside the
    # install the configure recorded as BBLITE_RMLUI_DIR -- the same way
    # the LabSound and Dawn notices below travel inside theirs.
    $rmluiDir = if ($cache.ContainsKey("BBLITE_RMLUI_DIR")) {
        $cache["BBLITE_RMLUI_DIR"]
    } else {
        Join-Path $root "artifacts\tools\rmlui-static"
    }
    $rmluiLicense = Join-Path $rmluiDir "RmlUi-LICENSE.txt"
    if (-not (Test-Path $rmluiLicense)) {
        throw "RmlUi license not found: $rmluiLicense. Rebuild the RmlUi library (tools/build-rmlui.ps1 -StaticRuntime)."
    }
    Copy-Item $rmluiLicense (Join-Path $licenses "RmlUi.txt")
}
if ($audioReached) {
    $labSoundDir = $cache["BBLITE_LABSOUND_DIR"]
    if (-not $labSoundDir) {
        throw "The audio feature reached the package, but BBLITE_LABSOUND_DIR is absent from $cacheFile."
    }
    $audioNotices = @(
        "LabSound-LICENSE.txt",
        "LabSound-COPYING.txt"
    )
    if ($audioCapture -or $audioDecoded) {
        $audioNotices += @(
            "libnyquist-LICENSE.txt",
            "libnyquist-COPYING.txt"
        )
    }
    foreach ($notice in $audioNotices) {
        $source = Join-Path $labSoundDir $notice
        if (-not (Test-Path $source)) {
            throw "Audio dependency notice not found: $source"
        }
        Copy-Item $source (Join-Path $licenses $notice)
    }
}
if ($backend -eq "DAWN") {
    $dawnDir = if ($cache.ContainsKey("BBLITE_DAWN_DIR")) {
        $cache["BBLITE_DAWN_DIR"]
    } else {
        Join-Path $root "artifacts\tools\dawn"
    }
    $dawnLicense = Join-Path $dawnDir "LICENSE.txt"
    if (-not (Test-Path $dawnLicense)) {
        throw "Dawn license not found: $dawnLicense. Rebuild the Dawn library (tools/build-dawn.ps1 or tools/build-dawn-min.ps1)."
    }
    Copy-Item $dawnLicense (Join-Path $licenses "Dawn.txt")
}
# End of third-party notices. test/package-demo-notices.test.ts holds the
# region above closed over native/vcpkg.json: a new linkable dependency
# fails the suite until its notice entry lands between these markers.

$primaryLines = @(
    "@echo off",
    "setlocal"
)
if ($backend -eq "SDL_GPU") {
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

$backendDescription = switch ($backend) {
    "SDL_GPU" { "SDL_GPU over Direct3D 12 with offline-compiled shaders" }
    "DAWN" { "Dawn (Chrome's WebGPU) over Direct3D 12, compiling WGSL at startup" }
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

$fxcNote = if ($backend -eq "DAWN") {
    "`r`n  - Shaders compile through the Windows D3D compiler (d3dcompiler_47.dll), resolved from System32."
} else {
    ""
}

@"
bblitec $Scene shipping demo (Windows x64)
================================================

Backend: $backendDescription

Run:
  Double-click run-$Scene.cmd.

Controls:
  Scene-defined keyboard and pointer input remains available to the demo.
  Where an ArcRotate camera is attached, left drag orbits,
  right/middle drag pans, and the mouse wheel zooms. Camera controls do not
  consume keyboard input.

Troubleshooting:
  - Requires Windows 10/11 and a Direct3D 12 GPU. bblitec renders only
    on a GPU; there is no software path, so a device that cannot be
    brought up is an error rather than a slower picture.
  - bblitec-$Scene.log records startup errors.
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

# A payload is only a release if it starts. A DLL the staged binaries import
# but the package omits fails the process at load with STATUS_DLL_NOT_FOUND
# before main runs, and nothing about the staged file list says so — the list
# looks complete because every name on it is present. Read the import tables
# instead, and require any imported library the toolchain also ships to be in
# the package: system libraries live outside the vcpkg bin directory and are
# resolved by the loader, everything else has to travel with the executable.
function Get-ImportedLibraries {
    param([string] $Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) {
        return @()
    }
    $pe = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($bytes.Length -lt $pe + 24 -or [BitConverter]::ToUInt32($bytes, $pe) -ne 0x00004550) {
        return @()
    }
    $sectionCount = [BitConverter]::ToUInt16($bytes, $pe + 6)
    $optionalSize = [BitConverter]::ToUInt16($bytes, $pe + 20)
    $optional = $pe + 24
    $magic = [BitConverter]::ToUInt16($bytes, $optional)
    # The import directory is entry 1 of the data directory, which follows the
    # optional header's fixed part: 96 bytes for PE32, 112 for PE32+.
    $importEntry = $optional + $(if ($magic -eq 0x20B) { 112 } else { 96 }) + 8
    $importRva = [BitConverter]::ToUInt32($bytes, $importEntry)
    if ($importRva -eq 0) { return @() }

    $sections = @()
    $sectionBase = $optional + $optionalSize
    for ($i = 0; $i -lt $sectionCount; $i++) {
        $s = $sectionBase + ($i * 40)
        $sections += [pscustomobject]@{
            Rva = [BitConverter]::ToUInt32($bytes, $s + 12)
            Size = [BitConverter]::ToUInt32($bytes, $s + 8)
            Raw = [BitConverter]::ToUInt32($bytes, $s + 20)
        }
    }
    function Convert-RvaToOffset {
        param([uint32] $Rva, $Sections)
        foreach ($s in $Sections) {
            if ($Rva -ge $s.Rva -and $Rva -lt ($s.Rva + [Math]::Max($s.Size, 1))) {
                return [int]($s.Raw + ($Rva - $s.Rva))
            }
        }
        return -1
    }

    $names = @()
    $descriptor = Convert-RvaToOffset -Rva $importRva -Sections $sections
    if ($descriptor -lt 0) { return @() }
    while ($descriptor + 20 -le $bytes.Length) {
        $nameRva = [BitConverter]::ToUInt32($bytes, $descriptor + 12)
        if ($nameRva -eq 0) { break }
        $nameOffset = Convert-RvaToOffset -Rva $nameRva -Sections $sections
        if ($nameOffset -lt 0) { break }
        $end = $nameOffset
        while ($end -lt $bytes.Length -and $bytes[$end] -ne 0) { $end++ }
        $names += [System.Text.Encoding]::ASCII.GetString($bytes, $nameOffset, $end - $nameOffset)
        $descriptor += 20
    }
    return $names
}

$staged = Get-ChildItem $packageDirectory -Filter *.dll -File
$staged += Get-ChildItem $packageDirectory -Filter *.exe -File
$stagedNames = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]($staged | ForEach-Object { $_.Name }),
    [System.StringComparer]::OrdinalIgnoreCase
)
$missing = @{}
foreach ($binary in $staged) {
    foreach ($import in (Get-ImportedLibraries -Path $binary.FullName)) {
        if ($stagedNames.Contains($import)) { continue }
        # Only the toolchain's own libraries are ours to ship.
        if (-not (Test-Path (Join-Path $runtimeDirectory $import))) { continue }
        $missing[$import] = $binary.Name
    }
}
if ($missing.Count -gt 0) {
    $detail = ($missing.GetEnumerator() |
        ForEach-Object { "$($_.Key) (imported by $($_.Value))" }) -join ", "
    throw "Package would not start: missing runtime libraries the toolchain provides: $detail"
}

Compress-Archive -Path $packageDirectory -DestinationPath $archivePath -CompressionLevel Optimal
Write-Output "Created $archivePath ($backend payload)"
