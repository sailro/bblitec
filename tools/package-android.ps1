param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]+(?:-[a-z0-9]+)*$')][string]$Scene,
    [string]$Sdk = $env:ANDROID_HOME,
    [string]$Device,
    [ValidateSet('arm64-v8a', 'x86_64')][string]$Abi = 'arm64-v8a',
    [int]$Jobs = 8,
    [string]$OutputRoot = 'artifacts/releases'
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'bblite-tools.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'package-output.psm1') -Force
$root = Get-RepositoryRoot
if (-not $Device) { throw 'Android packaging requires -Device for its staged startup check.' }
$applicationId = 'org.bblite.demo.' + $Scene.Replace('-', '_')
& (Join-Path $PSScriptRoot 'android.ps1') -Scene $Scene -Sdk $Sdk -Abi $Abi -Jobs $Jobs -ApplicationId $applicationId
$built = Join-Path $root "artifacts/android/$Scene/$Abi"
$name = "bblitec-$Scene-sdl-gpu-android-$($Abi.Replace('_', '-'))"
$plan = New-PackageOutput (Resolve-RepositoryPath $OutputRoot) $name
$directory = Join-Path $plan.Staging $name
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$apk = Join-Path $directory "$Scene.apk"
Copy-Item "$built/bblite-$Scene-$Abi.apk" $apk
Copy-Item "$built/assets/licenses" $directory -Recurse
Copy-Item (Join-Path $root 'upstream/babylon-lite.json') (Join-Path $directory 'upstream.json')
$adb = Join-Path $Sdk "platform-tools/$(if ($IsWindows) { 'adb.exe' } else { 'adb' })"
& $adb -s $Device install -r $apk
if ($LASTEXITCODE -ne 0) { throw 'Staged Android APK installation failed.' }
$smoke = Join-Path $built 'package-smoke'
& node (Join-Path $root 'tools/android-smoke.mjs') --adb $adb --device $Device --apk $apk --app $applicationId --output $smoke
if ($LASTEXITCODE -ne 0) { throw "Staged Android startup failed; see $smoke." }
$receipt = Get-Content (Join-Path $smoke 'report.json') -Raw | ConvertFrom-Json
@"
$Scene — Android $Abi, SDL_GPU/Vulkan

Install $Scene.apk on Android 9+ with a compatible Vulkan GPU.
Application ID: $applicationId
Debug-signed prototype with Release native code; not a store release.
Assets, shaders and dependency notices are embedded in the APK.
"@ | Set-Content (Join-Path $directory 'README.txt') -Encoding utf8
$archive = Join-Path $plan.Staging "$name.zip"
Compress-Archive -Path $directory -DestinationPath $archive
@{
    scene = $Scene; platform = 'android'; abi = $Abi; applicationId = $applicationId
    buildType = 'debug'; nativeConfiguration = 'Release'; backend = 'SDL_GPU'
    apkBytes = (Get-Item $apk).Length; apkSha256 = (Get-FileHash $apk -Algorithm SHA256).Hash
    zipBytes = (Get-Item $archive).Length; zipSha256 = (Get-FileHash $archive -Algorithm SHA256).Hash
    smoke = $receipt
} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $plan.Staging "$name.json") -Encoding utf8
Publish-PackageOutput $plan
Write-Host "Package: $(Join-Path $plan.Root "$name.zip")"
