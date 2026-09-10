import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfSkeletonPose} from "../src/lowering/gltf/skeleton-pose.js";
import {lowerMatrixComposeCpp} from "../src/lowering/gltf/matrix-leaves.js";
import {pinnedMatrixHeader} from "../src/lowering/pinned-matrix.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/skeleton/skeleton-pose.ts";
const matrix = (x = 0) => new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1]);
const contexts = () => [new LoweringContext(),
    doctoredContext(module, "currentTRS[off + T_OFF] = n.tx;", "currentTRS[off + T_OFF] = n.tx + 0.75;"),
    doctoredContext(module, "if (skel.runtimeSkeleton?._disposed)", "if (!skel.runtimeSkeleton?._disposed)"),
    doctoredContext("src/skeleton/bone-control.ts", "applyOverridesToTRS(overrides, currentTRS, numNodes);", "applyOverridesToTRS(overrides, currentTRS, numNodes, true);"),
];

function sourceCase(context: LoweringContext, disposed: boolean, override: boolean, worldOverride: boolean) {
    const text = context.sourceFile(module).statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText().replace(/^export /, "")).join("\n");
    const math = (name: string, path: string) => context.functionDeclaration(path, name).declaration.getText().replace(/^export /, "");
    const build = context.functionDeclaration("src/skeleton/bone-control.ts", "buildSkeletons");
    const bake = context.variableInitializer(build.declaration, "bake").getText();
    const run = new Function("F32", "I32", "U8", transpileCommonJs(`
        ${math("mat4ComposeInto", "src/math/mat4-compose-into.ts")}
        ${math("mat4MultiplyInto", "src/math/mat4-multiply-into.ts")}
        ${text}
        return (nodes, skeletons, overrides, worldOverrides) => {
            const events = [], numNodes = nodes.length, topoOrder = computeTopoOrder(nodes);
            const currentTRS = new F32(numNodes * TRS_STRIDE), localMat = new F32(numNodes * 16), worldMat = new F32(numNodes * 16);
            const allBindings = skeletons;
            const device = {queue: {writeTexture(destination, buffer, layout, size) {
                events.push(['upload', destination.texture, layout.bytesPerRow, size.width, ...new Uint32Array(buffer)]);
            }}};
            const applyOverridesToTRS = (_overrides, trs, count, hidden = false) => {
                events.push(['override', count, hidden]); trs[hidden ? 7 : 0] = hidden ? 0 : 6.75;
            };
            const bake = ${bake}; bake();
            return {events, topo: [...topoOrder], trs: [...new Uint32Array(currentTRS.buffer)], local: [...new Uint32Array(localMat.buffer)],
                world: [...new Uint32Array(worldMat.buffer)], bones: skeletons.map(s => [...new Uint32Array(s.boneMatrices.buffer)])};
        };
    `, module))(Float32Array, Int32Array, Uint8Array) as (...args: unknown[]) => unknown;
    const nodes = [2, -1, 1].map((parentIdx, index) => ({parentIdx, tx: index + .123456789, ty: index / 3, tz: -(index + .25),
        rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1, ...(index === 2 ? {_matrix: matrix(3.5)} : {})}));
    const skeletons = [false, true].map((runtime, index) => ({jointNodes: [0, 2], boneCount: 2, invMeshWorld: matrix(-2.25),
        inverseBindMatrices: new Float32Array([...matrix(.125), ...matrix(-.75)]), boneMatrices: new Float32Array(32).fill(9), boneTexture: index,
        ...(runtime ? {runtimeSkeleton: {_disposed: disposed, boneTexture: index + 10}} : {})}));
    const initial = {nodes: nodes.map(n => ({...n, _matrix: n._matrix ? [...n._matrix] : null})), disposed, override, worldOverride,
        skeletons: skeletons.map(s => ({...s, invMeshWorld: [...s.invMeshWorld], inverseBindMatrices: [...s.inverseBindMatrices], boneMatrices: [...s.boneMatrices]}))};
    const expected = run(nodes, skeletons, new Map(override ? [[0, {}]] : []), new Map(worldOverride ? [[2, matrix(8.25)]] : []));
    return {initial, expected};
}

test("eager skeleton baking follows source scratch, override order, matrix products and disposed skips", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const variants = contexts();
    const cases = variants.map(context => [false, true].flatMap(disposed => [false, true].flatMap(override =>
        [false, true].map(worldOverride => sourceCase(context, disposed, override, worldOverride)))));
    const directory = resolve("artifacts/test-gltf-skeleton-pose"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    writeFileSync(resolve(directory, "pinned_matrix.hpp"), pinnedMatrixHeader(variants[0]!));
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <bit>
#include <fstream>
#include "pinned_matrix.hpp"
using Json=nlohmann::json;using Floats=std::vector<float>;using Matrix=std::array<float,16>;using bbl::Vec3;using bbl::Vec4;
Matrix identity_matrix(){return {1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};}
${lowerMatrixComposeCpp(variants[0]!.sourceFile("src/math/mat4-compose-into.ts"))}
Json bits(const Floats& values){Json result=Json::array();for(float v:values)result.push_back(std::bit_cast<std::uint32_t>(v));return result;}
struct Node{double parentIdx,tx,ty,tz,rx,ry,rz,rw,sx,sy,sz;std::optional<Floats> matrix;};
struct Skeleton{double boneCount;std::vector<double> jointNodes;Floats invMeshWorld,inverseBindMatrices;std::shared_ptr<Floats> boneMatrices;bool disposed;int texture;};
struct State{std::vector<Node> nodes;std::vector<Skeleton> skeletons;std::vector<double> topo_order;Floats currentTRS,localMat,worldMat,RH_TO_LH,_boneTmp=Floats(16);};
${variants.map((context,index)=>`namespace variant_${index} {${lowerGltfSkeletonPose(context)}}`).join("\n")}
template<class Initialize,class Bake>void check(const Json& row,Initialize initialize,Bake bake){
    const auto& input=row.at("initial");State state;
    for(const auto& n:input.at("nodes")){Node v{n.at("parentIdx"),n.at("tx"),n.at("ty"),n.at("tz"),n.at("rx"),n.at("ry"),n.at("rz"),n.at("rw"),n.at("sx"),n.at("sy"),n.at("sz"),{}};if(!n.at("_matrix").is_null())v.matrix=n.at("_matrix").get<Floats>();state.nodes.push_back(v);}
    for(const auto& s:input.at("skeletons")){const bool runtime=s.contains("runtimeSkeleton");state.skeletons.push_back({s.at("boneCount"),s.at("jointNodes").get<std::vector<double>>(),s.at("invMeshWorld").get<Floats>(),s.at("inverseBindMatrices").get<Floats>(),std::make_shared<Floats>(s.at("boneMatrices").get<Floats>()),runtime&&input.at("disposed").get<bool>(),runtime?s.at("runtimeSkeleton").at("boneTexture").get<int>():s.at("boneTexture").get<int>()});}
    initialize(state);Json events=Json::array();
    const Floats override_world={1,0,0,0,0,1,0,0,0,0,1,0,8.25f,0,0,1};
    auto world=[&](double node)->const Floats*{return input.at("worldOverride").get<bool>()&&node==2?&override_world:nullptr;};
    auto overrides=[&](Floats& trs,double count,bool hidden){events.push_back({"override",count,hidden});trs[hidden?7:0]=hidden?0:6.75f;};
    auto compose=[](Floats& out,double offset,double tx,double ty,double tz,double rx,double ry,double rz,double rw,double sx,double sy,double sz){const auto m=trs_matrix({float(tx),float(ty),float(tz)},{float(rx),float(ry),float(rz),float(rw)},{float(sx),float(sy),float(sz)});std::copy(m.begin(),m.end(),out.begin()+static_cast<std::size_t>(offset));};
    auto multiply=[](Floats& out,double offset,const Floats& left,double lo,const Floats& right,double ro){Matrix m{};bbl::upstream::mat4_multiply_into(m,0,left,static_cast<std::int64_t>(lo),right,static_cast<std::int64_t>(ro));std::copy(m.begin(),m.end(),out.begin()+static_cast<std::size_t>(offset));};
    auto upload=[&](Skeleton& s,const Floats& values,double width){Json event={"upload",s.texture,width*16,width};for(float value:values)event.push_back(std::bit_cast<std::uint32_t>(value));events.push_back(event);};
    bake(state,input.at("override").get<bool>()?1:0,world,overrides,compose,multiply,upload);
    Json bones=Json::array();for(const auto& s:state.skeletons)bones.push_back(bits(*s.boneMatrices));
    const Json actual={{"events",events},{"topo",state.topo_order},{"trs",bits(state.currentTRS)},{"local",bits(state.localMat)},{"world",bits(state.worldMat)},{"bones",bones}};
    if(actual!=row.at("expected")){std::ofstream("actual.json")<<actual.dump(2);std::ofstream("expected.json")<<row.at("expected").dump(2);throw std::runtime_error("Eager source/native mismatch");}
}
int main(){Json cases;std::ifstream("cases.json")>>cases;
${variants.map((_context,index)=>`for(const auto& row:cases.at(${index}))check(row,[](auto& state){variant_${index}::gltf_initialize_skeleton_pose(state);},[](auto&&... args){variant_${index}::gltf_bake_skeleton_pose(args...);});`).join("\n")}
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", "/I", resolve(nativeFixtureVcpkgRoot, "include"), file]);
    assert.equal(execFileSync(executable, {cwd: directory, encoding: "utf8"}), "");
});
