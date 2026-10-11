import assert from "node:assert/strict";
import test from "node:test";
import { asObject, type JsonObject } from "../src/json-fields.js";
import { sharedPinnedContext } from "../src/lowering/context.js";
import {
    pinnedMaterialInputFromGltf,
    preparePinnedMaterialFeatures,
} from "../src/pinned-material-input.js";
import { doctoredContext } from "./doctored-store.js";

test("material and texture declarations activate only through the document registry", async () => {
    const material = {
        extensions: { KHR_materials_clearcoat: {} },
        pbrMetallicRoughness: {
            baseColorTexture: {
                index: 0,
                extensions: { KHR_texture_transform: { offset: [0.25, 0] } },
            },
        },
    };
    for (const extensionsUsed of [
        undefined,
        [],
        ["KHR_materials_sheen"],
        ["KHR_materials_clearcoat", "KHR_texture_transform"],
    ]) {
        const document = {
            materials: [material],
            ...(extensionsUsed ? { extensionsUsed } : {}),
        };
        const materialFeatures = await preparePinnedMaterialFeatures(document);
        const input = pinnedMaterialInputFromGltf(material, {
            materialFeatures,
            imageOf: () => 0,
        });
        assert.equal(
            "_clearCoat" in input,
            extensionsUsed?.includes("KHR_materials_clearcoat") ?? false,
        );
        assert.equal(
            input._hasUvTx === true,
            extensionsUsed?.includes("KHR_texture_transform") ?? false,
        );
    }
});

test("material selection and dispatch follow modified registry source", async () => {
    const module = "src/loader-gltf/gltf-feature-registry.ts";
    const material = { extensions: { KHR_materials_clearcoat: {} } };
    const context = doctoredContext(
        module,
        'M + "clearcoat"',
        '"TEST_material_coat"',
    );
    for (const extension of ["KHR_materials_clearcoat", "TEST_material_coat"]) {
        const materialFeatures = await preparePinnedMaterialFeatures(
            { materials: [material], extensionsUsed: [extension] },
            context,
        );
        assert.equal(
            "_clearCoat" in
                pinnedMaterialInputFromGltf(material, { materialFeatures }),
            extension === "TEST_material_coat",
        );
    }
    const changedDispatch = doctoredContext(
        module,
        "Object.assign((layers ??= {}), fragment);",
        "Object.assign((layers ??= {}), fragment, { _unlit: true });",
    );
    const materialFeatures = await preparePinnedMaterialFeatures(
        { materials: [material], extensionsUsed: ["KHR_materials_clearcoat"] },
        changedDispatch,
    );
    assert.equal(
        pinnedMaterialInputFromGltf(material, { materialFeatures })._unlit,
        true,
    );
});

test("material extras retain the pinned metadata shape, absence and payload identity", async () => {
    for (const extras of [
        undefined,
        null,
        false,
        0,
        "",
        [],
        { label: "asset" },
    ]) {
        const material = { extras };
        const materialFeatures = await preparePinnedMaterialFeatures({
            materials: [material],
        });
        const input = pinnedMaterialInputFromGltf(material, {
            materialFeatures,
        });
        assert.equal("metadata" in input, extras !== undefined);
        if (extras !== undefined) {
            assert.deepEqual(input.metadata, { gltf: { extras } });
            assert.equal(
                asObject(asObject(input.metadata)?.gltf)?.extras,
                extras,
            );
        }
    }
    const material = { extras: { label: "source" } };
    const context = doctoredContext(
        "src/loader-gltf/gltf-feature-extras.ts",
        "metadata: { gltf: { extras } }",
        "metadata: { gltf: { payload: extras } }",
    );
    const materialFeatures = await preparePinnedMaterialFeatures(
        { materials: [material] },
        context,
    );
    assert.deepEqual(
        pinnedMaterialInputFromGltf(material, { materialFeatures }).metadata,
        { gltf: { payload: material.extras } },
    );
});

test("colliding material fragments follow the source registry order", async () => {
    const module = "src/loader-gltf/gltf-feature-registry.ts";
    const text = sharedPinnedContext().sourceFile(module).text;
    const rows = text
        .split("\n")
        .filter(
            (line) =>
                line.includes('import("./gltf-ext-diffuse-transmission.js")') ||
                line.includes('import("./gltf-ext-dielectric.js")'),
        );
    assert.equal(rows.length, 2);
    const reordered = text
        .replace(rows[0]!, "__MATERIAL_ROW__")
        .replace(rows[1]!, rows[0]!)
        .replace("__MATERIAL_ROW__", rows[1]!);
    const material: JsonObject = {
        extensions: {
            KHR_materials_diffuse_transmission: {
                diffuseTransmissionFactor: 0.4,
            },
            KHR_materials_transmission: { transmissionFactor: 0.7 },
        },
    };
    const document = {
        materials: [material],
        extensionsUsed: Object.keys(material.extensions as JsonObject),
    };
    const normal = pinnedMaterialInputFromGltf(material, {
        materialFeatures: await preparePinnedMaterialFeatures(document),
    });
    const reversed = pinnedMaterialInputFromGltf(material, {
        materialFeatures: await preparePinnedMaterialFeatures(
            document,
            doctoredContext(module, text, reordered),
        ),
    });
    assert.ok((normal._subsurface as JsonObject).refraction);
    assert.equal((normal._subsurface as JsonObject).translucency, undefined);
    assert.ok((reversed._subsurface as JsonObject).translucency);
    assert.equal((reversed._subsurface as JsonObject).refraction, undefined);
});

test("interleaved document preparation keeps animated white fallback tied to source material identity", async () => {
    const factor = [0.2, 0.3, 0.4, 0.5];
    const animated = { pbrMetallicRoughness: { baseColorFactor: factor } };
    const plain = { pbrMetallicRoughness: { baseColorFactor: factor } };
    const [animatedFeatures, plainFeatures] = await Promise.all([
        preparePinnedMaterialFeatures({
            materials: [animated],
            extensionsUsed: ["KHR_animation_pointer"],
            animations: [
                {
                    channels: [
                        {
                            target: {
                                extensions: {
                                    KHR_animation_pointer: {
                                        pointer:
                                            "/materials/0/pbrMetallicRoughness/baseColorFactor",
                                    },
                                },
                            },
                        },
                    ],
                },
            ],
        }),
        preparePinnedMaterialFeatures({
            materials: [plain],
            extensionsUsed: ["KHR_animation_pointer"],
        }),
    ]);
    for (let iteration = 0; iteration < 3; iteration++) {
        const input = pinnedMaterialInputFromGltf(animated, {
            materialFeatures: animatedFeatures,
        });
        assert.deepEqual(input.baseColorFactor, factor);
        assert.equal(
            pinnedMaterialInputFromGltf(plain, {
                materialFeatures: plainFeatures,
            }).baseColorFactor,
            undefined,
        );
    }
    assert.deepEqual(animated.pbrMetallicRoughness.baseColorFactor, factor);
    const disabled = await preparePinnedMaterialFeatures({
        materials: [animated],
    });
    assert.equal(
        pinnedMaterialInputFromGltf(animated, { materialFeatures: disabled })
            .baseColorFactor,
        undefined,
    );
});

test("separate-image ORM retains the explicit browser-image boundary", async () => {
    const material = {
        pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } },
        occlusionTexture: { index: 1 },
    };
    const materialFeatures = await preparePinnedMaterialFeatures({
        materials: [material],
        textures: [{ source: 0 }, { source: 1 }],
    });
    assert.throws(
        () =>
            pinnedMaterialInputFromGltf(material, {
                materialFeatures,
                imageOf: (index) =>
                    typeof index === "number" ? index : undefined,
            }),
        /glTF ORM compositing requires decoded browser images/,
    );
});
