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
        ["jpeg", "navigation", "physics", "ui", "webp"],
    );
});

test("keeps RmlUi recording backend-neutral and realizes it in scene and sprite renderers", () => {
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const projection = readFileSync("native/src/pal_ui_rml.cpp", "utf8");
    const systemFonts = readFileSync(
        "native/src/pal_system_fonts.cpp",
        "utf8",
    );
    const systemFontsHeader = readFileSync(
        "native/include/bblite/pal_system_fonts.hpp",
        "utf8",
    );
    const sdl = readFileSync("native/src/pal_sdl_gpu.cpp", "utf8");
    const dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
    const spriteSdl = readFileSync(
        "native/src/pal_sdl_gpu_sprite.cpp",
        "utf8",
    );
    const spriteDawn = readFileSync(
        "native/src/pal_dawn_sprite.cpp",
        "utf8",
    );
    const spriteSdlUi = readFileSync(
        "native/src/pal_sprite_ui_sdl.hpp",
        "utf8",
    );
    const spriteDawnUi = readFileSync(
        "native/src/pal_sprite_ui_dawn.hpp",
        "utf8",
    );

    assert.doesNotMatch(cmake, /RmlUi_Renderer_SDL_GPU\.cpp/);
    assert.doesNotMatch(projection, /RenderInterface_SDL_GPU|SDL_GPUDevice/);
    assert.match(cmake, /src\/pal_system_fonts\.cpp/);
    assert.match(systemFonts, /DWriteCreateFactory/);
    assert.match(systemFonts, /CTFontDescriptorCreateWithAttributes/);
    assert.match(systemFonts, /FcFontMatch/);
    const fontArchitecture =
        cmake + projection + systemFonts + systemFontsHeader;
    assert.doesNotMatch(
        fontArchitecture,
        /FontChoice|std::filesystem::exists/,
    );
    assert.doesNotMatch(
        fontArchitecture,
        /["'][^"'\r\n]*(?:[\\/]fonts[\\/]|\.tt[fc]\b|\.otf\b)[^"'\r\n]*["']/i,
    );
    assert.match(projection, /class UiRenderRecorder/);
    assert.match(projection, /record_ui_rml_frame/);
    assert.match(sdl, /render_ui_sdl_frame/);
    assert.match(dawn, /render_ui_dawn_frame/);
    assert.match(sdl, /multisample_layer/);
    assert.match(dawn, /multisample_layer/);
    assert.match(spriteSdl, /render_sprite_ui_sdl_frame/);
    assert.match(spriteDawn, /render_sprite_ui_dawn_frame/);
    assert.match(spriteSdl, /handle_ui_rml_event/);
    assert.match(spriteDawn, /handle_ui_rml_event/);
    for (const renderer of [sdl, dawn, spriteSdlUi, spriteDawnUi]) {
        assert.match(renderer, /ui_frame_uses_texture/);
        assert.match(renderer, /draw\.nearest_sampling/);
    }
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
    assert.match(block, /\/STACK:8388608/);
    assert.match(
        cmake,
        /main\.cpp"\s+PROPERTIES COMPILE_OPTIONS "\/wd4702"/,
    );
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
    assert.match(script, /generated scene id/);
    assert.match(script, /IsPathRooted\(\$OutputRoot\)/);
    assert.match(script, /if \(Test-Path \$assetSource\)/);
    assert.doesNotMatch(script, /numbered scene id/);
    assert.doesNotMatch(script, /run-\$Scene-dawn/);
});

test("the trimmed SDL build has a separate audio-capable variant", () => {
    const script = readFileSync("tools/build-sdl-min.ps1", "utf8");
    assert.match(script, /\[switch\]\$EnableAudio/);
    assert.match(script, /sdl-min-audio/);
    assert.match(script, /-DSDL_AUDIO=\$audioSetting/);
    assert.match(script, /bblite-sdl-features\.cmake/);

    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    assert.match(cmake, /include\("\$\{BBLITE_SDL_FEATURES\}"\)/);
    assert.match(cmake, /NOT BBLITE_SDL_AUDIO/);
});

test("minimal audio dependencies use a static runtime and ship their notices", () => {
    const builder = readFileSync("tools/build-labsound.ps1", "utf8");
    assert.match(builder, /\[switch\]\$StaticRuntime/);
    assert.match(builder, /\[switch\]\$EnableCodecs/);
    assert.match(builder, /CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded/);
    assert.match(builder, /bblite-labsound-features\.cmake/);
    assert.match(builder, /libnyquist-COPYING\.txt/);

    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    assert.match(cmake, /NOT BBLITE_LABSOUND_STATIC_RUNTIME/);
    assert.match(cmake, /if\(BBLITE_AUDIO_CAPTURE\)/);
    assert.match(
        cmake,
        /NOT BBLITE_AUDIO_CAPTURE\s+AND NOT BBLITE_AUDIO_DECODE_FILE\s+AND NOT BBLITE_LABSOUND_CORE_ONLY/,
    );
    assert.doesNotMatch(
        cmake,
        /LabSound\.lib"\s*"\$\{BBLITE_LABSOUND_DIR\}\/lib\/libnyquist\.lib/,
    );

    const packager = readFileSync("tools/package-demo.ps1", "utf8");
    assert.match(packager, /\$audioReached/);
    assert.match(packager, /\$audioDecoded/);
    assert.match(packager, /LabSound-LICENSE\.txt/);
    assert.match(packager, /libnyquist-COPYING\.txt/);
    assert.match(packager, /if \(\$audioCapture -or \$audioDecoded\)/);
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

test("native shader snapshots track additions and removals", () => {
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    assert.match(cmake, /list\(SORT BBLITE_GENERATED_SHADER_FILES\)/);
    assert.match(cmake, /bblite-generated-shaders\.manifest/);
    assert.match(
        cmake,
        /DEPENDS\s+\$\{BBLITE_GENERATED_SHADER_FILES\}\s+"\$\{BBLITE_GENERATED_SHADER_MANIFEST\}"/,
    );
});
