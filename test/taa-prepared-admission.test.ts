import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const prefix = `import {createEngine, createSceneContext, createRenderTarget, createRenderTask,
    createTaaPostProcessTask, createBlackAndWhitePostProcessTask, registerScene, createPbrMaterial,
    createGridMaterial, createStandardMaterial, createStandardNoColorMaterialView, loadSplat,
    loadEnvironment} from "@babylonjs/lite";
    const engine=await createEngine({});
    const scene=createSceneContext(engine,{defaultRenderTask:false});
    const rt=createRenderTarget({format:engine.format,dFormat:"depth24plus-stencil8",samples:1,size:engine});
    const source=createRenderTask({rt},engine,scene);`;
const taa = `const taa=createTaaPostProcessTask({sourceTexture:rt,sourceRenderTask:source,targetTexture:engine.scRT},engine,scene);`;

test("TAA preparation refuses unrepresented renderer families in either reach order", () => {
    for (const [body, feature] of [
        [`createPbrMaterial({});`, "material:pbr"],
        [`createGridMaterial();`, "material:grid"],
        [`createStandardNoColorMaterialView(createStandardMaterial());`, "material:no-color-view"],
        [`await loadSplat(scene,"/cloud.splat");`, "loader:splat"],
        [`await loadEnvironment(scene,"/studio.env",{skipGround:true});`, "background:"],
    ]) {
        assert.doesNotThrow(() => compileSource(prefix + body));
        for (const source of [prefix + body + taa, prefix + taa + body]) {
            assert.throws(() => compileSource(source), error => error instanceof Error &&
                error.message.includes("TAA source preparation") && error.message.includes(feature!));
        }
    }
});

test("TAA preparation requires one proven registered scene while preserving same-scene aliases", () => {
    const second = `const other=createSceneContext(engine,{defaultRenderTask:false});`;
    for (const registration of ["registerScene(scene);registerScene(other);", "registerScene(other);registerScene(scene);"]) {
        assert.doesNotThrow(() => compileSource(prefix + second + registration));
        assert.throws(() => compileSource(prefix + second + taa + registration), /one proven registered scene/);
        assert.throws(() => compileSource(prefix + second + registration + taa), /before initial scene registration/);
    }
    assert.doesNotThrow(() => compileSource(prefix + taa + `const alias=scene;registerScene(scene);registerScene(alias);`));
});

test("TAA pass signatures refuse missing depth, alternate depth and multisampled or unproven sampling", () => {
    for (const source of [
        prefix.replace('dFormat:"depth24plus-stencil8",', ""),
        prefix.replace('"depth24plus-stencil8"', '"depth32float"'),
        prefix.replace("format:engine.format,", ""),
        prefix.replace("format:engine.format", 'format:"rgba16float"'),
    ]) {
        assert.doesNotThrow(() => compileSource(source));
        assert.throws(() => compileSource(source + taa), /engine color format and depth24plus-stencil8/);
    }
    const multisampled = prefix.replace("samples:1", "samples:4");
    assert.doesNotThrow(() => compileSource(multisampled));
    assert.throws(() => compileSource(multisampled + taa), /proven single-sample source texture/);
    const derived = `const pass=createBlackAndWhitePostProcessTask({sourceTexture:rt},engine,scene);`;
    assert.throws(() => compileSource(prefix + derived + taa.replace("sourceTexture:rt", "sourceTexture:pass.outputTexture")),
        /proven single-sample source texture/);
    // A multisampled source pass may resolve into the separately proven 1x
    // texture sampled by TAA. It shares the same clean/retained Scene UBO.
    const resolve = `const resolved=createRenderTarget({format:engine.format,samples:1,size:engine});`;
    assert.doesNotThrow(() => compileSource(multisampled.replace("const source=", resolve + "const source=")
        .replace("createRenderTask({rt}", "createRenderTask({rt,rst:resolved}") + taa.replace("sourceTexture:rt", "sourceTexture:resolved")));
});
