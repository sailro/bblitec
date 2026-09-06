import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import { bakeNodeParticles } from "../src/pinned-node-particle.js";

const fileName = resolve("corpus/babylon-lite/lab/lite/src/lite/scene300.ts");
const original = readFileSync(fileName, "utf8");
const initialized = original.slice(0, original.indexOf("    const buffer = system.buffer;"));
function compile(body: string) {
    return compileSource(`${initialized}\n${body}\n}\nmain();`, { fileName });
}
const registration = `
    const renderer = createSpriteRenderer(engine, { layers: [] });
    registerNodeParticleSet2D(renderer, set, { autoStart: false });
`;

test("frozen particle buffer and column aliases preserve ordered initialization writes", () => {
    const result = compile(`
        const buffer = system.buffer;
        const positions = buffer.posX;
        positions[0] = 3.1;
        buffer.age[0] = 0.3673999999999999;
        const cells = new Uint16Array(buffer.capacity);
        const age = buffer.age[0] ?? -1;
        if (age < 0) throw new Error("missing age");
    `);
    assert.deepEqual(result.nodeParticles!.steps.slice(-3), [
        { op: "scalar", set: 0, system: 0, name: "updateSpeed", value: 0 },
        { op: "buffer-write", set: 0, system: 0, column: "posX", index: 0, value: 3.1 },
        { op: "buffer-write", set: 0, system: 0, column: "age", index: 0, value: 0.3673999999999999 },
    ]);
    assert.deepEqual(result.nodeParticles!.buffers, [
        { set: 0, system: 0, columns: ["age"], observed: true },
    ]);
    assert.match(result.cpp, /node_particle_frozen_capacity\(0, 0\)/);
    assert.match(result.cpp, /node_particle_frozen_column\(0, 0, "age", 0\.0\)/);
});

test("particle bake mutations refuse after native reads and inside live callbacks", () => {
    for (const body of [
        `const count = system.buffer.alive; system.buffer.posX[0] = 2;`,
        `const age = system.buffer.age[0]; animateParticleSystem(system, 1);`,
        `${registration} renderer._beforeUpdate.push(() => { system.updateSpeed = 1; });`,
        `${registration} renderer._beforeUpdate.push(() => { system.buffer.posX[0] = 2; });`,
    ]) {
        assert.throws(() => compile(body), /scene300\.ts:\d+:\d+: A frozen particle buffer can only change/);
    }
});

test("frozen sheet indices retain native typed-array aliases and request a live bridge hook", () => {
    const result = compile(`
        const buffer = system.buffer;
        const cells = new Uint16Array(buffer.capacity);
        const alias = cells;
        system._spriteSheet = { cellWidth: 64, cellHeight: 64, cellIndex: cells, update: () => undefined };
        alias[0] = 1;
        ${registration}
        renderer._beforeUpdate.push(() => {
            alias[0] = 0;
            if (buffer.alive === 0) throw new Error("empty");
            const age = buffer.age[0] ?? -1;
            if (age < 0) throw new Error("age");
        });
    `);
    assert.equal(result.nodeParticles!.sprite2d[0]!.retainFrozen, true);
    assert.equal(result.nodeParticles!.buffers[0]!.sheet, true);
    assert.deepEqual(result.nodeParticles!.buffers[0]!.columns, ["age"]);
    assert.equal(result.nodeParticles!.steps.filter((step) => step.op === "expect-alive").length, 0);
    assert.match(result.cpp, /set_frozen_node_particle_sheet\(0, 0, 64\.0, 64\.0, v_cells\)/);
    assert.match(result.cpp, /node_particle_frozen_alive\(0, 0\)/);
});

test("unreached sprite-sheet callbacks, fields and ownership shapes refuse at source", () => {
    for (const sheet of [
        `{ cellWidth: 64, cellHeight: 64, cellIndex: cells, update: () => { cells[0]++; } }`,
        `{ cellWidth: 64, cellHeight: 64, cellIndex: new Float32Array(600), update: () => undefined }`,
        `{ cellWidth: 64, cellHeight: 64, cellIndex: cells, update: () => undefined, extra: 1 }`,
        `other`,
    ]) {
        assert.throws(() => compile(`
            const cells = new Uint16Array(600);
            const other = { cellWidth: 64, cellHeight: 64, cellIndex: cells, update: () => undefined };
            system._spriteSheet = ${sheet};
        `), /scene300\.ts:\d+:\d+: .*([Ss]prite.sheet|Uint16Array)/);
    }
});

test("pinned frozen bake preserves full-capacity typed columns and stable Float64 particle age", async () => {
    const result = compile(`
        const buffer = system.buffer;
        const x = buffer.posX;
        x[0] = 3.1;
        const ages = buffer.age;
        const age = ages[0] ?? -1;
        const position = x[0] ?? -1;
        const inactive = ages[599] ?? -1;
        if (age < 0 || position < 0 || inactive < 0) throw new Error("bad buffer");
        ${registration}
    `);
    const baked = await bakeNodeParticles(result.nodeParticles!);
    const buffer = baked.systems[0]!;
    assert.equal(buffer.capacity, 600);
    assert.equal(buffer.alive, 90);
    assert.equal(buffer.stepIsIdentity, true);
    assert.equal(buffer.bufferColumns!.age!.length, 600);
    assert.equal(buffer.bufferColumns!.age![0], 0.3673999999999999);
    assert.notEqual(buffer.bufferColumns!.age![0], Math.fround(buffer.bufferColumns!.age![0]!));
    assert.equal(buffer.bufferColumns!.posX![0], Math.fround(3.1));
    assert.equal(buffer.bufferColumns!.age![599], 0);
    const atlas = PNG.sync.read(Buffer.from(buffer.texture!.bytes!, "base64"));
    assert.equal(atlas.width, 128);
    assert.equal(atlas.height, 64);
    assert.equal(buffer.texture!.mediaType, "image/png");
    const rgba = (x: number, y: number) => [...atlas.data.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4)];
    assert.deepEqual(rgba(96, 8), [255, 96, 32, 255]);
    assert.equal(rgba(96, 56)[3], 0);
});
