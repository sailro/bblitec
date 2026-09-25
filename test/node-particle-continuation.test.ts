import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { floatLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    NodeParticleLowerer,
    type NodeParticleSystemEmit,
} from "../src/lowering/node-particle-lowerer.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import {
    bakeNodeParticles,
    type NodeParticleColumn,
} from "../src/pinned-node-particle.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);
type Columns = Record<
    NodeParticleColumn,
    Float32Array | Float64Array | Uint32Array
>;
interface System {
    buffer: Columns & { alive: number; _nextId: number };
    texture: { width: number; height: number };
    blendMode: number;
}
interface Bridge {
    layer: { count: number; _instanceData: Float32Array };
}

test(
    "native particle continuation preserves runtime sizing, typed columns, composition and zero-speed updates",
    { skip: !tools },
    async () => {
        const fileName = resolve(
            "corpus/babylon-lite/lab/lite/src/lite/scene300.ts",
        );
        const program = compileSource(readFileSync(fileName, "utf8"), {
            fileName,
        }).nodeParticles!;
        const bake = await bakeNodeParticles(program);
        const live = bake.live[0]!;
        assert.ok(live.snapshot);
        assert.equal(live.snapshot.alive, 90);
        const { graph, facts, snapshot } = live;
        const entries: NodeParticleSystemEmit[] = [0, 1].map((set) => ({
            bake: { ...bake.systems[0]!, set, blendMode: set === 0 ? 3 : 4 },
            exactBlend: true,
            textureAsset: "fixture.png",
            continuation: { graph, facts: { ...facts, set }, snapshot },
        }));
        const context = new LoweringContext();
        const particle = new NodeParticleLowerer(context).lower(entries, [
            {
                systems: [
                    { set: 0, system: 0 },
                    { set: 1, system: 0 },
                ],
                exact: true,
                autoStart: false,
                pixelsPerUnit: 220,
                originPx: [0, 0],
                invertY: true,
                retainFrozen: true,
            },
        ]);
        const sprite = new SpriteLowerer(context).lowerCore();
        const { buildNodeParticleSet } = await importPinnedModule<{
            buildNodeParticleSet(
                this: void,
                engine: object,
                scene: object,
                graph: object,
                options: object,
            ): Promise<{ systems: System[] }>;
        }>("particle/node/npe-build.js");
        const { animateParticleSystem } = await importPinnedModule<{
            animateParticleSystem(
                this: void,
                system: System,
                ratio: number,
            ): void;
        }>("particle/particle-system.js");
        const api = await importPinnedModule<{
            createParticleSprite2DBridge(
                this: void,
                system: System,
                options: object,
            ): Bridge;
            syncParticleSprite2DBridge(this: void, bridge: Bridge): void;
        }>("particle/particle-sprite-2d.js");
        const expected: string[] = [];
        for (const [sample, [width, height]] of [
            [1280, 720],
            [800, 600],
        ].entries()) {
            for (const set of [0, 1]) {
                const built = await buildNodeParticleSet(
                    {},
                    {},
                    {
                        ...graph,
                        blocks: new Map(
                            graph.blocks.map((block) => [block.id, block]),
                        ),
                    },
                    { emitter: { x: 0, y: 0, z: 0 } },
                );
                const system = built.systems[0]!;
                Object.assign(system, snapshot.scalars);
                system.texture = { width: 128, height: 64 };
                system.buffer.alive = snapshot.alive;
                system.buffer._nextId = snapshot.nextId;
                for (const name of Object.keys(
                    snapshot.columns,
                ) as NodeParticleColumn[])
                    system.buffer[name].set(snapshot.columns[name]!);
                const buffer = system.buffer;
                buffer.posX[0] = ((set + 1) * 100 - width! * 0.5) / 220;
                buffer.posY[0] = (height! * 0.72 - 96) / 220;
                buffer.size[0] = 64 / 220;
                buffer.scaleX[0] = 1;
                buffer.scaleY[0] = 1;
                buffer.age[599] = 0.123456789012345;
                buffer.id[599] = -1;
                const bridge = api.createParticleSprite2DBridge(system, {
                    pixelsPerUnit: 220,
                    originPx: [width! * 0.5, height! * 0.72],
                });
                for (let frame = 0; frame < 2; frame++) {
                    if (frame === 1) {
                        // Zero speed still kills an expired particle and swap-removes its columns.
                        buffer.lifeTime[0] = 0;
                        animateParticleSystem(system, 1);
                    }
                    api.syncParticleSprite2DBridge(bridge);
                    expected.push(
                        `const std::vector<float> expected_${sample}_${set}_${frame}{${Array.from(bridge.layer._instanceData.slice(0, 13)).map(floatLiteral).join(", ")}};`,
                    );
                    assert.equal(bridge.layer.count, 90 - frame);
                }
            }
        }
        const output = resolve("artifacts/node-particle-continuation-check");
        const headers = join(output, "bblite/upstream");
        mkdirSync(headers, { recursive: true });
        writeFileSync(join(headers, "node_particles.hpp"), particle.header);
        writeFileSync(join(headers, "sprite_layer.hpp"), sprite.header);
        writeFileSync(join(output, "node_particles.cpp"), particle.source);
        writeFileSync(join(output, "sprite_layer.cpp"), sprite.source);
        writeFileSync(join(output, "expected.hpp"), expected.join("\n"));
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            "/O2",
            "/Gy",
            "/I",
            "native/include",
            "/I",
            output,
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            join(output, "node_particles.cpp"),
            join(output, "sprite_layer.cpp"),
            "test/fixtures/node-particle-continuation-check.cpp",
            "/link",
            "/OPT:REF",
        ]);
        for (const sample of [0, 1])
            assert.match(
                execFileSync(executable, [String(sample)], {
                    encoding: "utf8",
                }),
                /continuation-check: ok/,
            );
    },
);
