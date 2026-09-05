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
    needsOfflineShaders,
} from "../src/build-options.js";

test("Dawn-only iteration needs no offline compiler unless a target is explicitly requested", () => {
    assert.equal(needsOfflineShaders("DAWN"), false);
    assert.equal(needsOfflineShaders("SDL_GPU"), true);
    assert.equal(needsOfflineShaders("BOTH"), true);
    assert.equal(needsOfflineShaders("DAWN", "all"), true);
    assert.equal(needsOfflineShaders("DAWN", "d3d12"), true);
});

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
        ["jpeg", "navigation", "physics", "ui", "ui-svg", "webp"],
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
    assert.match(
        projection,
        /take_crosshair_color[\s\S]{0,120}--bbl-crosshair/,
    );
    assert.match(
        projection,
        /append_crosshair[\s\S]{0,900}SetInnerRML/,
    );
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

test("normalizes retained CSS cascade keywords and measures width resets", () => {
    const projection = readFileSync("native/src/pal_ui_rml.cpp", "utf8");
    const declarations = projection.slice(
        projection.indexOf("std::string take_css_declaration"),
        projection.indexOf("bool is_private_ui_declaration"),
    );
    assert.match(declarations, /ascii_iequals/);
    assert.match(
        declarations,
        /result = std::string\(\s*trim_css_token/,
    );
    assert.doesNotMatch(declarations, /result = ascii_lower/);

    const gridCascade = projection.slice(
        projection.indexOf("std::string resolved_style_attribute"),
        projection.indexOf("bool text_needs_flex_wrapper"),
    );
    const styleSource = projection.slice(
        projection.indexOf("ProjectedUiStyleSource project_ui_style_source"),
        projection.indexOf("std::string take_grid_children_style"),
    );
    assert.match(
        styleSource,
        /normalized_css_keyword\([\s\S]{0,100}take_css_declaration\(public_probe, "display"\)/,
    );
    assert.match(gridCascade, /project_ui_style_source\(rule\.style\)/);
    assert.match(
        gridCascade,
        /normalized_css_keyword\(dynamic_display->second\)/,
    );
    assert.match(
        gridCascade,
        /normalized_css_keyword\(dynamic_justification->second\)/,
    );

    const intrinsic = projection.slice(
        projection.indexOf("bool has_active_authored_width"),
        projection.indexOf("bool sync_hover_states"),
    );
    assert.match(intrinsic, /CascadedUiDeclaration width/);
    assert.match(intrinsic, /consider_cascaded_declaration/);
    assert.match(intrinsic, /ui_style_rule_specificity\(rule\)/);
    assert.match(intrinsic, /is_concrete_authored_width\(width\.value\)/);
    const concreteWidth = projection.slice(
        projection.indexOf("bool is_concrete_authored_width"),
        projection.indexOf("UiElementRecord& ui_element"),
    );
    for (const reset of ["auto", "initial", "unset"]) {
        assert.match(concreteWidth, new RegExp(`keyword != "${reset}"`));
    }
    const setAttribute = projection.slice(
        projection.indexOf("void ui_set_attribute"),
        projection.indexOf("void ui_set_style_property"),
    );
    assert.match(
        setAttribute,
        /name == "style"[\s\S]{0,120}record\.style_properties\.clear\(\)/,
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
    assert.match(script, /-DSDL_DIALOG=ON/);
    assert.match(script, /BBLITE_SDL_DIALOG ON/);
    assert.match(script, /bblite-sdl-features\.cmake/);

    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    assert.match(cmake, /include\("\$\{BBLITE_SDL_FEATURES\}"\)/);
    assert.match(cmake, /NOT BBLITE_SDL_AUDIO/);
    assert.match(
        cmake,
        /"browser:file" IN_LIST BBLITE_RUNTIME_FEATURES[\s\S]{0,100}NOT BBLITE_SDL_DIALOG/,
    );
    assert.doesNotMatch(cmake, /comdlg32/);
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

test("RmlUi is the pinned artifact, patched, with a static-runtime variant", () => {
    const pin: unknown = JSON.parse(
        readFileSync("upstream/rmlui.json", "utf8"),
    );
    assert.ok(
        pin !== null && typeof pin === "object",
        "upstream/rmlui.json must be an object",
    );
    const record = pin as Record<string, unknown>;
    assert.match(String(record.repository), /^https:\/\/github\.com\//);
    assert.match(String(record.commit), /^[0-9a-f]{40}$/);
    assert.equal(record.license, "MIT");

    const builder = readFileSync("tools/build-rmlui.ps1", "utf8");
    assert.match(builder, /\[switch\]\$StaticRuntime/);
    assert.match(builder, /upstream\\rmlui\.json/);
    assert.match(builder, /apply-rmlui-patch\.cmake/);
    assert.match(builder, /rmlui-premultiplied-rounding\.patch/);
    assert.match(builder, /rmlui-css-box-model\.patch/);
    assert.match(builder, /CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded/);
    assert.match(builder, /bblite-rmlui-features\.cmake/);
    assert.match(builder, /RMLUI_SVG_PLUGIN=\$rmlSvgSetting/);
    assert.match(builder, /\$rmlSvgEnabled = -not \$StaticRuntime -or \$EnableSvg/);
    assert.match(builder, /\[switch\]\$EnableSvg/);
    assert.match(builder, /lunasvgConfig\.cmake/);
    // The SDL platform pair RmlUi itself never installs, and the license
    // the packager copies out of the artifact.
    assert.match(builder, /RmlUi_Platform_SDL\.cpp/);
    assert.match(builder, /RmlUi_Platform_SDL\.h/);
    assert.match(builder, /RmlUi-LICENSE\.txt/);

    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    // Consumed as an installed package at BBLITE_RMLUI_DIR — never
    // re-fetched and re-built per build tree at configure.
    assert.doesNotMatch(cmake, /FetchContent/);
    assert.match(cmake, /tools\/build-rmlui\.ps1/);
    assert.match(cmake, /NOT BBLITE_RMLUI_STATIC_RUNTIME/);
    assert.match(cmake, /ui:inline-svg/);
    assert.match(cmake, /NOT RMLUI_SVG_PLUGIN/);
    assert.match(
        cmake,
        /\$\{BBLITE_RMLUI_DIR\}\/Backends\/RmlUi_Platform_SDL\.cpp/,
    );

    const packager = readFileSync("tools/package-demo.ps1", "utf8");
    assert.match(packager, /BBLITE_RMLUI_DIR/);
    assert.match(packager, /RmlUi-LICENSE\.txt/);
    assert.match(packager, /LunaSVG\.txt.*lunasvg/s);
    assert.match(packager, /PlutoVG\.txt.*plutovg/s);
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

test("shader slot sidecars rebase storage buffers within their register space", () => {
    const script = readFileSync("tools/compile-shaders.ps1", "utf8");
    assert.match(script, /\$sampledBySpace = @\{\}/);
    assert.match(script, /\$sampled\.Groups\[1\]\.Success/);
    assert.match(script, /\$_\.Groups\[6\]\.Success/);
    assert.match(script, /\$sampledBySpace\[\$space\]/);
    assert.match(script, /\$sampledBySpace\[\$space\] \?\? 0/);
    assert.doesNotMatch(script, /\[int\]\$_\.Groups\[5\]\.Value - \$sampledCount/);
});

test("SDL shader slot loading rejects unbounded generated indices", () => {
    const source = readFileSync("native/src/pal_sdl_gpu_shared.hpp", "utf8");
    assert.match(source, /constexpr std::size_t max_slot_index = 4096;/);
    assert.match(source, /digit < '0' \|\| digit > '9'/);
    assert.match(source, /Malformed shader slot/);
    assert.doesNotMatch(source, /std::stoul\(reg\.substr\(1\)\)/);
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
