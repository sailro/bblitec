import assert from "node:assert/strict";
import test from "node:test";

import { CompileError, compileSource } from "../src/compiler.js";

/**
 * Static option positions (shader-material lists and records) read a
 * closed helper's returned data and a spread generation settles, and refuse
 * what they cannot settle.
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

test("reads closed descriptor helpers with scalar arguments and local bindings", () => {
    for (const [prelude, call] of [
        [
            `function uniforms(name: string) { return [name] as const; }`,
            `uniforms("worldViewProjection")`,
        ],
        [
            `function uniforms() { const list = ["worldViewProjection"] as const; return list; }`,
            "uniforms()",
        ],
    ] as const) {
        const compiled = program(
            prelude,
            `uniforms: [...${call}, { name: "uTint", type: "vec4<f32>", defaultValue: [0.25, 0.5, 0.75, 1] }],`,
        );
        assert.deepEqual(compiled.uniforms, [
            "worldViewProjection",
            "uTint:vec4<f32>",
        ]);
        assert.deepEqual(compiled.uniformDefaults, [
            { name: "uTint", values: [0.25, 0.5, 0.75, 1] },
        ]);
    }
});

test("refuses a recursive descriptor helper", () => {
    assert.throws(
        () =>
            program(
                `function uniforms(): readonly string[] { return uniforms(); }`,
                "uniforms: uniforms(),",
            ),
        /Builder 'uniforms' threw at generation: Maximum call stack size exceeded/,
    );
});

test("an awaited asynchronous descriptor helper settles at generation", () => {
    const compiled = program(
        `async function uniforms() { return ["worldViewProjection"] as const; }`,
        "uniforms: await uniforms(),",
    );
    assert.deepEqual(compiled.uniforms, ["worldViewProjection"]);
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
        /Conditional static options require a side-effect-free predicate/,
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

// A wrapper keeps its options beside the material it builds, and the program
// compares such options by identity: the parameter takes the argument as its
// own object. `before` runs ahead of the material.
const wrappedMaterial = (before = ""): string => `
    import { createBox, createEngine, createShaderMaterial, type ShaderMaterial } from "@babylonjs/lite";

    const vertexSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}\`;
    const fragmentSource = \`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return shaderUniforms.uTint;}\`;
    type MaskOptions = Parameters<typeof createShaderMaterial>[0];
    interface Recipe {
        readonly options: MaskOptions;
        readonly bind?: (material: ShaderMaterial) => void;
        readonly layout?: "mesh" | "thin-instances";
    }
    const recipes = new WeakMap<ShaderMaterial, Recipe>();
    const kept: MaskOptions[] = [];
    const sameRecipe = (a: Recipe, b: Recipe): boolean => a.options === b.options;
    function retag(target: { attributes: string[] }): void {
        target.attributes.push("normal");
    }

    function createMask(
        options: MaskOptions,
        bind?: (material: ShaderMaterial) => void,
        extra?: Omit<Recipe, "options" | "bind">,
    ): ShaderMaterial {
        ${before}
        const material = createShaderMaterial(options);
        bind?.(material);
        recipes.set(material, { options, ...(bind ? { bind } : {}), ...extra });
        return material;
    }

    async function main() {
        const engine = await createEngine({});
        const material = createMask({
            name: "mask",
            vertexSource,
            fragmentSource,
            attributes: ["position"],
            uniforms: ["worldViewProjection", { name: "uTint", type: "vec4<f32>", defaultValue: [0.25, 0.5, 0.75, 1] }],
        });
        const box = createBox(engine);
        box.material = material;
        if (!sameRecipe(recipes.get(material)!, recipes.get(material)!) || kept.length > 1) throw new Error("recipe");
    }
`;

test("reads a stored argument's own object where nothing has yet changed or kept it", () => {
    const { cpp, manifest } = compileSource(wrappedMaterial());
    assert.match(cpp, /parameter_object/);
    const [compiled] = manifest.customShaderPrograms;
    assert.equal(compiled!.name, "mask");
    assert.deepEqual(compiled!.attributes, ["position"]);
    assert.deepEqual(compiled!.uniformDefaults, [
        { name: "uTint", values: [0.25, 0.5, 0.75, 1] },
    ]);
});

test("leaves a stored argument's object to the run time once something changed or kept it", () => {
    // Kept before the read, or captured by a closure made before it: other
    // code can reach the object, so its lists are the run time's.
    for (const before of [
        "kept.push(options);",
        "const keep = (): number => kept.push(options); if (kept.length > 5) keep();",
    ])
        assert.throws(
            () => compileSource(wrappedMaterial(before)),
            /Expected a static array literal/,
            before,
        );
    // A write through the object before the read never reads the literal.
    for (const before of [
        `(options as { attributes: string[] }).attributes = ["position", "normal"];`,
        "retag(options as { attributes: string[] });",
        `const tint = options.uniforms![1] as { defaultValue: number[] }; tint.defaultValue[0] = 1;`,
    ])
        assert.throws(
            () => compileSource(wrappedMaterial(before)),
            CompileError,
            before,
        );
});
