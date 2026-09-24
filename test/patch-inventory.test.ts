import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import {
    checkPatchInventory,
    runPatchIdentity,
} from "../src/patch-inventory.js";

const tools = discoverDevelopmentTools();

function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

function scratch(t: test.TestContext, prefix: string): string {
    mkdirSync("artifacts", { recursive: true });
    const root = mkdtempSync(resolve("artifacts", prefix));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

test("the repository's patch inventory is consistent", () => {
    assert.deepEqual(checkPatchInventory(), []);
});

test(
    "variants select each builder's and port's series in application order",
    { skip: !tools.cmake },
    () => {
        const names = (library: string, variants: string[]): string[] =>
            runPatchIdentity(tools.cmake!, "series", library, { variants })
                .split("\n")
                .filter(Boolean)
                .map((path) => path.slice(path.lastIndexOf("/") + 1));
        assert.deepEqual(names("dawn", []), []);
        assert.deepEqual(names("dawn", ["android"]), [
            "0001-android-surface-loss.patch",
        ]);
        assert.deepEqual(names("dawn", ["metal", "ios"]), [
            "0002-metal-sdk-compat.patch",
            "0003-metal-primitive-index.patch",
            "0004-metal-simulator-capabilities.patch",
        ]);
        assert.deepEqual(names("labsound", []), ["0001-lazy-decoders.patch"]);
        assert.deepEqual(names("labsound", ["core-only"]), [
            "0001-lazy-decoders.patch",
            "0002-core-only.patch",
        ]);
        // The trimmed SDL carries the overlay port's own patches except
        // vcpkg's FreeBSD packaging fix, then its dynamic-API switch and the
        // joystick-free device names.
        const trimmed = names("sdl3", ["trimmed"]);
        assert.equal(trimmed.includes("fix-freebsd.patch"), false);
        assert.deepEqual(trimmed.slice(-2), [
            "0009-static-no-dynapi.patch",
            "0010-no-joystick-device-names.patch",
        ]);
        assert.equal(trimmed.length, 9);
        assert.equal(names("sdl3", ["vcpkg"])[0], "fix-freebsd.patch");
        // A port feature selects its own patch.
        assert.equal(
            names("freetype", ["vcpkg"]).includes("subpixel-rendering.patch"),
            false,
        );
        assert.equal(
            names("freetype", ["vcpkg", "subpixel-rendering"]).at(-1),
            "subpixel-rendering.patch",
        );
        const rmlui = names("rmlui", []);
        assert.equal(rmlui.length, 23);
        assert.deepEqual(
            rmlui.map((name) => Number(name.slice(0, 4))),
            rmlui.map((_, index) => index + 1),
        );
        assert.throws(
            () => names("dawn", ["windows"]),
            /no dawn variant 'windows'/,
        );
        assert.throws(() => names("zlib", []), /no library 'zlib'/);
        // The record names the pin, each patch's digest and the variants.
        assert.match(
            runPatchIdentity(tools.cmake!, "record", "labsound", {
                variants: ["core-only"],
            }),
            /^set\(BBLITE_LABSOUND_SOURCE "[0-9a-f]{40}"\)\nset\(BBLITE_LABSOUND_PATCHES "0001-lazy-decoders\.patch=[0-9a-f]{64};0002-core-only\.patch=[0-9a-f]{64}"\)\nset\(BBLITE_LABSOUND_VARIANTS "core-only"\)\n$/,
        );
    },
);

function fixture(root: string): void {
    write(join(root, "upstream/demo.json"), '{ "commit": "abc" }');
    write(join(root, "tools/build-demo.ps1"), "# builds demo\n");
    write(join(root, "native/CMakeLists.txt"), "project(x NONE)\n");
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    write(
        join(root, "native/patches/demo/0001-first.patch"),
        `Why this patch exists.\n\n${diff}`,
    );
    write(join(root, "native/vcpkg-overlay-ports/port/keep.patch"), diff);
    write(
        join(root, "native/vcpkg-overlay-ports/port/extra.patch"),
        `Owned change.\n\n${diff}`,
    );
    write(
        join(root, "native/vcpkg-overlay-ports/port/portfile.cmake"),
        'include("${CMAKE_CURRENT_LIST_DIR}/../../patch-identity.cmake")\nbblite_patch_series(port PORT_PATCHES vcpkg)\nvcpkg_from_github(\n    PATCHES ${PORT_PATCHES}\n)\n',
    );
    write(
        join(root, "native/vcpkg-overlay-ports/port/vcpkg.json"),
        '{ "name": "port", "version": "1", "features": { "extra-feature": { "description": "x" } } }',
    );
    const patch = (
        library: string,
        order: number,
        file: string,
        inherited: boolean,
        variants: string[],
    ): object => ({
        library,
        order,
        file,
        purpose: "fixture",
        upstream: { state: inherited ? "vcpkg" : "unsubmitted" },
        variants,
        inheritedFromVcpkg: inherited,
    });
    write(
        join(root, "native/patches/manifest.json"),
        JSON.stringify({
            libraries: {
                demo: {
                    pin: { file: "upstream/demo.json", field: "commit" },
                    builder: "tools/build-demo.ps1",
                    record: {
                        prefix: "BBLITE_DEMO",
                        file: "bblite-demo-features.cmake",
                    },
                    variants: ["extra"],
                },
                port: {
                    pin: { file: "upstream/demo.json", field: "commit" },
                    port: "native/vcpkg-overlay-ports/port",
                    variants: ["vcpkg", "extra-feature", "other"],
                },
            },
            patches: [
                patch(
                    "demo",
                    1,
                    "native/patches/demo/0001-first.patch",
                    false,
                    ["all"],
                ),
                patch(
                    "port",
                    1,
                    "native/vcpkg-overlay-ports/port/keep.patch",
                    true,
                    ["vcpkg"],
                ),
                patch(
                    "port",
                    2,
                    "native/vcpkg-overlay-ports/port/extra.patch",
                    false,
                    ["extra-feature"],
                ),
            ],
        }),
    );
}

test("patches:check reports orphans, missing files, headers, numbering and port coverage", (t) => {
    const cases: [string, (root: string) => void, RegExp][] = [
        [
            "missing header",
            (root) =>
                write(
                    join(root, "native/patches/demo/0001-first.patch"),
                    "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
                ),
            /0001-first\.patch: opens with no header/,
        ],
        [
            "orphan",
            (root) =>
                write(join(root, "native/patches/demo/0002-orphan.patch"), "x"),
            /0002-orphan\.patch: not listed/,
        ],
        [
            "missing file",
            (root) =>
                rmSync(
                    join(root, "native/vcpkg-overlay-ports/port/extra.patch"),
                ),
            /extra\.patch: listed but missing/,
        ],
        [
            "builder list",
            (root) =>
                write(
                    join(root, "tools/build-demo.ps1"),
                    "git apply 0001-first.patch\n",
                ),
            /tools\/build-demo\.ps1 names 0001-first\.patch/,
        ],
        [
            "portfile list",
            (root) =>
                write(
                    join(
                        root,
                        "native/vcpkg-overlay-ports/port/portfile.cmake",
                    ),
                    "vcpkg_from_github(\n    PATCHES\n        keep.patch\n        extra.patch\n)\n",
                ),
            /portfile\.cmake does not take its series from bblite_patch_series\(port/,
        ],
        [
            "portfile names a patch",
            (root) => {
                const path = join(
                    root,
                    "native/vcpkg-overlay-ports/port/portfile.cmake",
                );
                write(path, `${readFileSync(path, "utf8")}# see keep.patch\n`);
            },
            /portfile\.cmake names keep\.patch/,
        ],
        [
            "port patch the port never applies",
            (root) => {
                const path = join(root, "native/patches/manifest.json");
                write(
                    path,
                    readFileSync(path, "utf8").replace(
                        '"variants":["extra-feature"]',
                        '"variants":["other"]',
                    ),
                );
            },
            /extra\.patch: a patch in the port directory must apply to the port/,
        ],
        [
            "numbering",
            (root) => {
                const path = join(root, "native/patches/manifest.json");
                write(
                    path,
                    readFileSync(path, "utf8").replace(
                        '"order":1,"file":"native/patches/demo',
                        '"order":2,"file":"native/patches/demo',
                    ),
                );
            },
            /order 2 where its position in the demo series is 1/,
        ],
        [
            "unknown variant",
            (root) => {
                const path = join(root, "native/patches/manifest.json");
                write(
                    path,
                    readFileSync(path, "utf8").replace(
                        '"variants":["all"]',
                        '"variants":["unknown"]',
                    ),
                );
            },
            /unknown demo variant 'unknown'/,
        ],
    ];
    const clean = scratch(t, "patch-inventory-");
    fixture(clean);
    assert.deepEqual(checkPatchInventory(clean), []);
    for (const [label, mutate, problem] of cases) {
        const root = scratch(t, "patch-inventory-");
        fixture(root);
        mutate(root);
        const problems = checkPatchInventory(root);
        assert.ok(
            problems.some((entry) => problem.test(entry)),
            `${label}: ${problems.join(" | ")}`,
        );
    }
});

test(
    "the PowerShell builders take their series and record from the CMake owner",
    { skip: !tools.powershell || !tools.cmake },
    () => {
        for (const [library, variants] of [
            ["rmlui", []],
            ["dawn", ["android"]],
            ["labsound", ["core-only"]],
            ["sdl3", ["trimmed"]],
        ] as const) {
            const quoted = `@(${variants.map((variant) => `'${variant}'`).join(",")})`;
            const lines = execFileSync(
                tools.powershell!,
                [
                    "-NoProfile",
                    "-Command",
                    `Import-Module '${resolve("tools/bblite-tools.psm1")}' -Force; ` +
                        `@(Get-MaintainedPatches ${library} ${quoted} '${tools.cmake!}' | ForEach-Object Path) + @('--') + ` +
                        `@(Get-PatchRecord ${library} ${quoted} '${tools.cmake!}')`,
                ],
                { encoding: "utf8" },
            )
                .trim()
                .split(/\r?\n/);
            const separator = lines.indexOf("--");
            assert.deepEqual(
                lines.slice(0, separator),
                runPatchIdentity(tools.cmake!, "series", library, {
                    variants,
                })
                    .split("\n")
                    .filter(Boolean),
                `${library} series`,
            );
            assert.equal(
                `${lines.slice(separator + 1).join("\n")}\n`,
                runPatchIdentity(tools.cmake!, "record", library, {
                    variants,
                }),
                `${library} record`,
            );
        }
    },
);

test(
    "configure refuses an artifact whose record differs and reports an unrecorded one",
    { skip: !tools.cmake },
    (t) => {
        const root = scratch(t, "patch-identity-");
        const dawn = join(root, "dawn");
        const sdl = join(root, "sdl");
        const rmlui = join(root, "rmlui");
        const labsound = join(root, "labsound");
        for (const directory of [dawn, sdl, rmlui, labsound])
            mkdirSync(directory);
        const project = join(root, "project");
        write(
            join(project, "CMakeLists.txt"),
            [
                "cmake_minimum_required(VERSION 3.24)",
                "project(patch_identity NONE)",
                "set(BBLITE_BACKEND_DAWN ON)",
                `set(BBLITE_DAWN_DIR "${dawn.replaceAll("\\", "/")}")`,
                `set(BBLITE_SDL_DIR "${sdl.replaceAll("\\", "/")}")`,
                `set(BBLITE_RMLUI_DIR "${rmlui.replaceAll("\\", "/")}")`,
                `set(BBLITE_LABSOUND_DIR "${labsound.replaceAll("\\", "/")}")`,
                'set(BBLITE_RMLUI_BUILD_COMMAND "tools/build-rmlui.ps1")',
                'set(BBLITE_RUNTIME_FEATURES "ui:rml;audio:engine")',
                `include("${resolve("native/patch-identity.cmake").replaceAll("\\", "/")}")`,
                "bblite_verify_dependency_artifacts()",
                "",
            ].join("\n"),
        );
        // CMake derives Dawn's variants from the platform the test runs on.
        const dawnVariants = process.platform === "darwin" ? ["metal"] : [];
        const record = (
            directory: string,
            file: string,
            library: string,
            variants: readonly string[],
        ): string => {
            const text = runPatchIdentity(tools.cmake!, "record", library, {
                variants,
            });
            write(join(directory, file), text);
            return text;
        };
        const configure = (): { status: number | null; output: string } => {
            const result = spawnSync(
                tools.cmake!,
                ["--fresh", "-S", project, "-B", join(project, "build")],
                { encoding: "utf8" },
            );
            return {
                status: result.status,
                output: result.stdout + result.stderr,
            };
        };

        // CMake wraps message text, so the expectations span lines.
        let result = configure();
        assert.equal(result.status, 0, result.output);
        assert.match(
            result.output,
            /dawn install at\s[\s\S]*?records\s+no\s+patch\s+set/,
        );
        assert.match(
            result.output,
            /sdl3 install at\s[\s\S]*?records\s+no\s+patch\s+set/,
        );

        // The records the builders write are the ones configure accepts;
        // LabSound's recorded variant set stands.
        const dawnRecord = record(
            dawn,
            "bblite-dawn-features.cmake",
            "dawn",
            dawnVariants,
        );
        record(sdl, "bblite-sdl-features.cmake", "sdl3", ["trimmed"]);
        const rmluiRecord = record(
            rmlui,
            "bblite-rmlui-features.cmake",
            "rmlui",
            [],
        );
        record(labsound, "bblite-labsound-features.cmake", "labsound", [
            "core-only",
        ]);
        result = configure();
        assert.equal(result.status, 0, result.output);
        assert.doesNotMatch(result.output, /records\s+no\s+patch\s+set/);

        write(
            join(rmlui, "bblite-rmlui-features.cmake"),
            rmluiRecord.replace(/=[0-9a-f]{64}/, "=0"),
        );
        result = configure();
        assert.notEqual(result.status, 0, result.output);
        assert.match(
            result.output,
            /rmlui install at\s[\s\S]*?Rebuild\s+it\s+with\s+tools\/build-rmlui\.ps1/,
        );
        record(rmlui, "bblite-rmlui-features.cmake", "rmlui", []);

        // An artifact built for other variants than this platform needs is stale.
        write(
            join(dawn, "bblite-dawn-features.cmake"),
            runPatchIdentity(tools.cmake!, "record", "dawn", {
                variants: ["android"],
            }),
        );
        result = configure();
        assert.notEqual(result.status, 0, result.output);
        assert.match(
            result.output,
            /was\s+built\s+for\s+the\s+variants\s+\[android\]/,
        );
        write(join(dawn, "bblite-dawn-features.cmake"), dawnRecord);
        assert.equal(configure().status, 0);
    },
);

test(
    "maintained patches stage their changes, so a pin reset removes added files, and refuse divergent sources",
    { skip: !tools.powershell || !tools.git },
    (t) => {
        const root = scratch(t, "patch-apply-");
        const checkout = join(root, "source");
        mkdirSync(checkout);
        const env = {
            ...process.env,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "safe.directory",
            GIT_CONFIG_VALUE_0: checkout,
        };
        const git = (...args: string[]): string =>
            execFileSync(tools.git!, ["-C", checkout, ...args], {
                env,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
        git("init");
        git("config", "core.autocrlf", "false");
        writeFileSync(join(checkout, "base.txt"), "original\n");
        git("add", "base.txt");
        git(
            "-c",
            "user.name=Patch Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "Fixture base",
        );
        const pin = git("rev-parse", "HEAD");
        const patch = join(root, "0001-fixture.patch");
        const writePatch = (content: string): void =>
            writeFileSync(
                patch,
                `Fixture header.\n\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-original\n+patched\n` +
                    `--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+${content}\n`,
            );
        const apply = () =>
            spawnSync(
                tools.powershell!,
                [
                    "-NoProfile",
                    "-Command",
                    `Import-Module '${resolve("tools/bblite-tools.psm1")}' -Force; ` +
                        `Install-MaintainedPatches '${checkout}' @([pscustomobject]@{ Name = '0001-fixture.patch'; Path = '${patch}' }) 'Fixture'`,
                ],
                { env, encoding: "utf8" },
            );
        writePatch("first version");
        let result = apply();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(
            readFileSync(join(checkout, "added.txt"), "utf8"),
            "first version\n",
        );
        git("checkout", "--force", "--detach", pin);
        assert.equal(
            existsSync(join(checkout, "added.txt")),
            false,
            "reset drops files introduced by the old patch",
        );
        writePatch("second version");
        result = apply();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(
            readFileSync(join(checkout, "added.txt"), "utf8"),
            "second version\n",
        );
        // Applied twice without a reset, or over a divergent source, the patch refuses.
        result = apply();
        assert.notEqual(result.status, 0, "an already patched source refuses");
        git("checkout", "--force", "--detach", pin);
        writeFileSync(join(checkout, "base.txt"), "unrelated edit\n");
        result = apply();
        assert.notEqual(result.status, 0, "divergent patch inputs refuse");
        assert.equal(
            readFileSync(join(checkout, "base.txt"), "utf8"),
            "unrelated edit\n",
        );
    },
);

test(
    "a patched checkout already carrying its series is left untouched; a changed series or edit resets it",
    { skip: !tools.powershell || !tools.git || !tools.cmake },
    (t) => {
        const root = scratch(t, "patch-sync-");
        const env = {
            ...process.env,
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "safe.directory",
            GIT_CONFIG_VALUE_0: "*",
            GIT_CONFIG_KEY_1: "core.autocrlf",
            GIT_CONFIG_VALUE_1: "false",
        };
        const git = (directory: string, ...args: string[]): string =>
            execFileSync(tools.git!, ["-C", directory, ...args], {
                env,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
        // An upstream repository, and a checkout of this module's layout
        // whose manifest names one patch against it.
        const upstream = join(root, "upstream-repository");
        mkdirSync(upstream);
        git(upstream, "init");
        git(upstream, "config", "core.autocrlf", "false");
        writeFileSync(join(upstream, "base.txt"), "original\n");
        git(upstream, "add", "base.txt");
        git(
            upstream,
            "-c",
            "user.name=Patch Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "Fixture base",
        );
        const pin = git(upstream, "rev-parse", "HEAD");
        const repository = join(root, "repository");
        for (const file of [
            "tools/bblite-tools.psm1",
            "native/patch-identity.cmake",
        ]) {
            mkdirSync(dirname(join(repository, file)), { recursive: true });
            copyFileSync(file, join(repository, file));
        }
        write(join(repository, "upstream/demo.json"), `{ "commit": "${pin}" }`);
        const patchPath = join(
            repository,
            "native/patches/demo/0001-fixture.patch",
        );
        const writePatch = (content: string): void =>
            write(
                patchPath,
                `Fixture header.\n\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-original\n+${content}\n`,
            );
        writePatch("patched");
        write(
            join(repository, "native/patches/manifest.json"),
            JSON.stringify({
                libraries: {
                    demo: {
                        pin: { file: "upstream/demo.json", field: "commit" },
                        builder: "tools/build-demo.ps1",
                        record: {
                            prefix: "BBLITE_DEMO",
                            file: "bblite-demo-features.cmake",
                        },
                        variants: [],
                    },
                },
                patches: [
                    {
                        library: "demo",
                        order: 1,
                        file: "native/patches/demo/0001-fixture.patch",
                        purpose: "fixture",
                        upstream: { state: "unsubmitted" },
                        variants: ["all"],
                        inheritedFromVcpkg: false,
                    },
                ],
            }),
        );
        const checkout = join(root, "checkout");
        const sync = (): string => {
            const result = spawnSync(
                tools.powershell!,
                [
                    "-NoProfile",
                    "-Command",
                    `Import-Module '${join(repository, "tools/bblite-tools.psm1")}' -Force; ` +
                        `$series = Sync-PatchedCheckout '${checkout}' '${upstream}' '${pin}' 'Demo' demo @() '${tools.cmake!}'; ` +
                        `"series=$(@($series).Count)"`,
                ],
                { env, encoding: "utf8" },
            );
            assert.equal(result.status, 0, result.stdout + result.stderr);
            return result.stdout;
        };
        const base = join(checkout, "base.txt");
        assert.match(sync(), /series=1/);
        assert.equal(readFileSync(base, "utf8"), "patched\n");
        const applied = statSync(base).mtimeMs;

        // Warm: the same series on the same commit is not reset or re-applied.
        const warm = sync();
        assert.match(warm, /Demo \S+ already carries its maintained series/);
        assert.match(warm, /series=1/);
        assert.equal(statSync(base).mtimeMs, applied);

        // A changed patch resets the checkout and applies the new series.
        writePatch("patched again");
        assert.doesNotMatch(sync(), /already carries/);
        assert.equal(readFileSync(base, "utf8"), "patched again\n");

        // An edit over the staged series is not a state the builder wrote.
        writeFileSync(base, "local edit\n");
        assert.doesNotMatch(sync(), /already carries/);
        assert.equal(readFileSync(base, "utf8"), "patched again\n");
        assert.ok(existsSync(join(checkout, ".git/bblite-applied-series.txt")));
    },
);
