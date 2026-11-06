import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { materialPluginListKey } from "../src/pinned-material-plugins.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    composeSsaoTask,
    ssaoPbrPluginManifest,
    type SsaoModePlan,
} from "../src/pinned-ssao.js";

/** Scene 348's own settings: medium quality, temporal, half resolution. */
const SCENE_OPTIONS = { radius: 0.3, quality: "medium" };

function frameLabels(mode: SsaoModePlan, index: 0 | 1): string[] {
    return mode.frames[index].map(
        (pass) => pass.label + (pass.repeat ? "*" : ""),
    );
}

test("the pinned factory composes each working mode the task reaches, in its encoding order", async () => {
    const task = await composeSsaoTask({
        options: SCENE_OPTIONS,
        normalFormat: "rgba16float",
        initialNormal: true,
        halfResolution: true,
    });
    assert.deepEqual(task.settings, {
        quality: "medium",
        radius: 0.3,
        intensity: 1,
        temporalEnabled: true,
        historySamples: 16,
    });
    assert.deepEqual(
        task.modes.map((mode) => mode.resolution),
        ["full", "half"],
    );
    const [full, half] = task.modes as [SsaoModePlan, SsaoModePlan];
    // Depth preparation, the reduction run over the depth chain, the
    // estimator and the spatial resolve, then the temporal reconstruction.
    const resolve = [
        "ssao*",
        "ssao",
        "ssao",
        "ssao-xegtao-temporal",
        "ssao-xegtao-convolution*",
        "ssao-xegtao-history-repair",
        "ssao-xegtao-output",
    ];
    assert.deepEqual(frameLabels(full, 0), ["ssao", ...resolve]);
    assert.deepEqual(frameLabels(full, 1), frameLabels(full, 0));
    assert.deepEqual(frameLabels(half, 0), [
        "ssao-half-pipeline-prepare",
        ...resolve,
        "ssao-half-pipeline-upsample",
    ]);
    assert.deepEqual(
        full.disabled.map((pass) => pass.stage),
        ["clear"],
    );
    // The full-resolution output is the visibility; the adapter's is its
    // own upsample, at the source extent, over a half-extent working set.
    const textures = task.textures;
    assert.equal(textures[full.output]!.label, "ssao-visibility");
    assert.equal(textures[full.output]!.extent, "source");
    assert.equal(textures[half.output]!.label, "ssao-half-pipeline-output");
    assert.equal(textures[half.output]!.extent, "source");
    assert.equal(
        half.textures
            .map((index) => textures[index]!)
            .find((texture) => texture.label === "ssao-depth")!.extent,
        "half",
    );
    assert.equal(full.samplingFootprint, undefined);
    assert.equal(half.samplingFootprint, 1);
    // A repeated pass runs over the levels of an owned mip chain.
    for (const mode of task.modes)
        for (const pass of mode.frames[0])
            if (pass.repeat)
                assert.equal(textures[pass.repeat.texture]!.chain, true);
});

test("each dispatch names the storage view its workgroups cover, and estimators carry their constants by name", async () => {
    const task = await composeSsaoTask({
        options: SCENE_OPTIONS,
        normalFormat: "rgba16float",
        initialNormal: true,
        halfResolution: false,
    });
    for (const mode of task.modes)
        for (const pass of [...mode.frames[0], ...mode.frames[1]]) {
            if (pass.stage !== "compute") continue;
            const program = task.programs[pass.program!]!;
            assert.equal(program.stage, "compute");
            assert.deepEqual(program.workgroup, [8, 8]);
            assert.notEqual(pass.domain, undefined, pass.label);
            assert.equal(pass.resources[pass.domain!]!.kind, "view");
            assert.equal(program.layout[pass.domain!]!.kind, "storage-texture");
        }
    const estimator = task.programs.find((program) =>
        program.constants.some((constant) => constant.name === "SLICE_COUNT"),
    );
    assert.ok(estimator, "the estimator is specialised by override constants");
    assert.deepEqual(
        Object.fromEntries(
            estimator.constants.map((constant) => [
                constant.name,
                constant.value,
            ]),
        ),
        {
            PROVIDED_NORMALS: 1,
            SLICE_COUNT: 2,
            STEP_COUNT: 2,
            WORLD_NORMALS: 0,
        },
    );
});

test("enablePbrSsao's plugin is the pin's own: IBL passes only, one non-filtering visibility texture", async () => {
    const plugin = ssaoPbrPluginManifest();
    assert.equal(ssaoPbrPluginManifest(), plugin, "the enabler runs once");
    assert.equal(plugin.name, "ssao-diffuse-ibl");
    assert.equal(plugin.pbrIblOnly, true);
    assert.equal(plugin.vertex, undefined);
    assert.deepEqual(plugin.samplers, [
        {
            texture: "ssaoVisibilityTexture",
            sampler: "ssaoVisibilitySampler",
            samplerType: "sampler_non_filtering",
        },
    ]);
    const begin = plugin.fragment?.["CUSTOM_FRAGMENT_MAIN_BEGIN"] ?? "";
    assert.match(
        begin,
        /let ssaoDiffuseVisibility=textureSampleLevel\(ssaoVisibilityTexture,ssaoVisibilitySampler,ssaoUv,0\)\.r;/,
    );
    // The pin's signature reads no internal member, so the plugin keys
    // like any other plugin carrying the same declarations.
    assert.equal(
        materialPluginListKey([plugin]),
        materialPluginListKey([
            {
                name: plugin.name,
                fragment: plugin.fragment!,
                samplers: plugin.samplers,
            },
        ]),
    );
    // Running the enabler installs what composition then reads: the
    // diffuse-occlusion modifier and the IBL-pass plugin decorator.
    const occlusion = await importPinnedModule<{
        pbrDiffuseOcclusion: unknown;
    }>("material/pbr/pbr-diffuse-occlusion.js");
    assert.equal(typeof occlusion.pbrDiffuseOcclusion, "function");
    const decorator = await importPinnedModule<{
        pbrPluginDecorator: unknown;
    }>("material/plugin/pbr-plugin-decorator.js");
    assert.equal(typeof decorator.pbrPluginDecorator, "function");
});

test("a geometry format restating the attachment's pinned default is automatic, and another refuses by name", () => {
    const geometry = (format: string): string => `
        import { createEngine, createSceneContext, createGeometryRendererTask,
            GeometryTextureType, addTask } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine, {defaultRenderTask: false});
        addTask(scene, createGeometryRendererTask({name: "velocity", samples: 1,
            textureDescriptions: [{type: GeometryTextureType.LINEAR_VELOCITY,
                format: "${format}"}]}, engine, scene));
    `;
    const restated = compileSource(geometry("rgba16float"));
    assert.match(restated.cpp, /GeometryTextureFormat::automatic/);
    assert.throws(
        () => compileSource(geometry("rg32float")),
        /Unsupported geometry texture format override 'rg32float'/,
    );
});

test("PBR metallic and roughness factors written on a held material are its record's", () => {
    const result = compileSource(`
        import { createEngine, createPbrMaterial } from "@babylonjs/lite";
        const engine = await createEngine({});
        const material = createPbrMaterial();
        material.metallicFactor = 0;
        material.roughnessFactor = 0.85;
    `);
    assert.match(result.cpp, /\.metallic_factor = /);
    assert.match(result.cpp, /\.roughness_factor = /);
});

test("velocity, motion pruning and live settings compose every reachable mode, each kept by key", async () => {
    const task = await composeSsaoTask({
        options: { radius: 0.6 },
        normalFormat: "rgba16float",
        initialNormal: true,
        halfResolution: true,
        velocity: { format: "rgba16float", previousDepth: true },
        motionPruning: true,
        live: ["quality", "normal", "temporal", "pruning"],
    });
    // Two resolutions, four presets, two normal inputs, and temporal
    // reconstruction with and without pruning, or spatial-only frames.
    assert.equal(task.modes.length, 2 * 4 * 2 * 3);
    assert.equal(
        new Set(
            task.modes.map((mode) =>
                JSON.stringify([mode.resolution, mode.key]),
            ),
        ).size,
        task.modes.length,
    );
    assert.equal(task.velocityFormat, "rgba16float");
    const pruned = task.modes.find(
        (mode) =>
            mode.resolution === "half" &&
            mode.key.quality === "high" &&
            mode.key.normal &&
            mode.key.pruning,
    )!;
    const labels = pruned.frames[0].map(
        (pass) => `${pass.label}:${pass.stage}`,
    );
    assert.deepEqual(labels.slice(4, 8), [
        "ssao-object-motion-mask:clear-buffer",
        "ssao-transport-draw:clear-buffer",
        "ssao-object-motion-mask:compute",
        "ssao-occlusion-history-transport:render",
    ]);
    const [, , , , cells, draw, mask, transport] = pruned.frames[0];
    assert.deepEqual(task.buffers[cells!.buffer!]!.size, {
        kind: "motion-cells",
    });
    assert.deepEqual(task.buffers[draw!.buffer!]!.size, {
        kind: "fixed",
        bytes: 16,
    });
    // The mask dispatch writes buffers alone and covers the working extent;
    // the transport draws its arguments from the mask's buffer.
    assert.equal(mask!.domain, undefined);
    assert.equal(transport!.buffer, draw!.buffer);
    // The estimator and resolve share the pinned `ssao` compute pass.
    assert.deepEqual(
        pruned.frames[0].slice(1, 4).map((pass) => pass.continues === true),
        [false, true, true],
    );
    // A pruning switch keeps every texture: the pin keeps its history.
    const plain = task.modes.find(
        (mode) =>
            mode.resolution === "half" &&
            JSON.stringify(mode.key) ===
                JSON.stringify({ ...pruned.key, pruning: false }),
    )!;
    assert.deepEqual(plain.textures, pruned.textures);
    assert.equal(
        plain.frames[0].some((pass) => pass.stage === "clear-buffer"),
        false,
    );
});

test("SSAO live settings, the velocity input and live builds compile to the task's records", () => {
    const result = compileSource(`
        import { addTask, buildFrameGraphTask, createArcRotateCamera, createCopyToTextureTask,
            createEngine, createGeometryRendererTask, createSceneContext, createSsaoTask,
            enableSsaoHalfResolution, enableSsaoMotionPruning, getFrameGraph,
            GeometryTextureType } from "@babylonjs/lite";
        import type { SsaoQuality } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const camera = createArcRotateCamera(0, 1, 4, { x: 0, y: 0, z: 0 });
        scene.camera = camera;
        const geometry = createGeometryRendererTask({ name: "g", samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL },
                { type: GeometryTextureType.LINEAR_VELOCITY }] }, engine, scene);
        const flags = { normals: Math.random() > 0.5, samples: Math.random() * 16 };
        const ao = createSsaoTask({ depthTexture: geometry.geometryDepthTexture,
            normalTexture: flags.normals ? geometry.geometryViewNormalTexture! : undefined,
            camera, temporal: { velocityTexture: geometry.geometryLinearVelocityTexture!,
                velocityHasPreviousDepth: true, historySamples: Math.ceil(flags.samples) } },
            engine, scene);
        enableSsaoHalfResolution(ao);
        const pruning = enableSsaoMotionPruning(ao);
        const copy = createCopyToTextureTask({ name: "c", sourceTexture: ao.outputTexture,
            targetTexture: engine.scRT }, engine, scene);
        addTask(scene, geometry);
        addTask(scene, ao);
        addTask(scene, copy);
        pruning.enabled = flags.normals;
        const temporal = ao.temporal;
        temporal.enabled = !flags.normals;
        ao.quality = (flags.normals ? "low" : "ultra") as SsaoQuality;
        ao.normalTexture = flags.normals ? null : geometry.geometryViewNormalTexture!;
        for (const name of ["radius", "intensity"] as const) {
            ao[name] = flags.samples / 16;
        }
        buildFrameGraphTask(getFrameGraph(scene), ao);
        buildFrameGraphTask(getFrameGraph(scene), copy);
    `);
    const [task] = result.manifest.ssaoTasks;
    assert.equal(task!.motionPruning, true);
    assert.deepEqual(task!.velocity, {
        attachment: "LINEAR_VELOCITY",
        previousDepth: true,
    });
    assert.deepEqual(task!.live, ["quality", "normal", "temporal", "pruning"]);
    // The runtime history limit is the factory's argument.
    assert.match(
        result.cpp,
        /create_ssao_task_0\([^;]*std::ceil|create_ssao_task_0\([^;]*ceil/,
    );
    assert.match(result.cpp, /enable_ssao_motion_pruning\(/);
    assert.match(
        result.cpp,
        /ssao_motion_pruning_settings\([^;]*\)\.enabled = /,
    );
    assert.match(result.cpp, /\.ssao\.quality = /);
    assert.match(result.cpp, /\.ssao\.normal = /);
    assert.match(result.cpp, /== "radius"\) \{/);
    assert.match(result.cpp, /== "intensity"\) \{/);
    assert.match(result.cpp, /build_frame_graph_task\(/);
});
