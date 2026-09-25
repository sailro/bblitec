param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]+(?:-[a-z0-9]+)*$')][string]$Scene,
    [string]$Sdk = $env:ANDROID_HOME,
    [string]$Device,
    [ValidateSet('arm64-v8a', 'x86_64')][string]$Abi = 'arm64-v8a',
    [ValidateSet('SDL_GPU', 'DAWN')][string]$Backend = 'SDL_GPU',
    [int]$Jobs = 8,
    [string]$OutputRoot = 'artifacts/releases'
)
# Builds, installs and starts one Android package on -Device; staging, notices,
# the archive, the receipt and publication are src/package-output.ts's, shared
# with every platform.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'bblite-tools.psm1') -Force
$root = Get-RepositoryRoot
$Backend = $Backend.ToUpperInvariant()
if (-not $Device) { throw 'Android packaging requires -Device for its staged startup check.' }
$applicationId = 'org.bblite.demo.' + $Scene.Replace('-', '_')
& (Join-Path $PSScriptRoot 'android.ps1') -Scene $Scene -Sdk $Sdk -Abi $Abi -Backend $Backend -Jobs $Jobs -ApplicationId $applicationId
$variant = "$Abi$(if ($Backend -ne 'SDL_GPU') { '-dawn' })"
$built = Join-Path $root "artifacts/android/$Scene/$variant"
$configuration = Get-Content "$built/build.json" -Raw | ConvertFrom-Json
if ($configuration.backend -ne $Backend) { throw 'The Android build backend does not match the requested package.' }
$name = "bblitec-$Scene-$($Backend.ToLowerInvariant().Replace('_', '-'))-android-$($Abi.Replace('_', '-'))"
$outputRootPath = Resolve-RepositoryPath $OutputRoot
$packageOutput = Join-Path $root 'dist/src/package-output.js'
$staging = @(Invoke-Checked 'node' @($packageOutput, 'stage', '--root', $outputRootPath, '--name', $name))[-1]
$directory = Join-Path $staging $name
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$apk = Join-Path $directory "$Scene.apk"
Copy-Item "$built/bblite-$Scene-$Abi.apk" $apk
Copy-Item "$built/assets/licenses" $directory -Recurse
Copy-Item (Join-Path $root 'upstream/babylon-lite.json') (Join-Path $directory 'upstream.json')
$adb = Join-Path $Sdk "platform-tools/$(if ($IsWindows) { 'adb.exe' } else { 'adb' })"
& $adb -s $Device install -r $apk
if ($LASTEXITCODE -ne 0) { throw 'Staged Android APK installation failed.' }
$smoke = Join-Path $built 'package-smoke'
& node (Join-Path $root 'tools/android-smoke.mjs') --adb $adb --device $Device --apk $apk --app $applicationId --output $smoke --backend ($Backend.ToLowerInvariant())
if ($LASTEXITCODE -ne 0) { throw "Staged Android startup failed; see $smoke." }
$smokeReport = Get-Content (Join-Path $smoke 'report.json') -Raw | ConvertFrom-Json
@"
$Scene — Android $Abi, $Backend/Vulkan

Install $Scene.apk on Android API $($configuration.minSdk)+ with a compatible Vulkan GPU.
Application ID: $applicationId
Debug-signed app with Release native code; not a store release.
Assets, shaders and dependency notices are embedded in the APK.
"@ | Set-Content (Join-Path $directory 'README.txt') -Encoding utf8
$fields = Join-Path $staging 'receipt-fields.json'
[ordered]@{
    scene = $Scene; platform = 'android'; abi = $Abi; applicationId = $applicationId
    minSdk = $configuration.minSdk
    buildType = 'debug'; nativeConfiguration = 'Release'; backend = $Backend
    smoke = $smokeReport
} | ConvertTo-Json -Depth 8 | Set-Content $fields -Encoding utf8
$published = @(Invoke-Checked 'node' @($packageOutput, 'finish', '--root', $outputRootPath, '--name', $name,
    '--staging', $staging, '--receipt', $fields, '--artifact', "apk=$apk"))[-1]
Write-Host "Package: $published"
