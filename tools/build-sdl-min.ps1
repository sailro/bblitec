param(
    [string]$Workspace = "",
    [string]$OutputDirectory = "",
    [ValidateSet('', 'x86_64', 'arm64')][string]$MacArchitecture = '',
    [ValidateSet('', 'iphoneos')][string]$IosSdk = '',
    [switch]$EnableAudio,
    [switch]$EnableGamepad,
    [ValidateRange(0, 1024)][int]$Jobs = 0,
    [string]$CMake = $env:CMAKE_COMMAND
)

# Builds a subsystem-trimmed static SDL3 for minimal-size release
# packages. The version tracks the vcpkg-installed SDL3 so the trimmed
# library stays ABI-identical to the one SDL3_image was compiled
# against. The engine initializes only SDL_INIT_VIDEO|SDL_INIT_EVENTS
# and renders through SDL_GPU (D3D12 on Windows, Vulkan on Linux, Metal on macOS).
# Unreached joystick/HIDAPI, haptic, sensor, camera, power, GL plumbing
# and the SDL_Renderer core are compiled out entirely.
# SDL's portable dialog subsystem remains available for desktop browser:file scenes;
# iOS file dialogs use UIKit in PAL and do not need SDL_DIALOG.
# static dead stripping removes it from executables that do not reach the PAL.
# SDL_RENDER is one of them: bblitec requires a GPU and has no software
# renderer to link it for. Audio stays off by default; EnableAudio creates a
# separate feature-compatible install for generated scenes that reach it,
# and EnableGamepad likewise keeps joystick and HIDAPI for input:gamepad.

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force
$root = Get-RepositoryRoot
if ($IosSdk -and $MacArchitecture) { throw 'Select an iOS device or a macOS architecture, not both.' }
$targetSuffix = if ($IosSdk) { "-ios-$IosSdk-arm64" } elseif ($MacArchitecture) { "-$MacArchitecture" } else { '' }
$iosArguments = if ($IosSdk) { @(Get-IosCompilerArguments $IosSdk 'arm64') } else { @() }
if ($IosSdk -and [version](Invoke-Checked 'xcrun' @('--sdk', $IosSdk, '--show-sdk-version')) -lt [version]'16.4') {
    throw 'The pinned SDL_GPU backend requires iOS SDK 16.4 or newer.'
}
$enabledFeatures = @(
    if ($EnableAudio) { "audio" }
    if ($EnableGamepad) { "gamepad" }
)
# Preserves the established sdl-min-audio and sdl-min-gamepad directory names.
$featureSuffix = if ($enabledFeatures.Count -gt 0) {
    "-" + ($enabledFeatures -join "-")
} else {
    ""
}

if (-not $Workspace) {
    $Workspace = ".cache\sdl$featureSuffix$targetSuffix"
}
if (-not $OutputDirectory) {
    $OutputDirectory = "artifacts\tools\sdl-min$featureSuffix$targetSuffix"
}
$audioSetting = if ($EnableAudio) { "ON" } else { "OFF" }
$gamepadSetting = if ($EnableGamepad) { "ON" } else { "OFF" }
$dialogSetting = if ($IosSdk) { 'OFF' } else { 'ON' }
$variantFeatures = @("video", "events") + $(if (-not $IosSdk) { @("dialogs") } else { @() }) + $enabledFeatures + @("gpu")

# The version the overlay port pins, so the trimmed library stays
# ABI-identical to the one SDL3_image was compiled against.
$sdlVersion = (Get-Content (Join-Path $root "native/vcpkg-overlay-ports/sdl3/vcpkg.json") -Raw |
    ConvertFrom-Json).version
$repository = "https://github.com/libsdl-org/SDL.git"
$tag = "release-$sdlVersion"

$workspacePath = Resolve-RepositoryPath $Workspace
$source = Join-Path $workspacePath "source"
$build = Join-Path $workspacePath "build-min"
$output = Resolve-RepositoryPath $OutputDirectory
$CMake = Find-CMake $CMake

New-Item -ItemType Directory -Path $workspacePath, $output -Force |
    Out-Null
if (-not (Test-Path (Join-Path $source ".git"))) {
    git clone --depth 1 --branch $tag $repository $source
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to clone SDL $tag."
    }
} else {
    $current = git -C $source describe --tags --exact-match 2>$null
    if ($current -ne $tag) {
        git -C $source fetch --depth 1 origin "refs/tags/${tag}:refs/tags/$tag"
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to fetch SDL tag $tag."
        }
    }
}

# The `trimmed` series of native/patches/manifest.json: the overlay port's
# own patches (the vcpkg-installed SDL3 the parity numbers were measured
# against carries them) except vcpkg's FreeBSD packaging fix, plus the
# static build's dynamic-API switch.
$tagCommit = git -C $source rev-parse "$tag^{commit}"
if ($LASTEXITCODE -ne 0) {
    throw "Unable to resolve SDL tag $tag."
}
Sync-PatchedCheckout $source $repository $tagCommit "SDL $tag" sdl3 @("trimmed") $CMake | Out-Null

# SDL's surface code is linked whole through its blitter tables. The engine
# only converts decoded images (SDL_ConvertSurface, never blending): keep the
# indexed and N-to-N converters SDL_image's formats reach and compile out the
# blending, modulating and scaling blitters, RLE, YUV and SDL's own stb_image
# loader (SDL_internal.h's lean switches; the generic converter remains).
# SDL's targets drop /D flags given through CMAKE_C_FLAGS*, so the defines
# reach them as compile definitions from a project include.
$surfaceDefines = @("SDL_LEAN_AND_MEAN", "SDL_HAVE_BLIT_0", "SDL_HAVE_BLIT_1", "SDL_HAVE_BLIT_N", "SDL_DISABLE_STB")
New-Item -ItemType Directory -Path $build -Force | Out-Null
$surfaceInclude = Join-Path $build "bblite-surface-definitions.cmake"
Set-ArtifactContent $surfaceInclude "add_compile_definitions($($surfaceDefines -join ' '))`n"

# One table drives the configure and the check after it: every entry is
# passed as "-D<name>=<value>" and read back from the cache CMake wrote,
# so an option that reached CMake as PowerShell text instead of its value
# is refused before anything is compiled -- CMake's if() treats any
# non-false string as true, which would silently keep the subsystem. Each
# entry must also be one of SDL's own options: BOOL, or INTERNAL for a
# dependent option SDL forces on this platform. A name the pinned SDL does
# not declare stays UNINITIALIZED in the cache and trims nothing.
$sdlOptions = [ordered]@{
    SDL_SHARED = "OFF"
    SDL_STATIC = "ON"
    SDL_TEST_LIBRARY = "OFF"
    SDL_EXAMPLES = "OFF"
    SDL_AUDIO = $audioSetting
    SDL_JOYSTICK = $gamepadSetting
    SDL_HAPTIC = "OFF"
    SDL_HIDAPI = $gamepadSetting
    SDL_SENSOR = "OFF"
    SDL_CAMERA = "OFF"
    SDL_POWER = "OFF"
    SDL_DIALOG = $dialogSetting
    SDL_OPENGL = "OFF"
    SDL_OPENGLES = "OFF"
    SDL_VULKAN = $(if ($IsLinux) { "ON" } else { "OFF" })
    SDL_METAL = $(if ($IsMacOS) { "ON" } else { "OFF" })
    SDL_RENDER_GPU = "OFF"
    SDL_GPU = "ON"
    SDL_RENDER = "OFF"
    SDL_VIDEO = "ON"
}
$configureArguments = @(
    "-S", $source,
    "-B", $build,
    "-DCMAKE_BUILD_TYPE=MinSizeRel",
    "-DCMAKE_INSTALL_PREFIX=$output",
    "-DCMAKE_PROJECT_SDL3_INCLUDE=$($surfaceInclude.Replace('\', '/'))"
)
if ($IsWindows) {
    $configureArguments += @(
        '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>',
        '-DCMAKE_CXX_FLAGS_MINSIZEREL=/O1 /Ob1 /DNDEBUG /Gw /Zc:inline',
        '-DCMAKE_C_FLAGS_MINSIZEREL=/O1 /Ob1 /DNDEBUG /Gw'
    )
} else {
    $configureArguments += if ($IosSdk) { $iosArguments } else { @(Get-PosixCompilerArguments $MacArchitecture) }
    $configureArguments += @(
        "-G", "Ninja", "-DCMAKE_INSTALL_LIBDIR=lib",
        "-DCMAKE_C_FLAGS_MINSIZEREL=-Os -DNDEBUG -ffunction-sections -fdata-sections",
        "-DCMAKE_CXX_FLAGS_MINSIZEREL=-Os -DNDEBUG -ffunction-sections -fdata-sections"
    )
}
foreach ($option in $sdlOptions.GetEnumerator()) {
    $configureArguments += "-D$($option.Key)=$($option.Value)"
}
& $CMake @configureArguments
if ($LASTEXITCODE -ne 0) {
    throw "SDL minimal CMake configuration failed."
}

$cache = Read-CMakeCache (Join-Path $build "CMakeCache.txt") -WithTypes
foreach ($option in $sdlOptions.GetEnumerator()) {
    $entry = $cache[$option.Key]
    $actual = if ($entry) { $entry.Value } else { $null }
    if ($actual -ne $option.Value) {
        throw (
            "The SDL cache records $($option.Key)=$actual where " +
            "$($option.Value) was requested; the option did not reach " +
            "CMake as a value. Refusing to build a mis-trimmed SDL."
        )
    }
    if ($entry.Type -notin @("BOOL", "INTERNAL")) {
        throw (
            "The SDL cache records $($option.Key) as $($entry.Type), " +
            "not an option: SDL $sdlVersion declares no such setting, so it " +
            "trims nothing. Remove it from the option table."
        )
    }
}
$unexpanded = @(
    $cache.GetEnumerator() |
        Where-Object { $_.Key -like "SDL_*" -and $_.Value.Value.Contains('$') }
)
if ($unexpanded.Count -gt 0) {
    $listing = ($unexpanded | ForEach-Object { "$($_.Key)=$($_.Value.Value)" }) -join ", "
    throw "SDL cache entries hold unexpanded script text: $listing"
}

$parallelArguments = Get-BuildParallelArguments $Jobs
& $CMake --build $build --config MinSizeRel @parallelArguments
if ($LASTEXITCODE -ne 0) {
    throw "SDL minimal build failed."
}

& $CMake --install $build --config MinSizeRel
if ($LASTEXITCODE -ne 0) {
    throw "SDL minimal install failed."
}

Copy-ArtifactItem (Join-Path $source "LICENSE.txt") (Join-Path $output "LICENSE.txt")

# The notices a package of this library owes: SDL's own licence plus the
# third-party code the trimmed library still compiles -- with -EnableGamepad,
# HIDAPI. The YUV converters and stb_image are compiled out above; vcpkg's
# SDL3 copyright carries their notices for its own build.
$notices = @("SDL $sdlVersion (LICENSE.txt)", (Get-Content (Join-Path $source "LICENSE.txt") -Raw))
if ($EnableGamepad) {
    $notices += @("src/hidapi (LICENSE-bsd.txt)", (Get-Content (Join-Path $source "src/hidapi/LICENSE-bsd.txt") -Raw))
}
$noticeText = for ($index = 0; $index -lt $notices.Count; $index += 2) {
    "$($notices[$index]):`n`n$($notices[$index + 1].Trim())`n"
}
Set-ArtifactContent (Join-Path $output "NOTICES.txt") ((($noticeText -join "`n")) + "`n")

# Native configuration reads this before project() to reject a generated
# scene whose reached feature set is incompatible with the selected trimmed
# dependency. Keep the capability machine-readable rather than inferring it
# from an install-directory name or from a prose provenance field. The patch
# record is compared with the pin and the manifest the same way
# (native/patch-identity.cmake).
$record = @(
    "set(BBLITE_SDL_AUDIO $audioSetting)"
    "set(BBLITE_SDL_GAMEPAD $gamepadSetting)"
    "set(BBLITE_SDL_DIALOG $dialogSetting)"
    "set(BBLITE_SDL_VULKAN $($sdlOptions.SDL_VULKAN))"
    "set(BBLITE_SDL_METAL $($sdlOptions.SDL_METAL))"
) + @(Get-PatchRecord sdl3 @("trimmed") $CMake)
Set-ArtifactContent (Join-Path $output "bblite-sdl-features.cmake") (($record -join "`n") + "`n")

@{
    repository = $repository
    tag = $tag
    version = $sdlVersion
    variant = "static, MinSizeRel, $($variantFeatures -join '+') only"
    vulkan = $IsLinux
    metal = $IsMacOS
    staticRuntime = $IsWindows
    iosSdk = $IosSdk
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content (Join-Path $output "provenance.json")

Write-Output "Built minimal SDL $sdlVersion into $output."
