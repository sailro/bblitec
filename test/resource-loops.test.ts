import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { StaticExpansionBudget } from "../src/compiler/static-expansion.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { loopBoundMayChange } from "../src/compiler/resource-loops.js";
import { CompilerSymbols } from "../src/compiler/symbols.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

function scene(body: string, helpers = ""): string {
    return `
        import {
            createEngine, createSceneContext, createBox, createPlane,
            createSphere, createStandardMaterial, createPbrMaterial,
            addToScene, onBeforeRender,
        } from "@babylonjs/lite";
        import type { EngineContext, SceneContext, Mesh, Material } from "@babylonjs/lite";
        ${helpers}
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            ${body}
        }
    `;
}

const gridSource = scene(`
        const material = createStandardMaterial();
        for (let x = 0; x < 64; x++) {
            for (let y = 0; y < 64; y++) {
                const box = createBox(engine, { size: x + 1 });
                box.position.x = x;
                box.position.y = y;
                box.material = material;
                addToScene(scene, box);
            }
        }
    `);

test("parameterizes a 64 by 64 box grid while retaining every composition row", () => {
    const result = compileSource(gridSource);
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.cpp.match(/for \(;/g)?.length, 2);
    assert.ok(Buffer.byteLength(result.cpp) < 5000);
    assert.equal(result.manifest.sceneMeshes.length, 4096);
    assert.equal(result.manifest.sceneMeshes.filter((mesh) => mesh.standardMaterial).length, 4096);
    assert.match(result.cpp, /BoxOptions\{static_cast<float>\(\(v_\w+_x \+ 1\.0\)\)/);
});

test("small torus-knot loops preserve composition counts and record callback evaluation", () => {
    const result = compileSource(scene(`
        const material = createStandardMaterial();
        let calls = 0;
        const options = { size(index: number): number { calls++; return index + 2; } };
        for (let index = 0; index < 4; index++) {
            const mesh = createTorusKnot(engine, { radius: options.size(index), tube: tint(index) });
            mesh.material = material;
            addToScene(scene, mesh);
        }
        if (calls !== 4) throw new Error("callback count");
    `, `
        import { createTorusKnot } from "@babylonjs/lite";
        function tint(index: number): number {
            if (index === 0) return 1;
            return index === 1 ? 2 : 3;
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_torus_knot\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMeshes.length, 4);
    assert.equal(result.manifest.sceneMeshes.filter(mesh => mesh.standardMaterial).length, 4);
    assert.equal(result.cpp.match(/v_calls\+\+|\(\*v_calls\)\+\+/g)?.length, 1);
});

test("sprite option callbacks and data returns keep a grid compact", () => {
    const result = compileSource(`
        import { createEngine, loadSpriteAtlas, createSprite2DLayer, addSprite2DIndex } from "@babylonjs/lite";
        const engine = await createEngine({});
        const atlas = await loadSpriteAtlas(engine, "atlas.png", { gridSize: [32, 32] });
        const layer = createSprite2DLayer(atlas, { capacity: 256, depth: "none" });
        const options = { frame: (index: number): number => index % 16 };
        function tint(index: number): [number, number, number, number] {
            if (index === 0) return [1, 1, 1, 1];
            return [0.5, 1, 0.5, 1];
        }
        for (let row = 0; row < 10; row++) {
            for (let column = 0; column < 25; column++) {
                const index = row * 25 + column;
                addSprite2DIndex(layer, { positionPx: [column * 40, row * 40],
                    sizePx: [32,32], frame: options.frame(index), color: tint(index) });
            }
        }
    `);
    assert.equal(result.cpp.match(/bbl::add_sprite_2d_index\(/g)?.length, 1);
    assert.equal(result.cpp.match(/for \(;/g)?.length, 2);
    assert.ok(Buffer.byteLength(result.cpp) < 6000);
});

test("inclusive resource loops preserve endpoint values and empty ranges", () => {
    for (const [start, end, expected] of [[1, 3, 3], [3, 3, 1], [3, 2, 0]] as const) {
        const result = compileSource(scene(`
            for (let index = ${start}; index <= ${end}; index++) {
                const box = createBox(engine, { size: index });
                box.position.x = index;
                addToScene(scene, box);
            }
        `));
        assert.equal(result.manifest.sceneMeshes.length, expected);
        assert.deepEqual(
            [...result.cpp.matchAll(/\.position\.x = (\d+)\.0;/g)].map((match) => Number(match[1])),
            Array.from({ length: expected }, (_, index) => start + index),
        );
    }
});

test("inclusive nested resource loops retain compact construction cardinality", () => {
    const result = compileSource(gridSource
        .replace("x = 0; x < 64", "x = 1; x <= 64")
        .replace("y = 0; y < 64", "y = 1; y <= 64"));
    assert.equal(result.manifest.sceneMeshes.length, 4096);
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.cpp.match(/for \(;/g)?.length, 2);
});

test("a runtime await still specializes resources reached through its arguments", () => {
    const result = compileSource(scene(`
        const picker = createGpuPicker(scene);
        for (let i = 0; i <= 39; i++) {
            await readback(picker, createSphere(engine, { segments: i + 3 }).position.x, 0);
        }
    `, `
        import { createGpuPicker, pickAsync as readback } from "@babylonjs/lite";
    `));
    assert.equal(result.cpp.match(/bbl::gpu_pick\(/g)?.length, 40);
    assert.equal(result.cpp.match(/bbl::create_sphere\(/g)?.length, 40);
    assert.equal(result.manifest.sceneMeshes.length, 40);
});

test("an inlined numeric result retains static count and evaluated helper effects", () => {
    const result = compileSource(scene(`
        let calls = 0;
        const steps = (value: number): number => {
            calls++;
            return Math.round(value * 60);
        };
        const count = steps(0.05);
        for (let index = 1; index <= count; index++) {
            addToScene(scene, createBox(engine, { size: index }));
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 3);
    assert.equal(result.cpp.match(/v_calls\+\+/g)?.length, 1);
});

test("an inlined numeric result cannot fold a written parameter to its argument", () => {
    for (const update of ["value += 1;", "value = 4;", "const values = new Float32Array([4]); value = values[0]!;"]) {
        const result = compileSource(scene(`
            const count = steps(engine, 3);
            for (let index = 1; index <= count; index++) createBox(engine, { size: index });
        `, `function steps(engine: EngineContext, value: number): number {
            ${update}
            return Math.round(value);
        }`));
        assert.match(result.cpp, /round_js\(v_\w+_value\)/);
        assert.match(result.cpp, /for \(;/);
        assert.doesNotMatch(result.cpp, /v_count = 3\.0;/);
    }
});

test("inline return inference does not fold a locally defined Math method", () => {
    const result = compileSource(scene(`
        const data = new Float32Array([4]);
        const Math = { round: (_value: number): number => data[0]! };
        const steps = (engine: EngineContext, value: number): number => Math.round(value);
        const count = steps(engine, 3);
        for (let index = 1; index <= count; index++) createBox(engine, { size: index });
    `));
    // The authored bound is 4. It is read from mutable native storage, so
    // folding the spelling Math.round(3) into three construction rows is wrong.
    assert.match(result.cpp, /for \(; \w+ <= v_count;/);
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
});

const nativeTools = optionalNativeFixtureTools();

const assignmentControls = [
    `const values: number[] = []; values.reverse(); let alias: number[] = []; alias = values; alias.push(7); let total = 0; for (const value of values) total += value; if (total !== 7) throw new Error("assignment lost its array alias");`,
    `const values: number[] = []; values.reverse(); let alias: number[] = []; alias = values; const held = alias; alias = []; alias.push(11); values.push(7); let original = 0; for (const value of held) original += value; let rebound = 0; for (const value of alias) rebound += value; if (original !== 7 || rebound !== 11) throw new Error("rebinding changed the old array");`,
    `const first: number[] = []; first.reverse(); const second: number[] = []; second.reverse(); let alias: number[] = []; alias = first; alias.push(3); alias = second; alias.push(5); let a = 0; for (const value of first) a += value; let b = 0; for (const value of second) b += value; if (a !== 3 || b !== 5) throw new Error("rebinding retained the wrong cardinality cell");`,
    `const values: number[] = []; values.reverse(); let alias: number[] = []; alias = values; alias = alias; alias.push(7); let total = 0; for (const value of values) total += value; if (total !== 7) throw new Error("self assignment changed array identity");`,
    `const values: number[] = []; values.reverse(); let alias: number[] = []; const gate = new Float32Array([1]); if (gate[0]! > 0) alias = values; values.reverse(); alias.push(7); let total = 0; for (const value of values) total += value; if (total !== 7) throw new Error("conditional alias trusted an empty source");`,
    `const values: number[] = []; values.reverse(); let alias: number[] = []; let calls = 0; function choose(): number[] { calls++; return values; } alias = choose(); alias.push(7); let total = 0; for (const value of values) total += value; if (total !== 7 || calls !== 1) throw new Error("returned alias was lost or evaluated twice");`,
    `const values = [1, 2]; let alias: number[] = []; alias = values; alias.push(4); let total = 0; for (const value of values) total += value; if (total !== 7) throw new Error("inferred array storage ignored an assigned alias");`,
    `const values = [1, 2]; let alias: number[] = []; function choose(): number[] { return values; } alias = choose(); alias.push(4); let total = 0; for (const value of values) total += value; if (total !== 7) throw new Error("returned inferred array alias was copied");`,
    `const values = [1, 2]; const wrapper = { get items(): number[] { return values; } }; let alias: number[] = []; alias = wrapper.items; alias.push(4); let total = 0; for (const value of values) total += value; if (total !== 7) throw new Error("getter array alias was copied");`,
    `const values: number[] = [7]; let alias: number[] = []; alias = values; alias = [...alias]; alias.push(5); let oldTotal = 0; for (const value of values) oldTotal += value; let newTotal = 0; for (const value of alias) newTotal += value; if (oldTotal !== 7 || newTotal !== 12) throw new Error("fresh array rebinding retained the old identity");`,
    `let values: number[] = []; const held = values; values = []; held.push(7); let oldTotal = 0; for (const value of held) oldTotal += value; let newTotal = 0; for (const value of values) newTotal += value; if (oldTotal !== 7 || newTotal !== 0) throw new Error("rebinding a snapshot owner changed its old aliases");`,
] as const;

test("ordinary array assignment shares cardinality after static elements are withdrawn", () => {
    const result = compileSource(assignmentControls[0]);
    assert.match(result.cpp, /for \(auto&& .* : v_values\)/);
    assert.match(result.cpp, /v_total \+=/);
});

test("array rebinding detaches only the destination's cardinality", () => {
    const result = compileSource(scene(`
        const meshes: Mesh[] = [];
        meshes.reverse();
        let alias: Mesh[] = [];
        alias = meshes;
        alias = [];
        alias.push(createBox(engine));
        for (const mesh of meshes) mesh.material = createStandardMaterial();
        for (const mesh of alias) mesh.material = createStandardMaterial();
        createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `));
    assert.equal(result.manifest.sceneMaterialCount, 2);
    assert.equal(result.manifest.scenePbrMaterials[0]?.materialsBefore, 1);
});

test("unproven assignment aliases cannot retain an empty-collection shortcut", () => {
    for (const source of assignmentControls.slice(4, 6)) {
        const result = compileSource(`async function main() { ${source} }`);
        assert.match(result.cpp, /for \(auto&& .* : v_values\)/);
        assert.match(result.cpp, /v_total \+=/);
    }
});

test("array-assignment and rebind controls execute with JavaScript identities", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/array-cardinality-assignment-check");
    mkdirSync(output, { recursive: true });
    const input = `async function main() { ${assignmentControls.map((source) => `{ ${source} }`).join("\n")} }`;
    const source = join(output, "assignment.cpp");
    writeFileSync(source, compileSource(input).cpp);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", source]);
    execFileSync(executable, { encoding: "utf8" });
});

test("the compact grid executes all 4096 ordered native constructions and live coordinates", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/resource-loop-runtime-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "grid.hpp"), compileSource(gridSource).cpp);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native\\include",
        "test\\fixtures\\resource-loop-runtime-check.cpp"]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /resource-loop-runtime-check: ok/);
});

test("resource effect guards do not reserialize existing literal particle graphs", (t) => {
    let serializedGraphs = 0;
    const stringify = JSON.stringify;
    t.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {
        const value: unknown = args[0];
        if (typeof value === "object" && value !== null &&
            "auditSnapshotMarker" in value && value.auditSnapshotMarker === true) ++serializedGraphs;
        return stringify(...args);
    });
    const result = compileSource(scene(`
        const graph = parseNodeParticleSource({ auditSnapshotMarker: true, blocks: [] });
        await buildNodeParticleSet(engine, scene, graph);
        let sum = 0;
        for (let i = 0; i < 1024; i++) sum += i;
        for (let j = 0; j < 1024; j++) sum += j;
        console.log(sum);
    `, `import { parseNodeParticleSource, buildNodeParticleSet } from "@babylonjs/lite";`));
    assert.equal(result.manifest.nodeParticles?.sets.length, 1);
    assert.equal(serializedGraphs, 1, "only final manifest publication needs the graph digest");
});

test("resource effect guards still detect conditional particle construction", () => {
    assert.throws(() => compileSource(scene(`
        for (let i = 0; i < 3; i++) buildParticles(engine, scene);
    `, `
        import { parseNodeParticleSource, buildNodeParticleSet } from "@babylonjs/lite";
        async function buildParticles(engine: EngineContext, scene: SceneContext): Promise<void> {
            if (Math.random() > 0.5) return;
            const graph = parseNodeParticleSource({ blocks: [] });
            await buildNodeParticleSet(engine, scene, graph);
        }
    `)), /resource-construction helper's early return requires a generation-known condition/);
});

test("accepts prefix increments and nonzero starts in counted resource loops", () => {
    const result = compileSource(scene(`
        for (let i = 7; i < 307; ++i) createBox(engine, i);
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMeshes.length, 300);
    assert.match(result.cpp, /for \(; v_\w+_i < 307\.0; \+\+v_\w+_i\)/);
});

test("parameterizes resource helpers by resolved call symbols and live numeric arguments", () => {
    const result = compileSource(scene(`
        for (let x = 0; x < 64; x++) {
            for (let y = 0; y < 64; y++) {
                spawn(engine, scene, x, y);
            }
        }
    `, `
        function spawn(engine: EngineContext, scene: SceneContext, x: number, y: number): Mesh {
            const mesh = createBox(engine, x + 1);
            mesh.position.x = x;
            mesh.position.z = y;
            addToScene(scene, mesh);
            return mesh;
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMeshes.length, 4096);
    assert.ok(Buffer.byteLength(result.cpp) < 6000);
});

test("resource classification follows import aliases rather than a callee's spelling", () => {
    const result = compileSource(scene(`
        function createBox(value: number): number { return value + 1; }
        for (let i = 0; i < 300; i++) {
            primitive(engine, createBox(i));
        }
    `, `import { createBox as primitive } from "@babylonjs/lite";`));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMeshes.length, 300);
});

test("resource helper overloads resolve to the lowered implementation body", () => {
    const result = compileSource(scene(`
        for (let i = 0; i < 300; i++) spawn(engine, i + 1);
    `, `
        function spawn(engine: EngineContext): void;
        function spawn(engine: EngineContext, size: number): void;
        function spawn(engine: EngineContext, size = 1): void {
            createBox(engine, size);
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMeshes.length, 300);
});

test("follows helper-local loops and their invariant parameter bounds", () => {
    const result = compileSource(scene(`
        for (let row = 0; row < 64; row++) {
            buildRow(engine, row, 64);
        }
    `, `
        function buildRow(engine: EngineContext, row: number, columns: number): void {
            for (let column = 0; column < columns; column++) {
                const mesh = createBox(engine);
                mesh.position.x = column;
                mesh.position.y = row;
            }
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.cpp.match(/for \(;/g)?.length, 2);
    assert.equal(result.manifest.sceneMeshes.length, 4096);
});

test("readonly class method counts preserve their call-site construction facts", () => {
    const result = compileSource(scene(`
        const field = new Bursts(engine);
        for (let slot = 0; slot < 4; slot++) field.burst(3);
    `, `
        class Bursts {
            constructor(private readonly engine: EngineContext) {}
            burst(count: number): void {
                for (let i = 0; i < count; i++) {
                    const mesh = createBox(this.engine);
                    mesh.material = createStandardMaterial();
                }
            }
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 12);
    assert.equal(result.manifest.sceneMaterialCount, 12);
});

test("mutable class method counts do not become fixed construction ordinals", () => {
    assert.throws(() => compileSource(scene(`
        const field = new Bursts(engine);
        field.burst(3);
    `, `
        class Bursts {
            constructor(private readonly engine: EngineContext) {}
            burst(count: number): void {
                for (let i = 0; i < count; i++) {
                    count--;
                    createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
                }
            }
        }
    `)), /generation-known iteration count|invariant bound/);
});

test("runtime mesh retirement keeps native continue semantics", () => {
    const result = compileSource(scene(`
        const meshes: Mesh[] = [createBox(engine)];
        for (let index = meshes.length - 1; index >= 0; index--) {
            removeFromScene(scene, meshes[index]!);
            continue;
        }
    `, `import { removeFromScene } from "@babylonjs/lite";`));
    assert.equal(result.manifest.sceneMeshes.length, 1);
    assert.match(result.cpp, /bbl::remove_from_scene\(/);
    assert.match(result.cpp, /continue;/);
});

test("static record filtering can continue before loading nested texture data", () => {
    const result = compileSource(scene(`
        const blocks = [
            { customType: "Input", name: "ignored", texture: { url: "", invertY: false } },
            { customType: "Texture", name: "loaded", texture: { url: "data:image/png;base64,iVBORw0KGgo=", invertY: true } },
        ];
        for (const block of blocks) {
            if (block.customType !== "Texture") continue;
            if (!block.texture.url) continue;
            await loadTexture2D(engine, block.texture.url, { invertY: block.texture.invertY });
        }
    `, `import { loadTexture2D } from "@babylonjs/lite";`));
    assert.equal(result.manifest.assets.length, 1);
    assert.equal(result.cpp.match(/bbl::load_file_texture\(/g)?.length, 1);
});

test("native asset discovery does not authorize variable glTF container construction", () => {
    const data = `data:model/gltf+json;base64,${Buffer.from(JSON.stringify({
        asset: { version: "2.0" }, scenes: [{ nodes: [] }], nodes: [], meshes: [],
    })).toString("base64")}`;
    assert.throws(() => compileSource(scene(`
        while (Math.random() < 0.5) await loadGltf(engine, ${JSON.stringify(data)});
    `, `import { loadGltf } from "@babylonjs/lite";`)), /generation-known iteration count/);
});

test("parameterizes nested counted and homogeneous static for-of resource loops", () => {
    const result = compileSource(scene(`
        const columns: number[] = [${Array.from({ length: 64 }, (_, i) => i).join(",")}];
        for (let row = 0; row < 64; row++) {
            for (const column of columns) {
                const mesh = createBox(engine, column + 1);
                mesh.position.y = row;
            }
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMeshes.length, 4096);
    assert.match(result.cpp, /for \(auto&& \w+ : v_columns\)/);
    assert.ok(Buffer.byteLength(result.cpp) < 6000);
});

test("parameterizes a static literal resource for-of without replaying its data expression", () => {
    const result = compileSource(scene(`
        for (const size of [${Array.from({ length: 300 }, (_, i) => i + 1).join(",")}]) {
            createBox(engine, size);
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMeshes.length, 300);
    assert.match(result.cpp, /for \(auto&&/);
    assert.ok(Buffer.byteLength(result.cpp) < 6000);
});

test("replicates mixed nested composition sequences in exact creation order", () => {
    const result = compileSource(scene(`
        for (let row = 0; row < 64; row++) {
            createBox(engine);
            for (let column = 0; column < 32; column++) {
                createPlane(engine, { width: column + 1 });
            }
        }
        createSphere(engine);
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.cpp.match(/bbl::create_plane\(/g)?.length, 1);
    assert.deepEqual(
        result.manifest.sceneMeshes.map(({ kind }) => kind),
        [...Array.from({ length: 64 }, () => ["box", ...Array<string>(32).fill("plane")]).flat(), "sphere"],
    );
});

test("keeps collected runtime handles live rather than snapshotting one loop iteration", () => {
    const result = compileSource(scene(`
        const meshes: Mesh[] = [];
        for (let i = 0; i < 300; i++) {
            const mesh = createBox(engine);
            meshes.push(mesh);
        }
        onBeforeRender(scene, () => {
            for (const mesh of meshes) mesh.rotation.y += 0.01;
        });
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.cpp.match(/\.rotation\.y \+=/g)?.length, 1);
    assert.match(result.cpp, /for \(auto&& \w+ : v_meshes\)/);
    assert.doesNotMatch(result.cpp, /handle_table/);
    assert.equal(result.manifest.sceneMeshes.length, 300);
});

test("retains cardinality after aliases are withdrawn for later material construction", () => {
    const result = compileSource(scene(`
        const meshes: Mesh[] = [];
        for (let i = 0; i < 300; i++) {
            const mesh = createBox(engine);
            meshes.push(mesh);
        }
        for (const mesh of meshes) {
            const material = createStandardMaterial();
            mesh.material = material;
        }
        createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `));
    assert.equal(result.manifest.sceneMeshes.length, 300);
    assert.equal(result.manifest.sceneMaterialCount, 301);
    assert.equal(result.manifest.scenePbrMaterials[0]?.materialsBefore, 300);
    assert.equal(result.cpp.match(/bbl::create_standard_material\(/g)?.length, 1);
});

test("array aliases and helper appends share cardinality without sharing element identity", () => {
    const result = compileSource(scene(`
        const meshes: Mesh[] = [];
        const alias = meshes;
        for (let i = 0; i < 300; i++) append(alias, engine);
        const appendAlias = meshes;
        appendAlias.push(createBox(engine));
        let readAlias = meshes;
        for (const mesh of readAlias) mesh.material = createStandardMaterial();
        createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `, `
        function append(meshes: Mesh[], engine: EngineContext): void {
            meshes.push(createBox(engine));
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 301);
    assert.equal(result.manifest.sceneMaterialCount, 302);
    assert.equal(result.manifest.scenePbrMaterials[0]?.materialsBefore, 301);
});

test("nested append multiplicities survive for a subsequent resource loop", () => {
    const result = compileSource(scene(`
        const meshes: Mesh[] = [];
        for (let x = 0; x < 64; x++) {
            for (let y = 0; y < 64; y++) meshes.push(createBox(engine));
        }
        meshes.reverse();
        for (const mesh of meshes) mesh.material = createStandardMaterial();
        createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `));
    assert.equal(result.manifest.sceneMeshes.length, 4096);
    assert.equal(result.manifest.sceneMaterialCount, 4097);
    assert.equal(result.manifest.scenePbrMaterials[0]?.materialsBefore, 4096);
    assert.equal(result.cpp.match(/bbl::create_standard_material\(/g)?.length, 1);
});

test("known collection sizes feed subsequent counted resource loops", () => {
    const result = compileSource(scene(`
        const meshes: Mesh[] = [];
        for (let i = 0; i < 300; i++) meshes.push(createBox(engine));
        for (let i = 0; i < meshes.length; i++) {
            meshes[i]!.material = createStandardMaterial();
        }
        createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `));
    assert.equal(result.manifest.sceneMaterialCount, 301);
    assert.equal(result.manifest.scenePbrMaterials[0]?.materialsBefore, 300);
});

test("known runtime members still permit bounded per-material specialization", () => {
    const result = compileSource(scene(`
        const meshes: Mesh[] = [];
        for (let i = 0; i < 100; i++) meshes.push(createBox(engine));
        for (const mesh of meshes) {
            mesh.material = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
        }
        createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `));
    assert.equal(result.manifest.sceneMaterialCount, 101);
    assert.equal(result.manifest.scenePbrMaterials.length, 101);
    assert.equal(result.manifest.scenePbrMaterials[100]?.materialsBefore, 100);
});

test("keyed collection cardinality counts distinct keys rather than updates", () => {
    const result = compileSource(scene(`
        const values = new Map<number, number>();
        const alias = values;
        alias.set(1, 1);
        alias.set(1, 2);
        values.set(2, 3);
        values.delete(1);
        for (const [, value] of values) {
            void value;
            createStandardMaterial();
        }
        values.clear();
        for (const [, value] of values) {
            void value;
            createStandardMaterial();
        }
        const choices = new Set<number>();
        choices.add(1);
        choices.add(2);
        choices.add(2);
        for (const choice of choices) {
            void choice;
            createStandardMaterial();
        }
        createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `));
    assert.equal(result.manifest.sceneMaterialCount, 4);
    assert.equal(result.manifest.scenePbrMaterials[0]?.materialsBefore, 3);
});

test("unknown-cardinality material construction cannot guess a later PBR physical slot", () => {
    assert.throws(() => compileSource(scene(`
        const meshes: Mesh[] = [];
        if (Math.random() > 0.5) meshes.push(createBox(engine));
        for (const mesh of meshes) mesh.material = createStandardMaterial();
        createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `)), /generation-known physical material slot/);
    assert.throws(() => compileSource(scene(`
        for (let i = 0; i < Math.random() * 20; i++) createStandardMaterial();
        createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `)), /generation-known physical material slot/);
    assert.throws(() => compileSource(scene(`
        for (let i = 0; i < Math.random() * 20; i++) createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    `)), /Runtime resource construction requires a generation-known iteration count/);
});

test("mixed runtime mesh identities use the unknown-mesh PBR composition path", () => {
    const result = compileSource(scene(`
        const light = createSpotLight([0, 10, 0], [0, -1, 0], 1, 1);
        addToScene(scene, light);
        createPcfSpotlightShadowGenerator(engine, light, { mapSize: 64, near: 0.1, far: 100 });
        const receiver = createBox(engine);
        receiver.receiveShadows = true;
        const meshes: Mesh[] = [receiver];
        for (let i = 0; i < 300; i++) {
            const mesh = createBox(engine);
            meshes.push(mesh);
        }
        const material = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
        for (const mesh of meshes) mesh.material = material;
    `, `import { createSpotLight, createPcfSpotlightShadowGenerator } from "@babylonjs/lite";`));
    assert.equal(result.manifest.sceneMeshes.length, 301);
    assert.equal(result.manifest.shadowGenerators.length, 1);
    assert.deepEqual(result.manifest.shadowReceiverMeshes, [0]);
    assert.deepEqual(result.manifest.scenePbrMaterials[0]?.sceneMeshIndices, []);
    assert.equal(result.manifest.scenePbrMaterials[0]?.unknownSceneMesh, true);
});

test("keeps material slot order after repeated Standard material construction", () => {
    const result = compileSource(scene(`
        for (let i = 0; i < 300; i++) {
            const material = createStandardMaterial();
            const mesh = createBox(engine);
            mesh.material = material;
        }
        const pbr = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
        const last = createSphere(engine);
        last.material = pbr;
    `));
    assert.equal(result.cpp.match(/bbl::create_standard_material\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMaterialCount, 301);
    assert.equal(result.manifest.sceneMaterialGltfAssetsBefore?.length, 301);
    assert.equal(result.manifest.scenePbrMaterials[0]?.materialsBefore, 300);
    assert.deepEqual(result.manifest.scenePbrMaterials[0]?.sceneMeshIndices, [300]);
});

test("parameterizes invariant material shape while keeping per-instance uniform values live", () => {
    const result = compileSource(scene(`
        const enabled = true;
        for (let i = 0; i < 300; i++) {
            if (enabled) {
                const material = createStandardMaterial();
                material.diffuseColor = [i / 300, 0.5, 1];
                const mesh = createBox(engine);
                mesh.material = material;
            }
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.cpp.match(/bbl::create_standard_material\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMaterialCount, 300);
    assert.equal(result.manifest.sceneMeshes.length, 300);
    assert.match(result.cpp, /set_material_diffuse_color\([^;]+bbl::js::Array<double>\{\(v_\w+_i \/ 300\.0\), 0\.5, 1\.0\}/);
});

test("repeats PBR pairing and receiver facts without duplicating runtime construction", () => {
    const result = compileSource(scene(`
        const material = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
        for (let i = 0; i < 300; i++) {
            const mesh = createBox(engine);
            mesh.material = material;
            mesh.receiveShadows = true;
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.deepEqual(result.manifest.shadowReceiverMeshes, Array.from({ length: 300 }, (_, i) => i));
    assert.deepEqual(result.manifest.scenePbrMaterials[0]?.sceneMeshIndices, result.manifest.shadowReceiverMeshes);
});

test("separate parameterized loops spend no static expansion allowance", () => {
    const result = compileSource(scene(`
        for (let i = 0; i < 4096; i++) createBox(engine, i + 1);
        for (let j = 0; j < 4096; j++) createBox(engine, j + 2);
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 2);
    assert.equal(result.manifest.sceneMeshes.length, 8192);
    assert.ok(Buffer.byteLength(result.cpp) < 3000);
});

test("a genuine per-iteration option specialization keeps bounded static lowering", () => {
    const result = compileSource(scene(`
        for (let i = 0; i < 300; i++) {
            createSphere(engine, { segments: i + 3 });
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_sphere\(/g)?.length, 300);
    assert.equal(result.manifest.sceneMeshes.length, 300);
    assert.doesNotMatch(result.cpp, /for \(;/);
});

test("enforces total static expansion across separate loops", () => {
    assert.throws(() => compileSource(scene(`
        for (let i = 0; i < 2050; i++) createSphere(engine, { segments: i + 3 });
        for (let j = 0; j < 2050; j++) createSphere(engine, { segments: j + 3 });
    `)), /Total static loop expansion exceeds 4096 static iterations/);
});

test("a caught expansion failure cannot turn a later emission probe into success", () => {
    const source = ts.createSourceFile("loop.ts", "for (;;) {}", ts.ScriptTarget.Latest, true);
    const loop = source.statements[0];
    assert.ok(loop && ts.isForStatement(loop));
    const budget = new StaticExpansionBudget((_node, message) => { throw new Error(message); });
    for (let i = 0; i < 4096; i++) {
        budget.enter(loop);
        budget.leave();
    }
    assert.throws(() => budget.enter(loop), /Total static loop expansion exceeds/);
    assert.throws(() => budget.assertWithinBudget(), /Total static loop expansion exceeds/);
    const composition = new StaticExpansionBudget((_node, message) => { throw new Error(message); });
    assert.throws(() => composition.checkComposition(loop, 65537, 0), /Resource-loop composition exceeds/);
    assert.throws(() => composition.assertWithinBudget(), /Resource-loop composition exceeds/);
});

test("helper calls cannot reset the compilation-wide static expansion allowance", () => {
    assert.throws(() => compileSource(scene(`
        build(engine);
        build(engine);
    `, `
        function build(engine: EngineContext): void {
            for (let i = 0; i < 2050; i++) createSphere(engine, { segments: i + 3 });
        }
    `)), /Total static loop expansion exceeds 4096 static iterations/);
});

test("bounds specialization in a nested resource product", () => {
    assert.throws(() => compileSource(scene(`
        for (let x = 0; x < 64; x++) {
            for (let y = 0; y < 64; y++) {
                createSphere(engine, { segments: x + y + 3 });
            }
        }
    `)), /Total static loop expansion exceeds/);
});

test("for-of specialization spends the same total static expansion allowance", () => {
    const values = Array.from({ length: 2050 }, (_, i) => i + 3).join(",");
    assert.throws(() => compileSource(scene(`
        for (const segments of [${values}]) createSphere(engine, { segments });
        for (const segments of [${values}]) createSphere(engine, { segments });
    `)), /Total static loop expansion exceeds 4096 static iterations/);
});

test("counts expanded helper emission as well as loop iterations", () => {
    assert.throws(() => compileSource(scene(`
        for (let i = 0; i < 128; i++) {
            const mesh = createSphere(engine, { segments: i + 3 });
            stretch(mesh, i);
        }
    `, `
        function stretch(mesh: Mesh, value: number): void {
            ${"mesh.position.x = value;\n".repeat(150)}
        }
    `)), /Total static loop expansion exceeds 1048576 emitted bytes/);
});

test("bounds composition facts even when the emitted runtime body is small", () => {
    assert.throws(() => compileSource(scene(`
        for (let x = 0; x < 512; x++) {
            for (let y = 0; y < 512; y++) createBox(engine);
        }
    `)), /Resource-loop composition exceeds 65536/);
});

test("static resource exits stop or skip the actual generation iteration", () => {
    const result = compileSource(scene(`
        for (let i = 0; i < 1000000; i++) {
            if (i === 2) continue;
            if (i === 5) break;
            const mesh = createBox(engine);
            mesh.position.x = i;
        }
        createPlane(engine);
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 4);
    assert.deepEqual(result.manifest.sceneMeshes.map(({ kind }) => kind), ["box", "box", "box", "box", "plane"]);
    assert.doesNotMatch(result.cpp, /break;|continue;|for \(;/);
    for (const value of [0, 1, 3, 4]) assert.match(result.cpp, new RegExp(`\\.position\\.x = ${value}\\.0;`));
});

test("empty resource loops collect no unreachable construction facts", () => {
    const result = compileSource(scene(`
        for (let i = 0; i < 0; i++) createSphere(engine, { segments: Math.random() });
        for (let i = 0; i < -1; i++) createBox(engine);
        createPlane(engine);
    `));
    assert.deepEqual(result.manifest.sceneMeshes.map(({ kind }) => kind), ["plane"]);
    assert.doesNotMatch(result.cpp, /bbl::create_box|bbl::create_sphere/);
});

test("a resource break belongs to its own nested loop", () => {
    const result = compileSource(scene(`
        for (let x = 0; x < 3; x++) {
            for (let y = 0; y < 4; y++) {
                if (y === 2) break;
                createBox(engine);
            }
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 6);
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 6);
    assert.doesNotMatch(result.cpp, /break;/);
});

test("static resource for-of exits retain exact construction counts and order", () => {
    const result = compileSource(scene(`
        const values: number[] = [0, 1, 2, 3, 4, 5];
        for (const value of values) {
            if (value === 1) continue;
            if (value === 4) break;
            const mesh = createBox(engine);
            mesh.position.x = value;
        }
        createPlane(engine);
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 3);
    assert.deepEqual(result.manifest.sceneMeshes.map(({ kind }) => kind), ["box", "box", "box", "plane"]);
    assert.doesNotMatch(result.cpp, /break;|continue;|for \(auto&&/);
});

test("a nested data loop keeps its native break under a static resource loop", () => {
    const result = compileSource(scene(`
        for (let i = 0; i < 3; i++) {
            let value = 0;
            while (value < 10) {
                value++;
                if (value === 2) break;
            }
            createBox(engine);
        }
    `));
    assert.equal(result.cpp.match(/break;/g)?.length, 3);
    assert.equal(result.manifest.sceneMeshes.length, 3);
});

test("runtime-dependent exits cannot silently corrupt resource composition counts", () => {
    for (const control of ["break", "continue"]) {
        assert.throws(() => compileSource(scene(`
            for (let i = 0; i < 300; i++) {
                if (Math.random() < 0.5) ${control};
                createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
            }
        `)), /statically unrolled .*loop requires a generation-known condition/);
    }
});

test("returns and labeled exits retain an explicit resource specialization boundary", () => {
    assert.throws(() => compileSource(scene(`
        for (let i = 0; i < 300; i++) {
            if (i === 3) return;
            createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
        }
    `)), /return from a resource loop changes its composition count/);
    assert.throws(() => compileSource(scene(`
        outer: for (let i = 0; i < 300; i++) {
            for (let j = 0; j < 2; j++) {
                if (j === 1) break outer;
                createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
            }
        }
    `)), /labeled resource-loop exit/);
});

test("runtime-dependent helper exits cannot disguise variable construction counts", () => {
    assert.throws(() => compileSource(scene(`
        for (let i = 0; i < 300; i++) maybeSpawn(engine);
    `, `
        function maybeSpawn(engine: EngineContext): void {
            if (Math.random() < 0.5) return;
            createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
        }
    `)), /resource-construction helper's early return requires a generation-known condition/);
});

test("nullable pool helpers can return before native thin-instance updates", () => {
    const result = compileSource(scene(`
        const mesh = createBox(engine);
        const matrices = new Float32Array(16 * 4);
        setThinInstances(mesh, matrices, 4);
        const slots = new Map<number, number>();
        slots.set(1, 0);
        const pools = new Map<number, Pool>();
        pools.set(1, { mesh, colors: new Float32Array(4 * 4), slots });
        for (let handle = 0; handle < 4; handle++) {
            writeInstance(pools, handle);
        }
    `, `
        import { mat4Compose, setThinInstances, setThinInstanceMatrix, setThinInstanceColors } from "@babylonjs/lite";
        interface Pool {
            mesh: Mesh;
            colors: Float32Array;
            slots: Map<number, number>;
        }
        function poolOf(pools: Map<number, Pool>, handle: number): Pool | null {
            return pools.get(handle) ?? null;
        }
        function writeInstance(pools: Map<number, Pool>, handle: number): void {
            const pool = poolOf(pools, handle);
            if (!pool) return;
            const slot = pool.slots.get(handle)!;
            const matrix = mat4Compose(handle, 0, 0, 0, 0, 0, 1, 1, 1, 1);
            setThinInstanceMatrix(pool.mesh, slot, matrix);
            setThinInstanceColors(pool.mesh, pool.colors);
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 1);
    assert.equal(result.manifest.sceneMeshes[0]?.thinInstanceColors, true);
    assert.match(result.cpp, /bbl::set_thin_instance_matrix\(/);
    assert.match(result.cpp, /bbl::set_thin_instance_colors\(/);
    const update = result.cpp.indexOf("bbl::set_thin_instance_matrix(");
    assert.match(result.cpp.slice(0, update), /\b(?:break|return);/);
});

test("a helper can return after unconditional construction and before runtime mutation", () => {
    const result = compileSource(scene(`
        for (let i = 0; i < 4; i++) spawn(engine, i);
    `, `
        function spawn(engine: EngineContext, x: number): void {
            const mesh = createBox(engine);
            if (Math.random() < 0.5) return;
            mesh.position.x = x;
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 1);
    assert.equal(result.manifest.sceneMeshes[0]!.runtimeInstances, true);
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.cpp.match(/\.position\.x =/g)?.length, 1);
});

test("a helper exit still refuses construction hidden in a nested call", () => {
    assert.throws(() => compileSource(scene(`
        for (let i = 0; i < 4; i++) maybeSpawn(engine);
    `, `
        function spawn(engine: EngineContext): void { createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 }); }
        function maybeSpawn(engine: EngineContext): void {
            if (Math.random() < 0.5) return;
            spawn(engine);
        }
    `)), /resource-construction helper's early return requires a generation-known condition/);
});

test("materializes large generation-known record members for native instance updates", () => {
    const result = compileSource(scene(`
        const mesh = createBox(engine);
        const matrices = new Float32Array(16);
        setThinInstances(mesh, matrices, 1);
        updateRows({ rows: [${Array.from({ length: 87 }, (_, id) => `{ id: ${id} }`).join(",")}] }, mesh);
    `, `
        import { mat4Compose, setThinInstances, setThinInstanceMatrix } from "@babylonjs/lite";
        interface Row { id: number }
        function updateRows(json: unknown, mesh: Mesh): void {
            const file = json as { rows?: Row[] } | null;
            if (!file || !Array.isArray(file.rows)) return;
            for (const row of file.rows) {
                const matrix = mat4Compose(row.id, 0, 0, 0, 0, 0, 1, 1, 1, 1);
                setThinInstanceMatrix(mesh, 0, matrix);
            }
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 1);
    assert.equal(result.cpp.match(/bbl::set_thin_instance_matrix\(/g)?.length, 1);
    assert.match(result.cpp, /for \(auto&&/);
});

test("small sign loops do not duplicate an expensive data callback", () => {
    const result = compileSource(`
        let total = 0;
        const patch = (sign: number): void => {
            ${"total += sign;\n".repeat(80)}
        };
        for (const sign of [1, -1] as const) patch(sign);
    `);
    assert.match(result.cpp, /for \(auto&&/);
    assert.equal(result.cpp.match(/v_total \+=/g)?.length, 80);
});

test("materializing a literal data iteration evaluates each operand only once", () => {
    const result = compileSource(`
        async function main(): Promise<void> {
            let calls = 0;
            let total = 0;
            function next(): number { calls++; return calls; }
            for (const value of [next(), next()]) {
                ${"total += value;\n".repeat(80)}
            }
        }
    `);
    assert.match(result.cpp, /for \(auto&&/);
    assert.equal(result.cpp.match(/v_calls\+\+;/g)?.length, 2);
    assert.equal(result.cpp.match(/v_total \+=/g)?.length, 80);
});

test("nonconforming decoded rows retain their checked static filtering path", () => {
    const result = compileSource(`
        interface Row { value: number }
        function consume(json: unknown): number {
            const file = json as { rows: Row[] };
            let total = 0;
            for (const raw of file.rows) {
                const row = raw as Partial<Row>;
                if (typeof row.value !== "number") continue;
                total += row.value;
            }
            return total;
        }
        const total = consume({ rows: [
            { value: "invalid" },
            ${Array.from({ length: 39 }, (_, value) => `{ value: ${value} }`).join(",")}
        ] });
    `);
    assert.doesNotMatch(result.cpp, /for \(auto&&/);
    assert.equal(result.cpp.match(/total \+=/g)?.length, 39);
});

test("DOM construction keeps its static label and retained-callback specialization", () => {
    const result = compileSource(scene(`
        for (const tool of [
            { label: "Move", key: "1" }, { label: "Scale", key: "2" },
            ${Array.from({ length: 38 }, (_, i) => `{ label: "Other", key: "${i + 3}" }`).join(",")}
        ]) {
            const button = document.createElement("button");
            button.setAttribute("aria-label", tool.label + " " + tool.key);
            button.addEventListener("click", () => {
                button.setAttribute("data-selected", tool.key);
            });
            document.body.appendChild(button);
        }
        scene.camera = createArcRotateCamera(0, 1, 4, [0, 0, 0]);
        registerScene(scene);
        await startEngine(engine);
    `, `import { createArcRotateCamera, registerScene, startEngine } from "@babylonjs/lite";`));
    assert.match(result.cpp, /Move 1/);
    assert.match(result.cpp, /Scale 2/);
    assert.doesNotMatch(result.cpp, /for \(auto&&/);
});

test("bound creator callbacks keep their per-iteration construction facts", () => {
    const result = compileSource(scene(`
        visit([${Array.from({ length: 87 }, (_, id) => id).join(",")}], () => { createBox(engine); });
    `, `
        function visit(values: readonly number[], create: () => void): void {
            for (const value of values) {
                void value;
                create();
            }
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 87);
});

test("loop-index mutation checks use symbols, including calls to capturing helpers", () => {
    const result = compileSource(scene(`
        for (let i = 0; i < 300; i++) {
            {
                let i = 0;
                i++;
            }
            createBox(engine);
        }
    `));
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMeshes.length, 300);
    for (const mutation of ["i *= 2;", "function jump() { i++; } jump();"]) {
        assert.throws(() => compileSource(scene(`
            for (let i = 0; i < 10; i++) {
                ${mutation}
                createBox(engine);
            }
        `)), /Static index-loop bodies cannot mutate the loop index/);
    }
});

test("mutable helper parameter bounds cannot be mistaken for fixed resource counts", () => {
    assert.throws(() => compileSource(scene(`
        build(engine, 300);
    `, `
        function build(engine: EngineContext, count: number): void {
            for (let i = 0; i < count; i++) {
                count--;
                createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
            }
        }
    `)), /static resource loop requires an invariant bound/);
});

test("bound-alias analysis type-checks only initializers rooted in tracked aliases", () => {
    const { checker, sourceFile } = createCompilerProgram(`
        const limit = { value: 8 };
        const alias = limit;
        const unrelated = { value: 1 };
        ${Array.from({ length: 128 }, (_, i) =>
            `const ignored${i} = unrelated; const scalar${i} = ${i};`,
        ).join("\n")}
        for (let i = 0; i < limit.value; i++) { alias.value--; }
    `, "input.ts");
    const loop = sourceFile.statements.find(ts.isForStatement);
    const alias = sourceFile.statements[1];
    assert.ok(loop?.condition && ts.isBinaryExpression(loop.condition));
    assert.ok(alias && ts.isVariableStatement(alias));
    const initializer = alias.declarationList.declarations[0]?.initializer;
    assert.ok(initializer);
    const queried: ts.Node[] = [];
    const original = checker.getTypeAtLocation;
    checker.getTypeAtLocation = (node) => {
        queried.push(node);
        return original(node);
    };
    try {
        assert.equal(loopBoundMayChange(
            { checker, symbols: new CompilerSymbols(checker) },
            loop.statement,
            loop.condition.right,
        ), true);
        assert.ok(queried.length > 0 && queried.length <= 2);
        assert.ok(queried.every((node) => node === initializer));
    } finally {
        checker.getTypeAtLocation = original;
    }
});

test("resource-loop generation is deterministic", () => {
    const source = scene(`
        for (let i = 0; i < 300; i++) createBox(engine, i + 1);
    `);
    assert.deepEqual(compileSource(source), compileSource(source));
});
