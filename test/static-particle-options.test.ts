import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const setup = `
    import { createEngine, createSceneContext, createSpriteRenderer,
        parseNodeParticleSource, buildNodeParticleSet, registerNodeParticleSet2D }
        from "babylon-lite";
    async function main() {
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        const set = await buildNodeParticleSet(engine, scene,
            parseNodeParticleSource({ blocks: [] }));
        const renderer = createSpriteRenderer(engine, { layers: [] });
`;

function source(body: string): string {
    return `${setup}${body}} main();`;
}

test("particle options retain annotated tuple contents and configured viewport values", () => {
    for (const [width, height] of [[1280, 720], [800, 600]] as const) {
        const compiled = compileSource(`
            const center: readonly [number, number] = [96, 96];
        ` + source(`
            const original: [number, number] = [canvas.width * 0.5, canvas.height * 0.72];
            const originPx = original;
            const system = set.systems[0];
            system.buffer.posX[0] = (center[0] - originPx[0]) / 220;
            system.buffer.posY[0] = (originPx[1] - center[1]) / 220;
            registerNodeParticleSet2D(renderer, set, { originPx, pixelsPerUnit: center[0] });
        `), { width, height });
        assert.deepEqual(compiled.nodeParticles?.sprite2d[0]?.originPx, [width * 0.5, height * 0.72]);
        assert.equal(compiled.nodeParticles?.sprite2d[0]?.pixelsPerUnit, 96);
        assert.deepEqual(compiled.nodeParticles?.steps, [
            { op: "buffer-write", set: 0, system: 0, column: "posX", index: 0, value: (96 - width * 0.5) / 220 },
            { op: "buffer-write", set: 0, system: 0, column: "posY", index: 0, value: (height * 0.72 - 96) / 220 },
        ]);
        // Generation-only option facts do not replace the tuple's live initializer.
        assert.match(compiled.cpp, /v_engine\.options\.width/);
        assert.match(compiled.cpp, /v_engine\.options\.height/);
    }
});

test("particle options refuse tuples initialized from a mutable scalar", () => {
    assert.throws(() => compileSource(source(`
        let x = 96;
        const originPx: [number, number] = [x, 48];
        x = 24;
        registerNodeParticleSet2D(renderer, set, { originPx });
    `)), /originPx must be a static two-element number tuple/);
});

test("particle options refuse tuple snapshots invalidated through native writes and aliases", () => {
    const mutations = [
        "originPx[0] = 24;",
        "originPx[0] += 1;",
        "originPx[0]++;",
        "const previous = originPx[0]++;",
        "const current = ++originPx[0];",
        "const alias = originPx; alias[0] = 24;",
        "const holder = { originPx }; holder.originPx[0] = 24;",
        "const holder = { nested: { originPx } }; holder.nested.originPx[0] = 24;",
        "function mutate(value: [number, number]): void { value[0] = 24; } mutate(originPx);",
        `const holder = { originPx };
            function mutate(value: { originPx: [number, number] }): void { value.originPx[0] = 24; }
            mutate(holder);`,
        `function identity(value: [number, number]): [number, number] { return value; }
            const alias = identity(originPx); alias[0] = 24;`,
        "const holder: [number, number][] = [originPx]; holder[0][0] = 24;",
        "const holder = { get value() { return originPx; } }; holder.value[0] = 24;",
        "function update(callback: () => void): void { callback(); } update(() => { originPx[0] = 24; });",
        "[originPx[0], originPx[1]] = [originPx[1], originPx[0]];",
    ];
    for (const mutation of mutations) {
        assert.throws(() => compileSource(source(`
            const originPx: [number, number] = [96, 48];
            ${mutation}
            registerNodeParticleSet2D(renderer, set, { originPx });
        `)), /originPx must be a static two-element number tuple/, mutation);
        assert.throws(() => compileSource(source(`
            const originPx: [number, number] = [96, 48];
            ${mutation}
            registerNodeParticleSet2D(renderer, set, { pixelsPerUnit: originPx[0] });
        `)), /pixelsPerUnit must be a static number/, mutation);
    }
});

test("particle options refuse nonconstant, rebound and incorrectly sized tuples", () => {
    assert.throws(() => compileSource(source(`
        const values = new Float64Array([96]);
        const originPx: [number, number] = [values[0], 48];
        registerNodeParticleSet2D(renderer, set, { originPx });
    `)), /originPx must be a static two-element number tuple/);
    assert.throws(() => compileSource(source(`
        let originPx: [number, number] = [96, 48];
        originPx = [24, 12];
        registerNodeParticleSet2D(renderer, set, { originPx });
    `)), /rebinding it would copy in native code where JavaScript would alias/);
    assert.throws(() => compileSource(source(`
        const originPx: [number, number, number] = [96, 48, 12];
        registerNodeParticleSet2D(renderer, set, { originPx });
    `)), /originPx must be a static two-element number tuple/);
});
