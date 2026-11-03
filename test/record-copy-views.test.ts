/**
 * When a copy of a parameter's nested record can be told apart from the
 * argument's object. A program that keys objects by identity somewhere does
 * not make every copy observable: a copy held where only its fields are read,
 * or lent to a callee that only reads it, is never seen as an object, and a
 * nested literal a conditional spread supplies is as fresh as one written
 * in place.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { POSITION_VERTEX_WGSL } from "./program-snippets.js";

function program(calls: string): string {
    return `
import { createEngine, createShaderMaterial } from "@babylonjs/lite";
import type { EngineContext } from "@babylonjs/lite";
interface Border { width?: number }
interface Wave { amplitude?: number }
interface Opts { border?: Border; wave?: Wave; count?: number }
const VERTEX = \`${POSITION_VERTEX_WGSL}\`;
// The program keys objects by identity, whatever their type.
const visited = new Set<object>();
export function remember(value: object): void { visited.add(value); }
function bordered(border: Border | undefined, value: number): number {
    return border === undefined ? 0 : value;
}
function waveLine(wave: Wave | undefined): string {
    if (!wave) return "// still";
    return \`// wave \${(wave.amplitude ?? 0).toFixed(2)}\`;
}
function make(engine: EngineContext, opts: Opts) {
    opts.count = (opts.count ?? 0) + 1;
    const border = opts.border ?? {};
    const width = border.width ?? 0.5;
    const material = createShaderMaterial({
        name: "surface",
        vertexSource: \`\${waveLine(opts.wave)}\\n\${VERTEX}\`,
        fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }",
        attributes: ["position"],
        uniforms: ["worldViewProjection", { name: "uBorder", type: "f32", defaultValue: width }],
    });
    return { material, bordered: (value: number) => bordered(opts.border, value) };
}
async function main(): Promise<void> {
    const engine = await createEngine({});
    ${calls}
}
void main();
`;
}

test("nested option records keep their literal facts across held and lent copies", () => {
    const result = compileSource(
        program(`
    const run = (o: { wave?: boolean }) =>
        make(engine, { border: { width: 0.8 }, ...(o.wave ? { wave: { amplitude: 0.25 } } : {}) });
    const waving = run({ wave: true });
    waving.bordered(new Float32Array([1])[0]!);
    run({});`),
    );
    const sources = result.manifest.customShaderPrograms.map(
        (shader) => shader.vertexSource.split("\n")[0],
    );
    assert.ok(sources.includes("// wave 0.25"), sources.join(", "));
    assert.ok(sources.includes("// still"), sources.join(", "));
});
