# Creates or removes a linked worktree whose disposable caches are junctions
# to the main checkout's (docs/development.md#native-builds).
#
#   tools\setup-worktree.ps1 -Path C:\Dev\bbl-fix -Branch my-branch [-Commit 294fd23] [-SharedVcpkg]
#   tools\setup-worktree.ps1 -Path C:\Dev\bbl-old -Commit 294fd23
#   tools\setup-worktree.ps1 -Path C:\Dev\bbl-fix -Remove
#
# Never delete a worktree with a recursive remove: it follows the junctions
# and empties the main checkout's caches. -Remove unlinks them first.
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
    "artifacts\native-cache",
    "tools\shader-compiler\vcpkg_installed"
)

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

if ($SharedVcpkg) { $junctions += "artifacts\vcpkg-installed" }
foreach ($relative in $junctions) {
    $link = Join-Path $Path $relative
    $target = Join-Path $main $relative
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if ($item.LinkType -eq "Junction") { continue }
        throw "$link already exists and is not a junction; move it aside first."
    }
    # -Force tolerates an existing directory; a cache the main checkout has
    # not built yet is created there so both sides grow into one directory.
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $link) -Force |
        Out-Null
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
