import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

/**
 * Static option positions (shader-material lists and records) read a
 * parameterless module function's returned literal and a spread generation
 * settles, and refuse what they cannot settle.
 */

const shaderMaterial = (prelude: string, options: string) => `
    import { createBox, createEngine, createShaderMaterial } from "@babylonjs/lite";

    const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}\`;
    const fragmentSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return shaderUniforms.uTint;}\`;
    const TINT = [0.25, 0.5, 0.75, 1] as const;
${prelude}
    async function main() {
        const engine = await createEngine({});
        const material = createShaderMaterial({
            vertexSource,
            fragmentSource,
            attributes: ["position"],
            ${options}
        });
        const box = createBox(engine);
        box.material = material;
    }
`;

const program = (prelude: string, options: string) =>
    compileSource(shaderMaterial(prelude, options)).manifest
        .customShaderPrograms[0]!;

test("reads the literal a parameterless module function returns", () => {
    for (const prelude of [
        `function uniforms() {
            return ["worldViewProjection", { name: "uTint", type: "vec4<f32>" as const, defaultValue: TINT }] as const;
        }`,
        `const uniforms = () => ["worldViewProjection", { name: "uTint", type: "vec4<f32>" as const, defaultValue: TINT }] as const;`,
        `function inner() {
            return ["worldViewProjection", { name: "uTint", type: "vec4<f32>" as const, defaultValue: TINT }] as const;
        }
        function uniforms() { return inner(); }`,
    ]) {
        const compiled = program(prelude, "uniforms: uniforms(),");
        assert.deepEqual(
            compiled.uniforms.map((uniform) => uniform.split(":")[0]),
            ["worldViewProjection", "uTint"],
        );
    }
});

test("leaves calls the static reader cannot replace to their own refusal", () => {
    for (const prelude of [
        // A parameter, a body with more than a return, recursion and an
        // async function all keep the call.
        `function uniforms(name: string) { return [name] as const; }`,
        `function uniforms() { const list = ["worldViewProjection"] as const; return list; }`,
        `function uniforms(): readonly string[] { return uniforms(); }`,
        `async function uniforms() { return ["worldViewProjection"] as const; }`,
    ]) {
        const call = prelude.includes("name: string")
            ? `uniforms("worldViewProjection")`
            : prelude.startsWith("async")
              ? `await uniforms()`
              : "uniforms()";
        assert.throws(
            () => program(prelude, `uniforms: ${call},`),
            /Expected a static array literal/,
        );
    }
});

test("reads option-record spreads generation settles, the later write winning", () => {
    const compiled = program(
        `const query = new URLSearchParams(location.search);
         const flip = query.get("flip") === "yes";`,
        `uniforms: ["worldViewProjection", { name: "uTint", type: "vec4<f32>", defaultValue: TINT }],
            backFaceCulling: true,
            ...(flip ? { backFaceCulling: true } : { backFaceCulling: false }),
            ...{ depthWrite: false },`,
    );
    assert.equal(compiled.backFaceCulling, false);
    assert.equal(compiled.depthWrite, false);
});

test("reads the settled spreads of a static shader list", () => {
    const compiled = program(
        `function viewUniforms() { return ["worldViewProjection"] as const; }
         const query = new URLSearchParams(location.search);
         const tinted = query.get("tint") !== "off";`,
        `uniforms: [
                ...viewUniforms(),
                ...(tinted ? [{ name: "uTint", type: "vec4<f32>", defaultValue: TINT }] : []),
            ],`,
    );
    assert.deepEqual(
        compiled.uniforms.map((uniform) => uniform.split(":")[0]),
        ["worldViewProjection", "uTint"],
    );
});

test("refuses a spread whose record generation cannot settle", () => {
    assert.throws(
        () =>
            program(
                "",
                `uniforms: ["worldViewProjection"],
            ...(Math.random() > 0.5 ? { depthWrite: false } : {}),`,
            ),
        /Reached shader materials support/,
    );
});
