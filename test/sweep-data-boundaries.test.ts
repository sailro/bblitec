import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("scalar reads in newly allocated wrappers do not make an input mutable", () => {
    const { cpp } = compileSource(`
        function copy(input: Float32Array): Float32Array {
            const output = new Float32Array(input.length);
            let first = input[0]!;
            first += 1;
            output[0] = first;
            return output;
        }
        const data = new Float32Array([1, 2]);
        const result = copy(data);
        console.log(result[0]);
    `);
    assert.match(cpp, /copy\(const bbl::js::F32Array&/);
});

test("closed Record slots establish object identity before aggregate emission", () => {
    const { cpp } = compileSource(`
        type Slot = "left" | "right";
        interface Entry { count: number; values: number[]; }
        interface Owner { slots: Record<Slot, Entry>; }
        function make(count: number): Entry { return { count, values: [] }; }
        const owner: Owner = { slots: { left: make(1), right: make(2) } };
        const entries: Entry[] = [owner.slots.left];
        entries[0]!.count += 1;
        console.log(owner.slots.left.count);
    `);
    assert.match(cpp, /make_ref<bblscene::EntryData>/);
    assert.doesNotMatch(cpp, /bblscene::Entry\{[^}]*,/);
});

const nativeTools = optionalNativeFixtureTools();

function runDataProgram(name: string, source: string): string {
    const { cpp } = compileSource(source);
    const output = resolve("artifacts", name);
    mkdirSync(output, { recursive: true });
    const sourceFile = join(output, "generated.cpp");
    const executable = join(output, `${name}.exe`);
    writeFileSync(sourceFile, cpp);
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/permissive-",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include",
        sourceFile, "test/fixtures/js-callback/data-engine-stubs.cpp",
    ]);
    execFileSync(executable, [], { encoding: "utf8" });
    return cpp;
}

test("inferred factory records share replaced buffers across stored owners", { skip: !nativeTools }, () => {
    const cpp = runDataProgram("inferred-pool-identity", `
        import { createEngine, createBox } from "babylon-lite";
        import type { Mesh, EngineContext } from "babylon-lite";
        interface Pool { mesh: Mesh; values: Float32Array; count: number; }
        type Key = "left" | "right";
        interface Owner { pools: Record<Key, Pool>; }
        class Holder { constructor(public readonly owner: Owner) {} }
        function make(engine: EngineContext, count: number): Pool {
            const mesh = createBox(engine);
            return { mesh, values: new Float32Array([count]), count };
        }
        async function makeOwner(engine: EngineContext): Promise<Owner> {
            const left = make(engine, 1);
            const right = make(engine, 2);
            return { pools: { left, right } };
        }
        const engine = await createEngine({});
        const owner = await makeOwner(engine);
        const first = new Holder(owner);
        const second = new Holder(owner);
        const key: Key = Math.random() < 2 ? "left" : "right";
        const pool = first.owner.pools[key];
        pool.values = new Float32Array([3, 4, 5]);
        pool.count += 2;
        if (second.owner.pools[key].values.length !== 3) throw new Error("replacement lost");
        if (second.owner.pools[key].count !== 3) throw new Error("count alias lost");
    `);
    assert.equal((cpp.match(/make_ref<bblscene::PoolData>/g) ?? []).length, 2);
    assert.ok((cpp.match(/make_ref<bblscene::OwnerData>/g) ?? []).length <= 1);
    assert.doesNotMatch(cpp, /std::make_shared<(?:double|bbl::js::F32Array)>/);
});

test("runtime numeric tuple predicates preserve indices and short-circuiting", { skip: !nativeTools }, () => {
    runDataProgram("tuple-predicate-observers", `
        const values: [number, number, number] = [Math.random(), 1, 2];
        let calls = 0;
        const all = values.every((value, index, array) => {
            calls++;
            return Number.isFinite(value) && index < 1 && array.length === 3;
        });
        if (all || calls !== 2) throw new Error("every did not short-circuit");
        calls = 0;
        const some = values.some((value, index, array) => {
            calls++;
            return value === 1 && index === 1 && array.length === 3;
        });
        if (!some || calls !== 2) throw new Error("some did not short-circuit");
    `);
});

test("stored scalar records retain their compile-time spread and enumeration metadata", { skip: !nativeTools }, () => {
    runDataProgram("scalar-record-projections", `
        import { createEngine, createBox } from "babylon-lite";
        import type { EngineContext } from "babylon-lite";
        interface Point { x: number; z: number; }
        async function makePoint(engine: EngineContext): Promise<Point> {
            const mesh = createBox(engine);
            return { x: mesh.position.x, z: 2 };
        }
        const engine = await createEngine({});
        const point = await makePoint(engine);
        const retained: Point[] = [point];
        const copy = { ...point, heading: 4 };
        const values = Object.values(point);
        if (copy.x !== retained[0]!.x || copy.heading !== 4 || values[1] !== point.z) {
            throw new Error("record projection changed");
        }
    `);
});

test("equivalent stored record types agree on native parameter member access", () => {
    const { cpp } = compileSource(`
        interface Bounds { low: number; high: number; }
        interface StoredBounds { low: number; high: number; }
        function width(bounds: Bounds): number {
            const limits = [bounds.low, bounds.high];
            return limits[1]! - limits[0]!;
        }
        console.log(width({ low: 1, high: 3 }));
        const saved: StoredBounds[] = [{ low: 2, high: 4 }];
        console.log(saved[0]!.high);
    `);
    assert.match(cpp, /bounds->low/);
    assert.doesNotMatch(cpp, /bounds\.low/);
});

test("native numeric producers and typed-array fill/slice retain their ownership rules", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/typed-array-boundary-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "typed-array-boundary-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/permissive-",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include",
        "test/fixtures/js-callback/typed-array-boundary-check.cpp",
    ]);
    assert.match(execFileSync(executable, [], { encoding: "utf8" }), /typed-array-boundary-check: ok/);
});
