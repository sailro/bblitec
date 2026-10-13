import assert from "node:assert/strict";
import test from "node:test";
import {
    composeVatPickingShaders,
    vatPickingHeader,
} from "../src/pinned-picking-shaders.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";

interface Projection {
    key: string;
    shader: object;
}

test("VAT picking composes each reached pin projection arm through the advanced builder", async () => {
    const pin = await importPinnedModule<{
        getVatPickingProjection(
            this: void,
            engine: unknown,
            mesh: unknown,
        ): Projection | null;
    }>("picking/vat-picking-pipeline.js");
    const advanced = await importPinnedModule<{
        pickingShaderVariantSource(
            this: void,
            thin: boolean,
            options: { _vertexProjection: object },
        ): string;
    }>("picking/picking-advanced-shader.js");
    const variants = await composeVatPickingShaders({
        regular: true,
        thinTexture: true,
        thinStorage: true,
    });
    assert.deepEqual(
        variants.map(({ thin, instanceStorage }) => [thin, instanceStorage]),
        [
            [false, false],
            [true, false],
            [true, true],
        ],
    );
    for (const variant of variants) {
        const layouts: Array<{ entries: unknown[] }> = [];
        const engine = {
            _device: {
                createBindGroupLayout: (layout: { entries: unknown[] }) => {
                    layouts.push(layout);
                    return layout;
                },
            },
        };
        const vat = {
            joints1Buffer: null,
            weights1Buffer: null,
            _instanceStorage: variant.instanceStorage ? {} : undefined,
            instanceTexture:
                variant.thin && !variant.instanceStorage ? {} : null,
        };
        const projection = pin.getVatPickingProjection(engine, {
            vat,
            thinInstances: variant.thin ? {} : null,
        })!;
        assert.equal(
            variant.module,
            advanced.pickingShaderVariantSource(variant.thin, {
                _vertexProjection: projection.shader,
            }),
        );
        // Regular group 3: bake and settings; thin adds the clip params.
        assert.deepEqual(
            layouts.map((layout) => layout.entries.length),
            [2, 3],
        );
        assert.equal(variant.module.includes("vatSampler"), true);
        assert.equal(
            variant.module.includes("vatInstanceStorage"),
            variant.instanceStorage,
        );
        assert.equal(
            variant.module.includes("vatInstanceTex"),
            variant.thin && !variant.instanceStorage,
        );
        // A thin candidate with neither clip source takes no projection.
        assert.equal(
            pin.getVatPickingProjection(engine, {
                vat: {
                    ...vat,
                    _instanceStorage: undefined,
                    instanceTexture: null,
                },
                thinInstances: {},
            }),
            null,
        );
    }
    assert.match(
        vatPickingHeader(variants),
        /PickVatVariant, 3>[\s\S]*\{true, true, "picking-vat-2.vert", "picking-vat-2.frag"\}/,
    );
    assert.deepEqual(
        await composeVatPickingShaders({
            regular: false,
            thinTexture: false,
            thinStorage: false,
        }),
        [],
    );
});
