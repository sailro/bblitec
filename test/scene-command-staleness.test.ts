import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { browserCaptureStaleness } from "../src/capture-instrumented.js";
import { suiteBrowserModuleDigest } from "../src/capture-suite-reference.js";
import {
    captureBuffersPath,
    captureMetaPath,
    writeSeekMeta,
} from "../src/parity-scene.js";
import { resolveScene } from "../src/scene-registry.js";

// The one reader every capture-reuse path shares: diff recaptures on a
// reason, compose auto-captures on one, uniforms refuses with one. The
// classes are exercised in the order the reader checks them, over a real
// ad-hoc scene so the module digest is the digest the writers record.

test("names every way a browser capture stops being evidence", () => {
    const sourcePath = ".cache/staleness-probe-scene.ts";
    const captureDirectory = resolve(".cache", "staleness-capture");
    mkdirSync(".cache", { recursive: true });
    mkdirSync(captureDirectory, { recursive: true });
    writeFileSync(
        sourcePath,
        "export const probe = 1;\n",
    );
    try {
        const scene = resolveScene(sourcePath);

        // No capture at all.
        assert.equal(
            browserCaptureStaleness(scene, captureDirectory, {}),
            "missing",
        );

        // A capture with no provenance sidecar (pre-meta).
        writeFileSync(captureBuffersPath(captureDirectory), "[]");
        assert.equal(
            browserCaptureStaleness(scene, captureDirectory, {}),
            "carries no provenance sidecar",
        );

        // A fresh capture: the sidecar records the digest of the module
        // this scene composes to right now.
        const metaPath = captureMetaPath(captureDirectory);
        writeSeekMeta(metaPath, undefined, {
            moduleSha256: suiteBrowserModuleDigest(sourcePath),
            goldenIdentity: "not-checked",
        });
        assert.equal(
            browserCaptureStaleness(scene, captureDirectory, {
                requireSeek: null,
            }),
            undefined,
        );
        // The uniforms reader accepts the capture's own pose (no
        // requireSeek); diff pins one and refuses another.
        assert.equal(
            browserCaptureStaleness(scene, captureDirectory, {}),
            undefined,
        );
        assert.equal(
            browserCaptureStaleness(scene, captureDirectory, {
                requireSeek: 0.5,
            }),
            "was captured at a different seek",
        );

        // A filtered capture is an experiment, not evidence.
        writeSeekMeta(metaPath, undefined, {
            moduleSha256: suiteBrowserModuleDigest(sourcePath),
            goldenIdentity: "not-checked",
            drawFilter: 36,
        });
        assert.match(
            browserCaptureStaleness(scene, captureDirectory, {}) ?? "",
            /draw filter \(--skip-draw 36\)/,
        );

        // A sidecar predating the digest field forces a recapture.
        writeSeekMeta(metaPath, undefined);
        assert.equal(
            browserCaptureStaleness(scene, captureDirectory, {}),
            "carries no scene-module provenance",
        );

        // A scene source that moved since the capture: the digest no
        // longer matches, even though every file is still on disk.
        writeSeekMeta(metaPath, undefined, {
            moduleSha256: suiteBrowserModuleDigest(sourcePath),
            goldenIdentity: "not-checked",
        });
        writeFileSync(
            sourcePath,
            "export const probe = 2;\n",
        );
        assert.match(
            browserCaptureStaleness(scene, captureDirectory, {}) ?? "",
            /captured from a different scene module/,
        );
    } finally {
        rmSync(sourcePath, { force: true });
        rmSync(captureDirectory, { recursive: true, force: true });
    }
});
