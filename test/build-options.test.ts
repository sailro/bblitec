import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    canonicalCompiledBackend,
    canonicalDevelopmentCompiler,
    canonicalOfflineShaderTarget,
    defaultDevelopmentBackend,
    DEVELOPMENT_VCPKG_INSTALL,
    developmentVcpkgFeatures,
    hostOfflineShaderTarget,
} from "../src/build-options.js";

test("the development vcpkg install contains every manifest feature", () => {
    const manifest = JSON.stringify({
        features: {
            webp: { dependencies: [] },
            physics: { dependencies: [] },
            jpeg: { dependencies: [] },
        },
    });
    assert.equal(DEVELOPMENT_VCPKG_INSTALL, "development-full");
    assert.deepEqual(developmentVcpkgFeatures(manifest), [
        "jpeg",
        "physics",
        "webp",
    ]);
    assert.throws(
        () => developmentVcpkgFeatures('{"dependencies":[]}'),
        /features object/,
    );
});

test("canonicalizes the development compiler", () => {
    assert.equal(canonicalDevelopmentCompiler("auto"), "auto");
    assert.equal(canonicalDevelopmentCompiler("MSVC"), "msvc");
    assert.equal(canonicalDevelopmentCompiler("clang-cl"), "clangcl");
    assert.throws(
        () => canonicalDevelopmentCompiler("gcc"),
        /auto\|msvc\|clangcl/,
    );
});

test("the repository manifest automatically feeds the full dev set", () => {
    assert.deepEqual(
        developmentVcpkgFeatures(
            readFileSync("native/vcpkg.json", "utf8"),
        ),
        ["jpeg", "navigation", "physics", "webp"],
    );
});

test("canonicalizes the build-time backend flag", () => {
    assert.equal(defaultDevelopmentBackend("win32"), "BOTH");
    assert.equal(defaultDevelopmentBackend("linux"), "SDL_GPU");
    assert.equal(canonicalCompiledBackend("sdl_gpu", "build"), "SDL_GPU");
    assert.equal(canonicalCompiledBackend("DAWN", "process"), "DAWN");
    assert.equal(canonicalCompiledBackend("both", "process"), "BOTH");
    assert.throws(
        () => canonicalCompiledBackend("vulkan", "build"),
        /--backend must be sdl_gpu\|dawn\|both/,
    );
});

test("compiles only the host's offline shader format by default", () => {
    assert.equal(hostOfflineShaderTarget("win32"), "d3d12");
    assert.equal(hostOfflineShaderTarget("darwin"), "metal");
    assert.equal(hostOfflineShaderTarget("linux"), "vulkan");
    assert.equal(hostOfflineShaderTarget("win32", "all"), "all");
    assert.equal(canonicalOfflineShaderTarget("D3D12"), "d3d12");
    assert.throws(
        () => canonicalOfflineShaderTarget("spirv"),
        /d3d12\|vulkan\|metal\|all/,
    );
});

test("minimal mode has dedicated MSVC and clang-cl size flags", () => {
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const block = cmake.slice(cmake.indexOf("if(BBLITE_MINSIZE)"));
    assert.match(block, /CMAKE_CXX_COMPILER_ID MATCHES "Clang"/);
    assert.match(block, /\/clang:-Oz \/clang:-flto/);
    assert.match(block, /\/O1 \/Ob1 \/GL \/Gw/);
    assert.match(block, /PRIVATE -Os -ffunction-sections/);
});

test("shipping packages require the trimmed static build", () => {
    const script = readFileSync("tools/package-demo.ps1", "utf8");
    const patterns = script.slice(
        script.indexOf("$shaderPatterns ="),
        script.indexOf("$shaderFiles ="),
    );
    assert.match(script, /SDL_GPU_DRIVER=direct3d12/);
    assert.match(patterns, /\*\.dxil/);
    assert.doesNotMatch(patterns, /\*\.spv/);
    assert.match(script, /VCPKG_INSTALLED_DIR/);
    assert.match(script, /BBLITE_MINSIZE/);
    assert.match(script, /x64-windows-static/);
    assert.match(script, /CMAKE_MSVC_RUNTIME_LIBRARY/);
    assert.match(script, /MultiThreaded/);
    assert.match(script, /single backend/);
    assert.doesNotMatch(script, /run-\$Scene-dawn/);
});

test("shader compilation gates non-target formats", () => {
    const script = readFileSync("tools/compile-shaders.ps1", "utf8");
    assert.match(script, /\$emitDxil = \$Target -in/);
    assert.match(script, /\$emitSpirv = \$Target -in/);
    assert.match(script, /\$emitMsl = \$Target -in/);
    assert.match(script, /if \(\$emitSpirv\)/);
    assert.match(script, /if \(\$emitMsl\)/);
    assert.match(script, /target = \$Target/);
    assert.doesNotMatch(script, /Copy-Item \$cached(?:Dxil|Spirv)/);
    assert.match(script, /Copy-IfDifferent \$cachedDxil/);
});
