import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    geometryReferenceStaleness,
    geometryTaskPaths,
} from "../src/geometry-output-diagnostics.js";
import {
    resolveNativeExecutable,
    writeSeekMeta,
} from "../src/parity-scene.js";

// TL-6's parseable pieces, in the gaps-test style: the per-task path
// quartet, the diff-rule staleness reader for cached impostor
// references, and the shared executable resolver the command now goes
// through instead of its own truncated chain.

test("spells the geometry task path quartet once for writer and reader", () => {
    const directory = join("artifacts", "parity", "scene145", "geometry");
    const paths = geometryTaskPaths(directory, "albedo", "gpu");
    assert.equal(paths.reference, resolve(directory, "albedo-lite.png"));
    assert.equal(
        paths.referenceMeta,
        resolve(directory, "albedo-lite.meta.json"),
    );
    assert.equal(paths.actual, resolve(directory, "albedo-native-gpu.png"));
    assert.equal(paths.diff, resolve(directory, "albedo-diff-gpu.png"));
    // The Dawn artifacts sit beside the SDL_GPU ones under their own
    // token; the browser reference is shared and carries neither.
    const dawn = geometryTaskPaths(directory, "albedo", "dawn");
    assert.equal(dawn.reference, paths.reference);
    assert.equal(dawn.actual, resolve(directory, "albedo-native-dawn.png"));
});

test("a cached impostor reference is evidence only at its recorded pose", () => {
    const directory = resolve(".cache", "geometry-staleness");
    mkdirSync(directory, { recursive: true });
    const reference = join(directory, "albedo-lite.png");
    const meta = join(directory, "albedo-lite.meta.json");
    try {
        // No reference at all.
        assert.equal(
            geometryReferenceStaleness(reference, meta, null),
            "missing",
        );

        // A pre-sidecar reference reads as unknown provenance — the
        // reuse-on-bare-existence hole this rule closes.
        writeFileSync(reference, "png");
        assert.equal(
            geometryReferenceStaleness(reference, meta, null),
            "was captured at a different seek (or carries no provenance)",
        );

        // A recorded pose matches itself, seeked or not...
        writeSeekMeta(meta, 0.5);
        assert.equal(
            geometryReferenceStaleness(reference, meta, 0.5),
            undefined,
        );
        writeSeekMeta(meta, undefined);
        assert.equal(
            geometryReferenceStaleness(reference, meta, null),
            undefined,
        );

        // ...and any other wanted pose recaptures, in both directions —
        // the animated-scene case TL-6 named: a settled browser pose
        // against native frame 0.
        writeSeekMeta(meta, 0.5);
        assert.equal(
            geometryReferenceStaleness(reference, meta, 1),
            "was captured at a different seek (or carries no provenance)",
        );
        assert.equal(
            geometryReferenceStaleness(reference, meta, null),
            "was captured at a different seek (or carries no provenance)",
        );
        writeSeekMeta(meta, undefined);
        assert.equal(
            geometryReferenceStaleness(reference, meta, 0.5),
            "was captured at a different seek (or carries no provenance)",
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("the executable chain is explicit, then BBLITE_NATIVE_EXE, then the build", () => {
    const previous = process.env.BBLITE_NATIVE_EXE;
    try {
        process.env.BBLITE_NATIVE_EXE = join("elsewhere", "bblite_native.exe");
        // An explicit `--exe` wins over the ambient override.
        assert.equal(
            resolveNativeExecutable(
                join("explicit", "exe"),
                "native/build-scene145-release",
            ),
            resolve("explicit", "exe"),
        );
        // The ambient override wins over the scene's own build.
        assert.equal(
            resolveNativeExecutable(
                undefined,
                "native/build-scene145-release",
            ),
            resolve("elsewhere", "bblite_native.exe"),
        );
        // Without either, the scene's Release build answers.
        delete process.env.BBLITE_NATIVE_EXE;
        const fallback = resolveNativeExecutable(
            undefined,
            "native/build-scene145-release",
        );
        assert.ok(
            fallback.includes(
                join("native", "build-scene145-release"),
            ),
            `default resolves into the build directory (got ${fallback})`,
        );
    } finally {
        if (previous === undefined) {
            delete process.env.BBLITE_NATIVE_EXE;
        } else {
            process.env.BBLITE_NATIVE_EXE = previous;
        }
    }
});
