param(
    [Parameter(Mandatory)][string]$Scene,
    [string]$Sdk = $env:ANDROID_HOME,
    [string]$Ndk = $env:ANDROID_NDK_HOME,
    [ValidateSet('arm64-v8a', 'x86_64')][string]$Abi = 'arm64-v8a',
    [string]$Device,
    [ValidatePattern('^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')][string]$ApplicationId = 'org.bblite.prototype',
    [switch]$Install,
    [switch]$Smoke,
    [switch]$SkipGenerate,
    [string]$SweepGeneratedDirectoriesFile,
    [switch]$UseInstalledDependencies,
    [int]$Jobs = 8
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'bblite-tools.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'package-output.psm1') -Force
$root = Get-RepositoryRoot
if (-not $Sdk -or -not (Test-Path "$Sdk/platforms/android-35/android.jar")) {
    throw 'Set ANDROID_HOME or -Sdk to an SDK containing platforms;android-35, build-tools;35.0.0 and platform-tools.'
}
if (-not $Ndk) { $Ndk = "$Sdk/ndk/28.2.13676358" }
if (-not (Test-Path "$Ndk/build/cmake/android.toolchain.cmake")) {
    throw 'Install ndk;28.2.13676358 with sdkmanager, or set ANDROID_NDK_HOME/-Ndk.'
}
$env:ANDROID_HOME = [IO.Path]::GetFullPath($Sdk)
$env:ANDROID_NDK_HOME = [IO.Path]::GetFullPath($Ndk)
$cmake = Find-CMake
$hostTools = Get-DevToolchain
$vcpkgRoot = $env:VCPKG_ROOT
if (-not $vcpkgRoot -and $IsWindows) { $vcpkgRoot = Join-Path (Get-VisualStudioRoot) 'VC/vcpkg' }
if (-not $vcpkgRoot) { throw 'Set VCPKG_ROOT to your vcpkg checkout.' }

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed ($LASTEXITCODE)." }
}

function Build-AndroidDependency([string]$Name, [string]$Output, [string[]]$Inputs, [string[]]$Required, [scriptblock]$Build) {
    $identity = @($Abi, [IO.Path]::GetFullPath($Ndk)) + @(
        $Inputs + @("$Ndk/source.properties", "$PSScriptRoot/bblite-tools.psm1", "$PSScriptRoot/android.ps1") |
            Sort-Object -Unique | ForEach-Object { "$_=" + (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
    )
    $fingerprint = $identity -join "`n"
    $stamp = "$Output/android-build-inputs.txt"
    if ((Test-Path $stamp) -and (Get-Content $stamp -Raw) -eq $fingerprint -and
        @($Required | Where-Object { -not (Test-Path (Join-Path $Output $_)) }).Count -eq 0) {
        Write-Host "$Name Android artifact is current ($Abi)."
        return
    }
    & $Build
    Set-Content $stamp $fingerprint -NoNewline
}

Push-Location $root
try {
    Invoke-Checked 'npm' @('run', 'build')
    # Registry resolution supplies the same generated path as desktop commands.
    $sceneJson = & node dist/src/scene-command.js show $Scene
    if ($LASTEXITCODE -ne 0) { throw "Unknown scene: $Scene" }
    $resolved = $sceneJson | ConvertFrom-Json
    $id = $resolved.id
    if (-not $id -or $id -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Android requires a registered scene ID.' }
    if (-not $SkipGenerate) { Invoke-Checked 'node' @('dist/src/scene-command.js', 'compile', $id) }
    Invoke-Checked 'node' @('dist/src/compile-shaders.js', '--scene', $id, '--target', 'vulkan')
    $generated = Join-Path $root $resolved.output
    $triplet = if ($Abi -eq 'arm64-v8a') { 'arm64-android-bblite' } else { 'x64-android-bblite' }
    $build = "$root/native/build-$id-android-$Abi"
    $staging = "$root/artifacts/android/$id/$Abi"
    New-Item -ItemType Directory -Force $staging | Out-Null
    $directoriesFile = $SweepGeneratedDirectoriesFile
    if (-not $directoriesFile) {
        $directoriesFile = "$staging/dependency-directories.txt"
        Set-Content $directoriesFile $generated.Replace('\', '/')
    }
    $profile = "$staging/dependencies.txt"
    Invoke-Checked $cmake @("-DBBLITE_GENERATED_DIRS_FILE=$directoriesFile",
        "-DBBLITE_PROFILE_OUTPUT=$profile", '-P', "$root/tools/android-sweep-dependencies.cmake")
    $dependencyFeatures = (Get-Content $profile -Raw).Trim()
    $runtimeFeatures = @(Get-Content $directoriesFile | ForEach-Object {
        (Get-Content (Join-Path $_ 'manifest.json') -Raw | ConvertFrom-Json).features
    } | Sort-Object -Unique)
    $rmlui = "$root/artifacts/tools/rmlui-android-$Abi"
    $labsound = "$root/artifacts/tools/labsound-android-$Abi"
    if (-not $UseInstalledDependencies) {
        $vcpkg = Join-Path $vcpkgRoot "vcpkg$(if ($IsWindows) { '.exe' })"
        $installArguments = @('install', "--x-manifest-root=$root/native", "--x-install-root=$root/artifacts/android-vcpkg",
            "--overlay-triplets=$root/native/triplets", "--triplet=$triplet")
        $installArguments += @($dependencyFeatures.Split(';', [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { "--x-feature=$_" })
        Invoke-Checked $vcpkg $installArguments
        if ('ui:rml' -in $runtimeFeatures) {
            $inputs = @("$root/upstream/rmlui.json", "$PSScriptRoot/build-rmlui.ps1", "$PSScriptRoot/package-output.psm1", "$root/native/apply-rmlui-patch.cmake") +
                @(Get-ChildItem "$root/native/patches" -Filter 'rmlui-*.patch' -File | ForEach-Object FullName) +
                @('freetype', 'lunasvg', 'boost-charconv' | ForEach-Object { "$root/artifacts/android-vcpkg/$triplet/share/$_/vcpkg_abi_info.txt" })
            Build-AndroidDependency 'RmlUi' $rmlui $inputs @('lib/librmlui.a', 'lib/cmake/RmlUi/RmlUiConfig.cmake', 'bblite-rmlui-features.cmake', 'include/RmlUi/Core.h', 'Backends/RmlUi_Platform_SDL.cpp', 'RmlUi-LICENSE.txt') {
                & "$PSScriptRoot/build-rmlui.ps1" -AndroidAbi $Abi -AndroidNdk $Ndk -FreetypeRoot "$root/artifacts/android-vcpkg/$triplet" -Jobs $Jobs -CMake $cmake
            }
        }
        if ('audio:engine' -in $runtimeFeatures) {
            Build-AndroidDependency 'LabSound' $labsound @("$root/upstream/labsound.json", "$PSScriptRoot/build-labsound.ps1", "$PSScriptRoot/patches/labsound-lazy-decoders.patch") @('lib/libLabSound.a', 'lib/liblibnyquist.a', 'include/LabSound/LabSound.h', 'include/libnyquist/Decoders.h', 'bblite-labsound-features.cmake', 'LabSound-LICENSE.txt', 'LabSound-COPYING.txt', 'libnyquist-LICENSE.txt', 'libnyquist-COPYING.txt') {
                & "$PSScriptRoot/build-labsound.ps1" -AndroidAbi $Abi -AndroidNdk $Ndk -Jobs $Jobs -CMake $cmake
            }
        }
    }
    $sceneFeatures = (Get-Content "$generated/manifest.json" -Raw | ConvertFrom-Json).features
    $minSdk = if ('ui:rml' -in $sceneFeatures) { 29 } else { 28 }
    if ($minSdk -ne 28) { $build += "-api$minSdk" }
    $configure = @('-S', "$root/native", '-B', $build, '-G', 'Ninja',
        "-DCMAKE_TOOLCHAIN_FILE=$vcpkgRoot/scripts/buildsystems/vcpkg.cmake",
        "-DVCPKG_CHAINLOAD_TOOLCHAIN_FILE=$Ndk/build/cmake/android.toolchain.cmake",
        "-DVCPKG_OVERLAY_TRIPLETS=$root/native/triplets", "-DVCPKG_TARGET_TRIPLET=$triplet",
        "-DVCPKG_INSTALLED_DIR=$root/artifacts/android-vcpkg", "-DANDROID_ABI=$Abi",
        "-DANDROID_PLATFORM=android-$minSdk", '-DANDROID_STL=c++_shared',
        "-DBBLITE_RMLUI_DIR=$rmlui", "-DBBLITE_LABSOUND_DIR=$labsound",
        '-DCMAKE_BUILD_TYPE=Release', "-DBBLITE_GENERATED_DIR=$generated", '-DBBLITE_BACKEND=SDL_GPU',
        '-DBBLITE_PCH=ON', '-DBBLITE_NATIVE_CACHE=ON')
    $configure += "-DVCPKG_MANIFEST_FEATURES=$dependencyFeatures"
    $configure += '-DVCPKG_MANIFEST_INSTALL=OFF'
    if ($hostTools) { $configure += "-DCMAKE_MAKE_PROGRAM=$($hostTools.Ninja)" }
    Invoke-Checked $cmake $configure

    # Match Java glue to the native SDL version, without modifying a desktop checkout.
    $sdlVersion = (Get-Content "$root/native/vcpkg-overlay-ports/sdl3/vcpkg.json" -Raw | ConvertFrom-Json).version
    $sdl = "$root/.cache/android-sdl-$sdlVersion"
    if (-not (Test-Path "$sdl/android-project/gradlew.bat")) {
        $revision = & git ls-remote --refs 'https://github.com/libsdl-org/SDL.git' "refs/tags/release-$sdlVersion"
        if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^([0-9a-f]{40})\s') { throw "Cannot resolve SDL $sdlVersion." }
        Sync-PinnedCheckout $sdl 'https://github.com/libsdl-org/SDL.git' $Matches[1] 'SDL Android glue'
    }
    if ($SweepGeneratedDirectoriesFile) { return }
    Invoke-Checked $cmake @('--build', $build, '--parallel', "$Jobs")
    # Remove only disposable staging payloads, after checking their absolute boundary.
    foreach ($relative in @('assets', 'jniLibs')) {
        $path = [IO.Path]::GetFullPath("$staging/$relative")
        Assert-PackageChild $staging $path
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    $payload = "$staging/assets/payload"
    $libraries = "$staging/jniLibs/$Abi"
    New-Item -ItemType Directory -Force "$payload/shaders", $libraries | Out-Null
    if (Test-Path "$generated/assets") { Copy-Item "$generated/assets" $payload -Recurse }
    Get-ChildItem "$build/shaders" -File | Where-Object { $_.Extension -in @('.spv', '.slots') } |
        Copy-Item -Destination "$payload/shaders"
    Copy-Item "$build/libmain.so" $libraries
    Copy-Item "$root/artifacts/android-vcpkg/$triplet/lib/libSDL3.so" $libraries
    $ndkHost = if ($IsWindows) { 'windows-x86_64' } elseif ($IsMacOS) { 'darwin-x86_64' } else { 'linux-x86_64' }
    $arch = if ($Abi -eq 'arm64-v8a') { 'aarch64-linux-android' } else { 'x86_64-linux-android' }
    Copy-Item "$Ndk/toolchains/llvm/prebuilt/$ndkHost/sysroot/usr/lib/$arch/libc++_shared.so" $libraries
    $strip = "$Ndk/toolchains/llvm/prebuilt/$ndkHost/bin/llvm-strip$(if ($IsWindows) { '.exe' })"
    Get-ChildItem $libraries -Filter '*.so' -File | ForEach-Object {
        Invoke-Checked $strip @('--strip-unneeded', $_.FullName)
    }
    $licenses = "$staging/assets/licenses"
    New-Item -ItemType Directory -Force $licenses | Out-Null
    Get-ChildItem "$root/artifacts/android-vcpkg/$triplet/share" -Filter copyright -Recurse -File | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $licenses "$($_.Directory.Name).txt")
    }
    Copy-Item "$Ndk/NOTICE.toolchain" "$licenses/NDK-toolchain.txt"
    Copy-Item "$root/node_modules/@babylonjs/lite/LICENSE" "$licenses/Babylon-Lite.txt"
    if ('ui:rml' -in $sceneFeatures) { Copy-Item "$rmlui/RmlUi-LICENSE.txt" $licenses }
    if ('audio:engine' -in $sceneFeatures) {
        Get-ChildItem $labsound -File | Where-Object { $_.Name -match '-(LICENSE|COPYING)\.txt$' } | Copy-Item -Destination $licenses
    }
    $hashes = Get-ChildItem $payload -Recurse -File | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($payload.Length) + ':' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    }
    $version = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($hashes -join "`n")))
    Set-Content "$staging/assets/payload.version" $version -NoNewline
    $gradle = if ($IsWindows) { "$sdl/android-project/gradlew.bat" } else { "$sdl/android-project/gradlew" }
    # Recreate the ZIP so incremental replacement cannot retain holes from larger libraries.
    $gradleApk = "$staging/gradle-app/outputs/apk/debug/app-debug.apk"
    Assert-PackageChild $staging $gradleApk
    if (Test-Path -LiteralPath $gradleApk) { Remove-Item -LiteralPath $gradleApk }
    Invoke-Checked $gradle @('-p', "$root/native/android", '--project-cache-dir', "$staging/gradle-cache",
        "-PbbliteStaging=$staging", "-PbbliteScene=$id", "-PbbliteMinSdk=$minSdk", "-PbbliteApplicationId=$ApplicationId", "-PbbliteSdlJava=$sdl/android-project/app/src/main/java", 'assembleDebug')
    $apk = "$staging/bblite-$id-$Abi.apk"
    Copy-Item $gradleApk $apk -Force
    @{ scene = $id; abi = $Abi; minSdk = $minSdk } | ConvertTo-Json | Set-Content "$staging/build.json"
    Write-Host "APK: $apk"
    if ($Install -or $Smoke) {
        $adb = if ($IsWindows) { "$Sdk/platform-tools/adb.exe" } else { "$Sdk/platform-tools/adb" }
        $selector = if ($Device) { @('-s', $Device) } else { @() }
        Invoke-Checked $adb ($selector + @('install', '-r', $apk))
        if ($Smoke) {
            $smokeArguments = @('tools/android-smoke.mjs', '--adb', $adb, '--output', "$staging/smoke", '--apk', $apk, '--app', $ApplicationId)
            if ($Device) { $smokeArguments += @('--device', $Device) }
            Invoke-Checked 'node' $smokeArguments
        } else {
            Invoke-Checked $adb ($selector + @('shell', 'am', 'force-stop', $ApplicationId))
            Invoke-Checked $adb ($selector + @('shell', 'am', 'start', '-W', '-n', "$ApplicationId/org.bblite.prototype.MainActivity"))
        }
    }
} finally { Pop-Location }
