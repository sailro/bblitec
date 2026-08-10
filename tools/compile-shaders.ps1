param(
    [string]$Dxc = $env:DXC_PATH,
    [string]$Tint = $env:TINT_PATH,
    [string]$Scene
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$shaderDirectories = if ($Scene) {
    @((Join-Path $root "generated\$Scene\upstream\shaders"))
} else {
    @(
        Get-ChildItem (Join-Path $root "generated") -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "upstream\shaders" } |
            Where-Object { Test-Path $_ }
    )
}
$shaderDirectories = @($shaderDirectories | Where-Object { Test-Path $_ })
if ($shaderDirectories.Count -eq 0) {
    throw "No generated shader directories found. Run a compile:<scene> command first."
}

if (-not $Dxc) {
    $local = Join-Path $root "tools\shader-compiler\vcpkg_installed\x64-windows\tools\directx-dxc\dxc.exe"
    if (Test-Path $local) {
        $Dxc = $local
    } else {
        $command = Get-Command dxc -ErrorAction SilentlyContinue
        if ($command) {
            $Dxc = $command.Source
        }
    }
}

if (-not $Dxc -or -not (Test-Path $Dxc)) {
    throw "SPIR-V-capable dxc not found. Install tools/shader-compiler/vcpkg.json or set DXC_PATH."
}
if (-not $Tint) {
    $tintExecutable = if ($IsWindows) { "tint.exe" } else { "tint" }
    $localTint = Join-Path $root "artifacts\tools\tint\$tintExecutable"
    if (Test-Path $localTint) {
        $Tint = $localTint
    }
}
if ($Tint -and -not (Test-Path $Tint)) {
    throw "Tint compiler not found: $Tint"
}
$nativeWgslFiles = @(
    $shaderDirectories |
        ForEach-Object {
            Get-ChildItem $_ -Filter "*.native.wgsl"
        }
)
if ($nativeWgslFiles.Count -gt 0 -and -not $Tint) {
    throw "Reached WGSL shaders require pinned Tint. Run tools/build-tint.ps1 or set TINT_PATH."
}

$env:PATH = "$(Split-Path -Parent $Dxc);$env:PATH"

$cacheRoot = Join-Path $root "artifacts\shader-cache"
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
$dxilFlags = @("-O3")
$spirvFlags = @(
    "-spirv",
    "-fspv-target-env=vulkan1.0",
    "-O3"
)

function Get-StringSha256 {
    param([string]$Value)

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [Convert]::ToHexString(
            $hasher.ComputeHash($bytes)
        ).ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
}

$compilerFiles = @(
    $Dxc,
    (Join-Path (Split-Path -Parent $Dxc) "dxcompiler.dll"),
    (Join-Path (Split-Path -Parent $Dxc) "dxil.dll")
) |
    Where-Object { Test-Path $_ } |
    Sort-Object -Unique
$compilerIdentity = @(
    $compilerFiles |
        ForEach-Object {
            "$([System.IO.Path]::GetFileName($_)):$((Get-FileHash $_ -Algorithm SHA256).Hash)"
        }
) -join "|"
$compilerHash = Get-StringSha256 $compilerIdentity
$cacheFlagIdentity =
    "dxil:$($dxilFlags -join ',')|spirv:$($spirvFlags -join ',')"

function Get-ShaderCacheKey {
    param(
        [System.IO.FileInfo]$Source,
        [string]$Profile,
        [string]$EntryPoint
    )

    $sourceHash = (Get-FileHash $Source.FullName -Algorithm SHA256).Hash
    $payload =
        "$compilerHash|$Profile|$EntryPoint|$cacheFlagIdentity|$sourceHash"
    return Get-StringSha256 $payload
}

function Test-ShaderCacheBinary {
    param(
        [string]$Path,
        [ValidateSet("dxil", "spirv")]
        [string]$Kind
    )

    if (-not (Test-Path $Path)) {
        return $false
    }
    $file = Get-Item $Path
    if ($file.Length -lt 4) {
        return $false
    }
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $magic = [byte[]]::new(4)
        if ($stream.Read($magic, 0, 4) -ne 4) {
            return $false
        }
        if ($Kind -eq "dxil") {
            return (
                $magic[0] -eq 0x44 -and
                $magic[1] -eq 0x58 -and
                $magic[2] -eq 0x42 -and
                $magic[3] -eq 0x43
            )
        }
        return (
            $magic[0] -eq 0x03 -and
            $magic[1] -eq 0x02 -and
            $magic[2] -eq 0x23 -and
            $magic[3] -eq 0x07
        )
    } finally {
        $stream.Dispose()
    }
}

function Normalize-TintHlslBindings {
    param([string]$Path)

    $source = Get-Content $Path -Raw
    $matches = [regex]::Matches(
        $source,
        "register\(([tsbu])(\d+), space(\d+)\)"
    )
    $mapping = @{}
    foreach ($registerClass in @("t", "s", "b", "u")) {
        foreach (
            $space in @(
                $matches |
                    Where-Object {
                        $_.Groups[1].Value -eq $registerClass
                    } |
                    ForEach-Object { [int]$_.Groups[3].Value } |
                    Sort-Object -Unique
            )
        ) {
            $indices = @(
                $matches |
                    Where-Object {
                        $_.Groups[1].Value -eq $registerClass -and
                        [int]$_.Groups[3].Value -eq $space
                    } |
                    ForEach-Object { [int]$_.Groups[2].Value } |
                    Sort-Object -Unique
            )
            for ($index = 0; $index -lt $indices.Count; $index += 1) {
                $mapping["$registerClass`:$space`:$($indices[$index])"] =
                    $index
            }
        }
    }
    $normalized = [regex]::Replace(
        $source,
        "register\(([tsbu])(\d+), space(\d+)\)",
        {
            param($match)
            $registerClass = $match.Groups[1].Value
            $original = [int]$match.Groups[2].Value
            $space = [int]$match.Groups[3].Value
            $mapped = $mapping["$registerClass`:$space`:$original"]
            return "register($registerClass$mapped, space$space)"
        }
    )
    $normalized = [regex]::Replace(
        $normalized,
        "struct (\w+_(?:inputs|outputs)) \{\r?\n(?<body>[\s\S]*?)\r?\n\};",
        {
            param($match)
            $lines = @(
                $match.Groups["body"].Value -split "\r?\n" |
                    Where-Object { $_.Trim().Length -gt 0 }
            )
            $position = @(
                $lines |
                    Where-Object { $_ -match ":\s*SV_Position" }
            )
            $user = @($lines | Where-Object { $_ -notmatch ":\s*SV_" })
            $otherSystem = @(
                $lines |
                    Where-Object {
                        $_ -match ":\s*SV_" -and
                        $_ -notmatch ":\s*SV_Position"
                    }
            )
            return "struct $($match.Groups[1].Value) {`n$(
                ($position + $user + $otherSystem) -join "`n"
            )`n};"
        }
    )
    $normalized = [regex]::Replace(
        $normalized,
        "(\w+_outputs\s+\w+\s*=\s*\{)(?<values>[^{}]*)(?<suffix>\};)",
        {
            param($match)
            $values = @(
                $match.Groups["values"].Value -split "," |
                    ForEach-Object { $_.Trim() }
            )
            $position = @(
                $values | Where-Object { $_ -match "\.position$" }
            )
            if ($position.Count -ne 1) {
                return $match.Value
            }
            $others = @(
                $values | Where-Object { $_ -notmatch "\.position$" }
            )
            return "$($match.Groups[1].Value)$(
                ($position + $others) -join ", "
            )$($match.Groups["suffix"].Value)"
        }
    )
    $normalized = $normalized -replace "\bdiscard;", "clip(-1.0f);"
    Set-Content $Path $normalized
}

$compiled = 0
$reused = 0
$usedTint = $false
foreach ($shaderDirectory in $shaderDirectories) {
    $directoryNativeWgsl = @(
        Get-ChildItem $shaderDirectory -Filter "*.native.wgsl"
    )
    if ($directoryNativeWgsl.Count -gt 0) {
        $usedTint = $true
        foreach ($source in $directoryNativeWgsl) {
            $outputBase = $source.FullName.Substring(
                0,
                $source.FullName.Length - ".native.wgsl".Length
            )
            $entryPoint = if ($outputBase.EndsWith(".vert")) {
                "mainVertex"
            } else {
                "mainFragment"
            }
            $reflection = & $Tint $source.FullName `
                --entry-point $entryPoint `
                --format hlsl `
                --output-name "$outputBase.hlsl" `
                --dump-inspector-bindings true 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "Tint HLSL generation failed for $($source.FullName)."
            }
            $reflectionText = $reflection -join [Environment]::NewLine
            $reflectionText |
                Set-Content "$outputBase.tint-reflection.txt"
            $wgsl = Get-Content $source.FullName -Raw
            $expectedBindings = @(
                [regex]::Matches(
                    $wgsl,
                    "@group\((\d+)u?\)\s*@binding\((\d+)u?\)"
                ) |
                    ForEach-Object {
                        "$($_.Groups[1].Value):$($_.Groups[2].Value)"
                    } |
                    Sort-Object -Unique
            )
            $actualBindings = @(
                [regex]::Matches(
                    $reflectionText,
                    "\[(\d+)\]\[(\d+)\]"
                ) |
                    ForEach-Object {
                        "$($_.Groups[1].Value):$($_.Groups[2].Value)"
                    } |
                    Sort-Object -Unique
            )
            if (
                Compare-Object $expectedBindings $actualBindings
            ) {
                throw "Tint binding reflection differs from native WGSL for $($source.FullName)."
            }
            Normalize-TintHlslBindings "$outputBase.hlsl"
            & $Tint $source.FullName --entry-point $entryPoint --format msl --output-name "$outputBase.msl"
            if ($LASTEXITCODE -ne 0) {
                throw "Tint MSL generation failed for $($source.FullName)."
            }
        }
    }
    foreach ($source in Get-ChildItem $shaderDirectory -Filter "*.hlsl") {
        $profile = if ($source.Name.EndsWith(".vert.hlsl")) { "vs_6_0" } else { "ps_6_0" }
        $outputBase = $source.FullName.Substring(0, $source.FullName.Length - ".hlsl".Length)
        $nativeWgsl = "$outputBase.native.wgsl"
        $entryPoint = if (Test-Path $nativeWgsl) {
            if ($profile -eq "vs_6_0") { "mainVertex" } else { "mainFragment" }
        } else {
            "main"
        }
        $cacheKey = Get-ShaderCacheKey -Source $source -Profile $profile -EntryPoint $entryPoint
        $cachedDxil = Join-Path $cacheRoot "$cacheKey.dxil"
        $cachedSpirv = Join-Path $cacheRoot "$cacheKey.spv"
        if (
            (Test-ShaderCacheBinary $cachedDxil "dxil") -and
            (Test-ShaderCacheBinary $cachedSpirv "spirv")
        ) {
            Copy-Item $cachedDxil "$outputBase.dxil" -Force
            Copy-Item $cachedSpirv "$outputBase.spv" -Force
            $reused += 1
            continue
        }
        $temporarySuffix = "$PID-$([Guid]::NewGuid().ToString('N'))"
        $temporaryDxil = "$cachedDxil.$temporarySuffix.tmp"
        $temporarySpirv = "$cachedSpirv.$temporarySuffix.tmp"
        try {
            & $Dxc -T $profile -E $entryPoint @dxilFlags -Fo $temporaryDxil $source.FullName
            if ($LASTEXITCODE -ne 0) {
                throw "DXIL compilation failed for $($source.FullName)."
            }
            & $Dxc @spirvFlags -T $profile -E $entryPoint -Fo $temporarySpirv $source.FullName
            if ($LASTEXITCODE -ne 0) {
                throw "SPIR-V compilation failed for $($source.FullName)."
            }
            if (-not (Test-ShaderCacheBinary $temporaryDxil "dxil")) {
                throw "DXIL compiler produced an invalid binary for $($source.FullName)."
            }
            if (-not (Test-ShaderCacheBinary $temporarySpirv "spirv")) {
                throw "SPIR-V compiler produced an invalid binary for $($source.FullName)."
            }
            Move-Item $temporaryDxil $cachedDxil -Force
            Move-Item $temporarySpirv $cachedSpirv -Force
        } finally {
            if (Test-Path $temporaryDxil) {
                Remove-Item -LiteralPath $temporaryDxil
            }
            if (Test-Path $temporarySpirv) {
                Remove-Item -LiteralPath $temporarySpirv
            }
        }
        Copy-Item $cachedDxil "$outputBase.dxil" -Force
        Copy-Item $cachedSpirv "$outputBase.spv" -Force
        $compiled += 1
    }
    $compilerRecord = if ($directoryNativeWgsl.Count -gt 0) {
        $pin = Get-Content (Join-Path $root "upstream\tint.json") -Raw |
            ConvertFrom-Json
        @{
            backend = "tint-wgsl"
            tintCommit = $pin.commit
            tintSha256 = (Get-FileHash $Tint -Algorithm SHA256).Hash
            dxilCompilerSha256 = (Get-FileHash $Dxc -Algorithm SHA256).Hash
        }
    } else {
        @{
            backend = "dxc-hlsl"
            dxilCompilerSha256 = (Get-FileHash $Dxc -Algorithm SHA256).Hash
        }
    }
    $compilerRecord |
        ConvertTo-Json |
        Set-Content (Join-Path $shaderDirectory "shader-compiler.json")
}

$backend = if ($usedTint) { "Tint WGSL plus DXC" } else { "DXC HLSL" }
Write-Output "$backend compiled $compiled shader variants; reused $reused cached variants."
