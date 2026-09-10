import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const handles = `
    import { createEngine, createBox } from "@babylonjs/lite";
    class Walker {
        visit(callback: (value: number) => number): number {
            let total = 0;
            for (let i = 0; i < 4; i++) total += callback(i);
            return total;
        }
    }
    async function main() {
        const engine = await createEngine({});
        const a = createBox(engine), b = createBox(engine), c = createBox(engine), d = createBox(engine);
        for (const mesh of [a, b, a, d] as const) mesh.position.x += 1;
        if (a.position.x !== 2 || b.position.x !== 1 || c.position.x !== 0 || d.position.x !== 1)
            throw new Error("Compaction changed handle order or multiplicity");
        let total = 0;
        for (let i = 0; i < 4; i++) total += i;
        for (const value of [1, 2, 3, 4]) total += value;
        if (total !== 16) throw new Error("Compaction changed numeric iteration");
        const values = new Uint8Array([1, 2, 3, 4]);
        const read = (index: number): number => values[index]!;
        const walker = new Walker();
        if (walker.visit(read) !== 10) throw new Error("Compaction changed an immediate callback");
    }
`;

test("four-element handle literals and numeric walks emit compact loops", () => {
    const result = compileSource(handles);
    assert.equal(result.cpp.match(/\.position\.x \+=/g)?.length, 1);
    assert.match(result.cpp, /handle_table_\d+\[4\]/);
    assert.equal(result.cpp.match(/v_total \+=/g)?.length, 2);
    assert.equal(result.manifest.sceneMeshes.length, 4);
});

test("short handle walks stay flat and conditional bodies use native identity", () => {
    const short = compileSource(handles.replace("[a, b, a, d]", "[a, b, d]"));
    assert.doesNotMatch(short.cpp, /handle_table/);
    const divergent = compileSource(handles.replace("mesh.position.x += 1", "mesh.position.x += mesh === a ? 2 : 1"));
    assert.match(divergent.cpp, /handle_table/);
    assert.equal(divergent.cpp.match(/\.position\.x \+=/g)?.length, 1);
    assert.match(divergent.cpp, /\.value == v_a.value/);
});

test("loops over handle property names retain static key dispatch", () => {
    const result = compileSource(`
        import { createEngine, createPbrMaterial, type Texture2D } from "@babylonjs/lite";
        const engine = await createEngine({});
        const material = createPbrMaterial({});
        const textures: Texture2D[] = [];
        for (const field of ["baseColorTexture", "normalTexture", "ormTexture", "emissiveTexture", "occlusionTexture"] as const) {
            const texture = material[field];
            if (texture && !textures.includes(texture)) textures.push(texture);
        }
    `);
    assert.doesNotMatch(result.cpp, /for \(auto&&/);
    assert.equal(result.manifest.sceneMaterialCount, 1);
});

const tools = optionalNativeFixtureTools();
test("loops over record property names retain static assignments", () => {
    const result = compileSource(`
        import { createEngine, createBox, type Mesh } from "@babylonjs/lite";
        const engine = await createEngine({});
        const a = createBox(engine);
        const record = {} as Record<"a" | "b" | "c" | "d", Mesh>;
        for (const key of ["a", "b", "c", "d"] as const) record[key] = a;
        record.d.position.x = 7;
    `);
    assert.equal(result.manifest.sceneMeshes.length, 1);
    assert.match(result.cpp, /\.position\.x = 7/);
});

test("compact small loops preserve native handle aliases and numeric results", { skip: !tools }, () => {
    const directory = resolve("artifacts/small-loop-compaction");
    mkdirSync(directory, { recursive: true });
    for (const [name, source] of [
        ["regular", handles],
        ["conditional", handles.replace("mesh.position.x += 1", "mesh.position.x += mesh === a ? 2 : 1")
            .replace("a.position.x !== 2", "a.position.x !== 4")],
    ] as const) {
    const path = join(directory, `${name}.cpp`), executable = join(directory, `${name}.exe`);
    writeFileSync(path, compileSource(source).cpp + `
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            MeshHandle create_box(Engine& engine, BoxOptions) {
                const auto index = static_cast<std::uint32_t>(engine.meshes.size());
                engine.meshes.emplace_back();
                return {index};
            }
            void mark_mesh_dirty(Engine&, MeshHandle) {}
        }
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${directory}\\`, `/Fe:${executable}`, "/I", "native/include", path]);
    execFileSync(executable, { stdio: "pipe" });
    }
});
