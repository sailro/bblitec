$ErrorActionPreference = "Stop"

function Assert-PackageChild([string]$Root, [string]$Path) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $child = [IO.Path]::GetFullPath($Path)
    if (-not $child.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw "Package path escapes output root: $Path"
    }
    $cursor = $child
    while ($cursor -and $cursor -ne $rootPath) {
        if ((Test-Path -LiteralPath $cursor) -and
            ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Package path crosses a link or junction: $cursor"
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}

function New-PackageOutput([string]$Root, [string]$Name) {
    if ($Name -notmatch '^bblitec-[a-z0-9]+(?:-[a-z0-9]+)*-windows-x64$') {
        throw "Invalid package name: $Name"
    }
    $rootPath = [IO.Path]::GetFullPath($Root)
    $run = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N')
    $staging = Join-Path $rootPath ".staging/$run"
    $previous = Join-Path $rootPath ".replaced/$run"
    foreach ($path in @($staging, $previous)) { Assert-PackageChild $rootPath $path }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    return [pscustomobject]@{
        Root = $rootPath; Name = $Name; Staging = $staging; Previous = $previous
    }
}

# Called only after staged smoke and archive creation succeed. No prior package
# is removed; any failure during publication retains its files in .replaced.
function Publish-PackageOutput($Plan) {
    $names = @($Plan.Name, "$($Plan.Name).zip", "$($Plan.Name).json")
    foreach ($name in $names) {
        foreach ($parent in @($Plan.Staging, $Plan.Root, $Plan.Previous)) {
            Assert-PackageChild $Plan.Root (Join-Path $parent $name)
        }
        if (-not (Test-Path -LiteralPath (Join-Path $Plan.Staging $name))) {
            throw "Incomplete staged package: $name"
        }
    }
    foreach ($name in $names) {
        $current = Join-Path $Plan.Root $name
        if (Test-Path -LiteralPath $current) {
            New-Item -ItemType Directory -Path $Plan.Previous -Force | Out-Null
            Move-Item -LiteralPath $current -Destination (Join-Path $Plan.Previous $name)
        }
    }
    foreach ($name in $names) {
        Move-Item -LiteralPath (Join-Path $Plan.Staging $name) -Destination (Join-Path $Plan.Root $name)
    }
}

Export-ModuleMember -Function New-PackageOutput, Publish-PackageOutput, Assert-PackageChild
