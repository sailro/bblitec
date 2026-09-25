import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { computeBuildStamp } from "../src/build-stamp.js";
import {
    discoverDevelopmentTools,
    discoverWindowsBuildTools,
} from "../src/development-tools.js";
import { applicationScenes } from "../src/scene-registry.js";
import type { CompiledNativeBackend } from "../src/tooling/backends.js";
import {
    desktopShaderSuffixes,
    importedLibraries,
    shippingPlatform,
    validateDesktopBuilds,
} from "../src/package-demo.js";
import {
    assertPackageChild,
    newPackageOutput,
    publishPackageOutput,
} from "../src/package-output.js";
import {
    packageSizeReport,
    preserveShippingPayload,
    selectShippingScenes,
    shippingConfigureArguments,
    shippingPlan,
} from "../src/shipping-demos.js";
import {
    readShippingFeatures,
    type ShippingFeatures,
} from "../src/shipping-profile.js";

const tools = discoverDevelopmentTools();
const sample = applicationScenes[0]!;
const core: ShippingFeatures = { features: [], codecs: [], runtime: [] };

test(
    "shipping selects host shader payloads and trims unreached SVG on both platforms",
    { skip: !tools.powershell },
    (t) => {
        assert.deepEqual(desktopShaderSuffixes("SDL_GPU", "win32"), [
            ".dxil",
            ".slots",
        ]);
        assert.deepEqual(desktopShaderSuffixes("SDL_GPU", "linux"), [
            ".spv",
            ".slots",
        ]);
        assert.deepEqual(desktopShaderSuffixes("SDL_GPU", "darwin"), [
            ".msl",
            ".slots",
        ]);
        assert.deepEqual(desktopShaderSuffixes("DAWN", "win32"), [
            ".native.wgsl",
        ]);
        const directory = mkdtempSync(
            join(tmpdir(), "bblite-shipping-policy-"),
        );
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const rml = readFileSync("tools/build-rmlui.ps1", "utf8");
        const rmlStart = rml.indexOf("$minimalBuild ="),
            rmlEnd = rml.indexOf("$staticSuffix =", rmlStart);
        assert.ok(rmlStart >= 0 && rmlEnd > rmlStart);
        const probe = join(directory, "policy.ps1");
        writeFileSync(
            probe,
            `
$ErrorActionPreference = 'Stop'
foreach ($StaticRuntime in @($false, $true)) {
    foreach ($MinSize in @($false, $true)) {
        foreach ($EnableSvg in @($false, $true)) {
            ${rml.slice(rmlStart, rmlEnd)}
            $expected = if (($StaticRuntime -or $MinSize) -and -not $EnableSvg) { 'OFF' } else { 'ON' }
            if ($rmlSvgSetting -ne $expected) { throw 'Wrong SVG capability' }
        }
    }
}
`,
        );
        const result = spawnSync(
            tools.powershell!,
            ["-NoProfile", "-File", probe],
            { encoding: "utf8", windowsHide: true },
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
    },
);
test("Linux shipping selects static host libraries and Vulkan-compatible native configuration", () => {
    assert.equal(shippingPlatform("linux", "x64"), "linux");
    assert.equal(shippingPlatform("win32", "x64"), "win32");
    assert.equal(shippingPlatform("darwin", "x64"), "darwin");
    assert.equal(shippingPlatform("darwin", "arm64"), "darwin");
    assert.throws(() => shippingPlatform("freebsd", "x64"));
    assert.throws(() => shippingPlatform("linux", "arm64"));
    const plan = shippingPlan(
        process.cwd(),
        [{ scene: sample, reached: core }],
        undefined,
        "linux",
    );
    const scene = plan.scenes[0]!;
    assert.equal(plan.profiles[0]!.triplet, "x64-linux");
    assert.equal(scene.triplet, "x64-linux");
    const args = shippingConfigureArguments(
        process.cwd(),
        scene,
        { compiler: "/usr/bin/clang++", ninja: "/usr/bin/ninja" },
        "/opt/vcpkg/scripts/buildsystems/vcpkg.cmake",
    );
    for (const required of [
        "-DCMAKE_CXX_COMPILER=/usr/bin/clang++",
        "-DVCPKG_TARGET_TRIPLET=x64-linux",
        "-DCMAKE_SKIP_RPATH=ON",
        "-DBBLITE_MINSIZE=ON",
        "-DBBLITE_BACKEND=SDL_GPU",
        "-DBBLITE_VISUAL_CAPTURE=OFF",
        "-DBBLITE_AUDIO_CAPTURE=OFF",
    ])
        assert.ok(args.includes(required), required);
    assert.ok(
        !args.some(
            (arg) => arg.includes("MSVC") || arg.includes("windows-static"),
        ),
    );
    assert.match(packageSizeReport([], "linux"), /SDL_GPU \/ Vulkan/);
    const mac = shippingPlan(
        process.cwd(),
        [{ scene: sample, reached: core }],
        undefined,
        "darwin",
    );
    assert.equal(mac.profiles[0]!.triplet, "x64-osx");
    assert.match(packageSizeReport([], "darwin"), /SDL_GPU \/ Metal/);
});

test("universal shipping isolates both architectures while sharing codec-compatible profiles within each slice", () => {
    const inputs = [
        {
            scene: sample,
            reached: {
                features: ["png", "ui"],
                codecs: ["png"],
                runtime: ["ui:rml", "audio:engine"],
            },
        },
        {
            scene: { ...sample, id: "second" },
            reached: {
                features: ["png", "physics"],
                codecs: ["png"],
                runtime: ["ui:rml", "audio:engine"],
            },
        },
    ];
    const plan = shippingPlan(process.cwd(), inputs, undefined, "darwin");
    assert.equal(plan.scenes.length, 4);
    assert.deepEqual(
        plan.profiles.map((profile) => profile.triplet),
        ["x64-osx", "arm64-osx"],
    );
    for (const profile of plan.profiles)
        assert.deepEqual(profile.features, ["physics", "png", "ui"]);
    const [intel, arm, secondIntel, secondArm] = plan.scenes;
    assert.equal(intel!.installedDirectory, secondIntel!.installedDirectory);
    assert.equal(arm!.installedDirectory, secondArm!.installedDirectory);
    for (const key of [
        "buildDirectory",
        "installedDirectory",
        "sdlDirectory",
        "labSoundDirectory",
        "rmlUiDirectory",
    ] as const) {
        assert.notEqual(
            intel![key],
            arm![key],
            `Architectures must not overwrite ${key}`,
        );
    }
    assert.equal(
        intel!.output,
        arm!.output,
        "Both slices consume the same generated scene and Metal shader payload",
    );
    for (const scene of [intel!, arm!]) {
        const args = shippingConfigureArguments(
            process.cwd(),
            scene,
            { compiler: "/tools/clang++", ninja: "/tools/ninja" },
            "/tools/vcpkg.cmake",
        );
        assert.ok(
            args.includes(`-DCMAKE_OSX_ARCHITECTURES=${scene.macArchitecture}`),
        );
        assert.ok(args.includes(`-DVCPKG_TARGET_TRIPLET=${scene.triplet}`));
    }
});

test("shipping selects all application registry entries and refuses paths or duplicate IDs", () => {
    assert.deepEqual(selectShippingScenes(undefined), applicationScenes);
    assert.deepEqual(selectShippingScenes("all"), applicationScenes);
    assert.deepEqual(selectShippingScenes(sample.id), [sample]);
    for (const value of [
        "../scene",
        "scene1",
        `${sample.id},${sample.id}`,
        "",
    ]) {
        assert.throws(() => selectShippingScenes(value));
    }
    assert.throws(() =>
        shippingPlan(process.cwd(), [
            { scene: { ...sample, id: "../escape" }, reached: core },
        ]),
    );
});

test("desktop packaging refuses a build that is not the exact mini shape, and stale or missing slices", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblite-desktop-builds-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (path: string, content: string): void => {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), content);
    };
    write("generated/demo/assets/data.bin", "current asset");
    write("generated/demo/upstream/shaders/main.msl", "current shader");
    write("generated/demo/upstream/shaders/main.dxil", "current dxil");
    write("generated/demo/upstream/shaders/main.slots", "slots");
    const cacheText = (values: Record<string, string>): string =>
        Object.entries(values)
            .map(([key, value]) => `${key}:STRING=${value}`)
            .join("\n");
    const mac = (arch: string): Record<string, string> => ({
        CMAKE_OSX_ARCHITECTURES: arch,
        CMAKE_OSX_DEPLOYMENT_TARGET: "12.0",
        BBLITE_BACKEND: "SDL_GPU",
        BBLITE_MINSIZE: "ON",
        BBLITE_AUDIO_CAPTURE: "OFF",
        BBLITE_VISUAL_CAPTURE: "OFF",
        VCPKG_TARGET_TRIPLET: arch === "arm64" ? "arm64-osx" : "x64-osx",
        BBLITE_GENERATED_DIR: join(root, "generated/demo"),
        BBLITE_DEPLOYED_SHADER_SUFFIXES: ".msl;.slots",
    });
    const reset = (): void => {
        for (const arch of ["x86_64", "arm64"]) {
            write(`native/${arch}/CMakeCache.txt`, cacheText(mac(arch)));
            write(`native/${arch}/bblite_native`, arch);
            write(`native/${arch}/assets/data.bin`, "current asset");
            write(`native/${arch}/shaders/main.msl`, "current shader");
            write(`native/${arch}/shaders/main.slots`, "slots");
        }
    };
    // lipo reads a thin executable's architecture; the fixture's names it.
    const validate = () =>
        validateDesktopBuilds(
            {
                scene: "demo",
                buildDirectory: "native/x86_64",
                arm64BuildDirectory: "native/arm64",
                outputRoot: "releases",
                cmake: "cmake",
                platform: "darwin",
                root,
            },
            (executable) => readFileSync(executable, "utf8"),
        );
    reset();
    assert.deepEqual(
        validate().map((slice) => slice.buildDirectory),
        [join(root, "native/x86_64"), join(root, "native/arm64")],
    );
    for (const [path, value, message] of [
        [
            "CMakeCache.txt",
            cacheText({ ...mac("arm64"), CMAKE_OSX_DEPLOYMENT_TARGET: "13.0" }),
            /disagree on CMAKE_OSX_DEPLOYMENT_TARGET/,
        ],
        [
            "CMakeCache.txt",
            cacheText(mac("x86_64")),
            /Expected CMAKE_OSX_ARCHITECTURES=arm64/,
        ],
        ["bblite_native", "x86_64", /Expected a thin arm64/],
        ["assets/data.bin", "old asset", /data\.bin \(changed\)/],
        ["shaders/main.msl", "old shader", /main\.msl \(changed\)/],
        ["shaders/orphan.msl", "left behind", /orphan\.msl \(unexpected\)/],
    ] as const) {
        reset();
        write(`native/arm64/${path}`, value);
        assert.throws(validate, message);
        rmSync(join(root, "native/arm64/shaders/orphan.msl"), { force: true });
    }
    reset();
    rmSync(join(root, "native/arm64/bblite_native"));
    assert.throws(validate, /Required shipping executable not found/);

    // Windows: one static-CRT SDL_GPU or Dawn slice of the named scene.
    const windows: Record<string, string> = {
        BBLITE_BACKEND: "SDL_GPU",
        BBLITE_MINSIZE: "ON",
        VCPKG_TARGET_TRIPLET: "x64-windows-static",
        CMAKE_MSVC_RUNTIME_LIBRARY: "MultiThreaded",
        BBLITE_GENERATED_DIR: join(root, "generated/demo"),
        BBLITE_DEPLOYED_SHADER_SUFFIXES: ".dxil;.slots",
    };
    write("native/win/bblite_native.exe", "exe");
    write("native/win/assets/data.bin", "current asset");
    write("native/win/shaders/main.dxil", "current dxil");
    write("native/win/shaders/main.slots", "slots");
    const validateWindows = (
        values: Record<string, string>,
        scene = "demo",
        expectBackend?: CompiledNativeBackend,
    ) => {
        write("native/win/CMakeCache.txt", cacheText(values));
        return validateDesktopBuilds({
            scene,
            buildDirectory: "native/win",
            outputRoot: "releases",
            cmake: "cmake",
            platform: "win32",
            root,
            ...(expectBackend ? { expectBackend } : {}),
        });
    };
    assert.equal(validateWindows(windows).length, 1);
    for (const [values, message] of [
        [{ ...windows, BBLITE_BACKEND: "BOTH" }, /requires a single backend/],
        [{ ...windows, BBLITE_MINSIZE: "OFF" }, /BBLITE_MINSIZE=ON/],
        [
            { ...windows, VCPKG_TARGET_TRIPLET: "x64-windows" },
            /VCPKG_TARGET_TRIPLET=x64-windows-static/,
        ],
        [
            { ...windows, CMAKE_MSVC_RUNTIME_LIBRARY: "MultiThreadedDLL" },
            /static MSVC runtime/,
        ],
        [
            {
                ...windows,
                BBLITE_GENERATED_DIR: join(root, "generated/other"),
            },
            /was configured against/,
        ],
    ] as const)
        assert.throws(() => validateWindows(values), message);
    assert.throws(() => validateWindows(windows, "Demo"), /generated scene id/);
    assert.throws(
        () => validateWindows(windows, "demo", "DAWN"),
        /BBLITE_BACKEND=SDL_GPU, not DAWN/,
    );
});

test("desktop packages start before they are archived and name each import the toolchain provides", () => {
    // The staged executable runs a few frames with GPU validation and an
    // aborting SDL assertion handler, from its own directory, bounded.
    const source = readFileSync("src/package-demo.ts", "utf8");
    assert.match(source, /BBLITE_MAX_FRAMES: String\(smokeFrames\)/);
    assert.match(source, /SDL_ASSERT: "abort"/);
    assert.match(source, /cwd: packageDirectory/);
    assert.match(source, /const smokeFrames = 5;/);
    assert.match(source, /Output tail:/);
    assert.ok(
        source.indexOf("smokeRun(staged") <
            source.indexOf("archivePackage(plan"),
    );
    // A PE import table lists the DLLs a binary loads.
    assert.deepEqual(
        importedLibraries(readFileSync(process.execPath)).length > 0,
        process.platform === "win32",
    );
    assert.deepEqual(importedLibraries(Buffer.from("not a PE image")), []);
});
test("static installs share optional libraries only within the exact image-codec set", () => {
    const rows = [
        {
            scene: sample,
            reached: { features: ["png"], codecs: ["png"], runtime: [] },
        },
        {
            scene: { ...sample, id: "second" },
            reached: {
                features: ["png", "physics"],
                codecs: ["png"],
                runtime: ["physics:world"],
            },
        },
        {
            scene: { ...sample, id: "third" },
            reached: {
                features: ["webp"],
                codecs: ["webp"],
                runtime: [
                    "audio:engine",
                    "audio:decoded-buffer",
                    "input:gamepad",
                    "ui:inline-svg",
                ],
            },
        },
        { scene: { ...sample, id: "fourth" }, reached: core },
    ];
    const plan = shippingPlan(
        resolve("artifacts/fixture root"),
        rows,
        undefined,
        "win32",
    );
    assert.equal(plan.profiles.length, 3);
    assert.equal(
        plan.scenes[0]!.installedDirectory,
        plan.scenes[1]!.installedDirectory,
    );
    assert.notEqual(
        plan.scenes[0]!.installedDirectory,
        plan.scenes[2]!.installedDirectory,
    );
    assert.deepEqual(plan.profiles[0]!.features, ["physics", "png"]);
    assert.deepEqual(plan.profiles[1]!.features, ["webp"]);
    assert.deepEqual(plan.profiles[2]!.features, []);
    assert.match(plan.scenes[0]!.sdlDirectory, /sdl-min$/);
    assert.match(plan.scenes[2]!.sdlDirectory, /sdl-min-audio-gamepad$/);
    assert.match(plan.scenes[2]!.labSoundDirectory, /labsound-static-codecs$/);
    assert.match(plan.scenes[2]!.rmlUiDirectory, /rmlui-static-svg$/);
    assert.throws(() =>
        readShippingFeatures("features=png\ncodecs=../escape\nruntime="),
    );
    assert.throws(() => readShippingFeatures("features=png"));
});

test(
    "shipping profile executes the native dependency predicates including navigation, SVG and text",
    { skip: !tools.cmake },
    (t) => {
        const directory = mkdtempSync(
            join(tmpdir(), "bblite-shipping-profile-"),
        );
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const cases = [
            { runtime: [], codecs: [], expected: [] },
            { runtime: ["ui:rml"], codecs: ["png"], expected: ["png", "ui"] },
            {
                runtime: ["ui:rml", "ui:inline-svg"],
                codecs: ["webp", "jpeg"],
                expected: ["jpeg", "ui", "ui-svg", "webp"],
            },
            {
                runtime: [
                    "physics:world",
                    "navigation:recast",
                    "navigation:crowd",
                    "navigation:tile-cache",
                    "text:layout",
                ],
                codecs: [],
                expected: [
                    "navigation",
                    "navigation-crowd",
                    "navigation-tile-cache",
                    "physics",
                    "text-layout",
                ],
            },
        ];
        for (const fixture of cases) {
            const quotes = (values: string[]): string =>
                values.length
                    ? values.map((value) => `"${value}"`).join(" ")
                    : '""';
            writeFileSync(
                join(directory, "features.cmake"),
                `set(BBLITE_RUNTIME_FEATURES ${quotes(fixture.runtime)})\nset(BBLITE_IMAGE_CODECS ${quotes(fixture.codecs)})\n`,
            );
            const output = join(directory, "profile.txt");
            const result = spawnSync(
                tools.cmake!,
                [
                    `-DBBLITE_GENERATED_DIR=${directory}`,
                    `-DBBLITE_PROFILE_OUTPUT=${output}`,
                    "-P",
                    resolve("tools/shipping-profile.cmake"),
                ],
                { encoding: "utf8", windowsHide: true },
            );
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const parsed = readShippingFeatures(readFileSync(output, "utf8"));
            assert.deepEqual(parsed.features, fixture.expected);
            assert.deepEqual(parsed.codecs, [...fixture.codecs].sort());
        }
        writeFileSync(
            join(directory, "features.cmake"),
            "set(BBLITE_IMAGE_CODECS unknown)\n",
        );
        const rejected = spawnSync(
            tools.cmake!,
            [
                `-DBBLITE_GENERATED_DIR=${directory}`,
                `-DBBLITE_PROFILE_OUTPUT=${join(directory, "profile.txt")}`,
                "-P",
                resolve("tools/shipping-profile.cmake"),
            ],
            { encoding: "utf8", windowsHide: true },
        );
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /Unknown BBLITE_IMAGE_CODECS/);
    },
);

test(
    "fresh shipping configure removes obsolete package paths and pins the static MSVC shape",
    { skip: process.platform !== "win32" || !tools.cmake },
    (t) => {
        const directory = mkdtempSync(join(tmpdir(), "bblite-shipping-cache-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const native = join(directory, "native");
        mkdirSync(native);
        writeFileSync(
            join(native, "CMakeLists.txt"),
            "cmake_minimum_required(VERSION 3.24)\nproject(shipping_cache NONE)\n",
        );
        const toolchainFile = join(directory, "toolchain.cmake");
        writeFileSync(toolchainFile, "");
        const toolchain = discoverWindowsBuildTools("msvc");
        const scene = shippingPlan(directory, [
            { scene: sample, reached: core },
        ]).scenes[0]!;
        const args = shippingConfigureArguments(
            directory,
            scene,
            toolchain,
            toolchainFile,
        );
        for (const required of [
            "--fresh",
            "-DBBLITE_MINSIZE=ON",
            "-DBBLITE_BACKEND=SDL_GPU",
            "-DBBLITE_PCH=OFF",
            "-DVCPKG_TARGET_TRIPLET=x64-windows-static",
            "-DVCPKG_MANIFEST_INSTALL=OFF",
            "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
            "-DBBLITE_VISUAL_CAPTURE=OFF",
            "-DBBLITE_AUDIO_CAPTURE=OFF",
        ])
            assert.ok(args.includes(required), required);
        assert.ok(args.includes(`-DCMAKE_CXX_COMPILER=${toolchain.compiler}`));
        for (const extra of [
            ["-DSDL3_image_DIR=C:/obsolete/static-superset"],
            [],
        ]) {
            const result = spawnSync(tools.cmake!, [...args, ...extra], {
                encoding: "utf8",
                windowsHide: true,
            });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const cache = readFileSync(
                join(scene.buildDirectory, "CMakeCache.txt"),
                "utf8",
            );
            assert.equal(
                cache.includes("C:/obsolete/static-superset"),
                extra.length > 0,
            );
        }
    },
);

test("obsolete deployment is preserved without moving the executable or native objects", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblite-shipping-payload-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, "native/build-demo-min-sdl");
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "assets/old.bin"), "old asset");
    writeFileSync(join(directory, "SDL3.dll"), "old dll");
    writeFileSync(join(directory, "bblite-shaders-deployed.stamp"), "deployed");
    writeFileSync(join(directory, "bblite_native.exe"), "old executable");
    writeFileSync(join(directory, "object.obj"), "cached object");
    assert.throws(() => preserveShippingPayload(root, "../escape"));
    preserveShippingPayload(root, "demo");
    const backup = readdirSync(directory).find((name) =>
        name.startsWith(".payload-"),
    );
    assert.ok(backup);
    assert.equal(
        readFileSync(join(directory, backup, "assets/old.bin"), "utf8"),
        "old asset",
    );
    assert.equal(
        readFileSync(join(directory, backup, "SDL3.dll"), "utf8"),
        "old dll",
    );
    assert.equal(
        readFileSync(join(directory, "bblite_native.exe"), "utf8"),
        "old executable",
    );
    assert.ok(existsSync(join(directory, "object.obj")));
    assert.ok(!existsSync(join(directory, "assets")));
    assert.ok(
        !existsSync(join(directory, "bblite-shaders-deployed.stamp")),
        "Ninja must redeploy after moving the shader directory",
    );
});

test("extracted dependency choices remain part of the native build stamp", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-shipping-stamp-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "native"));
    mkdirSync(join(directory, "generated"));
    writeFileSync(
        join(directory, "native/CMakeLists.txt"),
        "include(dependency-features.cmake)",
    );
    writeFileSync(
        join(directory, "native/dependency-features.cmake"),
        "set(FEATURE one)",
    );
    const before = computeBuildStamp(join(directory, "generated"), directory);
    writeFileSync(
        join(directory, "native/dependency-features.cmake"),
        "set(FEATURE another)",
    );
    const after = computeBuildStamp(join(directory, "generated"), directory);
    assert.notEqual(before.stamp, after.stamp);
    assert.ok(
        after.inputs.some(
            (input) => input.path === "native/dependency-features.cmake",
        ),
    );
});

test("package publication keeps failed staging and the comparison baseline separate from replacements", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblite-shipping-publication-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const name = "bblitec-demo-sdl-gpu-windows-x64";
    mkdirSync(join(root, name), { recursive: true });
    mkdirSync(join(root, "@previous"));
    writeFileSync(join(root, name, "old.txt"), "old package");
    writeFileSync(join(root, `${name}.zip`), "old zip");
    writeFileSync(
        join(root, "@previous", "baseline.zip"),
        "comparison baseline",
    );
    const plan = newPackageOutput(root, name);
    // An incomplete staging publishes nothing and keeps the prior package.
    assert.throws(
        () => publishPackageOutput(plan),
        /Incomplete staged package/,
    );
    assert.equal(
        readFileSync(join(root, name, "old.txt"), "utf8"),
        "old package",
    );
    mkdirSync(join(plan.staging, name));
    writeFileSync(join(plan.staging, name, "new.txt"), "new package");
    writeFileSync(join(plan.staging, `${name}.zip`), "new zip");
    writeFileSync(join(plan.staging, `${name}.json`), "{}");
    writeFileSync(join(plan.staging, "smoke-output.txt"), "smoke log");
    publishPackageOutput(plan);
    assert.ok(!existsSync(join(root, ".staging")), "published staging kept");
    assert.equal(
        readFileSync(join(plan.previous, name, "old.txt"), "utf8"),
        "old package",
    );
    assert.equal(
        readFileSync(join(plan.previous, `${name}.zip`), "utf8"),
        "old zip",
    );
    assert.equal(
        readFileSync(join(root, name, "new.txt"), "utf8"),
        "new package",
    );
    assert.deepEqual(readdirSync(join(root, "@previous")), ["baseline.zip"]);
    for (const accepted of [
        "bblitec-demo-sdl-gpu-linux-x64",
        "bblitec-demo-sdl-gpu-macos-universal",
        "bblitec-tetris-sdl-gpu-ios-arm64",
        "bblitec-demo-dawn-android-x86-64",
    ])
        assert.equal(newPackageOutput(root, accepted).name, accepted);
    for (const invalid of [
        "../escape",
        "bblitec-../escape-windows-x64",
        "bblitec-demo-sdl-gpu-linux-universal",
    ])
        assert.throws(
            () => newPackageOutput(root, invalid),
            /Invalid package name/,
        );
    assert.throws(
        () => assertPackageChild(root, join(root, "..", "outside")),
        /escapes output root/,
    );
    const outside = join(root, "..", `${basename(root)}-external`);
    mkdirSync(outside);
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(root, ".staging"), { recursive: true });
    symlinkSync(outside, join(root, ".staging", "link"), "junction");
    assert.throws(
        () =>
            assertPackageChild(root, join(root, ".staging", "link", "payload")),
        /crosses a link or junction/,
    );
});

test(
    "the mobile scripts' staging, archive, receipt and publication run through one command",
    { skip: !tools.cmake },
    (t) => {
        const root = mkdtempSync(join(tmpdir(), "bblite-mobile-publication-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const name = "bblitec-tetris-sdl-gpu-ios-arm64";
        mkdirSync(join(root, "@previous"));
        writeFileSync(join(root, "@previous", "keep.txt"), "baseline");
        const command = (...args: string[]): string => {
            const result = spawnSync(
                process.execPath,
                ["dist/src/package-output.js", ...args],
                { encoding: "utf8", windowsHide: true },
            );
            assert.equal(result.status, 0, result.stdout + result.stderr);
            return result.stdout.trim().split(/\r?\n/).at(-1)!;
        };
        for (const content of ["first", "second"]) {
            const staging = command("stage", "--root", root, "--name", name);
            const bundle = join(staging, name, "bblite-tetris.app");
            mkdirSync(join(bundle, "shaders"), { recursive: true });
            writeFileSync(join(bundle, "bblite_native"), content);
            writeFileSync(join(bundle, "shaders", "a.msl"), "shader");
            const fields = join(staging, "receipt-fields.json");
            writeFileSync(
                fields,
                JSON.stringify({ scene: "tetris", platform: "ios" }),
            );
            assert.equal(
                command(
                    "finish",
                    "--root",
                    root,
                    "--name",
                    name,
                    "--staging",
                    staging,
                    "--receipt",
                    fields,
                    "--artifact",
                    `exe=${join(bundle, "bblite_native")}`,
                    "--files",
                    `bundle=${bundle}`,
                ),
                join(root, `${name}.zip`),
            );
        }
        const receipt: unknown = JSON.parse(
            readFileSync(join(root, `${name}.json`), "utf8"),
        );
        assert.ok(typeof receipt === "object" && receipt !== null);
        assert.equal("scene" in receipt && receipt.scene, "tetris");
        assert.equal("exeBytes" in receipt && receipt.exeBytes, 6);
        assert.equal("bundleBytes" in receipt && receipt.bundleBytes, 12);
        assert.ok("files" in receipt && Array.isArray(receipt.files));
        assert.deepEqual(
            receipt.files.map((file: unknown) =>
                typeof file === "object" && file !== null && "path" in file
                    ? file.path
                    : undefined,
            ),
            ["bblite_native", "shaders/a.msl"],
        );
        assert.ok(
            "zipBytes" in receipt && typeof receipt.zipBytes === "number",
        );
        assert.match(
            "exeSha256" in receipt ? String(receipt.exeSha256) : "",
            /^[0-9A-F]{64}$/,
        );
        assert.equal(
            readFileSync(
                join(root, name, "bblite-tetris.app", "bblite_native"),
                "utf8",
            ),
            "second",
        );
        const replaced = readdirSync(join(root, ".replaced"));
        assert.equal(replaced.length, 1);
        assert.equal(
            readFileSync(
                join(
                    root,
                    ".replaced",
                    replaced[0]!,
                    name,
                    "bblite-tetris.app",
                    "bblite_native",
                ),
                "utf8",
            ),
            "first",
        );
        assert.equal(
            readFileSync(join(root, "@previous", "keep.txt"), "utf8"),
            "baseline",
        );
    },
);
test("size report exposes growth and shrinkage separately for executable and archive", () => {
    const report = packageSizeReport([
        {
            scene: "growing",
            exeBytes: 2 ** 21,
            previousExeBytes: 2 ** 20,
            zipBytes: 2 ** 19,
            previousZipBytes: 2 ** 20,
        },
        {
            scene: "new",
            exeBytes: 123,
            zipBytes: 456,
            previousExeBytes: null,
            previousZipBytes: null,
        },
    ]);
    assert.match(
        report,
        /growing \| 2\.00 \| \+1\.00 MiB \(100\.0%\) \| 0\.50 \| -0\.50 MiB \(-50\.0%\)/,
    );
    assert.match(report, /new \| 0\.00 \| New \| 0\.00 \| New/);
});
