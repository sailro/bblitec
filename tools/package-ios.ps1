param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]+(?:-[a-z0-9]+)*$')][string]$Scene,
    [ValidateRange(1, 1024)][int]$Jobs = 3,
    [string]$OutputRoot = 'artifacts/releases',
    [switch]$SkipGenerate
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'bblite-tools.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'package-output.psm1') -Force
if (-not $IsMacOS) { throw 'iOS packaging requires macOS and Xcode with iOS SDK 16.4 or newer.' }
$root = Get-RepositoryRoot
$applicationId = "org.bblite.demo.$Scene"
& (Join-Path $PSScriptRoot 'ios.ps1') -Scene $Scene -Sdk iphoneos -Architecture arm64 -Backend SDL_GPU `
    -MinSize -ApplicationId $applicationId -Jobs $Jobs -SkipGenerate:$SkipGenerate
$built = Join-Path $root "artifacts/ios/$Scene/iphoneos-arm64-sdl_gpu-min"
$configuration = Get-Content "$built/build.json" -Raw | ConvertFrom-Json
$cache = Read-CMakeCache "$($configuration.buildDirectory)/CMakeCache.txt"
$required = @{
    BBLITE_BACKEND = 'SDL_GPU'; BBLITE_MINSIZE = 'ON'; BBLITE_PCH = 'OFF'
    BBLITE_VISUAL_CAPTURE = 'OFF'; BBLITE_AUDIO_CAPTURE = 'OFF'; CMAKE_BUILD_TYPE = 'Release'
    VCPKG_TARGET_TRIPLET = 'arm64-ios-bblite'; CMAKE_OSX_ARCHITECTURES = 'arm64'
    BBLITE_IOS_BUNDLE_IDENTIFIER = $applicationId
}
foreach ($entry in $required.GetEnumerator()) {
    if ($cache[$entry.Key] -ne $entry.Value) { throw "iOS shipping requires $($entry.Key)=$($entry.Value)." }
}
if (-not $configuration.minSize -or $configuration.sdk -ne 'iphoneos' -or $configuration.signed -or
    -not $cache['BBLITE_SDL_DIR'] -or $cache['BBLITE_GENERATED_DIR'] -ne $configuration.generatedDirectory) {
    throw 'The iOS build is not an unsigned, trimmed device bundle for the recorded generated tree.'
}
$sourceBundle = $configuration.bundle
Push-Location $root
try {
    $buildStamp = Invoke-Checked 'node' @('--input-type=module', '-e', @'
import { readSceneStatus } from "./dist/src/tooling/generated-readers.js";
const [generated, build, bundle] = process.argv.slice(1);
const status = readSceneStatus(generated, build, `${bundle}/bblite_native`, true);
if (!status.current) throw new Error(`Stale iOS package input: ${JSON.stringify(status)}`);
console.log(status.expectedStamp);
'@, $configuration.generatedDirectory, $configuration.buildDirectory, $sourceBundle)
} finally { Pop-Location }

$name = "bblitec-$Scene-sdl-gpu-ios-arm64"
$plan = New-PackageOutput (Resolve-RepositoryPath $OutputRoot) $name
$directory = Join-Path $plan.Staging $name
$bundle = Join-Path $directory "bblite-$Scene.app"
$executable = Join-Path $bundle 'bblite_native'
New-Item -ItemType Directory -Path "$bundle/shaders" -Force | Out-Null
Copy-Item "$sourceBundle/Info.plist", "$sourceBundle/bblite_native" $bundle
foreach ($payload in @('assets', 'licenses')) {
    if (Test-Path "$sourceBundle/$payload") { Copy-Item "$sourceBundle/$payload" $bundle -Recurse }
}
$shaders = @(Get-ChildItem "$sourceBundle/shaders" -File | Where-Object { $_.Extension -in @('.msl', '.slots') })
if (-not @($shaders | Where-Object Extension -eq '.msl').Count -or -not @($shaders | Where-Object Extension -eq '.slots').Count) {
    throw 'The device package requires Metal shaders and their binding sidecars.'
}
$shaders | Copy-Item -Destination "$bundle/shaders"
Copy-Item "$root/upstream/babylon-lite.json" "$directory/upstream.json"
Copy-Item "$($configuration.generatedDirectory)/manifest.json" "$directory/manifest.json"

$strip = $cache['CMAKE_STRIP']
if (-not $strip -or -not (Test-Path -LiteralPath $strip)) { throw 'CMAKE_STRIP must name the device strip tool.' }
Invoke-Checked $strip @('-x', $executable)
Invoke-Checked 'chmod' @('755', $executable)
$loadCommands = Invoke-Checked 'xcrun' @('otool', '-l', $executable)
if ($loadCommands -match 'LC_CODE_SIGNATURE') {
    Invoke-Checked 'codesign' @('--remove-signature', $executable)
}
$architecture = (Invoke-Checked 'xcrun' @('lipo', '-archs', $executable)).Trim()
$version = (Invoke-Checked 'xcrun' @('vtool', '-show-build', $executable)) -join "`n"
if ($architecture -ne 'arm64' -or $version -notmatch '(?m)^\s*platform IOS\s*$') {
    throw 'The package must contain a thin ARM64 iOS device executable, not a macOS or Simulator slice.'
}
if ($version -notmatch "(?m)^\s*minos $([regex]::Escape($cache['CMAKE_OSX_DEPLOYMENT_TARGET']))\s*$" -or
    $version -notmatch "(?m)^\s*sdk $([regex]::Escape($configuration.sdkVersion))\s*$") {
    throw 'The Mach-O deployment target or SDK disagrees with the build configuration.'
}
$plist = (Invoke-Checked 'plutil' @('-convert', 'json', '-o', '-', "$bundle/Info.plist")) -join "`n" | ConvertFrom-Json
if ($plist.CFBundleExecutable -ne 'bblite_native' -or $plist.CFBundleIdentifier -ne $applicationId -or
    (@($plist.CFBundleSupportedPlatforms) -join ',') -ne 'iPhoneOS' -or
    (@($plist.UIDeviceFamily) -join ',') -ne '1,2' -or
    $plist.MinimumOSVersion -ne $cache['CMAKE_OSX_DEPLOYMENT_TARGET']) {
    throw 'The device bundle must identify this executable and support both iPhone and iPad at the configured minimum OS.'
}
$dependencies = @(Invoke-Checked 'xcrun' @('otool', '-L', $executable))
foreach ($line in $dependencies | Select-Object -Skip 1) {
    if ($line.Trim() -notmatch '^(?:/usr/lib/|/System/Library/)') {
        throw "The package must link project libraries statically; external import: $line"
    }
}
$dependencies | Set-Content "$directory/RUNTIME-LIBRARIES.txt"
$manifest = Get-Content "$directory/manifest.json" -Raw | ConvertFrom-Json
$assetSources = @($manifest.assets | Where-Object { $_.source -match '^https?://' } | ForEach-Object source | Sort-Object -Unique)
if ($assetSources) { $assetSources | Set-Content "$directory/ASSET-SOURCES.txt" }
@"
$Scene - iPhone and iPad, ARM64, SDL_GPU/Metal

Unsigned device bundle for iOS $($plist.MinimumOSVersion)+. This is not an installable IPA or App Store release.
Application ID: $applicationId
Sign and provision bblite-$Scene.app using your own Apple development/distribution identity before device installation.
Physical-device startup has not been tested; SDL_GPU does not support iOS Simulator.

Native code uses BBLITE_MINSIZE, size optimization, LTO and dead stripping.
Static dependencies retain reached audio, gamepad, codecs and UI only. Capture and Dawn are absent.
Metal shaders, assets and third-party notices are inside the app.
"@ | Set-Content "$directory/README.txt"
$archive = Join-Path $plan.Staging "$name.zip"
$cmake = Find-CMake
Push-Location $plan.Staging
try {
    Invoke-Checked $cmake @('-E', 'tar', 'cf', $archive, '--format=zip', '--', $name)
} finally { Pop-Location }
$files = @(Get-ChildItem $bundle -Recurse -File | Sort-Object FullName | ForEach-Object {
    @{ path = [IO.Path]::GetRelativePath($bundle, $_.FullName); bytes = $_.Length;
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
@{
    scene = $Scene; platform = 'ios'; sdk = 'iphoneos'; sdkVersion = $configuration.sdkVersion
    architecture = $architecture; deviceFamilies = @('iPhone', 'iPad'); applicationId = $applicationId
    minSdk = $plist.MinimumOSVersion; backend = 'SDL_GPU'; nativeConfiguration = 'Release'
    minSize = $true; visualCapture = $false; audioCapture = $false; signed = $false
    qualification = 'unsigned-device-bundle'
    startup = @{ status = 'not-run'; reason = 'A provisioned physical iOS device is required; SDL_GPU excludes Simulator.' }
    buildStamp = $buildStamp; upstream = Get-Content "$directory/upstream.json" -Raw | ConvertFrom-Json
    features = @($manifest.features); files = $files
    exeBytes = (Get-Item $executable).Length; exeSha256 = (Get-FileHash $executable -Algorithm SHA256).Hash
    bundleBytes = ($files | Measure-Object bytes -Sum).Sum
    zipBytes = (Get-Item $archive).Length; zipSha256 = (Get-FileHash $archive -Algorithm SHA256).Hash
} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $plan.Staging "$name.json")
Publish-PackageOutput $plan
Write-Host "Unsigned iOS device package: $(Join-Path $plan.Root "$name.zip")"
