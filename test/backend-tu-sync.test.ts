import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { featureSources } from "../src/compiler/output-projection.js";

// `featureSources` decides which SDL_GPU translation units a feature
// compiles into BBLITE_RUNTIME_SOURCES, and the CMake backend arm removes
// exactly those files from a build without the SDL_GPU backend. Neither
// list references the other, so a TU added to one and not the other would
// fail only at build time — this pins the sync, reading the record itself
// so no spelling of a source entry can dodge it.
test("a DAWN-only build removes exactly the SDL_GPU TUs featureSources names", () => {
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

    const cmake = readFileSync("native/CMakeLists.txt", "utf8");
    const removal = cmake.match(
        /list\(\s*REMOVE_ITEM\s+BBLITE_RUNTIME_SOURCES\s+([^)]*)\)/,
    );
    assert.ok(
        removal,
        "CMakeLists.txt has no BBLITE_RUNTIME_SOURCES REMOVE_ITEM list",
    );
    const removedTus = [
        ...removal[1]!.matchAll(/"\$\{BBLITE_NATIVE_ROOT\}\/(src\/[^"]+)"/g),
    ].map((match) => match[1]!);

    assert.ok(featureTus.length > 0, "featureSources names no SDL_GPU TU");
    assert.deepEqual([...removedTus].sort(), [...featureTus].sort());
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
test("the SDL scene loop tears down after its try, like its siblings", () => {
    // A run-lifetime object declared inside the try (the upload batch,
    // the pick hook guard) unwinds when the try ends. With the device
    // teardown inside that same try on the normal path, the batch
    // outlived the device and released through it; after the catch, it
    // cannot.
    const text = readFileSync("native/src/pal_sdl_gpu.cpp", "utf8");
    const batch = text.indexOf(
        "GpuBufferUploadBatch frame_buffer_uploads(state.device);",
    );
    assert.ok(batch >= 0, "the run-lifetime batch is not declared");
    const rethrow = text.indexOf("} catch (...) {", batch);
    const teardown = text.lastIndexOf("release(state);");
    assert.ok(rethrow >= 0, "the scene loop has no catch after the batch");
    assert.ok(
        teardown > rethrow,
        "the normal-path release(state) sits inside the try, before the batch unwinds",
    );
});

test("the run end closes every audio context", () => {
    // A context surviving into static destruction keeps its audio thread
    // alive while the objects it touches are torn down in an order
    // nothing controls. run_engine's exit guard is the one place a run
    // ends, so it closes them there, after the captures rendered.
    const text = readFileSync("native/src/pal_sdl.cpp", "utf8");
    const guard = text.indexOf("~AudioRunEnd()");
    assert.ok(guard >= 0, "run_engine has no audio run-end guard");
    const captures = text.indexOf("audio_render_pending_captures();", guard);
    const closes = text.indexOf("audio_close_all_contexts();", guard);
    assert.ok(closes > captures && captures > guard);
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
    const releaseMesh = dawn.slice(dawn.indexOf("void release_mesh("));
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
