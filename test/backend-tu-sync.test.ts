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
