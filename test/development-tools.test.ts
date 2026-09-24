import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
    discoverClangTool,
    discoverDevelopmentTools,
    discoverWindowsBuildTools,
} from "../src/development-tools.js";
import {
    expectedPatchRecord,
    readPatchManifest,
} from "../src/patch-inventory.js";

function touch(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
}

test("quality tools honor explicit paths, versioned LLVM, and Visual Studio discovery", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-quality-tools-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    const vs = join(root, "Visual Studio");
    const bundled = join(
        vs,
        "VC",
        "Tools",
        "Llvm",
        "x64",
        "bin",
        "clang-format.exe",
    );
    touch(bundled);
    mkdirSync(join(vs, "VC", "Tools", "MSVC"), { recursive: true });
    const environment = { PATH: bin, VSINSTALLDIR: vs };
    assert.equal(
        discoverClangTool("clang-format", {
            cwd: root,
            platform: "win32",
            environment,
        }),
        bundled,
    );
    const versioned = join(bin, "clang-format-22");
    touch(versioned);
    assert.equal(
        discoverClangTool("clang-format", {
            cwd: root,
            platform: "linux",
            environment,
        }),
        versioned,
    );
    assert.equal(
        discoverClangTool("clang-format", {
            cwd: root,
            platform: "win32",
            environment: {
                ...environment,
                CLANG_FORMAT: join(root, "missing"),
            },
        }),
        undefined,
    );
    const explicit = join(bin, "selected-tidy");
    touch(explicit);
    assert.equal(
        discoverClangTool("clang-tidy", {
            cwd: root,
            platform: "linux",
            environment: { PATH: "", CLANG_TIDY: explicit },
        }),
        explicit,
    );
});

test("tool discovery skips directories named like executables", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-tools-directories-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    mkdirSync(join(bin, "git"), { recursive: true });
    touch(join(bin, "git.exe"));
    const tools = discoverDevelopmentTools({
        cwd: root,
        platform: "win32",
        environment: { PATH: bin },
    });
    assert.equal(tools.git, join(bin, "git.exe"));
    assert.equal(
        discoverDevelopmentTools({
            cwd: root,
            platform: "win32",
            environment: { PATH: bin, CMAKE_COMMAND: join(bin, "git") },
        }).cmake,
        undefined,
    );
});

test("discovers the CMake, Ninja, clang-cl, and vcpkg bundled with Visual Studio", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-tools-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const vs = resolve(root, "Visual Studio");
    const programFilesX86 = resolve(root, "Program Files (x86)");
    const msvc = resolve(vs, "VC/Tools/MSVC/14.40");
    const sdk = resolve(programFilesX86, "Windows Kits/10");
    const ninja = resolve(
        vs,
        "Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe",
    );
    const cmake = resolve(
        vs,
        "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe",
    );
    const clang = resolve(vs, "VC/Tools/Llvm/x64/bin/clang-cl.exe");
    const cl = resolve(msvc, "bin/Hostx64/x64/cl.exe");
    const vcpkg = resolve(vs, "VC/vcpkg/vcpkg.exe");
    for (const path of [ninja, cmake, clang, cl, vcpkg]) touch(path);
    touch(resolve(vs, "VC/vcpkg/scripts/buildsystems/vcpkg.cmake"));
    mkdirSync(resolve(sdk, "Include/10.0.26100.0"), { recursive: true });

    const environment: NodeJS.ProcessEnv = {
        PATH: "",
        VSINSTALLDIR: vs,
        "ProgramFiles(x86)": programFilesX86,
    };
    const options = {
        cwd: root,
        environment,
        platform: "win32" as const,
    };
    const windows = discoverWindowsBuildTools("auto", options);
    assert.equal(windows.compiler, clang);
    assert.equal(windows.ninja, ninja);
    assert.match(windows.environment.INCLUDE ?? "", /10\.0\.26100\.0/);

    const tools = discoverDevelopmentTools(options);
    assert.equal(tools.cmake, cmake);
    assert.equal(tools.vcpkg, vcpkg);
    assert.equal(tools.vcpkgRoot, resolve(vs, "VC/vcpkg"));
    const ccache = resolve(root, "artifacts/tools/ccache/ccache.exe");
    touch(ccache);
    assert.equal(discoverDevelopmentTools(options).ccache, ccache);
    assert.equal(
        discoverDevelopmentTools({
            ...options,
            environment: {
                ...environment,
                CCACHE_PATH: resolve(root, "missing-ccache.exe"),
            },
        }).ccache,
        undefined,
    );
});

test("an explicit invalid vcpkg root is reported instead of hidden by a fallback", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-tools-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const tools = discoverDevelopmentTools({
        cwd: root,
        environment: {
            PATH: "",
            VCPKG_ROOT: resolve(root, "missing-vcpkg"),
        },
        platform: "win32",
    });
    assert.equal(tools.vcpkgRoot, undefined);
    assert.equal(tools.vcpkg, undefined);
});

for (const platform of ["linux", "darwin"] as const)
    test(`${platform} discovery finds native tools and archives without Windows artifacts`, (t) => {
        const root = mkdtempSync(join(tmpdir(), "bblitec-linux-tools-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const bin = join(root, "bin");
        for (const name of [
            "cmake",
            "pwsh",
            "git",
            "ccache",
            "clang",
            "clang++",
            "gcc",
            "g++",
        ])
            touch(join(bin, name));
        const vcpkg = join(root, "vcpkg");
        touch(join(vcpkg, "vcpkg"));
        touch(join(vcpkg, "scripts/buildsystems/vcpkg.cmake"));
        const dawn = join(root, "artifacts/tools/dawn");
        touch(join(dawn, "lib/cmake/Dawn/DawnConfig.cmake"));
        const dawnLibrary = join(
            dawn,
            `lib/libwebgpu_dawn.${platform === "darwin" ? "dylib" : "so"}`,
        );
        touch(dawnLibrary);
        const labsound = join(root, "artifacts/tools/labsound");
        for (const path of [
            "lib/libLabSound.a",
            "lib/liblibnyquist.a",
            "include/libnyquist/Decoders.h",
        ]) {
            touch(join(labsound, path));
        }
        const dxc = join(
            root,
            `tools/shader-compiler/vcpkg_installed/${process.arch}-linux/tools/directx-dxc/dxc`,
        );
        touch(dxc);
        touch(join(root, "artifacts/tools/tint/tint"));
        const options = {
            cwd: root,
            platform,
            environment: { PATH: "bin", VCPKG_ROOT: vcpkg },
        };
        const tools = discoverDevelopmentTools(options);
        assert.equal(tools.cmake, join(bin, "cmake"));
        assert.equal(tools.cc, join(bin, "clang"));
        assert.equal(tools.cxx, join(bin, "clang++"));
        const gcc = discoverDevelopmentTools({
            cwd: root,
            platform: "linux",
            environment: { PATH: "bin", CC: "gcc", CXX: "g++" },
        });
        assert.equal(gcc.cc, join(bin, "gcc"));
        assert.equal(gcc.cxx, join(bin, "g++"));
        assert.equal(
            discoverDevelopmentTools({
                cwd: root,
                platform: "linux",
                environment: { PATH: "bin", CXX: "missing" },
            }).cxx,
            undefined,
        );
        assert.equal(tools.powershell, join(bin, "pwsh"));
        assert.equal(tools.vcpkg, join(vcpkg, "vcpkg"));
        if (platform === "linux") assert.equal(tools.dxc, dxc);
        assert.equal(tools.dawnInstalled, true);
        assert.equal(tools.labSoundInstalled, true);
        assert.equal(tools.visualStudioRoot, undefined);
        rmSync(dawnLibrary);
        assert.equal(discoverDevelopmentTools(options).dawnInstalled, false);
    });

test("a pinned artifact whose patch record differs counts as not installed; an unrecorded one is reported", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-patch-record-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dawn = join(root, "artifacts/tools/dawn");
    touch(join(dawn, "lib/cmake/Dawn/DawnConfig.cmake"));
    touch(join(dawn, "lib/libwebgpu_dawn.so"));
    const options = {
        cwd: root,
        platform: "linux" as const,
        environment: { PATH: "" },
    };
    const record = (): { state: string; message: string | undefined } => {
        const found = discoverDevelopmentTools(
            options,
        ).dependencyPatchRecords.find((entry) => entry.library === "dawn");
        assert.ok(found, "a built Dawn artifact carries a record state");
        return { state: found.state.state, message: found.message };
    };

    // Artifacts built before records existed stay usable and are reported.
    assert.equal(discoverDevelopmentTools(options).dawnInstalled, true);
    assert.equal(record().state, "unrecorded");
    assert.match(record().message ?? "", /records no source\/patch set/);

    // Linux Dawn applies no maintained patch: the record names the pin only.
    const expected = expectedPatchRecord(readPatchManifest(), "dawn", []);
    assert.equal(expected.patches, "");
    const write = (source: string, patches: string): void =>
        writeFileSync(
            join(dawn, "bblite-dawn-features.cmake"),
            `set(BBLITE_DAWN_SOURCE "${source}")\nset(BBLITE_DAWN_PATCHES "${patches}")\n`,
        );
    write(expected.source, expected.patches);
    assert.equal(record().state, "current");
    assert.equal(record().message, undefined);
    assert.equal(discoverDevelopmentTools(options).dawnInstalled, true);

    // A different patch set or source is stale: setup rebuilds it.
    write(expected.source, "0001-android-surface-loss.patch=00");
    assert.equal(record().state, "stale");
    assert.equal(discoverDevelopmentTools(options).dawnInstalled, false);
    write("0000000000000000000000000000000000000000", expected.patches);
    assert.equal(discoverDevelopmentTools(options).dawnInstalled, false);
    assert.match(record().message ?? "", /setup rebuilds it/);
});
