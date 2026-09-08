import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

function runProgram(name: string, source: string): string {
    const { cpp } = compileSource(source);
    const output = resolve("artifacts", "physics-enum-vector-alias", name);
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp");
    const dirty = join(output, "dirty.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(file, cpp);
    // Observe the identity passed to the already-tested dirty helper; these
    // compiler tests exercise generated alias storage without opening a GPU.
    writeFileSync(dirty, `#include <bblite/runtime.hpp>
        namespace bbl {
        void mark_mesh_dirty(Engine& engine, MeshHandle mesh) {
            engine.meshes.at(mesh.value).gpu_world_transform = true;
        }
        }`);
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/permissive-",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include",
        file, dirty, "test/fixtures/js-callback/data-engine-stubs.cpp",
    ]);
    execFileSync(executable, [], { encoding: "utf8" });
    return cpp;
}

test("pinned const enum bags retain numeric values in native arrays and helpers", { skip: !tools }, () => {
    runProgram("enum-values", `
        import { PhysicsMotionType as Motion, PhysicsPrestepType as Prestep } from "babylon-lite";
        function encode(values: number[]): number {
            let result = 0;
            for (const value of values) result = result * 10 + value;
            return result;
        }
        const motions = [Motion.STATIC, Motion.ANIMATED, Motion.DYNAMIC];
        const presteps = [Prestep.ACTION, Prestep.DISABLED, Prestep.TELEPORT];
        if (encode(motions) !== 12 || encode(presteps) !== 201) throw new Error("enum values changed");
        const PhysicsMotionType = { STATIC: 9 };
        PhysicsMotionType.STATIC = 7;
        if (PhysicsMotionType.STATIC !== 7) throw new Error("local enum bag was folded");
    `);
});

test("observable vector aliases retain handles across index changes and arena growth", { skip: !tools }, () => {
    const cpp = runProgram("vector-identity", `
        import { createEngine, createBox } from "babylon-lite";
        import type { Mesh } from "babylon-lite";
        const engine = await createEngine({});
        const first = createBox(engine);
        const second = createBox(engine);
        const meshes: Mesh[] = [first, second];
        let index = 0;
        const p = meshes[index]!.position;
        const alias = p;
        index = 1;
        const count = new Float32Array([128]);
        for (let i = 0; i < count[0]!; i++) createBox(engine);
        p.set(1.0000000001, 2, 3);
        alias.set(alias.x + 4, alias.y + 5, alias.z + 6);
        if (first.position.x !== 5.0000000001 || first.position.y !== 7 || first.position.z !== 9)
            throw new Error("alias lost node identity or double precision");
        if (second.position.x !== 0) throw new Error("alias followed replaced array element");
        const scale = first.scaling;
        scale.set(2, 3, 4);
        if (first.scaling.z !== 4) throw new Error("scaling alias lost");
    `);
    assert.match(cpp, /const auto \w+vector_owner\w* =/);
    assert.match(cpp, /mark_mesh_dirty\([^;]*vector_owner/);
});

test("vector aliases returned by helpers survive retained callback captures", { skip: !tools }, () => {
    runProgram("retained-vector", `
        import { createEngine, createBox } from "babylon-lite";
        import type { Mesh } from "babylon-lite";
        function position(mesh: Mesh) { return mesh.position; }
        const engine = await createEngine({});
        const mesh = createBox(engine);
        const callbacks: (() => void)[] = [];
        {
            const p = position(mesh);
            callbacks.push(() => { p.set(0, 0, 0); });
            callbacks.push(() => { p.set(p.x + 1, p.y + 2, p.z + 3); });
        }
        for (const callback of callbacks) callback();
        for (const callback of callbacks) callback();
        if (mesh.position.x !== 1 || mesh.position.y !== 2 || mesh.position.z !== 3)
            throw new Error("retained vector no longer addresses its mesh");
    `);
});

test("exact scene106 lowers enum array sinks and its physics-step vector alias", () => {
    const fileName = "corpus/babylon-lite/lab/lite/src/lite/scene106.ts";
    const source = readFileSync(fileName, "utf8");
    const { cpp } = compileSource(source, { fileName });
    assert.match(cpp, /static_cast<bbl::upstream::PhysicsMotionType>\(/);
    assert.match(cpp, /static_cast<bbl::upstream::PhysicsPrestepType>\(/);
    assert.match(cpp, /mark_mesh_runtime_transform\([^;]*vector_owner/);
    assert.throws(() => compileSource(source.replace(
        "motions[motion]!", "Math.random()",
    ), { fileName }), /Expected a value of the pinned PhysicsMotionType enum/);
    assert.throws(() => compileSource(source.replace(
        "presteps[prestep]!", "9",
    ), { fileName }), /Expected a value of the pinned PhysicsPrestepType enum/);
});

test("untyped handles keep native storage and metadata after selected static branches", { skip: !tools }, () => {
    runProgram("untyped-handle", `
        import { createEngine, createBox } from "babylon-lite";
        const engine = await createEngine({});
        let mesh;
        if (true) { mesh = createBox(engine); } else { mesh = createBox(engine); }
        mesh.position.set(1, 2, 3);
        const original = mesh;
        if (false) { mesh = original; } else { mesh = createBox(engine); }
        mesh.position.set(4, 5, 6);
        if (original.position.x !== 1 || mesh.position.x !== 4) throw new Error("selected handle identity changed");
    `);
});

test("untyped handle inference refuses mixed writes and reads before assignment", () => {
    const prefix = `import { createEngine, createBox } from "babylon-lite"; const engine = await createEngine({});`;
    assert.throws(() => compileSource(`${prefix} let mesh; mesh = createBox(engine); mesh = 3;`), /native data type/);
    assert.throws(() => compileSource(`${prefix} let mesh; if (mesh) throw new Error("early read"); mesh = createBox(engine); mesh.position.x = 1;`));
    assert.throws(() => compileSource(`${prefix} let mesh = createBox(engine); const other = createBox(engine); const callbacks: (() => void)[] = []; callbacks.push(() => { if (true) { mesh = other; } }); mesh.position.x = 1;`), /nested callback/);
});
