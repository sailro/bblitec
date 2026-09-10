param([string]$OutputDirectory = "artifacts\tools\ccache")

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force
$root = Get-RepositoryRoot
$pin = Get-Content -LiteralPath (Join-Path $root "upstream\ccache.json") -Raw | ConvertFrom-Json
$output = Resolve-RepositoryPath $OutputDirectory
$download = Join-Path $root ".cache\ccache\$($pin.version)"
New-Item -ItemType Directory -Path $output, $download -Force | Out-Null
$archive = Join-Path $download "ccache.zip"
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $pin.url -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $pin.sha256) {
    throw "ccache archive checksum mismatch: $archive"
}
Expand-Archive -LiteralPath $archive -DestinationPath $download -Force
Copy-Item -LiteralPath (Join-Path $download "$($pin.directory)\ccache.exe") -Destination (Join-Path $output "ccache.exe") -Force
& (Join-Path $output "ccache.exe") --version
if ($LASTEXITCODE -ne 0) { throw "ccache installation check failed" }
