import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { jsonObject, jsonRecords, jsonString } from "./json.js";
import { GeneratedTree } from "../src/generated-tree.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import {
    emitUpstreamGenerated,
    type UpstreamEmitOptions,
} from "../src/upstream-lower.js";

class EmittedFiles extends GeneratedTree {
    readonly contents = new Map<string, string>();
    constructor() {
        super(resolve("artifacts/sprite-emission"));
    }
    override write(path: string, data: string | Uint8Array): boolean {
        this.contents.set(
            path,
            typeof data === "string"
                ? data
                : Buffer.from(data).toString("utf8"),
        );
        return true;
    }
    read(path: string): string {
        const result = this.contents.get(path);
        assert.notEqual(result, undefined, path);
        return result!;
    }
}

function options(pure: boolean): UpstreamEmitOptions {
    return {
        idDiagnostics: false,
        shaderPrograms: [],
        spriteCustomShaders: [],
        effects: [],
        pureSpriteVertex: pure,
        plainSpriteLayer: true,
        plainBillboardSystem: false,
        geometryOutputTasks: [],
        postProcessTasks: [],
        postProcessShaders: [],
        postProcessComposites: [],
        gpuDeformation: false,
        morphStorage: false,
        nonTrianglePrimitives: false,
        gaussianSplats: false,
        compressedImages: false,
        nodeVisibility: false,
        gltfNodeVisibility: false,
        animationPointer: false,
        animationPointerMaterials: false,
        assetTransmission: false,
        transmission: false,
        materialSpecular: false,
        selectedMaterialVariant: "",
        standardLightLists: false,
        standardDiffuseUv2: false,
        textureTransform: false,
        imageBasedLighting: false,
        gpuInstancing: false,
        gpuInstanceColors: false,
        punctualLights: false,
        clearcoat: false,
        sheen: false,
        iridescence: false,
        specularGlossiness: false,
        dispersion: false,
        occlusionUv2: false,
    };
}

test("upstream emission publishes only reached sprite programs and their pinned origins", () => {
    const context = new LoweringContext(),
        sprites = new SpriteLowerer(context);
    const provenance = context.provenance(
        "src/sprite/sprite-pipeline.ts",
        "makeSpriteWgsl",
    );
    const origins = [
        {
            modulePath: "src/sprite/sprite-scene.ts",
            symbolName: "addDepthHostedSpriteLayer",
        },
        {
            modulePath: "src/sprite/sprite-renderable.ts",
            symbolName: "buildSpriteRenderable",
        },
        {
            modulePath: "src/render/alpha-to-coverage.ts",
            symbolName: "setAlphaToCoverage",
        },
    ];
    for (const pure of [false, true])
        for (const depth of [false, true])
            for (const scroll of [false, true]) {
                const tree = new EmittedFiles();
                emitUpstreamGenerated(
                    tree.root,
                    [
                        "core",
                        "sprite:2d",
                        "renderer:sprite",
                        ...(depth ? ["sprite:2d-depth-host"] : []),
                        ...(scroll ? ["sprite:uv-scroll"] : []),
                    ],
                    options(pure),
                    tree,
                );
                // Each reached permutation's program is the pin's module,
                // deployed whole under its fragment stem, the vertex stem
                // compiling from it.
                const expected = new Map<string, string>();
                for (const [reached, depthHosted, stem] of [
                    [pure, false, "sprite"],
                    [depth, true, "sprite_depth"],
                ] as const) {
                    if (!reached) continue;
                    for (const uvScroll of scroll ? [false, true] : [false]) {
                        expected.set(
                            `upstream/shaders/${stem}${uvScroll ? "_uvscroll" : ""}.frag.native.wgsl`,
                            `// ${provenance}\n${sprites.module({ hasDepth: depthHosted, uvScroll })}`,
                        );
                    }
                }
                assert.deepEqual(
                    new Map(
                        [...tree.contents].filter(
                            ([path]) =>
                                path.includes("/sprite") &&
                                path.endsWith(".native.wgsl"),
                        ),
                    ),
                    expected,
                    JSON.stringify({ pure, depth, scroll }),
                );
                const composition = jsonObject(
                    JSON.parse(tree.read("upstream/shaders/composition.json")),
                );
                const modules = jsonRecords(composition.modules).filter(
                    (module) => jsonString(module.output).includes("/sprite"),
                );
                assert.deepEqual(
                    modules.map((module) => jsonString(module.output)).sort(),
                    [...expected.keys()].sort(),
                );
                // Both stages enter where the pin's module declares them.
                for (const module of modules) {
                    assert.equal(jsonString(module.entryPoint), "fs");
                    const [vertex] = jsonRecords(module.alsoStages);
                    assert.equal(jsonString(vertex!.entryPoint), "vs");
                    assert.equal(
                        jsonString(vertex!.stem),
                        jsonString(module.output)
                            .slice("upstream/shaders/".length)
                            .replace(".frag.native.wgsl", ".vert"),
                    );
                }
                const manifest = jsonObject(
                    JSON.parse(tree.read("upstream/provenance.json")),
                );
                for (const origin of origins)
                    assert.equal(
                        jsonRecords(manifest.generated).filter(
                            (item) =>
                                item.modulePath === origin.modulePath &&
                                item.symbolName === origin.symbolName,
                        ).length,
                        1,
                    );
            }
    const absent = new EmittedFiles();
    emitUpstreamGenerated(absent.root, ["core"], options(true), absent);
    assert.equal(
        [...absent.contents.keys()].some((path) => path.includes("/sprite")),
        false,
    );
    const manifest = jsonObject(
        JSON.parse(absent.read("upstream/provenance.json")),
    );
    for (const origin of origins)
        assert.equal(
            jsonRecords(manifest.generated).some(
                (item) =>
                    item.modulePath === origin.modulePath &&
                    item.symbolName === origin.symbolName,
            ),
            false,
        );
});
