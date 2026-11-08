import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { cppSection } from "./native-fixture.js";

const tools = discoverDevelopmentTools();

test(
    "Apple compiler arguments align SDKs and keep desktop overrides out of iOS",
    { skip: !tools.powershell },
    (t) => {
        const directory = mkdtempSync(join(tmpdir(), "bblitec-apple-sdk-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const macSdk = join(directory, "macOS SDK");
        const iosSdk = join(directory, "iOS SDK");
        mkdirSync(macSdk);
        mkdirSync(iosSdk);
        const module = readFileSync("tools/bblite-tools.psm1", "utf8");
        const helpers = [
            cppSection(
                module,
                "function Get-PosixCompilerArguments",
                "function Get-AndroidCompilerArguments",
            ),
            cppSection(
                module,
                "function Get-IosCompilerArguments",
                "function Get-BuildParallelArguments",
            ),
        ]
            .join("\n")
            .replaceAll("$IsMacOS", "$macHost")
            .replaceAll("$IsLinux", "$linuxHost");
        const quote = (value: string): string => value.replaceAll("'", "''");
        const script = join(directory, "sdk.ps1");
        writeFileSync(
            script,
            `
$ErrorActionPreference = 'Stop'
$macHost = $true
$linuxHost = $false
$env:CC = 'chosen-clang'
$env:CXX = 'chosen-clang++'
Remove-Item Env:SDKROOT -ErrorAction SilentlyContinue
$macSdk = '${quote(macSdk)}'
$iosSdk = '${quote(iosSdk)}'
$script:discoveredSdk = $macSdk
$script:sdkExit = 0
$script:queries = [Collections.Generic.List[string]]::new()
function Get-Command([string]$Name, [string]$CommandType) {
    return [pscustomobject]@{ Source = $Name }
}
function xcrun {
    $script:queries.Add(($args -join '|'))
    $global:LASTEXITCODE = $script:sdkExit
    return $script:discoveredSdk
}
${helpers}
function Assert-Sdk($Actual, $Expected) {
    foreach ($argument in @("-DCMAKE_OSX_SYSROOT=$Expected", "-DCMAKE_SYSROOT=$Expected")) {
        if ($argument -notin $Actual) { throw "Missing SDK argument: $argument" }
    }
    if (@($Actual | Where-Object { $_ -match '^-DCMAKE_(OSX_)?SYSROOT=' }).Count -ne 2) {
        throw 'SDK arguments must not be duplicated'
    }
}
function Assert-Refused([scriptblock]$Action) {
    try { & $Action; throw 'Expected SDK refusal' } catch {
        if ($_.Exception.Message -notmatch 'SDK .*unavailable') { throw }
    }
}
$arguments = @(Get-PosixCompilerArguments x86_64)
Assert-Sdk $arguments $macSdk
foreach ($argument in @('-DCMAKE_C_COMPILER=chosen-clang', '-DCMAKE_CXX_COMPILER=chosen-clang++',
    '-DCMAKE_OBJCXX_COMPILER=chosen-clang++', '-DCMAKE_OSX_ARCHITECTURES=x86_64')) {
    if ($argument -notin $arguments) { throw "Missing compiler argument: $argument" }
}
if ($script:queries.Count -ne 1 -or $script:queries[0] -ne '--sdk|macosx|--show-sdk-path') {
    throw 'Desktop SDK must come from xcrun'
}
$env:SDKROOT = $macSdk
$script:sdkExit = 1
Assert-Sdk @(Get-PosixCompilerArguments) $macSdk
if ($script:queries.Count -ne 1) { throw 'An explicit SDKROOT must not query xcrun' }
$script:sdkExit = 0
$env:SDKROOT = 'macosx13.3'
Assert-Sdk @(Get-PosixCompilerArguments) $macSdk
if ($script:queries[$script:queries.Count - 1] -ne '--sdk|macosx13.3|--show-sdk-path') {
    throw 'An SDKROOT name must be resolved by xcrun'
}
$script:sdkExit = 1
foreach ($invalid in @('relative.sdk', (Join-Path $macSdk 'missing'), '${quote(script)}')) {
    $env:SDKROOT = $invalid
    Assert-Refused { Get-PosixCompilerArguments }
}
Remove-Item Env:SDKROOT
Assert-Refused { Get-PosixCompilerArguments }
$script:sdkExit = 0
$script:discoveredSdk = ''
Assert-Refused { Get-PosixCompilerArguments }
$env:SDKROOT = $macSdk
$script:discoveredSdk = $iosSdk
foreach ($target in @(@('iphonesimulator', 'x86_64'), @('iphoneos', 'arm64'))) {
    $arguments = @(Get-IosCompilerArguments $target[0] $target[1])
    Assert-Sdk $arguments $iosSdk
    if ($script:queries[$script:queries.Count - 1] -ne "--sdk|$($target[0])|--show-sdk-path") {
        throw 'iOS must query its requested SDK, ignoring desktop SDKROOT'
    }
}
$calls = $script:queries.Count
$macHost = $false
$linuxHost = $true
$env:SDKROOT = 'unavailable'
$arguments = @(Get-PosixCompilerArguments)
if ($arguments.Count -ne 2 -or $script:queries.Count -ne $calls) {
    throw 'Linux must not select an Apple SDK'
}
$linuxHost = $false
if (@(Get-PosixCompilerArguments).Count -ne 0) { throw 'Windows must not select POSIX tools' }
`,
        );
        const result = spawnSync(
            tools.powershell!,
            ["-NoProfile", "-NonInteractive", "-File", script],
            { encoding: "utf8", windowsHide: true },
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
    },
);

test(
    "build parallel arguments splat as whole tokens",
    { skip: !tools.powershell },
    () => {
        assert.ok(tools.powershell);
        // Splatting a string passes one character per argument, so both the
        // default and an explicit job count must stay arrays.
        const script = `
        $ErrorActionPreference = 'Stop'
        Import-Module '${resolve("tools/bblite-tools.psm1").replaceAll("'", "''")}' -Force
        Remove-Item Env:CMAKE_BUILD_PARALLEL_LEVEL -ErrorAction SilentlyContinue
        $default = Get-BuildParallelArguments
        $explicit = Get-BuildParallelArguments 8
        $printer = 'console.log(JSON.stringify(process.argv.slice(1)))'
        $a = & node -e $printer -- @default
        $b = & node -e $printer -- @explicit
        "$a|$b"
    `;
        const result = spawnSync(
            tools.powershell,
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        const [first, second] = result.stdout.trim().split("|");
        assert.deepEqual(JSON.parse(first ?? ""), ["--parallel"]);
        assert.deepEqual(JSON.parse(second ?? ""), ["--parallel", "8"]);
    },
);
