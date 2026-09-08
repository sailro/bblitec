import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
        ["jpeg", "navigation", "navigation-crowd", "navigation-tile-cache", "physics", "png", "text-layout", "ui", "ui-svg", "webp"],
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
    // The package is the executable alone: the trimmed SDL carries only the
    // Direct3D 12 driver, so no launcher pins one, and the console window
    // is the log.
    assert.doesNotMatch(script, /SDL_GPU_DRIVER|run-\$Scene\.cmd|\.log/);
    assert.match(script, /Double-click \$exeName/);
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
    // The staged package runs for a few frames and must exit cleanly
    // before the archive is written.
    const smoke = script.slice(
        script.indexOf("$smokeFrames = 5"),
        script.indexOf("Compress-Archive"),
    );
    assert.match(smoke, /Environment\["BBLITE_MAX_FRAMES"\] = "\$smokeFrames"/);
    assert.match(smoke, /WorkingDirectory = \$packageDirectory/);
    assert.match(smoke, /WaitForExit\(120000\)/);
    assert.match(smoke, /\$smoke\.ExitCode -ne 0/);
});

test("the trimmed SDL build has a separate audio-capable variant", () => {
    const script = readFileSync("tools/build-sdl-min.ps1", "utf8");
    assert.match(script, /\[switch\]\$EnableAudio/);
    assert.match(script, /sdl-min-audio/);
    // The subsystem switches are one table, passed as "-D<name>=<value>"
    // (a quoted, expanded string) and read back from the cache CMake
    // wrote. A bare `-DSDL_AUDIO=$audioSetting` token reaches CMake as
    // that text, which its if() reads as true: the subsystem stays in.
    assert.match(script, /SDL_AUDIO = \$audioSetting/);
    assert.match(script, /SDL_JOYSTICK = \$gamepadSetting/);
    assert.match(script, /SDL_HIDAPI = \$gamepadSetting/);
    assert.match(script, /SDL_DIALOG = "ON"/);
    assert.match(script, /"-D\$\(\$option\.Key\)=\$\(\$option\.Value\)"/);
    assert.doesNotMatch(script, /^\s*-D[A-Za-z_]+=\$/m);
    assert.doesNotMatch(script, /^\s*"?-DSDL_/m);
    assert.match(script, /Read-CMakeCache \(Join-Path \$build "CMakeCache\.txt"\)/);
    assert.match(script, /\$actual -ne \$option\.Value/);
    assert.match(script, /Contains\('\$'\)/);
    assert.match(script, /BBLITE_SDL_DIALOG ON/);
    assert.match(script, /bblite-sdl-features\.cmake/);
    // The script-only patch lives beside the LabSound one, outside the
    // overlay port directory that keys the development vcpkg install.
    assert.match(script, /tools\\patches\\sdl-static-no-dynapi\.patch/);
    assert.doesNotMatch(script, /overlay-ports\\sdl3\\static-no-dynapi/);
    assert.ok(existsSync("tools/patches/sdl-static-no-dynapi.patch"));
    assert.ok(!existsSync("native/vcpkg-overlay-ports/sdl3/static-no-dynapi.patch"));

    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    assert.match(cmake, /include\("\$\{BBLITE_SDL_FEATURES\}"\)/);
    assert.match(cmake, /NOT BBLITE_SDL_AUDIO/);
    assert.match(
        cmake,
        /"browser:file" IN_LIST BBLITE_RUNTIME_FEATURES[\s\S]{0,100}NOT BBLITE_SDL_DIALOG/,
    );
    // The reverse mismatch -- an SDL carrying a subsystem the scene never
    // reaches -- links, so a minimal build names the smaller install.
    assert.match(
        cmake,
        /if\(BBLITE_SDL_DIR AND BBLITE_MINSIZE\)[\s\S]{0,700}message\(\s*WARNING/,
    );
    assert.doesNotMatch(cmake, /comdlg32/);
});

test("the PowerShell tools share one module for discovery, checkouts and caches", () => {
    const module = readFileSync("tools/bblite-tools.psm1", "utf8");
    for (const helper of [
        "Get-RepositoryRoot",
        "Resolve-RepositoryPath",
        "Get-VisualStudioRoot",
        "Find-CMake",
        "Get-DevToolchain",
        "Sync-PinnedCheckout",
        "Read-CMakeCache",
    ]) {
        assert.match(module, new RegExp(`function ${helper}`));
        assert.match(module, new RegExp(`"${helper}"`));
    }
    const scripts = readdirSync("tools").filter(
        (name) => /^build-.*\.ps1$/.test(name) || name === "package-demo.ps1",
    );
    assert.equal(scripts.length, 7);
    for (const name of scripts) {
        const script = readFileSync(`tools/${name}`, "utf8");
        assert.match(
            script,
            /Import-Module \(Join-Path \$PSScriptRoot "bblite-tools\.psm1"\) -Force/,
            `${name} does not import the shared module`,
        );
        assert.doesNotMatch(
            script,
            /function (Sync-PinnedCheckout|Get-DevToolchain|Find-CMake|Read-CMakeCache)/,
            `${name} carries its own copy of a shared helper`,
        );
        assert.doesNotMatch(script, /Get-Command cmake/, `${name} rediscovers CMake itself`);
        assert.doesNotMatch(script, /vswhere/, `${name} rediscovers Visual Studio itself`);
        assert.doesNotMatch(script, /git -C \$\w+ fetch --depth 1 origin \$/, `${name} syncs a pinned checkout itself`);
    }
});

test("feature macros come from one CMake function", () => {
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    assert.match(cmake, /function\(bblite_feature_define macro\)/);
    for (const [macro, feature] of [
        ["BBLITE_HAS_GAMEPAD", "input:gamepad"],
        ["BBLITE_HAS_PBR_RENDERER", "renderer:scene"],
        ["BBLITE_HAS_PHYSICS_QUERIES", "physics:queries"],
        ["BBLITE_HAS_PHYSICS_CONSTRAINTS", "physics:constraints"],
        ["BBLITE_HAS_PHYSICS_TRIGGER", "physics:trigger"],
        ["BBLITE_HAS_PHYSICS_HEIGHTFIELD", "physics:heightfield"],
        ["BBLITE_HAS_PHYSICS_CHARACTER", "physics:character-controller"],
        ["BBLITE_HAS_PHYSICS_FLOATING_ORIGIN", "physics:floating-origin"],
        ["BBLITE_HAS_NAV_TILE_CACHE", "navigation:tile-cache"],
        ["BBLITE_PHYSICS_VIEWER", "physics:viewer"],
    ]) {
        assert.match(cmake, new RegExp(`bblite_feature_define\\(${macro} "${feature}"\\)`));
    }
    assert.match(cmake, /bblite_feature_define\(BBLITE_HAS_TEXT "text:renderable" "renderer:text"\)/);
    assert.ok((cmake.match(/bblite_feature_define\(/g) ?? []).length >= 36);
    // No hand-written 1/0 pair is left for a single-feature macro, no
    // macro is defined without a reader, and the one stack reservation
    // sits outside the compiler split.
    assert.doesNotMatch(
        cmake,
        /if\("[a-z:-]+" IN_LIST BBLITE_RUNTIME_FEATURES\)\s*target_compile_definitions\(\s*bblite_native\s+PRIVATE\s+BBLITE_[A-Z_]+=1\s*\)\s*else\(\)/,
    );
    assert.doesNotMatch(cmake, /BBLITE_HAS_GLTF/);
    assert.equal((cmake.match(/\/STACK:8388608/g) ?? []).length, 1);
    // A generated tree without a codec list is refused, not defaulted.
    assert.match(cmake, /if\(NOT DEFINED BBLITE_IMAGE_CODECS\)\s*message\(\s*FATAL_ERROR/);
});

test("the shipping presets spell the documented minimal recipe", () => {
    const presets = JSON.parse(readFileSync("native/CMakePresets.json", "utf8")) as {
        configurePresets: Array<{
            name: string;
            inherits?: string;
            cacheVariables?: Record<string, string>;
        }>;
    };
    const byName = new Map(presets.configurePresets.map((preset) => [preset.name, preset]));
    const resolved = (name: string): Record<string, string> => {
        const preset = byName.get(name);
        assert.ok(preset, `preset ${name} is missing`);
        return {
            ...(preset.inherits ? resolved(preset.inherits) : {}),
            ...(preset.cacheVariables ?? {}),
        };
    };
    const visual = resolved("min-sdl");
    assert.equal(visual.BBLITE_MINSIZE, "ON");
    assert.equal(visual.BBLITE_BACKEND, "SDL_GPU");
    assert.equal(visual.BBLITE_VISUAL_CAPTURE, "OFF");
    assert.equal(visual.CMAKE_CXX_COMPILER, "cl");
    assert.equal(visual.VCPKG_TARGET_TRIPLET, "x64-windows-static");
    assert.match(visual.CMAKE_MSVC_RUNTIME_LIBRARY ?? "", /^MultiThreaded/);
    assert.match(visual.BBLITE_SDL_DIR ?? "", /\/sdl-min$/);
    const audio = resolved("min-sdl-audio-gamepad");
    assert.match(audio.BBLITE_SDL_DIR ?? "", /\/sdl-min-audio-gamepad$/);
    assert.match(audio.BBLITE_LABSOUND_DIR ?? "", /\/labsound-static$/);
    assert.equal(audio.BBLITE_MINSIZE, "ON");
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
    assert.match(cmake, /BBLITE_HAS_AUDIO_CAPTURE=\$<BOOL:\$\{BBLITE_AUDIO_CAPTURE\}>/);
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

    // The pin names every maintained patch, and the directory is the
    // set the builder applies and records; the two must be one set.
    const directoryPatches = readdirSync("native/patches")
        .filter((name) => /^rmlui-.*\.patch$/.test(name))
        .sort();
    assert.deepEqual(record.patches, directoryPatches);
    assert.ok(directoryPatches.length >= 5);

    const builder = readFileSync("tools/build-rmlui.ps1", "utf8");
    assert.match(builder, /\[switch\]\$StaticRuntime/);
    assert.match(builder, /upstream\\rmlui\.json/);
    assert.match(builder, /apply-rmlui-patch\.cmake/);
    assert.match(builder, /Get-ChildItem \$patchDirectory -Filter "rmlui-\*\.patch"/);
    assert.match(builder, /\$pinnedPatches -join ";"\) -ne \(\$directoryPatches -join ";"/);
    assert.doesNotMatch(builder, /rmlui-premultiplied-rounding\.patch/);
    assert.match(builder, /Get-FileHash \$_\.FullName -Algorithm SHA256/);
    assert.match(builder, /set\(BBLITE_RMLUI_COMMIT/);
    assert.match(builder, /set\(BBLITE_RMLUI_PATCHES/);
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
    // An artifact is refused when its recorded commit or patch set is not
    // what the pin and native/patches say now, naming the rebuild.
    assert.match(cmake, /string\(JSON BBLITE_RMLUI_PINNED_COMMIT GET "\$\{BBLITE_RMLUI_PIN\}" commit\)/);
    assert.match(cmake, /file\(GLOB BBLITE_RMLUI_PATCH_FILES "\$\{BBLITE_NATIVE_ROOT\}\/patches\/rmlui-\*\.patch"\)/);
    assert.match(cmake, /file\(SHA256 "\$\{bblite_rmlui_patch\}" bblite_rmlui_patch_digest\)/);
    assert.match(cmake, /NOT BBLITE_RMLUI_COMMIT STREQUAL BBLITE_RMLUI_PINNED_COMMIT/);
    assert.match(cmake, /NOT "\$\{BBLITE_RMLUI_PATCHES\}" STREQUAL "\$\{BBLITE_RMLUI_EXPECTED_PATCHES\}"/);
    assert.match(cmake, /Rebuild it with "\s*"\$\{BBLITE_RMLUI_BUILD_COMMAND\}\."/);
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
