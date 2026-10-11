import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { featureSources } from "../src/compiler/output-projection.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { sceneBackendSource, sharedGpuSource } from "./native-fixture.js";

const tools = discoverDevelopmentTools();
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
const aggregateScene = (source: string): string =>
    source === "src/pal_sdl_gpu.cpp" ? "src/pal_sdl_gpu_scene_all.cpp" : source;
const dawnTwin = (source: string): string =>
    source.replace("src/pal_sdl_gpu", "src/pal_dawn");

test("every reached GPU translation unit has both backend implementations", () => {
    assert.ok(featureTus.length > 0);
    for (const source of [
        ...featureTus.map(aggregateScene),
        "src/pal_sdl_gpu_window_presenter.cpp",
    ]) {
        for (const path of [source, dawnTwin(source)])
            assert.ok(existsSync(join("native", path)), path);
    }
    assert.match(
        readFileSync("native/CMakeLists.txt", "utf8"),
        /include\("\$\{CMAKE_CURRENT_LIST_DIR\}\/backend-sources\.cmake"\)/,
    );
});

test(
    "backend selection needs only the selected renderer's files",
    { skip: !tools.cmake },
    (t) => {
        assert.ok(tools.cmake);
        const root = mkdtempSync(join(tmpdir(), "bblite-backend-selection-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const script = join(root, "select.cmake");
        writeFileSync(
            script,
            [
                "cmake_minimum_required(VERSION 3.24)",
                'set(BBLITE_NATIVE_ROOT "$ENV{BBLITE_TEST_NATIVE}")',
                'set(BBLITE_RUNTIME_SOURCES "$ENV{BBLITE_TEST_SOURCES}")',
                'set(BBLITE_RUNTIME_FEATURES "$ENV{BBLITE_TEST_FEATURES}")',
                'set(BBLITE_BACKEND_SDL_GPU "$ENV{BBLITE_TEST_SDL}")',
                'set(BBLITE_BACKEND_DAWN "$ENV{BBLITE_TEST_DAWN}")',
                'include("$ENV{BBLITE_TEST_SELECTOR}")',
                'file(WRITE "$ENV{BBLITE_TEST_OUTPUT}" "${BBLITE_RUNTIME_SOURCES}\n${BBLITE_DAWN_SOURCES}")',
            ].join("\n"),
        );
        for (const backend of ["sdl", "dawn", "both"] as const) {
            const native = join(root, backend).replaceAll("\\", "/");
            mkdirSync(join(native, "src"), { recursive: true });
            const useSdl = backend !== "dawn";
            const useDawn = backend !== "sdl";
            for (const source of [
                ...featureTus.map(aggregateScene),
                "src/pal_sdl_gpu_window_presenter.cpp",
            ]) {
                if (useSdl) writeFileSync(join(native, source), "");
                if (useDawn) writeFileSync(join(native, dawnTwin(source)), "");
            }
            const absolute = (source: string): string => native + "/" + source;
            const shared = [
                "src/pal_gpu_frame.cpp",
                "src/pal_gpu_images.cpp",
                "src/pal_gpu_shared.cpp",
            ].map(absolute);
            for (const paths of [
                [],
                ...featureTus.map((source) => [source]),
                featureTus,
            ]) {
                for (const window of [false, true]) {
                    const canonical = [
                        ...paths.map(aggregateScene),
                        ...(window
                            ? ["src/pal_sdl_gpu_window_presenter.cpp"]
                            : []),
                    ];
                    const output = join(native, "selection.txt");
                    const result: SpawnSyncReturns<string> = spawnSync(
                        tools.cmake,
                        ["-P", script],
                        {
                            encoding: "utf8",
                            env: {
                                ...process.env,
                                BBLITE_TEST_NATIVE: native,
                                BBLITE_TEST_SOURCES: ["src/pal.cpp", ...paths]
                                    .map(absolute)
                                    .join(";"),
                                BBLITE_TEST_FEATURES: window
                                    ? "platform:window"
                                    : "",
                                BBLITE_TEST_SDL: useSdl ? "ON" : "OFF",
                                BBLITE_TEST_DAWN: useDawn ? "ON" : "OFF",
                                BBLITE_TEST_SELECTOR: resolve(
                                    "native/backend-sources.cmake",
                                ),
                                BBLITE_TEST_OUTPUT: output,
                            },
                        },
                    );
                    const context = backend + ": " + canonical.join(", ");
                    assert.equal(
                        result.status,
                        0,
                        context + "\n" + result.stdout + result.stderr,
                    );
                    const selected = readFileSync(output, "utf8")
                        .split(/\r?\n/)
                        .map((line) => (line ? line.split(";") : []));
                    assert.deepEqual(
                        selected,
                        [
                            [
                                absolute("src/pal.cpp"),
                                ...(useSdl ? canonical.map(absolute) : []),
                                ...(canonical.length ? shared : []),
                            ],
                            useDawn
                                ? canonical.map(dawnTwin).map(absolute)
                                : [],
                        ],
                        context,
                    );
                }
            }
        }
    },
);

test("the SDL scene driver releases run resources before its device", () => {
    const source = sceneBackendSource("sdl");
    const driver = source.slice(source.indexOf("class SdlSceneRun {"));
    const state = driver.slice(
        driver.indexOf("struct State : FrameSession"),
        driver.indexOf("} data_;"),
    );
    assert.ok(
        state.indexOf("Resources resources;") <
            state.indexOf("std::optional<PickHookGuard>"),
    );
    assert.ok(
        state.indexOf("Resources resources;") <
            state.indexOf("std::optional<GpuBufferUploadBatch>"),
    );
    const destructor = driver.slice(
        driver.indexOf("~Resources()"),
        driver.indexOf("struct State : FrameSession"),
    );
    assert.equal(destructor.match(/release\(state\);/g)?.length, 1);
    assert.ok(
        destructor.indexOf("destroy_ui_rml_runtime") <
            destructor.indexOf("release(state);"),
    );
    assert.ok(
        destructor.indexOf("release_scene_sprite_pass") <
            destructor.indexOf("release(state);"),
    );
    assert.ok(
        driver.indexOf("} data_;") <
            driver.indexOf("std::optional<Frame> frame_;"),
    );
});

test("the run end finishes only its engine's audio session", () => {
    const text = readFileSync("native/src/pal_sdl.cpp", "utf8");
    const guard = text.indexOf("~AudioRunEnd()");
    assert.ok(guard >= 0, "run_engine has no audio run-end guard");
    assert.match(
        text.slice(guard),
        /if \(engine\.audio_session\)\s+engine\.audio_session->finish\(\);/,
    );
    assert.doesNotMatch(text, /audio_close_all_contexts/);
});

test("scene replacement restarts both backends without retaining a dead root", () => {
    const runtime = readFileSync("native/include/bblite/runtime.hpp", "utf8");
    const dispatch = readFileSync("native/src/pal_sdl.cpp", "utf8");
    const backends = [sceneBackendSource("sdl"), sceneBackendSource("dawn")];
    assert.match(runtime, /bool renderer_restart_requested = false;/);
    // The run ends only without a restart, unloading the page first.
    assert.match(
        dispatch,
        /if \(!engine\.renderer_restart_requested\) \{[^}]*dispatch_page_lifecycle\([\s\S]*?co_return 0;/,
    );
    for (const backend of backends) {
        assert.match(
            backend,
            /const std::vector<std::shared_ptr<Scene>> active_registered_scenes =\s*engine\.scenes\(\);/,
        );
        assert.match(
            backend,
            /request_renderer_restart_if_scene_set_changed\(\s*engine, active_registered_scenes\)/,
        );
    }
    const shared = sharedGpuSource();
    assert.match(
        shared,
        /engine\.renderer_restart_requested = !engine\.scenes\(\)\.empty\(\);/,
    );
});

test("diagnostic input resumes across renderer restarts", () => {
    const runtime = readFileSync("native/include/bblite/runtime.hpp", "utf8");
    const replay = readFileSync("native/src/pal_platform_events.hpp", "utf8");
    assert.match(runtime, /std::size_t input_replay_next_frame = 0;/);
    assert.match(runtime, /unsigned int input_replay_mouse_buttons = 0u;/);
    assert.match(
        replay,
        /const std::size_t index = engine\.input_replay_next_frame;/,
    );
    assert.match(replay, /\+\+engine\.input_replay_next_frame;/);
    assert.match(replay, /frame == last_frame_/);
    assert.match(
        replay,
        /unsigned int& mouse_buttons_ = engine\.input_replay_mouse_buttons;/,
    );
});

test("frame dispatch survives a callback disposing its own scene", () => {
    const shared = sharedGpuSource();
    assert.match(
        shared,
        /const auto root_callbacks = scene\.before_render;\s*for \(const auto& callback : root_callbacks\)/,
    );
    assert.match(shared, /const auto registered_scenes = engine\.scenes\(\);/);
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
    const shared = sharedGpuSource();
    assert.match(runtime, /std::optional<UiElementHandle> surface_canvas;/);
    assert.match(shared, /scene_surface_pane\(/);
    assert.match(shared, /scene_surface_extent\(/);
    assert.match(shared, /scene_camera_viewport\(/);
    // Both backends settle the primary projection in the one shared
    // synchronization.
    assert.match(
        readFileSync("native/src/pal_scene_synchronize.hpp", "utf8"),
        /scene_surface_extent\(\s*engine, scene, sync\.width, sync\.height\)/,
        "the scene synchronization builds the primary projection at the full target aspect",
    );
    for (const file of ["sdl", "dawn"] as const) {
        const backend = sceneBackendSource(file);
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
    const dawn = sceneBackendSource("dawn");
    assert.match(
        dawn,
        /mesh\.thin_pick_uniform_buffer == state\.pick_mesh_buffer/,
    );
    assert.match(dawn, /mesh\.thin_pick_instances == mesh\.instances/);
    assert.match(dawn, /mesh\.thin_pick_bound_size == bound_size/);
    assert.match(
        dawn,
        /state\.release_thin_pick_groups\(\);[\s\S]{0,300}wgpuBufferRelease\(state\.pick_mesh_buffer\)/,
    );
    assert.match(
        dawn,
        /gpu\.release_thin_pick_group\(\);[\s\S]{0,300}wgpuBufferRelease\(gpu\.instances\)/,
    );
    const releaseMesh = dawn.slice(
        dawn.indexOf("void release_gpu_resources(DawnMeshResources&"),
    );
    assert.match(
        releaseMesh.slice(0, 1000),
        /mesh\.release_thin_pick_group\(\)/,
    );
    assert.doesNotMatch(dawn, /std::vector<WGPUBindGroup> thin_pick_groups/);
});

test("Dawn completes canvas readback before post-copy UI", () => {
    const dawn = sceneBackendSource("dawn");
    const capture = dawn.indexOf("const bool capture_frame");
    const copy = dawn.indexOf("begin_dawn_surface_capture(", capture);
    const firstSubmit = dawn.indexOf(
        "submit_dawn_command(state.queue, command);",
        copy,
    );
    const map = dawn.indexOf("finish_dawn_surface_capture(", firstSubmit);
    const deferredUi = dawn.indexOf("if (ui_after_capture_copy)", map);
    assert.ok(capture >= 0 && copy > capture);
    assert.ok(firstSubmit > copy && map > firstSubmit);
    assert.equal(
        dawn.slice(copy, firstSubmit).includes("render_sprite_ui_dawn_frame("),
        false,
    );
    assert.ok(deferredUi > map);

    const shared = readFileSync("native/src/pal_dawn_shared.hpp", "utf8");
    assert.match(shared, /maximum_wait_nanoseconds/);
    assert.doesNotMatch(
        shared.slice(
            shared.indexOf("inline void wait_for"),
            shared.indexOf("struct DawnDevice"),
        ),
        /UINT64_MAX/,
    );
});
