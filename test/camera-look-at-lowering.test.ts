/**
 * The camera's world matrix and the ArcRotate eye are the pinned
 * `mat4LookAtWorldLHToRef` and nested `localEyePosition` translated whole.
 * These tests prove the translations are live: a doctored pin moves the
 * emitted literal, a nested declaration that moves out of its factory
 * refuses, and the high-precision arm stores at the pin's F64 width.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { doctoredContext } from "./doctored-store.js";

const LOOK_AT_MODULE = "src/math/mat4-look-at-world-lh.ts";
const ARC_ROTATE_MODULE = "src/camera/arc-rotate.ts";

function arcRotateSource(
    context = new LoweringContext(),
    highPrecisionMatrix = false,
): string {
    return new CameraLowerer(context).lowerArcRotateFactory(
        false,
        highPrecisionMatrix,
    ).source;
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

test("the high-precision arm stores the unrounded basis", () => {
    const precise = arcRotateSource(new LoweringContext(), true);
    assert.match(precise, /out\[static_cast<std::size_t>\(0\.0\)\] = xx;/);
    assert.match(
        precise,
        /out\[static_cast<std::size_t>\(4\.0\)\] = \(\(zy \* xz\) - \(zz \* xy\)\);/,
    );
    assert.doesNotMatch(precise, /static_cast<float>/);
    const narrowed = arcRotateSource();
    assert.match(
        narrowed,
        /out\[static_cast<std::size_t>\(4\.0\)\] = static_cast<float>\(\(\(zy \* xz\) - \(zz \* xy\)\)\);/,
    );
});
