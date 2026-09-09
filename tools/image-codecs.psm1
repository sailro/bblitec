$ErrorActionPreference = "Stop"

function Get-ImageCodecLicenses(
    [string]$ManifestPath,
    [string]$FeaturesText,
    [bool]$VisualCapture
) {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json -AsHashtable
    $list = [regex]::Match($FeaturesText, '(?m)^set\(BBLITE_IMAGE_CODECS\b([^)]*)\)')
    if (-not $list.Success) {
        throw "Generated features carry no BBLITE_IMAGE_CODECS list; regenerate the scene."
    }
    $items = $list.Groups[1].Value.Trim()
    if ($items -and $items -notmatch '^(?:"(?:[a-z][a-z0-9-]*)?"\s*)+$') {
        throw "Malformed BBLITE_IMAGE_CODECS list; regenerate the scene."
    }
    $reached = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($entry in [regex]::Matches($items, '"([a-z][a-z0-9-]*)"')) {
        [void]$reached.Add($entry.Groups[1].Value)
    }
    if ($VisualCapture) { [void]$reached.Add("png") }
    $licenses = @{}
    foreach ($codec in $reached) {
        $feature = $manifest.features[$codec]
        $metadata = if ($feature) { $feature['$bblite-image'] } else { $null }
        if ($metadata -isnot [System.Collections.IDictionary]) {
            throw "Unknown BBLITE_IMAGE_CODECS entry '$codec'; regenerate the scene."
        }
        if ($metadata.licenses -isnot [System.Collections.IDictionary] -or $metadata.licenses.Count -eq 0) {
            throw "Image codec '$codec' declares no package licenses."
        }
        $licenses['SDL3_image.txt'] = 'sdl3-image'
        foreach ($license in $metadata.licenses.GetEnumerator()) {
            $licenses[$license.Key] = $license.Value
        }
    }
    return $licenses
}

Export-ModuleMember -Function Get-ImageCodecLicenses
