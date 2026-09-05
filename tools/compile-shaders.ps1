param(
    [string]$Dxc = $env:DXC_PATH,
    [string]$Tint = $env:TINT_PATH,
    [string]$Scene,
    [string]$Target = $env:BBLITE_SHADER_TARGET
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $Target) {
    $Target = if ($IsWindows) {
        "d3d12"
    } elseif ($IsMacOS) {
        "metal"
    } else {
        "vulkan"
    }
}
$Target = $Target.ToLowerInvariant()
if ($Target -notin @("d3d12", "vulkan", "metal", "all")) {
    throw "Shader target must be d3d12|vulkan|metal|all (got '$Target')."
}
$emitDxil = $Target -in @("d3d12", "all")
$emitSpirv = $Target -in @("vulkan", "all")
$emitMsl = $Target -in @("metal", "all")
$needsDxc = $emitDxil -or $emitSpirv
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

if ($needsDxc -and -not $Dxc) {
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

if ($needsDxc -and (-not $Dxc -or -not (Test-Path $Dxc))) {
    throw "DXC not found for the $Target shader target. Install tools/shader-compiler/vcpkg.json or set DXC_PATH."
}
if ($Dxc -and -not (Test-Path $Dxc)) {
    throw "DXC compiler not found: $Dxc"
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

if ($needsDxc) {
    $env:PATH = "$(Split-Path -Parent $Dxc);$env:PATH"
}

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

$compilerFiles = if ($needsDxc) {
    @(
        $Dxc,
        (Join-Path (Split-Path -Parent $Dxc) "dxcompiler.dll"),
        (Join-Path (Split-Path -Parent $Dxc) "dxil.dll")
    ) |
        Where-Object { Test-Path $_ } |
        Sort-Object -Unique
} else {
    @()
}
$compilerIdentity = @(
    $compilerFiles |
        ForEach-Object {
            "$([System.IO.Path]::GetFileName($_)):$((Get-FileHash $_ -Algorithm SHA256).Hash)"
        }
) -join "|"
$compilerHash = Get-StringSha256 $compilerIdentity
function Get-ShaderCacheKey {
    param(
        [System.IO.FileInfo]$Source,
        [string]$Profile,
        [string]$EntryPoint,
        [ValidateSet("dxil", "spirv")]
        [string]$Kind
    )

    $sourceHash = (Get-FileHash $Source.FullName -Algorithm SHA256).Hash
    $flags = if ($Kind -eq "dxil") { $dxilFlags } else { $spirvFlags }
    $payload =
        "$compilerHash|$Kind|$Profile|$EntryPoint|$($flags -join ',')|$sourceHash"
    return Get-StringSha256 $payload
}

# ---------------------------------------------------------------------------
# The Tint half of the cache, content-addressed exactly like the DXC half.
#
# Tint used to run twice per deployed stage on every invocation — a
# measured 1m50 corpus no-op. A stage's target-derived artifacts are
# `.hlsl` after register compaction, reflection and `.slots`, plus `.msl`
# only for a Metal or all-target build. They are pure functions of:
#   - the pinned Tint binary,
#   - THIS SCRIPT (the compaction, demotion and slot-publication passes
#     live here, so the whole script's hash keys the entry — any edit to
#     the script recompiles everything once, which is the
#     rebuild-more-on-doubt direction),
#   - the stage's WGSL bytes,
#   - the declared entry point, the pinned-bindings declaration (it
#     selects the remap-vs-normalize pass), the stage kind (the remap's
#     register spaces differ per stage), and the selected output-format set.
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
$tintArtifactExtensions = @(".hlsl", ".tint-reflection.txt", ".slots")
if ($emitMsl) {
    $tintArtifactExtensions += ".msl"
}

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
        "formats:$($tintArtifactExtensions -join ',')|wgsl:$sourceHash"
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
    # Copy-Item preserves the cache entry's old timestamp. Changed bytes must
    # invalidate CMake's shader snapshot even when the cache predates it.
    [System.IO.File]::SetLastWriteTimeUtc($Destination, [DateTime]::UtcNow)
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

    Two declaration shapes carry no template argument and both reach this
    from the shadow receivers: a `texture_depth_2d` emits as a bare
    `Texture2D`, and its comparison sampler as `SamplerComparisonState`.
    Matching only the templated forms dropped BOTH from the sidecar and left
    the storage rebase counting one texture short.
    #>
    param([string]$Path, [string]$normalized)

    # D3D12 shares sampled textures and read-only storage buffers only
    # within one register space. Pinned shaders remap both into the same
    # space; generic shader materials retain their WGSL group spaces. Count
    # the sampled prefix per space so a storage buffer in space0 is not
    # rebased by textures living in space2.
    $sampledBySpace = @{}
    foreach (
        $sampled in [regex]::Matches(
            $normalized,
            "Texture\w*(?:<[^>]+>)?\s+\w+\s*:\s*register\(t\d+(?:, space(\d+))?"
        )
    ) {
        $space = if ($sampled.Groups[1].Success) {
            [int]$sampled.Groups[1].Value
        } else {
            0
        }
        $sampledBySpace[$space] = 1 + ($sampledBySpace[$space] ?? 0)
    }
    $slots = @(
        [regex]::Matches(
            $normalized,
            "(?:cbuffer\s+cbuffer_(\w+)|(?:Texture\w*(?:<[^>]+>)?|Sampler\w*State)\s+(\w+)|(?:RW)?(?:ByteAddress|Structured)Buffer(?:<[^>]+>)?\s+(\w+))\s*:\s*register\(([tsb])(\d+)(?:, space(\d+))?"
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
                    $space = if ($_.Groups[6].Success) {
                        [int]$_.Groups[6].Value
                    } else {
                        0
                    }
                    [int]$_.Groups[5].Value -
                        ($sampledBySpace[$space] ?? 0)
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
        # A module carrying both entry points deploys ONE file and
        # declares its other compiled stem beside it. Expand each
        # declared stem into a synthetic row keyed the way the stem's
        # own WGSL would have been, carrying the source file it
        # compiles from — the Tint pass compiles that source once per
        # stem, and the DXC pass looks its produced `.hlsl` up here.
        $alsoStages = $module.PSObject.Properties["alsoStages"]
        if ($null -ne $alsoStages -and $null -ne $alsoStages.Value) {
            foreach ($stage in $alsoStages.Value) {
                $declared["$($stage.stem).native.wgsl"] = [pscustomobject]@{
                    entryPoint = [string]$stage.entryPoint
                    pinnedBindings = [bool]$module.pinnedBindings
                    stem = [string]$stage.stem
                    sourceName = $name
                }
            }
        }
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

function Get-DemotableUniformBlocks {
    <#
    .SYNOPSIS
    The uniform blocks of a pinned stage this backend may move to storage.

    .DESCRIPTION
    A block is demotable when nothing but the stage reads it and its
    members are all 16-byte aligned, so the std140 and std430 layouts of
    it agree: the frame graph's `gp` params, the shadow receiver's
    `shadowInfo_N` blocks (a mat4 and two vec4s), the cascaded receiver's
    `csmInfo_N` blocks (four mat4s and four vec4s), and the node ESM
    caster's `nmeShadowParams` (two vec4s). All are read-only in every
    composed stage that declares them. Returned in demotion order, `gp`
    first, so a stage carrying more than one spends the cheapest first.
    #>
    param([string]$Wgsl)

    $names = @()
    if ($Wgsl -match "var\s*<\s*uniform\s*>\s*gp\s*:") {
        $names += "gp"
    }
    if ($Wgsl -match "var\s*<\s*uniform\s*>\s*nmeShadowParams\s*:") {
        $names += "nmeShadowParams"
    }
    foreach (
        $match in [regex]::Matches(
            $Wgsl,
            "var\s*<\s*uniform\s*>\s*((?:shadow|csm)Info_\d+)\s*:"
        )
    ) {
        $names += $match.Groups[1].Value
    }
    return $names
}

function Demote-PinnedVariantUniformBlocks {
    <#
    .SYNOPSIS
    Rewrites named uniform blocks of a pinned stage to read-only storage
    buffers, for stages SDL_GPU cannot otherwise express.

    .DESCRIPTION
    SDL_GPU caps uniform buffers at four per stage
    (MAX_UNIFORM_BUFFERS_PER_STAGE), and its release build skips the
    validation: a fifth block corrupts the D3D12 command buffer's
    fixed-size slot arrays instead of failing. Two composed families reach
    five: the Standard geometry fragments (scene, lights, mesh and mat
    spend the whole budget before the geometry tasks' gp block arrives)
    and the shadow receivers (the same four before the receiver block).

    Storage buffers have their own budget of eight, so the stage keeps
    every pinned struct, name and expression and only the block's address
    space changes -- the same contract as the register remap.
    The demoted source feeds the selected SDL-facing artifact path and
    the `.slots` sidecar, where each block becomes an `r` row the PAL
    binds a real buffer against. The `.native.wgsl` Dawn consumes keeps
    the pin's uniform declarations.

    Returns the demoted source path, written beside the stage.
    #>
    param(
        [string]$SourcePath,
        [string]$OutputBase,
        [int]$UniformCount,
        [string[]]$Blocks
    )

    $wgsl = Get-Content $SourcePath -Raw
    $demoted = $wgsl
    foreach ($block in $Blocks) {
        $demoted = [regex]::Replace(
            $demoted,
            "var\s*<\s*uniform\s*>\s*$block\s*:",
            "var<storage, read> ${block}:"
        )
    }
    if ($demoted -eq $wgsl) {
        throw (
            "$SourcePath declares $UniformCount uniform blocks; SDL_GPU " +
            "caps a stage at 4 and none of them is demotable."
        )
    }
    # Tint infers the input format from the extension, so the temp must
    # end in .wgsl; it is removed after HLSL and the optional MSL arm consume it.
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
    # Generation normally gives this stage a fresh directory, but a direct
    # target switch must not leave the old platform's deployable artifact
    # behind for CMake to snapshot.
    $unrequestedPatterns = @()
    if (-not $emitDxil) { $unrequestedPatterns += "*.dxil" }
    if (-not $emitSpirv) { $unrequestedPatterns += "*.spv" }
    if (-not $emitMsl) { $unrequestedPatterns += "*.msl" }
    foreach ($pattern in $unrequestedPatterns) {
        foreach ($stale in Get-ChildItem $shaderDirectory -Filter $pattern -File) {
            Remove-Item -LiteralPath $stale.FullName
        }
    }
    $directoryNativeWgsl = @(
        Get-ChildItem $shaderDirectory -Filter "*.native.wgsl"
    )
    $declaredModules = Get-ShaderComposition $shaderDirectory
    # The synthetic rows Get-ShaderComposition expanded from `alsoStages`,
    # grouped once by the deployed source they compile from; the loop below
    # then looks its own extras up by name instead of probing every declared
    # module per source.
    $stagesBySource = @{}
    foreach ($extra in $declaredModules.Values) {
        $extraSource = $extra.PSObject.Properties["sourceName"]
        if ($null -ne $extraSource) {
            if (-not $stagesBySource.ContainsKey($extraSource.Value)) {
                $stagesBySource[$extraSource.Value] = @()
            }
            $stagesBySource[$extraSource.Value] += $extra
        }
    }
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
            # The stems this one deployed file also serves: a module
            # carrying both entry points deploys once and declares its
            # other stem, so the same source compiles once per stem,
            # each at that stem's own entry point and cache key.
            $stages = @([pscustomobject]@{
                OutputBase = $outputBase
                Declared = $declared
            })
            if ($stagesBySource.ContainsKey($source.Name)) {
                foreach ($extra in $stagesBySource[$source.Name]) {
                    $stages += [pscustomobject]@{
                        OutputBase = Join-Path $shaderDirectory $extra.stem
                        Declared = $extra
                    }
                }
            }
            foreach ($stage in $stages) {
                $outputBase = $stage.OutputBase
                $declared = $stage.Declared
                $isPinnedComposed = [bool]$declared.pinnedBindings
                $entryPoint = [string]$declared.entryPoint
                # The Tint half is content-addressed like the DXC half: on a
                # hit the selected Tint-derived artifacts come from the cache
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
                    $demotable = @(Get-DemotableUniformBlocks $wgsl)
                    if ($demotable.Count -gt 0) {
                        # Every demotable block moves. No composed stage in the
                        # tree declares more than one, so spending them all is
                        # what the overflow needs; a stage that grew a second
                        # kind would want the order above rather than a count.
                        $chosen = $demotable
                        $sdlSource = Demote-PinnedVariantUniformBlocks `
                            $source.FullName `
                            $outputBase `
                            $uniformCount `
                            $chosen
                        & $Tint $sdlSource `
                            --entry-point $entryPoint `
                            --format hlsl `
                            --output-name $pendingHlsl
                        if ($LASTEXITCODE -ne 0) {
                            throw "Tint HLSL generation failed for $sdlSource."
                        }
                        Assert-UniformBufferCap `
                            $pendingHlsl `
                            ("$($source.FullName) (after demoting " +
                             "$($chosen -join ', '))")
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
                if ($emitMsl) {
                    $pendingMsl = "$outputBase.pending-msl"
                    & $Tint $sdlSource `
                        --entry-point $entryPoint `
                        --format msl `
                        --output-name $pendingMsl
                    if ($LASTEXITCODE -ne 0) {
                        throw "Tint MSL generation failed for $($source.FullName)."
                    }
                    Move-IfDifferent $pendingMsl "$outputBase.msl"
                }
                if ($sdlSource -ne $source.FullName) {
                    Remove-Item $sdlSource
                }
                Save-TintCacheEntry $tintCacheBase $outputBase
                $tintCompiled += 1
            }
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
        if (-not $needsDxc) { continue }

        $cachedDxil = $null
        $cachedSpirv = $null
        $dxilCached = -not $emitDxil
        $spirvCached = -not $emitSpirv
        if ($emitDxil) {
            $dxilKey = Get-ShaderCacheKey `
                -Source $source `
                -Profile $profile `
                -EntryPoint $entryPoint `
                -Kind dxil
            $cachedDxil = Join-Path $cacheRoot "$dxilKey.dxil"
            $dxilCached = Test-ShaderCacheBinary $cachedDxil "dxil"
        }
        if ($emitSpirv) {
            $spirvKey = Get-ShaderCacheKey `
                -Source $source `
                -Profile $profile `
                -EntryPoint $entryPoint `
                -Kind spirv
            $cachedSpirv = Join-Path $cacheRoot "$spirvKey.spv"
            $spirvCached = Test-ShaderCacheBinary $cachedSpirv "spirv"
        }
        if ($dxilCached -and $spirvCached) {
            if ($emitDxil) {
                Copy-IfDifferent $cachedDxil "$outputBase.dxil"
            }
            if ($emitSpirv) {
                Copy-IfDifferent $cachedSpirv "$outputBase.spv"
            }
            $reused += 1
            continue
        }
        $temporarySuffix = "$PID-$([Guid]::NewGuid().ToString('N'))"
        $temporaryDxil = $null
        $temporarySpirv = $null
        try {
            if ($emitDxil -and -not $dxilCached) {
                $temporaryDxil = "$cachedDxil.$temporarySuffix.tmp"
                & $Dxc -T $profile -E $entryPoint `
                    @dxilFlags -Fo $temporaryDxil $source.FullName
                if ($LASTEXITCODE -ne 0) {
                    throw "DXIL compilation failed for $($source.FullName)."
                }
                if (-not (Test-ShaderCacheBinary $temporaryDxil "dxil")) {
                    throw "DXIL compiler produced an invalid binary for $($source.FullName)."
                }
                Move-Item $temporaryDxil $cachedDxil -Force
            }
            if ($emitSpirv -and -not $spirvCached) {
                $temporarySpirv = "$cachedSpirv.$temporarySuffix.tmp"
                & $Dxc @spirvFlags -T $profile -E $entryPoint `
                    -Fo $temporarySpirv $source.FullName
                if ($LASTEXITCODE -ne 0) {
                    throw "SPIR-V compilation failed for $($source.FullName)."
                }
                if (-not (Test-ShaderCacheBinary $temporarySpirv "spirv")) {
                    throw "SPIR-V compiler produced an invalid binary for $($source.FullName)."
                }
                Move-Item $temporarySpirv $cachedSpirv -Force
            }
        } finally {
            if ($temporaryDxil -and (Test-Path $temporaryDxil)) {
                Remove-Item -LiteralPath $temporaryDxil
            }
            if ($temporarySpirv -and (Test-Path $temporarySpirv)) {
                Remove-Item -LiteralPath $temporarySpirv
            }
        }
        if ($emitDxil) {
            Copy-IfDifferent $cachedDxil "$outputBase.dxil"
        }
        if ($emitSpirv) {
            Copy-IfDifferent $cachedSpirv "$outputBase.spv"
        }
        $compiled += 1
    }
    # [ordered]: a plain hashtable serializes its keys in bucket order,
    # which varies between processes, so the record's bytes differed from
    # run to run with identical content — defeating both the generated-tree
    # digest and the Move-IfDifferent guard below.
    $compilerRecord = [ordered]@{
        backend = if ($directoryNativeWgsl.Count -gt 0) {
            "tint-wgsl"
        } else {
            "dxc-hlsl"
        }
        target = $Target
    }
    if ($directoryNativeWgsl.Count -gt 0) {
        $pin = Get-Content (Join-Path $root "upstream\tint.json") -Raw |
            ConvertFrom-Json
        $compilerRecord["tintCommit"] = $pin.commit
        $compilerRecord["tintSha256"] =
            (Get-FileHash $Tint -Algorithm SHA256).Hash
    }
    if ($needsDxc) {
        $compilerRecord["dxcCompilerSha256"] =
            (Get-FileHash $Dxc -Algorithm SHA256).Hash
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

$backend = if ($usedTint) { "Tint WGSL" } else { "HLSL" }
$dxcStep = if ($needsDxc) { " plus DXC" } else { "" }
Write-Output (
    "$backend$dxcStep target $Target compiled $compiled shader variants; " +
    "reused $reused cached variants."
)
if ($usedTint) {
    Write-Output (
        "Tint stages: $tintCompiled transpiled, " +
        "$tintReused replayed from artifacts\shader-cache."
    )
}
