import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { lowerMeshGeometryUpdates } from "../src/lowering/mesh-geometry-updates.js";
import { lowerMeshGeometryAccess } from "../src/lowering/mesh-geometry-access.js";
import { lowerRetainedMeshRecovery } from "../src/lowering/mesh-recovery.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { pinnedError } from "./pinned-errors.js";

test("geometry update adapters retain range presence, result fields and feature isolation", (t) => {
    const compiled = compileSource(`
      import {createEngine,createMeshFromData,updateMeshGeometry,updateMeshGeometryCapacity,getMeshGeometry,type Mesh,type MeshGeometryUpdateRanges} from "babylon-lite";
      const engine=await createEngine({});
      const p=new Float32Array([99,1,2,3,4,5,6,7,8,9,99]).subarray(1,10);
      const n=new Float32Array(11).subarray(1,10);
      const i=new Uint32Array([99,0,1,2,99]).subarray(1,4);
      const uv=new Float32Array(8).subarray(1,7), t=new Float32Array(14).subarray(1,13);
      const mesh=createMeshFromData(engine,"owned",new Float32Array(9),new Float32Array(9),new Uint32Array([0,1,2]),new Float32Array(6),new Float32Array(6),new Float32Array(12),new Float32Array(12));
      updateMeshGeometry(engine,mesh,p,n,i,uv,uv,t,t);
      type CpuMesh=Mesh&{_cpuPositions?:Float32Array;_cpuNormals?:Float32Array;_cpuUvs?:Float32Array;_cpuIndices?:Uint32Array};
      const cpu=mesh as CpuMesh;
      if(cpu._cpuPositions!==p||cpu._cpuNormals!==n||cpu._cpuUvs!==uv||cpu._cpuIndices!==i)throw new Error("private CPU owners");
      const snapshot=getMeshGeometry(mesh);
      if(snapshot===null||snapshot.positions===p||snapshot.indices===i)throw new Error("public copies");
      function ranges(enabled:boolean):MeshGeometryUpdateRanges|undefined {return enabled?{vertices:[{offset:1,count:1}],indices:[{offset:0,count:1}]}:undefined;}
      const result=updateMeshGeometryCapacity(engine,mesh,p,n,i,uv,uv,t,t,undefined,ranges(true));
      if(!result.stable||result.vertexCapacity!==3||result.indexCapacity!==3)throw new Error("capacity");
      updateMeshGeometryCapacity(engine,mesh,p,n,i,uv,uv,t,t,1.5,ranges(false));
      updateMeshGeometryCapacity(engine,mesh,p,n,i,uv,uv,t,t,undefined,{vertices:[],indices:[]});
      cpu._cpuPositions![0]=77;cpu._cpuIndices![0]=2;
      const retained=getMeshGeometry(mesh);
      if(retained===null||retained.positions[0]!==77||retained.indices[0]!==2||p[0]!==77||i[0]!==2||snapshot.positions[0]!==1||snapshot.indices[0]!==0)throw new Error("retained aliases");
      const emptyUv=new Float32Array(0),barePositions=new Float32Array(9),bareNormals=new Float32Array(9),bareIndices=new Uint32Array([0,1,2]);
      const bare=createMeshFromData(engine,"empty-uv",barePositions,bareNormals,bareIndices,emptyUv) as CpuMesh;
      if(bare._cpuUvs!==emptyUv)throw new Error("factory empty UV owner");
      updateMeshGeometry(engine,bare,barePositions,bareNormals,bareIndices,emptyUv);
      if(bare._cpuUvs!==undefined)throw new Error("retained empty UV absence");
    `);
    assert(compiled.manifest.features.includes("mesh:update-geometry"));
    assert.equal(compiled.manifest.deferredCapabilities?.length ?? 0, 0);
    const isolated = new FactoryLowerer(
        new LoweringContext(),
    ).lowerMeshFactories([]).source;
    assert.doesNotMatch(isolated, /update_mesh_geometry(?:_capacity)?\(/);
    assert.doesNotMatch(isolated, /pal_mesh_geometry.hpp/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const factories = new FactoryLowerer(
        new LoweringContext(),
    ).lowerMeshFactories([
        "mesh:resize-geometry",
        "mesh:update-geometry",
    ]).source;
    runGeneratedProgram(
        tools,
        "mesh-geometry-adapters-check",
        `${factories}
    namespace bbl {${lowerMeshGeometryAccess(new LoweringContext())}
    Engine create_engine(EngineOptions options){Engine engine;engine.options=options;return engine;}
    void mark_mesh_dirty(Engine& engine, MeshHandle mesh){++handle_at(engine.meshes,mesh).transform_version;}}
    ${compiled.cpp}`,
        { flags: ["/Gy"], timeoutMs: 10000 },
    );
});

test("source geometry updates retain active CPU owners and separate GPU ranges, capacity and recovery", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const context = new LoweringContext();
    const factories = new FactoryLowerer(context).lowerMeshFactories([
        "mesh:resize-geometry",
        "mesh:update-attributes",
    ]).source;
    const updated = lowerMeshGeometryUpdates(context);
    const changed = lowerMeshGeometryUpdates(
        doctoredContext(
            "src/mesh/mesh-factories.ts",
            "reserveFactor = 1.25",
            "reserveFactor = 1.5",
        ),
    );
    runGeneratedProgram(
        tools,
        "mesh-geometry-updates-check",
        `#include <bblite/pal_mesh_geometry.hpp>\n${factories}\nnamespace bbl {\n${updated}\n${lowerRetainedMeshRecovery(context)}
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) { ++handle_at(engine.meshes,mesh).transform_version; }
namespace changed { ${changed} }
}
#include <cassert>
#include <cstdio>
#include <cstdlib>
#undef assert
#define assert(condition) do { if (!(condition)) { std::fprintf(stderr,"Assertion failed at line %d: %s\\n",__LINE__,#condition);std::exit(1); } } while(false)
template<class F> void rejects(F action,const char* expected) { bool caught=false; try { action(); } catch(const std::runtime_error& error) { caught=true; assert(error.what()==std::string(expected)); } assert(caught); }
int check() { using namespace bbl;
 Engine engine; auto scene=std::make_shared<Scene>();scene->engine=&engine;engine.rendering_contexts.push_back("scene",scene);
 js::F32Array p{1,2,3,4,5,6,7,8,9},n(9),uv{1,2,3,4,5,6},tangent(12),color(12);js::U32Array indices{0,1,2};
 auto mesh=create_retained_mesh_from_data(engine,"owned",p,n,indices,uv,uv,tangent,color);scene->meshes.push_back(mesh);
 const auto original=handle_at(engine.meshes,mesh).geometry;
 js::F32Array owner{99,99,101,102,103,104,105,106,107,108,109,99};
 js::F32Array next(owner.buffer(),8,9);js::U32Array nextIndices{2,1,0};
 update_mesh_geometry(engine,mesh,next,n,nextIndices,uv,uv,tangent,color);
 assert(handle_at(engine.meshes,mesh).geometry==original && scene->render_topology_version==0);
 assert(handle_at(engine.meshes,mesh).cpu_streams->positions->identity()==next.identity());
 assert(engine.geometries[original].bounds_min.x==101 && engine.geometries[original].bounds_max.z==109);
 assert(engine.geometries[original].vertices[0].position.x==101);
 assert(engine.geometries[original].render_vertices_override->at(0).position.x==101);
 assert(engine.geometries[original].render_indices_override->at(0)==2);
 engine.geometries[original].owners=2;rejects([&]{update_mesh_geometry(engine,mesh,{},n,nextIndices,uv,uv,tangent,color);},"${pinnedError("updateMeshGeometry requires unshared, tightly-packed mesh geometry")}");engine.geometries[original].owners=1;
 rejects([&]{update_mesh_geometry(engine,mesh,js::F32Array(6),n,nextIndices,uv,uv,tangent,color);},"${pinnedError("updateMeshGeometry requires unchanged vertex/index counts; use resizeMeshGeometry for topology changes")}");
 rejects([&]{update_mesh_geometry(engine,mesh,next,n,nextIndices,std::nullopt,uv,tangent,color);},"${pinnedError("updateMeshGeometry requires unchanged optional-attribute layout; use resizeMeshGeometry for layout changes")}");
 rejects([&]{update_mesh_geometry_capacity(engine,mesh,next,n,nextIndices,uv,uv,tangent,color,0.9,std::nullopt);},"${pinnedError("updateMeshGeometryCapacity requires reserveFactor >= 1")}");
 engine.geometries[original].owners=2;rejects([&]{update_mesh_geometry_capacity(engine,mesh,next,n,nextIndices,uv,uv,tangent,color,std::nullopt,std::nullopt);},"${pinnedError("updateMeshGeometryCapacity requires unshared, tightly-packed mesh geometry")}");engine.geometries[original].owners=1;
 rejects([&]{update_mesh_geometry_capacity(engine,mesh,next,n,js::U32Array{1},uv,uv,tangent,color,std::nullopt,std::nullopt);},"${pinnedError("updateMeshGeometryCapacity requires coherent triangle-list geometry with uint32 indices")}");
 rejects([&]{update_mesh_geometry_capacity(engine,mesh,next,n,nextIndices,std::nullopt,uv,tangent,color,std::nullopt,std::nullopt);},"${pinnedError("updateMeshGeometryCapacity requires unchanged optional-attribute layout")}");
 rejects([&]{update_mesh_geometry_capacity(engine,mesh,next,n,nextIndices,uv,uv,tangent,color,std::nullopt,MeshGeometryRanges{{{3,1}}, {}});},"${pinnedError("mesh geometry update requires valid ranges within the active geometry")}");
 js::F32Array bigP{201,202,203,204,205,206,207,208,209,210,211,212},bigN(12),bigUv(8),bigTangent(16),bigColor(16);js::U32Array bigIndices{0,1,2,1,3,2};
 const auto grown=update_mesh_geometry_capacity(engine,mesh,bigP,bigN,bigIndices,bigUv,bigUv,bigTangent,bigColor,std::nullopt,MeshGeometryRanges{{},{}});
 assert(!grown.stable && grown.vertexCapacity==5 && grown.indexCapacity==9);
 const auto geometry=handle_at(engine.meshes,mesh).geometry;
 assert(geometry!=original && engine.geometries[original].vertices.empty());
 assert(scene->render_topology_version==1 && engine.draw_list_epoch==1);
 assert(engine.geometries[geometry].vertices.size()==4 && engine.geometries[geometry].render_vertices_override->size()==5);
 assert(engine.geometries[geometry].indices.size()==6 && engine.geometries[geometry].render_indices_override->size()==9);
 assert(engine.geometries[geometry].bounds_min.x==201 && engine.geometries[geometry].bounds_max.x==210);
 assert(handle_at(engine.meshes,mesh).cpu_streams->positions->identity()==bigP.identity());
 update_mesh_positions(engine,mesh,js::F32Array{900,901,902},0,1,0);
 js::F32Array partialP{301,302,303,304,305,306,307,308,309};js::U32Array partialIndices{2,2,1};
 const auto stable=update_mesh_geometry_capacity(engine,mesh,partialP,n,partialIndices,uv,uv,tangent,color,std::nullopt,MeshGeometryRanges{{{1,1},{3,0}},{{0,1}}});
 assert(stable.stable && stable.vertexCapacity==5 && stable.indexCapacity==9);
 auto& current=engine.geometries[geometry];
 assert(current.render_vertices_override->at(0).position.x==900 && current.render_vertices_override->at(1).position.x==304 && current.render_vertices_override->at(2).position.x==207);
 assert(current.vertices[0].position.x==301 && current.vertices.size()==3);
 assert(((*current.render_indices_override)==std::vector<std::uint32_t>{2,1,2,0,0,0,0,0,0}));
 assert((current.indices==std::vector<std::uint32_t>{2,2,1}));
 assert(current.index_scratch->load(1)==2 && current.index_scratch->size()==9);
 assert(current.bounds_min.x==301 && current.bounds_max.x==307);
 const auto version=current.attribute_version;
 update_mesh_geometry_capacity(engine,mesh,partialP,n,partialIndices,uv,uv,tangent,color,std::nullopt,MeshGeometryRanges{{},{}});
 assert(current.attribute_version==version);
 assert(scene->render_topology_version==1);
 partialP.store(0,777);partialIndices.store(0,1);
 recover_retained_meshes(engine);
 const auto recovered=handle_at(engine.meshes,mesh).geometry;
 assert(!engine.geometries[recovered].vertex_capacity && !engine.geometries[recovered].index_capacity && !engine.geometries[recovered].index_scratch);
 assert(!engine.geometries[recovered].render_vertices_override && !engine.geometries[recovered].render_indices_override);
 assert(engine.geometries[recovered].vertices.size()==3 && engine.geometries[recovered].vertices[0].position.x==777);
 assert(engine.geometries[recovered].indices.size()==3 && engine.geometries[recovered].indices[0]==1);
 assert(engine.geometries[recovered].bounds_min.x==301);
 auto other=create_retained_mesh_from_data(engine,"changed",p,n,indices,uv,uv,tangent,color);
 const auto mutated=changed::update_mesh_geometry_capacity(engine,other,bigP,bigN,bigIndices,bigUv,bigUv,bigTangent,bigColor,std::nullopt,std::nullopt);
 assert(mutated.vertexCapacity==6 && mutated.indexCapacity==9);
 auto empty=create_retained_mesh_from_data(engine,"empty",{},{},{},std::nullopt,std::nullopt,std::nullopt,std::nullopt);
 const auto emptyResult=update_mesh_geometry_capacity(engine,empty,{},{},{},std::nullopt,std::nullopt,std::nullopt,std::nullopt,std::nullopt,std::nullopt);
 assert(emptyResult.stable && emptyResult.vertexCapacity==0 && emptyResult.indexCapacity==0 && !handle_at(engine.meshes,empty).has_bounds);
 return 0;
}
int main() { try { return check(); } catch (const std::exception& error) { std::fprintf(stderr,"%s\\n",error.what());return 2; } }
`,
        { flags: ["/Gy"], timeoutMs: 10000, expectedOutput: "" },
    );
});
