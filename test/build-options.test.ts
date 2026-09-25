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
import { listFiles } from "../src/tooling/records.js";
import { sceneBackendFiles, sceneBackendSource } from "./native-fixture.js";

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
            "sdl",
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
    const sdl = sceneBackendSource("sdl");
    const dawn = sceneBackendSource("dawn");
    const spriteSdl = readFileSync("native/src/pal_sdl_gpu_sprite.cpp", "utf8");
    const spriteDawn = readFileSync("native/src/pal_dawn_sprite.cpp", "utf8");
    const spriteSdlUi = readFileSync(
        "native/src/pal_sdl_gpu_sprite_ui.hpp",
        "utf8",
    );
    const spriteDawnUi = readFileSync(
        "native/src/pal_dawn_sprite_ui.hpp",
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
        /render_sprite_ui_sdl_gpu_frame\([\s\S]{0,200}state\.sample_count\)/,
    );
    assert.match(
        dawn,
        /render_sprite_ui_dawn_frame\([\s\S]{0,200}state\.sample_count\)/,
    );
    assert.match(spriteSdlUi, /layer\.multisample/);
    assert.match(spriteDawnUi, /multisample_view/);
    assert.match(spriteSdl, /render_sprite_ui_sdl_gpu_frame/);
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
    assert.match(
        script,
        /Sync-PatchedCheckout \$source \$repository \$tagCommit "SDL \$tag" sdl3 @\("trimmed"\)/,
    );
    assert.match(script, /Get-PatchRecord sdl3 @\("trimmed"\)/);
    // The engine only converts decoded images: the blending, modulating and
    // scaling blitters, RLE, YUV and SDL's stb_image loader are compiled out,
    // so the trimmed SDL owes no YUV or stb_image notice.
    assert.match(
        script,
        /\$surfaceDefines = @\("SDL_LEAN_AND_MEAN", "SDL_HAVE_BLIT_0", "SDL_HAVE_BLIT_1", "SDL_HAVE_BLIT_N", "SDL_DISABLE_STB"\)/,
    );
    // SDL's targets drop /D flags from CMAKE_C_FLAGS*: the definitions reach
    // them from a project include.
    assert.match(
        script,
        /add_compile_definitions\(\$\(\$surfaceDefines -join ' '\)\)/,
    );
    assert.match(script, /"-DCMAKE_PROJECT_SDL3_INCLUDE=/);
    assert.doesNotMatch(script, /\$defines/);
    assert.doesNotMatch(script, /yuv2rgb\/LICENSE|stb_image\.h"/);
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
        "Sync-PatchedCheckout",
        "Set-ArtifactContent",
        "Read-CMakeCache",
    ]) {
        assert.match(module, new RegExp(`function ${helper}`));
        assert.match(module, new RegExp(`"${helper}"`));
    }
    const scripts = readdirSync("tools").filter((name) =>
        /^build-.*\.ps1$/.test(name),
    );
    assert.equal(scripts.length, 6);
    // Every builder of a patched library brings its checkout to the pin and
    // series through the one applied-series record, and rewrites its record
    // file only when it changes (a record is a configure input).
    for (const name of [
        "build-sdl-min.ps1",
        "build-labsound.ps1",
        "build-rmlui.ps1",
        "build-dawn.ps1",
        "build-dawn-min.ps1",
    ]) {
        const script = readFileSync(`tools/${name}`, "utf8");
        assert.match(script, /Sync-PatchedCheckout /, name);
        assert.doesNotMatch(
            script,
            /Install-MaintainedPatches|applied-series/,
            name,
        );
        assert.match(
            script,
            /Set-ArtifactContent \(Join-Path \$output "bblite-[a-z]+-features\.cmake"\)/,
            name,
        );
    }
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

test("a generated tree without its codec list or macro headers is refused", () => {
    // The one stack reservation sits outside the compiler split.
    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    assert.equal((cmake.match(/\/STACK:8388608/g) ?? []).length, 1);
    assert.match(
        readFileSync("native/dependency-features.cmake", "utf8"),
        /if\(NOT DEFINED BBLITE_IMAGE_CODECS\)\s*message\(\s*FATAL_ERROR/,
    );
    assert.match(
        cmake,
        /if\(NOT EXISTS "\$\{BBLITE_GENERATED_DIR\}\/upstream\/include\/bblite\/features"\)\s*message\(\s*FATAL_ERROR/,
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
    // These units read the generated tree only through activation macros;
    // the backend families, the window realm, the build stamp and the
    // navigation PAL include lowered module headers (configure refuses a
    // PAL-common unit that does).
    for (const unit of [
        "pal",
        "pal_sdl",
        "pal_ui_rml",
        "pal_audio_labsound",
        "pal_physics_bullet",
        "pal_physics_debug",
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
        "pal_sdl_gpu_window_presenter",
        "pal_build_stamp",
        "pal_navigation_recast",
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
    // Each backend's scene renderer compiles as one checked-in translation
    // unit that includes its family files and its driver by name (CMake's
    // UNITY_BUILD writes absolute paths into the source it generates, which
    // would enter the object cache's key); no family file compiles alone.
    assert.ok(
        cmake.includes(
            'list(TRANSFORM BBLITE_RUNTIME_SOURCES REPLACE "/src/pal_sdl_gpu\\\\.cpp$" "/src/pal_sdl_gpu_scene_all.cpp")',
        ),
        "the feature table's scene driver compiles through its unity unit",
    );
    assert.doesNotMatch(
        cmake,
        /_scene_(?:meshes|variants|shadows|textures|targets|post_process|picking)/,
    );
    for (const backend of ["sdl", "dawn"] as const) {
        const sources = sceneBackendFiles(backend).filter((path) =>
            path.endsWith(".cpp"),
        );
        const unity = readFileSync(
            sources[0]!.replace(/_scene_\w+\.cpp$/, "_scene_all.cpp"),
            "utf8",
        );
        assert.deepEqual(
            [...unity.matchAll(/^#include "([^"]+)"$/gm)].map(
                (match) => `native/src/${match[1]}`,
            ),
            sources,
            `${backend} scene renderer unit`,
        );
        assert.doesNotMatch(
            unity.replace(/^(?:\/\/.*|#include "[^"]+")$/gm, ""),
            /\S/,
            `${backend} scene renderer unit holds only its includes`,
        );
    }
    // Under the object cache each repository unit reads its own
    // content-addressed header folder, and a PAL-common unit reaching a
    // generated header other than an activation macro is refused
    // (executed in native-cache.test.ts); every other usage requirement
    // rides the interface target.
    assert.match(
        cmake,
        /bblite_cache_unit_headers\(\s*TARGETS bblite_pal_common bblite_native\s+SCENE_INVARIANT bblite_pal_common/,
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
    // Under the object cache the lowered modules compile from
    // content-addressed copies and clang-cl builds one precompiled header the
    // trees of a checkout share (executed in native-cache.test.ts).
    assert.match(
        cmake,
        /bblite_content_addressed_sources\(BBLITE_GENERATED_UNITS \$\{BBLITE_GENERATED_SOURCES\}\)/,
    );
    assert.match(
        cmake,
        /bblite_shared_pch\(\s*NAME bblite_pch\s+TARGETS bblite_pal_common bblite_native\s+HEADERS \$\{BBLITE_PCH_HEADERS\}/,
    );
    // clang-cl's /Yc instantiates the templates a PCH leaves pending; the
    // -emit-pch PCHs must too, or every user instantiates them again.
    assert.match(
        readFileSync("native/native-header-cache.cmake", "utf8"),
        /"SHELL:-Xclang -emit-pch" "SHELL:-Xclang -fpch-instantiate-templates"/,
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
        /BBLITE_AUDIO_CAPTURE=\$<BOOL:\$\{BBLITE_AUDIO_CAPTURE\}>/,
    );
    assert.match(
        cmake,
        /NOT BBLITE_AUDIO_CAPTURE\s+AND NOT BBLITE_AUDIO_DECODE_FILE\s+AND NOT BBLITE_LABSOUND_CORE_ONLY/,
    );
    assert.doesNotMatch(
        cmake,
        /LabSound\.lib"\s*"\$\{BBLITE_LABSOUND_DIR\}\/lib\/libnyquist\.lib/,
    );
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
    assert.match(
        builder,
        /Sync-PatchedCheckout \$source \$pin\.repository \$pin\.commit "RmlUi" rmlui @\(\)/,
    );
    assert.match(builder, /Get-PatchRecord rmlui @\(\)/);
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
        /bblite_verify_patch_record\(\s*rmlui "\$\{BBLITE_RMLUI_DIR\}" "\$\{BBLITE_RMLUI_BUILD_COMMAND\}" REQUIRE\s*\)/,
    );
    assert.match(
        cmake,
        /\$\{BBLITE_RMLUI_DIR\}\/Backends\/RmlUi_Platform_SDL\.cpp/,
    );
});

test("shader sidecar loading rejects unbounded generated indices", () => {
    // One bounded index parser, which both backends' sidecar readers use.
    const common = readFileSync("native/src/pal_gpu_common.hpp", "utf8");
    assert.match(common, /constexpr std::uint32_t max_sidecar_index = 4096;/);
    assert.match(common, /digit < '0' \|\| digit > '9'/);
    for (const file of ["pal_sdl_gpu_shared.hpp", "pal_dawn_shared.hpp"]) {
        const source = readFileSync(`native/src/${file}`, "utf8");
        assert.match(source, /parse_sidecar_index\(/, file);
        assert.match(source, /for_each_sidecar_line\(/, file);
        assert.doesNotMatch(source, /std::stoul\(/, file);
    }
    assert.match(
        readFileSync("native/src/pal_sdl_gpu_shared.hpp", "utf8"),
        /Malformed shader slot/,
    );
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
