import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import {
    ScreenSpaceLowerer,
    screenSpaceShadersHeader,
} from "../src/lowering/screen-space-lowerer.js";
import {
    composeScreenSpaceTask,
    type ComposedScreenSpaceTask,
} from "../src/pinned-screen-space.js";

/** The demo's own settings for its two tasks. */
const CONTACT_OPTIONS = {
    stepCount: 12,
    maxDistance: 0.32,
    tint: [0.08, 0.1, 0.16],
    temporalWeight: 1 / 64,
    temporalSamples: 64,
    spatialRadius: 0.75,
};
const GI_OPTIONS = {
    composition: "color-bleed",
    resolutionScale: 0.75,
    rayCount: 4,
    temporalSamples: 64,
};

/**
 * The two pinned screen-space factories, run under the recording device the
 * way generation runs them, with the demo's own settings.
 */
async function composeBoth(): Promise<{
    contact: ComposedScreenSpaceTask;
    gi: ComposedScreenSpaceTask;
}> {
    const contact = await composeScreenSpaceTask({
        intrinsic: "createScreenSpaceContactShadowsPostProcessTask",
        options: CONTACT_OPTIONS,
        hasTarget: false,
        hasDepthTexture: false,
    });
    const gi = await composeScreenSpaceTask({
        intrinsic: "createScreenSpaceGlobalIlluminationPostProcessTask",
        options: GI_OPTIONS,
        hasTarget: true,
        hasDepthTexture: true,
    });
    return { contact, gi };
}

test("running the pinned factories records the documented pipeline configuration", async () => {
    const { contact, gi } = await composeBoth();
    // The architecture page's tables: producer targets and history formats,
    // each the format composition checked the pipeline draws into.
    assert.equal(contact.producer.targetFormat, "r8unorm");
    assert.equal(contact.resolve.targetFormat, "rg16float");
    assert.equal(gi.producer.targetFormat, "rgba16float");
    assert.equal(gi.resolve.targetFormat, "rgba16float");
    // The two producers bind the depth attachment through a depth-only
    // view; only the GI producer also samples the lit source colour.
    assert.deepEqual(
        contact.producer.bindings.map((binding) => `${binding.name}:${binding.kind}:${binding.role ?? "-"}`),
        ["ssDepth:depth-texture:depth", "ssContact:uniform:-"],
    );
    assert.deepEqual(
        gi.producer.bindings.map((binding) => `${binding.name}:${binding.kind}:${binding.role ?? "-"}`),
        [
            "ssGiDepth:depth-texture:depth",
            "ssGiColorSampler:sampler:-",
            "ssGiColor:texture:source-color",
            "ssGi:uniform:-",
        ],
    );
    // The shared temporal resolve: sampler, depth, raw, history, block. The
    // pass order of an enabled and a disabled frame is asserted inside
    // composition against what the backends encode.
    for (const task of [contact, gi]) {
        assert.deepEqual(
            task.resolve.bindings.map((binding) => binding.role ?? binding.kind),
            ["sampler", "depth", "raw", "history", "uniform"],
        );
        assert.equal(task.producer.uniformBytes, 192);
        assert.equal(task.resolve.uniformBytes, 288);
        assert.equal(task.historyCopy.sampling, "nearest");
        assert.equal(task.composite?.sampling, "linear");
        assert.deepEqual(task.composite?.extraTextures, ["stable"]);
    }
    // The settings the factory clamped and published, as the demo set them
    // and as the pin defaulted the rest.
    assert.equal(contact.settings.stepCount, 12);
    assert.equal(contact.settings.intensity, 0.6);
    assert.deepEqual(contact.settings.tint, [0.08, 0.1, 0.16]);
    assert.equal(contact.clamped.resolutionScale, 1);
    assert.equal(gi.clamped.resolutionScale, 0.75);
    assert.equal(gi.settings.rayCount, 4);
    assert.equal(gi.settings.fadeEnd, 60);
});

test("a composition of 'none' builds no composite and publishes the stable target", async () => {
    const task = await composeScreenSpaceTask({
        intrinsic: "createScreenSpaceContactShadowsPostProcessTask",
        options: { composition: "none" },
        hasTarget: false,
        hasDepthTexture: false,
    });
    assert.equal(task.composite, null);
    assert.equal(task.historyCopy.clear, true);
});

test("the lowerer translates the temporal state machine and both uniform blocks from the pinned bodies", async () => {
    const { contact, gi } = await composeBoth();
    const lowerer = new ScreenSpaceLowerer(new LoweringContext(), [
        {
            manifest: {
                taskIndex: 0,
                intrinsic: contact.intrinsic,
                name: "contact",
                options: CONTACT_OPTIONS,
                hasTarget: false,
                hasDepthTexture: false,
            },
            composed: contact,
            producerStage: 0,
            resolveStage: 1,
            historyCopyShader: 3,
            compositeShader: 4,
        },
        {
            manifest: {
                taskIndex: 1,
                intrinsic: gi.intrinsic,
                options: GI_OPTIONS,
                hasTarget: true,
                hasDepthTexture: true,
            },
            composed: gi,
            producerStage: 2,
            resolveStage: 3,
            historyCopyShader: 5,
            compositeShader: 6,
        },
    ]);
    const { source, header } = lowerer.lowerTaskRecords();
    // The pure helpers and the reset matrix, lowered whole.
    for (const symbol of [
        "double compute_temporal_weight(",
        "double advance_accumulation(",
        "double advance_phase_index(",
        "double phase_value(",
        "ScreenSpaceResetDecision decide_screen_space_reset(",
        "ScreenSpaceScaledSize screen_space_scaled_size(",
    ]) {
        assert.ok(source.includes(symbol), `expected ${symbol}`);
    }
    // The block sizes the pin's constants name meet the decision's arrays.
    assert.match(
        source,
        /sizeof\(ScreenSpaceFrameDecision::producer_uniforms\) == 192u/,
    );
    assert.match(
        source,
        /sizeof\(ScreenSpaceFrameDecision::temporal_uniforms\) == 288u/,
    );
    // The reset matrix: camera motion is not an invalidation event.
    assert.ok(source.includes("ev.enabled_transitioned_on) || ev.singular_inverse)"));
    assert.ok(!source.includes("ev.camera_moved ||"));
    // Both frame functions: the disabled transition clears once, the
    // singular inverse clears too, and each packs its block from the
    // clamped live settings.
    for (const frame of ["contact_shadows_frame", "global_illumination_frame"]) {
        assert.ok(source.includes(`ScreenSpaceFrameDecision ${frame}(`));
    }
    assert.match(
        source,
        /if \(state\.last_enabled\) \{\s*decision\.clear_identity = true;/,
    );
    assert.ok(source.includes("bbl::js::or_number(bbl::js::hypot_js({light_direction.x, light_direction.y, light_direction.z}), 1.0)"));
    assert.ok(source.includes("decision.producer_uniforms[static_cast<std::size_t>(47.0)] = static_cast<float>(phase);"));
    assert.ok(source.includes("decision.producer_uniforms[static_cast<std::size_t>(43.0)] = static_cast<float>(rayCount);"));
    // The temporal block: previous matrices saved after the resolve, and
    // the GI task's absent spatial inputs taking the pin's own defaults.
    assert.ok(source.includes("pack_mat4_into_f32(decision.temporal_uniforms.data(), state.prev_view_proj, 32.0);"));
    assert.ok(source.includes("pack_mat4_into_f32(state.prev_view_proj.data(), viewProj, 0.0);"));
    assert.ok(source.includes("decision.temporal_uniforms[static_cast<std::size_t>(69.0)] = static_cast<float>(0.0);"));
    // The composite writer reads the task's live fields through the pass
    // parameters in the writer's own reading order, and the frame function
    // marks the block dirty only when a slot moved.
    const writers = lowerer.compositeWriters();
    assert.deepEqual([...writers.keys()], [4, 6]);
    assert.ok(writers.get(4)!.includes("task.params[1] != 0.0"));
    assert.ok(source.includes("write(4u, task.tint[2]);"));
    assert.ok(source.includes("write(3u, task.color_bleed_max);"));
    assert.ok(source.includes("pass.uniforms_dirty = true;"));
    // Each task's factory bakes what the pin clamped and names its stages.
    assert.ok(source.includes("options.step_count = 12.0;"));
    assert.ok(source.includes("options.resolution_scale = 0.75;"));
    assert.ok(source.includes("composite.shader_index = 6u;"));
    assert.ok(header.includes("TaskHandle create_screen_space_task_1("));
});

test("the stage table carries each deployed stage's entry points, block and bindings", async () => {
    const { contact } = await composeBoth();
    const header = screenSpaceShadersHeader("test", [
        { stem: "screenspace-0", ...contact.producer },
    ]);
    assert.ok(header.includes('ScreenSpaceShaderInfo{"screenspace-0", "ssContactVertex", "ssContactFragment", 192u, TextureFormatClass::r8_unorm, screen_space_bindings_0.data(), screen_space_bindings_0.size()}'));
    assert.ok(header.includes('ScreenSpaceStageBinding{0u, "ssDepth", ScreenSpaceBindingKind::depth_texture, ScreenSpaceTextureRole::depth}'));
});
