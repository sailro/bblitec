import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { asObject } from "../src/json-fields.js";
import {
    copyPackageNotices,
    linkedPortNotices,
    packageNotices,
    type NoticePlatform,
    type NoticeRequest,
} from "../src/package-notices.js";
import { cppSection } from "./native-fixture.js";

// Ports that install no code into the shipped executable: build-system
// helpers. Everything else the manifest names is linkable, so the notice
// table must name it on the platforms where it links.
const NOTICE_EXEMPT: ReadonlySet<string> = new Set([
    "vcpkg-cmake",
    "vcpkg-cmake-config",
]);

/** Every dependency `native/vcpkg.json` names, with the platforms it links on. */
function manifestDependencies(): { name: string; platform?: string }[] {
    const manifest = asObject(
        JSON.parse(readFileSync("native/vcpkg.json", "utf8")),
    );
    if (!manifest) assert.fail("native/vcpkg.json must contain an object.");
    const entries: { name: string; platform?: string }[] = [];
    const collect = (value: unknown): void => {
        if (!Array.isArray(value)) return;
        for (const item of value) {
            const entry = asObject(item);
            const name = typeof item === "string" ? item : entry?.name;
            if (typeof name !== "string")
                assert.fail("A vcpkg.json dependency must be named.");
            const platform = entry?.platform;
            entries.push({
                name,
                ...(typeof platform === "string" ? { platform } : {}),
            });
        }
    };
    collect(manifest.dependencies);
    for (const feature of Object.values(asObject(manifest.features) ?? {}))
        collect(asObject(feature)?.dependencies);
    return entries;
}

const everyFeature = [
    "loader:gltf",
    "physics:world",
    "navigation:recast",
    "ui:rml",
    "ui:inline-svg",
    "text:layout",
    "data:locale",
    "platform:http",
    "audio:engine",
];

test("the notice table names every linkable dependency on every platform it links on", () => {
    const platforms: NoticePlatform[] = [
        "windows",
        "linux",
        "macos",
        "android",
        "ios",
    ];
    const named = new Map(
        platforms.map((platform) => [
            platform,
            new Set(
                linkedPortNotices({
                    platform,
                    cache: { BBLITE_VISUAL_CAPTURE: "ON" },
                    runtime: everyFeature,
                    codecs: ["png", "jpeg", "webp"],
                }).map((notice) => notice.port),
            ),
        ]),
    );
    const linksOn = (expression: string | undefined, platform: string) => {
        if (expression === undefined) return true;
        const token = {
            windows: "windows",
            linux: "linux",
            macos: "osx",
            android: "android",
            ios: "ios",
        }[platform];
        // The manifest's expressions: `!a & !b`, `a | b`, `!a`, `a`.
        if (expression.includes("|"))
            return expression.split("|").some((part) => part.trim() === token);
        return expression
            .split("&")
            .every((part) =>
                part.trim().startsWith("!")
                    ? part.trim().slice(1) !== token
                    : part.trim() === token,
            );
    };
    for (const { name, platform } of manifestDependencies()) {
        if (NOTICE_EXEMPT.has(name)) continue;
        for (const target of platforms) {
            if (!linksOn(platform, target)) continue;
            assert.ok(
                named.get(target)!.has(name),
                `The notice table names no notice for '${name}' on ${target}; add it to linkedPortNotices (src/package-notices.ts).`,
            );
        }
    }
    // PAL font/control compatibility code retains its upstream notices.
    for (const notice of ["Skia", "Chromium"])
        assert.match(
            readFileSync(`native/notices/${notice}.txt`, "utf8"),
            /Redistribution and use/,
        );
});

test("notices follow the reached features, the trimmed SDL and the codecs the build links", () => {
    const request = (
        runtime: string[],
        codecs: string[] = [],
        cache: Record<string, string> = {},
    ): NoticeRequest => ({
        platform: "windows",
        cache: {
            BBLITE_VISUAL_CAPTURE: "OFF",
            BBLITE_MINSIZE: "ON",
            BBLITE_SDL_DIR: "/trimmed",
            ...cache,
        },
        runtime,
        codecs,
    });
    const names = (value: NoticeRequest) =>
        [
            ...new Set(linkedPortNotices(value).map((notice) => notice.name)),
        ].sort();
    // A trimmed SDL carries its own notices; vcpkg's covers only its build.
    assert.deepEqual(names(request([])), []);
    assert.deepEqual(names(request([], [], { BBLITE_SDL_DIR: "" })), [
        "SDL3.txt",
    ]);
    // JSON links only where the native build links nlohmann-json.
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const linked =
        /\nif\(\s*"loader:gltf" IN_LIST[\s\S]*?find_package\(nlohmann_json/.exec(
            cmake,
        )?.[0] ?? "";
    const jsonFeatures = [
        ...linked.matchAll(/"([a-z]+:[a-z-]+)" IN_LIST/g),
    ].map((match) => match[1]!);
    assert.deepEqual(jsonFeatures, [
        "loader:gltf",
        "loader:babylon",
        "data:json",
    ]);
    for (const feature of jsonFeatures)
        assert.deepEqual(names(request([feature])), ["nlohmann-json.txt"]);
    assert.deepEqual(names(request(["renderer:scene"])), []);
    // Codecs, and PNG whenever capture can write screenshots.
    const common = ["SDL3_image.txt"];
    assert.deepEqual(
        names(request([], ["jpeg"])),
        [...common, "libjpeg-turbo.txt"].sort(),
    );
    assert.deepEqual(
        names(request([], ["webp"])),
        [...common, "libwebp.txt"].sort(),
    );
    assert.deepEqual(
        names(request([], ["jpeg"], { BBLITE_VISUAL_CAPTURE: "ON" })),
        [...common, "libjpeg-turbo.txt", "libpng.txt", "zlib.txt"].sort(),
    );
    assert.throws(
        () => names(request([], ["unknown"])),
        /Unknown BBLITE_IMAGE_CODECS/,
    );
    // A shipping UI links LunaSVG only for inline SVG; development always does.
    assert.deepEqual(names(request(["ui:rml"])), ["FreeType.txt"]);
    assert.deepEqual(names(request(["ui:rml", "ui:inline-svg"])), [
        "FreeType.txt",
        "LunaSVG.txt",
        "PlutoVG.txt",
    ]);
    assert.deepEqual(
        names(request(["ui:rml"], [], { BBLITE_MINSIZE: "OFF" })),
        ["FreeType.txt", "LunaSVG.txt", "PlutoVG.txt"],
    );
    // Colour fonts pull PNG into Unix FreeType.
    assert.deepEqual(names({ ...request(["ui:rml"]), platform: "linux" }), [
        "FreeType.txt",
        "libpng.txt",
        "zlib.txt",
    ]);
});

test("package notices copy the artifacts' own notices and every transitive vcpkg port", (t) => {
    mkdirSync("artifacts", { recursive: true });
    const root = mkdtempSync(resolve("artifacts", "package-notices-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (path: string, content: string): void => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    };
    const triplet = "x64-windows-static";
    const installed = join(root, "installed");
    // vcpkg's record of what each port installed.
    const installs = (port: string, files: string[]): void =>
        write(
            `installed/vcpkg/info/${port}_1.0_${triplet}.list`,
            [`${triplet}/`, `${triplet}/share/`, ...files, ""].join("\n"),
        );
    for (const port of [
        "sdl3-image",
        "libpng",
        "zlib",
        "libjpeg-turbo",
        "freetype",
        "nlohmann-json",
        "brotli",
    ]) {
        write(
            `installed/${triplet}/share/${port}/copyright`,
            `${port} licence`,
        );
        installs(port, [
            `${triplet}/lib/${port}.lib`,
            `${triplet}/share/${port}/copyright`,
        ]);
    }
    // A port that installs only share/ files (CMake helpers, metadata) links
    // nothing and owes no notice; Boost's ports depend on this one.
    installs("boost-uninstall", [
        `${triplet}/share/boost-uninstall/vcpkg_abi_info.txt`,
        `${triplet}/share/boost/vcpkg-cmake-wrapper.cmake`,
    ]);
    const paragraph = (name: string, depends: string, feature?: string) =>
        [
            `Package: ${name}`,
            ...(feature ? [`Feature: ${feature}`] : ["Version: 1.0"]),
            ...(depends ? [`Depends: ${depends}`] : []),
            `Architecture: ${triplet}`,
            "Status: install ok installed",
        ].join("\n");
    write(
        "installed/vcpkg/status",
        [
            paragraph(
                "sdl3-image",
                "sdl3, vcpkg-cmake:x64-windows, vcpkg-cmake-config:x64-windows",
            ),
            paragraph("sdl3-image", "libpng", "png"),
            paragraph("sdl3-image", "libjpeg-turbo", "jpeg"),
            paragraph("libpng", "vcpkg-cmake:x64-windows, zlib"),
            paragraph("zlib", ""),
            paragraph("libjpeg-turbo", ""),
            paragraph("nlohmann-json", ""),
            // A transitive port the table does not name travels under its own name.
            paragraph("freetype", "brotli"),
            paragraph("brotli", "boost-uninstall"),
            paragraph("boost-uninstall", ""),
            "",
        ].join("\n\n"),
    );
    write("sdl/NOTICES.txt", "trimmed SDL notices");
    write("rmlui/RmlUi-LICENSE.txt", "RmlUi licence");
    write("labsound/LabSound-LICENSE.txt", "LabSound licence");
    write("labsound/LabSound-COPYING.txt", "LabSound copying");
    write("labsound/libnyquist-LICENSE.txt", "libnyquist licence");
    write("labsound/libnyquist-COPYING.txt", "libnyquist copying");
    const request = (
        runtime: string[],
        extra: Record<string, string> = {},
    ): NoticeRequest => ({
        platform: "windows",
        cache: {
            VCPKG_INSTALLED_DIR: installed,
            VCPKG_TARGET_TRIPLET: triplet,
            BBLITE_SDL_DIR: join(root, "sdl"),
            BBLITE_RMLUI_DIR: join(root, "rmlui"),
            BBLITE_LABSOUND_DIR: join(root, "labsound"),
            BBLITE_BACKEND: "SDL_GPU",
            BBLITE_MINSIZE: "ON",
            BBLITE_VISUAL_CAPTURE: "OFF",
            BBLITE_AUDIO_CAPTURE: "OFF",
            ...extra,
        },
        runtime,
        codecs: ["png", "jpeg"],
    });
    const notices = packageNotices(
        request(["loader:gltf", "ui:rml", "audio:engine"]),
    );
    assert.deepEqual(
        notices.map((notice) => notice.name),
        [
            "Babylon-Lite.txt",
            "Chromium.txt",
            "FreeType.txt",
            "LabSound-COPYING.txt",
            "LabSound-LICENSE.txt",
            "RmlUi.txt",
            "SDL3.txt",
            "SDL3_image.txt",
            "Skia.txt",
            "brotli.txt",
            "libjpeg-turbo.txt",
            "libpng.txt",
            "nlohmann-json.txt",
            "zlib.txt",
        ],
    );
    const licenses = join(root, "licenses");
    copyPackageNotices(notices, licenses);
    assert.equal(
        readFileSync(join(licenses, "SDL3.txt"), "utf8"),
        "trimmed SDL notices",
    );
    assert.equal(readdirSync(licenses).length, notices.length);
    // Decoded audio links libnyquist and owes its notices.
    const decoded = packageNotices(
        request(["audio:engine", "audio:decoded-buffer"]),
    ).map((notice) => notice.name);
    assert.ok(decoded.includes("libnyquist-LICENSE.txt"));
    assert.ok(decoded.includes("libnyquist-COPYING.txt"));
    // A linked port the install lacks, or a missing artifact notice, refuses.
    assert.throws(
        () => packageNotices(request(["physics:world"])),
        /links vcpkg port 'bullet3', which the install/,
    );
    assert.throws(
        () =>
            packageNotices(
                request(["ui:rml"], { BBLITE_RMLUI_DIR: join(root, "none") }),
            ),
        /Notice RmlUi\.txt not found/,
    );
    assert.throws(
        () => packageNotices(request([], { BBLITE_BACKEND: "DAWN" })),
        /records no BBLITE_DAWN_DIR/,
    );
    // A Dawn build owes its licence; the APK also records its provenance.
    write("dawn/LICENSE.txt", "Dawn licence");
    write("dawn/provenance.json", "{}");
    write("ndk/NOTICE.toolchain", "NDK notices");
    const dawn = {
        BBLITE_BACKEND: "DAWN",
        BBLITE_DAWN_DIR: join(root, "dawn"),
    };
    const desktopDawn = packageNotices(request([], dawn)).map(
        (notice) => notice.name,
    );
    assert.ok(desktopDawn.includes("Dawn.txt"));
    assert.equal(desktopDawn.includes("Dawn-provenance.json"), false);
    const android = packageNotices({
        ...request([], dawn),
        platform: "android",
        ndk: join(root, "ndk"),
    }).map((notice) => notice.name);
    for (const name of [
        "Dawn.txt",
        "Dawn-provenance.json",
        "NDK-toolchain.txt",
    ])
        assert.ok(android.includes(name), name);
    // A transitive port whose file list is missing refuses, not guesses.
    rmSync(join(installed, "vcpkg", "info", `brotli_1.0_${triplet}.list`));
    assert.throws(
        () => packageNotices(request(["ui:rml"])),
        /vcpkg file list not found for 'brotli'/,
    );
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
        write("src/hidapi/LICENSE-bsd.txt", "hidapi BSD licence\n");
        const builder = readFileSync("tools/build-sdl-min.ps1", "utf8");
        const composition = cppSection(
            builder,
            "$notices =",
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
                `$ErrorActionPreference = 'Stop'\nImport-Module '${resolve("tools/bblite-tools.psm1")}' -Force\n$source = '${source}'\n$output = '${output}'\n$sdlVersion = '3.4.14'\n$EnableGamepad = $${gamepad}\n${composition}`,
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
        // The YUV converters and stb_image are compiled out of the trimmed SDL.
        assert.doesNotMatch(core, /yuv2rgb|stb_image|hidapi/);
        assert.match(run(true), /hidapi BSD licence/);
    },
);
