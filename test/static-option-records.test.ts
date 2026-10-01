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
    for (const [prelude, call] of [
        // A parameter, a body with more than a return, recursion and an
        // async function all keep the call.
        [
            `function uniforms(name: string) { return [name] as const; }`,
            `uniforms("worldViewProjection")`,
        ],
        [
            `function uniforms() { const list = ["worldViewProjection"] as const; return list; }`,
            "uniforms()",
        ],
        [
            `function uniforms(): readonly string[] { return uniforms(); }`,
            "uniforms()",
        ],
        [
            `async function uniforms() { return ["worldViewProjection"] as const; }`,
            "await uniforms()",
        ],
    ] as const) {
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

test("composes required shader text through builders, constants and record arithmetic", () => {
    const { manifest } = compileSource(`
        import { createBox, createEngine, createShaderMaterial, wgsl } from "@babylonjs/lite";

        const LANES = { fog: 18 };
        export function paletteWgsl(
            read: (index: string) => string = (index) => \`vec4<f32>(0.8, 0.5, 0.3, \${index})\`,
            alpha = "1.0",
        ): string {
            return \`fn ccPalette() -> vec4<f32> { return \${read(alpha)}; }\`;
        }
        const PALETTE_WGSL = paletteWgsl();
        const HEADER_WGSL = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
const FOG_LANE: u32 = \${LANES.fog + 1}u;\`;
        const VS = \`@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}\`;
        const FS = \`@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return ccPalette();}\`;

        async function main() {
            const engine = await createEngine({});
            const material = createShaderMaterial({
                vertexSource: wgsl\`\${\`\${HEADER_WGSL}\\n\${VS}\`}\`,
                fragmentSource: wgsl\`\${\`\${HEADER_WGSL}\\n\${PALETTE_WGSL}\\n\${FS}\`}\`,
                attributes: ["position"],
                uniforms: ["worldViewProjection"],
            });
            const box = createBox(engine);
            box.material = material;
        }
    `);
    const [compiled] = manifest.customShaderPrograms;
    assert.match(compiled!.vertexSource, /FOG_LANE: u32 = 19u/);
    assert.match(
        compiled!.fragmentSource,
        /return vec4<f32>\(0\.8, 0\.5, 0\.3, 1\.0\);/,
    );
});
