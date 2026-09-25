# The one PowerShell copy of what every dependency build script and the
# packager need: where the repository is, which CMake to run, how a pinned
# checkout is brought to its commit, how the development toolchain is
# composed, and how a CMake cache is read back. `src/development-tools.ts`
# is the TypeScript twin of the discovery half (`discoverWindowsBuildTools`,
# `discoverDevelopmentTools`); keep the two in step. Scripts import this
# module with
#
#     Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force
#
# after their param() block.

$ErrorActionPreference = "Stop"

# The repository root: this module lives in tools/.
function Get-RepositoryRoot {
    return Split-Path -Parent $PSScriptRoot
}

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed ($LASTEXITCODE)." }
}

function Build-DependencyArtifact(
    [string]$Name, [string]$Output, [string[]]$Identity, [string[]]$Inputs,
    [string[]]$Required, [scriptblock]$Build
) {
    $fingerprint = (@($Identity) + @(
        $Inputs + @("$PSScriptRoot/bblite-tools.psm1") | Sort-Object -Unique |
            ForEach-Object { "$_=" + (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
    )) -join "`n"
    $stamp = Join-Path $Output 'dependency-build-inputs.txt'
    if ((Test-Path $stamp) -and (Get-Content $stamp -Raw) -eq $fingerprint -and
        @($Required | Where-Object { -not (Test-Path (Join-Path $Output $_)) }).Count -eq 0) {
        Write-Host "$Name artifact is current."
        return
    }
    & $Build
    foreach ($file in $Required) {
        if (-not (Test-Path (Join-Path $Output $file))) { throw "$Name build did not produce $file." }
    }
    Set-Content $stamp $fingerprint -NoNewline
}

# An absolute path for a repository-relative or already absolute one.
function Resolve-RepositoryPath([string]$Path) {
    if (-not $IsWindows) { $Path = $Path.Replace('\', '/') }
    return [System.IO.Path]::GetFullPath($Path, (Get-RepositoryRoot))
}

# Refuses a path a script is about to delete or replace unless it lies under
# $Root without crossing a link or junction on the way.
function Assert-ContainedPath([string]$Root, [string]$Path) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $child = [IO.Path]::GetFullPath($Path)
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if (-not $child.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw "Path escapes its root: $Path"
    }
    $cursor = $child
    while ($cursor -and $cursor -ne $rootPath) {
        if ((Test-Path -LiteralPath $cursor) -and
            ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Path crosses a link or junction: $cursor"
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}

# The Visual Studio installation carrying the C++ tools: VSINSTALLDIR when
# it names one, otherwise the latest vswhere reports.
function Get-VisualStudioRoot {
    if (-not $IsWindows) { return $null }
    if ($env:VSINSTALLDIR) {
        $fromEnvironment = $env:VSINSTALLDIR.TrimEnd("\", "/")
        if (Test-Path (Join-Path $fromEnvironment "VC\Tools\MSVC")) {
            return $fromEnvironment
        }
    }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} `
        "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $null }
    $vsRoot = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
    if ($vsRoot -and (Test-Path (Join-Path $vsRoot "VC\Tools\MSVC"))) {
        return $vsRoot
    }
    return $null
}

# The CMake every script runs: an explicit path, CMAKE_COMMAND, the one on
# PATH, then the Visual Studio bundle -- the same order the TypeScript twin
# resolves it in.
function Find-CMake([string]$Requested = "") {
    $candidate = if ($Requested) { $Requested } else { $env:CMAKE_COMMAND }
    if (-not $candidate) {
        $command = Get-Command cmake -ErrorAction SilentlyContinue
        if ($command) { $candidate = $command.Source }
    }
    if (-not $candidate) {
        $vsRoot = Get-VisualStudioRoot
        if ($vsRoot) {
            $bundled = Join-Path $vsRoot `
                "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
            if (Test-Path $bundled) { $candidate = $bundled }
        }
    }
    if (-not $candidate -or -not (Test-Path $candidate)) {
        throw "CMake was not found. Set CMAKE_COMMAND or pass -CMake."
    }
    return $candidate
}

# The development scene builds select clang-cl when Visual Studio ships it
# (MSVC otherwise), with the MSVC and Windows SDK directories composed onto
# PATH/INCLUDE/LIB exactly as `discoverWindowsBuildTools` composes them. A
# dependency built for those consumers must be built the same way: RmlUi
# is a header-inlining-heavy C++ static library, and an MSVC-built archive
# linked into clang-cl consumers crashed inside `Context::Render`.
# $null when the toolchain is not installed.
function Get-DevToolchain {
    $vsRoot = Get-VisualStudioRoot
    if (-not $vsRoot) { return $null }
    $clang = Join-Path $vsRoot "VC\Tools\Llvm\x64\bin\clang-cl.exe"
    $ninja = Join-Path $vsRoot `
        "Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
    if (-not (Test-Path $clang) -or -not (Test-Path $ninja)) { return $null }
    $msvc = Get-ChildItem (Join-Path $vsRoot "VC\Tools\MSVC") -Directory |
        Sort-Object Name | Select-Object -Last 1
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10"
    $sdk = Get-ChildItem (Join-Path $sdkRoot "Include") -Directory |
        Sort-Object Name | Select-Object -Last 1
    if (-not $msvc -or -not $sdk) { return $null }
    [pscustomobject]@{
        Clang = $clang
        Ninja = $ninja
        Path = @(
            (Split-Path $clang),
            (Join-Path $msvc.FullName "bin\Hostx64\x64"),
            (Join-Path $sdkRoot "bin\$($sdk.Name)\x64"),
            (Split-Path $ninja)
        ) -join ";"
        Include = @(
            (Join-Path $msvc.FullName "include"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\ucrt"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\shared"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\um"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\winrt"),
            (Join-Path $sdkRoot "Include\$($sdk.Name)\cppwinrt")
        ) -join ";"
        Lib = @(
            (Join-Path $msvc.FullName "lib\x64"),
            (Join-Path $sdkRoot "Lib\$($sdk.Name)\ucrt\x64"),
            (Join-Path $sdkRoot "Lib\$($sdk.Name)\um\x64")
        ) -join ";"
    }
}

# Brings a disposable checkout under $Path to exactly $Commit of
# $Repository: initialized on first use, fetched only when the commit is
# not yet present, and always reset with a forced detached checkout so a
# patch applied to the working tree by an earlier run (which
# Sync-PatchedCheckout re-applies) never accumulates or blocks a changed patch.
function Sync-PinnedCheckout(
    [string]$Path,
    [string]$Repository,
    [string]$Commit,
    [string]$Label
) {
    if (-not (Test-Path (Join-Path $Path ".git"))) {
        git init $Path
        git -C $Path remote add origin $Repository
        git -C $Path config core.longpaths true
    }
    git -C $Path cat-file -e "$Commit^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) {
        git -C $Path fetch --depth 1 origin $Commit
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to fetch pinned $Label commit $Commit."
        }
    }
    git -C $Path checkout --force --detach $Commit
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to check out pinned $Label commit $Commit."
    }
}

# Runs native/patch-identity.cmake, the one owner of the maintained patch
# series and of the record an artifact carries, and returns the lines it wrote.
function Invoke-PatchIdentity(
    [ValidateSet('series', 'record')][string]$Action,
    [string]$Library,
    [string[]]$Variants = @(),
    [string]$CMake = ""
) {
    $cmakePath = Find-CMake $CMake
    $output = [IO.Path]::GetTempFileName()
    try {
        & $cmakePath "-DBBLITE_PATCH_ACTION=$Action" "-DBBLITE_PATCH_LIBRARY=$Library" `
            "-DBBLITE_PATCH_VARIANTS=$(@($Variants) -join ';')" "-DBBLITE_PATCH_OUTPUT=$output" `
            -P (Join-Path (Get-RepositoryRoot) "native/patch-identity.cmake") | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "native/patch-identity.cmake $Action $Library failed ($LASTEXITCODE)." }
        return @(Get-Content -LiteralPath $output | Where-Object { $_ -ne "" })
    } finally {
        Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
    }
}

# The maintained patches of one library that a build for $Variants applies,
# in application order (native/patches/manifest.json).
function Get-MaintainedPatches([string]$Library, [string[]]$Variants = @(), [string]$CMake = "") {
    return @(Invoke-PatchIdentity series $Library $Variants $CMake | ForEach-Object {
        [pscustomobject]@{ Name = Split-Path -Leaf $_; Path = $_ }
    })
}

# The files a $Library artifact built for $Variants depends on: its pin file
# and builder (native/patches/manifest.json), the manifest, the patch-identity
# owner and the patches the build applies. Build-DependencyArtifact's inputs.
function Get-DependencyInputs([string]$Library, [string[]]$Variants = @(), [string]$CMake = "") {
    $root = Get-RepositoryRoot
    $manifestPath = Join-Path $root 'native/patches/manifest.json'
    $definition = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).libraries.$Library
    if (-not $definition -or -not $definition.builder) {
        throw "native/patches/manifest.json names no builder for '$Library'."
    }
    return @(
        (Join-Path $root $definition.pin.file),
        (Join-Path $root $definition.builder),
        $manifestPath,
        (Join-Path $root 'native/patch-identity.cmake')
    ) + @(Get-MaintainedPatches $Library $Variants $CMake | ForEach-Object Path)
}

# Applies patches to a checkout its builder has just reset to the pin. Each
# one is staged, so the next forced checkout also removes files an earlier
# version of a patch added; a patch that does not apply is a refusal, and
# git applies each patch whole or not at all.
function Install-MaintainedPatches([string]$Source, [object[]]$Patches, [string]$Label) {
    foreach ($patch in $Patches) {
        if (-not (Test-Path -LiteralPath $patch.Path)) { throw "$Label patch not found: $($patch.Path)" }
        & git -C $Source apply --index $patch.Path
        if ($LASTEXITCODE -ne 0) { throw "$Label patch $($patch.Name) does not apply to the pinned source at $Source." }
        Write-Host "Applied $Label patch $($patch.Name)."
    }
}

# The CMake lines the record of a $Library artifact built for $Variants
# carries: its pinned source, each applied patch as name=sha256 in application
# order, and the variants (native/patch-identity.cmake).
function Get-PatchRecord([string]$Library, [string[]]$Variants = @(), [string]$CMake = "") {
    return @(Invoke-PatchIdentity record $Library $Variants $CMake)
}

# What a checkout at $Commit with $Record's series staged records: empty when
# HEAD is elsewhere or an unstaged edit sits over the staged series.
function Get-AppliedSeriesState([string]$Path, [string]$Commit, [string[]]$Record) {
    $head = git -C $Path rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or $head -ne $Commit) { return "" }
    git -C $Path diff --quiet
    if ($LASTEXITCODE -ne 0) { return "" }
    $tree = git -C $Path write-tree
    if ($LASTEXITCODE -ne 0) { return "" }
    return (@($Record) + "tree=$tree") -join "`n"
}

# Brings the disposable checkout at $Path to $Commit of $Repository with the
# maintained series of $Library for $Variants applied, and returns that series.
# The applied series and the tree it staged are recorded in the checkout's git
# directory; a checkout still carrying exactly that state is left as it
# stands, because a forced checkout and a re-applied series would give every
# patched file a new timestamp and recompile the library and its consumers.
# The record is removed before the source is reset and written only once the
# whole series applied.
function Sync-PatchedCheckout(
    [string]$Path,
    [string]$Repository,
    [string]$Commit,
    [string]$Label,
    [string]$Library,
    [string[]]$Variants = @(),
    [string]$CMake = ""
) {
    $patches = @(Get-MaintainedPatches $Library $Variants $CMake)
    $record = @(Get-PatchRecord $Library $Variants $CMake)
    $statePath = Join-Path $Path ".git/bblite-applied-series.txt"
    $recorded = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw } else { "" }
    if ($recorded -and $recorded -ceq (Get-AppliedSeriesState $Path $Commit $record)) {
        Write-Host "$Label $Commit already carries its maintained series."
        return $patches
    }
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
    Sync-PinnedCheckout $Path $Repository $Commit $Label | Out-Host
    Install-MaintainedPatches $Path $patches $Label | Out-Host
    Set-Content -LiteralPath $statePath -Value (Get-AppliedSeriesState $Path $Commit $record) -NoNewline -Encoding utf8NoBOM
    return $patches
}

# Writes $Value to $Path only when its bytes differ, so a warm rebuild leaves
# an artifact's files, and the timestamps its consumers' builds compare, alone.
function Set-ArtifactContent([string]$Path, [string]$Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and
        [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($Path), [byte[]]$bytes)) {
        return
    }
    [IO.File]::WriteAllBytes($Path, $bytes)
}

# Copies the file or directory tree $Source to $Destination, rewriting only
# the files whose bytes differ (Set-ArtifactContent's rule).
function Copy-ArtifactItem([string]$Source, [string]$Destination) {
    $files = if (Test-Path -LiteralPath $Source -PathType Leaf) {
        @([pscustomobject]@{ From = $Source; To = $Destination })
    } elseif (Test-Path -LiteralPath $Source -PathType Container) {
        @(Get-ChildItem -LiteralPath $Source -Recurse -File | ForEach-Object {
            [pscustomobject]@{
                From = $_.FullName
                To = Join-Path $Destination ([IO.Path]::GetRelativePath($Source, $_.FullName))
            }
        })
    } else {
        throw "Artifact input not found: $Source"
    }
    foreach ($file in $files) {
        if ((Test-Path -LiteralPath $file.To -PathType Leaf) -and
            (Get-Item -LiteralPath $file.To).Length -eq (Get-Item -LiteralPath $file.From).Length -and
            (Get-FileHash -LiteralPath $file.To).Hash -eq (Get-FileHash -LiteralPath $file.From).Hash) {
            continue
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $file.To) -Force | Out-Null
        Copy-Item -LiteralPath $file.From -Destination $file.To -Force
    }
}

# The `NAME:TYPE=value` entries of a CMakeCache.txt as a hashtable of values
# -- the PowerShell twin of `readCacheConfiguration` (src/build-stamp.ts).
# -WithTypes maps each name to its Value and Type instead: BOOL, STRING,
# INTERNAL, or UNINITIALIZED for a -D the project never declared.
function Read-CMakeCache([string]$Path, [switch]$WithTypes) {
    $cache = @{}
    foreach ($line in Get-Content $Path) {
        if ($line -match '^([A-Za-z0-9_]+):([A-Z]+)=(.*)$') {
            $value = $Matches[3].Trim()
            $cache[$Matches[1]] = if ($WithTypes) {
                [pscustomobject]@{ Value = $value; Type = $Matches[2] }
            } else {
                $value
            }
        }
    }
    return $cache
}

# Match Unix scene builds; explicit CC/CXX select a compatible host toolchain.
function Get-PosixCompilerArguments([ValidateSet('', 'x86_64', 'arm64')][string]$MacArchitecture = '') {
    if ($MacArchitecture -and -not $IsMacOS) { throw '-MacArchitecture requires macOS.' }
    if (-not $IsLinux -and -not $IsMacOS) { return @() }
    $ccName = if ($env:CC) { $env:CC } else { "clang" }
    $cxxName = if ($env:CXX) { $env:CXX } else { "clang++" }
    $ccTool = Get-Command $ccName -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $cxxTool = Get-Command $cxxName -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $arguments = @("-DCMAKE_C_COMPILER=$($ccTool.Source)", "-DCMAKE_CXX_COMPILER=$($cxxTool.Source)")
    if ($IsMacOS) {
        $arguments += @("-DCMAKE_OBJC_COMPILER=$($ccTool.Source)", "-DCMAKE_OBJCXX_COMPILER=$($cxxTool.Source)")
        if ($MacArchitecture) { $arguments += "-DCMAKE_OSX_ARCHITECTURES=$MacArchitecture" }
    }
    return $arguments
}

function Get-AndroidCompilerArguments([string]$Abi, [string]$Ndk) {
    if ($Abi -notin @('arm64-v8a', 'x86_64')) { throw 'Android requires arm64-v8a or x86_64.' }
    if (-not $Ndk -or -not (Test-Path "$Ndk/build/cmake/android.toolchain.cmake")) {
        throw 'Set ANDROID_NDK_HOME or -AndroidNdk to an installed NDK.'
    }
    $arguments = @('-G', 'Ninja', "-DCMAKE_TOOLCHAIN_FILE=$Ndk/build/cmake/android.toolchain.cmake",
        "-DANDROID_ABI=$Abi", '-DANDROID_PLATFORM=android-28', '-DANDROID_STL=c++_shared',
        '-DCMAKE_POSITION_INDEPENDENT_CODE=ON')
    $hostTools = Get-DevToolchain
    if ($hostTools) { $arguments += "-DCMAKE_MAKE_PROGRAM=$($hostTools.Ninja)" }
    return $arguments
}

function Get-IosCompilerArguments(
    [ValidateSet('iphoneos', 'iphonesimulator')][string]$Sdk,
    [ValidateSet('x86_64', 'arm64')][string]$Architecture
) {
    if (-not $IsMacOS) { throw 'iOS builds require macOS and a full Xcode installation.' }
    if ($Sdk -eq 'iphoneos' -and $Architecture -ne 'arm64') { throw 'iOS devices require arm64.' }
    $sdkPath = & xcrun --sdk $Sdk --show-sdk-path
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sdkPath)) {
        throw "Xcode SDK $Sdk is unavailable. Set DEVELOPER_DIR to Xcode.app/Contents/Developer."
    }
    return @(Get-PosixCompilerArguments) + @(
        '-G', 'Ninja', '-DCMAKE_SYSTEM_NAME=iOS',
        "-DCMAKE_OSX_SYSROOT=$sdkPath", "-DCMAKE_SYSROOT=$sdkPath", "-DCMAKE_OSX_ARCHITECTURES=$Architecture",
        '-DCMAKE_OSX_DEPLOYMENT_TARGET=16.0',
        '-DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO'
    )
}

function Get-BuildParallelArguments([int]$Jobs = 0) {
    if (-not $Jobs -and $env:CMAKE_BUILD_PARALLEL_LEVEL) {
        $Jobs = [int]$env:CMAKE_BUILD_PARALLEL_LEVEL
        if ($Jobs -lt 1) { throw "CMAKE_BUILD_PARALLEL_LEVEL must be a positive integer." }
    }
    if ($Jobs) { return @("--parallel", "$Jobs") }
    # The comma keeps a one-element array an array: a bare @("--parallel")
    # unrolls to a string, and splatting a string passes one character each.
    return , @("--parallel")
}

Export-ModuleMember -Function @(
    "Get-RepositoryRoot",
    "Invoke-Checked",
    "Build-DependencyArtifact",
    "Resolve-RepositoryPath",
    "Get-VisualStudioRoot",
    "Find-CMake",
    "Get-DevToolchain",
    "Sync-PinnedCheckout",
    "Sync-PatchedCheckout",
    "Get-MaintainedPatches",
    "Get-DependencyInputs",
    "Install-MaintainedPatches",
    "Get-PatchRecord",
    "Set-ArtifactContent",
    "Copy-ArtifactItem",
    "Assert-ContainedPath",
    "Read-CMakeCache",
    "Get-BuildParallelArguments"
    "Get-PosixCompilerArguments"
    "Get-AndroidCompilerArguments"
    "Get-IosCompilerArguments"
)
