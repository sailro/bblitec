import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("resize frontend admits individual meshes and typed shared families", () => {
    const result =
        compileSource(`import {createEngine,createMeshFromData,resizeMeshGeometry,resizeSharedMeshGeometry,type EngineContext,type Mesh} from 'babylon-lite';
    const engine=await createEngine({});
    const p=new Float32Array([0,0,0,1,0,0,0,1,0]);const n=new Float32Array(9);const i=new Uint32Array([0,1,2]);
    const mesh=createMeshFromData(engine,'a',p,n,i);
    resizeMeshGeometry(engine,mesh,p,n,i);
    function family(engine:EngineContext,meshes:readonly Mesh[]) {resizeSharedMeshGeometry(engine,meshes,p,n,i);}
    family(engine,[mesh]);`);
    assert.match(result.cpp, /bbl::resize_mesh_geometry\(/);
    assert.match(result.cpp, /bbl::resize_shared_mesh_geometry\(/);
    assert.ok(result.manifest.features.includes("mesh:resize-geometry"));
});

test("source geometry resize preserves omitted owners, validates families and invalidates scenes", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const directory = resolve("artifacts/mesh-resize-check");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    const factories = new FactoryLowerer(
        new LoweringContext(),
    ).lowerMeshFactories(["mesh:resize-geometry"]).source;
    const clone = cppFunction(
        new SceneLowerer(new LoweringContext()).lowerCore().source,
        "MeshHandle clone_mesh_node(",
    );
    writeFileSync(
        source,
        factories +
            `
#include <cassert>
#include <bblite/js_data.hpp>
namespace bbl {
${clone}
void mark_mesh_dirty(Engine& engine,MeshHandle mesh){++engine.meshes.at(mesh.value).transform_version;}
}
template<class F>void rejects(F fn,const char* code){try{fn();assert(false);}catch(const std::runtime_error& error){assert(std::string(error.what()).find(code)!=std::string::npos);}}
int main(){using namespace bbl;Engine engine;
 const std::vector<float> p{0,0,0,1,0,0,0,1,0},n(9),uv{0,0,1,0,0,1};const std::vector<std::uint32_t> i{0,1,2};
 const auto a=create_mesh_from_data(engine,"a",p,n,i,uv,{},{},{});
 const auto b=clone_mesh_node(engine,a),omitted=clone_mesh_node(engine,b);
 assert(!engine.meshes[b.value].detached_imported_mesh && engine.geometries[0].owners==3);
 auto scene=std::make_shared<Scene>();scene->engine=&engine;engine.registered_scenes.push_back(scene);
 const auto topology=scene->render_topology_version,epoch=engine.draw_list_epoch;
 const std::vector<float> bigger{0,0,0,2,0,0,0,2,0,2,2,0},bn(12);const std::vector<std::uint32_t> bi{0,1,2,1,3,2};
 const js::Array<MeshHandle> family{a,b};
 resize_shared_mesh_geometry(engine,family,bigger,bn,bi);
 assert(engine.meshes.size()==3 && engine.geometries.size()==2);
 assert(engine.meshes[0].geometry==engine.meshes[1].geometry && engine.meshes[2].geometry==0);
 assert(engine.geometries[0].owners==1 && engine.geometries[0].vertices.size()==3);
 assert(engine.geometries[1].owners==2 && engine.geometries[1].vertices.size()==4 && engine.geometries[1].indices.size()==6);
 assert(engine.geometries[1].bounds_max.x==2 && engine.geometries[1].bounds_max.y==2);
 assert(scene->render_topology_version==topology+1 && engine.draw_list_epoch==epoch+1);
 assert(engine.meshes[0].transform_version==1 && engine.meshes[1].transform_version==1);
 rejects([&]{resize_shared_mesh_geometry(engine,{},p,n,i);},"#415");
 const std::array<MeshHandle,2> duplicate{a,a},mixed{a,omitted};
 rejects([&]{resize_shared_mesh_geometry(engine,duplicate,p,n,i);},"#417");
 rejects([&]{resize_shared_mesh_geometry(engine,mixed,p,n,i);},"#417");
 assert(engine.geometries.size()==2);
 resize_mesh_geometry(engine,omitted,p,n,i);assert(engine.geometries[0].vertices.empty());
 resize_mesh_geometry(engine,a,p,n,i);assert(engine.geometries[1].vertices.size()==4 && engine.geometries[1].owners==1);
 resize_mesh_geometry(engine,b,p,n,i);assert(engine.geometries[1].vertices.empty());
 engine.geometries[engine.meshes[a.value].geometry].owned_packed_geometry=false;
 rejects([&]{resize_mesh_geometry(engine,a,p,n,i);},"#414");
 engine.meshes[b.value].retired=true;const std::array<MeshHandle,1> disposed{b};
 rejects([&]{resize_shared_mesh_geometry(engine,disposed,p,n,i);},"#417");
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/Gy",
        `/I${resolve("native/include")}`,
        source,
        `/Fo${directory}/`,
        `/Fe${exe}`,
        "/link",
        "/OPT:REF",
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
