/**
 * Every post-process parameter slot starts from the default its pinned
 * factory states: a `config.<option> ?? <default>`, the module's own
 * coercer, the `task` record, or the `params` record for a slot the pass
 * refreshes from its source.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POST_PROCESS_EFFECTS } from "../src/post-process-effects.js";

test("every post-process slot reads its default from the pin", () => {
    for (const effect of POST_PROCESS_EFFECTS) {
        for (const slot of effect.params) {
            assert.ok(
                typeof slot.fallback === "number" ||
                    typeof slot.fallback === "boolean",
                `${effect.intrinsic} ${slot.path}`,
            );
        }
    }
});

test("a flag keeps the pinned keyword's type and a runtime slot the params record's value", () => {
    const slots = (intrinsic: string) =>
        new Map(
            (
                POST_PROCESS_EFFECTS.find(
                    (effect) => effect.intrinsic === intrinsic,
                )?.params ?? []
            ).map((slot) => [slot.path, slot.fallback]),
        );
    const edges = slots("createSmaaEdgeDetectionPostProcessTask");
    assert.equal(typeof edges.get("sourceIsSrgb"), "boolean");
    assert.equal(typeof edges.get("threshold"), "number");
    const aberration = slots("createChromaticAberrationPostProcessTask");
    assert.equal(aberration.get("screenWidth"), 1);
    assert.equal(aberration.get("screenHeight"), 1);
});
