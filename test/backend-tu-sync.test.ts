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
// BOTH backends: the tracked epoch, the lists-only rebuild it triggers,
// and the re-sync.
test("both backends re-record the draw lists on the visibility epoch", () => {
    for (const file of [
        "native/src/pal_sdl_gpu.cpp",
        "native/src/pal_dawn.cpp",
    ]) {
        const text = readFileSync(file, "utf8");
        assert.match(
            text,
            /std::uint64_t synced_visibility_epoch =\s*\r?\n\s*engine\.visibility_epoch;/,
            `${file} does not track the visibility epoch`,
        );
        assert.match(
            text,
            /engine\.visibility_epoch != synced_visibility_epoch\) \{[\s\S]{0,700}?build_render_draw_lists\([\s\S]{0,200}?rebuild_task_draw_lists\(\);/,
            `${file} does not rebuild the draw lists when the epoch moves`,
        );
        assert.match(
            text,
            /synced_visibility_epoch = engine\.visibility_epoch;/,
            `${file} never re-syncs the visibility epoch`,
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
