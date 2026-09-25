import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";

const tools = discoverDevelopmentTools();

test(
    "SDL_image codec options follow port features",
    { skip: !tools.cmake || !tools.vcpkgRoot },
    (t) => {
        assert.ok(tools.cmake);
        const root = mkdtempSync(join(tmpdir(), "bblite-codec-port-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const script = join(root, "options.cmake");
        const output = join(root, "options.txt");
        writeFileSync(
            script,
            [
                "cmake_minimum_required(VERSION 3.24)",
                "set(FEATURES $ENV{BBLITE_TEST_CODEC_FEATURES})",
                'include("$ENV{BBLITE_TEST_VCPKG}/scripts/cmake/vcpkg_check_features.cmake")',
                "function(vcpkg_from_github)",
                "endfunction()",
                "macro(vcpkg_cmake_configure)",
                '    file(WRITE "$ENV{BBLITE_TEST_CODEC_OUTPUT}" "${FEATURE_OPTIONS}")',
                "    return()",
                "endmacro()",
                'include("$ENV{BBLITE_TEST_CODEC_PORT}/portfile.cmake")',
            ].join("\n"),
        );
        for (const features of [
            [],
            ["png", "jpeg", "webp"],
            ["avif", "jxl", "tiff"],
        ]) {
            const result: SpawnSyncReturns<string> = spawnSync(
                tools.cmake,
                ["-P", script],
                {
                    encoding: "utf8",
                    env: {
                        ...process.env,
                        BBLITE_TEST_VCPKG: tools.vcpkgRoot,
                        BBLITE_TEST_CODEC_PORT: resolve(
                            "native/vcpkg-overlay-ports/sdl3-image",
                        ),
                        BBLITE_TEST_CODEC_OUTPUT: output,
                        BBLITE_TEST_CODEC_FEATURES: features.join(";"),
                    },
                },
            );
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const options = readFileSync(output, "utf8").split(";").sort();
            assert.deepEqual(
                options,
                [
                    ["avif", "AVIF"],
                    ["jpeg", "JPG"],
                    ["jxl", "JXL"],
                    ["png", "PNG"],
                    ["tiff", "TIF"],
                    ["webp", "WEBP"],
                ]
                    .map(
                        ([feature, option]) =>
                            `-DSDLIMAGE_${option}=${features.some((value) => value === feature) ? "ON" : "OFF"}`,
                    )
                    .sort(),
            );
        }
    },
);

test(
    "native configure refuses an undeclared image codec",
    { skip: !tools.cmake },
    (t) => {
        assert.ok(tools.cmake);
        const root = mkdtempSync(join(tmpdir(), "bblite-codec-configure-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        writeFileSync(
            join(root, "features.cmake"),
            'set(BBLITE_IMAGE_CODECS "unknown")\n',
        );
        const result = spawnSync(
            tools.cmake,
            [
                "-S",
                resolve("native"),
                "-B",
                join(root, "build"),
                `-DBBLITE_GENERATED_DIR=${root}`,
                "-DBBLITE_VISUAL_CAPTURE=OFF",
            ],
            { encoding: "utf8" },
        );
        assert.notEqual(result.status, 0);
        assert.match(
            result.stdout + result.stderr,
            /Unknown BBLITE_IMAGE_CODECS entry 'unknown'/,
        );
    },
);

test(
    "native configure rejects a prepared SDL_image that omits a reached codec",
    { skip: !tools.cmake },
    (t) => {
        const root = mkdtempSync(join(tmpdir(), "bblite-codec-installed-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const cmake = readFileSync("native/CMakeLists.txt", "utf8");
        const start = cmake.indexOf(
            "    foreach(BBLITE_IMAGE_CODEC IN LISTS BBLITE_REQUIRED_IMAGE_CODECS)",
        );
        const end = cmake.indexOf("    endforeach()", start);
        assert.ok(start >= 0 && end > start);
        const script = join(root, "installed.cmake");
        writeFileSync(
            script,
            cmake.slice(start, end + "    endforeach()".length),
        );
        for (const [codec, option] of [
            ["png", "PNG"],
            ["jpeg", "JPG"],
            ["webp", "WEBP"],
        ]) {
            const check = (enabled: string) =>
                spawnSync(
                    tools.cmake!,
                    [
                        `-DBBLITE_REQUIRED_IMAGE_CODECS=${codec}`,
                        `-DSDLIMAGE_${option}=${enabled}`,
                        "-P",
                        script,
                    ],
                    { encoding: "utf8", windowsHide: true },
                );
            assert.equal(check("ON").status, 0);
            const missing = check("OFF");
            assert.notEqual(missing.status, 0);
            assert.match(
                missing.stderr,
                new RegExp(`lacks required codec '${codec}'`),
            );
        }
    },
);
