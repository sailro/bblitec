/**
 * The camera's world matrix and the ArcRotate eye are the pinned
 * `writeLookAtWorldMat4LHIntoBuffer` and nested `localEyePosition` translated whole.
 * These tests prove the translations are live: a doctored pin moves the
 * emitted literal, and a nested declaration that moves out of its factory
 * refuses. The un-doctored emission, both store widths included, is
 * pinned beside the other camera factories in upstream.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { doctoredContext } from "./doctored-store.js";
import {
    probeError,
    probeValue,
    rightHandedProbes,
} from "./right-handed-process.js";

const LOOK_AT_MODULE = "src/math/write-look-at-world-mat4-lh-into-buffer.ts";
const ARC_ROTATE_MODULE = "src/camera/arc-rotate.ts";

function arcRotateSource(context: LoweringContext): string {
    return new CameraLowerer(context).lowerArcRotateFactory().source;
}

test("a changed look-at degenerate epsilon flows into both guards", () => {
    const source = arcRotateSource(
        doctoredContext(LOOK_AT_MODULE, "1e-10", "1e-9"),
    );
    assert.match(source, /if \(zLen >= 1e-9\) \{/);
    assert.match(source, /if \(xLen < 1e-10\) \{/);
});

test("a changed pole fallback flows into the eye", () => {
    const source = arcRotateSource(
        doctoredContext(ARC_ROTATE_MODULE, "sinB = 0.0001;", "sinB = 0.001;"),
    );
    assert.match(source, /sinB = 0\.001;/);
});

test("an eye that leaves its factory refuses generation", () => {
    assert.throws(
        () =>
            arcRotateSource(
                doctoredContext(
                    ARC_ROTATE_MODULE,
                    "function localEyePosition(): Vec3 {",
                    "function localEyeOffset(): Vec3 {",
                ),
            ),
        /Expected one nested function 'localEyePosition'/,
    );
});

test("a right-handed camera world negates its look-at X and Z basis columns", () => {
    const negation =
        "for (const double i : std::array<double, 6>{0.0, 1.0, 2.0, 8.0, 9.0, 10.0}) {";
    assert.ok(!arcRotateSource(new LoweringContext()).includes(negation));
    const [rightHanded, edited] = rightHandedProbes([
        { probe: "arcRotateFactory" },
        // Every reached factory edits its world the same way.
        {
            probe: "arcRotateFactory",
            edits: [
                [
                    "src/camera/free-camera.ts",
                    [
                        "for (const i of [0, 1, 2, 8, 9, 10])",
                        "for (const i of [0, 1, 2])",
                    ],
                ],
            ],
        },
    ]);
    assert.ok(String(probeValue(rightHanded)).includes(negation));
    assert.match(
        probeError(edited),
        /no longer edits its look-at matrix as createArcRotateCamera's does/,
    );
});
