/** Source-derived additive helpers are integrated with the public group writers. */
import assert from "node:assert/strict";
import test from "node:test";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { doctoredContext as doctoredModuleContext } from "./doctored-store.js";
import { lowerGltfWeightedAnimationRuntime } from "../src/lowering/gltf/weighted-animation-runtime.js";
import { lowerGltfWeightedAnimationPasses } from "../src/lowering/gltf/weighted-animation-passes.js";
import { lowerGltfAnimationPlayback } from "../src/lowering/gltf/animation-playback.js";

const MIXER_MODULE = "src/animation/weighted-gltf-mixer.ts";

function doctoredContext(
    needle: string,
    replacement: string,
): LoweringContext {
    return doctoredModuleContext(MIXER_MODULE, needle, replacement);
}

test("the additive group writers carry the pinned conversion and guard", () => {
    const lowered = new AnimationLowerer(
        new LoweringContext(),
    ).lowerGroupOperations({ additive: true, groupTime: true });
    // The frame arm divides by the pinned default rate — the setter's own
    // `|| 60` and the group factory's DEFAULT_FRAME_RATE, asserted equal.
    assert.match(
        lowered.source,
        /set_animation_additive\(\s*engine,\s*group,\s*reference_frame \/ 60\.0f\);/,
    );
    // The pinned finite/non-negative reference guard.
    assert.match(
        lowered.source,
        /!std::isfinite\(reference_time\) \|\|\s*reference_time < 0\.0f/,
    );
    // The additive mark takes the same writer route as every other group
    // field, and the owner enable installs the glTF mixer handler.
    assert.match(lowered.source, /asset\.set_clip_additive/);
    assert.match(
        lowered.source,
        /category_handler =\s*AnimationCategoryHandler::gltf_mixer;/,
    );
    // The direct currentTime write reaches the loader's own time writer.
    assert.match(
        lowered.source,
        /void set_animation_current_time\(/,
    );
    assert.doesNotMatch(
        // Without the reaches, neither writer is emitted — the gates keep
        // untouched scenes byte-identical.
        new AnimationLowerer(new LoweringContext())
            .lowerGroupOperations()
            .source,
        /set_animation_additive|set_animation_current_time/,
    );
});

test("the loader integrates source additive passes, arithmetic and playback", () => {
    const context = new LoweringContext();
    const adapter = new GltfLowerer(context).lowerLoaderAdapter({
        animationBlending: true,
        animationAdditive: true,
    });
    // Native differential fixtures exercise the complete pass order and
    // Float32 additive arithmetic; these checks keep those bodies connected.
    for (const body of [lowerGltfWeightedAnimationRuntime(context),
        lowerGltfWeightedAnimationPasses(context), lowerGltfAnimationPlayback(context, true)])
        assert.ok(adapter.source.includes(body), "the loader includes the tested source animation body");
    assert.match(adapter.source, /asset\.set_clip_additive\s*=/);
    assert.match(adapter.source, /clip\.additive_reference_time\s*=\s*reference_time/);
    assert.match(adapter.source, /if\(clip\.stopped\|\|!clip\.playing\)continue;/);
});

test("a doctored additive difference changes the integrated source body", () => {
    const context = doctoredContext(
        "target.trs[base + T_OFF] = target.trs[base + T_OFF]! + (scratch.sample[0]! - scratch.reference[0]!) * weight;",
        "target.trs[base + T_OFF] = target.trs[base + T_OFF]! + (scratch.sample[0]! + scratch.reference[0]!) * weight;",
    );
    const original = lowerGltfWeightedAnimationRuntime(new LoweringContext());
    const changed = lowerGltfWeightedAnimationRuntime(context);
    assert.notEqual(changed, original);
    const source = new GltfLowerer(context).lowerLoaderAdapter({animationBlending: true, animationAdditive: true}).source;
    assert.ok(source.includes(changed));
    assert.ok(!source.includes(original));
});

test("a doctored additive reference rate refuses generation", () => {
    assert.throws(
        () =>
            new AnimationLowerer(
                doctoredContext(
                    "(group.frameRate || 60)",
                    "(group.frameRate || 30)",
                ),
            ).lowerGroupOperations({ additive: true }),
        /Additive reference-time resolution/,
    );
});

test("a doctored owner enable refuses generation", () => {
    assert.throws(
        () =>
            new AnimationLowerer(
                doctoredContext(
                    "enableAnimationBlending(owner);",
                    "void owner;",
                ),
            ).lowerGroupOperations({ additive: true }),
        /enableAnimationBlending/,
    );
});
