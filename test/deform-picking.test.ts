import assert from "node:assert/strict";
import test from "node:test";
import { composeDeformPickingShaders, deformPickingHeader } from "../src/pinned-picking-shaders.js";
import { importPinnedModule, importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";

interface Projection {
    shader: object;
}
const bits = await importPinnedModule<{
    MSH_HAS_SKELETON: number; MSH_HAS_MORPH_TARGETS: number;
}>("material/mesh-features.js");
const meshFeatures = [0, bits.MSH_HAS_SKELETON, bits.MSH_HAS_MORPH_TARGETS,
    bits.MSH_HAS_SKELETON | bits.MSH_HAS_MORPH_TARGETS];

test("regular picking composes each pin deformation arm for both pass modes", async () => {
    const pin = await importPinnedModule<{
        getDeformPickingProjection(engine: unknown, mesh: unknown): Projection | null;
    }>("picking/deform-picking-projection.js");
    const basic = await importPinnedModule<{
        pickingShaderSource(options: { _vertexProjection: object }): string;
    }>("picking/picking-shader.js");
    const detailed = await importPinnedModuleWithExports<{
        shader(rule: null, projection: object): string;
    }>("picking/picking-detailed-pipeline.js", ["shader"]);
    const variants = await composeDeformPickingShaders({ meshFeatures, skeleton: true, morph: true, detailed: true });
    assert.deepEqual(variants.map(({ skeleton, morph }) => [skeleton, morph]),
        [[true, false], [false, true], [true, true]]);
    for (const variant of variants) {
        const layouts: Array<{ entries: unknown[] }> = [];
        const engine = { _device: { createBindGroupLayout: (layout: { entries: unknown[] }) => {
            layouts.push(layout); return layout;
        } } };
        const mesh = {
            vat: null,
            skeleton: variant.skeleton ? { joints1Buffer: null, weights1Buffer: null } : null,
            morphTargets: variant.morph ? {} : null,
        };
        const projection = pin.getDeformPickingProjection(engine, mesh)!;
        assert.equal(variant.mesh, basic.pickingShaderSource({ _vertexProjection: projection.shader }));
        assert.equal(variant.detailed, detailed.shader(null, projection.shader));
        assert.equal(layouts.at(-1)!.entries.length, Number(variant.skeleton) + Number(variant.morph) * 2);
        assert.equal(variant.mesh.includes("boneSampler"), variant.skeleton);
        assert.equal(variant.mesh.includes("morphDeltas"), variant.morph);
        assert.equal(variant.mesh.includes("primitive_index"), false);
        assert.equal(variant.detailed!.includes("primitive_index"), true);
        assert.equal(pin.getDeformPickingProjection(engine, { ...mesh, vat: {} }), null);
    }
    assert.match(deformPickingHeader(variants), /PickDeformVariant, 3/);
    const separate = await composeDeformPickingShaders({
        meshFeatures: [bits.MSH_HAS_SKELETON, bits.MSH_HAS_MORPH_TARGETS, bits.MSH_HAS_SKELETON],
        skeleton: true, morph: true, detailed: true,
    });
    assert.equal(separate.length, 2, "independent attachments do not compose an unused combined arm");
    assert.ok(separate.every(variant => !(variant.skeleton && variant.morph)));
});

test("picking does not deploy unreached projection families or detailed stages", async () => {
    assert.deepEqual(await composeDeformPickingShaders({ meshFeatures, skeleton: false, morph: false, detailed: true }), []);
    for (const skeleton of [false, true]) {
        const variants = await composeDeformPickingShaders({ meshFeatures, skeleton, morph: !skeleton, detailed: false });
        assert.equal(variants.length, 1);
        assert.equal(variants[0]!.skeleton, skeleton);
        assert.equal(variants[0]!.morph, !skeleton);
        assert.equal(variants[0]!.detailed, undefined);
        assert.match(deformPickingHeader(variants), /"picking-deform-0.vert", nullptr/);
    }
});
