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
import { mobilePackageArguments } from "../src/shipping-mobile.js";
import { cppSection } from "./native-fixture.js";

const tools = discoverDevelopmentTools();

test("iOS publishing selects device SDL packaging without conflating Android or Simulator options", () => {
    const args = mobilePackageArguments(
        "ios",
        "tetris",
        new Map([
            ["--jobs", "3"],
            ["--workers", "1"],
            ["--output", "artifacts/releases with spaces"],
        ]),
    );
    for (const [flag, expected] of [
        ["-Platform", "ios"],
        ["-Scene", "tetris"],
        ["-Jobs", "3"],
        ["-OutputRoot", resolve("artifacts/releases with spaces")],
    ]) {
        assert.equal(args[args.indexOf(flag!) + 1], expected);
    }
    for (const flag of ["--sdk", "--device", "--abi"]) {
        assert.throws(
            () =>
                mobilePackageArguments(
                    "ios",
                    "tetris",
                    new Map([[flag, "value"]]),
                ),
            /ARM64 devices/,
        );
    }
    assert.throws(
        () =>
            mobilePackageArguments(
                "ios",
                "tetris",
                new Map([["--workers", "2"]]),
            ),
        /share dependencies/,
    );
    for (const jobs of ["0", "-1", "1.5", "three"]) {
        assert.throws(
            () =>
                mobilePackageArguments(
                    "ios",
                    "tetris",
                    new Map([["--jobs", jobs]]),
                ),
            /positive integer/,
        );
    }
    const result = spawnSync(
        process.execPath,
        [
            "dist/src/shipping-demos.js",
            "--platform",
            "ios",
            "--scene",
            "tetris",
            "--plan",
        ],
        { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
        {
            scene: "tetris",
            args: mobilePackageArguments("ios", "tetris", new Map()),
        },
    ]);
});

test(
    "iOS shipping scripts parse and preserve the per-feature trimmed SDL policy",
    { skip: !tools.powershell },
    (t) => {
        const directory = mkdtempSync(
            join(tmpdir(), "bblite-ios-shipping-policy-"),
        );
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const sdl = readFileSync("tools/build-sdl-min.ps1", "utf8");
        const flags = cppSection(sdl, "$audioSetting =", "# Keep in lockstep");
        const options = cppSection(
            sdl,
            "$sdlOptions =",
            "$configureArguments =",
        )
            .replaceAll("$IsMacOS", "$macHost")
            .replaceAll("$IsLinux", "$linuxHost");
        const script = join(directory, "policy.ps1");
        writeFileSync(
            script,
            `
$ErrorActionPreference = 'Stop'
foreach ($file in @('tools/package-ios.ps1', 'tools/package-demo.ps1', 'tools/package-output.psm1',
    'tools/ios.ps1', 'tools/build-sdl-min.ps1', 'tools/build-rmlui.ps1', 'tools/build-labsound.ps1')) {
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path '${resolve(".").replaceAll("'", "''")}' $file), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
}
$macHost = $true; $linuxHost = $false
foreach ($IosSdk in @('', 'iphoneos')) {
    foreach ($EnableAudio in @($false, $true)) {
        foreach ($EnableGamepad in @($false, $true)) {
            $enabledFeatures = @()
            ${flags}
            ${options}
            foreach ($name in @('SDL_RENDER', 'SDL_RENDER_GPU', 'SDL_OPENGL', 'SDL_OPENGLES',
                'SDL_VULKAN', 'SDL_HAPTIC', 'SDL_SENSOR', 'SDL_CAMERA', 'SDL_POWER', 'SDL_MISC', 'SDL_LOCALE', 'SDL_SHARED')) {
                if ($sdlOptions[$name] -ne 'OFF') { throw "Untrimmed subsystem: $name" }
            }
            foreach ($name in @('SDL_GPU', 'SDL_METAL', 'SDL_VIDEO', 'SDL_STATIC')) {
                if ($sdlOptions[$name] -ne 'ON') { throw "Missing reached subsystem: $name" }
            }
            if (($sdlOptions.SDL_AUDIO -eq 'ON') -ne $EnableAudio -or
                ($sdlOptions.SDL_JOYSTICK -eq 'ON') -ne $EnableGamepad -or
                ($sdlOptions.SDL_HIDAPI -eq 'ON') -ne $EnableGamepad) { throw 'Wrong reached SDL features' }
            if (($sdlOptions.SDL_DIALOG -eq 'ON') -eq [bool]$IosSdk) { throw 'iOS files use UIKit, desktop files use SDL dialogs' }
        }
    }
}
`,
        );
        const result = spawnSync(
            tools.powershell!,
            ["-NoProfile", "-File", script],
            { encoding: "utf8", windowsHide: true },
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
    },
);

test(
    "iOS packaging refuses incompatible caches, device identity and external libraries",
    { skip: !tools.powershell },
    (t) => {
        const directory = mkdtempSync(
            join(tmpdir(), "bblite-ios-shipping-admission-"),
        );
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const source = readFileSync("tools/package-ios.ps1", "utf8");
        const configurationGuard = cppSection(
            source,
            "$required =",
            "$sourceBundle =",
        );
        const binaryGuard = cppSection(
            source,
            "$architecture =",
            "$dependencies | Set-Content",
        );
        const script = join(directory, "admission.ps1");
        const fixture = join(directory, "fixture.json");
        const base = {
            cache: {
                BBLITE_BACKEND: "SDL_GPU",
                BBLITE_MINSIZE: "ON",
                BBLITE_PCH: "OFF",
                BBLITE_VISUAL_CAPTURE: "OFF",
                BBLITE_AUDIO_CAPTURE: "OFF",
                CMAKE_BUILD_TYPE: "Release",
                VCPKG_TARGET_TRIPLET: "arm64-ios-bblite",
                CMAKE_OSX_ARCHITECTURES: "arm64",
                BBLITE_IOS_BUNDLE_IDENTIFIER: "org.bblite.demo.tetris",
                BBLITE_SDL_DIR: "/trimmed",
                BBLITE_GENERATED_DIR: "/generated",
                CMAKE_OSX_DEPLOYMENT_TARGET: "16.0",
            },
            configuration: {
                minSize: true,
                sdk: "iphoneos",
                sdkVersion: "16.4",
                signed: false,
                generatedDirectory: "/generated",
            },
            architecture: "arm64",
            platform: "IOS",
            minos: "16.0",
            sdk: "16.4",
            dependencies: [
                "/usr/lib/libc++.1.dylib",
                "/System/Library/Frameworks/Metal.framework/Metal",
            ],
            plist: {
                CFBundleExecutable: "bblite_native",
                CFBundleIdentifier: "org.bblite.demo.tetris",
                CFBundleSupportedPlatforms: ["iPhoneOS"],
                UIDeviceFamily: [1, 2],
                MinimumOSVersion: "16.0",
            },
        };
        writeFileSync(
            script,
            `
$ErrorActionPreference = 'Stop'
$fixture = Get-Content '${fixture.replaceAll("'", "''")}' -Raw | ConvertFrom-Json -AsHashtable
$cache = $fixture.cache; $configuration = $fixture.configuration
$applicationId = 'org.bblite.demo.tetris'; $executable = 'fixture executable'; $bundle = 'fixture bundle'
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    if ($Program -eq 'plutil') { return ($fixture.plist | ConvertTo-Json -Depth 5) }
    switch ($Arguments[0]) {
        'lipo' { return $fixture.architecture }
        'vtool' { return @('LC_BUILD_VERSION', " platform $($fixture.platform)", " minos $($fixture.minos)", " sdk $($fixture.sdk)") }
        'otool' { return @('fixture executable:') + @($fixture.dependencies | ForEach-Object { " $_ (compatibility version 1.0.0)" }) }
        default { throw 'Unexpected inspection command' }
    }
}
${configurationGuard}
${binaryGuard}
`,
        );
        const run = (value: typeof base) => {
            writeFileSync(fixture, JSON.stringify(value));
            return spawnSync(
                tools.powershell!,
                ["-NoProfile", "-File", script],
                { encoding: "utf8", windowsHide: true },
            );
        };
        const valid = run(base);
        assert.equal(valid.status, 0, valid.stdout + valid.stderr);
        const cases: Array<{
            change: (value: typeof base) => void;
            error: RegExp;
        }> = [
            ...(
                [
                    "BBLITE_MINSIZE",
                    "BBLITE_PCH",
                    "BBLITE_VISUAL_CAPTURE",
                    "BBLITE_AUDIO_CAPTURE",
                ] as const
            ).map((key) => ({
                change: (value: typeof base) => {
                    value.cache[key] = value.cache[key] === "ON" ? "OFF" : "ON";
                },
                error: /iOS shipping requires/,
            })),
            {
                change: (value) => {
                    value.cache.BBLITE_BACKEND = "DAWN";
                },
                error: /BBLITE_BACKEND/,
            },
            {
                change: (value) => {
                    value.cache.BBLITE_SDL_DIR = "";
                },
                error: /trimmed device/,
            },
            {
                change: (value) => {
                    value.cache.BBLITE_GENERATED_DIR = "/other";
                },
                error: /generated tree/,
            },
            {
                change: (value) => {
                    value.configuration.signed = true;
                },
                error: /unsigned/,
            },
            {
                change: (value) => {
                    value.configuration.sdk = "iphonesimulator";
                },
                error: /device bundle/,
            },
            {
                change: (value) => {
                    value.platform = "IOSSIMULATOR";
                },
                error: /device executable/,
            },
            {
                change: (value) => {
                    value.platform = "MACOS";
                },
                error: /device executable/,
            },
            {
                change: (value) => {
                    value.architecture = "x86_64 arm64";
                },
                error: /thin ARM64/,
            },
            {
                change: (value) => {
                    value.sdk = "16.2";
                },
                error: /SDK disagrees/,
            },
            {
                change: (value) => {
                    value.minos = "17.0";
                },
                error: /deployment target/,
            },
            {
                change: (value) => {
                    value.plist.UIDeviceFamily = [1];
                },
                error: /iPhone and iPad/,
            },
            {
                change: (value) => {
                    value.plist.CFBundleIdentifier = "other.application";
                },
                error: /identify this executable/,
            },
            {
                change: (value) => {
                    value.dependencies.push("@rpath/libSDL3.dylib");
                },
                error: /external import/,
            },
        ];
        for (const { change, error } of cases) {
            const value = structuredClone(base);
            change(value);
            const result = run(value);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, error);
        }
    },
);

test(
    "iOS publication retains a previous unsigned package without touching comparison baselines",
    { skip: !tools.powershell },
    (t) => {
        const directory = mkdtempSync(
            join(tmpdir(), "bblite-ios-shipping-publish-"),
        );
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const script = join(directory, "publish.ps1");
        mkdirSync(join(directory, "@previous"));
        writeFileSync(join(directory, "@previous/keep.txt"), "baseline");
        writeFileSync(
            script,
            `
$ErrorActionPreference = 'Stop'
Import-Module '${resolve("tools/package-output.psm1").replaceAll("'", "''")}' -Force
$name = 'bblitec-tetris-sdl-gpu-ios-arm64'
foreach ($content in @('first', 'second')) {
    $plan = New-PackageOutput $PSScriptRoot $name
    New-Item -ItemType Directory (Join-Path $plan.Staging $name) | Out-Null
    Set-Content (Join-Path $plan.Staging "$name/app.txt") $content
    Set-Content (Join-Path $plan.Staging "$name.zip") $content
    Set-Content (Join-Path $plan.Staging "$name.json") $content
    Publish-PackageOutput $plan
}
if ((Get-Content (Join-Path $plan.Previous "$name/app.txt")) -ne 'first') { throw 'Prior package lost' }
if ((Get-Content (Join-Path $PSScriptRoot "$name/app.txt")) -ne 'second') { throw 'New package was not published' }
if ((Get-Content (Join-Path $PSScriptRoot '@previous/keep.txt')) -ne 'baseline') { throw 'Comparison evidence changed' }
`,
        );
        const result = spawnSync(
            tools.powershell!,
            ["-NoProfile", "-File", script],
            { encoding: "utf8", windowsHide: true },
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
    },
);
