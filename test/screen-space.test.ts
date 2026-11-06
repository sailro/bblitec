import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import {
    ScreenSpaceLowerer,
    screenSpaceShadersHeader,
} from "../src/lowering/screen-space-lowerer.js";
import {
    composeScreenSpaceTask,
    type ComposedScreenSpaceStagePass,
    type ComposedScreenSpaceTask,
    type ScreenSpaceTextureRef,
} from "../src/pinned-screen-space.js";

/** The demo's own settings for its three tasks. */
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
const AO_OPTIONS = {
    resolutionScale: 0.5,
    intensity: 0.8,
    radius: 0.55,
    bias: 0.05,
    power: 1.5,
    sliceCount: 3,
    stepCount: 4,
    fadeStart: 15,
    fadeEnd: 35,
    temporalWeight: 1 / 32,
    temporalSamples: 64,
};

/**
 * The three pinned screen-space factories, run under the recording device
 * the way generation runs them, with the demo's own settings.
 */
async function composeAll(): Promise<{
    contact: ComposedScreenSpaceTask;
    gi: ComposedScreenSpaceTask;
    ao: ComposedScreenSpaceTask;
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
    const ao = await composeScreenSpaceTask({
        intrinsic: "createScreenSpaceAmbientOcclusionPostProcessTask",
        options: AO_OPTIONS,
        hasTarget: true,
        hasDepthTexture: true,
    });
    return { contact, gi, ao };
}

/** A texture reference as `role` or `role#index` for an intermediate. */
function ref(texture: ScreenSpaceTextureRef | undefined): string {
    if (!texture) return "-";
    return texture.role === "intermediate"
        ? `intermediate#${texture.index}`
        : texture.role;
}

/** One pass as `label -> target`, then each binding's name and what it reads. */
function describe(pass: ComposedScreenSpaceStagePass): string[] {
    return [
        `${pass.label} -> ${ref(pass.target)}`,
        ...pass.stage.bindings.map(
            (binding, index) =>
                `${binding.name}:${binding.kind}:${ref(pass.textures[index])}`,
        ),
    ];
}

test("running the pinned factories records the documented pipeline configuration", async () => {
    const { contact, gi } = await composeAll();
    // The architecture page's tables: producer targets and history formats,
    // each the format composition checked the pipeline draws into.
    assert.deepEqual(contact.intermediates, ["r8unorm"]);
    assert.equal(contact.passes.at(-1)!.stage.targetFormat, "rg16float");
    assert.deepEqual(gi.intermediates, ["rgba16float"]);
    assert.equal(gi.passes.at(-1)!.stage.targetFormat, "rgba16float");
    // The two producers bind the depth attachment through a depth-only
    // view; only the GI producer also samples the lit source colour.
    assert.deepEqual(describe(contact.passes[0]!), [
        "producer -> intermediate#0",
        "ssDepth:depth-texture:depth",
        "ssContact:uniform:-",
    ]);
    assert.deepEqual(describe(gi.passes[0]!), [
        "producer -> intermediate#0",
        "ssGiDepth:depth-texture:depth",
        "ssGiColorSampler:sampler:-",
        "ssGiColor:texture:source-color",
        "ssGi:uniform:-",
    ]);
    // The shared temporal resolve: sampler, depth, raw, history, block. The
    // pass order of an enabled and a disabled frame is asserted inside
    // composition against what the backends encode.
    for (const task of [contact, gi]) {
        assert.deepEqual(
            task.passes.map((pass) => pass.label),
            ["producer", "resolve"],
        );
        assert.deepEqual(describe(task.passes[1]!), [
            "resolve -> stable",
            "ssLinearSampler:sampler:-",
            "ssCurrentDepth:depth-texture:depth",
            "ssRawTex:texture:intermediate#0",
            "ssHistoryTex:texture:history",
            "ssTemporal:uniform:-",
        ]);
        assert.equal(task.passes[0]!.stage.uniformBytes, 192);
        assert.equal(task.passes[1]!.stage.uniformBytes, 288);
        assert.equal(task.historyCopy.sampling, "nearest");
        assert.equal(task.composite?.sampling, "linear");
        assert.deepEqual(task.composite?.extraTextures.map(ref), ["stable"]);
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

test("ambient occlusion composes a producer, two blur passes over one pipeline and the scalar resolve", async () => {
    const { contact, ao } = await composeAll();
    // The pin's own pass order and the three r8unorm targets it owns
    // between them, numbered as each pass first draws into one.
    assert.deepEqual(
        ao.passes.map((pass) => pass.label),
        ["producer", "blur-horizontal", "blur-vertical", "resolve"],
    );
    assert.deepEqual(ao.intermediates, ["r8unorm", "r8unorm", "r8unorm"]);
    assert.deepEqual(describe(ao.passes[0]!), [
        "producer -> intermediate#0",
        "ssAoDepth:depth-texture:depth",
        "ssAo:uniform:-",
    ]);
    // One blur pipeline, two bind groups: the horizontal pass reads the raw
    // occlusion, the vertical one the horizontal result.
    assert.equal(ao.passes[1]!.stage, ao.passes[2]!.stage);
    assert.deepEqual(describe(ao.passes[1]!), [
        "blur-horizontal -> intermediate#1",
        "ssAoBlurDepth:depth-texture:depth",
        "ssAoInput:texture:intermediate#0",
        "ssAoBlur:uniform:-",
    ]);
    assert.deepEqual(describe(ao.passes[2]!).slice(0, 3), [
        "blur-vertical -> intermediate#2",
        "ssAoBlurDepth:depth-texture:depth",
        "ssAoInput:texture:intermediate#1",
    ]);
    // The resolve temporally accumulates the vertical blur, through the
    // scalar owner contact shadows use.
    assert.equal(ao.kind, "scalar");
    assert.equal(ao.passes[3]!.stage.wgsl, contact.passes[1]!.stage.wgsl);
    assert.equal(
        ref(ao.passes[3]!.textures[2]),
        "intermediate#2",
        "the resolve's raw input is the vertical blur target",
    );
    assert.deepEqual(
        ao.passes.map((pass) => pass.stage.uniformBytes),
        [176, 160, 160, 288],
    );
    assert.deepEqual(ao.composite?.extraTextures.map(ref), ["stable"]);
    assert.equal(ao.composite?.sampling, "linear");
    // The clamped settings the task publishes and keeps in params.
    assert.deepEqual(ao.settings, {
        intensity: 0.8,
        radius: 0.55,
        bias: 0.05,
        power: 1.5,
        sliceCount: 3,
        stepCount: 4,
        fadeStart: 15,
        fadeEnd: 35,
        temporalWeight: 1 / 32,
        resetVersion: 0,
    });
    assert.deepEqual(ao.clamped, { resolutionScale: 0.5, temporalSamples: 64 });
});

test("a composition of 'none' builds no composite and publishes the stable target", async () => {
    for (const intrinsic of [
        "createScreenSpaceContactShadowsPostProcessTask",
        "createScreenSpaceAmbientOcclusionPostProcessTask",
    ]) {
        const task = await composeScreenSpaceTask({
            intrinsic,
            options: { composition: "none" },
            hasTarget: false,
            hasDepthTexture: false,
        });
        assert.equal(task.composite, null);
        assert.equal(task.historyCopy.clear, true);
    }
});

/** The three demo tasks as generation hands them to the lowerer. */
function lowererOf(
    contact: ComposedScreenSpaceTask,
    gi: ComposedScreenSpaceTask,
    ao: ComposedScreenSpaceTask,
): ScreenSpaceLowerer {
    return new ScreenSpaceLowerer(new LoweringContext(), [
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
            plan: 0,
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
            plan: 1,
            historyCopyShader: 5,
            compositeShader: 6,
        },
        {
            manifest: {
                taskIndex: 2,
                intrinsic: ao.intrinsic,
                name: "ao",
                options: AO_OPTIONS,
                hasTarget: true,
                hasDepthTexture: true,
            },
            composed: ao,
            plan: 2,
            historyCopyShader: 7,
            compositeShader: 8,
        },
    ]);
}

test("the lowerer translates the temporal state machine and every uniform block from the pinned bodies", async () => {
    const { contact, gi, ao } = await composeAll();
    const lowerer = lowererOf(contact, gi, ao);
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
    // Every reached block fits the decision's rows: ambient occlusion
    // encodes four passes, the temporal resolve uploads the largest block.
    assert.match(source, /screen_space_max_passes >= 4u/);
    assert.match(source, /screen_space_max_block_floats >= 72u/);
    // The reset matrix: camera motion is not an invalidation event.
    assert.ok(
        source.includes(
            "(ev.enabled_transitioned_on)) || (ev.singular_inverse)",
        ),
    );
    assert.ok(!source.includes("ev.camera_moved ||"));
    // Every frame function: the disabled transition clears once, the
    // singular inverse clears too, and each packs its blocks from the
    // clamped live settings.
    for (const frame of [
        "contact_shadows_frame",
        "global_illumination_frame",
        "ambient_occlusion_frame",
    ]) {
        assert.ok(source.includes(`ScreenSpaceFrameDecision ${frame}(`));
    }
    assert.match(
        source,
        /if \(state\.last_enabled\) \{\s*decision\.clear_identity = true;/,
    );
    assert.match(
        source,
        /auto&& (pinned_\w+) = bbl::js::hypot_js\(\{light_direction.x, light_direction.y, light_direction.z\}\); return bbl::js::number_truthy\(static_cast<double>\(\1\)\) \? static_cast<double>\(\1\) : static_cast<double>\(1.0\);/,
    );
    assert.ok(
        source.includes(
            "decision.stage_uniforms[0][static_cast<std::size_t>(47.0)] = static_cast<float>(phase);",
        ),
    );
    assert.ok(
        source.includes(
            "decision.stage_uniforms[0][static_cast<std::size_t>(43.0)] = static_cast<float>(rayCount);",
        ),
    );
    // The temporal block: previous matrices saved after the resolve, and
    // the GI task's absent spatial inputs taking the pin's own defaults.
    assert.ok(
        source.includes(
            "pack_mat4_into_f32(decision.stage_uniforms[1].data(), state.prev_view_proj, 32.0);",
        ),
    );
    assert.ok(
        source.includes(
            "pack_mat4_into_f32(state.prev_view_proj.data(), viewProj, 0.0);",
        ),
    );
    assert.ok(
        source.includes(
            "decision.stage_uniforms[1][static_cast<std::size_t>(69.0)] = static_cast<float>(0.0);",
        ),
    );
    // The composite writer reads the task's live fields through the pass
    // parameters in the writer's own reading order, and the frame function
    // marks the block dirty only when a slot moved.
    const writers = lowerer.compositeWriters();
    assert.deepEqual([...writers.keys()], [4, 6, 8]);
    assert.ok(writers.get(4)!.includes("task.params[1] != 0.0"));
    assert.ok(source.includes("write(4u, task.tint[2]);"));
    assert.ok(source.includes("write(3u, task.color_bleed_max);"));
    assert.ok(source.includes("pass.uniforms_dirty = true;"));
    // Each task's factory bakes what the pin clamped and names its plan.
    assert.ok(source.includes("options.step_count = 12.0;"));
    assert.ok(source.includes("options.resolution_scale = 0.75;"));
    assert.ok(source.includes("composite.shader_index = 6u;"));
    assert.ok(header.includes("TaskHandle create_screen_space_task_2("));
});

test("the ambient-occlusion frame fills its producer, both blur blocks and the resolve in pass order", async () => {
    const { contact, gi, ao } = await composeAll();
    const { source } = lowererOf(contact, gi, ao).lowerTaskRecords();
    const start = source.indexOf(
        "ScreenSpaceFrameDecision ambient_occlusion_frame(",
    );
    assert.ok(start >= 0);
    const frame = source.slice(start, source.indexOf("\n}\n", start));
    // The viewport refusal runs first, as the pin's execute does.
    assert.match(
        frame,
        /ambient_occlusion_assert_fullscreen_viewport\(camera, task\.name\);\s*if \(!\(task\.enabled\)\)/,
    );
    // The producer block, from the live clamped settings.
    for (const line of [
        "const double sliceCount = bbl::js::round_js(screen_space_clamp(task.slice_count, 1.0, 8.0));",
        "decision.stage_uniforms[0][static_cast<std::size_t>(36.0)] = static_cast<float>(radius);",
        "decision.stage_uniforms[0][static_cast<std::size_t>(38.0)] = static_cast<float>(screen_space_clamp(task.power, 0.1, 8.0));",
        "decision.stage_uniforms[0][static_cast<std::size_t>(43.0)] = static_cast<float>(phase);",
    ]) {
        assert.ok(frame.includes(line), `expected ${line}`);
    }
    // The pin's one `blurUniforms` helper, written out for each block with
    // that pass's direction and the shared depth sigma.
    for (const [row, x, y] of [
        [1, "1.0", "0.0"],
        [2, "0.0", "1.0"],
    ] as const) {
        assert.ok(
            frame.includes(
                `decision.stage_uniforms[${row}][static_cast<std::size_t>(36.0)] = static_cast<float>(${x});`,
            ),
        );
        assert.ok(
            frame.includes(
                `decision.stage_uniforms[${row}][static_cast<std::size_t>(37.0)] = static_cast<float>(${y});`,
            ),
        );
        assert.ok(
            frame.includes(
                `decision.stage_uniforms[${row}][static_cast<std::size_t>(38.0)] = static_cast<float>(0.02);`,
            ),
        );
    }
    // The resolve's block is the last row, its spatial radius the call's 0.
    assert.ok(
        frame.includes(
            "pack_mat4_into_f32(decision.stage_uniforms[3].data(), state.prev_view, 48.0);",
        ),
    );
    assert.ok(frame.includes("const double resolve_spatialRadius = 0.0;"));
    // Camera motion keeps history here too, and the producer's position
    // read is absent, so the camera world matrix is not composed.
    assert.ok(!frame.includes("camera_world"));
    assert.ok(!frame.includes("camera_moved"));
    // The task factory names its plan, its three intermediates and the
    // refusal at creation.
    const factory = source.slice(
        source.indexOf("TaskHandle create_screen_space_task_2("),
    );
    for (const line of [
        "options.kind = ScreenSpaceEffectKind::ambient_occlusion;",
        "options.slice_count = 3.0;",
        "options.radius = 0.55;",
        "options.plan = 2u;",
        "plan.intermediate_formats = {TextureFormatClass::r8_unorm, TextureFormatClass::r8_unorm, TextureFormatClass::r8_unorm};",
        "plan.stable_format = TextureFormatClass::rg16_float;",
        "upstream::ambient_occlusion_assert_fullscreen_viewport(bbl::handle_at(engine.cameras, camera), options.name);",
    ]) {
        assert.ok(factory.includes(line), `expected ${line}`);
    }
});

test("the stage table carries each deployed stage, and each plan its passes over it", async () => {
    const { contact, ao } = await composeAll();
    const stages = [
        contact.passes[0]!.stage,
        contact.passes[1]!.stage,
        ao.passes[0]!.stage,
        ao.passes[1]!.stage,
    ].map((stage, index) => ({ stem: `screenspace-${index}`, ...stage }));
    const module = screenSpaceShadersHeader("test", stages, [
        {
            passes: ao.passes.map((pass) => ({
                stage: [0, 1, 2, 3].find(
                    (index) =>
                        stages[index]!.wgsl === pass.stage.wgsl &&
                        stages[index]!.fragmentEntry ===
                            pass.stage.fragmentEntry,
                )!,
                target: pass.target,
                textures: pass.textures,
            })),
            intermediateCount: ao.intermediates.length,
        },
    ]);
    const header = module.header + module.definitions;
    assert.ok(
        header.includes(
            'ScreenSpaceShaderInfo{"screenspace-0", "ssContactVertex", "ssContactFragment", 192u, TextureFormatClass::r8_unorm, screen_space_bindings_0.data(), screen_space_bindings_0.size()}',
        ),
    );
    assert.ok(
        header.includes(
            'ScreenSpaceStageBinding{0u, "ssDepth", ScreenSpaceBindingKind::depth_texture}',
        ),
    );
    // Both blur passes draw the one blur stage into their own target.
    assert.ok(
        header.includes(
            "ScreenSpacePassInfo{3u, ScreenSpaceTextureRef{ScreenSpaceTextureRole::intermediate, 1u}, screen_space_textures_0_1.data()}",
        ),
    );
    assert.ok(
        header.includes(
            "ScreenSpacePassInfo{3u, ScreenSpaceTextureRef{ScreenSpaceTextureRole::intermediate, 2u}, screen_space_textures_0_2.data()}",
        ),
    );
    assert.ok(
        header.includes(
            "ScreenSpacePassInfo{1u, ScreenSpaceTextureRef{ScreenSpaceTextureRole::stable, 0u}, screen_space_textures_0_3.data()}",
        ),
    );
    assert.ok(
        header.includes(
            "ScreenSpacePlanInfo{screen_space_passes_0.data(), screen_space_passes_0.size(), 3u}",
        ),
    );
});
