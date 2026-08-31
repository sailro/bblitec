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

function compileLoader(loader: string) {
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
                blockLoader: loadBlock,
            });
        }
        main();
    `);
}

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
    const source = new FactoryLowerer(
        new LoweringContext(),
    ).lowerNodeMaterialFactory().source;

    assert.match(
        source,
        /normalized\.data\.bytes\.assign\(\s*texture\.texel\.begin\(\),\s*texture\.texel\.end\(\)\);/,
    );
    assert.match(
        source,
        /normalized\.data\.rgba_width = 1;\s*normalized\.data\.rgba_height = 1;/,
    );
    assert.match(
        source,
        /normalized\.data\.sampler\.min_filter = TextureFilter::linear;\s*normalized\.data\.sampler\.mag_filter = TextureFilter::linear;/,
    );
    assert.match(
        source,
        /normalized\.data\.sampler\.mipmap_mode = TextureMipmapMode::nearest;/,
    );
    assert.match(
        source,
        /normalized\.data\.sampler\.address_u = TextureAddressMode::clamp;\s*normalized\.data\.sampler\.address_v = TextureAddressMode::clamp;/,
    );
    assert.match(source, /normalized\.data\.sampler\.max_lod = 0\.0f;/);
    assert.match(
        source,
        /normalized\.width = 1;\s*normalized\.height = 1;/,
    );
});

test("dispatches stored node textures without losing pixels metadata", () => {
    const source = new FactoryLowerer(
        new LoweringContext(),
    ).lowerNodeMaterialFactory().source;

    assert.match(
        source,
        /const PixelsTexture& texture\) \{[\s\S]*normalized\.data\.bytes = texture\.rgba;[\s\S]*normalized\.data\.rgba_width = texture\.width;[\s\S]*normalized\.data\.rgba_height = texture\.height;/,
    );
    assert.match(
        source,
        /normalized\.data\.sampler = texture\.sampler;\s*normalized\.data\.uv_transform = texture\.uv_transform;\s*normalized\.data\.uv_invert_y = texture\.uv_invert_y;/,
    );
    assert.match(
        source,
        /const StoredTexture& texture\) \{\s*return std::visit\([\s\S]*node_material_texture\(std::move\(name\), stored\);/,
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
