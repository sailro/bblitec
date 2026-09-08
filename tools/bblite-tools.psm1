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

# An absolute path for a repository-relative or already absolute one.
function Resolve-RepositoryPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path, (Get-RepositoryRoot))
}

# The Visual Studio installation carrying the C++ tools: VSINSTALLDIR when
# it names one, otherwise the latest vswhere reports.
function Get-VisualStudioRoot {
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
# patch applied to the working tree by an earlier run (which the callers
# re-apply) never accumulates or blocks a changed patch.
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

# The `NAME:TYPE=value` entries of a CMakeCache.txt as a hashtable -- the
# PowerShell twin of `readCacheConfiguration` (src/build-stamp.ts).
function Read-CMakeCache([string]$Path) {
    $cache = @{}
    foreach ($line in Get-Content $Path) {
        if ($line -match '^([A-Za-z0-9_]+):[A-Z]+=(.*)$') {
            $cache[$Matches[1]] = $Matches[2].Trim()
        }
    }
    return $cache
}

Export-ModuleMember -Function @(
    "Get-RepositoryRoot",
    "Resolve-RepositoryPath",
    "Get-VisualStudioRoot",
    "Find-CMake",
    "Get-DevToolchain",
    "Sync-PinnedCheckout",
    "Read-CMakeCache"
)
