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
interface Options { range?: [number, number]; start?: number; full?: number }
const DEFAULTS = { start: 0.15, full: 0.62 } as const;
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

/** The comment the program's vertex source starts with: `spread`, formatted. */
function formattedSpread(body: string): string | undefined {
    return compileSource(
        program(body),
    ).manifest.customShaderPrograms[0]?.vertexSource.split("\n")[0];
}

test("a local const holds its initializer's folded number", () => {
    assert.equal(
        formattedSpread(`
    const range = opts.range ?? [0.2, 0.6];
    const middle = (range[0] + range[1]) / 2;
    const spread = middle > 0 ? (range[1] - range[0]) / (2 * middle) : 0;`),
        "// 0.5000",
    );
});

test("a static literal record's number field folds inside a Math call", () => {
    assert.equal(
        formattedSpread(`
    const start = opts.start ?? DEFAULTS.start;
    const spread = Math.max(start + 0.05, opts.full ?? DEFAULTS.full);`),
        "// 0.6200",
    );
});

test("Number() of a string generation knows is the number JavaScript parses", () => {
    assert.equal(
        formattedSpread(
            "const spread = Number((0.32491969623290634).toFixed(4));",
        ),
        "// 0.3249",
    );
});

test("an approximated Math member formats the number JavaScript computes", () => {
    for (const [call, value] of [
        ["Math.tan(0.3)", Math.tan(0.3)],
        ["Math.pow(2, 0.5)", Math.pow(2, 0.5)],
        ["Math.hypot(0.3, 0.4, 0.5)", Math.hypot(0.3, 0.4, 0.5)],
    ] as const)
        assert.equal(
            formattedSpread(`const spread = ${call};`),
            `// ${value.toFixed(4)}`,
            call,
        );
    assert.throws(
        () => formattedSpread("const spread = Math.random();"),
        CompileError,
    );
});

test("a helper formatting an approximated Math call's number folds", () => {
    // The helper rounds to two digits; generation computes what it formats.
    assert.equal(
        formattedSpread(`
    const shaderConstant = (value: number, digits: number): number => Number(value.toFixed(digits));
    const spread = shaderConstant(Math.sin(0.3), 2);`),
        "// 0.3000",
    );
});

test("a formatted number is forgotten where its binding is written", () => {
    for (const body of [
        "let x = Math.sin(0.3); x = 2; const spread = x;",
        "let x = Math.sin(0.3); x++; const spread = x;",
        "let [x] = [Math.sin(0.3)]; x = 2; const spread = x;",
        "const f = (v = Math.sin(0.3)) => { v = 2; return v; }; const spread = f();",
    ])
        assert.throws(() => formattedSpread(body), CompileError, body);
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
