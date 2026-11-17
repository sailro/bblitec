import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

/**
 * A mask registry's shape: a geometry owner hands a placement record whose
 * storage-buffer list joins module-constant declarations, the mask spreads
 * that list into its options, and a registry helper passes the options
 * record on to `createShaderMaterial` and keeps it (`registered`).
 */
const scene = (buffers: string, list: string, kept: string): string => `
    import { createBox, createEngine, createShaderMaterial, wgsl } from "babylon-lite";
    import type { ShaderMaterial } from "babylon-lite";
    type Options = Parameters<typeof createShaderMaterial>[0];
    interface StorageDecl { readonly name: string; readonly type: string }
    const PALETTE: StorageDecl = { name: "uPalette", type: "array<vec4<f32>>" };
    const SCENE: StorageDecl = { name: "uScene", type: "array<vec4<f32>>" };
    function sceneDecls(): StorageDecl[] {
        return [SCENE];
    }
    const recipes = new WeakMap<ShaderMaterial, { readonly options: Options }>();
    function registered(options: Options): ShaderMaterial {
        const material = createShaderMaterial(options);
        recipes.set(material, { options });
        ${kept}
        return material;
    }
    interface Placement { readonly storageBuffers: readonly StorageDecl[] }
    function placedMask(placement: Placement): ShaderMaterial {
        return registered({
            name: "placed-mask",
            vertexSource: wgsl\`struct VOut { @builtin(position) position: vec4<f32> };
@vertex fn mainVertex(input: VertexInput) -> VOut {
    var o: VOut;
    o.position = shaderSystem.worldViewProjection * vec4<f32>(input.position + uPalette[0].xyz + uScene[0].xyz, 1.0);
    return o;
}\`,
            fragmentSource: wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`,
            attributes: ["position"],
            storageBuffers: ${list},
            uniforms: ["worldViewProjection"],
        });
    }
    async function main(): Promise<void> {
        const engine = await createEngine({});
        createBox(engine).material = placedMask({ storageBuffers: ${buffers} });
    }
    void main();
`;

test("reads a forwarded options record's storage buffers spread from module-constant declarations", () => {
    for (const [buffers, list, kept] of [
        // The spread array keeps the module constants as its elements.
        ["[PALETTE, ...sceneDecls()]", "[...placement.storageBuffers]", ""],
        ["[PALETTE, SCENE]", "[...[PALETTE], ...[SCENE]]", ""],
        // The registry tells the kept record from the argument's object, so
        // the parameter holds that object natively, its list's facts too.
        [
            '[{ name: "uPalette", type: "array<vec4<f32>>" }, { name: "uScene", type: "array<vec4<f32>>" }]',
            "[...placement.storageBuffers]",
            'if (recipes.get(material)?.options !== options) throw new Error("copied");',
        ],
        [
            "[PALETTE, ...sceneDecls()]",
            "[...placement.storageBuffers]",
            'if (recipes.get(material)?.options !== options) throw new Error("copied");',
        ],
    ]) {
        const [program] = compileSource(scene(buffers!, list!, kept!)).manifest
            .customShaderPrograms;
        assert.deepEqual(
            program?.storageBuffers.map(({ name, type }) => ({ name, type })),
            [
                { name: "uPalette", type: "array<vec4<f32>>" },
                { name: "uScene", type: "array<vec4<f32>>" },
            ],
            `${buffers} as ${list} ${kept}`,
        );
    }
});
