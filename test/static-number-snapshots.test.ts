/**
 * A `const` holds the number its initializer folds to where it runs: the
 * arm its pure conditions select, over the facts its operands' reads carry
 * there. A generation-time string (a shader source) can then format it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";
import { POSITION_VERTEX_WGSL } from "./program-snippets.js";

function program(body: string, call = "build(engine, {});"): string {
    return `
import { createEngine, createShaderMaterial } from "@babylonjs/lite";
import type { EngineContext } from "@babylonjs/lite";
interface Options { range?: [number, number] }
const VERTEX = \`${POSITION_VERTEX_WGSL}\`;
function build(engine: EngineContext, opts: Options) {
    ${body}
    return createShaderMaterial({
        name: "folded",
        vertexSource: \`// \${spread.toFixed(4)}\\n\${VERTEX}\`,
        fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }",
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
    });
}
async function main() {
    const engine = await createEngine({});
    ${call}
}
void main();
`;
}

test("a local const holds its initializer's folded number", () => {
    const result = compileSource(
        program(`
    const range = opts.range ?? [0.2, 0.6];
    const middle = (range[0] + range[1]) / 2;
    const spread = middle > 0 ? (range[1] - range[0]) / (2 * middle) : 0;`),
    );
    assert.equal(
        result.manifest.customShaderPrograms[0]?.vertexSource.split("\n")[0],
        "// 0.5000",
    );
});

test("a const over a run-time total folds nothing", () => {
    assert.throws(
        () =>
            compileSource(
                program(`
    let total = 0;
    for (const value of new Float32Array([1, 2])) total += value;
    const spread = total / 2;`),
            ),
        CompileError,
    );
});
