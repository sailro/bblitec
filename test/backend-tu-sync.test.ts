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

// The draw lists filter `visible` when they are BUILT (the pin's
// bundle-record rule), so a setMeshVisible after the build reaches the
// screen only through the visibility epoch: each backend re-runs the list
// build when the epoch moves. A backend that forgets the sync re-creates
// the defect that froze quake's weapon switch — hidden at build never
// drew, hidden after build kept drawing — and nothing at compile time
// forces the check, so the three-part shape is pinned here as text for
// BOTH backends: the shared membership epoch, the lists-only rebuild it triggers,
// and the re-sync.
test("both backends re-record draw lists on membership changes", () => {
    for (const file of [
        "native/src/pal_sdl_gpu.cpp",
        "native/src/pal_dawn.cpp",
    ]) {
        const text = readFileSync(file, "utf8");
        assert.match(
            text,
            /std::uint64_t synced_draw_list_epoch =\s*\r?\n\s*engine\.draw_list_epoch;/,
            `${file} does not track the draw-list epoch`,
        );
        assert.match(
            text,
            /engine\.draw_list_epoch != synced_draw_list_epoch[\s\S]{0,900}?build_render_draw_lists\([\s\S]{0,200}?rebuild_task_draw_lists\(\);/,
            `${file} does not rebuild the draw lists when the epoch moves`,
        );
        assert.match(
            text,
            /synced_draw_list_epoch = engine\.draw_list_epoch;/,
            `${file} never re-syncs the draw-list epoch`,
        );
    }
});

// A thin-instance pool can come into existence AFTER registration: a mesh
// registered with no pool, whose first `addThinInstance` runs from a frame
// callback. The PBR family's draw predicate is the live record, so it will
// bind `pinned_instances` from that frame on -- and the capacity-recreation
// branch is the only place that can allocate one. Both backends must
// therefore create it there unconditionally, null included, instead of only
// refreshing a buffer registration already made.
test("both backends allocate the pinned instance stream for a late pool", () => {
    for (const [file, release, create] of [
        [
            "native/src/pal_sdl_gpu.cpp",
            "SDL_ReleaseGPUBuffer(\n                                state.device,\n                                gpu_mesh.pinned_instances);",
            "gpu_mesh.pinned_instances =",
        ],
        [
            "native/src/pal_dawn.cpp",
            "wgpuBufferRelease(dawn_mesh.pinned_instances);",
            "dawn_mesh.pinned_instances = create_buffer(",
        ],
    ] as const) {
        const text = readFileSync(file, "utf8");
        const released = text.indexOf(release);
        assert.ok(
            released >= 0,
            `${file} no longer releases the previous pinned instance stream`,
        );
        // The allocation must sit OUTSIDE the non-null guard that wraps the
        // release, so a null one becomes a buffer rather than staying null.
        const guarded = text.lastIndexOf("pinned_instances &&", released);
        assert.ok(
            guarded >= 0,
            `${file} no longer guards the pinned release on ownership`,
        );
        const closed = text.indexOf("}", released);
        const allocated = text.indexOf(create, closed);
        assert.ok(
            allocated > closed,
            `${file} only recreates an existing pinned instance stream, so a ` +
                "pool established after registration binds nothing",
        );
    }
});

// Teardown order is the class of defect single-frame parity cannot see: a
// GPU or audio object released through a device that is already gone
// crashes intermittently at exit, as the application gates did after the
// audit hoisted the SDL upload batch to run lifetime. The fixes are
// structural -- ownership and scope, not a call to remember -- so what is
// pinned here is the structure that carries each invariant.
test("the SDL scene loop keeps device cleanup outside its run-local resources", () => {
    // Reverse destruction order must release the upload batch and pick
    // hook before the device, on normal exit, exceptions and coroutine
    // cancellation. The outer scope guard owns the single teardown path.
    const source = readFileSync("native/src/pal_sdl_gpu.cpp", "utf8");
    const entry = source.indexOf("SceneRun run_gpu_engine(Engine& engine)");
    assert.ok(entry >= 0, "the scene loop is not declared");
    const text = source.slice(entry);
    const cleanup = /const auto run_cleanup = js::finally\(\[&\]\(\) noexcept \{[\s\S]*?\n    \}\);/.exec(text);
    assert.ok(cleanup, "the scene loop has no device cleanup scope guard");
    const state = text.indexOf("GpuState state;");
    assert.ok(state >= 0 && state < cleanup.index, "the device state must outlive its cleanup guard");
    assert.match(cleanup[0], /release\(state\);/, "the cleanup guard does not release its device");
    assert.equal(text.match(/release\(state\);/g)?.length, 1, "device teardown must have one owner");
    const resources = cleanup.index + cleanup[0].length;
    assert.match(text.slice(resources), /^\s*\{/, "run-local resources need their own inner scope");
    const batch = text.indexOf(
        "GpuBufferUploadBatch frame_buffer_uploads(state.device);",
    );
    assert.ok(
        batch > resources,
        "the upload batch must unwind before the device cleanup guard",
    );
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

test("scene replacement during frame callbacks stops stale GPU work", () => {
    for (const file of [
        "native/src/pal_sdl_gpu.cpp",
        "native/src/pal_dawn.cpp",
    ]) {
        const backend = readFileSync(file, "utf8");
        const advance = backend.indexOf("advance_frame(");
        const syncUi = backend.indexOf("update_ui_rml_runtime(", advance);
        assert.ok(advance >= 0 && syncUi > advance);
        const boundary = backend.slice(advance, syncUi);
        assert.match(
            boundary,
            /request_renderer_restart_if_scene_set_changed\(\s*engine, active_registered_scenes\)/,
            `${file} does GPU work after a callback replaces its scene`,
        );
        assert.match(boundary, /break;/);
        if (file.endsWith("pal_sdl_gpu.cpp")) {
            assert.match(boundary, /SDL_SubmitGPUCommandBuffer\(command\)/);
            assert.doesNotMatch(boundary, /SDL_CancelGPUCommandBuffer\(/);
        }
    }
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
        "wgpuQueueSubmit(state.queue, 1, &command);",
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
