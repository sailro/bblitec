import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("finally sees a generation-only binding assigned within each static loop scope", () => {
    const result = compileSource(`
        import { createEngine, createBox, createCsgFromMesh, createMeshFromCsg } from "@babylonjs/lite";
        const engine = await createEngine({});
        for (const size of [1, 2]) {
            let solid: ReturnType<typeof createCsgFromMesh> | undefined;
            try {
                solid = createCsgFromMesh(createBox(engine, size));
            } finally {
                if (solid) {
                    createMeshFromCsg(engine, solid, "reached");
                } else {
                    throw new Error("unreachable missing solid");
                }
            }
        }
    `);
    assert.equal(result.manifest.sceneMeshes.length, 4);
    assert.equal(result.cpp.match(/bbl::create_mesh_from_data\(/g)?.length, 2);
    assert.doesNotMatch(result.cpp, /unreachable missing solid/);
});

test("a nested loop cannot establish an outer generation-only binding", () => {
    assert.throws(() => compileSource(`
        import { createEngine, createBox, createCsgFromMesh } from "@babylonjs/lite";
        const engine = await createEngine({});
        let solid: ReturnType<typeof createCsgFromMesh> | undefined;
        for (const size of [1, 2]) {
            solid = createCsgFromMesh(createBox(engine, size));
        }
    `), /assigned inside a ForOfStatement/);
});

const nativeTools = optionalNativeFixtureTools();
test("native finally preserves return, catch, break and cleanup order", { skip: !nativeTools }, () => {
    const result = compileSource(`
        const seen: number[] = [];
        function settle(mode: number, seen: number[]): number {
            let value = 1;
            try {
                if (mode === 1) return value;
                if (mode === 2) throw new Error("caught");
                value = 3;
            } catch {
                value = 4;
            } finally {
                value += 10;
                seen.push(value);
            }
            return value;
        }
        if (settle(0, seen) !== 13 || settle(1, seen) !== 1 || settle(2, seen) !== 14) throw new Error("finally results");
        if (seen.length !== 3 || seen[0] !== 13 || seen[1] !== 11 || seen[2] !== 14) throw new Error("finally order");
        function abort(seen: number[]): void {
            try {
                throw new Error("unwind");
            } finally {
                seen.push(99);
            }
        }
        try { abort(seen); } catch {}
        if (seen.length !== 4 || seen[3] !== 99) throw new Error("unwind cleanup");
        let cleanup = 0;
        for (let i = 0; i < 3; i++) {
            try {
                if (i === 1) break;
                cleanup += i;
            } finally {
                cleanup += 10;
            }
        }
        if (cleanup !== 20) throw new Error("break cleanup");
    `);
    const output = resolve("artifacts/compiler-finally-bindings");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", source,
    ]);
    execFileSync(executable, { stdio: "pipe" });
});
