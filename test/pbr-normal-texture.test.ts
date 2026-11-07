import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

/** A created PBR material's normal texture and scale. */

const pbrScene = (options: string) => `
    import { createEngine, createPbrMaterial, createSolidTexture2D, loadTexture2D } from "@babylonjs/lite";

    async function main() {
        const engine = await createEngine({});
        const normal = await loadTexture2D(engine, "normal.png", { srgb: false });
        const scale = 1 + performance.now() / 1000;
        void createSolidTexture2D;
        const material = createPbrMaterial({ ${options} });
        void material;
    }
`;

test("binds a created PBR material's loaded normal texture and its scale", () => {
    const result = compileSource(
        pbrScene("normalTexture: normal, normalTextureScale: scale"),
    );
    assert.equal(result.manifest.scenePbrMaterials[0]?.hasNormalTexture, true);
    assert.match(
        result.cpp,
        /bbl::set_pbr_texture\(v_engine, (v_bblite_material_\d+), bbl::MaterialTextureSlot::normal, v_normal\);\s*bbl::handle_at\(v_engine\.materials, \1\)\.normal_texture_scale = static_cast<float>\(v_scale\);/,
    );

    // Without a normal texture the scale composes nothing and is dropped
    // once evaluated.
    const plain = compileSource(pbrScene("normalTextureScale: scale"));
    assert.equal(
        plain.manifest.scenePbrMaterials[0]?.hasNormalTexture,
        undefined,
    );
    assert.doesNotMatch(
        plain.cpp,
        /MaterialTextureSlot::normal|normal_texture_scale/,
    );
});

test("binds a created PBR normal texture of any 2D storage, as the pin does", () => {
    const result = compileSource(
        pbrScene("normalTexture: createSolidTexture2D(engine, 0.5, 0.5, 1)"),
    );
    assert.equal(result.manifest.scenePbrMaterials[0]?.hasNormalTexture, true);
    assert.match(
        result.cpp,
        /bbl::set_pbr_texture\(v_engine, v_bblite_material_\d+, bbl::MaterialTextureSlot::normal, bbl::solid_texture_file\(bbl::create_solid_texture\(/,
    );
});
