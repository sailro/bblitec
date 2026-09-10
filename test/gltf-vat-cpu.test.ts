import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {VatLowerer} from "../src/lowering/vat-lowerer.js";
import {lowerGltfAnimationPlayback} from "../src/lowering/gltf/animation-playback.js";
import {lowerGltfVatPlayback} from "../src/lowering/gltf/vat-playback.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const vatModule = "src/vat/vat-baker.ts", controllerModule = "src/skeleton/skeleton-updater.ts";
const groupModule = "src/animation/animation-group.ts";
interface Group {
    currentTime: number; isPlaying: boolean; _stopped: boolean; speedRatio: number; loopAnimation: boolean;
    frameRate: number; name: string; duration: number; _gltfMixer: unknown[];
    _ctrl: {time: number; playing: boolean; speedRatio: number; loop: boolean; tick(delta: number): void; _setMask(mask: unknown): void};
}
const scenarios = [
    {name: "same", target: 0, owners: [0], drives: [0]},
    {name: "clone", target: 0, owners: [0], drives: [0], clone: true},
    {name: "texture_alias", target: 0, owners: [0], drives: [0], alias: true},
    {name: "other_skin_same_asset", target: 1, owners: [0, 0], drives: [0, 1]},
    {name: "foreign_asset", target: 0, owners: [1], drives: [2]},
    {name: "later_foreign_asset", target: 0, owners: [0, 1], drives: [0, 2]},
    {name: "no_skeleton", target: 0, owners: [0], drives: [0], absent: true},
    {name: "attached_vat", target: 0, owners: [0], drives: [0], attached: true},
    {name: "inconsistent", target: 0, owners: [0], drives: [0], mismatched: true},
];
function variants(): LoweringContext[] {
    return [new LoweringContext(),
        doctoredContext(vatModule, "ctrl.speedRatio = group.speedRatio", "ctrl.speedRatio = -group.speedRatio"),
        doctoredContext(vatModule, 'has no skeleton binding for clip', 'lacks a skeleton binding for clip')];
}
function sourceResult(context: LoweringContext): unknown[] {
    const printer = ts.createPrinter();
    const source = (module: string) => {
        const file = context.sourceFile(module);
        return file.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement =>
            printer.printNode(ts.EmitHint.Unspecified, statement, file).replace(/^export /gm, "")).join("\n");
    };
    const paths = ["PATH_TRANSLATION", "PATH_ROTATION", "PATH_SCALE", "PATH_WEIGHTS", "PATH_POINTER"];
    const types = context.sourceFile("src/animation/types.ts");
    const constants = paths.map(name => context.numericValue(context.moduleScopeConstant(types, name)!, types));
    let pose: () => void = () => {};
    const api = new Function("F32", "I32", "U8", ...paths, "mat4ComposeInto", "mat4MultiplyInto", "evaluateSampler", "_boneApplier", "_setTickAnimationImpl", "GLTF_CLIP",
        transpileCommonJs(source(controllerModule) + "\n" + source(groupModule), groupModule) +
        "\nreturn {createAnimationGroups,stopAnimation};")(
        Float32Array, Int32Array, Uint8Array, ...constants, () => pose(), () => {}, () => {}, undefined, () => {}, 0) as {
            createAnimationGroups(data: object): Group[]; stopAnimation(group: Group): void;
        };
    const functions = ["bindingOf", "clipFrameCount", "goToFrameCpu", "prepareVatMany"].map(name =>
        context.functionDeclaration(vatModule, name).declaration.getText().replace(/^export /, "")).join("\n");
    const prepare = new Function("stopAnimation", transpileCommonJs("const DEFAULT_FRAME_RATE = 60;\n" + functions, vatModule) +
        "\nreturn prepareVatMany;")(api.stopAnimation) as (targets: object[], groups: Group[]) => Array<{data: Float32Array; frameCount: number; boneCount: number; clips: object}>;
    return scenarios.map(scenario => {
        const palettes = [0, 1, 2].map(resource => Float32Array.from({length: 16}, (_, index) => resource * 20 + index));
        const skeletons = palettes.map(() => ({boneTexture: {}, boneCount: 1}));
        const bindings = palettes.map((boneMatrices, index) => ({runtimeSkeleton: skeletons[index], boneTexture: skeletons[index]!.boneTexture,
            boneCount: scenario.mismatched ? 2 : 1, boneMatrices}));
        let current = 0;
        const events: unknown[] = [];
        const node = {parentIdx: -1,tx: 0,ty: 0,tz: 0,rx: 0,ry: 0,rz: 0,rw: 1,sx: 1,sy: 1,sz: 1};
        const groups = scenario.owners.map((owner,index) => {
            const group = api.createAnimationGroups({clips: [{name: `clip${index}`,duration: 0.0625,channels: [],samplers: []}],
                nodes: [node],skeletons: [],morphBindings: [{nodeIdx: 0}],nodeTargets: [],nodeNames: []})[0]!;
            group._gltfMixer[2] = owner === 0 ? bindings.slice(0,2) : bindings.slice(2);
            group._stopped = true; group.speedRatio = 2;
            const mask = group._ctrl._setMask;
            group._ctrl._setMask = value => {current = index; events.push(["mask",index]); mask(value);};
            return group;
        });
        pose = () => {
            const group = groups[current]!, drive = scenario.drives[current]!;
            events.push(["pose",current,group._ctrl.time]);
            palettes[drive]!.set(Float32Array.from({length: 16}, (_, lane) => drive * 20 + lane + group._ctrl.time * 100));
        };
        const live = Array.from(palettes[scenario.target]!);
        const targetSkeleton = scenario.absent || scenario.attached ? null : scenario.alias
            ? {...skeletons[scenario.target]!} : skeletons[scenario.target];
        let error: string | null = null, baked: object | null = null;
        try {
            const result = prepare([{mesh: {name: "target",skeleton: targetSkeleton}}],groups)[0]!;
            baked = {data: Array.from(result.data),frame_count: result.frameCount,bone_count: result.boneCount,clips: result.clips};
        } catch (caught) { error = (caught as Error).message; }
        let restored = false;
        try { groups[0]!._ctrl.tick(0); } catch { restored = true; }
        return {error,baked,live,events,restored,groups: groups.map(group => ({time: group.currentTime,playing: group.isPlaying,
            stopped: group._stopped,controller: [group._ctrl.time,group._ctrl.playing,group._ctrl.speedRatio,group._ctrl.loop]}))};
    });
}

test("VAT source CPU seeking preserves binding validation order and uploaded palette isolation", t => {
    const native = optionalNativeFixtureTools();
    if (!native) {t.skip("Native fixture compiler unavailable."); return;}
    const contexts = variants(), expected = contexts.map(sourceResult);
    assert.notDeepEqual(expected[0],expected[1]); assert.notDeepEqual(expected[0],expected[2]);
    const directory = resolve("artifacts/test-gltf-vat-cpu"); mkdirSync(directory,{recursive:true});
    const file = resolve(directory,"check.cpp"), executable = resolve(directory,"check.exe");
    writeFileSync(resolve(directory,"cases.json"),JSON.stringify({scenarios,expected}));
    // Emit the complete VAT unit once per source variant. ABI names stay within each fixture namespace.
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>
using Json = nlohmann::json;
${contexts.map((context,index) => `namespace variant_${index} {
using namespace bbl;
${lowerGltfAnimationPlayback(context)}
${lowerGltfVatPlayback(context)}
struct Group {double time=0,duration=0.0625,frame_rate=60,speed_ratio=2;bool playing=true,stopped=true,loop=true;GltfAnimationControllerPlayback controller;};
std::vector<Group>* active_groups=nullptr;
void fixture_stop_animation(Engine&,AnimationGroupHandle handle) {
    auto& group=active_groups->at(handle.value);group.playing=false;group.time=0;group.stopped=true;
}
void fixture_vat_play(Engine&,VatHandle,const std::string&,std::optional<double>,std::optional<double>);
${new VatLowerer(context).lower({instances:false}).source.replace(/^#include .*$/gm,"").replace("namespace bbl {","") .replace(/} \/\/ namespace bbl\s*$/,"").replace(/\b(stop_animation|vat_play|bake_vat)\b/g,"fixture_$1")}
Json run(const Json& scenarios) {
    Json observations=Json::array();
    for(const auto& scenario:scenarios) {
        Engine engine; engine.meshes.resize(2);engine.assets.resize(2);
        const auto target=scenario.at("target").get<std::size_t>();
        const auto mesh_index=scenario.value("clone",false)?1u:0u;
        auto& mesh=engine.meshes.at(mesh_index);mesh.name="target";
        mesh.skinned=!scenario.value("absent",false)&&!scenario.value("attached",false);
        mesh.has_vat=scenario.value("attached",false);
        std::array<std::vector<std::array<float,16>>,3> palettes;
        for(std::size_t resource=0;resource<palettes.size();++resource) {
            palettes[resource].resize(scenario.value("mismatched",false)?2u:1u);
            for(std::size_t lane=0;lane<16;++lane)palettes[resource][0][lane]=static_cast<float>(resource*20+lane);
        }
        mesh.bone_matrices={palettes[target][0]};
        std::vector<Group> groups(scenario.at("owners").size());active_groups=&groups;
        Json events=Json::array();std::vector<AnimationGroupHandle> handles;
        for(std::size_t index=0;index<groups.size();++index) {
            auto& group=engine.animation_groups.emplace_back();group.name="clip"+std::to_string(index);
            group.asset=scenario.at("owners").at(index);group.clip=index;handles.push_back(AnimationGroupHandle{static_cast<std::uint32_t>(index)});
        }
        for(std::size_t owner=0;owner<engine.assets.size();++owner) {
            auto& asset=engine.assets[owner];asset.clip_duration=[](std::size_t){return 0.0625f;};
            asset.animation_has_skeleton=[&,owner](MeshHandle handle){return handle.value==mesh_index&&owner==0;};
            asset.animation_bone_palette=[&](MeshHandle){return palettes[target];};
            asset.animation_cpu_go_to_frame=[&](std::size_t index,double frame){
                auto& group=groups[index];
                gltf_vat_go_to_frame(group,frame,[&]{events.push_back({"mask",index});},[&](double delta){
                    gltf_tick_animation_controller(group,group.controller,delta,false,true,false,[&](double time,bool){
                        events.push_back({"pose",index,time});const auto drive=scenario.at("drives").at(index).get<std::size_t>();
                        for(std::size_t lane=0;lane<16;++lane)palettes[drive][0][lane]=static_cast<float>(drive*20+lane+time*100);
                    });
                });
            };
        }
        Json error=nullptr,baked=nullptr;
        try {
            const auto handle=fixture_bake_vat(engine,MeshHandle{mesh_index},handles);const auto& result=engine.vat_bakes.at(handle.value);
            Json clips=Json::object();for(const auto& clip:result.clips)clips[clip.name]={{"fromRow",clip.from_row},{"frameCount",clip.frame_count},{"fps",clip.fps}};
            baked={{"data",result.data},{"frame_count",result.frame_count},{"bone_count",result.bone_count},{"clips",clips}};
        } catch(const std::exception& caught){error=caught.what();}
        bool restored=false;
        try {gltf_tick_animation_controller(groups[0],groups[0].controller,0,false,true,true,[](double,bool){});}catch(...){restored=true;}
        Json state=Json::array();for(const auto& group:groups)state.push_back({{"time",group.time},{"playing",group.playing},{"stopped",group.stopped},
            {"controller",{group.controller.time,group.controller.playing,group.controller.speed_ratio,group.controller.loop}}});
        observations.push_back({{"error",error},{"baked",baked},{"live",mesh.bone_matrices[0]},{"events",events},{"restored",restored},{"groups",state}});
    }
    return observations;
}
}`).join("\n")}
int main(){Json cases;std::ifstream("cases.json")>>cases;
${contexts.map((_,index)=>`const auto result_${index}=variant_${index}::run(cases.at("scenarios"));if(result_${index}!=cases.at("expected").at(${index})){std::cerr<<result_${index}.dump(2);return ${index+1};}`).join("\n")}
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",
        `/Fo:${directory}/`,`/Fe:${executable}`,"/I","native/include","/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(executable,{cwd:directory,encoding:"utf8",stdio:"pipe"}),"");
});

test("VAT controller CPU lifetime and binding identity mutations refuse unsupported changes",()=>{
    assert.throws(()=>lowerGltfVatPlayback(doctoredContext(controllerModule,"uploadGpu = previous","uploadGpu = true")),/CPU controller upload lifetime/);
    assert.throws(()=>new VatLowerer(doctoredContext(vatModule,"binding.boneTexture === skeleton.boneTexture","binding.boneCount === skeleton.boneCount")).lower({instances:false}),/identity lookup/);
});
