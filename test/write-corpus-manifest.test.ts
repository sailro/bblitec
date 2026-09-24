import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
    adoptRecapturedRow,
    moduleMoveExplainedByPin,
} from "../src/write-corpus-manifest.js";

// `corpus:manifest` rewrites the golden-provenance column a pin bump moves.
// The whole writer rests on one rule -- a moved digest is adopted only when
// reverting the pin reproduces the committed value -- because rewriting the
// column unconditionally would launder a real change into the provenance
// record. That rule is a predicate over the composed text, so it is checked
// here without a repository tree to point the writer at.

const previous = {
    version: "1.25.0",
    sourceVersion: "286525f8041dd9adc72b2c9962e8bff4d9aeb764",
};
const current = {
    version: "1.26.0",
    sourceVersion: "69c8588f39454f94b6c1657193672cee9f03ee0e",
};

const sha256 = (text: string): string =>
    createHash("sha256").update(text).digest("hex");

/** The shape a capture module takes: the pin reaches it through asset URLs. */
const moduleText = (pin: typeof previous, scene: string): string =>
    `import { createEngine } from "@babylonjs/lite";\n` +
    `// @babylonjs/lite@${pin.version}\n` +
    `const brdfUrl = "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/` +
    `${pin.sourceVersion}/packages/babylon-lite/assets/brdf-lut.png";\n` +
    `export const source = ${JSON.stringify(scene)};\n`;

test("a digest that moved only through the pinned URLs is explained", () => {
    const recorded = sha256(moduleText(previous, "scene1"));
    assert.ok(
        moduleMoveExplainedByPin(
            moduleText(current, "scene1"),
            recorded,
            previous,
            current,
        ),
    );
});

test("a scene that moved beside the pin is not explained", () => {
    // The pin churn is present AND the scene changed. Reverting the pin
    // cannot reach the recorded digest, so the writer must refuse rather
    // than adopt the new value and lose the fact that the scene moved.
    const recorded = sha256(moduleText(previous, "scene1"));
    assert.equal(
        moduleMoveExplainedByPin(
            moduleText(current, "scene1-edited"),
            recorded,
            previous,
            current,
        ),
        false,
    );
});

test("a wrong previous pin does not explain the move", () => {
    // Getting the previous pair wrong is the likely operator error, and it
    // must refuse rather than rewrite every row against a pin that never
    // produced them.
    const recorded = sha256(moduleText(previous, "scene1"));
    assert.equal(
        moduleMoveExplainedByPin(
            moduleText(current, "scene1"),
            recorded,
            {
                version: "1.25.0",
                sourceVersion: "0".repeat(40),
            },
            current,
        ),
        false,
    );
});

test("both halves of the pin are reverted, not just the commit", () => {
    // A provenance banner carries the package version beside the commit, so
    // reverting the commit alone leaves the version behind and every row
    // reads as unexplained.
    const recorded = sha256(moduleText(previous, "scene1"));
    assert.equal(
        moduleMoveExplainedByPin(
            moduleText(current, "scene1"),
            recorded,
            {
                version: current.version,
                sourceVersion: previous.sourceVersion,
            },
            current,
        ),
        false,
    );
});

// `--adopt-reference` records a deliberate recapture: only the golden's
// digest and capture time move, and only while every other pinned input holds.
const row = {
    id: "scene181",
    sourceSha256: "source",
    reference: "reference/scene181/babylon-lite-golden.png",
    referenceSha256: "old-golden",
    moduleSha256: "module",
    capturedAt: "2026-09-08T05:21:34.366Z",
    referenceHostPage: "corpus/babylon-lite/lab/lite/scene181.html",
    referenceHostPageSha256: "host",
};
const inputs = {
    corpusSha256: "source",
    moduleSha256: "module",
    referenceSearch: undefined,
    referenceHostPage: "corpus/babylon-lite/lab/lite/scene181.html",
    referenceHostPageSha256: "host",
    goldenSha256: "new-golden",
    goldenWrittenAt: "2026-09-24T12:00:00.000Z",
};

test("a recaptured golden of an unchanged capture is adopted with its capture time", () => {
    assert.deepEqual(adoptRecapturedRow(row, inputs), {
        ...row,
        referenceSha256: "new-golden",
        capturedAt: "2026-09-24T12:00:00.000Z",
    });
});

test("adoption refuses a moved input and an unchanged golden", () => {
    assert.throws(
        () => adoptRecapturedRow(row, { ...inputs, moduleSha256: "other" }),
        /capture module moved/,
    );
    assert.throws(
        () => adoptRecapturedRow(row, { ...inputs, corpusSha256: "other" }),
        /corpus source moved/,
    );
    assert.throws(
        () => adoptRecapturedRow(row, { ...inputs, referenceSearch: "?x" }),
        /capture query moved/,
    );
    assert.throws(
        () =>
            adoptRecapturedRow(row, {
                ...inputs,
                referenceHostPageSha256: "other",
            }),
        /host page moved/,
    );
    assert.throws(
        () =>
            adoptRecapturedRow(row, { ...inputs, goldenSha256: "old-golden" }),
        /no recapture to adopt/,
    );
});
