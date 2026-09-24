import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
    canonicalCompiledBackend,
    canonicalDevelopmentCompiler,
    canonicalOfflineShaderTarget,
    compiledBuildDirectory,
    defaultDevelopmentBackend,
    DEVELOPMENT_VCPKG_INSTALL,
    developmentVcpkgFeatures,
    developmentTriplet,
    hostOfflineShaderTarget,
    needsOfflineShaders,
} from "../src/build-options.js";
import { shadowGeneratorFeatures } from "../src/shadow-capabilities.js";
import { listFiles } from "../src/tooling/records.js";

test("compiled backends have independent build and deployment directories", () => {
    const directory = "native/build-primitives-release";
    assert.equal(compiledBuildDirectory(directory, "BOTH"), directory);
    assert.equal(
        compiledBuildDirectory(directory, "SDL_GPU"),
        `${directory}-sdl_gpu`,
    );
    assert.equal(
        compiledBuildDirectory(directory, "DAWN"),
        `${directory}-dawn`,
    );
});

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
        developmentVcpkgFeatures(readFileSync("native/vcpkg.json", "utf8")),
        [
            "http",
            "jpeg",
            "locale",
            "navigation",
            "navigation-crowd",
            "navigation-tile-cache",
            "physics",
            "png",
            "text-layout",
            "ui",
            "ui-svg",
            "webp",
        ],
    );
});

test("keeps RmlUi recording backend-neutral and realizes it in scene and sprite renderers", () => {
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const projection = readFileSync("native/src/pal_ui_rml.cpp", "utf8");
    const systemFonts = readFileSync("native/src/pal_system_fonts.cpp", "utf8");
    const systemFontsHeader = readFileSync(
        "native/include/bblite/pal_system_fonts.hpp",
        "utf8",
    );
    const sdl = readFileSync("native/src/pal_sdl_gpu.cpp", "utf8");
    const dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
    const spriteSdl = readFileSync("native/src/pal_sdl_gpu_sprite.cpp", "utf8");
    const spriteDawn = readFileSync("native/src/pal_dawn_sprite.cpp", "utf8");
    const spriteSdlUi = readFileSync(
        "native/src/pal_sprite_ui_sdl.hpp",
        "utf8",
    );
    const spriteDawnUi = readFileSync(
        "native/src/pal_sprite_ui_dawn.hpp",
        "utf8",
    );
    const textureCache = readFileSync(
        "native/src/pal_ui_texture_cache.hpp",
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
    assert.doesNotMatch(fontArchitecture, /FontChoice|std::filesystem::exists/);
    assert.doesNotMatch(
        // The packaged text-symbol face is an app asset, not a guessed host font location.
        fontArchitecture.replace('"fonts/NotoSansSymbols2-Regular.ttf"', '""'),
        /["'][^"'\r\n]*(?:[\\/]fonts[\\/]|\.tt[fc]\b|\.otf\b)[^"'\r\n]*["']/i,
    );
    assert.match(projection, /class UiRenderRecorder/);
    assert.match(projection, /record_ui_rml_frame/);
    assert.match(
        projection,
        /take_crosshair_color[\s\S]{0,120}--bbl-crosshair/,
    );
    assert.match(projection, /append_crosshair[\s\S]{0,900}SetInnerRML/);
    // One compositor per backend: the scene renderer passes its sample
    // count and gets the multisampled layer; sprite and Window hosts blend
    // directly.
    assert.match(
        sdl,
        /render_sprite_ui_sdl_frame\([\s\S]{0,200}state\.sample_count\)/,
    );
    assert.match(
        dawn,
        /render_sprite_ui_dawn_frame\([\s\S]{0,200}state\.sample_count\)/,
    );
    assert.match(spriteSdlUi, /layer\.multisample/);
    assert.match(spriteDawnUi, /multisample_view/);
    assert.match(spriteSdl, /render_sprite_ui_sdl_frame/);
    assert.match(spriteDawn, /render_sprite_ui_dawn_frame/);
    assert.match(spriteSdl, /handle_ui_rml_event/);
    assert.match(spriteDawn, /handle_ui_rml_event/);
    assert.match(
        textureCache,
        /std::weak_ptr<const std::vector<std::uint8_t>> source/,
    );
    assert.match(textureCache, /source\.expired\(\)/);
    for (const renderer of [spriteSdlUi, spriteDawnUi]) {
        assert.match(renderer, /#include "pal_ui_texture_cache\.hpp"/);
        assert.match(renderer, /prune_ui_texture_cache\(\s*ui\.textures,/);
        assert.match(
            renderer,
            /UiCachedTexture<[^>]+>\{texture, source(?:_texture)?\.rgba\}/,
        );
        assert.doesNotMatch(renderer, /ui_frame_uses_texture/);
    }
    for (const renderer of [sdl, dawn])
        assert.doesNotMatch(
            renderer,
            /ui_frame_uses_texture|draw\.nearest_sampling/,
        );
    for (const renderer of [spriteSdlUi, spriteDawnUi])
        assert.match(renderer, /draw\.nearest_sampling/);
});

test("normalizes retained CSS cascade keywords and measures width resets", () => {
    const projection = readFileSync("native/src/pal_ui_rml.cpp", "utf8");
    const declarations = projection.slice(
        projection.indexOf("std::string take_css_declaration"),
        projection.indexOf("bool is_private_ui_declaration"),
    );
    assert.match(declarations, /css_property_name_equals/);
    assert.match(declarations, /result = std::string\(\s*trim_css_token/);
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
    assert.equal(defaultDevelopmentBackend("linux"), "BOTH");
    assert.equal(defaultDevelopmentBackend("darwin"), "BOTH");
    assert.equal(canonicalCompiledBackend("sdl_gpu", "build"), "SDL_GPU");
    assert.equal(canonicalCompiledBackend("DAWN", "process"), "DAWN");
    assert.equal(canonicalCompiledBackend("both", "process"), "BOTH");
    assert.equal(canonicalCompiledBackend("gpu", "build"), "SDL_GPU");
    assert.throws(
        () => canonicalCompiledBackend("vulkan", "build"),
        /--backend must be sdl_gpu\|dawn\|both/,
    );
});

test("development dependencies use the host platform and architecture", () => {
    assert.equal(developmentTriplet("linux", "x64"), "x64-linux");
    assert.equal(developmentTriplet("linux", "arm64"), "arm64-linux");
    assert.equal(developmentTriplet("win32", "x64"), "x64-windows");
    assert.equal(developmentTriplet("darwin", "arm64"), "arm64-osx");
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
    // Generated units are warning-clean under MSVC too: the lowering emits
    // no unreachable fallthrough for LTCG to report as C4702.
    assert.doesNotMatch(cmake, /\/wd4702/);
    assert.match(block, /INTERFACE -Os -ffunction-sections/);
});

test("shipping packages require the trimmed static build", () => {
    const script = readFileSync("tools/package-demo.ps1", "utf8");
    const patterns = script.slice(
        script.indexOf("$shaderPatterns ="),
        script.indexOf("$shaderFiles ="),
    );
    // The executable runs directly; packaging tests exercise the host shader
    // payload selection. Windows retains its console for startup errors.
    assert.doesNotMatch(
        script.slice(0, script.indexOf("$smokeFrames")),
        /SDL_GPU_DRIVER|run-\$Scene\.cmd|\.log/,
    );
    assert.match(script, /\$smokeStart\.Environment\["SDL_ASSERT"\] = "abort"/);
    assert.match(script, /Double-click \$exeName/);
    assert.match(patterns, /\*\.dxil/);
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
    // A failed start shows the program's own output, and a payload path the
    // non-long-path-aware executable cannot open is refused before it runs.
    assert.match(smoke, /RedirectStandardOutput = \$true/);
    assert.match(smoke, /RedirectStandardError = \$true/);
    assert.match(
        smoke,
        /exited with \$\(\$smoke\.ExitCode\)[^\n]*Output tail:/,
    );
    assert.match(
        script.slice(0, script.indexOf("$smokeFrames = 5")),
        /FullName\.Length -ge 260/,
    );
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
    assert.match(script, /SDL_DIALOG = \$dialogSetting/);
    assert.match(script, /"-D\$\(\$option\.Key\)=\$\(\$option\.Value\)"/);
    assert.doesNotMatch(script, /^\s*-D[A-Za-z_]+=\$/m);
    assert.doesNotMatch(script, /^\s*"?-DSDL_/m);
    assert.match(
        script,
        /Read-CMakeCache \(Join-Path \$build "CMakeCache\.txt"\)/,
    );
    assert.match(script, /\$actual -ne \$option\.Value/);
    assert.match(script, /Contains\('\$'\)/);
    assert.match(script, /BBLITE_SDL_DIALOG \$dialogSetting/);
    assert.match(script, /bblite-sdl-features\.cmake/);
    // Every trimmed-SDL patch comes from the inventory; the script-only one
    // lives outside the overlay port directory that keys the development
    // vcpkg install. Only SDL's own options (BOOL, or INTERNAL when SDL
    // forces a dependent one) are admitted to the trim table.
    assert.match(script, /Get-MaintainedPatches sdl3 @\("trimmed"\)/);
    assert.match(script, /Get-PatchRecord sdl3 \$sdlVersion \$patches/);
    // A warm workspace that already holds the tag with this series staged is
    // not reset and re-patched, which would recompile the whole library.
    assert.match(script, /applied-series\.txt/);
    assert.match(script, /git -C \$source write-tree/);
    assert.doesNotMatch(script, /SDL_(MISC|LOCALE) =/);
    assert.match(script, /-notin @\("BOOL", "INTERNAL"\)/);
    assert.ok(existsSync("native/patches/sdl3/0009-static-no-dynapi.patch"));
    assert.ok(
        !existsSync(
            "native/vcpkg-overlay-ports/sdl3/0009-static-no-dynapi.patch",
        ),
    );

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
        assert.doesNotMatch(
            script,
            /Get-Command cmake/,
            `${name} rediscovers CMake itself`,
        );
        assert.doesNotMatch(
            script,
            /vswhere/,
            `${name} rediscovers Visual Studio itself`,
        );
        assert.doesNotMatch(
            script,
            /git -C \$\w+ fetch --depth 1 origin \$/,
            `${name} syncs a pinned checkout itself`,
        );
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
        assert.match(
            cmake,
            new RegExp(`bblite_feature_define\\(${macro} "${feature}"\\)`),
        );
    }
    assert.match(
        cmake,
        /bblite_feature_define\(BBLITE_HAS_TEXT "text:renderable" "renderer:text"\)/,
    );
    // Generator records exist exactly where a shadow generator is reached.
    assert.match(
        cmake,
        new RegExp(
            `bblite_feature_define\\(BBLITE_HAS_SHADOWS ${shadowGeneratorFeatures
                .map((feature) => `"${feature}"`)
                .join(" ")}\\)`,
        ),
    );
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
    assert.match(
        readFileSync("native/dependency-features.cmake", "utf8"),
        /if\(NOT DEFINED BBLITE_IMAGE_CODECS\)\s*message\(\s*FATAL_ERROR/,
    );
});

test("every bblite macro test is a plain #if over an always-defined macro", () => {
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    // An undefined name in a project unit's #if is a compile error.
    assert.match(cmake, /\/we4668 \/external:env:INCLUDE \/external:W0/);
    assert.match(cmake, /INTERFACE -Wundef -Werror=undef\)/);
    assert.match(cmake, /-Wpedantic -Werror -Wundef\)/);
    // No spelling decides what a missing macro means: `defined(X) && X`
    // read it as off, `!defined(X) || X` as on, and an #ifndef default
    // supplied a value CMake or the generator already owns.
    const sources = [
        ...listFiles("native/include"),
        ...listFiles("native/src"),
        ...listFiles("src").filter((file) => file.endsWith(".ts")),
    ];
    const wrong: string[] = [];
    for (const file of sources) {
        for (const [index, line] of readFileSync(file, "utf8")
            .split("\n")
            .entries()) {
            if (
                /#\s*(?:if|elif)\b.*\bdefined\s*\(?\s*BBLITE_/.test(line) ||
                /#\s*(?:ifdef|ifndef)\s+BBLITE_(?!\w*_HPP\b)/.test(line)
            ) {
                wrong.push(`${file}:${index + 1}: ${line.trim()}`);
            }
        }
    }
    assert.deepEqual(wrong, []);
});

test("the scene-invariant PAL units compile in their own object library", () => {
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const pattern = /BBLITE_PAL_COMMON_PATTERN\s*"([^"]+)"/.exec(cmake)?.[1];
    assert.ok(pattern, "no PAL-common pattern");
    const selector = new RegExp(pattern.replaceAll("\\\\", "\\"));
    // Verified with the preprocessor: these units include no header under
    // the generated tree, the backend families, the window realm and the
    // build stamp do.
    for (const unit of [
        "pal",
        "pal_sdl",
        "pal_ui_rml",
        "pal_audio_labsound",
        "pal_physics_bullet",
        "pal_physics_debug",
        "pal_navigation_recast",
        "pal_file",
        "pal_storage",
        "pal_text_layout",
    ]) {
        assert.match(`/src/${unit}.cpp`, selector, `${unit} is not PAL-common`);
        assert.ok(
            existsSync(`native/src/${unit}.cpp`),
            `${unit}.cpp is missing`,
        );
    }
    for (const unit of [
        "pal_sdl_gpu",
        "pal_sdl_gpu_sprite",
        "pal_dawn",
        "pal_window_realm",
        "pal_window_presenter_sdl",
        "pal_build_stamp",
    ]) {
        assert.doesNotMatch(
            `/src/${unit}.cpp`,
            selector,
            `${unit} reaches generated headers`,
        );
    }
    assert.match(cmake, /add_library\(bblite_features INTERFACE\)/);
    assert.match(
        cmake,
        /add_library\(bblite_pal_common OBJECT \$\{BBLITE_PAL_COMMON_SOURCES\}\)/,
    );
    assert.match(
        cmake,
        /target_link_libraries\(bblite_native PRIVATE bblite_features bblite_pal_common\)/,
    );
    // Only the executable's own units see the generated include directory;
    // every other usage requirement rides the interface target.
    assert.match(
        cmake,
        /target_include_directories\(bblite_native PRIVATE "\$\{BBLITE_GENERATED_DIR\}\/upstream\/include"\)/,
    );
    assert.doesNotMatch(cmake, /target_compile_definitions\(\s*bblite_native/);
    assert.doesNotMatch(
        cmake,
        /target_link_libraries\(\s*bblite_native\s+PRIVATE\s+(?!bblite_features)/,
    );
    assert.match(
        cmake,
        /target_precompile_headers\(bblite_pal_common PRIVATE \$\{BBLITE_PCH_HEADERS\}\)/,
    );
    assert.match(
        cmake,
        /target_precompile_headers\(bblite_native REUSE_FROM bblite_pal_common\)/,
    );
    assert.match(
        cmake,
        /target_sources\(\s*bblite_pal_common\s+PRIVATE\s+"\$\{BBLITE_NATIVE_ROOT\}\/src\/pal_system_fonts\.cpp"/,
    );
});

test("the shipping presets spell the documented minimal recipe", () => {
    const presets = JSON.parse(
        readFileSync("native/CMakePresets.json", "utf8"),
    ) as {
        configurePresets: Array<{
            name: string;
            inherits?: string;
            cacheVariables?: Record<string, string>;
        }>;
    };
    const byName = new Map(
        presets.configurePresets.map((preset) => [preset.name, preset]),
    );
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
    assert.match(
        cmake,
        /BBLITE_HAS_AUDIO_CAPTURE=\$<BOOL:\$\{BBLITE_AUDIO_CAPTURE\}>/,
    );
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
    // The inventory, not the pin, lists the maintained patches.
    assert.equal(record.patches, undefined);
    assert.ok(
        readdirSync("native/patches/rmlui").filter((name) =>
            /^\d{4}-[a-z0-9-]+\.patch$/.test(name),
        ).length >= 5,
    );

    const builder = readFileSync("tools/build-rmlui.ps1", "utf8");
    assert.match(builder, /\[switch\]\$StaticRuntime/);
    assert.match(builder, /upstream\\rmlui\.json/);
    assert.match(builder, /Get-MaintainedPatches rmlui/);
    assert.match(
        builder,
        /Install-MaintainedPatches \$source \$patches "RmlUi"/,
    );
    assert.match(builder, /Get-PatchRecord rmlui \$pin\.commit \$patches/);
    assert.doesNotMatch(builder, /\.patch\b/);
    assert.match(builder, /CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded/);
    assert.match(builder, /bblite-rmlui-features\.cmake/);
    assert.match(builder, /RMLUI_SVG_PLUGIN=\$rmlSvgSetting/);
    // The development/shipping SVG matrix is executed in shipping-demos.test.
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
    // Every prebuilt artifact's recorded source and patch set is verified
    // by one function against the pin and the inventory
    // (executed in test/patch-inventory.test.ts).
    assert.match(
        cmake,
        /include\("\$\{BBLITE_NATIVE_ROOT\}\/patch-identity\.cmake"\)\s*bblite_verify_dependency_artifacts\(\)/,
    );
    assert.match(
        readFileSync("native/patch-identity.cmake", "utf8"),
        /bblite_verify_patch_record\(rmlui "\$\{BBLITE_RMLUI_DIR\}" "\$\{BBLITE_RMLUI_BUILD_COMMAND\}"\)/,
    );
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
