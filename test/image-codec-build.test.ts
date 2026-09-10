import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";

const tools = discoverDevelopmentTools();

test("shipping codec notices follow reached formats and capture", { skip: !tools.powershell }, () => {
    assert.ok(tools.powershell);
    const script = `
        $ErrorActionPreference = 'Stop'
        Import-Module $env:BBLITE_TEST_CODEC_MODULE -Force
        $results = @()
        foreach ($case in @(
            @{ Features = 'set(BBLITE_IMAGE_CODECS\n    ""\n)'; Capture = $false },
            @{ Features = 'set(BBLITE_IMAGE_CODECS "jpeg")'; Capture = $false },
            @{ Features = 'set(BBLITE_IMAGE_CODECS "webp")'; Capture = $false },
            @{ Features = 'set(BBLITE_IMAGE_CODECS "jpeg")'; Capture = $true },
            @{ Features = 'set(BBLITE_IMAGE_CODECS "png" "jpeg" "webp")'; Capture = $true }
        )) {
            $results += Get-ImageCodecLicenses $env:BBLITE_TEST_CODEC_MANIFEST $case.Features $case.Capture
        }
        foreach ($features in @('', 'set(BBLITE_IMAGE_CODECS "unknown")', 'set(BBLITE_IMAGE_CODECS JPEG)')) {
            try {
                Get-ImageCodecLicenses $env:BBLITE_TEST_CODEC_MANIFEST $features $false | Out-Null
                throw 'unexpected admission'
            } catch {
                if ($_.Exception.Message -eq 'unexpected admission') { throw }
                $results += $_.Exception.Message
            }
        }
        ConvertTo-Json -InputObject $results -Compress
    `;
    const result = spawnSync(tools.powershell, ["-NoProfile", "-Command", script], {
        encoding: "utf8", env: { ...process.env,
            BBLITE_TEST_CODEC_MODULE: resolve("tools/image-codecs.psm1"),
            BBLITE_TEST_CODEC_MANIFEST: resolve("native/vcpkg.json"),
        },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const results: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(results));
    const common = { "SDL3_image.txt": "sdl3-image" };
    const png = { "libpng.txt": "libpng", "zlib.txt": "zlib" };
    const jpeg = { "libjpeg-turbo.txt": "libjpeg-turbo" };
    const webp = { "libwebp.txt": "libwebp" };
    assert.deepEqual(results.slice(0, 5), [
        {}, { ...common, ...jpeg }, { ...common, ...webp },
        { ...common, ...jpeg, ...png }, { ...common, ...jpeg, ...png, ...webp },
    ]);
    assert.match(String(results[5]), /no BBLITE_IMAGE_CODECS/);
    assert.match(String(results[6]), /Unknown BBLITE_IMAGE_CODECS/);
    assert.match(String(results[7]), /Malformed BBLITE_IMAGE_CODECS/);
});

test("SDL_image codec options follow port features", { skip: !tools.cmake || !tools.vcpkgRoot }, (t) => {
    assert.ok(tools.cmake);
    const root = mkdtempSync(join(tmpdir(), "bblite-codec-port-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const script = join(root, "options.cmake");
    const output = join(root, "options.txt");
    writeFileSync(script, [
        'cmake_minimum_required(VERSION 3.24)',
        'set(FEATURES $ENV{BBLITE_TEST_CODEC_FEATURES})',
        'include("$ENV{BBLITE_TEST_VCPKG}/scripts/cmake/vcpkg_check_features.cmake")',
        'function(vcpkg_from_github)', 'endfunction()',
        'macro(vcpkg_cmake_configure)',
        '    file(WRITE "$ENV{BBLITE_TEST_CODEC_OUTPUT}" "${FEATURE_OPTIONS}")',
        '    return()', 'endmacro()',
        'include("$ENV{BBLITE_TEST_CODEC_PORT}/portfile.cmake")',
    ].join("\n"));
    for (const features of [[], ["png", "jpeg", "webp"], ["avif", "jxl", "tiff"]]) {
        const result: SpawnSyncReturns<string> = spawnSync(tools.cmake, ["-P", script], { encoding: "utf8", env: {
            ...process.env,
            BBLITE_TEST_VCPKG: tools.vcpkgRoot,
            BBLITE_TEST_CODEC_PORT: resolve("native/vcpkg-overlay-ports/sdl3-image"),
            BBLITE_TEST_CODEC_OUTPUT: output, BBLITE_TEST_CODEC_FEATURES: features.join(";"),
        } });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const options = readFileSync(output, "utf8").split(";").sort();
        assert.deepEqual(options, [
            ["avif", "AVIF"], ["jpeg", "JPG"], ["jxl", "JXL"],
            ["png", "PNG"], ["tiff", "TIF"], ["webp", "WEBP"],
        ].map(([feature, option]) => `-DSDLIMAGE_${option}=${features.some((value) => value === feature) ? "ON" : "OFF"}`).sort());
    }
});

test("native configure refuses an undeclared image codec", { skip: !tools.cmake }, (t) => {
    assert.ok(tools.cmake);
    const root = mkdtempSync(join(tmpdir(), "bblite-codec-configure-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "features.cmake"), 'set(BBLITE_IMAGE_CODECS "unknown")\n');
    const result = spawnSync(tools.cmake, [
        "-S", resolve("native"), "-B", join(root, "build"),
        `-DBBLITE_GENERATED_DIR=${root}`, "-DBBLITE_VISUAL_CAPTURE=OFF",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Unknown BBLITE_IMAGE_CODECS entry 'unknown'/);
});
