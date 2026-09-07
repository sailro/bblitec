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

test("unchanged scene300 derives frozen marker placement from the configured canvas", () => {
    for (const [width, height] of [[1280, 720], [800, 600]] as const) {
        const result = compileSource(original, { fileName, width, height });
        const program = result.nodeParticles!;
        assert.deepEqual(program.sprite2d[0]!.originPx, [width * 0.5, height * 0.72]);
        assert.equal(program.sprite2d[0]!.retainFrozen, true);
        const writes = program.steps.filter((step) => step.op === "buffer-write");
        assert.deepEqual(writes.slice(0, 2), [
            { op: "buffer-write", set: 0, system: 0, column: "posX", index: 0, value: (96 - width * 0.5) / 220 },
            { op: "buffer-write", set: 0, system: 0, column: "posY", index: 0, value: (height * 0.72 - 96) / 220 },
        ]);
        assert.match(result.cpp, /sprite_renderer_before_update/);
        assert.match(result.cpp, /\(\*v_liveSamples\)\+\+/);
    }
});

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

test("frozen snapshots refuse composed aliases in either reach order", () => {
    const other = `const other = await buildNodeParticleSet(engine, buildScene, parseNodeParticleSource(createNpeSprite2DGraph(flareUrl)));`;
    const sheet = `const cells = new Uint16Array(600); system._spriteSheet = { cellWidth:64, cellHeight:64, cellIndex:cells, update:()=>undefined };`;
    for (const body of [
        `set.systems.push(system); const x = set.systems[1]!.buffer.posX[0] ?? 0; system.buffer.posX[0] = 123;`,
        `const buffer = system.buffer; const column = buffer.posX; set.systems.push(system); const x = column[0];`,
        `const buffer = system.buffer; set.systems.push(system); const count = buffer.capacity;`,
        `const x = system.buffer.posX[0]; set.systems.push(system);`,
        `${other} other.systems.push(system); const x = system.buffer.posX[0];`,
        `${other} other.systems.push(system); const x = other.systems[0]!.buffer.alive;`,
        `${other} const x = system.buffer.posX[0]; other.systems.push(system);`,
        `${other} const x = other.systems[0]!.buffer.age[0]; other.systems.push(system);`,
        `${sheet} ${other} other.systems.push(system); ${registration.replace(", set,", ", other,")}`,
        `${other} other.systems.push(system); ${sheet}`,
    ]) {
        assert.throws(() => compile(body), /scene300\.ts:\d+:\d+: .*([Ss]ystem-list composition|cannot be combined with system-list composition)/);
    }
    // Existing composition remains an ordered bake operation when no new
    // native snapshot or shared sheet crosses the original-system boundary.
    const result = compile(`${other} other.systems.push(system); ${registration.replace(", set,", ", other,")}`);
    assert.ok(result.nodeParticles!.steps.some((step) => step.op === "push-system"));
    assert.deepEqual(result.nodeParticles!.buffers, []);
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

test("a seeded generator may come from a factory the driver re-declares", () => {
    // The pin's own seed factory holds the state its returned function
    // steps, so what travels is the declaration plus the call rather than a
    // verbatim arrow. It is annotated TypeScript, and the driver runs
    // JavaScript, so the declaration goes through the same transpile the
    // other pinned-text drivers use.
    const result = compile(`
        function makeSeed(start = 7): () => number {
            let state: number = start;
            return () => {
                state = (state * 1664525 + 1013904223) >>> 0;
                return state / 4294967296;
            };
        }
        Math.random = makeSeed(11);
    `);
    // Scene 300's own prefix installs a sine seed first, so this is the
    // second `random` step, not the only one.
    const randomSteps = result.nodeParticles!.steps.filter(
        (step) => step.op === "random",
    );
    assert.equal(randomSteps.length, 2);
    const random = randomSteps[1]!;
    assert.ok(random.op === "random");
    // The call is the expression the driver returns as the generator, and
    // the argument travels as written.
    assert.equal(random.arrow, "makeSeed(11)");
    const declared = random.declarations.join("\n");
    assert.match(declared, /function makeSeed\(start = 7\)/);
    // The annotations are gone: this text is evaluated as JavaScript.
    assert.doesNotMatch(declared, /\(\) => number/);
    assert.doesNotMatch(declared, /let state: number/);
    assert.match(declared, /state \* 1664525/);
});

test("a seed factory refuses what the driver could not run", () => {
    for (const [body, expected] of [
        [
            `const makeSeed = () => () => 0.5;\nMath.random = makeSeed();`,
            /must be a function declaration this compiler can read/,
        ],
        [
            `async function makeSeed() { return () => 0.5; }\nMath.random = makeSeed();`,
            /is not async/,
        ],
        [
            `function makeSeed(start = 1) { let s = start; return () => (s = s + 1) / 4294967296; }\nconst chosen = 3;\nMath.random = makeSeed(chosen);`,
            /numeric literal arguments only/,
        ],
    ] as const) {
        assert.throws(() => compile(body), expected, body);
    }
});
