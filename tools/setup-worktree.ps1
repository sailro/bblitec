# Creates (or removes) a linked git worktree that shares this repository's
# disposable caches through directory junctions, so a second checkout builds
# without re-downloading or re-compiling any dependency.
#
# Shared through junctions (all disposable, all concurrency-safe: the
# tool trees are read-only pins, node_modules and the asset cache are
# written only by installs/downloads of identical content, and the shader
# and bake caches store temp-file-plus-rename):
#   node_modules                            npm install
#   .cache                                  downloaded corpus assets
#   artifacts\tools                         pinned Dawn / LabSound / RmlUi / Tint
#   artifacts\shader-cache                  content-addressed shader replays
#   artifacts\bake-cache                    content-addressed bake replays
#   tools\shader-compiler\vcpkg_installed   pinned DXC
#
# NOT shared by default: artifacts\vcpkg-installed. Concurrent vcpkg use of
# one install root is unreliable (docs/development.md), and worktrees exist
# here precisely so several agents can build at once — so each worktree
# pays one vcpkg install for that safety. Pass `-SharedVcpkg` to junction
# it too when you know the trees will never run native builds concurrently.
#
# Everything that carries per-checkout meaning stays local: sources, dist\,
# generated\, native build trees, and parity evidence.
#
# Never delete a worktree with a recursive remove: PowerShell's
# Remove-Item -Recurse follows junctions and would empty the shared caches
# of the MAIN checkout. Use `-Remove` here, which unlinks the junctions
# first and then runs `git worktree remove`.
#
# Usage:
#   tools\setup-worktree.ps1 -Path C:\Dev\bbl-fix -Branch my-branch
#   tools\setup-worktree.ps1 -Path C:\Dev\bbl-old -Commit 294fd23
#   tools\setup-worktree.ps1 -Path C:\Dev\bbl-fix -Remove
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Branch,
    [string]$Commit,
    [switch]$SharedVcpkg,
    [switch]$Remove
)
$ErrorActionPreference = "Stop"

# A relative or drive-relative path (a shell that ate the backslashes turns
# C:\Dev\tree into C:Devtree) would scatter the worktree and its junctions
# under whatever the current directory happens to be.
$Path = [System.IO.Path]::GetFullPath($Path, (Get-Location).Path)

# The main checkout's root, wherever this copy of the script runs from: the
# common git directory is always <main>\.git.
$scriptRepo = Split-Path -Parent $PSScriptRoot
$commonGitDir = git -C $scriptRepo rev-parse --path-format=absolute --git-common-dir
if ($LASTEXITCODE -ne 0) { throw "Not inside a git repository: $scriptRepo" }
$main = Split-Path -Parent $commonGitDir

$junctions = @(
    "node_modules",
    ".cache",
    "artifacts\tools",
    "artifacts\shader-cache",
    "artifacts\bake-cache",
    "tools\shader-compiler\vcpkg_installed"
)
if ($SharedVcpkg) { $junctions += "artifacts\vcpkg-installed" }

if ($Remove) {
    # Unlink every junction this script can have made, whether or not the
    # optional vcpkg share was requested at creation time.
    $junctions += "artifacts\vcpkg-installed"
    foreach ($relative in $junctions) {
        $link = Join-Path $Path $relative
        if (-not (Test-Path -LiteralPath $link)) { continue }
        $item = Get-Item -LiteralPath $link -Force
        if ($item.LinkType -ne "Junction") {
            throw "$link exists but is not a junction; refusing to touch it."
        }
        # Deletes the link itself, never its target's contents.
        $item.Delete()
    }
    git -C $main worktree remove $Path
    if ($LASTEXITCODE -ne 0) { throw "git worktree remove failed for $Path" }
    Write-Host "Removed worktree $Path."
    exit 0
}

if (-not (Test-Path -LiteralPath $Path)) {
    $addArguments = @("worktree", "add")
    if ($Branch) { $addArguments += @("-b", $Branch) }
    $addArguments += $Path
    if ($Commit) { $addArguments += $Commit }
    git -C $main @addArguments
    if ($LASTEXITCODE -ne 0) { throw "git worktree add failed for $Path" }
}

foreach ($relative in $junctions) {
    $link = Join-Path $Path $relative
    $target = Join-Path $main $relative
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if ($item.LinkType -eq "Junction") { continue }
        throw "$link already exists and is not a junction; move it aside first."
    }
    if (-not (Test-Path -LiteralPath $target)) {
        # Nothing to share yet (a cache the main checkout has not built);
        # create it there so both sides grow into the same directory.
        New-Item -ItemType Directory -Path $target -Force | Out-Null
    }
    $parent = Split-Path -Parent $link
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}

Push-Location $Path
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed in $Path" }
} finally {
    Pop-Location
}
Write-Host "Worktree $Path ready: caches shared with $main, dist built."
