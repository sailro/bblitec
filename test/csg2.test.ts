import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { bakeCsg2Meshes, csg2BooleanNames, type Csg2SolidPlan } from "../src/pinned-csg2.js";
import { packBakedCsgMesh, type BakedCsgMesh } from "../src/pinned-csg.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const source = (body: string): string => `
import { createEngine, createBox, createSphere, createStandardMaterial,
    initializeCsg2Async, isCsg2Ready, createCsg2FromMesh, csg2Add, csg2Subtract,
    csg2Intersect, createMeshFromCsg2, createMeshesFromCsg2, disposeCsg2 } from "babylon-lite";
const engine = await createEngine({});
${body}`;

test("CSG2 compiler preserves native material partitions and generation-only solid lifetime", () => {
    const result = compileSource(source(`
        await initializeCsg2Async();
        const material = createStandardMaterial();
        const box = createBox(engine, 2);
        box.material = material;
        const a = createCsg2FromMesh(box, 0);
        const b = createCsg2FromMesh(createSphere(engine, { diameter: 2.5, segments: 8 }), 1);
        const solid = csg2Subtract(a, b);
        const meshes = createMeshesFromCsg2(engine, solid, [material, material], "carved");
        disposeCsg2(a); disposeCsg2(b); disposeCsg2(solid); disposeCsg2(solid);
    `));
    assert.equal(result.manifest.sceneMeshes.length, 4);
    assert.equal(result.manifest.sceneMeshes.filter((mesh) => mesh.kind === "from-data" && mesh.standardMaterial).length, 2);
    assert.match(result.cpp, /"carved_sub0"/);
    assert.match(result.cpp, /"carved_sub1"/);
    assert.equal(result.cpp.match(/bbl::create_mesh_from_data\(/g)?.length, 2);
    assert.ok(result.manifest.features.includes("mesh:csg2"));
    assert.ok(result.manifest.adaptations.some((adaptation) => adaptation.id === "executed-csg2-solid"));
    assert.ok(!result.manifest.features.includes("mesh:csg"));
});

test("CSG2 rejects missing initialization, disposed aliases and unsupported source mutations", () => {
    assert.throws(() => compileSource(source(`const solid = createCsg2FromMesh(createBox(engine, 2));`)), /requires initializeCsg2Async/);
    assert.throws(() => compileSource(source(`
        await initializeCsg2Async();
        const solid = createCsg2FromMesh(createBox(engine, 2));
        const alias = solid;
        disposeCsg2(solid);
        const mesh = createMeshFromCsg2(engine, alias);
    `)), /absent or disposed/);
    for (const mutation of ["box.position.x = 1;", "const alias = box;"]) {
        assert.throws(() => compileSource(source(`
            await initializeCsg2Async();
            const box = createBox(engine, 2);
            ${mutation}
            const solid = createCsg2FromMesh(box);
        `)), /unchanged identity-transform/);
    }
    for (const slot of [-1, 65536, 0.5]) {
        assert.throws(() => compileSource(source(`
            await initializeCsg2Async();
            const solid = createCsg2FromMesh(createBox(engine, 2), ${slot});
        `)), /generation-known integer/);
    }
});

function volume(mesh: BakedCsgMesh): number {
    const p = mesh.positions;
    let result = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
        const a = 3 * mesh.indices[i]!;
        const b = 3 * mesh.indices[i + 1]!;
        const c = 3 * mesh.indices[i + 2]!;
        result += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) +
            p[a + 1]! * (p[b + 2]! * p[c]! - p[b]! * p[c + 2]!) +
            p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
    }
    return Math.abs(result / 6);
}

const box: Csg2SolidPlan = { op: "from-mesh", source: { factory: "createBox", options: 2 }, materialSlot: 2 };
const sphere: Csg2SolidPlan = { op: "from-mesh", source: { factory: "createSphere", options: { diameter: 2.5, segments: 8 } }, materialSlot: 0 };

test("pinned CSG2 operations preserve volume and ascending material slots, including sparse slots", () => {
    const volumes = new Map<string, number>();
    for (const op of csg2BooleanNames) {
        const plan: Csg2SolidPlan = { op, left: box, right: sphere };
        const parts = bakeCsg2Meshes({ plan, name: op, materialCount: 3 });
        assert.deepEqual(parts.map((part) => part.materialSlot), [0, 2]);
        assert.deepEqual(parts.map((part) => part.name), [`${op}_sub0`, `${op}_sub2`]);
        const merged = bakeCsg2Meshes({ plan, name: op });
        assert.equal(merged.length, 1);
        assert.equal(parts.reduce((count, part) => count + part.geometry.indices.length, 0), merged[0]!.geometry.indices.length);
        volumes.set(op, volume(merged[0]!.geometry));
    }
    assert.ok(volumes.get("csg2Subtract")! > 0);
    assert.ok(volumes.get("csg2Intersect")! > 0);
    assert.ok(Math.abs(volumes.get("csg2Subtract")! + volumes.get("csg2Intersect")! - 8) < 0.00001);
    assert.ok(volumes.get("csg2Add")! > 8);
});

test("pinned CSG2 replay preserves exact bytes and refuses missing materials and empty single meshes", () => {
    const first = bakeCsg2Meshes({ plan: box, name: "first" });
    const second = bakeCsg2Meshes({ plan: box, name: "second" });
    assert.deepEqual(packBakedCsgMesh(first[0]!.geometry), packBakedCsgMesh(second[0]!.geometry));
    assert.throws(() => bakeCsg2Meshes({ plan: box, name: "missing", materialCount: 2 }), /missing.*material|material.*2|346/i);
    const empty: Csg2SolidPlan = { op: "csg2Subtract", left: box, right: box };
    assert.deepEqual(bakeCsg2Meshes({ plan: empty, name: "empty", materialCount: 3 }), []);
    assert.throws(() => bakeCsg2Meshes({ plan: empty, name: "empty" }), /empty|345/i);
});

test("CSG2 refusal boundary is anchored to the pinned slot reservation and bundled WASM", () => {
    const pin = new UpstreamSourceStore().getSource("src/mesh/csg2.ts");
    assert.match(pin, /const MATERIAL_ID_RESERVE_COUNT = 65536;/);
    assert.match(pin, /materialSlot < 0 \|\| materialSlot >= MATERIAL_ID_RESERVE_COUNT \|\| !Number.isInteger\(materialSlot\)/);
    assert.match(pin, /outputs.sort\(\(a, b\) => a.materialSlot - b.materialSlot\)/);
    assert.match(readFileSync("node_modules/@babylonjs/lite/lib/mesh/csg2.js", "utf8"), /import\('\.\.\/_chunks\/vendor\/manifold-/);
});
