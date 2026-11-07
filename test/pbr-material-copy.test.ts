/**
 * `{ ...material }` copies and the composition-relevant writes PBR materials
 * take after creation: the compiler records which states each target can
 * reach, so composition can name a row for each.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";
import { TINT_PLUGIN } from "./program-snippets.js";

function pbrScene(body: string, before = ""): string {
    return `
        import { createBox, createEngine, createPbrMaterial, createStandardMaterial } from "@babylonjs/lite";
        import type { MaterialPlugin } from "@babylonjs/lite";
        ${before}
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const material = createPbrMaterial({});
            const box = createBox(engine);
            box.material = material;
            ${body}
        }
        void main();
    `;
}

test("a material copy is a cloned record holding its source's values", () => {
    const result = compileSource(
        pbrScene(`
            const copy = { ...material, plugins: material.plugins ? [...material.plugins] : undefined };
            box.material = copy;
        `),
    );
    assert.match(
        result.cpp,
        /const bbl::MaterialHandle \w+ = bbl::clone_material\(v_engine, v_material\);/,
    );
    // A copy takes a handle at run time, so later loads announce profiles.
    assert.equal(result.manifest.profiledGltfLoads, true);
});

test("a material copy refuses members that are not its source's own", () => {
    assert.throws(
        () =>
            compileSource(
                pbrScene("const copy = { ...material, alpha: 0.5 };"),
            ),
        (error) =>
            error instanceof CompileError &&
            /restates its source's members only/.test(error.message),
    );
    assert.throws(
        () =>
            compileSource(
                pbrScene(
                    "const standard = createStandardMaterial(); const copy = { ...standard };",
                ),
            ),
        (error) =>
            error instanceof CompileError &&
            /lowered for a PBR material/.test(error.message),
    );
});

test("records the blend, alpha and base colour states a material can reach", () => {
    const result = compileSource(
        pbrScene(`
            const copy = { ...material };
            copy.alphaBlend = true;
            copy.alpha = 0.5;
            copy.baseColorFactor = [1, 0, 0, 1];
            // Inert on PBR: only setPbrAlphaCutoff reaches the composed cutoff.
            copy.alphaCutOff = 0.4;
        `),
    );
    assert.deepEqual(result.manifest.pbrMaterialStates, [
        {
            target: { kind: "scene", index: 0 },
            alphaBlend: [true],
            alphaBelowOne: [true],
            baseColorFactor: true,
            bentNormalTexture: false,
            pluginSignatures: [],
            pluginAppends: [],
        },
    ]);
    assert.match(result.cpp, /bbl::set_pbr_alpha_blend\(v_engine, \w+, true\)/);
    assert.match(result.cpp, /bbl::set_material_base_color_factor\(/);
    assert.doesNotMatch(result.cpp, /alpha_cut_off|alphaCutOff/);
});

test("grows a PBR material's plugin list through the program's signature algebra", () => {
    const result = compileSource(
        pbrScene(
            `
            const copy = { ...material };
            if (!copy.plugins?.includes(tint)) copy.plugins = [...(copy.plugins ?? []), tint];
            box.material = copy;
        `,
            TINT_PLUGIN,
        ),
    );
    assert.deepEqual(
        result.manifest.pbrMaterialStates?.[0]?.pluginAppends,
        [0],
    );
    assert.equal(result.manifest.pbrPluginSignatures?.length, 1);
    assert.match(
        result.cpp,
        /bblscene::pbr_plugin_signature_contains\(bbl::material_plugin_signature\(v_engine, \w+\), 0u\)/,
    );
    assert.match(
        result.cpp,
        /bbl::set_material_plugin_signature\(v_engine, \w+, bblscene::pbr_plugin_signature_append\(bbl::material_plugin_signature\(v_engine, \w+\), 0u\)\)/,
    );
    // The empty list holds nothing and grows to signature 1; signature 1
    // holds the plugin and grows no further.
    assert.match(result.cpp, /case 256u: return true;/);
    assert.match(result.cpp, /case 0u: return 1;/);
    assert.doesNotMatch(result.cpp, /case 256u: return \d+;/);
});

const BENT_NORMAL_IMPORTS = `import { addToScene, createSceneContext, enableBentNormals, loadTexture2D, registerScene } from "@babylonjs/lite";`;

test("records a bent normal texture as a state its material can reach", () => {
    const result = compileSource(
        pbrScene(
            `
            const bent = await loadTexture2D(engine, "bent.png", { invertY: false });
            material.bentNormalTexture = bent;
            material.bentNormalStrength = 0.25;
            enableBentNormals();
        `,
            BENT_NORMAL_IMPORTS,
        ),
    );
    assert.ok(result.manifest.features.includes("material:bent-normal"));
    assert.deepEqual(result.manifest.pbrMaterialStates, [
        {
            target: { kind: "scene", index: 0 },
            alphaBlend: [],
            alphaBelowOne: [],
            baseColorFactor: false,
            bentNormalTexture: "definite",
            pluginSignatures: [],
            pluginAppends: [],
        },
    ]);
    assert.match(
        result.cpp,
        /bbl::set_pbr_texture\(v_engine, v_material, bbl::MaterialTextureSlot::bent_normal, v_bent\);/,
    );
    assert.match(result.cpp, /\.bent_normal_strength = 0\.25f;/);
});

test("refuses bent normal setup the pin would not compose", () => {
    const refuses = (body: string, message: RegExp) =>
        assert.throws(
            () => compileSource(pbrScene(body, BENT_NORMAL_IMPORTS)),
            (error) =>
                error instanceof CompileError && message.test(error.message),
        );
    const registered = `
        const scene = createSceneContext(engine);
        addToScene(scene, box);
        await registerScene(scene);
    `;
    refuses(`${registered} enableBentNormals();`, /before scene registration/);
    refuses(
        `const bent = await loadTexture2D(engine, "bent.png");
        ${registered} material.bentNormalTexture = bent;`,
        /bentNormalTexture requires static setup before scene registration/,
    );
    refuses(
        `const bent = await loadTexture2D(engine, "bent.png");
        const standard = createStandardMaterial();
        (standard as unknown as { bentNormalTexture: unknown }).bentNormalTexture = bent;`,
        /bentNormalTexture requires a known PBR material/,
    );
});
