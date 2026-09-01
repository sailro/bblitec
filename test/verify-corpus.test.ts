import assert from "node:assert/strict";
import test from "node:test";
import type { BabylonLiteCorpusManifest } from "../src/upstream-corpus.js";
import type { ExactCorpusManifest } from "../src/verify-corpus.js";
import { classifyCorpusChecks } from "../src/verify-corpus.js";

// The classification is the decidable half of `corpus:verify`: which URL
// answers for a row, and whether the row is an upstream-tree file, a
// pinned origin file, or a member of a pinned release archive. The
// network comparison itself is the command, not a unit test.

const manifest: BabylonLiteCorpusManifest = {
    package: "@babylonjs/lite",
    version: "1.25.0",
    repository: "https://github.com/BabylonJS/Babylon-Lite.git",
    sourceVersion: "cafe0123",
    scenes: [
        {
            id: "scene1",
            upstreamPath: "lab/lite/src/lite/scene1.ts",
            source: "corpus/babylon-lite/lab/lite/src/lite/scene1.ts",
            sha256: "aa",
        },
    ],
    modules: [
        {
            upstreamPath: "lab/lite/src/lite/_shared.ts",
            source: "corpus/babylon-lite/lab/lite/src/lite/_shared.ts",
            sha256: "bb",
        },
    ],
    staged: [
        {
            upstreamPath: "lab/lite/src/lite/scene999.ts",
            source: "corpus/babylon-lite/lab/lite/src/lite/scene999.ts",
            sha256: "cc",
        },
    ],
    applications: [
        {
            id: "doom",
            entry: "corpus/babylon-lite/lab/lite/src/demos/doom.ts",
            reference: { source: "reference/doom/golden.png", sha256: "00" },
            files: [
                {
                    upstreamPath: "lab/lite/src/demos/doom.ts",
                    source: "corpus/babylon-lite/lab/lite/src/demos/doom.ts",
                    sha256: "dd",
                },
                {
                    upstreamPath: "freedoom-0.13.0/freedoom1.wad",
                    origin: "https://example.test/freedoom-0.13.0.zip",
                    source: "corpus/babylon-lite/lab/lite/src/demos/doom/freedoom1.wad",
                    sha256: "ee",
                },
                {
                    upstreamPath: "lab/public/racer/LICENSE",
                    origin: "https://example.test/racing/LICENSE",
                    source: "corpus/babylon-lite/lab/lite/src/demos/racer/LICENSE",
                    sha256: "ff",
                },
            ],
        },
    ],
};

test("classifies every corpus row onto the URL that decides it", () => {
    const exact: ExactCorpusManifest = {
        sourceVersion: "cafe0123",
        scenes: [],
    };
    assert.deepEqual(classifyCorpusChecks(manifest, exact), [
        {
            label: "scenes lab/lite/src/lite/scene1.ts",
            kind: "upstream-tree",
            url: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/cafe0123/lab/lite/src/lite/scene1.ts",
            sha256: "aa",
        },
        {
            label: "modules lab/lite/src/lite/_shared.ts",
            kind: "upstream-tree",
            url: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/cafe0123/lab/lite/src/lite/_shared.ts",
            sha256: "bb",
        },
        {
            label: "staged lab/lite/src/lite/scene999.ts",
            kind: "upstream-tree",
            url: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/cafe0123/lab/lite/src/lite/scene999.ts",
            sha256: "cc",
        },
        {
            label: "doom lab/lite/src/demos/doom.ts",
            kind: "upstream-tree",
            url: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/cafe0123/lab/lite/src/demos/doom.ts",
            sha256: "dd",
        },
        {
            label: "doom freedoom-0.13.0/freedoom1.wad",
            kind: "archive-member",
            url: "https://example.test/freedoom-0.13.0.zip",
            sha256: "ee",
        },
        {
            label: "doom lab/public/racer/LICENSE",
            kind: "origin-file",
            url: "https://example.test/racing/LICENSE",
            sha256: "ff",
        },
    ]);
});

test("joins exact-manifest rows to corpus scene paths and derives the rest", () => {
    const exact: ExactCorpusManifest = {
        sourceVersion: "cafe0123",
        scenes: [
            { id: "scene1", sourceSha256: "11" },
            { id: "scene7", sourceSha256: "77" },
        ],
    };
    const checks = classifyCorpusChecks(manifest, exact).filter(
        (check) => check.label.startsWith("exact "),
    );
    assert.deepEqual(checks, [
        {
            label: "exact scene1",
            kind: "upstream-tree",
            url: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/cafe0123/lab/lite/src/lite/scene1.ts",
            sha256: "11",
        },
        {
            label: "exact scene7",
            kind: "upstream-tree",
            url: "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/cafe0123/lab/lite/src/lite/scene7.ts",
            sha256: "77",
        },
    ]);
});

test("refuses an exact manifest pinned to a different commit", () => {
    const exact: ExactCorpusManifest = {
        sourceVersion: "beef4567",
        scenes: [],
    };
    assert.throws(
        () => classifyCorpusChecks(manifest, exact),
        /beef4567.*cafe0123/s,
    );
});

test("refuses a generated row whose upstreamPath names no output file", () => {
    // The generated-file check verifies that the pinned generator's text
    // names the row's output; an empty name would match every generator
    // vacuously, so classification refuses it instead of letting the
    // suite pass on nothing.
    const exact: ExactCorpusManifest = {
        sourceVersion: "cafe0123",
        scenes: [],
    };
    const generated: BabylonLiteCorpusManifest = {
        ...manifest,
        applications: [],
        modules: [],
        staged: [
            {
                upstreamPath: "lab/generated/",
                generatedBy: "lab/tools/render.ts",
                source: "corpus/babylon-lite/lab/generated/table.ts",
                sha256: "ab",
            },
        ],
    };
    assert.throws(
        () => classifyCorpusChecks(generated, exact),
        /declares generatedBy but its upstreamPath names no output file/,
    );
});
