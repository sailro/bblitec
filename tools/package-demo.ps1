param(
    [ValidateSet('desktop', 'android', 'ios')][string]$Platform = 'desktop',
    [string]$Scene = "scene1",
    [string]$Sdk = $env:ANDROID_HOME,
    [string]$Device,
    [ValidateSet('arm64-v8a', 'x86_64')][string]$Abi = 'arm64-v8a',
    [int]$Jobs = 8,
    [string]$OutputRoot = "artifacts\releases",
    [string]$BuildDirectory = "",
    [string]$Arm64BuildDirectory = "",
    [switch]$SkipGenerate,
    [ValidateSet("", "SDL_GPU", "DAWN")]
    [string]$ExpectBackend = ""
)

# Packages the shipping build for one generated scene target. Shipping means the
# exact, statically linked BBLITE_MINSIZE shape; full development builds and
# dual-backend differential binaries are deliberately rejected. The payload
# follows the single backend the build directory was configured with
# (BBLITE_BACKEND): SDL_GPU ships DXIL on Windows and SPIR-V on Linux;
# Windows DAWN ships WGSL text. Dawn comes from tools/build-dawn-min.ps1. The package
# ships no runtime or CRT DLLs.

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "image-codecs.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "package-output.psm1") -Force
$root = Get-RepositoryRoot
if ($Platform -eq 'ios') {
    if ($BuildDirectory -or $Arm64BuildDirectory -or $Device -or $ExpectBackend -eq 'DAWN' -or
        $PSBoundParameters.ContainsKey('Abi') -or $PSBoundParameters.ContainsKey('Sdk')) {
        throw 'iOS packaging builds an ARM64 SDL_GPU device bundle. Select Xcode with DEVELOPER_DIR; Android SDK/device and desktop build options do not apply.'
    }
    & (Join-Path $PSScriptRoot 'package-ios.ps1') -Scene $Scene -Jobs $Jobs -OutputRoot $OutputRoot -SkipGenerate:$SkipGenerate
    return
}
if ($SkipGenerate) { throw '-SkipGenerate is only supported for iOS packaging.' }
if ($Platform -eq 'android') {
    if ($BuildDirectory -or $Arm64BuildDirectory) { throw 'Android packaging builds its own APK.' }
    $backend = if ($ExpectBackend) { $ExpectBackend } else { 'SDL_GPU' }
    & (Join-Path $PSScriptRoot 'package-android.ps1') -Scene $Scene -Sdk $Sdk -Device $Device -Abi $Abi -Backend $backend -Jobs $Jobs -OutputRoot $OutputRoot
    return
}
$hostArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ((-not $IsWindows -and -not $IsLinux -and -not $IsMacOS) -or
    ($hostArchitecture -ne 'X64' -and -not ($IsMacOS -and $hostArchitecture -eq 'Arm64'))) {
    throw "Minimal packaging supports Windows/Linux x64 and macOS x64/arm64 hosts."
}
if ($Arm64BuildDirectory -and -not $IsMacOS) { throw '-Arm64BuildDirectory requires macOS.' }
$architectureToken = if ($IsMacOS) { 'universal' } else { 'x64' }
$architectures = if ($IsMacOS) { @('x86_64', 'arm64') } else { @('x64') }
$platformName = if ($IsWindows) { "windows" } elseif ($IsMacOS) { "macos" } else { "linux" }
$gpuDriver = if ($IsWindows) { "direct3d12" } elseif ($IsMacOS) { "metal" } else { "vulkan" }
$graphicsApi = if ($IsWindows) { "D3D12" } elseif ($IsMacOS) { "Metal" } else { "Vulkan" }
$exeExtension = if ($IsWindows) { ".exe" } else { "" }
$expectedTriplet = if ($IsWindows) { "x64-windows-static" } elseif ($IsMacOS) { "x64-osx" } else { "x64-linux" }
$pathComparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
$pathComparer = if ($IsWindows) { [StringComparer]::OrdinalIgnoreCase } else { [StringComparer]::Ordinal }
if ($Scene -notmatch '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$') {
    throw (
        "Shipping requires a generated scene id made from lowercase letters, " +
        "digits, and interior hyphens; got '$Scene'."
    )
}
if (-not $BuildDirectory) {
    $BuildDirectory = "native\build-$Scene-min-sdl$(if ($IsMacOS) { '-x86_64' })"
}
$buildPath = Resolve-RepositoryPath $BuildDirectory
if ($IsMacOS -and -not $Arm64BuildDirectory) { $Arm64BuildDirectory = "native/build-$Scene-min-sdl-arm64" }
$buildPaths = @($buildPath)
if ($IsMacOS) { $buildPaths += Resolve-RepositoryPath $Arm64BuildDirectory }
$executables = @()
$firstCache = $null
$upstreamPin = Get-Content (
    Join-Path $root "upstream\babylon-lite.json"
) -Raw | ConvertFrom-Json

foreach ($buildPath in $buildPaths) {
    $sliceIndex = $executables.Count
    $cacheFile = Join-Path $buildPath "CMakeCache.txt"
    if (-not (Test-Path $cacheFile)) {
        throw "CMake cache not found: $cacheFile. Configure and build the exact mini tree described in docs/development.md#minimal-size-shipping-builds."
    }
    $cache = Read-CMakeCache $cacheFile
    if ($IsMacOS) {
        $expectedTriplet = if ($sliceIndex -eq 0) { 'x64-osx' } else { 'arm64-osx' }
        if ($cache['CMAKE_OSX_ARCHITECTURES'] -ne $architectures[$sliceIndex]) {
            throw "Expected CMAKE_OSX_ARCHITECTURES=$($architectures[$sliceIndex]) in $cacheFile."
        }
        if ($firstCache) {
            foreach ($key in @('BBLITE_AUDIO_CAPTURE', 'BBLITE_VISUAL_CAPTURE', 'CMAKE_OSX_DEPLOYMENT_TARGET')) {
                if ($cache[$key] -ne $firstCache[$key]) { throw "Universal build slices disagree on $key." }
            }
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
    if (-not $IsWindows -and $backend -ne "SDL_GPU") { throw "$platformName shipping requires SDL_GPU with $graphicsApi." }
    $minSize = $cache["BBLITE_MINSIZE"]
    if ($minSize -ne "ON") {
        throw "Shipping requires BBLITE_MINSIZE=ON; configure the exact mini build before packaging."
    }
    $triplet = $cache["VCPKG_TARGET_TRIPLET"]
    if ($triplet -ne $expectedTriplet) {
        throw "Shipping requires VCPKG_TARGET_TRIPLET=$expectedTriplet; got '$triplet'."
    }
    $runtime = $cache["CMAKE_MSVC_RUNTIME_LIBRARY"]
    if ($IsWindows -and $runtime -notmatch '^MultiThreaded(?:Debug)?(?:\$<.*>)?$') {
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
        $pathComparison
    )) {
        throw "Build directory $BuildDirectory was configured against $generatedDirectory, not $expectedGenerated. Reconfigure the mini tree for the packaged scene."
    }
    # Package notices follow the generated features and optional capture capabilities.
    $audioCapture = $cache["BBLITE_AUDIO_CAPTURE"] -eq "ON"
    $visualCapture = $cache["BBLITE_VISUAL_CAPTURE"] -ne "OFF"
    $featuresPath = Join-Path $generatedDirectory "features.cmake"
    $featuresText = Get-Content -LiteralPath $featuresPath -Raw
    $imageCodecLicenses = Get-ImageCodecLicenses `
        -ManifestPath (Join-Path $root "native\vcpkg.json") `
        -FeaturesText $featuresText -VisualCapture $visualCapture
    $audioReached = $featuresText -match '"audio:engine"'
    $audioDecoded = $featuresText -match '"audio:decoded-buffer"'
    $physicsReached = $featuresText -match '"physics:world"'
    $navigationReached = $featuresText -match '"navigation:recast"'
    $uiReached = $featuresText -match '"ui:rml"'
    $uiSvgReached = $featuresText -match '"ui:inline-svg"'
    $textLayoutReached = $featuresText -match '"text:layout"'
    # The features native/CMakeLists.txt links nlohmann-json for.
    $jsonReached = $featuresText -match '"(?:loader:gltf|loader:babylon|data:json)"'

    $executable = @(
        (Join-Path $buildPath "bblite_native$exeExtension"),
        (Join-Path $buildPath "Release/bblite_native$exeExtension")
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
        if (-not (Test-Path $payload.Deployed)) {
            if ($IsMacOS -and (Test-Path $payload.Source)) { throw "Missing universal slice payload: $($payload.Deployed)" }
            continue
        }
        $owned = [System.Collections.Generic.HashSet[string]]::new(
            $pathComparer
        )
        if (Test-Path $payload.Source) {
            foreach ($file in Get-ChildItem $payload.Source -File -Recurse) {
                $relative = [System.IO.Path]::GetRelativePath($payload.Source, $file.FullName)
                [void]$owned.Add($relative)
                # Both executable slices must ship the same current assets and MSL.
                # Other shader intermediates are not part of a Metal package.
                if ($IsMacOS -and ($payload.Deployed -eq $assetSource -or $file.Extension -in @('.msl', '.slots'))) {
                    $deployedFile = Join-Path $payload.Deployed $relative
                    if (-not (Test-Path -LiteralPath $deployedFile) -or
                        (Get-FileHash -LiteralPath $deployedFile).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) {
                        throw "Universal slice has missing or stale deployed payload: $deployedFile. Rebuild both slices."
                    }
                }
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

    if ($IsMacOS) {
        $actualArchitecture = & lipo -archs $executable
        if ($LASTEXITCODE -ne 0 -or "$actualArchitecture".Trim() -ne $architectures[$sliceIndex]) {
            throw "Expected a thin $($architectures[$sliceIndex]) executable: $executable; got $actualArchitecture."
        }
    }
    $executables += $executable
    if (-not $firstCache) { $firstCache = $cache }
}
$cache = $firstCache
$buildPath = $buildPaths[0]
$triplet = $cache['VCPKG_TARGET_TRIPLET']

$backendToken = $backend.ToLowerInvariant().Replace("_", "-")
$outputRootPath = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
    [System.IO.Path]::GetFullPath($OutputRoot)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $root $OutputRoot))
}
$packageName = "bblitec-$Scene-$backendToken-$platformName-$architectureToken"
$outputPlan = New-PackageOutput $outputRootPath $packageName
$packageDirectory = Join-Path $outputPlan.Staging $packageName
$archivePath = Join-Path $outputPlan.Staging "$packageName.zip"
$exeName = "bblitec-$Scene$exeExtension"
$previousExe = Join-Path (Join-Path $outputRootPath $packageName) $exeName
$previousZip = Join-Path $outputRootPath "$packageName.zip"
$previousExeBytes = if (Test-Path -LiteralPath $previousExe) { (Get-Item -LiteralPath $previousExe).Length } else { $null }
$previousZipBytes = if (Test-Path -LiteralPath $previousZip) { (Get-Item -LiteralPath $previousZip).Length } else { $null }

$assets = Join-Path $packageDirectory "assets"
$shaders = Join-Path $packageDirectory "shaders"
$licenses = Join-Path $packageDirectory "licenses"
New-Item -ItemType Directory -Path $assets, $shaders, $licenses -Force | Out-Null

if ($IsMacOS) {
    & lipo -create @executables -output (Join-Path $packageDirectory $exeName)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to combine the macOS executable slices.' }
    & lipo (Join-Path $packageDirectory $exeName) -verify_arch x86_64 arm64
    if ($LASTEXITCODE -ne 0) { throw 'The staged executable is not universal.' }
} else {
    Copy-Item $executable (Join-Path $packageDirectory $exeName)
}
if (-not $IsWindows) {
    $strip = $cache["CMAKE_STRIP"]
    if (-not $strip -or -not (Test-Path -LiteralPath $strip)) { throw "CMAKE_STRIP must name the native strip tool." }
    $stripOption = if ($IsMacOS) { "-x" } else { "--strip-unneeded" }
    & $strip $stripOption (Join-Path $packageDirectory $exeName)
    if ($LASTEXITCODE -ne 0) { throw "Unable to strip the staged executable." }
    & chmod 755 (Join-Path $packageDirectory $exeName)
    if ($LASTEXITCODE -ne 0) { throw "Unable to set the executable permission." }
    if ($IsMacOS) {
        & codesign --force --sign - (Join-Path $packageDirectory $exeName)
        if ($LASTEXITCODE -ne 0) { throw "Unable to ad-hoc sign the staged executable." }
        & codesign --verify --strict --all-architectures (Join-Path $packageDirectory $exeName)
        if ($LASTEXITCODE -ne 0) { throw "Unable to verify both signed executable slices." }
    }
}
# Statically linked builds carry SDL (and Windows Dawn) inside the executable.
# Windows also links the CRT statically; Linux retains host system libraries.
$sdlShared = Test-Path (Join-Path $runtimeDirectory "SDL3.dll")
$dawnShared = ($backend -eq "DAWN") -and
    (Test-Path (Join-Path $runtimeDirectory "webgpu_dawn.dll"))
if ($sdlShared -or $dawnShared) {
    throw "Shipping requires the fully static mini dependencies; runtime DLLs were found beside $executable."
}

if (Test-Path $assetSource) {
    Copy-Item (Join-Path $assetSource "*") $assets -Recurse
}

# The runtime reads only its compiled backend's shader formats: the trimmed
# SDL uses the host GPU driver, so SDL_GPU loads .dxil/.spv or Metal .msl
# plus the .slots sidecars naming each pinned variant's register order (the
# PAL binds by that file, never by the WGSL); Dawn compiles the .native.wgsl
# text in-process. Other intermediates (.hlsl, reflection dumps, tool
# manifests) are development artifacts.
$shaderPatterns = switch ($backend) {
    "SDL_GPU" { @($(if ($IsWindows) { "*.dxil" } elseif ($IsMacOS) { "*.msl" } else { "*.spv" }), "*.slots") }
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
$licensePackages = @{}
# A trimmed SDL (BBLITE_SDL_DIR) carries the notices of exactly the code it
# compiles (tools/build-sdl-min.ps1); vcpkg's sdl3 notice covers its own build.
$sdlDir = if ($cache.ContainsKey("BBLITE_SDL_DIR")) { $cache["BBLITE_SDL_DIR"] } else { "" }
if ($sdlDir) {
    $sdlNotice = Join-Path $sdlDir "NOTICES.txt"
    if (-not (Test-Path -LiteralPath $sdlNotice)) {
        throw "Trimmed SDL notices not found: $sdlNotice. Rebuild it with tools/build-sdl-min.ps1."
    }
    Copy-Item -LiteralPath $sdlNotice (Join-Path $licenses "SDL3.txt")
} else {
    $licensePackages["SDL3.txt"] = "sdl3"
}
if ($jsonReached) { $licensePackages["nlohmann-json.txt"] = "nlohmann-json" }
if ($IsMacOS) { $licensePackages["Boost.Charconv.txt"] = "boost-charconv" }
foreach ($license in $imageCodecLicenses.GetEnumerator()) {
    $licensePackages[$license.Key] = $license.Value
}
if ($physicsReached) {
    $licensePackages["bullet3.txt"] = "bullet3"
}
if ($navigationReached) {
    $licensePackages["recastnavigation.txt"] = "recastnavigation"
}
if ($uiReached -or $textLayoutReached) {
    $licensePackages["FreeType.txt"] = "freetype"
}
if ($uiReached -and ($IsLinux -or $IsMacOS)) {
    # The system color fonts use PNG glyphs, independently of scene textures.
    $licensePackages["libpng.txt"] = "libpng"
    $licensePackages["zlib.txt"] = "zlib"
}
if ($textLayoutReached) {
    $licensePackages["HarfBuzz.txt"] = "harfbuzz"
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
    foreach ($uiNotice in @("Skia", "Chromium")) {
        Copy-Item (Join-Path $root "native\notices\$uiNotice.txt") (Join-Path $licenses "$uiNotice.txt")
    }
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

$backendDescription = switch ($backend) {
    "SDL_GPU" { "SDL_GPU over $graphicsApi with offline-compiled shaders" }
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
    "Current development $graphicsApi fidelity baseline (versus the pinned browser reference):`r`n" +
        ($fidelityLines -join "`r`n") + "`r`n`r`n"
} else {
    ""
}

$fxcNote = if ($backend -eq "DAWN") {
    "`r`n  - Shaders compile through the Windows D3D compiler (d3dcompiler_47.dll), resolved from System32."
} else {
    ""
}

$runInstructions = if ($IsWindows) { "Double-click $exeName. Its console window shows startup errors." } else { "Run ./$exeName from a terminal in this directory." }
$requirements = if ($IsWindows) { "Windows 10/11 and a Direct3D 12 GPU" } elseif ($IsMacOS) { "macOS on Intel or Apple silicon, with a Metal GPU and an active desktop session" } else { "Linux x64 with a Vulkan GPU/driver and an X11 or Wayland session" }
$linuxNote = if ($IsLinux) {
    "`n  - Built for the host Linux system ABI; see RUNTIME-LIBRARIES.txt for linked system libraries.`n  - Install Fontconfig and fonts for text/UI. Audio requires a working host audio service."
} else { "" }
$macNote = if ($IsMacOS) {
    "`n  - Built for the configured macOS deployment target; see RUNTIME-LIBRARIES.txt for system frameworks/libraries.`n  - Ad-hoc signed for local use; this package is not Developer ID signed or notarized."
} else { "" }
@"
bblitec $Scene shipping demo ($platformName $architectureToken)
================================================

Backend: $backendDescription

Run:
  $runInstructions

Controls:
  Scene-defined keyboard and pointer input remains available to the demo.
  Where an ArcRotate camera is attached, left drag orbits,
  right/middle drag pans, and the mouse wheel zooms. Camera controls do not
  consume keyboard input.

Troubleshooting:
  - Requires $requirements. bblitec renders only
    on a GPU; there is no software path, so a device that cannot be
    brought up is an error rather than a slower picture.
  - Keep the assets and shaders directories beside the executable.$fxcNote$linuxNote$macNote

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

if ($IsLinux) {
    # Project libraries must be static; OS libraries and the Vulkan driver stay
    # on the host. Resolve without the developer's loader search overrides.
    $oldLibraryPath = $env:LD_LIBRARY_PATH
    $oldPreload = $env:LD_PRELOAD
    $oldLocale = $env:LC_ALL
    try {
        $env:LC_ALL = "C"
        $env:LD_LIBRARY_PATH = $null
        $env:LD_PRELOAD = $null
        $dependencies = & ldd (Join-Path $packageDirectory $exeName) 2>&1
        if ($LASTEXITCODE -ne 0 -or ($dependencies -match 'not found')) { throw "Unresolved Linux dependencies: $dependencies" }
        foreach ($line in $dependencies) {
            if ($line -match 'lib(?:SDL3|RmlUi|rmlui|LabSound|webgpu_dawn)' -or $line.Contains($root)) {
                throw "Shipping requires static project libraries, but the executable imports: $line"
            }
        }
        $dependencies | Set-Content (Join-Path $packageDirectory "RUNTIME-LIBRARIES.txt")
    } finally {
        $env:LD_LIBRARY_PATH = $oldLibraryPath
        $env:LD_PRELOAD = $oldPreload
        $env:LC_ALL = $oldLocale
    }
} elseif ($IsMacOS) {
    $dependencies = foreach ($architecture in $architectures) {
        $sliceDependencies = & otool -arch $architecture -L (Join-Path $packageDirectory $exeName) 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Unable to inspect Mach-O dependencies: $sliceDependencies" }
        foreach ($line in $sliceDependencies | Select-Object -Skip 1) {
            if ($line.Trim() -notmatch '^(?:/usr/lib/|/System/Library/)') {
                throw "Shipping requires static project libraries and system frameworks, but imports: $line"
            }
        }
        $sliceDependencies
    }
    $dependencies | Set-Content (Join-Path $packageDirectory "RUNTIME-LIBRARIES.txt")
} else {
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
}

# The staged package must start: run it from the package directory for a
# few frames -- BBLITE_MAX_FRAMES is the run limit every backend's loop
# honours -- and require a clean exit. A shader the payload lacks, a
# device the trimmed dependencies cannot bring up, or a library the
# loader cannot resolve all fail here, before the archive exists.
$smokeFrames = 5
$smokeStart = [System.Diagnostics.ProcessStartInfo]::new()
$smokeStart.FileName = Join-Path $packageDirectory $exeName
if ($IsMacOS) {
    # Explicitly select the native host slice even when PowerShell/Node runs
    # under Rosetta; the receipt must name the architecture actually tested.
    $smokeStart.FileName = '/usr/bin/arch'
    $smokeStart.ArgumentList.Add($(if ($hostArchitecture -eq 'Arm64') { '-arm64' } else { '-x86_64' }))
    $smokeStart.ArgumentList.Add((Join-Path $packageDirectory $exeName))
}
$smokeStart.WorkingDirectory = $packageDirectory
$smokeStart.UseShellExecute = $false
$smokeStart.CreateNoWindow = $true
foreach ($name in @($smokeStart.Environment.Keys | Where-Object { $_ -like 'BBLITE_*' })) {
    [void]$smokeStart.Environment.Remove($name)
}
$smokeStart.Environment["BBLITE_MAX_FRAMES"] = "$smokeFrames"
$smokeStart.Environment["BBLITE_GPU_DEBUG"] = "1"
$smokeStart.Environment["BBLITE_TEST_PASS"] = "1"
$smokeStart.Environment["BBLITE_LOCAL_STORAGE_ROOT"] = Join-Path $outputPlan.Staging "smoke-storage"
$smokeStart.Environment["SDL_GPU_DRIVER"] = $gpuDriver
if ($IsLinux) {
    [void]$smokeStart.Environment.Remove("LD_LIBRARY_PATH")
    [void]$smokeStart.Environment.Remove("LD_PRELOAD")
}
if ($IsMacOS) {
    foreach ($name in @($smokeStart.Environment.Keys | Where-Object { $_ -like 'DYLD_*' })) {
        [void]$smokeStart.Environment.Remove($name)
    }
}
$smokeStart.Environment["SDL_ASSERT"] = "abort"
$smoke = [System.Diagnostics.Process]::Start($smokeStart)
if (-not $smoke.WaitForExit(120000)) {
    $smoke.Kill()
    throw "Package smoke run did not exit within 120 s: $exeName did not stop after $smokeFrames frames."
}
if ($smoke.ExitCode -ne 0) {
    throw "Package smoke run failed: $exeName exited with $($smoke.ExitCode) after at most $smokeFrames frames."
}
Write-Output "Smoke run: $exeName rendered $smokeFrames frames and exited 0."

if (-not $IsWindows) {
    # libarchive records Unix executable permissions in ZIP metadata; the
    # PowerShell Compress-Archive implementation does not preserve them.
    $cmake = Find-CMake
    Push-Location $outputPlan.Staging
    try {
        & $cmake -E tar cf $archivePath --format=zip $packageName
        if ($LASTEXITCODE -ne 0) { throw "$platformName package archive creation failed." }
    } finally { Pop-Location }
} else {
    Compress-Archive -Path $packageDirectory -DestinationPath $archivePath -CompressionLevel Optimal
}
$receipt = [ordered]@{
    scene = $Scene; backend = $backend; platform = $platformName; graphicsApi = $graphicsApi; buildDirectory = $buildPath
    exeBytes = (Get-Item -LiteralPath (Join-Path $packageDirectory $exeName)).Length
    zipBytes = (Get-Item -LiteralPath $archivePath).Length
    unpackedBytes = (Get-ChildItem -LiteralPath $packageDirectory -File -Recurse | Measure-Object Length -Sum).Sum
    exeSha256 = (Get-FileHash -LiteralPath (Join-Path $packageDirectory $exeName) -Algorithm SHA256).Hash
    zipSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    previousExeBytes = $previousExeBytes; previousZipBytes = $previousZipBytes
    smokeFrames = $smokeFrames; smokeExit = $smoke.ExitCode
    architectures = $architectures; smokeArchitecture = "$hostArchitecture"; buildDirectories = $buildPaths
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputPlan.Staging "$packageName.json") -Encoding utf8
Publish-PackageOutput $outputPlan
$smoke.Dispose()
Write-Output "Created $(Join-Path $outputRootPath "$packageName.zip") ($backend payload)"
