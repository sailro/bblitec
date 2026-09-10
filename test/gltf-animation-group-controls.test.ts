import assert from "node:assert/strict";
import test from "node:test";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGltfAnimationEvaluator } from "../src/lowering/gltf/animation-evaluator.js";
import { lowerGltfAnimationMask } from "../src/lowering/gltf/animation-mask.js";
import { lowerGltfAnimationPlayback } from "../src/lowering/gltf/animation-playback.js";
import { lowerGltfWeightedAnimationRuntime } from "../src/lowering/gltf/weighted-animation-runtime.js";
import { lowerGltfWeightedAnimationPasses } from "../src/lowering/gltf/weighted-animation-passes.js";

test("emits a group's speed-ratio and mask writers only when reached", () => {
    const plain = new AnimationLowerer(
        new LoweringContext(),
    ).lowerGroupOperations();
    assert.doesNotMatch(plain.source, /set_animation_speed_ratio/);
    assert.doesNotMatch(plain.source, /set_animation_mask/);

    const reached = new AnimationLowerer(
        new LoweringContext(),
    ).lowerGroupOperations({ groupSpeed: true, groupMask: true });
    assert.match(
        reached.source,
        /asset\.set_clip_speed_ratio\(record\.clip, speed_ratio\)/,
    );
    assert.match(
        reached.source,
        /asset\.set_clip_mask\(record\.clip, names, include\)/,
    );
});

test("carries STEP and the non-triangle topologies into the glTF loader", () => {
    const context = new LoweringContext();
    const lowerer = new GltfLowerer(context);
    const plain = lowerer.lowerLoaderAdapter();
    // STEP is unconditional: the pin branches on it in `evaluateSampler`, so
    // every glTF loader carries the arm. Sampler parsing has native source comparisons.
    assert.ok(plain.source.includes(lowerGltfAnimationEvaluator(context)));
    // The topology handling stays behind the specialization flag, the way
    // upstream keeps `gltf-feature-primitive.js` behind its own predicate.
    assert.doesNotMatch(plain.source, /MeshTopology::line_strip/);
    assert.doesNotMatch(plain.source, /void gltf_sync_animation_mask\(/);

    const exotic = lowerer.lowerLoaderAdapter({
        nonTrianglePrimitives: true,
    });
    assert.match(exotic.source, /MeshTopology::points/);
    assert.match(exotic.source, /MeshTopology::lines/);
    assert.match(exotic.source, /MeshTopology::line_strip/);
    assert.match(
        exotic.source,
        /Unsupported prepared glTF topology/,
    );
    // A point or a line has no fragment quad for the pinned flat-normal
    // derivative to read, so a primitive without NORMAL refuses.
    assert.match(
        exotic.source,
        /point or line primitive with no NORMAL/,
    );

    const masked = lowerer.lowerLoaderAdapter({ animationMask: true });
    assert.ok(masked.source.includes(lowerGltfAnimationMask(context)));
    assert.match(masked.source, /animation_runtime->node_names/);
    assert.match(masked.source, /gltf_sync_animation_mask\(clip,animation_runtime->node_names\)/);
    // Speed and seek use the source controller clock, covered with source
    // mutations and paused/stopped/reverse playback in the native fixture.
    assert.ok(plain.source.includes(lowerGltfAnimationPlayback(context)));
    assert.match(plain.source, /asset\.set_clip_speed_ratio\s*=/);
    assert.match(plain.source, /clip\.time=time;clip\.playing=false;/);
});

test("the weighted mixer uses source channels and global manager membership", () => {
    const context = new LoweringContext();
    const lowerer = new GltfLowerer(context);
    const blended = lowerer.lowerLoaderAdapter({
        animationBlending: true,
    });
    assert.ok(blended.source.includes(lowerGltfWeightedAnimationRuntime(context)));
    assert.ok(blended.source.includes(lowerGltfWeightedAnimationPasses(context)));
    assert.match(blended.source, /manager\.ordered_groups/);
    assert.match(blended.source, /gltf_update_weighted_animation_passes\(transport,delta_ms\)/);
    // Clip channel order and manager traversal have source/native differential
    // fixtures; the loader binds those channels to each source-created pose.
    assert.match(blended.source, /gltf_accumulate_weighted_group\(scratch,group,\*group\.pose,/);
    assert.match(blended.source, /gltf_accumulate_additive_group\(scratch,group,\*group\.pose,/);
    const plain = lowerer.lowerLoaderAdapter();
    assert.doesNotMatch(plain.source, /gltf_update_weighted_animation_passes/);
});
