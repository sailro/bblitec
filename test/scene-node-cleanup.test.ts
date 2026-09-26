import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { lowerSceneNodeRemoval } from "../src/lowering/scene-node-removal.js";
import { sceneNodeTraversalSource } from "../src/lowering/scene-node-transforms.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("SceneNode removal dispatches retained nodes and snapshots children before recursive removal", (t) => {
    const compiled = compileSource(`
        import {createEngine,createSceneContext,createTransformNode,removeFromScene,type SceneNode} from "@babylonjs/lite";
        const engine=await createEngine({});
        const scene=createSceneContext(engine);
        const nodes:SceneNode[]=[createTransformNode("root")];
        for(const node of nodes) {
            node.visible=false;
            if(node.visible!==false)throw new Error("visible");
            node.visible=undefined;
            removeFromScene(scene,node);
        }
    `);
    assert.match(compiled.cpp, /bbl::remove_from_scene\(/);
    assert.ok(compiled.manifest.features.includes("scene:node-transforms"));
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const output = resolve("artifacts/scene-node-cleanup");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, compiled.manifest.features);
    const application = join(output, "application.cpp");
    writeFileSync(application, compiled.cpp);
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
        application,
    ]);
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    const sceneCore = new SceneLowerer(new LoweringContext()).lowerCore({transformNodes: true}).source;
    writeFileSync(
        file,
        `#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl {
std::vector<std::uint32_t> removed;
void require_scene_engine(Scene& scene){assert(scene.engine);}
void mark_transform_node_dirty(Engine&,TransformNodeHandle) {}
${cppFunction(sceneCore, "void require_acyclic_transform_node_parent(")}
${cppFunction(sceneCore, "void set_transform_node_parent(")}
void remove_from_scene(Scene& scene,MeshHandle mesh){
    assert(scene.engine->transform_nodes[0].parent.value==std::numeric_limits<std::uint32_t>::max());
    removed.push_back(mesh.value);
    // A removal callback can mutate the public traversal list. The source
    // already captured [...kids], so the second entry must still be visited.
    scene.engine->transform_nodes[0].children.clear();
}
MeshHandle clone_mesh_node(Engine&,MeshHandle mesh){return mesh;}
AssetHandle clone_asset_root(Engine&,AssetHandle asset){return asset;}
${sceneNodeTraversalSource()}
${lowerSceneNodeRemoval(new LoweringContext())}
}
int main(){
    using namespace bbl;
    Engine engine;
    engine.transform_nodes.resize(2);
    engine.meshes.resize(2);
    engine.assets.emplace_back();
    engine.assets[0].root_node=TransformNodeHandle{0};
    engine.transform_nodes[0].parent=TransformNodeHandle{1};
    engine.transform_nodes[1].parented_nodes={TransformNodeHandle{0}};
    engine.transform_nodes[0].children={MeshHandle{0},MeshHandle{1}};
    assert(!scene_node_visibility(engine,AssetHandle{0}).source_value().has_value());
    scene_node_visibility(engine,AssetHandle{0})=false;
    assert(engine.transform_nodes[0].visible==false);
    scene_node_visibility(engine,TransformNodeHandle{0})=js::Nullable<bool>{};
    assert(!scene_node_visibility(engine,AssetHandle{0}).source_value().has_value());
    scene_node_visibility(engine,MeshHandle{0})=true;
    assert(engine.meshes[0].visible==true);
    assert(!scene_node_has_thin_instance_property(engine,MeshHandle{0}));
    engine.meshes[0].thin_instanced=true;
    assert(scene_node_has_thin_instance_property(engine,MeshHandle{0}));
    assert(scene_node_thin_instance_pool(engine,MeshHandle{0})->value==0);
    assert(!scene_node_has_thin_instance_property(engine,AssetHandle{0}));
    Scene scene;scene.engine=&engine;
    remove_from_scene(scene,SceneNodeHandle{AssetHandle{0}});
    assert((removed==std::vector<std::uint32_t>{0,1}));
    assert(engine.transform_nodes[1].parented_nodes.empty());
    remove_from_scene(scene,SceneNodeHandle{TransformNodeHandle{0}});
    assert(removed.size()==2);
    remove_from_scene(scene,SceneNodeHandle{MeshHandle{1}});
    assert(removed.size()==3&&removed.back()==1);
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

test("SceneNode thin-instance queries preserve optional matrices and material discrimination", (t) => {
    const compiled = compileSource(`
        import {createEngine,createBox,createTransformNode,setThinInstances,setThinInstanceCount,type SceneNode} from "@babylonjs/lite";
        const engine=await createEngine({});
        const mesh=createBox(engine,1);
        setThinInstances(mesh,new Float32Array(16),1);
        const nodes:SceneNode[]=[mesh,createTransformNode("root")];
        let reads=0;
        function current():SceneNode {reads++;return nodes[0]!;}
        const direct=(current() as {thinInstances?:{matrices:Float32Array}}).thinInstances?.matrices;
        if(reads!==1||!direct||direct.length!==16)throw new Error("computed owner");
        direct[12]=17;
        function inspect(node:SceneNode):number {
            const view=node as {thinInstances?:{matrices:Float32Array}};
            const matrices=view.thinInstances?.matrices;
            if("thinInstances" in node&&node.thinInstances)setThinInstanceCount(node,0);
            if("material" in node)return matrices?matrices[12]!:0;
            return -1;
        }
        if(inspect(nodes[0]!)!==17||inspect(nodes[1]!)!==-1)throw new Error("optional matrices or mesh identity");
    `);
    assert.match(compiled.cpp, /scene_node_thin_instance_pool/);
    assert.match(compiled.cpp, /Nullable<bbl::js::F32Array>/);
    assert.match(compiled.cpp, /holds_alternative<bbl::MeshHandle>/);
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const output = resolve("artifacts/scene-node-thin-properties");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, compiled.manifest.features);
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    const factories = new FactoryLowerer(
        new LoweringContext(),
    ).lowerMeshFactories(["mesh:thin-instances"]).source;
    writeFileSync(
        file,
        compiled.cpp +
            `
namespace bbl {
Engine create_engine(EngineOptions){return {};}
MeshHandle create_box(Engine& engine,BoxOptions){engine.meshes.emplace_back();return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size()-1)};}
TransformNodeHandle create_transform_node(Engine& engine,std::string,Vec3d,Vec4,Vec3){engine.transform_nodes.emplace_back();return TransformNodeHandle{static_cast<std::uint32_t>(engine.transform_nodes.size()-1)};}
void set_thin_instances(Engine& engine,MeshHandle mesh,js::F32Array& matrices,double count){
    auto& record=engine.meshes.at(mesh.value);record.thin_instanced=true;
    record.owned_instance_source=matrices.storage();record.instance_count=static_cast<std::uint32_t>(count);
}
void set_thin_instance_count(Engine& engine,MeshHandle mesh,double count){engine.meshes.at(mesh.value).instance_count=static_cast<std::uint32_t>(count);}
MeshHandle clone_mesh_node(Engine&,MeshHandle mesh){return mesh;}
AssetHandle clone_asset_root(Engine&,AssetHandle asset){return asset;}
${cppFunction(factories, "js::F32Array thin_instance_matrices(")}
${sceneNodeTraversalSource()}
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
        "/I",
        join(output, "upstream/include"),
        file,
    ]);
    execFileSync(executable, [], { stdio: "pipe" });
});

test("splice spread retains receiver identity, argument order and filtered record references", (t) => {
    const compiled = compileSource(`
        let values=[1,2,3];
        const original=values;
        let steps=0;
        function start():number {steps=steps*10+1;return 1;}
        function count():number {steps=steps*10+2;return 1;}
        function last():number {steps=steps*10+3;values=[9];original[0]=8;return 7;}
        const removed=values.splice(start(),count(),...values,last());
        if(steps!==123||removed.length!==1||removed[0]!==2)throw new Error("argument order");
        if(values.length!==1||values[0]!==9||original.length!==6||original[0]!==8||original[1]!==1||original[4]!==7||original[5]!==3)throw new Error("receiver or spread snapshot");
        interface Entry {id:number;}
        const entries:Entry[]=[{id:1},{id:2},{id:3}];
        const retained=entries[2]!;
        const alias=entries;
        entries.splice(0,entries.length,...entries.filter(entry=>entry.id!==2));
        if(alias!==entries||entries.length!==2||entries[1]!==retained)throw new Error("retained filter identity");
        const empty:number[]=[];
        const self=[4,5];
        self.splice(0,1,...self,...empty);
        if(self.length!==3||self[0]!==4||self[1]!==5||self[2]!==5)throw new Error("self spread");
    `);
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const output = resolve("artifacts/array-splice-spread");
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
