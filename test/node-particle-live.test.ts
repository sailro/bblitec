import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { LoweringContext } from "../src/lowering/context.js";
import {
    HOOK_NAMES,
    type LiveGraph,
    type LiveSystemFacts,
    NodeParticleLiveLowerer,
    SLOT_NAMES,
} from "../src/lowering/node-particle-live-lowerer.js";
import { findRepositoryRoot } from "../src/upstream-source.js";

/**
 * The live node-particle lowering over the demo's own graph.
 *
 * The pinned parser and builder run under Node here -- the texture block's
 * load fails inside the pin's own catch, which is the one effect this
 * lowering does not take from the build -- so the facts the bake driver
 * would report come off a real built system, and the lowering is checked
 * against them exactly as generation checks it.
 */
async function lowerDemoGraph(): Promise<{
    source: string;
    facts: LiveSystemFacts;
}> {
    const root = findRepositoryRoot();
    const text = readFileSync(
        join(root, "corpus/babylon-lite/lab/lite/src/shared/scene262-npe.ts"),
        "utf8",
    );
    const document = JSON.parse(
        text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    ) as { blocks: Array<Record<string, unknown>> };
    // The fixture's own edits (`createNpeSprite2DGraph`), restated as data.
    const textureBlock = document.blocks.find(
        (block) => block.customType === "BABYLON.ParticleTextureSourceBlock",
    )!;
    const systemBlock = document.blocks.find(
        (block) => block.customType === "BABYLON.SystemBlock",
    )!;
    textureBlock.url = "flare.png";
    systemBlock.capacity = 600;
    systemBlock.blendMode = 0;
    systemBlock.updateSpeed = 0.0167;
    const emitRate = (systemBlock.inputs as Array<Record<string, unknown>>).find(
        (input) => input.name === "emitRate",
    )!;
    emitRate.value = 90;

    const lib = join(root, "node_modules/@babylonjs/lite/lib");
    const load = async (path: string): Promise<Record<string, Function>> =>
        (await import(pathToFileURL(join(lib, path)).href)) as Record<string, Function>;
    const { parseNodeParticleSource } = await load("particle/node/npe-parser.js");
    const { buildNodeParticleSet } = await load("particle/node/npe-build.js");
    const { mat4Translation } = await load("math/mat4-translation.js");
    const graph = parseNodeParticleSource!(document) as {
        blocks: Map<number, LiveGraph["blocks"][number]>;
        systemBlockIds: number[];
    };
    const visits: number[] = [];
    const recording = new Map(graph.blocks);
    const plain = Map.prototype.get.bind(recording);
    recording.get = (key: number) => {
        visits.push(key);
        return plain(key);
    };
    graph.blocks = recording;
    const set = (await buildNodeParticleSet!({}, {}, graph, {
        emitter: { x: 0, y: 0, z: 0 },
    })) as { systems: Array<Record<string, unknown>> };
    const system = set.systems[0]!;
    const systemId = graph.systemBlockIds[0]!;
    const slots = Object.fromEntries(
        SLOT_NAMES.map((slot) => [slot, system[slot] !== null]),
    ) as LiveSystemFacts["slots"];
    const hooks = Object.fromEntries(
        HOOK_NAMES.map((hook) => [hook, system[hook] !== undefined]),
    ) as LiveSystemFacts["hooks"];
    const facts: LiveSystemFacts = {
        set: 0,
        system: 0,
        systemBlockId: systemId,
        capacity: (system.buffer as { capacity: number }).capacity,
        emitRate: system.emitRate as number,
        updateSpeed: system.updateSpeed as number,
        blendMode: system.blendMode as number,
        targetStopDuration: system.targetStopDuration as number,
        updateSteps: (system.updateSteps as unknown[]).length,
        slots,
        hooks,
        emitter: [0, 0, 0],
        emitterWorldMatrix: Array.from(mat4Translation!(0, 0, 0) as Float32Array),
        visitOrder: visits,
    };
    const liveGraph: LiveGraph = {
        blocks: [...graph.blocks.values()],
        systemBlockIds: graph.systemBlockIds,
    };
    const lowerer = new NodeParticleLiveLowerer(new LoweringContext());
    const lowered = lowerer.lowerSystem(liveGraph, facts);
    return { source: `${lowerer.sharedSource()}\n${lowered.source}`, facts };
}

const demo = lowerDemoGraph();

test("the live lowering derives the executed pin's own build", async () => {
    const { facts } = await demo;
    assert.equal(facts.updateSteps, 2);
    assert.deepEqual(
        Object.values(facts.slots),
        [true, true, true, true, true, true, true, true],
    );
    assert.ok(Object.values(facts.hooks).every((installed) => !installed));
});

test("the simulation loop keeps the pin's creation order and emission count", async () => {
    const { source } = await demo;
    const createNew = source.slice(source.indexOf("void create_new("));
    const order = [
        "create_life_time",
        "create_position",
        "create_direction",
        "create_emit_power",
        "create_size",
        "create_angle",
        "create_color",
        "create_color_dead",
    ].map((slot) => createNew.indexOf(`${slot}(state, i)`));
    assert.ok(order.every((index, position) => index > (order[position - 1] ?? -1)));
    // `emission >> 0` is ECMAScript ToInt32, not a C++ cast.
    assert.match(source, /bbl::js::to_int32\(emission\) >> \(bbl::js::to_int32\(0\.0\) & 31\)/);
    // Absent hooks fold away rather than emitting a null test.
    assert.doesNotMatch(source, /_prepareFrame|_emitRateGetter|_writeColorDead/);
    // The two update steps in graph order: colour before position.
    assert.match(source, /update_steps = \{\s*&update_step_35,\s*&update_step_40\}/);
});

test("per-particle closures are lowered with their shapes folded", async () => {
    const { source } = await demo;
    // The PerParticle lock: the mode folded, the id read, the draw stored.
    assert.match(
        source,
        /if \(state\.b8_current_lock_id != lockId\) \{\s*\{\s*state\.b8_current_lock_id = lockId;\s*\}\s*state\.b8_stored = draw_b8\(state, i\);/,
    );
    // A scalar random draws through the pin's own randomBetween over the
    // pinned generator.
    assert.match(source, /double npe_random_between\(/);
    assert.match(source, /bbl::js::random_js\(\)/);
    // A colour math block: the shape test folded to the Color4 arm, the
    // operation a constant argument of the pin's own apply.
    assert.match(source, /state\.b32_color4\.a = npe_apply\(0\.0, a\.a, b\.a\);/);
    // The box shape draws each component through randomRange and transforms
    // by the emitter matrix the executed pin composed.
    assert.match(source, /npe_random_range\(minX, maxBox\.x\)/);
    assert.match(source, /npe_transform_coordinates_to_ref\(rx, ry, rz, emitter_world_matrix, state\.b27_scratch\)/);
    // A stored vector draw takes the shape the body assigns, not the
    // number the pin initialises the cell with.
    assert.match(source, /Vec2d b14_stored\{\};/);
    // Typed-array stores round at the pin's widths: f32 columns, f64 age.
    assert.match(source, /state\.pos_x\[static_cast<std::size_t>\(i\)\] = static_cast<float>\(v\.x\);/);
    assert.match(source, /state\.age\[static_cast<std::size_t>\(i\)\] = \(previousAge \+ stepSpeed\);/);
});

test("a graph variant the lowering does not cover refuses by name", async () => {
    const lowerer = new NodeParticleLiveLowerer(new LoweringContext());
    const graph: LiveGraph = {
        blocks: [
            {
                id: 1,
                className: "SystemBlock",
                name: "system",
                inputs: [
                    { name: "emitRate", targetBlockId: 2, targetConnectionName: "output" },
                ],
                serialized: { capacity: 4 },
            },
            {
                id: 2,
                className: "ParticleInputBlock",
                name: "rate",
                inputs: [],
                serialized: { type: 2, value: 3 },
            },
        ],
        systemBlockIds: [1],
    };
    const facts: LiveSystemFacts = {
        set: 0,
        system: 0,
        systemBlockId: 1,
        capacity: 4,
        emitRate: 3,
        updateSpeed: 0.0167,
        blendMode: 2,
        targetStopDuration: 0,
        updateSteps: 0,
        slots: {
            createLifeTime: false,
            createPosition: false,
            createDirection: false,
            createEmitPower: false,
            createSize: false,
            createAngle: false,
            createColor: false,
            createColorDead: false,
        },
        hooks: {
            _emitRateGetter: true,
            _prepareFrame: false,
            _spriteSheet: false,
            _writeColorDead: false,
            _suppressInitialDirectionCapture: false,
            _seedLocalPosition: false,
            _registerBillboard: false,
        },
        emitter: [0, 0, 0],
        emitterWorldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        visitOrder: [1, 2],
    };
    assert.throws(
        () => lowerer.lowerSystem(graph, facts),
        /variant evaluator 'SystemBlock'/,
    );
});
