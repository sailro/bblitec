import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { readNativeHostUi } from "../src/native-host-ui.js";

const source = (body: string) => `import { createEngine, createTextRenderer, registerTextRenderer,
    createSceneContext, createFreeCamera, createBox, createStandardMaterial, addToScene, registerScene, createSpriteRenderer, registerSpriteRenderer,
    createEffectWrapper, createEffectRenderer, registerEffectRenderer,
    createFrameGraphContext, registerFrameGraphContext, startEngine } from "@babylonjs/lite";
    async function main() { const engine = await createEngine({}); ${body} await startEngine(engine); }
    void main();`;
const text = "registerTextRenderer(createTextRenderer(engine, {layers:[]}));";
const others = [
    ["renderer:scene", "const scene = createSceneContext(engine); scene.camera = createFreeCamera({x:0,y:0,z:-5}, {x:0,y:0,z:0}); const box = createBox(engine); box.material = createStandardMaterial(); addToScene(scene, box); registerScene(scene);"],
    ["renderer:sprite", "registerSpriteRenderer(createSpriteRenderer(engine, {layers:[]}));"],
    ["renderer:frame-graph", "registerFrameGraphContext(createFrameGraphContext(engine));"],
    ["renderer:effect", `const effect = createEffectWrapper(engine, {
        name:"fx", fragmentWGSL:"@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return vec4<f32>(1.0);}"});
        registerEffectRenderer(createEffectRenderer(engine, effect, {name:"fx-renderer"}));`],
] as const;

test("standalone text refuses mixed context registration in either order", () => {
    for (const [feature, other] of others) {
        const compatible = compileSource(source(other));
        assert(compatible.manifest.features.includes(feature), `${feature} reaches its ordinary driver`);
        for (const body of [text + other, other + text]) {
            assert.throws(() => compileSource(source(body)), error => {
                assert(error instanceof Error);
                assert.match(error.message, /Standalone text rendering cannot be combined/);
                assert(error.message.includes(feature));
                return true;
            }, `${feature}: ${body.startsWith(text) ? "text first" : "text last"}`);
        }
    }
});

test("standalone text admission retains both pinned text scene paths", () => {
    for (const [id, standalone] of [[180, true], [181, false]] as const) {
        const fileName = `corpus/babylon-lite/lab/lite/src/lite/scene${id}.ts`;
        const result = compileSource(readFileSync(fileName, "utf8"), {fileName, nativeHostUi:readNativeHostUi(`ui/scene${id}-host.json`)});
        assert.equal(result.manifest.features.includes("renderer:text"), standalone);
        assert.equal(result.manifest.features.includes("renderer:scene"), !standalone);
    }
});

test("unregistered renderer factories do not create mixed rendering contexts", () => {
    for (const [, other] of others) {
        compileSource(source(`createTextRenderer(engine, {layers:[]}); ${other}`));
    }
    compileSource(source(`${text} const scene = createSceneContext(engine);
        const box = createBox(engine); box.material = createStandardMaterial();
        addToScene(scene, box); createSpriteRenderer(engine, {layers:[]});`));
});
