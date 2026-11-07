import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { doctoredContext } from "./doctored-store.js";
import { floatLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedErrorCodeOf } from "../src/lowering/pinned-error.js";
import { GeometryVelocityLowerer } from "../src/lowering/geometry-velocity-lowerer.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { widestMeshUniformsFragment } from "../src/pinned-pbr-variant-cpp.js";
import { composePinnedPbrVariant } from "../src/pinned-pbr-variants.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { composePinnedStandardVariant } from "../src/pinned-standard-variants.js";
import type { GeometryVelocityState } from "../src/pinned-geometry-velocity.js";
import {
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/** The pin's coded error `owner` in `module` throws for `message`. */
function pinnedRefusal(module: string, owner: string, message: string): string {
    const context = new LoweringContext();
    return `#${pinnedErrorCodeOf(
        context,
        message,
        context.functionDeclaration(module, owner).declaration,
    )}`;
}
const MORPH_CONTEXT_REFUSAL = pinnedRefusal(
    "src/material/standard/standard-geometry-renderable.ts",
    "_ensureViewResources",
    "standard-geometry: morph targets require the scene Standard morph context",
);
const NOT_PRELOADED_REFUSAL = pinnedRefusal(
    "src/material/standard/standard-geometry-output-shader.ts",
    "createGeometryParamsFragment",
    "Standard geometry deformation velocity was not preloaded.",
);

const MSH_HAS_SKELETON = 2;
const MSH_HAS_MORPH_TARGETS = 8;

const material = (): Parameters<typeof composePinnedPbrVariant>[0] => ({
    baseColorFactor: [0.6, 0.6, 0.6, 1],
    metallicFactor: 0,
    roughnessFactor: 0.85,
});

const compose = (meshFeatures: number, velocity: boolean) =>
    composePinnedPbrVariant(material(), {
        meshFeatures,
        geometry: {
            attachments: ["VIEW_NORMAL", "LINEAR_VELOCITY"],
            emitColor: false,
            ...(velocity ? { velocity: true } : {}),
        },
    });

test("a velocity task's PBR views compose the pin's material-point velocity and nothing else does", async () => {
    const before = await compose(0, false);
    const plain = await compose(0, true);
    const skinned = await compose(MSH_HAS_SKELETON, true);
    const morphed = await compose(MSH_HAS_MORPH_TARGETS, true);
    for (const variant of [plain, skinned, morphed]) {
        assert.match(variant.vertexWgsl, /var<uniform> gm:gmUniforms/);
        assert.match(variant.vertexWgsl, /gm\.previousFromCurrent/);
        // Previous clip W rides velocity Z under the params block's flag.
        assert.match(
            variant.fragmentWgsl,
            /select\(0\.0,input\.vPreviousClip\.w,gp\.cameraNearFar\.z>0\.5\)/,
        );
    }
    assert.match(skinned.vertexWgsl, /var previousBoneSampler:texture_2d<f32>/);
    assert.doesNotMatch(plain.vertexWgsl, /previousBoneSampler|previousMorph/);
    assert.match(
        morphed.vertexWgsl,
        /var<storage, read> previousMorph:previousMorphUniforms/,
    );
    assert.equal(
        plain.meshBindingLayout.length,
        before.meshBindingLayout.length + 1,
    );
    // The hooks hold for the one call: a later ordinary view composes as before.
    const after = await compose(0, false);
    assert.equal(after.vertexWgsl, before.vertexWgsl);
    assert.equal(after.fragmentWgsl, before.fragmentWgsl);
    assert.doesNotMatch(before.vertexWgsl, /gmUniforms/);
});

const composeStandard = (
    meshFeatures: number,
    velocity?: GeometryVelocityState,
) =>
    composePinnedStandardVariant(
        {},
        {
            meshFeatures,
            skeleton: true,
            geometry: {
                attachments: ["VIEW_NORMAL", "LINEAR_VELOCITY"],
                emitColor: false,
                ...(velocity ? { velocity } : {}),
            },
        },
    );

test("a velocity program's Standard views compose the enabler's output and previous pose", async () => {
    const before = await composeStandard(0);
    const plain = await composeStandard(0, "enabler");
    const skinned = await composeStandard(MSH_HAS_SKELETON, "enabler");
    const morphed = await composeStandard(MSH_HAS_MORPH_TARGETS, "enabler");
    for (const variant of [plain, skinned, morphed]) {
        assert.match(variant.vertexWgsl, /mesh\.previousWorld/);
        assert.match(
            variant.fragmentWgsl,
            /select\(0\.0,input\.vPreviousClip\.w,gp\.cameraNearFar\.z>0\.5\)/,
        );
    }
    assert.doesNotMatch(before.fragmentWgsl, /gp\.cameraNearFar\.z/);
    assert.doesNotMatch(plain.vertexWgsl, /previousBoneSampler|previousMorph/);
    assert.match(skinned.vertexWgsl, /var previousBoneSampler:texture_2d<f32>/);
    assert.match(
        morphed.vertexWgsl,
        /var<storage, read> previousMorph:previousMorphUniforms/,
    );
    // The hooks hold for the one call.
    assert.deepEqual(await composeStandard(0), before);
});

test("a task preload's feature gives Standard views the previous pose and keeps their output", async () => {
    const skinned = await composeStandard(MSH_HAS_SKELETON, "preload");
    const morphed = await composeStandard(MSH_HAS_MORPH_TARGETS, "preload");
    assert.match(skinned.vertexWgsl, /var previousBoneSampler:texture_2d<f32>/);
    assert.match(
        morphed.vertexWgsl,
        /var<storage, read> previousMorph:previousMorphUniforms/,
    );
    for (const variant of [skinned, morphed])
        assert.doesNotMatch(variant.fragmentWgsl, /gp\.cameraNearFar\.z/);
    // Before any preload loaded it, a morphed view keeps the current-morph
    // arm and a skinned one throws as the pin's composer does.
    assert.doesNotMatch(
        (await composeStandard(MSH_HAS_MORPH_TARGETS)).vertexWgsl,
        /previousMorph/,
    );
    await assert.rejects(
        composeStandard(MSH_HAS_SKELETON),
        new RegExp(`${NOT_PRELOADED_REFUSAL}\\b`),
    );
});

test("the shared mesh mirror is the widest prefix-compatible MeshUniforms", () => {
    const fragment = (members: string): string =>
        `struct MeshUniforms { ${members} }; @fragment fn main() {}`;
    const base = fragment("world: mat4x4<f32>, lc: u32,");
    const velocity = fragment(
        "world: mat4x4<f32>, lc: u32, previousWorld: mat4x4<f32>, velocityEnabled: f32,",
    );
    assert.equal(widestMeshUniformsFragment([base, velocity, base]), velocity);
    assert.equal(widestMeshUniformsFragment([base, base]), base);
    assert.throws(
        () =>
            widestMeshUniformsFragment([
                velocity,
                fragment("world: mat4x4<f32>, other: u32,"),
            ]),
        /not a prefix/,
    );
});

function geometryProgram(
    descriptions: string,
    body: string,
): ReturnType<typeof compileSource> {
    return compileSource(`
        import { addTask, createArcRotateCamera, createEngine, createSceneContext, createGeometryRendererTask, enableGeometryVelocity, GeometryTextureType, registerScene, startEngine } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        scene.camera = createArcRotateCamera(0, 1, 4, { x: 0, y: 0, z: 0 });
        const geometry = createGeometryRendererTask({ textureDescriptions: [${descriptions}] }, engine, scene);
        addTask(scene, geometry);
        ${body}
        await startEngine(engine);
    `);
}

const VELOCITY = "{ type: GeometryTextureType.LINEAR_VELOCITY }";

test("the task preload's deformation load is lowered from the pin's", () => {
    const header = new GeometryVelocityLowerer(new LoweringContext()).header(
        true,
    );
    assert.match(header, /inline bool geometry_deformation_velocity_loaded/);
    assert.doesNotMatch(
        new GeometryVelocityLowerer(new LoweringContext()).header(),
        /geometry_deformation_velocity_loaded/,
    );
    for (const [module, needle, replacement] of [
        ["src/material/geometry-deformation-hooks.ts", "!mesh.vat && ", ""],
        [
            "src/material/standard/geometry-view.ts",
            "preloadGeometryDeformationVelocity(meshes, needsVelocity)",
            "preloadGeometryDeformationVelocity(meshes, true)",
        ],
        [
            "src/frame-graph/geometry-renderer-task.ts",
            "preloadStandardGeometryFeatures(meshes, task._needsVelocity)",
            "preloadStandardGeometryFeatures(meshes, true)",
        ],
        [
            "src/frame-graph/geometry-renderer-task.ts",
            "const meshes = (config.meshes ?? sc.meshes) as readonly Mesh[];",
            "const meshes = sc.meshes as readonly Mesh[];",
        ],
    ] as const) {
        assert.throws(
            () =>
                new GeometryVelocityLowerer(
                    doctoredContext(module, needle, replacement),
                ).header(true),
            /Expected|Geometry/,
            needle,
        );
    }
});

test("enableGeometryVelocity records its contract on the task", () => {
    const result = geometryProgram(
        VELOCITY,
        "enableGeometryVelocity(geometry, { previousDepth: true }); enableGeometryVelocity(geometry, { previousDepth: true }); await registerScene(scene);",
    );
    assert.ok(result.manifest.features.includes("renderer:geometry-velocity"));
    assert.deepEqual(result.manifest.geometryOutputTasks[0]?.velocity, {
        previousDepth: true,
    });
    assert.match(
        result.cpp,
        /bbl::upstream::enable_geometry_velocity\(v_engine, v_geometry, true\)/,
    );
});

test("enableGeometryVelocity refuses what the pin's enabler refuses", () => {
    assert.throws(
        () =>
            geometryProgram(
                "{ type: GeometryTextureType.VIEW_NORMAL }",
                "enableGeometryVelocity(geometry); await registerScene(scene);",
            ),
        /Geometry velocity requires a live LINEAR_VELOCITY attachment/,
    );
    assert.throws(
        () =>
            geometryProgram(
                '{ type: GeometryTextureType.LINEAR_VELOCITY, format: "r16float" }',
                "enableGeometryVelocity(geometry, { previousDepth: true }); await registerScene(scene);",
            ),
        /previous-depth velocity requires a floating-point RGBA velocity attachment/,
    );
    assert.throws(
        () =>
            geometryProgram(
                VELOCITY,
                "enableGeometryVelocity(geometry); enableGeometryVelocity(geometry, { previousDepth: true }); await registerScene(scene);",
            ),
        /already enabled with a different previous-depth contract/,
    );
    assert.throws(
        () =>
            geometryProgram(
                VELOCITY,
                "await registerScene(scene); enableGeometryVelocity(geometry);",
            ),
        /unconditional call before scene registration/,
    );
    assert.throws(
        () =>
            geometryProgram(
                VELOCITY,
                "enableGeometryVelocity(scene.camera as never); await registerScene(scene);",
            ),
        /requires a createGeometryRendererTask task/,
    );
});

interface PinnedVelocity {
    _update(worldChanged: boolean): void;
}
interface PinnedDeformation {
    _update(neutral: boolean): void;
}

/** A world matrix: a turn about Y by `angle`, a uniform `scale`, a translation. */
function world(angle: number, scale: number, x: number, y: number): number[] {
    const c = Math.cos(angle) * scale;
    const s = Math.sin(angle) * scale;
    return [c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, x, y, 0.5, 1];
}

/** The frames both runs take: the world the mesh block packs, whether it moved, visibility. */
const FRAMES: readonly { world: number[]; visible: boolean }[] = [
    { world: world(0.3, 1, 1, 2), visible: true },
    { world: world(0.3, 1, 1, 2), visible: true },
    { world: world(0.5, 1.2, 1.25, 2), visible: true },
    { world: world(0.5, 1.2, 1.25, 2), visible: true },
    { world: world(0.9, 0.7, -2, 1), visible: false },
    { world: world(0.9, 0.7, -2, 1), visible: true },
    { world: world(1.4, 2, 3, -1), visible: true },
    { world: world(1.4, 2, 3, -1), visible: true },
];
const POSES: readonly {
    bones: number[];
    weights: number[];
    neutral: boolean;
}[] = [0, 1, 2, 3, 4].map((frame) => ({
    bones: Array.from({ length: 32 }, (_, index) =>
        Math.fround(Math.sin(index * 0.37 + frame) * 3),
    ),
    weights: [Math.fround(frame * 0.21), Math.fround(1 - frame * 0.13)],
    neutral: frame === 0 || frame === 3,
}));

function bits(values: Iterable<number>): string {
    return [...values]
        .map((value) => {
            const view = new DataView(new ArrayBuffer(4));
            view.setFloat32(0, value, true);
            return view.getUint32(0, true).toString(16);
        })
        .join(",");
}

/** The pin's writes over FRAMES and POSES, through its own factories. */
async function pinnedWrites(): Promise<string[]> {
    const writes: string[] = [];
    const queue = {
        writeBuffer(
            _buffer: unknown,
            _offset: number,
            data: ArrayBufferLike | ArrayBufferView,
            offset = 0,
            size?: number,
        ) {
            const view = ArrayBuffer.isView(data)
                ? new Float32Array(
                      data.buffer,
                      data.byteOffset,
                      data.byteLength / 4,
                  )
                : new Float32Array(
                      data,
                      offset,
                      (size ?? data.byteLength - offset) / 4,
                  );
            writes.push(`buffer:${bits(view)}`);
        },
        writeTexture(_target: unknown, data: Float32Array) {
            writes.push(`texture:${bits(data)}`);
        },
    };
    const device = {
        queue,
        createBuffer: (descriptor: { size: number }) => ({
            size: descriptor.size,
            getMappedRange: () => new ArrayBuffer(descriptor.size),
            unmap() {},
            destroy() {},
        }),
        createTexture: () => ({ createView: () => ({}), destroy() {} }),
    };
    const engine = { _device: device };
    const velocity = await importPinnedModule<{
        createPbrGeometryVelocity: (
            engine: unknown,
            mesh: { visible: boolean },
            currentWorld: Float32Array,
            exclusions: undefined,
        ) => PinnedVelocity;
    }>("material/pbr/pbr-geometry-velocity.js");
    const current = new Float32Array(FRAMES[0]!.world);
    const mesh = { visible: true };
    const state = velocity.createPbrGeometryVelocity(
        engine,
        mesh,
        current,
        undefined,
    );
    for (const [index, frame] of FRAMES.entries()) {
        const changed =
            index > 0 && frame.world.join() !== FRAMES[index - 1]!.world.join();
        if (changed) current.set(frame.world);
        mesh.visible = frame.visible;
        state._update(changed);
    }
    const deformation = await importPinnedModule<{
        createGeometryDeformationVelocity: (
            engine: unknown,
            mesh: unknown,
        ) => PinnedDeformation;
    }>("material/geometry-deformation-velocity.js");
    const skeleton = {
        boneCount: 2,
        boneMatrices: new Float32Array(POSES[0]!.bones),
    };
    const morphTargets = {
        count: 2,
        weights: new Float32Array(POSES[0]!.weights),
    };
    const pose = deformation.createGeometryDeformationVelocity(engine, {
        skeleton,
        morphTargets,
    });
    for (const each of POSES) {
        skeleton.boneMatrices.set(each.bones);
        morphTargets.weights.set(each.weights);
        pose._update(each.neutral);
    }
    return writes;
}

const floats = (values: readonly number[]): string =>
    `{${values.map(floatLiteral).join(", ")}}`;

test("the lowered velocity renderable writes what the pin's writes over a run", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("A native fixture compiler is required.");
        return;
    }
    const output = resolve("artifacts/geometry-velocity");
    const includes = join(output, "bblite/upstream");
    mkdirSync(includes, { recursive: true });
    const context = new LoweringContext();
    writeFileSync(
        join(includes, "geometry_velocity.hpp"),
        new GeometryVelocityLowerer(context).header(true),
    );
    writeFileSync(
        join(includes, "pinned_matrix.hpp"),
        pinnedMatrixHeader(context),
    );
    const frames = FRAMES.map(
        (frame) =>
            `{${floats(frame.world)}, ${frame.visible ? "true" : "false"}}`,
    );
    const poses = POSES.map(
        (pose) =>
            `{${floats(pose.bones)}, ${floats(pose.weights)}, ${pose.neutral ? "true" : "false"}}`,
    );
    const source = join(output, "check.cpp");
    writeFileSync(
        source,
        `#include <bblite/upstream/geometry_velocity.hpp>
#include <cstdio>
#include <cstring>
namespace {
struct Frame { std::array<float, 16> world; bool visible; };
struct Pose { std::array<float, 32> bones; std::array<float, 2> weights; bool neutral; };
const Frame frames[] = {${frames.join(",\n")}};
const Pose poses[] = {${poses.join(",\n")}};
void print(const char* kind, std::span<const float> values) {
    std::printf("%s:", kind);
    for (std::size_t index = 0; index < values.size(); ++index) {
        std::uint32_t word = 0;
        std::memcpy(&word, &values[index], 4);
        std::printf(index ? ",%x" : "%x", word);
    }
    std::printf("\\n");
}
} // namespace
int main() {
    using namespace bbl::upstream;
    std::array<float, 16> current = frames[0].world;
    PbrGeometryVelocity state = create_pbr_geometry_velocity(current, frames[0].visible);
    print("buffer", state.data);
    for (std::size_t index = 0; index < std::size(frames); ++index) {
        const bool changed = index > 0 && frames[index].world != frames[index - 1].world;
        if (changed) current = frames[index].world;
        update_pbr_geometry_velocity(state, current, changed, frames[index].visible,
                                     [](bool) {}, [&] { print("buffer", state.data); });
    }
    GeometryDeformationVelocity pose = create_geometry_deformation_velocity(poses[0].bones, poses[0].weights);
    for (const Pose& each : poses) {
        update_geometry_deformation_velocity(pose, each.neutral, each.bones, each.weights,
            [](std::span<const float> values) { print("texture", values); },
            [](std::span<const float> values) { print("buffer", values); });
    }
    // A task preload loads the feature only for a velocity task listing a
    // Standard mesh and a skinned or morphed mesh neither instanced nor baked.
    bbl::Engine engine;
    engine.materials.resize(2);
    engine.materials[0].standard_material = true;
    engine.meshes.resize(3);
    for (auto& record : engine.meshes) record.material = bbl::MaterialHandle{1};
    bbl::Scene scene;
    scene.meshes = {bbl::MeshHandle{0}, bbl::MeshHandle{1}, bbl::MeshHandle{2}};
    bbl::GeometryTaskOptions task;
    task.attachments.push_back({bbl::GeometryTextureType::linear_velocity});
    const auto loaded = [&] {
        const bool value = geometry_deformation_velocity_loaded;
        geometry_deformation_velocity_loaded = false;
        return value;
    };
    std::printf("preload:%u", preload_geometry_task(engine, scene, task));
    std::printf(",%d", loaded());
    engine.meshes[2].morph_targets_attached = true;
    engine.meshes[2].has_vat = true;
    engine.meshes[0].material = bbl::MaterialHandle{0};
    std::printf(",%u", preload_geometry_task(engine, scene, task));
    std::printf(",%d", loaded());
    engine.meshes[2].has_vat = false;
    task.attachments.clear();
    preload_geometry_task(engine, scene, task);
    std::printf(",%d", loaded());
    task.attachments.push_back({bbl::GeometryTextureType::linear_velocity});
    preload_geometry_task(engine, scene, task);
    std::printf(",%d", loaded());
    // A deformed Standard view built before the feature loaded refuses as
    // the pin does: a morphed one at its morph context, a skin at the
    // composer.
    for (const bool morphed : {true, false}) {
        try {
            require_standard_deformation_velocity(morphed);
        } catch (const std::runtime_error& error) {
            std::printf(",%s", error.what());
        }
    }
    geometry_deformation_velocity_loaded = true;
    require_standard_deformation_velocity(true);
    std::printf("\\n");
}
`,
    );
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/O2",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        output,
        source,
    ]);
    const native = runFixtureExecutable(executable).trim().split(/\r?\n/);
    // Families: PBR alone, then Standard and PBR; loaded only for the
    // non-baked morphed mesh of a velocity task.
    assert.equal(
        native.pop(),
        [
            "preload:2,0,3,0,0,1",
            MORPH_CONTEXT_REFUSAL,
            NOT_PRELOADED_REFUSAL,
        ].join(","),
    );
    assert.deepEqual(native, await pinnedWrites());
});
