import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { CompileError } from "../src/compiler/compile-error.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    createRecordingDevice,
    RecordedTexture,
} from "../src/recording-device.js";

const setup = `const engine=await createEngine(document.getElementById('renderCanvas') as HTMLCanvasElement);const scene=createSceneContext(engine);`;
const splatImports = `import {createEngine,createSceneContext,loadSplat,type GsShaderFragment} from '@babylonjs/lite';`;
const plugin = `const plugin:GsShaderFragment={id:'neutral',helperFunctions:'fn neutral()->f32{return 1.0;}',fragmentSlots:{GS_FRAGMENT_MAIN_END:'finalColor=vec4<f32>(neutral());'}};`;
const splatCall = `await loadSplat(scene,'data:application/octet-stream;base64,AAAA',[plugin]);`;

test("retained splat descriptors project evaluated typed and aliased string fields", () => {
    const result = compileSource(`${splatImports}${plugin}
async function main(){${setup}const alias=plugin;await loadSplat(scene,'data:application/octet-stream;base64,AAAA',[alias]);}void main();`);
    assert.deepEqual(result.manifest.splatFragments, [
        {
            kind: "scene",
            id: "neutral",
            helperFunctions: "fn neutral()->f32{return 1.0;}",
            fragmentSlots: [
                {
                    slot: "GS_FRAGMENT_MAIN_END",
                    code: "finalColor=vec4<f32>(neutral());",
                },
            ],
        },
    ]);
    const absent = compileSource(`${splatImports}
import {gsLinearDepthFragment} from '@babylonjs/lite';
const plugin:GsShaderFragment={id:'no-helper',helperFunctions:undefined,fragmentSlots:{GS_FRAGMENT_MAIN_END:'code'}};
async function main(){${setup}await loadSplat(scene,'data:application/octet-stream;base64,AAAA',[gsLinearDepthFragment,plugin]);}void main();`);
    assert.deepEqual(absent.manifest.splatFragments, [
        { kind: "pinned", exportName: "gsLinearDepthFragment" },
        {
            kind: "scene",
            id: "no-helper",
            fragmentSlots: [{ slot: "GS_FRAGMENT_MAIN_END", code: "code" }],
        },
    ]);
});

test("retained descriptor admission rejects mutations and other alias escapes", () => {
    for (const [prefix, suffix] of [
        ["plugin.id=String(Date.now());", ""],
        ["", "plugin.id='changed';"],
        [
            "const slots=plugin.fragmentSlots;",
            "slots.GS_FRAGMENT_MAIN_END='changed';",
        ],
        [
            "const {fragmentSlots:slots}=plugin;",
            "slots.GS_FRAGMENT_MAIN_END='changed';",
        ],
        [
            "function forward(value:GsShaderFragment){return value;} const held=forward(plugin);",
            "void held;",
        ],
        ["", "for(const item of [plugin])item.id='changed';"],
    ]) {
        assert.throws(
            () =>
                compileSource(`${splatImports}${plugin}
async function main(){${setup}${prefix}${splatCall}${suffix}}void main();`),
            /retained generation descriptor requires stable/,
        );
    }
    assert.throws(
        () =>
            compileSource(`${splatImports}export ${plugin}
async function main(){${setup}${splatCall}}void main();`),
        /retained generation descriptor requires stable/,
    );
    assert.throws(
        () =>
            compileSource(`${splatImports}
const plugin:GsShaderFragment={get id(){return 'getter';},fragmentSlots:{GS_FRAGMENT_MAIN_END:'code'}};
async function main(){${setup}${splatCall}}void main();`),
        /accessor|plain properties|retained generation descriptor requires stable/,
    );
    assert.throws(
        () =>
            compileSource(`${splatImports}${plugin}
async function main(){${setup}const list=[plugin];await loadSplat(scene,'data:application/octet-stream;base64,AAAA',list);list.push(plugin);}void main();`),
        /retained generation descriptor requires stable|generation-known list/,
    );
});

const environmentFile = resolve(
    "corpus/babylon-lite/lab/lite/src/demos/environment.env",
);
const cubemapImports = `import {createEngine,createSceneContext,loadEnvironment,enablePbrLocalCubemap,createPbrLocalEnvironmentProbeSet} from '@babylonjs/lite';`;
const probeOptions = `{probes:[{environment,capturePosition:[0,0,0],projectionPosition:point,projectionSize:[4,4,4],influencePosition:point,influenceInnerSize:[1,1,1],influenceOuterSize:[4,4,4]}],voxelGrid:{minimum:[-2,-2,-2],maximum:[2,2,2],cellSize:2}}`;
function localProbeSource(after = ""): string {
    return `${cubemapImports}const point:[number,number,number]=[1,0,0];
async function main(){${setup}await enablePbrLocalCubemap({maxCandidates:2});
const environment=await loadEnvironment(scene,${JSON.stringify(environmentFile)});
createPbrLocalEnvironmentProbeSet(scene,${probeOptions});${after}}void main();`;
}

test("local probes pack proven stable owned tuple metadata and refuse later alias writes", () => {
    const result = compileSource(localProbeSource());
    const packet = [...result.assetPayloads.values()].find((source) =>
        source.startsWith("data:application/json;base64,"),
    );
    assert.ok(packet);
    const parsed: unknown = JSON.parse(
        Buffer.from(packet.split(",")[1]!, "base64").toString("utf8"),
    );
    assert.ok(
        typeof parsed === "object" && parsed !== null && "uniform" in parsed,
    );
    assert.ok(Array.isArray(parsed.uniform));
    const words = parsed.uniform.map((word: unknown) => {
        assert.ok(typeof word === "number");
        return word;
    });
    const values = new Float32Array(Uint32Array.from(words).buffer);
    assert.deepEqual(Array.from(values.slice(4, 7)), [1, 0, 0]);
    assert.deepEqual(Array.from(values.slice(16, 19)), [1, 0, 0]);
    assert.throws(
        () => compileSource(localProbeSource("const alias=point;alias[0]=2;")),
        /retained generation descriptor requires stable/,
    );
});

test("opaque retained results support their native consumers without exposing source geometry", () => {
    const source = (after = "") => `${cubemapImports}
import {createPbrMaterial,setPbrLocalEnvironmentProbeSet,setPbrLocalEnvironmentProbeDebug} from '@babylonjs/lite';
const point:[number,number,number]=[1,0,0];
function assign(material:ReturnType<typeof createPbrMaterial>,set:ReturnType<typeof createPbrLocalEnvironmentProbeSet>) {
    setPbrLocalEnvironmentProbeSet(material,set);
}
async function main(){${setup}await enablePbrLocalCubemap({maxCandidates:2});
const environment=await loadEnvironment(scene,${JSON.stringify(environmentFile)});
const set=createPbrLocalEnvironmentProbeSet(scene,${probeOptions});
const alias=set;
setPbrLocalEnvironmentProbeDebug(alias,true);
const material=createPbrMaterial({});assign(material,alias);${after}}void main();`;
    const result = compileSource(source());
    assert.equal(
        result.manifest.scenePbrMaterials?.[0]?.localCubemapCandidates,
        2,
    );
    for (const mutation of [
        "point[0]=2;",
        "const box={set,point};box.point[0]=2;",
        "const points=point;function later(){points[0]=2;}later();",
    ])
        assert.throws(
            () => compileSource(source(mutation)),
            /retained generation descriptor requires stable/,
        );
    for (const access of [
        "const geometry=alias.probes[0]!.projectionPosition;void geometry;",
        "const view=alias as unknown as {probes:{projectionPosition:number[]}[]};view.probes[0]!.projectionPosition[0]=2;",
    ])
        assert.throws(
            () => compileSource(source(access)),
            (error: unknown) => error instanceof CompileError,
        );
});

test("pinned recovery re-reads retained probe geometry while stable owners keep their values", async () => {
    const recorder = () =>
        createRecordingDevice({
            producer: "retained-probe-test",
            device: [
                "createBuffer",
                "createSampler",
                "createTexture",
                "createCommandEncoder",
            ],
            queue: ["submit", "writeBuffer"],
            encoder: ["copyTextureToTexture", "finish"],
            deviceFields: {
                limits: {
                    maxTextureArrayLayers: 2048,
                    maxUniformBufferBindingSize: 65536,
                    maxStorageBufferBindingSize: 134217728,
                    maxBufferSize: 268435456,
                },
            },
        });
    const engine = { _device: recorder().device };
    const texture = new RecordedTexture({
        size: [1, 1, 6],
        mipLevelCount: 1,
        format: "rgba16float",
        usage: 5,
    });
    const position = [1, 0, 0];
    const environment = {
        specularCube: texture,
        specularCubeView: texture.createView({ dimension: "cube" }),
        cubeSampler: {},
        sphericalHarmonics: new Float32Array(27),
        lodGenerationScale: 0.8,
    };
    const probe = {
        environment,
        capturePosition: [0, 0, 0],
        projectionPosition: position,
        projectionSize: [4, 4, 4],
        influencePosition: position,
        influenceInnerSize: [1, 1, 1],
        influenceOuterSize: [4, 4, 4],
    };
    const pin = await importPinnedModule<{
        enablePbrLocalCubemap(options: {
            maxCandidates: number;
        }): Promise<void>;
        createPbrLocalEnvironmentProbeSet(
            scene: object,
            options: object,
        ): {
            _ensureDevice(): void;
            _uniformData: Float32Array;
            probes: readonly object[];
        };
    }>("material/pbr/enable-pbr-local-cubemap.js");
    await pin.enablePbrLocalCubemap({ maxCandidates: 2 });
    const set = pin.createPbrLocalEnvironmentProbeSet(
        { surface: { engine }, _disposables: [] },
        {
            probes: [probe],
            voxelGrid: {
                minimum: [-2, -2, -2],
                maximum: [2, 2, 2],
                cellSize: 2,
            },
        },
    );
    assert.equal(set.probes[0], probe);
    assert.deepEqual(Array.from(set._uniformData.slice(4, 7)), [1, 0, 0]);
    engine._device = recorder().device;
    set._ensureDevice();
    assert.deepEqual(Array.from(set._uniformData.slice(4, 7)), [1, 0, 0]);
    position[0] = 2;
    engine._device = recorder().device;
    set._ensureDevice();
    assert.deepEqual(Array.from(set._uniformData.slice(4, 7)), [2, 0, 0]);
});
