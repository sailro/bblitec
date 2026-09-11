import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

test("engine contexts retain identity across caches, arrays and helper parameters", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        import type { EngineContext } from "@babylonjs/lite";
        const cache = new WeakMap<EngineContext, number>();
        const first = await createEngine({});
        cache.set(first, 3);
        const engines: EngineContext[] = [first, first];
        function lookup(engine: EngineContext): number { return cache.get(engine) ?? -1; }
        let sum = 0;
        for (let i = 0; i < first.drawCallCount; i++) sum += lookup(engines[i]!);
        if (sum !== 6 || cache.get(first) !== 3) throw new Error("retained engine identity");
        cache.delete(engines[1]!);
        if (cache.has(first)) throw new Error("aliased cache key");
    `);
    const output = resolve("artifacts/stored-engine-context");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), result.cpp);
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, `
        #define main generated_main
        #include "program.hpp"
        #undef main
        namespace bbl {
            Engine create_engine(EngineOptions) {
                Engine engine;
                engine.draw_call_count = 2;
                return engine;
            }
        }
        int main() { return generated_main(); }
    `);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
