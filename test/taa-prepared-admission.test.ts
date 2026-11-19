import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { pinnedLabPublicUrl } from "../src/pinned-lab-public.js";

const labDeployment = { publicUrl: pinnedLabPublicUrl() };

const prefix = `import {createEngine, createSceneContext, createRenderTarget, createRenderTask,
    createTaaPostProcessTask, createBlackAndWhitePostProcessTask, registerScene, createPbrMaterial,
    createGridMaterial, createStandardMaterial, createStandardNoColorMaterialView, loadSplat,
    loadEnvironment, setEnvironmentRotation, createCopyToTextureTask, addTask} from "@babylonjs/lite";
    const engine=await createEngine({});
    const scene=createSceneContext(engine,{defaultRenderTask:false});
    const rt=createRenderTarget({format:engine.format,dFormat:"depth24plus-stencil8",samples:1,size:engine});
    const source=createRenderTask({rt},engine,scene);`;
const taa = `const taa=createTaaPostProcessTask({sourceTexture:rt,sourceRenderTask:source,targetTexture:engine.scRT},engine,scene);`;

test("TAA refuses lossy image key writes through scene aliases and helper parameters", () => {
    for (const body of [
        `scene.imageProcessing.exposure=1+2**-25;`,
        `scene.imageProcessing.contrast+=2**-25;`,
        `const alias=scene;alias.imageProcessing.exposure=1+2**-25;`,
        `function change(owner){owner.imageProcessing.contrast=1+2**-25;}change(scene);`,
    ]) {
        assert.doesNotThrow(() => compileSource(prefix + body));
        for (const source of [prefix + body + taa, prefix + taa + body]) {
            assert.throws(
                () => compileSource(source),
                /imageProcessing\.(exposure|contrast).*double-precision TAA cache-key/,
            );
        }
    }
    // Paths with no owned image-processing representation already refuse;
    // they must not become silent escapes around the admitted setter fence.
    for (const body of [
        `const image=scene.imageProcessing;image.exposure=2;`,
        `scene.imageProcessing["exposure"]=2;`,
        `const key="exposure";scene.imageProcessing[key]=2;`,
        `const bag={owner:scene};bag.owner.imageProcessing.exposure=2;`,
        `Object.assign(scene.imageProcessing,{exposure:2});`,
    ])
        for (const source of [prefix + body + taa, prefix + taa + body]) {
            assert.throws(
                () => compileSource(source),
                /unsupported|not supported|Cannot|does not lower|requires tracked|Expected|Only property assignments/i,
            );
        }
});

test("pin image keys invalidate below float32 precision and reveal a changed contributor", async () => {
    const { createArcRotateCamera } = await importPinnedModule<{
        createArcRotateCamera(
            this: void,
            a: number,
            b: number,
            r: number,
            target: object,
        ): object;
    }>("camera/arc-rotate.js");
    const { _writePassSceneUBO } = await importPinnedModule<{
        _writePassSceneUBO(
            this: void,
            task: object,
            engine: object,
            scene: object,
            camera: object,
        ): void;
    }>("frame-graph/render-task.js");
    const { setClipPlane } = await importPinnedModule<{
        setClipPlane(this: void, scene: object, plane: number[]): void;
    }>("scene/scene-ubo-extras.js");
    const camera = createArcRotateCamera(-1, 1, 10, { x: 0, y: 0, z: 0 });
    for (const property of ["exposure", "contrast"] as const) {
        const source = {
            _config: { rt: { _width: 128, _height: 64 }, cs: false },
            _sceneUboCacheKey: [] as unknown[],
            _suData: new Float32Array(92),
            _sceneUBO: new Float32Array(92),
        };
        let writes = 0;
        const engine = {
            canvas: { width: 128, height: 64 },
            _device: {
                queue: {
                    writeBuffer(
                        target: Float32Array,
                        _offset: number,
                        data: Float32Array,
                    ) {
                        target.set(data);
                        writes++;
                    },
                },
            },
        };
        const scene = {
            imageProcessing: {
                exposure: 1,
                contrast: 1,
                toneMappingEnabled: false,
            },
        };
        setClipPlane(scene, [0, 0, 0, 0]);
        _writePassSceneUBO(source, engine, scene, camera);
        setClipPlane(scene, [1, 0, 0, 0]);
        _writePassSceneUBO(source, engine, scene, camera);
        assert.equal(writes, 1);
        assert.equal(source._sceneUBO[88], 0);
        scene.imageProcessing[property] = 1 + 2 ** -25;
        assert.equal(Math.fround(scene.imageProcessing[property]), 1);
        _writePassSceneUBO(source, engine, scene, camera);
        assert.equal(writes, 2);
        assert.equal(source._sceneUBO[88], 1);
        assert.equal(
            source._sceneUboCacheKey[property === "exposure" ? 4 : 5],
            1 + 2 ** -25,
        );
    }
});

test("TAA refuses explicit environment cache invalidation in either reach order", () => {
    const rotation = `setEnvironmentRotation(scene,.5);`;
    assert.doesNotThrow(() => compileSource(prefix + rotation));
    for (const source of [prefix + rotation + taa, prefix + taa + rotation]) {
        assert.throws(
            () => compileSource(source),
            /setEnvironmentRotation invalidates source-task caches/,
        );
    }
});

test("TAA leaves material and contributor admission to the prepared pass", () => {
    for (const body of [
        `createPbrMaterial({});`,
        `createGridMaterial();`,
        `createStandardNoColorMaterialView(createStandardMaterial());`,
        `await loadSplat(scene,"/cloud.splat");`,
        `await loadEnvironment(scene,"/studio.env",{skipGround:true});`,
    ]) {
        assert.doesNotThrow(() => compileSource(prefix + body, labDeployment));
        for (const source of [prefix + body + taa, prefix + taa + body]) {
            assert.doesNotThrow(() => compileSource(source, labDeployment));
        }
    }
});

test("TAA preparation requires one proven registered scene while preserving same-scene aliases", () => {
    const second = `const other=createSceneContext(engine,{defaultRenderTask:false});`;
    for (const registration of [
        "registerScene(scene);registerScene(other);",
        "registerScene(other);registerScene(scene);",
    ]) {
        assert.doesNotThrow(() =>
            compileSource(prefix + second + registration),
        );
        assert.throws(
            () => compileSource(prefix + second + taa + registration),
            /one proven registered scene/,
        );
        assert.throws(
            () => compileSource(prefix + second + registration + taa),
            /before initial scene registration/,
        );
    }
    assert.doesNotThrow(() =>
        compileSource(
            prefix +
                taa +
                `const alias=scene;registerScene(scene);registerScene(alias);`,
        ),
    );
});

test("TAA pass signatures admit the target's own attachments and refuse multisampled or unproven sampling", () => {
    for (const source of [
        prefix.replace('dFormat:"depth24plus-stencil8",', ""),
        prefix.replace('"depth24plus-stencil8"', '"depth32float"'),
        prefix.replace("format:engine.format", 'format:"rgba16float"'),
        // A colourless source pass is admitted; sampling it is refused where
        // the pass builds its GPU state, as the pin's is.
        prefix.replace("format:engine.format,", ""),
    ])
        assert.doesNotThrow(() => compileSource(source + taa));
    const multisampled = prefix.replace("samples:1", "samples:4");
    assert.doesNotThrow(() => compileSource(multisampled));
    assert.throws(
        () => compileSource(multisampled + taa),
        /proven single-sample source texture/,
    );
    const derived = `const pass=createBlackAndWhitePostProcessTask({sourceTexture:rt},engine,scene);`;
    assert.throws(
        () =>
            compileSource(
                prefix +
                    derived +
                    taa.replace(
                        "sourceTexture:rt",
                        "sourceTexture:pass.outputTexture",
                    ),
            ),
        /proven single-sample source texture/,
    );
    // A multisampled source pass may resolve into the separately proven 1x
    // texture sampled by TAA. It shares the same clean/retained Scene UBO.
    const resolve = `const resolved=createRenderTarget({format:engine.format,samples:1,size:engine});`;
    assert.doesNotThrow(() =>
        compileSource(
            multisampled
                .replace("const source=", resolve + "const source=")
                .replace(
                    "createRenderTask({rt}",
                    "createRenderTask({rt,rst:resolved}",
                ) + taa.replace("sourceTexture:rt", "sourceTexture:resolved"),
        ),
    );
});

test("TAA admits copy tasks in its frame graph, on either side of the TAA task and as its source", () => {
    // A temporal accumulator's history update: its own target, owned by the copy.
    const history = `const history=createRenderTarget({format:"rgba16float",samples:1,size:engine});`;
    const copy = `addTask(scene,createCopyToTextureTask({name:"keep",sourceTexture:rt,targetTexture:history,ownsTargetTexture:true},engine,scene));`;
    for (const body of [
        history + copy + taa,
        history + taa + copy,
        history.replace('"rgba16float"', "engine.format") +
            copy +
            taa.replace("sourceTexture:rt", "sourceTexture:history"),
    ]) {
        assert.doesNotThrow(() => compileSource(prefix + body));
    }
});

/** A normal pre-pass beside the TAA source, as an app's SSAO source builds it. */
const ownTargetPass = (
    format: string,
) => `import {createEngine, createSceneContext, createRenderTarget, createRenderTask,
    createTaaPostProcessTask, createArcRotateCamera, createSurfaceRenderTargetTexture, withSampledDepthTexture,
    enableRenderTaskMeshRefresh, addTaskAtStart} from "@babylonjs/lite";
const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene=createSceneContext(engine,{defaultRenderTask:false});
const camera=createArcRotateCamera(0,1,6,{x:0,y:0,z:0});
scene.camera=camera;
const rt=createRenderTarget({format:engine.format,dFormat:"depth24plus-stencil8",samples:1,size:engine});
const source=createRenderTask({rt},engine,scene);
const normals=createSurfaceRenderTargetTexture(engine,{${format}dFormat:"depth24plus",depthCompare:"greater-equal",
    depthClearValue:0,samples:1,size:{surface:engine,scale:.5}},withSampledDepthTexture);
const pass=createRenderTask({name:"normals",rt:normals.rt,clrColor:{r:0,g:0,b:0,a:1},clr:true,cam:camera,cs:true,
    autoMirror:false},engine,scene);
enableRenderTaskMeshRefresh(pass);
addTaskAtStart(scene,pass);`;

test("TAA admits another render task drawing into its own target formats, colour or depth-only", () => {
    for (const format of ['format:"rgba8unorm",', ""]) {
        const own = ownTargetPass(format);
        assert.doesNotThrow(() => compileSource(own));
        assert.doesNotThrow(() => compileSource(own + taa));
    }
});

test("TAA admits a multisampled depth-only render task, as an app's mesh-blending visibility pass builds it", () => {
    const direct = `const visibility=createRenderTarget({lbl:"visibility",dFormat:"depth24plus-stencil8",samples:4,size:engine});
const visibilityTask=createRenderTask({name:"visibility",rt:visibility,cam:camera,autoMirror:false},engine,scene);
enableRenderTaskMeshRefresh(visibilityTask);`;
    // A runtime-selected target keeps its attachment signature through the
    // optional storage its selection fills.
    const selected = `const sceneSamples:1|4=Math.random()<2?4:1;
const visibility=sceneSamples>1?createRenderTarget({lbl:"visibility",dFormat:"depth24plus-stencil8",samples:4,size:engine}):null;
const visibilityTask=visibility?createRenderTask({name:"visibility",rt:visibility,cam:camera,autoMirror:false},engine,scene):null;
if(visibilityTask)enableRenderTaskMeshRefresh(visibilityTask);`;
    for (const visibility of [direct, selected]) {
        const source = ownTargetPass('format:"rgba8unorm",') + visibility;
        assert.doesNotThrow(() => compileSource(source));
        assert.doesNotThrow(() => compileSource(source + taa));
    }
    // A reassignable slot may hold another target: its signature is unproven.
    const reassignable =
        ownTargetPass('format:"rgba8unorm",') +
        selected.replace("const visibility=", "let visibility=");
    assert.doesNotThrow(() => compileSource(reassignable));
    assert.throws(
        () => compileSource(reassignable + taa),
        /render task whose target has no proven attachment signature/,
    );
});
