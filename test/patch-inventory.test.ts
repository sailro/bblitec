import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import {
    checkPatchInventory,
    expectedPatchRecord,
    portfilePatches,
    readPatchManifest,
    selectPatches,
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

test("variants select each builder's series in application order", () => {
    const manifest = readPatchManifest();
    const names = (library: string, variants: string[]): string[] =>
        selectPatches(manifest, library, variants).map((patch) =>
            patch.file.slice(patch.file.lastIndexOf("/") + 1),
        );
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
    // The trimmed SDL carries the overlay port's own patches except vcpkg's
    // FreeBSD packaging fix, then its dynamic-API switch.
    const trimmed = names("sdl3", ["trimmed"]);
    assert.equal(trimmed.includes("fix-freebsd.patch"), false);
    assert.equal(trimmed.at(-1), "0009-static-no-dynapi.patch");
    assert.equal(trimmed.length, 8);
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
});

test("portfile PATCHES lists resolve variables and ignore comments", () => {
    assert.deepEqual(
        portfilePatches(
            [
                'set(OPTIONAL_PATCH "optional.patch")',
                "vcpkg_from_github(",
                "    REF x",
                "    # a comment naming ignored.patch",
                "    PATCHES",
                "        first.patch # trailing",
                "        ${OPTIONAL_PATCH}",
                ")",
                "vcpkg_cmake_configure(SOURCE_PATH x)",
            ].join("\n"),
        ),
        ["first.patch", "optional.patch"],
    );
    assert.throws(
        () => portfilePatches("vcpkg_from_github(\n PATCHES\n ${UNSET}\n)"),
        /never set/,
    );
});

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
        "vcpkg_from_github(\n    PATCHES\n        keep.patch\n        extra.patch\n)\n",
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
                    variants: ["vcpkg"],
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
                    ["vcpkg"],
                ),
            ],
        }),
    );
}

test("patches:check reports orphans, missing files, headers, numbering and list drift", (t) => {
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
            "portfile drift",
            (root) =>
                write(
                    join(
                        root,
                        "native/vcpkg-overlay-ports/port/portfile.cmake",
                    ),
                    "vcpkg_from_github(\n    PATCHES\n        extra.patch\n        keep.patch\n)\n",
                ),
            /portfile\.cmake applies \[extra\.patch, keep\.patch\]/,
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
                        '"variants":["other"]',
                    ),
                );
            },
            /unknown demo variant 'other'/,
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
    "PowerShell and TypeScript select and record the same series",
    { skip: !tools.powershell },
    () => {
        const manifest = readPatchManifest();
        for (const [library, variants] of [
            ["rmlui", []],
            ["dawn", []],
            ["dawn", ["android"]],
            ["dawn", ["metal", "ios"]],
            ["labsound", ["core-only"]],
            ["sdl3", ["trimmed"]],
        ] as const) {
            const expected = expectedPatchRecord(manifest, library, variants);
            const prefix = manifest.libraries.get(library)?.record?.prefix;
            const lines = execFileSync(
                tools.powershell!,
                [
                    "-NoProfile",
                    "-Command",
                    `Import-Module '${resolve("tools/bblite-tools.psm1")}' -Force; ` +
                        `Get-PatchRecord ${library} '${expected.source}' (Get-MaintainedPatches ${library} @(${variants.map((variant) => `'${variant}'`).join(",")}))`,
                ],
                { encoding: "utf8" },
            )
                .trim()
                .split(/\r?\n/);
            assert.deepEqual(
                lines,
                [
                    `set(${prefix}_SOURCE "${expected.source}")`,
                    `set(${prefix}_PATCHES "${expected.patches}")`,
                ],
                `${library} ${variants.join(",")}`,
            );
        }
    },
);

test(
    "configure refuses an artifact whose record differs and reports an unrecorded one",
    { skip: !tools.cmake },
    (t) => {
        const root = scratch(t, "patch-identity-");
        const manifest = readPatchManifest();
        const dawn = join(root, "dawn");
        const sdl = join(root, "sdl");
        const rmlui = join(root, "rmlui");
        for (const directory of [dawn, sdl, rmlui]) mkdirSync(directory);
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
                'set(BBLITE_RMLUI_BUILD_COMMAND "tools/build-rmlui.ps1")',
                'set(BBLITE_RUNTIME_FEATURES "ui:rml")',
                `include("${resolve("native/patch-identity.cmake").replaceAll("\\", "/")}")`,
                "bblite_verify_dependency_artifacts()",
                "",
            ].join("\n"),
        );
        // CMake derives these variants from the platform the test runs on.
        const dawnVariants = process.platform === "darwin" ? ["metal"] : [];
        const record = (
            directory: string,
            file: string,
            prefix: string,
            value: { source: string; patches: string },
        ): void =>
            write(
                join(directory, file),
                `set(${prefix}_SOURCE "${value.source}")\nset(${prefix}_PATCHES "${value.patches}")\n`,
            );
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
            /dawn install at\s[\s\S]*?records no patch set/,
        );
        assert.match(
            result.output,
            /sdl3 install at\s[\s\S]*?records no patch set/,
        );

        // The records the TypeScript side computes are the ones CMake accepts.
        record(
            dawn,
            "bblite-dawn-features.cmake",
            "BBLITE_DAWN",
            expectedPatchRecord(manifest, "dawn", dawnVariants),
        );
        record(
            sdl,
            "bblite-sdl-features.cmake",
            "BBLITE_SDL",
            expectedPatchRecord(manifest, "sdl3", ["trimmed"]),
        );
        record(
            rmlui,
            "bblite-rmlui-features.cmake",
            "BBLITE_RMLUI",
            expectedPatchRecord(manifest, "rmlui", []),
        );
        result = configure();
        assert.equal(result.status, 0, result.output);
        assert.doesNotMatch(result.output, /records no patch set/);

        const current = expectedPatchRecord(manifest, "rmlui", []);
        record(rmlui, "bblite-rmlui-features.cmake", "BBLITE_RMLUI", {
            source: current.source,
            patches: current.patches.replace(/=[0-9a-f]{64}/, "=0"),
        });
        result = configure();
        assert.notEqual(result.status, 0, result.output);
        assert.match(
            result.output,
            /rmlui install at\s[\s\S]*?Rebuild it with\s+tools\/build-rmlui\.ps1/,
        );
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
