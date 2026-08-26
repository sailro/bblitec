import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
    discoverDevelopmentTools,
    discoverWindowsBuildTools,
} from "../src/development-tools.js";

function touch(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
}

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
