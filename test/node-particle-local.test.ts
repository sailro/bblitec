import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import test from "node:test";
import { javascriptModuleUrl } from "../src/data-url.js";
import { transpileForBrowser } from "../src/typescript-transpile.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { floatLiteral, snakeCase } from "../src/cpp-literals.js";
import { NodeParticleLiveLowerer, SLOT_NAMES, HOOK_NAMES, type LiveGraph, type LiveSystemFacts } from "../src/lowering/node-particle-live-lowerer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

interface ParticleBuffer {
    capacity: number;
    alive: number;
    posX: Float32Array;
    posY: Float32Array;
    posZ: Float32Array;
    dirX: Float32Array;
    dirY: Float32Array;
    dirZ: Float32Array;
    age: Float64Array;
    id: Uint32Array;
    _columns: Map<string, Float32Array | Uint32Array | Uint8Array>;
}
interface ParticleSystem extends Record<string, unknown> {
    buffer: ParticleBuffer;
    emitRate: number;
    updateSpeed: number;
    blendMode: number;
    targetStopDuration: number;
    updateSteps: unknown[];
}

async function localFixture(provider = false) {
    const path = "corpus/babylon-lite/lab/lite/src/shared/scene302-npe-moving-emitter.ts";
    const helper = await import(javascriptModuleUrl(transpileForBrowser(readFileSync(path, "utf8"), path))) as {
        createScene302NpeGraph(): object;
        createScene302SeededRandom(): () => number;
        getScene302EmitterPoseForStep(step: number): { x: number; y: number; z: number; angleZ: number };
        writeScene302EmitterMatrix(matrix: Float32Array, pose: object): void;
    };
    const { parseNodeParticleSource } = await importPinnedModule<{
        parseNodeParticleSource(source: object): { blocks: Map<number, LiveGraph["blocks"][number]>; systemBlockIds: number[] };
    }>("particle/node/npe-parser.js");
    const { buildNodeParticleSet } = await importPinnedModule<{
        buildNodeParticleSet(engine: object, scene: object, graph: object, options: object): Promise<{ systems: ParticleSystem[] }>;
    }>("particle/node/npe-build.js");
    const graph = parseNodeParticleSource(helper.createScene302NpeGraph());
    const visits: number[] = [];
    const blocks = new Map(graph.blocks);
    const get = blocks.get.bind(blocks);
    blocks.get = (id: number) => { visits.push(id); return get(id); };
    graph.blocks = blocks;
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    let providerCalls = 0;
    let options: object = { emitter: { x: 0, y: 0, z: 0 } };
    if (provider) {
        helper.writeScene302EmitterMatrix(matrix, helper.getScene302EmitterPoseForStep(0));
        const pin = await importPinnedModule<{
            withNodeParticleEmitterProvider(callback: () => Float32Array, options: object): object;
        }>("particle/node/npe-emitter-provider.js");
        options = pin.withNodeParticleEmitterProvider(() => { ++providerCalls; return matrix; }, options);
    }
    const set = await buildNodeParticleSet({}, {}, graph, options);
    const system = set.systems[0]!;
    const facts: LiveSystemFacts = {
        set: 0, system: 0, systemBlockId: graph.systemBlockIds[0]!,
        capacity: system.buffer.capacity, emitRate: system.emitRate,
        updateSpeed: system.updateSpeed, blendMode: system.blendMode,
        targetStopDuration: system.targetStopDuration, updateSteps: system.updateSteps.length,
        slots: Object.fromEntries(SLOT_NAMES.map((name) => [name, system[name] !== null])) as LiveSystemFacts["slots"],
        hooks: Object.fromEntries(HOOK_NAMES.map((name) => [name, system[name] !== undefined])) as LiveSystemFacts["hooks"],
        emitter: [matrix[12]!, matrix[13]!, matrix[14]!], emitterWorldMatrix: Array.from(matrix),
        visitOrder: visits,
    };
    const lowerer = new NodeParticleLiveLowerer(new LoweringContext());
    const lowered = lowerer.lowerSystem({ blocks: [...blocks.values()], systemBlockIds: graph.systemBlockIds }, facts, provider);
    return { helper, system, facts, matrix, providerCalls: () => providerCalls,
        source: `${lowerer.sharedSource()}\n${lowered.source}` };
}

for (const provider of [false, true]) test(`local particle columns preserve births, updates and swap-removal (provider ${provider})`, {
    skip: !optionalNativeFixtureTools(false),
}, async () => {
    const { helper, system, source, matrix, facts, providerCalls } = await localFixture(provider);
    const pin = await importPinnedModule<{
        startParticleSystem(system: ParticleSystem): void;
        animateParticleSystem(system: ParticleSystem, ratio: number): void;
        stopParticleSystem(system: ParticleSystem): void;
    }>("particle/particle-system.js");
    const draws = Array.from({ length: 3000 }, helper.createScene302SeededRandom());
    const original = Math.random;
    let next = 0;
    const matrices: number[][] = [Array.from(matrix)];
    const advanceMatrix = (step: number): void => {
        helper.writeScene302EmitterMatrix(matrix, helper.getScene302EmitterPoseForStep(step));
        matrices.push(Array.from(matrix));
    };
    try {
        Math.random = () => draws[next++]!;
        pin.animateParticleSystem(system, 1);
        assert.equal(providerCalls(), provider ? 1 : 0, "Unstarted animation must not sample");
        pin.startParticleSystem(system);
        for (let frame = 1; frame <= 180; ++frame) {
            if (provider) advanceMatrix(frame);
            pin.animateParticleSystem(system, 1);
        }
        if (provider) {
            system.updateSpeed = 0;
            advanceMatrix(181);
            pin.animateParticleSystem(system, 1);
            pin.stopParticleSystem(system);
            advanceMatrix(182);
            pin.animateParticleSystem(system, 1);
            assert.equal(providerCalls(), 183, "Zero speed and stopped animation must still sample");
        }
    } finally { Math.random = original; }
    assert(system.buffer.alive > 0 && system.buffer.id[0]! > 0, "Fixture must exercise death and swap-removal");
    const checks: string[] = [];
    const columns = [
        ["pos_x", system.buffer.posX], ["pos_y", system.buffer.posY], ["pos_z", system.buffer.posZ],
        ["dir_x", system.buffer.dirX], ["dir_y", system.buffer.dirY], ["dir_z", system.buffer.dirZ],
        ["age", system.buffer.age], ["id", system.buffer.id],
        ...[...system.buffer._columns].map(([name, values]) => [`column_${snakeCase(name.replaceAll(".", "_"))}`, values] as const),
    ] as const;
    for (const [name, values] of columns) {
        checks.push(`{ const std::array<double, ${system.buffer.alive}> expected{${Array.from(values).slice(0, system.buffer.alive).join(",")}};
            for (std::size_t i = 0; i < expected.size(); ++i) assert(static_cast<double>(npe_0_0::state.${name}[i]) == expected[i]); }`);
    }
    const output = resolve(`artifacts/node-particle-local-check${provider ? "-provider" : ""}`);
    mkdirSync(output, { recursive: true });
    const fixture = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(fixture, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
using namespace bbl;
${source}
int main() {
    const std::array<double, ${draws.length}> draws{${draws.join(",")}};
    std::size_t next = 0;
    bbl::js::set_random_override([&]() { return draws.at(next++); });
    ${provider ? `
    const std::array<std::array<float, 16>, ${matrices.length}> matrices{{
        ${matrices.map((values) => `{${values.map(floatLiteral).join(",")}}`).join(",\n")}
    }};
    std::size_t provider_calls = 0;
    bbl::js::F32Array matrix(matrices[0].begin(), matrices[0].end());
    bbl::js::Callback<bbl::js::F32Array()> callback = [&]() { ++provider_calls; return matrix; };
    const auto sample = [&]() {
        const auto provided = npe_sample_provider(callback);
        std::array<float, 16> snapshot{};
        npe_copy_matrix(provided, snapshot);
        return snapshot;
    };
    const auto snapshot = sample();
    npe_0_0::state.emitter_provider = sample;
    npe_0_0::initialize(npe_0_0::state, snapshot);
    assert(provider_calls == 1);
    assert(npe_0_0::state.emitter_world_matrix == snapshot);
    assert(npe_0_0::state.emitter.x == ${facts.emitter[0]});
    assert(npe_0_0::state.emitter.y == ${facts.emitter[1]});
    assert(npe_0_0::state.emitter.z == ${facts.emitter[2]});
    npe_0_0::animate_particle_system(npe_0_0::state, 1.0);
    assert(provider_calls == 1);
    ` : ""}
    npe_0_0::start_particle_system(npe_0_0::state);
    for (std::size_t frame = 1; frame <= 180; ++frame) {
        ${provider ? "std::copy(matrices[frame].begin(), matrices[frame].end(), matrix.begin());" : ""}
        npe_0_0::animate_particle_system(npe_0_0::state, 1.0);
    }
    ${provider ? `
    npe_0_0::state.update_speed = 0;
    for (std::size_t frame = 181; frame <= 182; ++frame) {
        if (frame == 182) npe_0_0::stop_particle_system(npe_0_0::state);
        std::copy(matrices[frame].begin(), matrices[frame].end(), matrix.begin());
        npe_0_0::animate_particle_system(npe_0_0::state, 1.0);
    }
    assert(provider_calls == 183);
    assert(npe_0_0::state.emitter_world_matrix == matrices.back());
    const auto stable = npe_0_0::state.emitter_world_matrix;
    const auto alive = npe_0_0::state.alive;
    matrix.resize(15);
    bool invalid_length = false;
    try { npe_0_0::animate_particle_system(npe_0_0::state, 1.0); }
    catch (const std::runtime_error&) { invalid_length = true; }
    assert(invalid_length);
    matrix.resize(16);
    matrix[3] = std::numeric_limits<float>::quiet_NaN();
    bool invalid_value = false;
    try { npe_0_0::animate_particle_system(npe_0_0::state, 1.0); }
    catch (const std::runtime_error&) { invalid_value = true; }
    assert(invalid_value);
    assert(npe_0_0::state.emitter_world_matrix == stable && npe_0_0::state.alive == alive);
    ` : ""}
    assert(npe_0_0::state.alive == ${system.buffer.alive});
    assert(next == ${next});
    ${checks.join("\n")}
}
`);
    runNativeFixtureCompiler(optionalNativeFixtureTools(false)!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", fixture,
    ]);
    execFileSync(executable, { stdio: "pipe" });
});
