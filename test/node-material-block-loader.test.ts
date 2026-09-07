/** Closed scene-supplied node-material emitter loaders. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { executeModuleGraph } from "../src/executed-module-graph.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { composeNodeMaterial } from "../src/pinned-node-material.js";
import { pinnedNodeVariantsHeader } from "../src/pinned-node-material-cpp.js";

const scene83 = "corpus/babylon-lite/lab/lite/src/lite/scene83.ts";
const scene83Graph =
    "corpus/babylon-lite/lab/lite/src/shared/scene83-nme.ts";
const scene72 = "corpus/babylon-lite/lab/lite/src/lite/scene72.ts";
const scene72Graph =
    "corpus/babylon-lite/lab/lite/src/shared/scene72-nme.ts";
const scene72Compression =
    "corpus/babylon-lite/lab/lite/src/shared/nme-compression.ts";

function gitBlobHash(bytes: Buffer): string {
    return createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
}

function compileLoader(loader: string, name = "loadBlock") {
    return compileSource(`
        import {
            createEngine,
            parseNodeMaterialFromSnippet,
        } from "babylon-lite";

        ${loader}

        async function main() {
            const engine = await createEngine({});
            await parseNodeMaterialFromSnippet(engine, "", {
                json: { blocks: [] },
                blockLoader: ${name},
            });
        }
        main();
    `);
}

test("recognizes the pinned geometry loader by import symbol and keeps its graph identity", () => {
    for (const name of ["loadNodeBlockEmitterWithGeometry", "loadBlock"]) {
        const result = compileLoader(
            `import { loadNodeBlockEmitterWithGeometry as ${name} } from "babylon-lite";`,
            name,
        );
        assert.equal(result.manifest.nodeMaterials[0]!.pinnedBlockLoader, "geometry");
        assert.equal(result.manifest.nodeMaterials[0]!.blockEmitters, undefined);
    }
    const result = compileSource(`
        import { createEngine, parseNodeMaterialFromSnippet,
            loadNodeBlockEmitterWithGeometry as geometry } from "babylon-lite";
        async function main() {
            const engine = await createEngine({});
            const graph = { blocks: [] };
            await parseNodeMaterialFromSnippet(engine, "", { json: graph });
            await parseNodeMaterialFromSnippet(engine, "", { json: graph, blockLoader: geometry });
            await parseNodeMaterialFromSnippet(engine, "", { json: graph, blockLoader: geometry });
        }
        main();
    `);
    assert.deepEqual(result.manifest.nodeMaterials.map((material) => material.pinnedBlockLoader),
        [undefined, "geometry"]);
    assert.deepEqual([...result.cpp.matchAll(/create_node_material\([^,]+, (\d+)u,/g)]
        .map((match) => Number(match[1])), [0, 1, 1]);

    assert.throws(() => compileLoader(`
        async function loadNodeBlockEmitterWithGeometry(className: string): Promise<unknown> {
            return className;
        }
    `, "loadNodeBlockEmitterWithGeometry"), /one closed switch statement/);
    for (const declaration of [
        'import type { loadNodeBlockEmitterWithGeometry as loadBlock } from "babylon-lite";',
        'import { type loadNodeBlockEmitterWithGeometry as loadBlock } from "babylon-lite";',
    ]) {
        assert.throws(() => compileLoader(declaration), /blockLoader/);
    }
});

test("executes pinned geometry delegation while preserving ordinary graphs and later refusals", async () => {
    const graph = await executeModuleGraph({
        modulePath: "corpus/babylon-lite/lab/lite/src/shared/scene149-nme.ts",
        exportName: "SCENE149_NME_JSON",
    });
    const options = { pinnedBlockLoader: "geometry" } as const;
    const composed = await composeNodeMaterial(graph, "scene149-loader", {
        ...options,
        geometryTasks: [{ index: 0, attachments: ["WORLD_POSITION", "VIEW_NORMAL", "ALBEDO"], emitColor: false }],
    });
    assert.deepEqual(composed.textures.map(({ name }) => name), ["albedo"]);
    assert.deepEqual(composed.inputs, [{ name: "albedo", type: "texture2d" }]);
    const inputHeader = pinnedNodeVariantsHeader("input metadata", [0, 1].map((index) => ({
        index, vertexStem: `node-${index}.vert`, fragmentStem: `node-${index}.frag`, composed,
    })), []);
    assert.match(inputHeader, /std::array<NodeVariantInput, 2> node_variant_inputs/);
    assert.match(inputHeader, /\{0, "albedo", "texture2d"\}/);
    assert.match(inputHeader, /\{1, "albedo", "texture2d"\}/);
    assert.equal(composed.geometryViews[0]!.colorTargetCount, 3);
    assert.deepEqual(composed.geometryViews[0]!.attributes.map(({ name }) => name),
        ["position", "normal", "uv"]);
    await assert.rejects(() => composeNodeMaterial(graph, "scene149-default"),
        /no emitter registered for block "GeometryTextureOutputBlock"/);

    const ordinary = await executeModuleGraph({
        modulePath: "corpus/babylon-lite/lab/lite/src/shared/scene60-nme.ts",
        exportName: "SCENE60_NME_JSON",
    });
    assert.deepEqual(await composeNodeMaterial(ordinary, "ordinary", options),
        await composeNodeMaterial(ordinary, "ordinary"));
    await assert.rejects(() => composeNodeMaterial({
        blocks: [{ id: 1, customType: "BABYLON.MissingEmitterBlock", inputs: [], outputs: [] }],
    }, "missing-emitter", options), /no emitter registered for block "MissingEmitterBlock"/);
    await assert.rejects(() => composeNodeMaterial(graph, "scene149-local-refusal", {
        ...options,
        geometryTasks: [{ index: 0, attachments: ["LOCAL_POSITION"], emitColor: false }],
    }), /attachments include LOCAL_POSITION/);
    await assert.rejects(() => composeNodeMaterial(graph, "scene149-color-refusal", {
        ...options,
        geometryTasks: [{ index: 0, attachments: ["ALBEDO"], emitColor: true }],
    }), /refuses `emitColor`/);
    await assert.rejects(() => composeNodeMaterial(ordinary, "conflicting-loaders", {
        ...options,
        blockEmitters: [{ className: "InputBlock", module: "material/node/blocks/input-block.js" }],
    }), /cannot combine pinned and closed block loaders/);
});

function compressedJsonHelpers(options: {
    decoderExtra?: string;
    restorerReturn?: string;
} = {}): string {
    return `
        async function decodeCompressed(
            encoded: string,
        ): Promise<Record<string, unknown>> {
            const bytes = Uint8Array.from(
                atob(encoded),
                (char) => char.charCodeAt(0),
            );
            ${options.decoderExtra ?? ""}
            const stream = new Blob([bytes])
                .stream()
                .pipeThrough(new DecompressionStream("gzip"));
            return (await new Response(stream).json()) as Record<string, unknown>;
        }

        function restoreAliases(
            json: Record<string, unknown>,
        ): Record<string, unknown> {
            const blocks = json.blocks;
            if (!Array.isArray(blocks)) {
                return json;
            }
            for (const block of blocks) {
                if (!block || typeof block !== "object") {
                    continue;
                }
                const inputs = (block as { inputs?: unknown }).inputs;
                if (!Array.isArray(inputs)) {
                    continue;
                }
                for (const input of inputs) {
                    if (!input || typeof input !== "object") {
                        continue;
                    }
                    const entry = input as {
                        name?: unknown;
                        inputName?: unknown;
                    };
                    if (
                        entry.inputName === undefined &&
                        typeof entry.name === "string"
                    ) {
                        entry.inputName = entry.name;
                    }
                }
            }
            return ${options.restorerReturn ?? "json"};
        }

        const decoded = decodeCompressed("not-a-gzip-payload")
            .then(restoreAliases);
    `;
}

test("restores and compiles Scene 83's exact closed emitter loader", () => {
    const graphBytes = readFileSync(resolve(scene83Graph));
    assert.equal(
        gitBlobHash(graphBytes),
        "9bf427136bf5482d5e1dc611788efedb24240351",
    );

    const result = compileSource(
        readFileSync(resolve(scene83), "utf8"),
        { fileName: scene83 },
    );
    const material = result.manifest.nodeMaterials[0]!;
    assert.equal(material.kind, "module");
    assert.equal(material.blockEmitters?.length, 20);
    assert.deepEqual(material.blockEmitters?.slice(0, 3), [
        {
            className: "AddBlock",
            module: "material/node/blocks/add-block.js",
        },
        {
            className: "AmbientOcclusionBlock",
            module: "material/node/blocks/ambient-occlusion-block.js",
        },
        {
            className: "ColorMergerBlock",
            module: "material/node/blocks/color-merger.js",
        },
    ]);
    assert.deepEqual(material.textureNames, ["AoDepth", "PositionSample"]);
    assert.match(
        result.cpp,
        /node_material_texture\("AoDepth", v_aoDepth\)/,
    );
    assert.match(
        result.cpp,
        /node_material_texture\("PositionSample", v_positionTex\)/,
    );
});

test("restores Scene 72's exact compressed graph, textures, and emitter loader", () => {
    assert.equal(
        gitBlobHash(readFileSync(resolve(scene72))),
        "5656d87057060aafb9b3941182e64581d9200d87",
    );
    assert.equal(
        gitBlobHash(readFileSync(resolve(scene72Graph))),
        "1b96169e11084b744d5ee0bf9204854268fac315",
    );
    assert.equal(
        gitBlobHash(readFileSync(resolve(scene72Compression))),
        "f0d913a4d04733361c82d271f6a1e4eeb97e5e61",
    );

    const result = compileSource(
        readFileSync(resolve(scene72), "utf8"),
        { fileName: scene72 },
    );
    const material = result.manifest.nodeMaterials[0]!;
    assert.equal(material.kind, "literal");
    assert.equal(material.graph.alphaMode, 2);
    assert.ok(Array.isArray(material.graph.blocks));
    assert.equal(material.graph.blocks.length, 63);
    assert.deepEqual(material.textureNames, [
        "Albedo_texture",
        "MetallicRoughness_texture",
        "AO_texture",
        "Opacity_texture",
        "Bump_texture",
        "Sheen_texture",
        "Anisotropy_texture",
        "ClearCoat_texture",
        "ClearCoat_bump_texture",
        "ClearCoat_tint_texture",
        "SubSurface_thickness_texture",
    ]);
    assert.deepEqual(material.blockEmitters, [
        { className: "AddBlock", module: "material/node/blocks/add-block.js" },
        {
            className: "AnisotropyBlock",
            module: "material/node/blocks/anisotropy-block.js",
        },
        {
            className: "ClearCoatBlock",
            module: "material/node/blocks/clearcoat-block.js",
        },
        {
            className: "FragmentOutputBlock",
            module: "material/node/blocks/fragment-output.js",
        },
        { className: "InputBlock", module: "material/node/blocks/input-block.js" },
        { className: "LerpBlock", module: "material/node/blocks/lerp-block.js" },
        {
            className: "MultiplyBlock",
            module: "material/node/blocks/multiply-block.js",
        },
        {
            className: "PBRMetallicRoughnessBlock",
            module: "material/node/blocks/pbr-metallic-roughness-block-full.js",
        },
        {
            className: "PerturbNormalBlock",
            module: "material/node/blocks/perturb-normal.js",
        },
        {
            className: "ReflectionBlock",
            module: "material/node/blocks/reflection-block.js",
        },
        {
            className: "RefractionBlock",
            module: "material/node/blocks/refraction-block.js",
        },
        { className: "SheenBlock", module: "material/node/blocks/sheen-block.js" },
        {
            className: "SubSurfaceBlock",
            module: "material/node/blocks/subsurface-block.js",
        },
        {
            className: "SubtractBlock",
            module: "material/node/blocks/subtract-block.js",
        },
        {
            className: "TextureBlock",
            module: "material/node/blocks/texture-block.js",
        },
        {
            className: "TransformBlock",
            module: "material/node/blocks/transform-block.js",
        },
        {
            className: "VectorMergerBlock",
            module: "material/node/blocks/vector-merger.js",
        },
        {
            className: "VertexOutputBlock",
            module: "material/node/blocks/vertex-output.js",
        },
    ]);

    assert.deepEqual(
        result.manifest.assets
            .map(({ source }) => source.match(/\/textures\/nme\/([^/]+)$/)?.[1])
            .filter((name): name is string => name !== undefined),
        [
            "600b47df0b94a342.png",
            "3a0489ce143027b3.png",
            "def680233b740938.jpg",
            "e044718a24cb5146.png",
            "76af750145dbbd44.png",
            "b01458d0a1171375.png",
        ],
    );
    assert.equal(
        result.cpp.match(/bbl::load_file_texture\(/g)?.length,
        material.textureNames.length,
    );
    for (const textureName of material.textureNames) {
        assert.match(
            result.cpp,
            new RegExp(
                `node_material_texture\\("${textureName}",\\s*` +
                    `[^,\\r\\n]+\\.at\\("${textureName}"\\)\\)`,
            ),
        );
    }
});

test("rejects a compressed JSON decoder with an extra observable statement", () => {
    assert.throws(
        () =>
            compileSource(compressedJsonHelpers({
                decoderExtra: 'console.log("decoding", encoded);',
            })),
        /Immediate promise then requires an inline callback/,
    );
});

test("rejects a compressed JSON restorer that returns a different value", () => {
    assert.throws(
        () =>
            compileSource(compressedJsonHelpers({
                restorerReturn: "{ ...json }",
            })),
        /Immediate promise then requires an inline callback/,
    );
});

test("composes Scene 83 with only its supplied pinned emitters", async () => {
    const compiled = compileSource(
        readFileSync(resolve(scene83), "utf8"),
        { fileName: scene83 },
    ).manifest.nodeMaterials[0]!;
    assert.equal(compiled.kind, "module");
    assert.ok(compiled.blockEmitters);
    const graph = await executeModuleGraph({
        modulePath: resolve(scene83Graph),
        exportName: "SCENE83_NME_JSON",
    });
    const composed = await composeNodeMaterial(
        graph,
        "scene83",
        { blockEmitters: compiled.blockEmitters },
    );

    // AoDepth is reached from the output graph. PositionSample is
    // disconnected, so upstream loads its emitter but declares no binding
    // and ignores the extra options.textures key.
    assert.deepEqual(
        composed.textures.map(({ name }) => name),
        ["AoDepth"],
    );
    assert.match(composed.wgsl, /nodeTex_AoDepth/);
    assert.doesNotMatch(composed.wgsl, /nodeTex_PositionSample/);
    assert.match(composed.wgsl, /dpdx/);
    assert.match(composed.wgsl, /dpdy/);

    const withoutDerivative = compiled.blockEmitters.filter(
        ({ className }) => className !== "DerivativeBlock",
    );
    assert.equal(withoutDerivative.length, 19);
    await assert.rejects(
        () =>
            composeNodeMaterial(
                graph,
                "scene83-without-derivative",
                { blockEmitters: withoutDerivative },
            ),
        /custom block loader has no emitter for block "DerivativeBlock"/,
    );
});

test("normalizes a solid node texture to the pinned 1x1 file contract", () => {
    // The 1x1 contract itself is stated ONCE, beside `create_solid_texture`
    // in the file-texture translation unit -- which is in the build wherever
    // a `SolidTexture` exists at all, because `createSolidTexture2D` reaches
    // `texture:file` unconditionally. Three slots restated it before that
    // was measured, and they had already diverged: the PBR occlusion copy
    // set no sampler. So this asserts the shared definition here...
    const factories = new FactoryLowerer(new LoweringContext());
    const shared = factories.lowerFileTextureFactory().source;

    assert.match(
        shared,
        /TextureData solid_texture_data\(const SolidTexture& texture\) \{/,
    );
    assert.match(
        shared,
        /data\.bytes\.assign\(\s*texture\.texel\.begin\(\),\s*texture\.texel\.end\(\)\);/,
    );
    assert.match(
        shared,
        /data\.rgba_width = 1;\s*data\.rgba_height = 1;/,
    );
    assert.match(
        shared,
        /data\.sampler\.min_filter = TextureFilter::linear;\s*data\.sampler\.mag_filter = TextureFilter::linear;/,
    );
    assert.match(
        shared,
        /data\.sampler\.mipmap_mode = TextureMipmapMode::nearest;/,
    );
    assert.match(
        shared,
        /data\.sampler\.address_u = TextureAddressMode::clamp;\s*data\.sampler\.address_v = TextureAddressMode::clamp;/,
    );
    assert.match(shared, /data\.sampler\.max_lod = 0\.0f;/);

    // ...and that the node slot reaches it rather than carrying its own
    // copy. The FileTexture wrapper's own 1x1 extent stays here, because
    // that is the node factory's shape and not the texture data's.
    const source = factories.lowerNodeMaterialFactory().source;
    assert.match(
        source,
        /const SolidTexture& texture\) \{\s*FileTexture normalized;\s*normalized\.data = solid_texture_data\(texture\);/,
    );
    assert.match(
        source,
        /normalized\.width = 1;\s*normalized\.height = 1;/,
    );
    assert.doesNotMatch(source, /normalized\.data\.sampler\.min_filter/);
});

test("retains node texture producers until deferred binding normalizes pixels metadata", () => {
    const source = new FactoryLowerer(
        new LoweringContext(),
    ).lowerNodeMaterialFactory().source;

    assert.match(
        source,
        /const PixelsTexture& texture\) \{\s*return NodeMaterialTexture\{std::move\(name\), texture\};/,
    );
    assert.match(
        source,
        /normalized\.data\.sampler = stored\.sampler;\s*normalized\.data\.uv_transform = stored\.uv_transform;\s*normalized\.data\.uv_invert_y = stored\.uv_invert_y;/,
    );
    assert.match(
        source,
        /const StoredTexture& texture\) \{\s*return NodeMaterialTexture\{std::move\(name\), texture\};/,
    );
});

test("refuses arbitrary or open-ended node-material block loaders", () => {
    assert.throws(
        () =>
            compileLoader(`
                async function loadBlock(className: string): Promise<any> {
                    return (await import(
                        "babylon-lite/material/node/blocks/add-block.js"
                    )).emitter;
                }
            `),
        /one closed switch statement/,
    );
    assert.throws(
        () =>
            compileLoader(`
                async function loadBlock(className: string): Promise<any> {
                    switch (className) {
                        case "AddBlock":
                            return (await import("babylon-lite/material/node/blocks/add-block.js")).emitter;
                    }
                }
            `),
        /requires a refusing default arm/,
    );
    assert.throws(
        () =>
            compileLoader(`
                async function loadBlock(className: string): Promise<any> {
                    switch (className) {
                        case "AddBlock":
                            return (await import("babylon-lite/material/node/node-registry.js")).loadBlockEmitter;
                        default:
                            throw new Error(className);
                    }
                }
            `),
        /returns only a pinned material\/node\/blocks module's emitter export/,
    );
    assert.throws(
        () =>
            compileLoader(`
                async function loadBlock(className: string): Promise<any> {
                    switch (className) {
                        case "AddBlock":
                            return (await import("./custom-emitter.js")).emitter;
                        default:
                            throw new Error(className);
                    }
                }
            `),
        /may import only the pinned material\/node\/blocks emitter modules/,
    );
    assert.throws(
        () =>
            compileLoader(`
                async function loadBlock(className: string): Promise<any> {
                    switch (className) {
                        case "MissingBlock":
                            return (await import("babylon-lite/material/node/blocks/not-a-real-block.js")).emitter;
                        default:
                            throw new Error(className);
                    }
                }
            `),
        /does not exist in the pinned material\/node\/blocks inventory/,
    );
    assert.throws(
        () =>
            compileLoader(`
                async function loadBlock(className: string): Promise<any> {
                    switch (className) {
                        default:
                            throw new Error(className);
                    }
                }
            `),
        /must map at least one class to a pinned block emitter/,
    );
});
