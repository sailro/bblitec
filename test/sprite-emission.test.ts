import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { GeneratedTree } from "../src/generated-tree.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { spriteVertexWgsl } from "../src/shader-builtins-sprite.js";
import { emitUpstreamGenerated, type UpstreamEmitOptions } from "../src/upstream-lower.js";

class EmittedFiles extends GeneratedTree {
    readonly contents = new Map<string, string>();
    constructor() { super(resolve("artifacts/sprite-emission")); }
    override write(path: string, data: string | Uint8Array): boolean {
        this.contents.set(path, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
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
        idDiagnostics: false, shaderPrograms: [], spriteCustomShaders: [], effects: [],
        pureSpriteVertex: pure, plainSpriteLayer: true, plainBillboardSystem: false,
        geometryOutputTasks: [], postProcessTasks: [], postProcessShaders: [], postProcessComposites: [],
        gpuDeformation: false, animatedWorldBounds: false, morphStorage: false,
        nonTrianglePrimitives: false, gaussianSplats: false, compressedImages: false,
        nodeVisibility: false, gltfNodeVisibility: false, animationPointer: false,
        animationPointerMaterials: false, assetTransmission: false, materialSpecular: false,
        selectedMaterialVariant: "", standardLightLists: false, standardDiffuseUv2: false,
        textureTransform: false, imageBasedLighting: false, gpuInstancing: false,
        gpuInstanceColors: false, punctualLights: false, clearcoat: false, sheen: false,
        iridescence: false, specularGlossiness: false, dispersion: false, occlusionUv2: false,
    };
}

test("upstream emission publishes only reached sprite vertex programs and their pinned origins", () => {
    const context = new LoweringContext(), sprites = new SpriteLowerer(context);
    const provenance = context.provenance("src/sprite/sprite-pipeline.ts", "makeSpriteWgsl");
    const origins = [
        { modulePath: "src/sprite/sprite-scene.ts", symbolName: "addDepthHostedSpriteLayer" },
        { modulePath: "src/sprite/sprite-renderable.ts", symbolName: "buildSpriteRenderable" },
        { modulePath: "src/render/alpha-to-coverage.ts", symbolName: "setAlphaToCoverage" },
    ];
    for (const pure of [false, true]) for (const depth of [false, true]) for (const scroll of [false, true]) {
        const tree = new EmittedFiles();
        emitUpstreamGenerated(tree.root, ["core", "sprite:2d", "renderer:sprite",
            ...(depth ? ["sprite:2d-depth-host"] : []), ...(scroll ? ["sprite:uv-scroll"] : [])], options(pure), tree);
        const expected = new Map<string, string>();
        for (const [reached, depthHosted, stem] of [[pure, false, "sprite"], [depth, true, "sprite_depth"]] as const) {
            if (!reached) continue;
            for (const uvScroll of scroll ? [false, true] : [false]) {
                expected.set(`upstream/shaders/${stem}${uvScroll ? "_uvscroll" : ""}.vert.native.wgsl`,
                    spriteVertexWgsl(provenance, sprites.shaderSource(uvScroll, undefined, [], depthHosted)));
            }
        }
        assert.deepEqual(new Map([...tree.contents].filter(([path]) => path.includes("/sprite") && path.endsWith(".vert.native.wgsl"))),
            expected, JSON.stringify({ pure, depth, scroll }));
        const composition: { modules: { output: string }[] } = JSON.parse(tree.read("upstream/shaders/composition.json"));
        assert.deepEqual(composition.modules.map(module => module.output).filter(path => path.includes("/sprite") && path.endsWith(".vert.native.wgsl")).sort(),
            [...expected.keys()].sort());
        const manifest: { generated: { modulePath: string; symbolName: string }[] } = JSON.parse(tree.read("upstream/provenance.json"));
        for (const origin of origins) assert.equal(manifest.generated.filter(item =>
            item.modulePath === origin.modulePath && item.symbolName === origin.symbolName).length, 1);
    }
    const absent = new EmittedFiles();
    emitUpstreamGenerated(absent.root, ["core"], options(true), absent);
    assert.equal([...absent.contents.keys()].some(path => path.includes("/sprite")), false);
    const manifest: { generated: { modulePath: string; symbolName: string }[] } = JSON.parse(absent.read("upstream/provenance.json"));
    for (const origin of origins) assert.equal(manifest.generated.some(item =>
        item.modulePath === origin.modulePath && item.symbolName === origin.symbolName), false);
});
