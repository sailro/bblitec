import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import type { BabylonLiteCorpusManifest } from "../src/upstream-corpus.js";
import type { ExactCorpusManifest } from "../src/verify-corpus.js";
import {
    classifyCorpusChecks,
    rightHandedFlagMismatches,
    verifyChecks,
} from "../src/verify-corpus.js";

// The classification is the decidable half of `corpus:verify`: which URL
// answers for a row, and whether the row is an upstream-tree file, a
// pinned origin file, or a member of a pinned release archive. The
// live origin comparison itself is the command.

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
    const checks = classifyCorpusChecks(manifest, exact).filter((check) =>
        check.label.startsWith("exact "),
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

test("rejects a 200 HTML archive, recovers a poisoned cache entry and still checks member digests", async (t) => {
    const url = `https://example.invalid/${randomUUID()}.zip`;
    const path = resolve(
        ".cache/assets",
        createHash("sha256").update(url).digest("hex").slice(0, 32),
    );
    t.after(() => {
        rmSync(path, { force: true });
        rmSync(`${path}.type`, { force: true });
    });
    const zip = readFileSync("examples/assets/regression/texture-pack.zip");
    const html = "<!doctype html>temporarily unavailable";
    let requests = 0;
    t.mock.method(globalThis, "fetch", (requested: string) => {
        assert.equal(requested, url);
        return Promise.resolve(
            ++requests === 1
                ? new Response(html, {
                      headers: { "content-type": "application/zip" },
                  })
                : new Response(zip, {
                      headers: { "content-type": "application/octet-stream" },
                  }),
        );
    });
    const member = {
        kind: "archive-member",
        label: "checker.png",
        url,
        sha256: "4f0d70066c42b14a9dd4d7a9b66bc6aa4d1cc04439810ac2e2ae5896bd180a63",
    } as const;
    const checks = [member, { ...member, sha256: "0".repeat(64) }];
    const first = await verifyChecks(checks, false);
    assert.equal(first[0]?.status, "unverifiable");
    assert.match(first[0].detail, /No zip end-of-central-directory/);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.type`), false);

    // A previous release already cached a successful HTML response.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
    writeFileSync(`${path}.type`, "text/html");
    assert.equal((await verifyChecks(checks, true))[0]?.status, "unverifiable");
    assert.equal(requests, 1);
    const recovered = await verifyChecks(checks, false);
    assert.deepEqual(
        recovered.map((row) => row.status),
        ["match", "mismatch"],
    );
    assert.equal(recovered[0]?.detail, "checker.png");
    assert.deepEqual(readFileSync(path), zip);
    assert.equal(
        readFileSync(`${path}.type`, "utf8"),
        "application/octet-stream",
    );
    assert.deepEqual(await verifyChecks(checks, true), recovered);
    assert.equal(requests, 2);
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

test("holds the scene rows' right-handed flags to the pinned scene configuration", () => {
    const twin = {
        id: "scene2",
        upstreamPath: "lab/lite/src/lite/scene2.ts",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene2.ts",
        sha256: "cc",
        rightHanded: true,
    } as const;
    const flagged = { ...manifest, scenes: [...manifest.scenes, twin] };
    const config = JSON.stringify([{ id: 1 }, { id: 2, rightHanded: true }]);
    assert.deepEqual(rightHandedFlagMismatches(flagged, config), []);
    // A marked scene with no row is no row's to carry.
    assert.deepEqual(rightHandedFlagMismatches(manifest, config), []);
    // A flag the configuration does not set, and one a row omits.
    assert.deepEqual(
        rightHandedFlagMismatches(flagged, JSON.stringify([{ id: 2 }])),
        ["scene2"],
    );
    assert.deepEqual(
        rightHandedFlagMismatches(
            manifest,
            JSON.stringify([{ id: 1, rightHanded: true }]),
        ),
        ["scene1"],
    );
});
