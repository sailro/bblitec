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
        [],
        false,
        compiled.blockEmitters,
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
                [],
                false,
                withoutDerivative,
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
