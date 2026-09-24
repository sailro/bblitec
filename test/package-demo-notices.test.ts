import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { cppSection } from "./native-fixture.js";

// Ports that install no code into the shipped executable — build-system
// helpers and operating-system libraries. Everything else the manifest names is linkable, so the
// packager must carry a notice entry for it; exclusions live here, by
// name, where a review can see them.
const NOTICE_EXEMPT: ReadonlySet<string> = new Set([
    "vcpkg-cmake",
    "vcpkg-cmake-config",
]);

function dependencyNames(value: unknown, location: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        assert.fail(`${location} must be an array.`);
    }
    return value.flatMap((entry: unknown, index) => {
        if (typeof entry === "string") return entry;
        if (
            entry === null ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            !("name" in entry)
        ) {
            assert.fail(
                `${location}[${index}] must be a name or a named object.`,
            );
        }
        const { name } = entry;
        if (typeof name !== "string") {
            assert.fail(`${location}[${index}].name must be a string.`);
        }
        // This packager targets Windows; these ports are replaced by OS services.
        if ("platform" in entry && entry.platform === "!windows") return [];
        return name;
    });
}

test("packager ships a third-party notice for every linkable dependency", () => {
    const manifest: unknown = JSON.parse(
        readFileSync("native/vcpkg.json", "utf8"),
    );
    if (
        manifest === null ||
        typeof manifest !== "object" ||
        Array.isArray(manifest)
    ) {
        assert.fail("native/vcpkg.json must contain an object.");
    }
    const names = new Set<string>(
        dependencyNames(
            "dependencies" in manifest ? manifest.dependencies : undefined,
            "dependencies",
        ),
    );
    const features = "features" in manifest ? manifest.features : undefined;
    if (features !== undefined) {
        if (
            features === null ||
            typeof features !== "object" ||
            Array.isArray(features)
        ) {
            assert.fail("native/vcpkg.json features must be an object.");
        }
        const definitions: ReadonlyArray<[string, unknown]> =
            Object.entries(features);
        for (const [feature, definition] of definitions) {
            if (
                definition === null ||
                typeof definition !== "object" ||
                Array.isArray(definition)
            ) {
                assert.fail(`features.${feature} must be an object.`);
            }
            for (const name of dependencyNames(
                "dependencies" in definition
                    ? definition.dependencies
                    : undefined,
                `features.${feature}.dependencies`,
            )) {
                names.add(name);
            }
        }
    }
    // RmlUi is the pinned artifact tools/build-rmlui.ps1 installs
    // (upstream/rmlui.json), not vcpkg, so the manifest never names it;
    // its notice is owed all the same wherever the ui feature links it.
    names.add("rmlui");
    // PAL font/control compatibility code retains its upstream notices.
    for (const name of ["Skia", "Chromium"]) {
        names.add(name);
        assert.match(
            readFileSync(`native/notices/${name}.txt`, "utf8"),
            /Redistribution and use/,
        );
    }

    const script = readFileSync("tools/package-demo.ps1", "utf8");
    const begin = script.indexOf(
        "# Third-party notices apply to every linked dependency.",
    );
    const end = script.indexOf("# End of third-party notices.");
    assert.ok(
        begin >= 0,
        "tools/package-demo.ps1 must open its notice table with the third-party marker comment",
    );
    assert.ok(
        end > begin,
        "tools/package-demo.ps1 must close its notice table with the end-of-notices marker comment",
    );
    const region =
        script.slice(begin, end) +
        readFileSync("tools/image-codecs.psm1", "utf8");

    for (const name of [...names].sort()) {
        if (NOTICE_EXEMPT.has(name)) continue;
        // Whole-token match: 'sdl3' inside 'sdl3-image' proves nothing
        // about an sdl3 notice, so the name must stand on its own.
        const token = new RegExp(
            `(?<![A-Za-z0-9_-])${name.replaceAll(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
            )}(?![A-Za-z0-9_-])`,
        );
        assert.match(
            region,
            token,
            `tools/package-demo.ps1 ships no notice for linkable dependency '${name}'; add it to the notice table (or, for a non-linkable port, to NOTICE_EXEMPT here).`,
        );
    }
});

test("packages ship the trimmed SDL's own notices and JSON's only where JSON links", () => {
    const script = readFileSync("tools/package-demo.ps1", "utf8");
    // A trimmed SDL carries its notices; vcpkg's sdl3 notice covers only its own build.
    assert.match(
        script,
        /if \(\$sdlDir\) \{[\s\S]*?Join-Path \$sdlDir "NOTICES\.txt"[\s\S]*?\} else \{\s*\$licensePackages\["SDL3\.txt"\] = "sdl3"/,
    );
    assert.match(
        script,
        /if \(\$jsonReached\) \{ \$licensePackages\["nlohmann-json\.txt"\] = "nlohmann-json" \}/,
    );
    // The package's JSON condition is the one the native build links nlohmann-json by.
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const linked =
        /\nif\(\s*"loader:gltf" IN_LIST[\s\S]*?find_package\(nlohmann_json/.exec(
            cmake,
        )?.[0] ?? "";
    const features = [...linked.matchAll(/"([a-z]+:[a-z-]+)" IN_LIST/g)].map(
        (match) => match[1],
    );
    assert.deepEqual(features, ["loader:gltf", "loader:babylon", "data:json"]);
    const condition =
        /\$jsonReached = \$featuresText -match '"\(\?:([^)]+)\)"'/.exec(
            script,
        )?.[1];
    assert.deepEqual(condition?.split("|"), features);
});

test(
    "the trimmed SDL composes the notices of the code it compiles",
    { skip: !discoverDevelopmentTools().powershell },
    (t) => {
        mkdirSync("artifacts", { recursive: true });
        const root = mkdtempSync(resolve("artifacts", "sdl-notices-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const source = join(root, "source");
        const write = (path: string, content: string): void => {
            mkdirSync(dirname(join(source, path)), { recursive: true });
            writeFileSync(join(source, path), content);
        };
        write("LICENSE.txt", "SDL zlib licence\n");
        write("src/video/yuv2rgb/LICENSE", "yuv2rgb BSD licence\n");
        write("src/hidapi/LICENSE-bsd.txt", "hidapi BSD licence\n");
        write(
            "src/video/stb_image.h",
            "decoder source\n/*\nrevision history\n*/\n\n/*\n----\nThis software is available under 2 licenses -- choose.\nALTERNATIVE A - MIT License\n----\n*/\n",
        );
        const builder = readFileSync("tools/build-sdl-min.ps1", "utf8");
        const composition = cppSection(
            builder,
            "$stbHeader =",
            "\n# Native configuration reads this",
        );
        const run = (gamepad: boolean): string => {
            const output = join(root, gamepad ? "gamepad" : "core");
            mkdirSync(output);
            const script = join(
                root,
                `compose-${gamepad ? "gamepad" : "core"}.ps1`,
            );
            writeFileSync(
                script,
                `$ErrorActionPreference = 'Stop'\n$source = '${source}'\n$output = '${output}'\n$sdlVersion = '3.4.14'\n$EnableGamepad = $${gamepad}\n${composition}`,
            );
            const result = spawnSync(
                discoverDevelopmentTools().powershell!,
                ["-NoProfile", "-File", script],
                { encoding: "utf8" },
            );
            assert.equal(result.status, 0, result.stdout + result.stderr);
            return readFileSync(join(output, "NOTICES.txt"), "utf8");
        };
        const core = run(false);
        assert.match(core, /SDL zlib licence/);
        assert.match(core, /yuv2rgb BSD licence/);
        assert.match(core, /ALTERNATIVE A - MIT License/);
        assert.doesNotMatch(core, /decoder source|revision history/);
        assert.doesNotMatch(core, /hidapi/);
        assert.match(run(true), /hidapi BSD licence/);
    },
);
