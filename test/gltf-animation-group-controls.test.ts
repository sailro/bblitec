import assert from "node:assert/strict";
import test from "node:test";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";

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
    const lowerer = new GltfLowerer(new LoweringContext());
    const plain = lowerer.lowerLoaderAdapter();
    // STEP is unconditional: the pin branches on it in `evaluateSampler`, so
    // every glTF loader carries the arm and the accepted interpolation names.
    assert.match(plain.source, /TrackInterpolation::step/);
    assert.match(
        plain.source,
        /supports LINEAR, STEP and CUBICSPLINE interpolation/,
    );
    assert.match(plain.source, /std::size_t track_step_key_at\(/);
    // The topology handling stays behind the specialization flag, the way
    // upstream keeps `gltf-feature-primitive.js` behind its own predicate.
    assert.doesNotMatch(plain.source, /MeshTopology::line_strip/);
    assert.doesNotMatch(plain.source, /clip_masks_node/);

    const exotic = lowerer.lowerLoaderAdapter({
        nonTrianglePrimitives: true,
    });
    assert.match(exotic.source, /MeshTopology::points/);
    assert.match(exotic.source, /MeshTopology::lines/);
    assert.match(exotic.source, /MeshTopology::line_strip/);
    assert.match(
        exotic.source,
        /has no WebGPU topology and is not supported/,
    );
    // A point or a line has no fragment quad for the pinned flat-normal
    // derivative to read, so a primitive without NORMAL refuses.
    assert.match(
        exotic.source,
        /point or line primitive with no NORMAL/,
    );

    const masked = lowerer.lowerLoaderAdapter({ animationMask: true });
    assert.match(masked.source, /bool clip_masks_node\(/);
    assert.match(masked.source, /animation_runtime->node_names/);
    assert.match(masked.source, /if \(listed == include\) continue;/);
    assert.match(masked.source, /target\.rotation = target\.rest_rotation/);

    // The manager advance is the arm that accumulates, so the ratio has to
    // reach it as well as the master-clock fan-out.
    const scaled = lowerer.lowerLoaderAdapter({
        animationSpeedRatio: true,
        managedGroups: true,
    });
    assert.match(scaled.source, /asset\.set_clip_speed_ratio =/);
    assert.match(
        scaled.source,
        /clip\.time \+= delta_ms \* 0\.001f \* clip\.speed_ratio/,
    );
    // The seek mirrors the browser harness, which pins a pose by writing the
    // group's own currentTime -- no ratio scales that.
    assert.match(
        scaled.source,
        /const float raw = seek\s*\?\s*animation_runtime->time/,
    );
});

test("the weighted mixer walks each clip's own recorded track range", () => {
    const lowerer = new GltfLowerer(new LoweringContext());
    const blended = lowerer.lowerLoaderAdapter({
        animationBlending: true,
    });
    // The loader records each clip's contiguous [first, last) run beside
    // the track vectors, filled where it appends: first before the
    // channel loop, last after, pushed once per clip in clip order.
    assert.match(
        blended.source,
        /std::vector<ClipTrackRanges> clip_track_ranges;/,
    );
    assert.match(
        blended.source,
        /clip_track_range\.rotation\.first =\s*animation_runtime->rotation_tracks\.size\(\);/,
    );
    assert.match(
        blended.source,
        /clip_track_range\.scale\.last =\s*animation_runtime->scale_tracks\.size\(\);/,
    );
    assert.match(
        blended.source,
        /clip_track_ranges\.push_back\(\s*clip_track_range\);/,
    );
    // The mixer iterates only the clip's own run instead of rejecting
    // every other clip's tracks once per blended clip...
    assert.match(
        blended.source,
        /clip_range\.rotation\.first;\s*track_index < clip_range\.rotation\.last;/,
    );
    assert.match(
        blended.source,
        /const TrackRange& range,/,
    );
    assert.match(
        blended.source,
        /clip_range\.translation,\s*&AnimatedNode::translation/,
    );
    assert.match(
        blended.source,
        /clip_range\.scale,\s*&AnimatedNode::scale/,
    );
    // ...and keeps the track.clip rejection inside the narrowed walks, so
    // correctness never depends on the grouping (rotation walk plus the
    // shared translation/scale lambda).
    const rejects = blended.source.match(
        /track\.clip != entry\.clip/g,
    );
    assert.ok(
        rejects !== null && rejects.length >= 2,
        "the clip test stays inside the narrowed walks",
    );
    // Without blending there is no mixer, so none of the bookkeeping is
    // emitted -- untouched scenes stay byte-identical.
    const plain = lowerer.lowerLoaderAdapter();
    assert.doesNotMatch(plain.source, /ClipTrackRanges/);
    assert.doesNotMatch(plain.source, /clip_track_range/);
});
