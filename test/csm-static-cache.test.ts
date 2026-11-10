import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { csmRefitLibrary } from "../src/lowering/csm-static-cache.js";
import { FactoryLowerer } from "../src/lowering/factory/material-factories.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";

interface PinCaster {
    worldMatrixVersion: number;
    thinInstances?: { _version: number };
}
interface PinGate {
    syncCasters(next: readonly PinCaster[]): void;
    isDynamic(caster: PinCaster): boolean;
    _lastRefitDriftOnly(): boolean;
    _lastDynamicChanged(): boolean;
    update(
        x: number,
        y: number,
        z: number,
        nowMs: number,
        cameraChanged: boolean,
        force: boolean,
        onPromote: (caster: PinCaster) => void,
        onDemote: (caster: PinCaster) => void,
    ): { refit: boolean; renderDynamic: boolean };
}
interface PinScheduler {
    arm(spread: boolean): void;
    pending(): boolean;
    take(): number[];
}

/** One frame of the script both sides run: who moves, where the light points, what else changed. */
interface ScriptFrame {
    moved: number[];
    light: [number, number, number];
    nowMs: number;
    cameraChanged: boolean;
    force: boolean;
    casters: number[];
}

function script(): ScriptFrame[] {
    const frames: ScriptFrame[] = [];
    for (let frame = 0; frame < 420; frame++) {
        const moved = [0];
        if (frame === 10 || frame === 260) moved.push(1);
        if (frame === 300) moved.push(2);
        // The light drifts in small steps (a drift refit every few frames
        // under a 0.01 rad threshold), and pauses between 140 and 220.
        const angle =
            frame < 140
                ? frame * 0.004
                : frame < 220
                  ? 0.56
                  : 0.56 + (frame - 220) * 0.004;
        frames.push({
            moved,
            light: [Math.sin(angle), -1, -Math.cos(angle)],
            nowMs: frame * 16,
            cameraChanged: frame === 50,
            force: frame === 70,
            casters: frame >= 150 && frame < 160 ? [0, 1] : [0, 1, 2, 3],
        });
    }
    return frames;
}

test("the CSM refit gate and static refit scheduler match the pin frame by frame", async (t) => {
    const { createCsmRefitGate, createCsmStaticRefitScheduler } =
        await importPinnedModule<{
            createCsmRefitGate(this: void, options: object): PinGate;
            createCsmStaticRefitScheduler(
                this: void,
                count: number,
                perFrame: number,
            ): PinScheduler;
        }>("shadow/csm-refit-gate.js");
    const frames = script();
    const casters: PinCaster[] = [0, 1, 2, 3].map((index) => ({
        worldMatrixVersion: index,
        ...(index === 3 ? { thinInstances: { _version: 2.7 } } : {}),
    }));
    const gate = createCsmRefitGate({
        refitAngle: 0.01,
        refitMaxIntervalMs: 1000,
    });
    const scheduler = createCsmStaticRefitScheduler(4, 1);
    let list: PinCaster[] = [];
    let listKey = "";
    const lines: string[] = [];
    for (const frame of frames) {
        for (const index of frame.moved) casters[index]!.worldMatrixVersion++;
        const key = frame.casters.join(",");
        if (key !== listKey) {
            list = frame.casters.map((index) => casters[index]!);
            listKey = key;
        }
        gate.syncCasters(list);
        const decision = gate.update(
            ...frame.light,
            frame.nowMs,
            frame.cameraChanged,
            frame.force,
            () => {},
            () => {},
        );
        if (decision.refit)
            scheduler.arm(gate._lastRefitDriftOnly() && !scheduler.pending());
        const taken = scheduler.pending() ? scheduler.take().join("") : "-";
        lines.push(
            `${+decision.refit}${+decision.renderDynamic}${+gate._lastRefitDriftOnly()}${+gate._lastDynamicChanged()}:${casters.map((caster) => +gate.isDynamic(caster)).join("")}:${taken}`,
        );
    }
    // Every arm is exercised: the first refit publishes every cascade at
    // once, a drift refit spreads them one per frame, quiet casters demote
    // on a refit, a moved static caster promotes, and a re-supplied caster
    // set re-enters dynamic.
    const joined = lines.join("|");
    for (const reached of [
        "1101:1111:0123",
        "1111:1111:0",
        "1101:1000:2301",
        "1101:1011:2301",
        "1101:1111:3012",
        "0101:1011:-",
    ])
        assert.ok(lines.includes(reached), reached);

    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const cpp = (values: readonly (number | boolean)[]): string =>
        values
            .map((value) =>
                typeof value === "boolean" ? String(value) : String(value),
            )
            .join(", ");
    const library = csmRefitLibrary(new LoweringContext());
    runGeneratedProgram(
        tools,
        "csm-static-cache/refit-gate",
        `#include <bblite/runtime.hpp>
${library.includes.map((header) => `#include <${header}>`).join("\n")}
#include <algorithm>
#include <cmath>
#include <iostream>
#include <string>
${library.source}
using namespace bbl;
struct Frame { std::vector<int> moved; double x, y, z, now; bool camera, force; std::vector<int> casters; };
int main() {
    Engine engine;
    engine.meshes.resize(4);
    for (std::size_t index = 0; index < 4; ++index) engine.meshes[index].transform_version = index;
    engine.meshes[3].thin_instances = std::make_shared<ThinInstancePoolData>();
    engine.meshes[3].thin_instances->version = 2.7;
    const std::vector<Frame> frames = {
${frames.map((frame) => `        {{${cpp(frame.moved)}}, ${frame.light.map((v) => v.toPrecision(17)).join(", ")}, ${frame.nowMs}, ${frame.cameraChanged}, ${frame.force}, {${cpp(frame.casters)}}}`).join(",\n")}
    };
    ShadowGeneratorRecord generator;
    CsmStaticCacheState cache;
    cache.options = {0.01, 1000, 1};
    upstream::csm_refit_start(engine, cache, generator, 4);
    CsmRefitRuntime& refit = *upstream::csm_refit_runtime(cache);
    std::string key, out;
    for (const Frame& frame : frames) {
        for (const int index : frame.moved) ++engine.meshes[index].transform_version;
        std::string next;
        for (const int index : frame.casters) next += std::to_string(index) + ",";
        if (next != key) {
            generator.caster_meshes.clear();
            for (const int index : frame.casters) generator.caster_meshes.push_back(MeshHandle{static_cast<std::uint32_t>(index)});
            ++generator.caster_list_version;
            key = next;
        }
        upstream::csm_refit_sync(engine, refit, generator);
        const auto decision = refit.gate->update(frame.x, frame.y, frame.z, frame.now, frame.camera, frame.force, refit.on_move, refit.on_move);
        if (decision.refit) refit.scheduler->arm(refit.gate->last_refit_drift_only() && !refit.scheduler->pending());
        std::string taken = "-";
        if (refit.scheduler->pending()) {
            taken.clear();
            for (const double cascade : refit.scheduler->take()) taken += std::to_string(static_cast<int>(cascade));
        }
        std::string dynamic;
        for (std::uint32_t index = 0; index < 4; ++index) dynamic += upstream::csm_refit_is_dynamic(engine, cache, MeshHandle{index}) ? "1" : "0";
        out += std::string(out.empty() ? "" : "|") + (decision.refit ? "1" : "0") + (decision.render_dynamic ? "1" : "0") +
               (refit.gate->last_refit_drift_only() ? "1" : "0") + (refit.gate->last_dynamic_changed() ? "1" : "0") + ":" + dynamic + ":" + taken;
    }
    std::cout << out;
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1"],
            timeoutMs: 20000,
            expectedOutput: joined,
        },
    );
});

test("enableCsmStaticCache lowers in a scene and refuses an unawaited call", () => {
    const prefix = `import {createEngine,createSceneContext,createFreeCamera,createTorusKnot,addToScene,createDirectionalLight,
createCsmDirectionalShadowGenerator,setShadowTaskCasterMeshes,registerSceneWithShadowSupport,enableCsmStaticCache,
createStandardMaterial} from "@babylonjs/lite";
const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene=createSceneContext(engine);
scene.camera=createFreeCamera([0,10,-20],[0,0,0]);
const light=createDirectionalLight([0,-1,-1],1);
addToScene(scene,light);
const knot=createTorusKnot(engine,{radius:2,tube:0.5});
knot.material=createStandardMaterial();
addToScene(scene,knot);
const sg=createCsmDirectionalShadowGenerator(engine,light,{numCascades:2});
light.shadowGenerator=sg;
setShadowTaskCasterMeshes(sg,[knot]);
`;
    const result = compileSource(
        `${prefix}await enableCsmStaticCache(engine,sg,{refitAngle:0.01,staticCascadesPerFrame:1});
await registerSceneWithShadowSupport(scene);`,
    );
    assert.equal(result.manifest.deferredCapabilities?.length ?? 0, 0);
    assert.ok(result.manifest.features.includes("shadow:csm-static-cache"));
    assert.match(
        result.cpp,
        /bbl::enable_csm_static_cache\(v_engine, v_sg, 0\.01, std::nullopt, std::optional<double>\{1\.0\}\)/,
    );
    // The receiver texture is the generator's own record, kept where the
    // call runs: enableCsmStaticCache reads it at run time.
    const read = compileSource(
        `${prefix.replace("createStandardMaterial}", "createStandardMaterial,getCsmReceiverTexture}")}const receiver=getCsmReceiverTexture(sg);
await enableCsmStaticCache(engine,sg,{refitAngle:0.01});
await registerSceneWithShadowSupport(scene);
void receiver;`,
    ).cpp;
    const taken = read.indexOf("bbl::get_csm_receiver_texture(v_engine, v_sg)");
    assert.ok(
        taken >= 0 && taken < read.indexOf("bbl::enable_csm_static_cache("),
    );
    assert.throws(
        () =>
            compileSource(
                `${prefix}void enableCsmStaticCache(engine,sg,{refitAngle:0.01});`,
            ),
        /awaits enableCsmStaticCache directly/,
    );
    assert.throws(
        () =>
            compileSource(
                `${prefix}await enableCsmStaticCache(engine,sg,{refitAngle:0.01,cascadeCoveragePadding:0.1});`,
            ),
        /Reached enableCsmStaticCache options/,
    );
});

test("a custom receiver binds the receiver texture of a generator a record stored", () => {
    // The options record is built with spreads, so the generator reaches
    // the read as a stored handle rather than as the scene's own value.
    const { cpp } =
        compileSource(`import {createEngine,createSceneContext,createFreeCamera,createGround,addToScene,createDirectionalLight,
createCsmDirectionalShadowGenerator,createShaderMaterial,getCsmReceiverTexture,setShaderTexture,registerSceneWithShadowSupport,
type ShaderMaterial,type ShadowGenerator,type Texture2D} from "@babylonjs/lite";
interface DecorOptions{enabled?:boolean;capacity?:number;shadow?:ShadowGenerator}
interface HostOptions{decor?:{enabled?:boolean};shadow?:ShadowGenerator}
function receiverTexture(shadow:ShadowGenerator):Texture2D{return getCsmReceiverTexture(shadow);}
function wire(shadow:ShadowGenerator|null|undefined,materials:readonly ShaderMaterial[]):void{
    if(!shadow||materials.length===0)return;
    const texture=receiverTexture(shadow);
    for(const material of materials)setShaderTexture(material,"csmShadow",texture);
}
function createDecor(options:DecorOptions,materials:readonly ShaderMaterial[]):void{wire(options.shadow,materials);}
function createHost(options:HostOptions,materials:readonly ShaderMaterial[]):void{
    const decor=options.decor??{enabled:false};
    createDecor({...(decor.enabled!==false?{capacity:16}:{}),...decor,shadow:options.shadow},materials);
}
const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene=createSceneContext(engine);
scene.camera=createFreeCamera([0,10,-20],[0,0,0]);
const light=createDirectionalLight([0,-1,-1],1);
addToScene(scene,light);
const sg=createCsmDirectionalShadowGenerator(engine,light,{numCascades:2});
light.shadowGenerator=sg;
const receiver=createShaderMaterial({name:"receiver",
    vertexSource:"@vertex fn main(@location(0) position:vec3<f32>)->@builtin(position) vec4<f32>{return sceneUniforms.viewProjection*vec4<f32>(position,1.0);}",
    fragmentSource:"@fragment fn main(@builtin(position) at:vec4<f32>)->@location(0) vec4<f32>{return vec4<f32>(vec3<f32>(textureSampleCompareLevel(csmShadow,csmShadowSampler,at.xy*0.001,0,0.5)),1.0);}",
    attributes:["position"],uniforms:["viewProjection"],
    samplers:[{name:"csmShadow",sampleType:"depth",viewDimension:"2d-array",comparison:true}]});
const ground=createGround(engine,{width:10,height:10});
ground.material=receiver;
addToScene(scene,ground);
const materials:ShaderMaterial[]=[receiver];
createHost({shadow:sg,decor:{enabled:false}},materials);
await registerSceneWithShadowSupport(scene);
`);
    const texture =
        /auto (\w+) = bbl::get_csm_receiver_texture\(v_engine, (\w+)\);/.exec(
            cpp,
        );
    assert.ok(texture);
    assert.notEqual(texture[2], "v_sg");
    assert.match(
        cpp,
        new RegExp(
            `bbl::set_shader_csm_texture\\(v_engine, \\w+, 0u, ${texture[1]}\\);`,
        ),
    );
});

test("a stored generator's receiver texture binds through the native texture setters", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    // The generator crosses a spread-built record, so the read and the bind
    // take the handle the record stored.
    const { compiled, cpp } = compileShaderMaterialFixture(`
import {addToScene,createSceneContext,createEngine,createDirectionalLight,createCsmDirectionalShadowGenerator,
createShaderMaterial,getCsmReceiverTexture,setShaderTexture,
type ShaderMaterial,type ShadowGenerator,type Texture2D} from "@babylonjs/lite";
interface DecorOptions{enabled?:boolean;capacity?:number;shadow?:ShadowGenerator}
interface HostOptions{decor?:{enabled?:boolean};shadow?:ShadowGenerator}
function receiverTexture(shadow:ShadowGenerator):Texture2D{return getCsmReceiverTexture(shadow);}
function wire(shadow:ShadowGenerator|null|undefined,materials:readonly ShaderMaterial[]):void{
    if(!shadow||materials.length===0)return;
    const texture=receiverTexture(shadow);
    for(const material of materials)setShaderTexture(material,"csmShadow",texture);
}
function createDecor(options:DecorOptions,materials:readonly ShaderMaterial[]):void{wire(options.shadow,materials);}
function createHost(options:HostOptions,materials:readonly ShaderMaterial[]):void{
    const decor=options.decor??{enabled:false};
    createDecor({...(decor.enabled!==false?{capacity:16}:{}),...decor,shadow:options.shadow},materials);
}
async function main(){
    const engine=await createEngine({});
    const scene=createSceneContext(engine);
    const light=createDirectionalLight([0,-1,-1],1);
    addToScene(scene,light);
    const sg=createCsmDirectionalShadowGenerator(engine,light,{mapSize:256,numCascades:2,lambda:0.5,
        cascadeBlendPercentage:0.1,bias:0.001,darkness:0.1,frustumEdgeFalloff:0.2});
    const receiver=createShaderMaterial({name:"receiver",
        vertexSource:"@vertex fn main(@location(0) position:vec3<f32>)->@builtin(position) vec4<f32>{return sceneUniforms.viewProjection*vec4<f32>(position,1.0);}",
        fragmentSource:"@fragment fn main(@builtin(position) at:vec4<f32>)->@location(0) vec4<f32>{return vec4<f32>(vec3<f32>(textureSampleCompareLevel(csmShadow,csmShadowSampler,at.xy*0.001,0,0.5)),1.0);}",
        attributes:["position"],uniforms:["viewProjection"],
        samplers:[{name:"csmShadow",sampleType:"depth",viewDimension:"2d-array",comparison:true}]});
    const materials:ShaderMaterial[]=[receiver];
    createHost({shadow:sg,decor:{enabled:false}},materials);
}
main();
`);
    // The fixture names every option, so the pinned defaults are unread.
    const checked = compiled.cpp
        .replace("#include <bblite/upstream/pinned_shadow.hpp>", "")
        .replace(
            "        return 0;",
            `        assert(bbl::handle_at(v_engine.shadow_generators, v_sg).csm_receiver_texture_read);
        const auto& bound = bbl::handle_at(v_engine.materials, v_receiver).shader_csm_textures;
        assert(bound.size() == 1 && bound[0].value == v_sg.value);
        return 0;`,
        );
    assert.ok(checked.includes("csm_receiver_texture_read"));
    const factory = new FactoryLowerer(
        new LoweringContext(),
    ).lowerShaderMaterialFactory().source;
    runGeneratedProgram(
        native,
        "csm-receiver-stored-generator",
        `${cpp}
namespace bbl {
Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
LightHandle create_directional_light(Engine& engine, Vec3, double) {
    engine.lights.emplace_back();
    return LightHandle{static_cast<std::uint32_t>(engine.lights.size() - 1)};
}
void add_to_scene(Scene& scene, LightHandle light) { scene.lights.push_back(light); }
ShadowGeneratorHandle create_csm_directional_shadow_generator(Engine& engine, LightHandle, CsmDirectionalShadowOptions) {
    engine.shadow_generators.emplace_back();
    engine.shadow_generators.back().filter = ShadowFilter::csm_directional;
    return ShadowGeneratorHandle{static_cast<std::uint32_t>(engine.shadow_generators.size() - 1)};
}
${cppFunction(factory, "void set_shader_csm_texture(")}
}
${checked}`,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});
