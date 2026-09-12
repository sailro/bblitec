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
    const ccache = resolve(root, "artifacts/tools/ccache/ccache.exe");
    touch(ccache);
    assert.equal(discoverDevelopmentTools(options).ccache, ccache);
    assert.equal(discoverDevelopmentTools({ ...options, environment: {
        ...environment, CCACHE_PATH: resolve(root, "missing-ccache.exe"),
    } }).ccache, undefined);
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

test("Linux discovery finds native tools and archives without Windows artifacts", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-linux-tools-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    for (const name of ["cmake", "pwsh", "git", "ccache", "clang", "clang++", "gcc", "g++"]) touch(join(bin, name));
    const vcpkg = join(root, "vcpkg");
    touch(join(vcpkg, "vcpkg"));
    touch(join(vcpkg, "scripts/buildsystems/vcpkg.cmake"));
    const dawn = join(root, "artifacts/tools/dawn");
    touch(join(dawn, "lib/cmake/Dawn/DawnConfig.cmake"));
    touch(join(dawn, "lib/libwebgpu_dawn.so"));
    const labsound = join(root, "artifacts/tools/labsound");
    for (const path of ["lib/libLabSound.a", "lib/liblibnyquist.a", "include/libnyquist/Decoders.h"]) {
        touch(join(labsound, path));
    }
    const dxc = join(root, `tools/shader-compiler/vcpkg_installed/${process.arch}-linux/tools/directx-dxc/dxc`);
    touch(dxc);
    touch(join(root, "artifacts/tools/tint/tint"));
    const tools = discoverDevelopmentTools({ cwd: root, platform: "linux", environment: { PATH: "bin", VCPKG_ROOT: vcpkg } });
    assert.equal(tools.cmake, join(bin, "cmake"));
    assert.equal(tools.cc, join(bin, "clang"));
    assert.equal(tools.cxx, join(bin, "clang++"));
    const gcc = discoverDevelopmentTools({ cwd: root, platform: "linux", environment: { PATH: "bin", CC: "gcc", CXX: "g++" } });
    assert.equal(gcc.cc, join(bin, "gcc"));
    assert.equal(gcc.cxx, join(bin, "g++"));
    assert.equal(discoverDevelopmentTools({ cwd: root, platform: "linux", environment: { PATH: "bin", CXX: "missing" } }).cxx, undefined);
    assert.equal(tools.powershell, join(bin, "pwsh"));
    assert.equal(tools.vcpkg, join(vcpkg, "vcpkg"));
    assert.equal(tools.dxc, dxc);
    assert.equal(tools.dawnInstalled, true);
    assert.equal(tools.labSoundInstalled, true);
    assert.equal(tools.visualStudioRoot, undefined);
});
