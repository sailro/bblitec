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
