/**
 * Lazily imported module graphs as a library ships them: bindings nothing
 * reads stay unevaluated, uninitialized `let`s hold undefined, modules of
 * types only re-export nothing to run, and a namespace held in a record or
 * awaited in place calls its exports.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function writeModules(
    directory: string,
    modules: Readonly<Record<string, string>>,
): void {
    mkdirSync(directory, { recursive: true });
    for (const [name, source] of Object.entries(modules))
        writeFileSync(join(directory, name), source);
}

test("a lazy library evaluates only the bindings its reached code reads", (t) => {
    const directory = resolve("artifacts/lazy-module-reach");
    writeModules(directory, {
        // A module of types only: its re-export runs nothing.
        "types.d.ts": `export type Vec = [number, number, number];`,
        "math.ts": `export * from "./types.js";
            import type { Vec } from "./types.js";
            export const create = (): Vec => [0, 0, 0];
            export const add = (out: Vec, a: Vec, b: Vec): Vec => { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out; };`,
        // Scratch storage no reached function reads holds values no native
        // storage represents: it is never evaluated.
        "library.ts": `import { create, add, type Vec } from "./math.js";
            const scratchNeverRead = new Array(7 * 3);
            const _scratch = create();
            let _cache: number[] | undefined;
            export function unreached(): number { scratchNeverRead[0] = 1; return scratchNeverRead.length; }
            export function sum(a: number, b: number): number {
                add(_scratch, [a, 0, 0], [b, 0, 0]);
                _cache ??= [];
                _cache.push(_scratch[0]);
                return _scratch[0] + _cache.length - 1;
            }
            export const filter = {
                flags: 1,
                pass(flags: number): boolean { return (flags & this.flags) !== 0; },
            };
            export function spread(values: any, index: number): number { return values[index]; }
            // A tuple a shared body writes through is its caller's own.
            const fill = (out: Vec, value: number, scale = 1): Vec => { out[0] = value; out[1] = value * 2 * scale; out[2] = value * 3; return out; };
            export function fillAll(values: { v: number }[]): number { let total = 0; for (const item of values) { fill(_scratch, item.v, 2); total += _scratch[0] + _scratch[1] + _scratch[2]; } fill(_scratch, 1); return total + _scratch[1]; }`,
        "runtime.ts": `export async function load() { return import("./library.js"); }`,
    });
    const result = compileSource(
        `import type * as Library from "./library.js";
        interface Holder { api: typeof Library | null; total: number }
        void (async () => {
            const api = await import("./library.js");
            const holder: Holder = { api, total: 0 };
            holder.total = holder.api!.sum(2, 3);
            if (holder.total !== 5) throw new Error("namespace in a record slot");
            if ((await import("./library.js")).sum(1, 1) !== 3) throw new Error("awaited namespace receiver");
            if (!holder.api!.filter.pass(3) || holder.api!.filter.pass(2)) throw new Error("home-object method");
            if (api.spread([4, 5], 1) !== 5) throw new Error("indexed any read");
            const items = JSON.parse('[{"v":1},{"v":2}]') as { v: number }[];
            if (api.fillAll(items) !== 26) throw new Error("tuple written through a shared body " + api.fillAll(items));
            holder.api = null;
            let threw = false;
            try { holder.api!.sum(1, 1); } catch { threw = true; }
            if (!threw) throw new Error("absent namespace");
            globalThis.close();
        })();`,
        { fileName: join(directory, "entry.ts") },
    );
    assert.doesNotMatch(
        result.cpp,
        /scratchNeverRead/,
        "a binding no reached code reads is not evaluated",
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "lazy-module-reach", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
    });
});

test("reading a lazy namespace reflectively evaluates every binding", () => {
    const directory = resolve("artifacts/lazy-module-reflection");
    writeModules(directory, {
        "library.ts": `const scratchNeverRead = new Array(7 * 3); export const value = 1;`,
    });
    assert.throws(
        () =>
            compileSource(
                `void (async () => { const all = { ...(await import("./library.js")) }; if (all.value !== 1) throw new Error("spread"); })();`,
                { fileName: join(directory, "entry.ts") },
            ),
        /Lazy module bindings require an owned data representation/,
    );
});
