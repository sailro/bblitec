import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { featureSources } from "../src/compiler/output-projection.js";

// `featureSources` decides which SDL_GPU translation units a feature
// compiles into BBLITE_RUNTIME_SOURCES; the CMake backend arm derives the
// Dawn twins from that selection by name and drops the SDL units from a
// build without the SDL_GPU backend by the same name pattern. One
// authority, so what is pinned here is the pattern's coverage: every SDL
// unit the table names matches it, and every one has its Dawn twin on
// disk -- a twin the derivation would otherwise refuse at configure.
test("the CMake backend arm derives the Dawn twins from the SDL_GPU units featureSources names", () => {
    const featureTus = [
        ...new Set(
            Object.values(featureSources)
                .flat()
                .filter(
                    (source) =>
                        source.startsWith("src/pal_sdl_gpu") &&
                        source.endsWith(".cpp"),
                ),
        ),
    ];
    assert.ok(featureTus.length > 0, "featureSources names no SDL_GPU TU");

    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const pattern = /list\(FILTER BBLITE_SDL_GPU_SOURCES INCLUDE REGEX "([^"]+)"\)/.exec(cmake)?.[1];
    assert.ok(pattern, "CMakeLists.txt does not select the SDL_GPU units by pattern");
    const exclusion = /list\(FILTER BBLITE_RUNTIME_SOURCES EXCLUDE REGEX "([^"]+)"\)/.exec(cmake)?.[1];
    assert.ok(exclusion, "CMakeLists.txt does not drop the SDL_GPU units by pattern");
    assert.equal(exclusion, pattern, "selection and exclusion must be one pattern");
    // CMake spells the regex with doubled backslashes inside its quotes.
    const selector = new RegExp(pattern.replaceAll("\\\\", "\\"));
    assert.match(cmake, /string\(REPLACE "\/src\/pal_sdl_gpu" "\/src\/pal_dawn" bblite_dawn_source/);
    assert.match(cmake, /target_sources\(bblite_native PRIVATE \$\{BBLITE_DAWN_SOURCES\}\)/);
    assert.doesNotMatch(cmake, /REMOVE_ITEM/);
    assert.doesNotMatch(cmake, /PRIVATE "\$\{BBLITE_NATIVE_ROOT\}\/src\/pal_dawn[^"]*\.cpp"/);
    for (const source of featureTus) {
        assert.match(`/${source}`, selector, `${source} escapes the SDL_GPU pattern`);
        const twin = `native/${source.replace("src/pal_sdl_gpu", "src/pal_dawn")}`;
        assert.ok(existsSync(twin), `${source} has no Dawn twin at ${twin}`);
    }
});

test("the SDL scene driver releases run resources before its device", () => {
    const source = readFileSync("native/src/pal_sdl_gpu.cpp", "utf8");
    const driver = source.slice(source.indexOf("class SdlSceneRun {"));
    const state = driver.slice(driver.indexOf("struct State : FrameSession"), driver.indexOf("} data_;"));
    assert.ok(state.indexOf("Resources resources;") < state.indexOf("std::optional<PickHookGuard>"));
    assert.ok(state.indexOf("Resources resources;") < state.indexOf("std::optional<GpuBufferUploadBatch>"));
    const destructor = driver.slice(driver.indexOf("~Resources()"), driver.indexOf("struct State : FrameSession"));
    assert.equal(destructor.match(/release\(state\);/g)?.length, 1);
    assert.ok(destructor.indexOf("destroy_ui_rml_runtime") < destructor.indexOf("release(state);"));
    assert.ok(destructor.indexOf("release_scene_sprite_pass") < destructor.indexOf("release(state);"));
    assert.ok(driver.indexOf("} data_;") < driver.indexOf("std::optional<Frame> frame_;"));
});

test("the run end finishes only its engine's audio session", () => {
    const text = readFileSync("native/src/pal_sdl.cpp", "utf8");
    const guard = text.indexOf("~AudioRunEnd()");
    assert.ok(guard >= 0, "run_engine has no audio run-end guard");
    assert.match(text.slice(guard), /if \(engine\.audio_session\) engine\.audio_session->finish\(\);/);
    assert.doesNotMatch(text, /audio_close_all_contexts/);
});

test("scene replacement restarts both backends without retaining a dead root", () => {
    const runtime = readFileSync("native/include/bblite/runtime.hpp", "utf8");
    const dispatch = readFileSync("native/src/pal_sdl.cpp", "utf8");
    const backends = [
        readFileSync("native/src/pal_sdl_gpu.cpp", "utf8"),
        readFileSync("native/src/pal_dawn.cpp", "utf8"),
    ];
    assert.match(runtime, /bool renderer_restart_requested = false;/);
    assert.match(dispatch, /if \(!engine\.renderer_restart_requested\) return;/);
    for (const backend of backends) {
        assert.match(
            backend,
            /const std::vector<std::shared_ptr<Scene>> active_registered_scenes =\s*engine\.registered_scenes;/,
        );
        assert.match(
            backend,
            /request_renderer_restart_if_scene_set_changed\(\s*engine, active_registered_scenes\)/,
        );
    }
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    assert.match(shared, /engine\.renderer_restart_requested = !engine\.registered_scenes\.empty\(\);/);
});

test("late auxiliary scene registration rebuilds both backend plans", () => {
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    assert.match(
        shared,
        /engine\.registered_scenes\.size\(\) != planned\.size\(\)/,
    );
    assert.match(shared, /current->shares_identity\(\*planned\[i\]\)/);
});

test("diagnostic input resumes across renderer restarts", () => {
    const runtime = readFileSync("native/include/bblite/runtime.hpp", "utf8");
    const replay = readFileSync("native/src/pal_platform_events.hpp", "utf8");
    assert.match(runtime, /std::size_t input_replay_next_frame = 0;/);
    assert.match(runtime, /unsigned int input_replay_mouse_buttons = 0u;/);
    assert.match(replay, /const std::size_t index = engine\.input_replay_next_frame;/);
    assert.match(replay, /\+\+engine\.input_replay_next_frame;/);
    assert.match(replay, /frame == last_frame_/);
    assert.match(replay, /unsigned int& mouse_buttons_ = engine\.input_replay_mouse_buttons;/);
});

test("frame dispatch survives a callback disposing its own scene", () => {
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    assert.match(
        shared,
        /const auto root_callbacks = scene\.before_render;\s*for \(const auto& callback : root_callbacks\)/,
    );
    assert.match(
        shared,
        /const auto registered_scenes = engine\.registered_scenes;/,
    );
    assert.match(
        shared,
        /const auto callbacks = registered->before_render;\s*for \(const auto& callback : callbacks\)/,
    );
});

test("creating a camera during UI dispatch cannot invalidate the active camera", () => {
    const runtime = readFileSync("native/include/bblite/runtime.hpp", "utf8");
    assert.match(runtime, /std::deque<CameraRecord> cameras;/);
    assert.doesNotMatch(runtime, /std::vector<CameraRecord> cameras;/);
});

test("auxiliary surface scenes render in independent panes", () => {
    const runtime = readFileSync("native/include/bblite/runtime.hpp", "utf8");
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    assert.match(runtime, /std::optional<UiElementHandle> surface_canvas;/);
    assert.match(shared, /scene_surface_pane\(/);
    assert.match(shared, /scene_surface_extent\(/);
    assert.match(shared, /scene_camera_viewport\(/);
    for (const file of [
        "native/src/pal_sdl_gpu.cpp",
        "native/src/pal_dawn.cpp",
    ]) {
        const backend = readFileSync(file, "utf8");
        assert.match(
            backend,
            /scene_surface_extent\(\s*engine, scene, width, height\)/,
            `${file} builds the primary projection at the full target aspect`,
        );
        assert.match(
            backend,
            /scene_surface_extent\(\s*engine, \*overlay_scene, width, height\)/,
            `${file} builds auxiliary projections at the full target aspect`,
        );
        assert.match(
            backend,
            /scene_camera_viewport\(\s*engine, scene, camera/,
            `${file} does not compose the scene surface into its viewport`,
        );
    }
});

test("Dawn caches thin-pick bindings and invalidates them with their buffers", () => {
    const dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
    assert.match(dawn, /mesh\.thin_pick_uniform_buffer == state\.pick_mesh_buffer/);
    assert.match(dawn, /mesh\.thin_pick_instances == mesh\.instances/);
    assert.match(dawn, /mesh\.thin_pick_bound_size == bound_size/);
    assert.match(dawn, /state\.release_thin_pick_groups\(\);[\s\S]{0,300}wgpuBufferRelease\(state\.pick_mesh_buffer\)/);
    assert.match(dawn, /dawn_mesh\.release_thin_pick_group\(\);[\s\S]{0,300}wgpuBufferRelease\(previous_instances\)/);
    const releaseMesh = dawn.slice(dawn.indexOf("void release_gpu_resources(DawnMeshResources&"));
    assert.match(releaseMesh.slice(0, 1000), /mesh\.release_thin_pick_group\(\)/);
    assert.doesNotMatch(dawn, /std::vector<WGPUBindGroup> thin_pick_groups/);
});

test("Dawn completes canvas readback before post-copy UI", () => {
    const dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
    const capture = dawn.indexOf("const bool capture_frame");
    const copy = dawn.indexOf(
        "wgpuCommandEncoderCopyTextureToBuffer(",
        capture,
    );
    const firstSubmit = dawn.indexOf(
        "submit_dawn_command(state.queue, command);",
        copy,
    );
    const map = dawn.indexOf("wgpuBufferMapAsync(", firstSubmit);
    const deferredUi = dawn.indexOf(
        "if (ui_after_capture_copy)",
        map,
    );
    assert.ok(capture >= 0 && copy > capture);
    assert.ok(firstSubmit > copy && map > firstSubmit);
    assert.equal(
        dawn.slice(copy, firstSubmit).includes("render_ui_dawn_frame("),
        false,
    );
    assert.ok(deferredUi > map);

    const shared = readFileSync(
        "native/src/pal_dawn_shared.hpp",
        "utf8",
    );
    assert.match(shared, /maximum_wait_nanoseconds/);
    assert.doesNotMatch(
        shared.slice(
            shared.indexOf("inline void wait_for"),
            shared.indexOf("struct DawnDevice"),
        ),
        /UINT64_MAX/,
    );
});
