import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { bakeNodeParticles } from "../src/pinned-node-particle.js";
import { LoweringContext } from "../src/lowering/context.js";
import { NodeParticleLowerer } from "../src/lowering/node-particle-lowerer.js";
import { BillboardLowerer } from "../src/lowering/billboard-lowerer.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";

function scene(body: string, helpers = ""): string {
    return `
        import { createEngine, createSceneContext, parseNodeParticleSource,
            buildNodeParticleSet, withNodeParticleEmitterProvider, startParticleSystem,
            stopParticleSystem, animateParticleSystem, createParticleBillboard,
            registerNodeParticleSet, registerNodeParticleSet2D, createSpriteRenderer, onBeforeRender,
            createTexture2DFromPixels } from "@babylonjs/lite";
        import { enableNodeParticleBlendModes } from "@babylonjs/lite";
        ${helpers}
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            ${body}
        }
    `;
}

const provider = `
    const original = Math.random;
    let calls = 0;
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const options = withNodeParticleEmitterProvider(() => { calls++; return matrix; }, {
        emitter: { x: 4, y: 5, z: 6 }, textureBaseUrl: "textures/",
    });
    if (calls !== 1) throw new Error("provider was not sampled when wrapped");
    matrix[12] = 9;
    const alias = options;
    const set = await buildNodeParticleSet(engine, scene, parseNodeParticleSource({ blocks: [] }), alias);
    const system = set.systems[0];
`;

const program = scene(`${provider}
    Math.random = makeRandom();
    const first = Math.random();
    if (first !== 0.23645552527159452) throw new Error("first LCG draw differs");
    const saved = Math.random;
    Math.random = () => 0.25;
    if (Math.random() !== 0.25) throw new Error("nested random override differs");
    Math.random = saved;
    if (Math.random() !== 0.3692706737201661) throw new Error("saved closure did not retain its state");
    let inlineState = 10;
    Math.random = () => ++inlineState;
    if (Math.random() !== 11 || inlineState !== 11) throw new Error("inline override captured a snapshot");
    Math.random = saved;
    startParticleSystem(system);
    animateParticleSystem(system, 1);
    if (calls !== 2) throw new Error("frame did not sample the provider");
    system.updateSpeed = 0;
    animateParticleSystem(system, 1);
    if (calls !== 3) throw new Error("zero speed skipped the provider");
    stopParticleSystem(system);
    animateParticleSystem(system, 1);
    if (calls !== 4) throw new Error("stopped system skipped the provider");
    if (system.buffer.alive !== 0 || system.buffer.capacity !== 640) throw new Error("native buffer reads differ");
    {
        const Math: { random: () => number } = { random: () => 0.25 };
        const localSaved = Math.random;
        if (localSaved() !== 0.25 || Math.random() !== 0.25) {
            throw new Error("own random property used the global override");
        }
    }
    Math.random = original;
    if (Math.random() !== 0.6270739405881613) throw new Error("built-in random state was consumed by an override");
`, `function makeRandom(): () => number {
    let state = 1;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}`);

test("provider option aliases retain static options and source-ordered native calls", () => {
    const result = compileSource(program);
    assert.deepEqual(result.nodeParticles!.sets[0], {
        graph: { kind: "literal", graph: { blocks: [] } }, builder: "buildNodeParticleSet",
        emitter: [4, 5, 6], textureBaseUrl: "textures/", native: true,
    });
    assert.deepEqual(result.nodeParticles!.steps, []);
    assert.deepEqual(result.nodeParticles!.buffers, []);
    assert.match(result.cpp, /sample_node_particle_emitter/);
    assert.match(result.cpp, /set_random_override/);
});

test("an own random assignment cannot install the engine's global override", () => {
    assert.throws(() => compileSource(scene(`${provider}
        {
            const Math = { random: (): number => 0.25 };
            Math.random = (): number => 0.5;
        }
    `)), /Unsupported property assignment 'Math.random'/);
});

test("provider-backed systems refuse bridges and composition that would freeze native state", () => {
    for (const [operation, diagnostic] of [
        ["createParticleBillboard(system);", /explicit billboard bridge only carries frozen state/],
        ["registerNodeParticleSet2D(createSpriteRenderer(engine, { layers: [] }), set);", /pure-2D provider bridge is not lowered/],
        ["set.systems.push(system);", /System-list composition with a provider-backed particle set/],
    ] as const) {
        assert.throws(() => compileSource(scene(provider + operation)), diagnostic);
    }
});

test("provider construction and texture mutation refuse recurring callback storage", () => {
    assert.throws(() => compileSource(scene(`${provider}
        onBeforeRender(scene, () => {
            withNodeParticleEmitterProvider(() => matrix);
        });
    `)), /native emitter provider must be constructed before recurring frame callbacks/);
    assert.throws(() => compileSource(scene(`${provider}
        onBeforeRender(scene, async () => {
            await buildNodeParticleSet(engine, scene, parseNodeParticleSource({ blocks: [] }), options);
        });
    `)), /provider-backed particle set must be built before recurring frame callbacks/);
    assert.throws(() => compileSource(scene(`${provider}
        const texture = createTexture2DFromPixels(engine, new Uint8Array([255, 255, 255, 255]), 1, 1);
        onBeforeRender(scene, () => { system.texture = texture; });
    `)), /provider-backed particle texture must be assigned before recurring frame callbacks/);
    assert.throws(() => compileSource(scene(`${provider}
        onBeforeRender(scene, () => registerNodeParticleSet(scene, set));
    `)), /provider-backed particle set must be registered before recurring frame callbacks/);
});

test("native and generation-only sets cannot split the shared random sequence", () => {
    const frozen = `const frozen = await buildNodeParticleSet(engine, scene, parseNodeParticleSource({ blocks: [] }));`;
    for (const body of [frozen + provider, provider + "Math.random = () => 0.25;" + frozen]) {
        assert.throws(() => compileSource(scene(body)), /simulations must observe one Math.random sequence/);
    }
});

test("native blend enabling cannot change an earlier registration retroactively", () => {
    assert.throws(() => compileSource(scene(`${provider}
        registerNodeParticleSet(scene, set);
        enableNodeParticleBlendModes(set);
    `)), /enabler affects future billboards/);
    assert.throws(() => compileSource(scene(`${provider}
        onBeforeRender(scene, () => enableNodeParticleBlendModes(set));
    `)), /enabler affects future billboards/);
});

test("standalone providers refuse before missing runtime helpers", () => {
    assert.throws(() => compileSource(scene(`withNodeParticleEmitterProvider(() => new Float32Array(16));`)),
        /standalone provider options are not lowered/);
});

test("resolved query primitives remain native input to imported numeric helpers", () => {
    const result = compileSource(`
        import { createEngine, createBox } from "@babylonjs/lite";
        import { stepCount, nextCount } from "./query-step-math.js";
        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const seconds = Number(new URLSearchParams(location.search).get("seconds"));
            const count = stepCount(seconds);
            for (let step = 1; step <= count; step++) box.position.x += step;
            const changed = nextCount(seconds);
            box.position.y = changed;
        }
    `, { fileName: resolve("test/fixtures/query-step-entry.ts"), search: "?seconds=2" });
    assert.match(result.cpp, /stepCount\(2\.0\)/);
    assert.match(result.cpp, /round_js\(\(v_\w+_seconds \* 60\.0\)\)/);
    assert.match(result.cpp, /\+= 1\.0/);
});

test("authored moving-emitter modes carry pinned build facts without freezing native steps", async () => {
    const fileName = resolve("corpus/babylon-lite/lab/lite/src/lite/scene302.ts");
    const source = readFileSync(fileName, "utf8");
    for (const search of ["?seekTime=2", ""]) {
        const result = compileSource(source, { fileName, search });
        const program = result.nodeParticles!;
        assert.equal(program.sets[0]!.native, true);
        assert.deepEqual(program.steps, []);
        assert.equal(program.registrations[0]!.autoStart, search === "");
        const bake = await bakeNodeParticles(program);
        assert.deepEqual(bake.systems, []);
        assert.equal(bake.live.length, 1);
        const live = bake.live[0]!;
        assert.equal(live.provider, true);
        assert.equal(live.request, undefined);
        assert.equal(live.facts.hooks._prepareFrame, true);
        assert.equal(live.facts.hooks._seedLocalPosition, true);
        assert.equal(live.facts.capacity, 640);
        assert.equal(live.facts.updateSpeed, 1 / 60);
        assert.equal(live.facts.updateSteps, 1);
        assert.equal(live.texture.sceneAssigned, true);
        assert.equal(live.texture.width, 64);
        assert.equal(live.texture.height, 64);
        if (nativeTools) {
            const context = new LoweringContext();
            const particle = new NodeParticleLowerer(context).lower([{
                bake: { set: 0, system: 0, capacity: live.facts.capacity,
                    blendMode: live.facts.blendMode, updateSpeed: live.facts.updateSpeed,
                    stepIsIdentity: false, texture: live.texture, spriteSheet: null,
                    alive: 0, positions: [], sizes: [], colors: [], rotations: [], frames: null },
                exactBlend: false, textureAsset: "fixture.png",
                live: { graph: live.graph, facts: live.facts, provider: true },
            }], [], [{ systems: [{ set: 0, system: 0 }], autoStart: search === "" }]);
            const billboard = new BillboardLowerer(context, new RendererLowerer(context).compiledSceneUniformsWgsl()).lowerCore();
            const sprite = new SpriteLowerer(context).lowerCore();
            const output = resolve(`artifacts/node-particle-provider-bridge-check-${search ? "frozen" : "live"}`);
            const headers = join(output, "bblite/upstream");
            mkdirSync(headers, { recursive: true });
            writeFileSync(join(headers, "node_particles.hpp"), particle.header);
            writeFileSync(join(headers, "billboard_system.hpp"), billboard.header);
            writeFileSync(join(headers, "sprite_layer.hpp"), sprite.header);
            writeFileSync(join(output, "node_particles.cpp"), particle.source);
            writeFileSync(join(output, "billboard_system.cpp"), billboard.source);
            const executable = join(output, "check.exe");
            runNativeFixtureCompiler(nativeTools, [
                "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/Gy",
                `/DAUTO_START=${search === "" ? 1 : 0}`, "/I", "native/include", "/I", output,
                `/Fo:${output}\\`, `/Fe:${executable}`, join(output, "node_particles.cpp"),
                join(output, "billboard_system.cpp"), "test/fixtures/node-particle-provider-bridge-check.cpp",
                "/link", "/OPT:REF",
            ]);
            assert.match(execFileSync(executable, { encoding: "utf8" }), /provider-bridge-check: ok/);
        }
    }
});

const nativeTools = optionalNativeFixtureTools(false);
test("native source calls preserve provider sampling and random closure restoration", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/native-particle-provider-check");
    mkdirSync(join(output, "bblite/upstream"), { recursive: true });
    writeFileSync(join(output, "bblite/upstream/node_particles.hpp"), "#pragma once\n");
    writeFileSync(join(output, "provider.hpp"), compileSource(program).cpp);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", "/I", output,
        "test/fixtures/native-particle-provider-check.cpp"]);
    execFileSync(executable, { encoding: "utf8" });
});
