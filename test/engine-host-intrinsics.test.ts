import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";

/**
 * Engine calls whose pinned effect native frame loops and generation already
 * own, and the `performance.timeOrigin` read.
 */

const compile = (body: string) =>
    compileSource(`
        import {
            createEngine,
            enableShaderMaterialUniformCaching,
            resizeEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            ${body}
        }
    `);

test("accepts resizeEngine and shader uniform caching with nothing left to run", () => {
    const { cpp } = compile(`
        enableShaderMaterialUniformCaching();
        resizeEngine(engine);
    `);
    assert.doesNotMatch(cpp, /resize|uniform_caching/i);
});

test("the pinned uniform caching only swaps the shader uniform writers", () => {
    const context = new LoweringContext();
    const { declaration } = context.functionDeclaration(
        "src/material/shader/enable-shader-material-uniform-caching.ts",
        "enableShaderMaterialUniformCaching",
    );
    context.assertStatementShapes(
        declaration,
        declaration.body!.statements,
        "_installShaderUniformWriters(writeCachedSystemUniforms, writeCachedCustomUniforms);",
        "shader uniform caching",
    );
});

test("reads performance.timeOrigin as the epoch time of the performance clock's zero", () => {
    const { cpp } = compile(`
        const origin = performance.timeOrigin;
        console.log(origin + performance.now());
    `);
    assert.match(cpp, /bbl::pal::performance_time_origin\(\)/);
});
