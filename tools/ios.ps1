param(
    [Parameter(Mandatory)][string]$Scene,
    [ValidateSet('iphonesimulator', 'iphoneos')][string]$Sdk = 'iphonesimulator',
    [ValidateSet('', 'x86_64', 'arm64')][string]$Architecture = '',
    [ValidateSet('', 'SDL_GPU', 'DAWN', 'BOTH')][string]$Backend = '',
    [string]$Device,
    [string]$DawnDirectory,
    [ValidatePattern('^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$')][string]$ApplicationId = 'org.bblite.prototype',
    [switch]$Install,
    [switch]$Smoke,
    [switch]$MinSize,
    [switch]$SkipGenerate,
    [string]$SweepGeneratedDirectoriesFile,
    [switch]$UseInstalledDependencies,
    [ValidateRange(1, 1024)][int]$Jobs = 3
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'bblite-tools.psm1') -Force
if (-not $IsMacOS) { throw 'iOS builds require macOS and a full Xcode installation.' }
if (-not $Backend) { $Backend = if ($Sdk -eq 'iphonesimulator') { 'DAWN' } else { 'SDL_GPU' } }
if ($Sdk -eq 'iphonesimulator' -and $Backend -ne 'DAWN') {
    throw 'The pinned SDL_GPU Metal backend does not support iOS Simulator. Use -Backend DAWN; SDL still provides UIKit windows and input.'
}
if ($MinSize -and ($Sdk -ne 'iphoneos' -or $Backend -ne 'SDL_GPU' -or $SweepGeneratedDirectoriesFile)) {
    throw '-MinSize requires an individual iphoneos SDL_GPU build; trimmed dependencies follow each scene.'
}
if (($Install -or $Smoke) -and ($Sdk -ne 'iphonesimulator' -or -not $Device)) {
    throw '-Install/-Smoke require -Sdk iphonesimulator and -Device <simulator UDID|booted>. Device signing/deployment is not implemented.'
}
if (-not $Architecture) {
    $Architecture = if ($Sdk -eq 'iphoneos' -or
        [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x86_64' }
}
$compilerArguments = @(Get-IosCompilerArguments $Sdk $Architecture)
$sdkVersion = Invoke-Checked 'xcrun' @('--sdk', $Sdk, '--show-sdk-version')
if ($Backend -ne 'DAWN') {
    if ([version]$sdkVersion -lt [version]'16.4') {
        throw 'The pinned SDL_GPU backend requires iOS SDK 16.4 or newer. Use -Backend DAWN with older SDKs.'
    }
}
$root = Get-RepositoryRoot
$cmake = Find-CMake
if (-not $env:VCPKG_ROOT -or -not (Test-Path "$env:VCPKG_ROOT/vcpkg")) {
    throw 'Set VCPKG_ROOT to a bootstrapped vcpkg checkout.'
}

Push-Location $root
try {
    if ($env:BBLITE_DIST_LOCK_HELD -ne '1') { Invoke-Checked 'npm' @('run', 'build') }
    elseif (-not (Test-Path 'dist/src/scene-command.js')) { throw 'Build the compiler before starting the iOS sweep.' }
    $sceneJson = & node dist/src/scene-command.js show $Scene
    if ($LASTEXITCODE -ne 0) { throw "Unknown scene: $Scene" }
    $resolved = $sceneJson | ConvertFrom-Json
    $id = $resolved.id
    if (-not $id -or $id -notmatch '^[a-zA-Z0-9_-]+$') { throw 'iOS requires a registered scene ID.' }
    if (-not $SkipGenerate) { Invoke-Checked 'node' @('dist/src/scene-command.js', 'compile', $id) }
    if ($Backend -ne 'DAWN' -and -not $SkipGenerate) {
        Invoke-Checked 'node' @('dist/src/compile-shaders.js', '--scene', $id, '--target', 'metal')
    }
    $generated = Join-Path $root $resolved.output
    if ($SkipGenerate -or $Backend -ne 'DAWN') {
        Invoke-Checked 'node' @('--input-type=module', '-e',
            'import { refreshBuildStamp } from "./dist/src/generation-stamp.js"; refreshBuildStamp(process.argv[1], { generatedInputsChanged: true });', $generated)
    }
    $features = (Get-Content "$generated/manifest.json" -Raw | ConvertFrom-Json).features
    if ($SweepGeneratedDirectoriesFile) {
        $features = @(Get-Content $SweepGeneratedDirectoriesFile | ForEach-Object {
            (Get-Content (Join-Path $_ 'manifest.json') -Raw | ConvertFrom-Json).features
        } | Sort-Object -Unique)
    }
    $target = "$Sdk-$Architecture"
    $triplet = if ($Sdk -eq 'iphoneos') { 'arm64-ios-bblite' }
        elseif ($Architecture -eq 'arm64') { 'arm64-ios-simulator-bblite' }
        else { 'x64-ios-simulator-bblite' }
    $backendToken = $Backend.ToLowerInvariant()
    $variant = "$target-$backendToken$(if ($MinSize) { '-min' })"
    $build = "$root/native/build-$id-ios-$variant"
    $staging = "$root/artifacts/ios/$id/$variant"
    $installed = "$root/artifacts/ios-vcpkg"
    New-Item -ItemType Directory -Force $staging | Out-Null
    $directoriesFile = $SweepGeneratedDirectoriesFile
    if (-not $directoriesFile) {
        $directoriesFile = "$staging/dependency-directories.txt"
        Set-Content $directoriesFile $generated
    }
    $profile = "$staging/dependencies.txt"
    if ($MinSize) {
        Invoke-Checked $cmake @("-DBBLITE_GENERATED_DIR=$generated",
            "-DBBLITE_PROFILE_OUTPUT=$profile", '-P', "$root/tools/shipping-profile.cmake")
        $shippingProfile = Get-Content $profile -Raw | ConvertFrom-StringData
        $dependencyFeatures = $shippingProfile.features
        $codecKey = if ($shippingProfile.codecs) { ($shippingProfile.codecs.Split(';') | Sort-Object) -join '-' } else { 'core' }
        $installed = "$root/artifacts/ios-vcpkg-min-$codecKey"
    } else {
        Invoke-Checked $cmake @("-DBBLITE_GENERATED_DIRS_FILE=$directoriesFile",
            "-DBBLITE_PROFILE_OUTPUT=$profile", '-P', "$root/tools/scene-dependencies.cmake")
        $dependencyFeatures = (Get-Content $profile -Raw).Trim()
    }
    $audioReached = 'audio:engine' -in $features
    $audioDecoded = 'audio:decoded-buffer' -in $features
    $gamepadReached = 'input:gamepad' -in $features
    $svgReached = 'ui:inline-svg' -in $features
    $sdl = "$root/artifacts/tools/sdl-min$(if ($audioReached) { '-audio' })$(if ($gamepadReached) { '-gamepad' })-ios-$target"
    $rmlui = "$root/artifacts/tools/rmlui$(if ($MinSize) { '-static' })$(if ($MinSize -and $svgReached) { '-svg' })-ios-$target"
    $labsound = "$root/artifacts/tools/labsound$(if ($MinSize) { '-static' })$(if ($MinSize -and $audioDecoded) { '-codecs' })-ios-$target"
    $dawn = if ($DawnDirectory) { Resolve-RepositoryPath $DawnDirectory } else { "$root/artifacts/tools/dawn-ios-$target" }
    if (-not $UseInstalledDependencies) {
        $installArguments = @('install', "--x-manifest-root=$root/native", "--x-install-root=$installed",
            "--overlay-triplets=$root/native/triplets", "--triplet=$triplet")
        $installArguments += @($dependencyFeatures.Split(';', [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { "--x-feature=$_" })
        Invoke-Checked "$env:VCPKG_ROOT/vcpkg" $installArguments
        $dependencyIdentity = @($compilerArguments) + @($sdkVersion, "minSize=$MinSize") + @(Invoke-Checked 'xcodebuild' @('-version'))
        $dependencyInputs = @("$PSScriptRoot/ios.ps1", $cmake) + @(
            $compilerArguments | ForEach-Object {
                if ($_ -match '^-DCMAKE_(?:C|CXX)_COMPILER=(.+)$') { $Matches[1] }
            }
        )
        if ($MinSize) {
            $inputs = Get-DependencyInputs sdl3 @('trimmed')
            Build-DependencyArtifact 'SDL iOS trimmed' $sdl $dependencyIdentity ($dependencyInputs + $inputs) @('lib/libSDL3.a', 'lib/cmake/SDL3/SDL3Config.cmake', 'bblite-sdl-features.cmake', 'provenance.json', 'LICENSE.txt') {
                & "$PSScriptRoot/build-sdl-min.ps1" -IosSdk $Sdk -EnableAudio:$audioReached -EnableGamepad:$gamepadReached -Jobs $Jobs -CMake $cmake
            }
        }
        if ('ui:rml' -in $features) {
            $inputs = @(Get-DependencyInputs rmlui) +
                @(@('freetype', 'boost-charconv') + $(if (-not $MinSize -or $svgReached) { @('lunasvg') } else { @() }) |
                    ForEach-Object { "$installed/$triplet/share/$_/vcpkg_abi_info.txt" })
            Build-DependencyArtifact 'RmlUi iOS' $rmlui $dependencyIdentity ($dependencyInputs + $inputs) @('lib/librmlui.a', 'lib/cmake/RmlUi/RmlUiConfig.cmake', 'bblite-rmlui-features.cmake', 'include/RmlUi/Core.h', 'Backends/RmlUi_Platform_SDL.cpp', 'RmlUi-LICENSE.txt') {
                & "$PSScriptRoot/build-rmlui.ps1" -IosSdk $Sdk -IosArchitecture $Architecture -FreetypeRoot "$installed/$triplet" -MinSize:$MinSize -EnableSvg:$svgReached -Jobs $Jobs -CMake $cmake
            }
        }
        if ('audio:engine' -in $features) {
            $inputs = Get-DependencyInputs labsound @('core-only')
            $required = @('lib/libLabSound.a', 'include/LabSound/LabSound.h', 'bblite-labsound-features.cmake', 'LabSound-LICENSE.txt', 'LabSound-COPYING.txt')
            if (-not $MinSize -or $audioDecoded) {
                $required += @('lib/liblibnyquist.a', 'include/libnyquist/Decoders.h', 'libnyquist-LICENSE.txt', 'libnyquist-COPYING.txt')
            }
            Build-DependencyArtifact 'LabSound iOS' $labsound $dependencyIdentity ($dependencyInputs + $inputs) $required {
                & "$PSScriptRoot/build-labsound.ps1" -IosSdk $Sdk -IosArchitecture $Architecture -MinSize:$MinSize -EnableCodecs:$audioDecoded -Jobs $Jobs -CMake $cmake
            }
        }
        if ($Backend -ne 'SDL_GPU') {
            $inputs = Get-DependencyInputs dawn @('metal', 'ios')
            Build-DependencyArtifact 'Dawn iOS' $dawn $dependencyIdentity ($dependencyInputs + $inputs) @('lib/libwebgpu_dawn.a', 'lib/cmake/Dawn/DawnConfig.cmake', 'include/webgpu/webgpu.h', 'bblite-dawn-features.cmake', 'provenance.json', 'LICENSE.txt') {
                & "$PSScriptRoot/build-dawn.ps1" -IosSdk $Sdk -IosArchitecture $Architecture -OutputDirectory $dawn -Jobs $Jobs -CMake $cmake
            }
        }
    }
    if ($SweepGeneratedDirectoriesFile) { return }
    $configure = @('-S', "$root/native", '-B', $build) + $compilerArguments + @(
        "-DCMAKE_TOOLCHAIN_FILE=$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake",
        "-DVCPKG_TARGET_TRIPLET=$triplet", "-DVCPKG_OVERLAY_TRIPLETS=$root/native/triplets",
        "-DVCPKG_INSTALLED_DIR=$installed", '-DVCPKG_MANIFEST_INSTALL=OFF',
        "-DVCPKG_MANIFEST_FEATURES=$dependencyFeatures", '-DCMAKE_BUILD_TYPE=Release',
        "-DBBLITE_GENERATED_DIR=$generated", "-DBBLITE_BACKEND=$Backend",
        "-DBBLITE_IOS_BUNDLE_IDENTIFIER=$ApplicationId", "-DBBLITE_IOS_BUNDLE_NAME=$id",
        "-DBBLITE_RMLUI_DIR=$rmlui", "-DBBLITE_LABSOUND_DIR=$labsound", "-DBBLITE_DAWN_DIR=$dawn")
    if ($MinSize) {
        $configure += @('--fresh', '-DBBLITE_MINSIZE=ON', '-DBBLITE_PCH=OFF',
            '-DBBLITE_VISUAL_CAPTURE=OFF', '-DBBLITE_AUDIO_CAPTURE=OFF', "-DBBLITE_SDL_DIR=$sdl")
    }
    Invoke-Checked $cmake $configure
    Invoke-Checked $cmake @('--build', $build, '--parallel', "$Jobs")
    $bundle = "$staging/bblite-$id.app"
    Assert-ContainedPath $staging $bundle
    if (Test-Path -LiteralPath $bundle) { Remove-Item -LiteralPath $bundle -Recurse -Force }
    Copy-Item "$build/bblite_native.app" $bundle -Recurse
    # The notices of what this build links: the trimmed SDL's own for -MinSize
    # (src/package-notices.ts, shared with every platform).
    Invoke-Checked 'node' @('dist/src/package-notices.js', '--build-directory', $build, '--platform', 'ios',
        '--output', "$bundle/licenses", '--cmake', $cmake)
    if ($Sdk -eq 'iphonesimulator') {
        Invoke-Checked 'codesign' @('--force', '--sign', '-', $bundle)
        Invoke-Checked 'codesign' @('--verify', '--strict', $bundle)
    }
    @{ scene = $id; sdk = $Sdk; sdkVersion = $sdkVersion; architecture = $Architecture;
        backend = $Backend; applicationId = $ApplicationId; bundle = $bundle;
        minSize = [bool]$MinSize; buildDirectory = $build; generatedDirectory = $generated;
        signed = $Sdk -eq 'iphonesimulator' } | ConvertTo-Json | Set-Content "$staging/build.json"
    Write-Host "iOS bundle: $bundle"
    if ($Smoke) {
        Invoke-Checked 'node' @('tools/ios-smoke.mjs', '--scene', $id, '--device', $Device,
            '--bundle', $bundle, '--app', $ApplicationId, '--backend', $backendToken,
            '--output', "$staging/smoke-$backendToken")
    } elseif ($Install) {
        Invoke-Checked 'xcrun' @('simctl', 'bootstatus', $Device, '-b')
        Invoke-Checked 'xcrun' @('simctl', 'install', $Device, $bundle)
        $previousBackend = $env:SIMCTL_CHILD_BBLITE_GPU_BACKEND
        try {
            $env:SIMCTL_CHILD_BBLITE_GPU_BACKEND = $backendToken
            Invoke-Checked 'xcrun' @('simctl', 'launch', '--terminate-running-process', $Device, $ApplicationId)
        } finally { $env:SIMCTL_CHILD_BBLITE_GPU_BACKEND = $previousBackend }
    }
} finally { Pop-Location }
