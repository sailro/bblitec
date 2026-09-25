import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    geometryReferencePaths,
    geometryReferenceStaleness,
    geometryTaskPaths,
} from "../src/geometry-output-diagnostics.js";
import { writeSeekMeta } from "../src/tooling/artifacts.js";
import {
    defaultExecutable,
    resolveNativeExecutable,
    withEnvironment,
} from "../src/tooling/native-run.js";
import { compiledBuildDirectory } from "../src/build-options.js";

test("measured runs select coexisting backend builds without modifying their payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "bblite-backends-"));
    const directory = join(root, "build-scene-release");
    try {
        await withEnvironment("BBLITE_NATIVE_EXE", undefined, async () => {
            for (const backend of ["BOTH", "SDL_GPU", "DAWN"] as const) {
                const build = compiledBuildDirectory(directory, backend);
                mkdirSync(build);
                writeFileSync(defaultExecutable(build), backend);
            }
            for (const backend of [
                "SDL_GPU",
                "DAWN",
                "BOTH",
                "SDL_GPU",
            ] as const) {
                await withEnvironment("BBLITE_BACKEND", backend, async () => {
                    const executable = resolveNativeExecutable(
                        undefined,
                        directory,
                    );
                    assert.equal(readFileSync(executable, "utf8"), backend);
                    assert.equal(
                        resolveNativeExecutable("explicit/exe", directory),
                        resolve("explicit/exe"),
                    );
                });
            }
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// The geometry mode's parseable pieces: the per-task path quartet, the
// shared browser-evidence staleness rule for cached impostor references,
// and the shared executable resolver.

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
    assert.deepEqual(geometryReferencePaths(directory, "albedo"), {
        reference: paths.reference,
        referenceMeta: paths.referenceMeta,
    });
});

test("a cached impostor reference is evidence only for its pose, pin and module", () => {
    const directory = resolve(".cache", "geometry-staleness");
    mkdirSync(directory, { recursive: true });
    const reference = join(directory, "albedo-lite.png");
    const meta = join(directory, "albedo-lite.meta.json");
    const want = (seekSeconds: number | null, pin = "1.0@abc") => ({
        seekSeconds,
        pin,
        moduleSha256: (seek: number | undefined) => `module-at-${seek}`,
    });
    try {
        // No reference at all.
        assert.equal(
            geometryReferenceStaleness(reference, meta, want(null)),
            "missing",
        );

        // A pre-sidecar reference reads as unknown provenance — the
        // reuse-on-bare-existence hole this rule closes.
        writeFileSync(reference, "png");
        assert.equal(
            geometryReferenceStaleness(reference, meta, want(null)),
            "carries no provenance sidecar",
        );

        // A seek-only sidecar (the previous format) names no module.
        writeSeekMeta(meta, 0.5);
        assert.equal(
            geometryReferenceStaleness(reference, meta, want(0.5)),
            "carries no scene-module provenance",
        );

        // A complete sidecar matches itself, seeked or not...
        writeSeekMeta(meta, 0.5, {
            moduleSha256: "module-at-0.5",
            pin: "1.0@abc",
        });
        assert.equal(
            geometryReferenceStaleness(reference, meta, want(0.5)),
            undefined,
        );
        writeSeekMeta(meta, undefined, {
            moduleSha256: "module-at-undefined",
            pin: "1.0@abc",
        });
        assert.equal(
            geometryReferenceStaleness(reference, meta, want(null)),
            undefined,
        );

        // ...and any other pose, pin or module recaptures.
        assert.equal(
            geometryReferenceStaleness(reference, meta, want(0.5)),
            "was captured at a different seek",
        );
        assert.equal(
            geometryReferenceStaleness(reference, meta, want(null, "2.0@def")),
            "was captured through 1.0@abc, not the current pin",
        );
        writeSeekMeta(meta, undefined, {
            moduleSha256: "an-older-module",
            pin: "1.0@abc",
        });
        assert.match(
            geometryReferenceStaleness(reference, meta, want(null)) ?? "",
            /different scene module/,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("the executable chain is explicit, then BBLITE_NATIVE_EXE, then the build", () => {
    const previous = process.env.BBLITE_NATIVE_EXE;
    try {
        process.env.BBLITE_NATIVE_EXE = join("elsewhere", "bblite_native.exe");
        // An explicit executable (the probe's resolved binary) wins over
        // the ambient override.
        assert.equal(
            resolveNativeExecutable(
                join("explicit", "exe"),
                "native/build-scene145-release",
            ),
            resolve("explicit", "exe"),
        );
        // The ambient override wins over the scene's own build.
        assert.equal(
            resolveNativeExecutable(undefined, "native/build-scene145-release"),
            resolve("elsewhere", "bblite_native.exe"),
        );
        // Without either, the scene's Release build answers.
        delete process.env.BBLITE_NATIVE_EXE;
        const fallback = resolveNativeExecutable(
            undefined,
            "native/build-scene145-release",
        );
        assert.ok(
            fallback.includes(join("native", "build-scene145-release")),
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
