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

# ---------------------------------------------------------------------------
# The Tint half of the cache, content-addressed exactly like the DXC half.
#
# Tint used to run twice per deployed stage on every invocation — a
# measured 1m50 corpus no-op. A stage's four Tint-derived artifacts
# (.hlsl after the register compaction, .msl, .tint-reflection.txt and
# the .slots sidecar the compaction publishes) are pure functions of:
#   - the pinned Tint binary,
#   - THIS SCRIPT (the compaction, demotion and slot-publication passes
#     live here, so the whole script's hash keys the entry — any edit to
#     the script recompiles everything once, which is the
#     rebuild-more-on-doubt direction),
#   - the stage's WGSL bytes,
#   - the declared entry point, the pinned-bindings declaration (it
#     selects the remap-vs-normalize pass), the stage kind (the remap's
#     register spaces differ per stage), and the fixed output-format set.
# The binding cross-check and the uniform-buffer cap run at fill time;
# the cap is additionally re-checked on every deployed .hlsl below, so a
# cache hit never lets it sleep.
# ---------------------------------------------------------------------------

$scriptIdentityHash = (Get-FileHash $PSCommandPath -Algorithm SHA256).Hash
$tintIdentityHash = if ($Tint) {
    (Get-FileHash $Tint -Algorithm SHA256).Hash
} else {
    ""
}
$tintArtifactExtensions = @(
    ".hlsl", ".msl", ".tint-reflection.txt", ".slots"
)

function Get-TintCacheBase {
    param(
        [System.IO.FileInfo]$Source,
        [string]$EntryPoint,
        [bool]$PinnedBindings,
        [bool]$IsVertex
    )

    $sourceHash = (Get-FileHash $Source.FullName -Algorithm SHA256).Hash
    $payload = (
        "tint:$tintIdentityHash|script:$scriptIdentityHash|" +
        "entry:$EntryPoint|pinned:$PinnedBindings|vertex:$IsVertex|" +
        "formats:hlsl,msl,reflection,slots|wgsl:$sourceHash"
    )
    return Join-Path $cacheRoot "tint-$(Get-StringSha256 $payload)"
}

function Test-TintCacheEntry {
    param([string]$CacheBase)

    foreach ($extension in $tintArtifactExtensions) {
        if (-not (Test-Path -LiteralPath "$CacheBase$extension")) {
            return $false
        }
    }
    return $true
}

function Save-TintCacheEntry {
    param([string]$CacheBase, [string]$OutputBase)

    foreach ($extension in $tintArtifactExtensions) {
        $temporary =
            "$CacheBase$extension.$PID-$([Guid]::NewGuid().ToString('N')).tmp"
        Copy-Item -LiteralPath "$OutputBase$extension" `
            -Destination $temporary
        # The rename publishes the entry whole, so a concurrent script
        # filling the same key never exposes a half-written artifact.
        Move-Item -LiteralPath $temporary `
            -Destination "$CacheBase$extension" -Force
    }
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

# One byte-exact file comparison for the publish helpers below.
# SequenceEqual rather than Compare-Object: the Tint cache runs this four
# times per stage across the whole corpus, and Compare-Object's
# set-difference semantics box every byte.
function Test-SameContent {
    param([string]$Left, [string]$Right)

    if (
        -not (Test-Path -LiteralPath $Left) -or
        -not (Test-Path -LiteralPath $Right)
    ) {
        return $false
    }
    $leftBytes = [System.IO.File]::ReadAllBytes($Left)
    $rightBytes = [System.IO.File]::ReadAllBytes($Right)
    return [System.Linq.Enumerable]::SequenceEqual(
        [byte[]]$leftBytes,
        [byte[]]$rightBytes
    )
}

# Publish a freshly produced file only when it differs from what is
# already there. Tint rewrites its HLSL, MSL and reflection dumps on every
# run; replacing an identical file makes the shader directory newer than
# the snapshot CMake copied from it, which re-runs the snapshot and
# relinks every scene even when nothing changed.
function Move-IfDifferent {
    param([string]$Temporary, [string]$Destination)

    if (Test-SameContent $Destination $Temporary) {
        Remove-Item -LiteralPath $Temporary -Force
        return
    }
    Move-Item -LiteralPath $Temporary -Destination $Destination -Force
}

# `Move-IfDifferent` for cached bytes that must stay in the cache: the
# hit path publishes the same artifact into many stages' directories.
function Copy-IfDifferent {
    param([string]$Source, [string]$Destination)

    if (Test-SameContent $Destination $Source) {
        return
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Remap-PinnedVariantRegisters {
    <#
    .SYNOPSIS
    Moves a pinned composed variant's registers into SDL_GPU's spaces.

    .DESCRIPTION
    Tint maps `@group(N)` to `spaceN`, and the shaders this repository
    specializes are authored in the groups that make that land where SDL_GPU's
    D3D12 backend looks: vertex uniforms in space1 with its textures in space0,
    fragment textures in space2 with its uniforms in space3.

    Babylon Lite's own variants are not authored for us. They use group 0 for the
    per-pass scene and lights blocks and group 1 for the per-draw mesh block, the
    material block and every texture, which Tint puts in space0 and space1. This
    moves them, and renumbers each class densely in the pin's own group-then-
    binding order, so the shader text stays the pin's and only its addressing
    changes -- the transformation that made emitting the pin's stages viable for
    this backend at all.

    The resulting slot order is what a PAL pushes against: vertex uniforms are
    scene then mesh; fragment uniforms are scene, lights, then material.
    #>
    param([string]$Path, [bool]$IsVertex)

    $source = Get-Content $Path -Raw
    $uniformSpace = if ($IsVertex) { 1 } else { 3 }
    $resourceSpace = if ($IsVertex) { 0 } else { 2 }
    $pattern = "register\(([tsbu])(\d+)(?:, space(\d+))?\)"
    $matches = [regex]::Matches($source, $pattern)
    # SDL_GPU's D3D12 convention orders the shared SRV space by class:
    # sampled textures first, then storage buffers (Tint's ByteAddressBuffer
    # rows for the morph arms). Tint numbers them by declaration order
    # instead, so the t-class renumbering has to know which registers are
    # storage before it can put the palette at t0 where the sampler pair
    # binds.
    $storageRegisters = @{}
    foreach (
        $declaration in [regex]::Matches(
            $source,
            "(?:RW)?(?:ByteAddress|Structured)Buffer(?:<[^>]+>)?\s+\w+\s*:\s*register\(t(\d+)(?:, space(\d+))?\)"
        )
    ) {
        $space = if ($declaration.Groups[2].Success) {
            [int]$declaration.Groups[2].Value
        } else {
            0
        }
        $storageRegisters["$space`:$($declaration.Groups[1].Value)"] = $true
    }
    $mapping = @{}
    foreach ($registerClass in @("b", "t", "s", "u")) {
        $ordered = @(
            $matches |
                Where-Object { $_.Groups[1].Value -eq $registerClass } |
                ForEach-Object {
                    [PSCustomObject]@{
                        Space = if ($_.Groups[3].Success) {
                            [int]$_.Groups[3].Value
                        } else {
                            0
                        }
                        Index = [int]$_.Groups[2].Value
                    }
                } |
                Sort-Object Space, Index -Unique
        )
        if ($registerClass -eq "t") {
            $ordered = @(
                @($ordered | Where-Object {
                    -not $storageRegisters.ContainsKey(
                        "$($_.Space)`:$($_.Index)")
                }) +
                @($ordered | Where-Object {
                    $storageRegisters.ContainsKey(
                        "$($_.Space)`:$($_.Index)")
                })
            )
        }
        for ($index = 0; $index -lt $ordered.Count; $index += 1) {
            $key = "$registerClass`:$($ordered[$index].Space)`:" +
                "$($ordered[$index].Index)"
            $mapping[$key] = $index
        }
    }
    $normalized = [regex]::Replace(
        $source,
        $pattern,
        {
            param($match)
            $registerClass = $match.Groups[1].Value
            $original = [int]$match.Groups[2].Value
            $space = if ($match.Groups[3].Success) {
                [int]$match.Groups[3].Value
            } else {
                0
            }
            $mapped = $mapping["$registerClass`:$space`:$original"]
            $target = if ($registerClass -eq "b") {
                $uniformSpace
            } else {
                $resourceSpace
            }
            return "register($registerClass$mapped, space$target)"
        }
    )
    Set-Content $Path $normalized
    Write-StageSlots $Path $normalized
}

function Write-StageSlots {
    <#
    .SYNOPSIS
    Publishes the slots a compaction pass assigned, beside the stage.

    .DESCRIPTION
    What the pass produced, by each block's own name, for a backend that binds
    by slot. Nothing else can publish this: the WGSL over-counts, because a
    stage can declare a block it never reads and Tint strips it, and Tint's
    own inspector dump lists sampled textures and samplers but no uniform
    buffers. The pass that assigns the slots is the only authority on them.

    Both compaction passes write it -- the pinned variants' remap and the
    specialization normalizer -- because both leave the same question behind.
    A custom sprite fragment declares the layer block and the `fx` block, and
    which of them survives is the caller's own WGSL to decide.

    Storage buffers share the t registers after the sampled textures under
    SDL_GPU's convention; the sidecar names them as their own `r` class,
    rebased to storage slot 0, which is the index
    SDL_BindGPUVertexStorageBuffers takes.
    #>
    param([string]$Path, [string]$normalized)

    $sampledCount = [regex]::Matches(
        $normalized,
        "Texture\w*<[^>]+>\s+\w+\s*:\s*register\(t\d+"
    ).Count
    $slots = @(
        [regex]::Matches(
            $normalized,
            "(?:cbuffer\s+cbuffer_(\w+)|(?:Texture\w*<[^>]+>|SamplerState)\s+(\w+)|(?:RW)?(?:ByteAddress|Structured)Buffer(?:<[^>]+>)?\s+(\w+))\s*:\s*register\(([tsb])(\d+)"
        ) |
            ForEach-Object {
                $storage = $_.Groups[3].Success
                $name = if ($_.Groups[1].Success) {
                    $_.Groups[1].Value
                } elseif ($storage) {
                    $_.Groups[3].Value
                } else {
                    $_.Groups[2].Value
                }
                $class = if ($storage) { "r" } else { $_.Groups[4].Value }
                $index = if ($storage) {
                    [int]$_.Groups[5].Value - $sampledCount
                } else {
                    [int]$_.Groups[5].Value
                }
                [PSCustomObject]@{
                    Class = $class
                    Index = $index
                    Name = $name
                }
            } |
            Sort-Object Class, Index |
            ForEach-Object { "$($_.Class)$($_.Index) $($_.Name)" }
    )
    $slotPath = [System.IO.Path]::ChangeExtension($Path, ".slots")
    Set-Content $slotPath ($slots -join [Environment]::NewLine)
}

function Get-ShaderComposition {
    <#
    .SYNOPSIS
    What the generator DECLARED about the modules in one shader directory.

    .DESCRIPTION
    `composition.json` names every module generation emitted, and a module may
    declare its own `entryPoint` and whether it carries the pin's own binding
    scheme. Both are facts about how the module was produced, which the
    generator knows and a file name does not — the inference below is a ladder
    of filename prefixes that grew a rung per family. A declaring module is out
    of the ladder's hands; the rest keep using it until they are moved too.

    Returns a hashtable keyed by module file name.
    #>
    param([string]$Directory)

    $declared = @{}
    $manifest = Join-Path $Directory "composition.json"
    if (-not (Test-Path $manifest)) {
        return $declared
    }
    $parsed = Get-Content $manifest -Raw | ConvertFrom-Json
    foreach ($module in $parsed.modules) {
        $name = [System.IO.Path]::GetFileName($module.output)
        $declared[$name] = $module
    }
    return $declared
}

function Get-HlslUniformBufferNames {
    <#
    .SYNOPSIS
    The uniform blocks an emitted HLSL stage binds, by name.

    .DESCRIPTION
    The count that binds against SDL_GPU's four-per-stage cap is the
    emitted HLSL's, not the WGSL's (Tint strips a block a stage declares
    but never reads), and a refusal has to NAME the blocks or the fix
    starts with re-deriving this list by hand.
    #>
    param([string]$Path)

    return @(
        [regex]::Matches(
            (Get-Content $Path -Raw),
            "cbuffer\s+(\w+)\s*:\s*register\(b"
        ) |
            ForEach-Object { $_.Groups[1].Value }
    )
}

function Assert-UniformBufferCap {
    <#
    .SYNOPSIS
    Refuses an HLSL stage that binds more than four uniform buffers.

    .DESCRIPTION
    SDL_GPU caps uniform buffers at four per stage
    (MAX_UNIFORM_BUFFERS_PER_STAGE) and its release build skips the
    validation: a fifth block corrupts the D3D12 command buffer's
    fixed-size slot arrays instead of failing. This check runs on EVERY
    compiled stage — it used to be gated on the `variant-` filename
    prefix, which left node and effect stages (the families most likely
    to grow blocks) uncounted against a silent-corruption failure.
    #>
    param([string]$Path, [string]$StageName)

    $names = Get-HlslUniformBufferNames $Path
    if ($names.Count -gt 4) {
        throw (
            "$StageName binds $($names.Count) uniform buffers " +
            "($($names -join ', ')); SDL_GPU caps a stage at 4 and its " +
            "release build corrupts the D3D12 command buffer instead of " +
            "failing on the fifth."
        )
    }
}

function Demote-PinnedVariantGpBlock {
    <#
    .SYNOPSIS
    Rewrites a pinned stage's `gp` uniform block to a read-only storage
    buffer, for stages SDL_GPU cannot otherwise express.

    .DESCRIPTION
    SDL_GPU caps uniform buffers at four per stage
    (MAX_UNIFORM_BUFFERS_PER_STAGE), and its release build skips the
    validation: a fifth block corrupts the D3D12 command buffer's
    fixed-size slot arrays instead of failing. The composed Standard
    geometry fragments reach five -- scene, lights, mesh and mat spend
    the whole budget before the geometry tasks' gp block arrives.

    Storage buffers have their own budget of eight, so the stage keeps
    every pinned struct, name and expression and only the gp block's
    address space changes -- the same contract as the register remap.
    The demoted source feeds every SDL-facing artifact (HLSL, DXIL,
    SPIR-V, MSL, and the .slots sidecar, where the block becomes an
    `r` row the PAL binds a real buffer against); the `.native.wgsl`
    Dawn consumes keeps the pin's uniform declaration.

    Returns the demoted source path, written beside the stage.
    #>
    param([string]$SourcePath, [string]$OutputBase, [int]$UniformCount)

    $wgsl = Get-Content $SourcePath -Raw
    $demoted = [regex]::Replace(
        $wgsl,
        "var\s*<\s*uniform\s*>\s*gp\s*:",
        "var<storage, read> gp:"
    )
    if ($demoted -eq $wgsl) {
        throw (
            "$SourcePath declares $UniformCount uniform blocks; SDL_GPU " +
            "caps a stage at 4 and only a gp block is demotable."
        )
    }
    # Tint infers the input format from the extension, so the temp must
    # end in .wgsl; it is removed after the HLSL and MSL arms consume it.
    $demotedPath = "$OutputBase.pending-sdl.wgsl"
    Set-Content $demotedPath $demoted
    return $demotedPath
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
    # Where SV_Position sat in Tint's own declaration order, per emitted
    # struct. An output struct is built with a flattening aggregate
    # initializer whose values follow that same order, so moving the
    # declaration without moving the value by the same amount silently
    # feeds the varyings into SV_Position. The index is the only thing
    # that ties the two halves together: the member name cannot, because
    # it is the shader author's (the pinned sprite varying is `p`).
    $positionIndex = @{}
    $normalized = [regex]::Replace(
        $normalized,
        "struct (\w+_(?:inputs|outputs)) \{\r?\n(?<body>[\s\S]*?)\r?\n\};",
        {
            param($match)
            $lines = @(
                $match.Groups["body"].Value -split "\r?\n" |
                    Where-Object { $_.Trim().Length -gt 0 }
            )
            for ($index = 0; $index -lt $lines.Count; $index++) {
                if ($lines[$index] -match ":\s*SV_Position") {
                    $positionIndex[$match.Groups[1].Value] = $index
                    break
                }
            }
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
        "(?<struct>\w+_outputs)(?<lead>\s+\w+\s*=\s*\{)(?<values>[^{}]*)(?<suffix>\};)",
        {
            param($match)
            $name = $match.Groups["struct"].Value
            if (-not $positionIndex.ContainsKey($name)) {
                return $match.Value
            }
            $index = $positionIndex[$name]
            $values = @(
                $match.Groups["values"].Value -split "," |
                    ForEach-Object { $_.Trim() }
            )
            if ($index -ge $values.Count) {
                return $match.Value
            }
            $ordered = @($values[$index])
            for ($other = 0; $other -lt $values.Count; $other++) {
                if ($other -ne $index) {
                    $ordered += $values[$other]
                }
            }
            return "$name$($match.Groups["lead"].Value)$(
                $ordered -join ", "
            )$($match.Groups["suffix"].Value)"
        }
    )
    $normalized = $normalized -replace "\bdiscard;", "clip(-1.0f);"
    Set-Content $Path $normalized
    Write-StageSlots $Path $normalized
}

$compiled = 0
$reused = 0
$tintCompiled = 0
$tintReused = 0
$usedTint = $false
# The per-directory loop stays sequential on purpose. With both halves
# content-addressed the warm pass is hashing plus byte compares, and
# `ForEach-Object -Parallel` would have to marshal every helper function
# and script-scope variable into each runspace ($using: has no function
# form) — real restructuring risk for seconds of gain on a stage that no
# longer dominates.
foreach ($shaderDirectory in $shaderDirectories) {
    $directoryNativeWgsl = @(
        Get-ChildItem $shaderDirectory -Filter "*.native.wgsl"
    )
    $declaredModules = Get-ShaderComposition $shaderDirectory
    if ($directoryNativeWgsl.Count -gt 0) {
        $usedTint = $true
        foreach ($source in $directoryNativeWgsl) {
            $outputBase = $source.FullName.Substring(
                0,
                $source.FullName.Length - ".native.wgsl".Length
            )
            # Text the pin composed rather than this repository: its groups
            # and bindings are the pin's own, which decides both the register
            # remap below and the binding cross-check that would otherwise
            # read this repository's specialization back out of Tint.
            $declared = $declaredModules[$source.Name]
            if ($null -eq $declared) {
                throw (
                    "$($source.FullName) is not declared in composition.json; " +
                    "generation must name every module's family."
                )
            }
            $isPinnedComposed = [bool]$declared.pinnedBindings
            $entryPoint = [string]$declared.entryPoint
            # The Tint half is content-addressed like the DXC half: on a
            # hit the four Tint-derived artifacts come from the cache
            # byte-for-byte, published through the same no-churn compare
            # as a fresh run.
            $tintCacheBase = Get-TintCacheBase `
                -Source $source `
                -EntryPoint $entryPoint `
                -PinnedBindings $isPinnedComposed `
                -IsVertex ($outputBase.EndsWith(".vert"))
            if (Test-TintCacheEntry $tintCacheBase) {
                foreach ($extension in $tintArtifactExtensions) {
                    Copy-IfDifferent "$tintCacheBase$extension" `
                        "$outputBase$extension"
                }
                $tintReused += 1
                continue
            }
            $pendingHlsl = "$outputBase.pending-hlsl"
            $reflection = & $Tint $source.FullName `
                --entry-point $entryPoint `
                --format hlsl `
                --output-name $pendingHlsl `
                --dump-inspector-bindings true 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "Tint HLSL generation failed for $($source.FullName)."
            }
            $reflectionText = $reflection -join [Environment]::NewLine
            $pendingReflection = "$outputBase.pending-reflection"
            $reflectionText | Set-Content $pendingReflection
            Move-IfDifferent $pendingReflection "$outputBase.tint-reflection.txt"
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
            # The cross-check validates *this repository's* binding
            # specialization survived Tint: every binding Tint kept has to be
            # one the WGSL declared, at the group and binding it declared it
            # at. The other direction does not hold — a stage may declare a
            # block it never reads, which Tint drops, and a custom sprite
            # fragment does exactly that with whichever of the layer block
            # and the `fx` block the caller's body left alone. Which ones
            # survived is published by `Write-StageSlots`, not inferred here.
            # A pinned composed variant is not specialized here — its groups
            # and bindings are the pin's own, and Tint validates them by
            # compiling the module.
            $undeclared = @(
                $actualBindings | Where-Object { $expectedBindings -notcontains $_ }
            )
            if ((-not $isPinnedComposed) -and $undeclared.Count -gt 0) {
                throw (
                    "Tint reports binding(s) $($undeclared -join ', ') that " +
                    "$($source.FullName) does not declare."
                )
            }
            # SDL_GPU caps uniform buffers at four per stage. The count that
            # binds is the emitted HLSL's, not the WGSL's -- Tint strips a
            # block a stage declares but never reads -- so the overflow check
            # reads the first compile of EVERY stage and, when it trips,
            # recompiles every SDL-facing artifact from a source whose gp
            # block is demoted to a read-only storage buffer. Dawn keeps
            # the pin's uniform declaration in the `.native.wgsl` it
            # consumes.
            # Demotion eligibility is the semantic fact itself: the stage
            # declares the frame-graph `gp` uniform block (the exact
            # declaration the demotion rewrites). composition.json carries
            # no family field to key this on -- its rows declare
            # `entryPoint` and `pinnedBindings` only -- so the WGSL
            # declaration is the authority; a stage over the cap without a
            # gp block has nothing demotable and refuses by name.
            $sdlSource = $source.FullName
            $uniformCount = (Get-HlslUniformBufferNames $pendingHlsl).Count
            if ($uniformCount -gt 4) {
                if ($wgsl -match "var\s*<\s*uniform\s*>\s*gp\s*:") {
                    $sdlSource = Demote-PinnedVariantGpBlock `
                        $source.FullName `
                        $outputBase `
                        $uniformCount
                    & $Tint $sdlSource `
                        --entry-point $entryPoint `
                        --format hlsl `
                        --output-name $pendingHlsl
                    if ($LASTEXITCODE -ne 0) {
                        throw "Tint HLSL generation failed for $sdlSource."
                    }
                    Assert-UniformBufferCap `
                        $pendingHlsl `
                        "$($source.FullName) (after demoting gp)"
                } else {
                    Assert-UniformBufferCap $pendingHlsl $source.FullName
                }
            }
            if ($isPinnedComposed) {
                Remap-PinnedVariantRegisters `
                    $pendingHlsl `
                    $outputBase.EndsWith(".vert")
            } else {
                Normalize-TintHlslBindings $pendingHlsl
            }
            Move-IfDifferent $pendingHlsl "$outputBase.hlsl"
            $pendingMsl = "$outputBase.pending-msl"
            & $Tint $sdlSource --entry-point $entryPoint --format msl --output-name $pendingMsl
            if ($LASTEXITCODE -ne 0) {
                throw "Tint MSL generation failed for $($source.FullName)."
            }
            Move-IfDifferent $pendingMsl "$outputBase.msl"
            if ($sdlSource -ne $source.FullName) {
                Remove-Item $sdlSource
            }
            Save-TintCacheEntry $tintCacheBase $outputBase
            $tintCompiled += 1
        }
    }
    foreach ($source in Get-ChildItem $shaderDirectory -Filter "*.hlsl") {
        $profile = if ($source.Name.EndsWith(".vert.hlsl")) { "vs_6_0" } else { "ps_6_0" }
        $outputBase = $source.FullName.Substring(0, $source.FullName.Length - ".hlsl".Length)
        $nativeWgsl = "$outputBase.native.wgsl"
        # A hand-authored .hlsl with no native WGSL beside it is Babylon
        # Lite's own text carried verbatim, so it keeps `main` like a composed
        # variant does; everything else answers to the same convention as the
        # Tint path above.
        $declared = $declaredModules[
            [System.IO.Path]::GetFileName($nativeWgsl)
        ]
        $entryPoint = if ($null -ne $declared) {
            [string]$declared.entryPoint
        } else {
            "main"
        }
        # The four-uniform-buffer cap on EVERY compiled stage, cache hit
        # or not: Tint-produced HLSL was checked (and possibly demoted)
        # at fill time, and this is where a hand-authored stage — carried
        # verbatim with no native WGSL beside it — meets the check at
        # all. A deployed stage over the cap is corrupting D3D12 command
        # buffers today regardless of what the binary cache holds.
        Assert-UniformBufferCap $source.FullName $source.FullName
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
    # [ordered]: a plain hashtable serializes its keys in bucket order,
    # which varies between processes, so the record's bytes differed from
    # run to run with identical content — defeating both the generated-tree
    # digest and the Move-IfDifferent guard below.
    $compilerRecord = if ($directoryNativeWgsl.Count -gt 0) {
        $pin = Get-Content (Join-Path $root "upstream\tint.json") -Raw |
            ConvertFrom-Json
        [ordered]@{
            backend = "tint-wgsl"
            tintCommit = $pin.commit
            tintSha256 = (Get-FileHash $Tint -Algorithm SHA256).Hash
            dxilCompilerSha256 = (Get-FileHash $Dxc -Algorithm SHA256).Hash
        }
    } else {
        [ordered]@{
            backend = "dxc-hlsl"
            dxilCompilerSha256 = (Get-FileHash $Dxc -Algorithm SHA256).Hash
        }
    }
    # Rewriting an unchanged record would make the shader directory look
    # newer than the snapshot CMake copied from it, which re-runs the
    # snapshot and relinks every scene on every run.
    $compilerRecordPath = Join-Path $shaderDirectory "shader-compiler.json"
    $pendingCompilerRecord = "$compilerRecordPath.pending"
    $compilerRecord |
        ConvertTo-Json |
        Set-Content $pendingCompilerRecord
    Move-IfDifferent $pendingCompilerRecord $compilerRecordPath
}

$backend = if ($usedTint) { "Tint WGSL plus DXC" } else { "DXC HLSL" }
Write-Output "$backend compiled $compiled shader variants; reused $reused cached variants."
if ($usedTint) {
    Write-Output (
        "Tint stages: $tintCompiled transpiled, " +
        "$tintReused replayed from artifacts\shader-cache."
    )
}
