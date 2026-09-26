import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { sceneNodeTraversalSource } from "../src/lowering/scene-node-transforms.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("stored imported roots retain clone dispatch and recursive SceneNode traversal", () => {
    const compiled = compileSource(`
        import {createEngine,loadGltf,cloneTransformNode,type SceneNode} from "@babylonjs/lite";
        const engine=await createEngine({});
        const asset=await loadGltf(engine,"asset.glb");
        interface Holder {root:SceneNode}
        const roots:Holder[]=[];
        roots.push({root:asset.entities[0]! as SceneNode});
        const direct=asset.entities[0]! as SceneNode;
        for(const child of direct.children) {
            if("material" in child) child.scaling.set(1,1,1);
        }
        const visit=(node:SceneNode):void=>{
            if("material" in node) node.scaling.set(2,2,2);
            for(const child of node.children) visit(child);
        };
        for(const holder of roots) visit(cloneTransformNode(holder.root));
    `);
    assert.match(compiled.cpp, /bbl::clone_scene_node\(/);
    assert.match(compiled.cpp, /std::holds_alternative<bbl::MeshHandle>/);
    assert.match(compiled.cpp, /bbl::scene_node_children\(/);
    assert.ok(compiled.manifest.features.includes("scene:node-transforms"));
    const native = optionalNativeFixtureTools();
    if (!native) return;
    const output = resolve("artifacts/scene-node-traversal-compile");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, compiled.manifest.features);
    const file = join(output, "check.cpp");
    writeFileSync(file, compiled.cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/permissive-",
        "/c",
        `/Fo:${output}\\`,
        "/I",
        "native/include",
        "/I",
        join(output, "upstream/include"),
        file,
    ]);
});

test("node children preserve interleaved live order and concrete clone identity", (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const output = resolve("artifacts/scene-node-traversal-runtime");
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    writeFileSync(
        file,
        `#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl {
MeshHandle clone_mesh_node(Engine&,MeshHandle source) {return MeshHandle{source.value+10};}
AssetHandle clone_asset_root(Engine&,AssetHandle source) {return AssetHandle{source.value+20};}
${sceneNodeTraversalSource()}
}
int main(){
    using namespace bbl;
    Engine engine;
    engine.meshes.resize(3);
    engine.transform_nodes.resize(2);
    engine.assets.emplace_back();
    engine.assets[0].root_node=TransformNodeHandle{0};
    engine.transform_nodes[0].children={MeshHandle{0},TransformNodeHandle{1}};
    engine.transform_nodes[1].children={MeshHandle{1}};
    engine.meshes[0].children={MeshHandle{2}};
    auto root=scene_node_children(engine,AssetHandle{0});
    assert(root.size()==2 && std::get<MeshHandle>(root[0]).value==0);
    assert(std::get<TransformNodeHandle>(root[1]).value==1);
    std::size_t count=0;
    for(const auto node:root){
        if(count==0) engine.transform_nodes[0].children.push_back(MeshHandle{2});
        if(count==1) assert(std::holds_alternative<TransformNodeHandle>(node));
        ++count;
    }
    assert(count==3 && root.size()==3);
    auto mesh=scene_node_children(engine,MeshHandle{0});
    assert(mesh.size()==1 && std::get<MeshHandle>(mesh[0]).value==2);
    assert(std::get<MeshHandle>(clone_scene_node(engine,MeshHandle{1})).value==11);
    assert(std::get<AssetHandle>(clone_scene_node(engine,AssetHandle{0})).value==20);
    bool refused=false;
    try{ (void)clone_scene_node(engine,TransformNodeHandle{0}); }catch(const std::runtime_error&){refused=true;}
    assert(refused);
}
`,
    );
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/permissive-",
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        file,
    ]);
    execFileSync(executable, [], { stdio: "pipe" });
});

test("declined hierarchy traversal probes evaluate a data owner only once", (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const compiled = compileSource(`
        let hits=0;
        interface Branch { children:number[]; }
        function branch():Branch {hits++;return{children:[2,3]};}
        let sum=0;
        for(const child of branch().children) sum+=child;
        if(hits!==1||sum!==5) throw new Error("wrong iteration");
    `);
    const output = resolve("artifacts/scene-node-children-data");
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    writeFileSync(file, compiled.cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/permissive-",
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        file,
    ]);
    execFileSync(executable, [], { stdio: "pipe" });
});
