import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMeshAttributeUpdates } from "../src/lowering/mesh-attribute-updates.js";
import { lowerMeshAttributeCapacities } from "../src/lowering/mesh-attribute-capacities.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    runGeneratedProgram,
} from "./native-fixture.js";

test("position and UV updates share source range validation and native uploads", (t) => {
    const compiled =
        compileSource(`import {createEngine,createBox,updateMeshPositions,updateMeshUvs} from "babylon-lite";
        async function main(){const engine=await createEngine({});const mesh=createBox(engine,1);updateMeshUvs(engine,mesh,new Float32Array([0,1]),1,1,0);updateMeshUvs(engine,mesh,new Float32Array([0,1]),1,undefined,0);updateMeshPositions(engine,mesh,new Float32Array([1,2,3]));}main();`);
    assert(compiled.manifest.features.includes("mesh:update-attributes"));
    assert.match(compiled.cpp, /update_mesh_uvs/);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const directory = resolve("artifacts/mesh-attribute-updates");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    const source = lowerMeshAttributeUpdates(new LoweringContext());
    const changed = lowerMeshAttributeUpdates(
        doctoredContext(
            "src/mesh/mesh-factories.ts",
            "\n        count < 0 ||",
            "\n        count < 1 ||",
        ),
    );
    writeFileSync(
        file,
        `#include <bblite/pal_mesh_attributes.hpp>
#include <cassert>
#include <cmath>
#include <stdexcept>
using namespace bbl;
namespace original {${source}}
namespace changed {${changed}}
template<class F>void rejects(F function,const char* code){bool caught=false;try{function();}catch(const std::runtime_error& error){caught=true;assert(std::string(error.what())==code);}assert(caught);}
int main(){Engine engine;engine.geometries.emplace_back();engine.meshes.emplace_back().geometry=0;const MeshHandle mesh{0};auto& geometry=engine.geometries[0];geometry.owned_packed_geometry=true;geometry.vertices.resize(3);geometry.bounds_max={9,9,9};
geometry.attribute_capacities={36,36,24,0,0,0};
original::update_mesh_positions(engine,mesh,{1,2,3,4,5,6},1,std::nullopt,0);
const auto& uploaded=*geometry.render_vertices_override;
assert(uploaded[0].position.x==0&&uploaded[1].position.x==1&&uploaded[2].position.z==6);
assert(geometry.vertices[1].position.x==0&&geometry.vertices[2].position.z==0);assert(geometry.attribute_version==1&&engine.meshes[0].transform_version==1&&geometry.bounds_max.x==9);
geometry.has_uvs=false;
original::update_mesh_uvs(engine,mesh,{1,2,3,4,5,6},1,1,1);
assert(uploaded[1].uv.x==3&&uploaded[1].uv.y==4&&uploaded[2].uv.x==0&&!geometry.has_uvs&&geometry.attribute_version==2);
assert(geometry.vertices[1].uv.x==0&&geometry.vertices[1].uv.y==0);
original::update_mesh_uvs(engine,mesh,{0,0},999,0,0);assert(geometry.attribute_version==2);
rejects([&]{changed::update_mesh_uvs(engine,mesh,{0,0},0,0,0);},"#556");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0},0,std::nullopt,0);},"#556");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},-1,1,0);},"#556");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},0,1,0.5);},"#556");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},0,std::numeric_limits<double>::quiet_NaN(),0);},"#556");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},0,2,0);},"#556");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},3,1,0);},"#557");
geometry.owners=2;rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},0,1,0);},"#555");geometry.owners=1;
geometry.owned_packed_geometry=false;rejects([&]{original::update_mesh_positions(engine,mesh,{0,0,0},0,1,0);},"#555");
assert(geometry.attribute_version==2&&engine.meshes[0].transform_version==2);
}`,
    );
    runNativeFixtureCompiler(native, [
        "/Gy",
        file,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    execFileSync(exe, { stdio: "pipe", timeout: 10000 });
});

test("all mesh attribute adapters retain ordinary reach and typed ranges", () => {
    for (const [api, native] of [
        ["updateMeshNormals", "normals"],
        ["updateMeshColors", "colors"],
        ["updateMeshTangents", "tangents"],
        ["updateMeshUv2", "uv2"],
    ]) {
        const compiled = compileSource(
            `import {createEngine,createBox,${api}} from "babylon-lite";
            const engine=await createEngine({});const mesh=createBox(engine,1);
            ${api}(engine,mesh,new Float32Array(0),undefined,undefined,undefined);`,
            { deferredCapabilities: "runtime-throw" },
        );
        assert(compiled.manifest.features.includes("mesh:update-attributes"));
        assert.equal(compiled.manifest.deferredCapabilities?.length ?? 0, 0);
        assert.match(compiled.cpp, new RegExp(`bbl::update_mesh_${native}\\(`));
    }
    const isolated = new FactoryLowerer(
        new LoweringContext(),
    ).lowerMeshFactories([]).source;
    assert.doesNotMatch(
        isolated,
        /void update_mesh_(?:normals|colors|tangents|uv2)\(/,
    );
});

test("attribute uploads preserve lane capacities, absent buffers and CPU geometry", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const context = new LoweringContext();
    const optionalChanged = doctoredContext(
        "src/mesh/mesh-factories.ts",
        "if (!gpu.colorBuffer)",
        "if (gpu.colorBuffer)",
    );
    const capacityChanged = doctoredContext(
        "src/resource/mapped-buffer.ts",
        "Math.max(data.byteLength, 4)",
        "Math.max(data.byteLength, 16)",
    );
    const allocationChanged = doctoredContext(
        "src/mesh/mesh.ts",
        "if (uvs2 && uvs2.length > 0)",
        "if (uvs2 && uvs2.length > 2)",
    );
    runGeneratedProgram(
        native,
        "mesh-attribute-capacities-check",
        `
#include <bblite/pal_mesh_attributes.hpp>
#include <cassert>
using namespace bbl;
namespace original {${lowerMeshAttributeUpdates(context)}
${lowerMeshAttributeCapacities(context)}
${lowerMeshAttributeCapacities(context, true)}}
namespace changed {${lowerMeshAttributeUpdates(optionalChanged)}}
namespace changed_capacity {${lowerMeshAttributeCapacities(capacityChanged)}}
namespace changed_allocation {${lowerMeshAttributeCapacities(allocationChanged)}}
template<class F> void rejects(F function, const char* code) {
    bool caught=false; try {function();} catch(const std::runtime_error& error) {
        caught=true; assert(std::string(error.what())==code);
    } assert(caught);
}
int main() {
    Engine engine; engine.geometries.emplace_back(); engine.meshes.emplace_back().geometry=0;
    const MeshHandle mesh{0}; auto& geometry=engine.geometries[0];
    geometry.owned_packed_geometry=true; geometry.vertices.resize(3);
    geometry.attribute_capacities=original::uploaded_mesh_attribute_capacities(9,9,6,6,12,12);
    geometry.has_tangents=true; geometry.cpu_uv2s=true; geometry.has_vertex_colors=true;
    original::update_mesh_normals(engine,mesh,{11,12,13,21,22,23,31,32,33},1,std::nullopt,1);
    original::update_mesh_colors(engine,mesh,{10,11,12,13,20,21,22,23},1,1,1);
    original::update_mesh_tangents(engine,mesh,{41,42,43,-1},2,std::nullopt,0);
    original::update_mesh_uv2(engine,mesh,{51,52,61,62,71,72},1,1,1);
    const auto& rendered=*geometry.render_vertices_override;
    assert(rendered[0].normal.y==1 && rendered[1].normal.x==21 && rendered[2].normal.z==33);
    assert(rendered[1].color.x==20 && rendered[1].color.w==23 && rendered[2].color.x==1);
    assert(rendered[2].tangent.x==41 && rendered[2].tangent.w==-1 && rendered[1].tangent.w==1);
    assert(rendered[1].uv2.x==61 && rendered[1].uv2.y==62 && rendered[2].uv2.x==0);
    assert(geometry.vertices[1].normal.x==0 && geometry.vertices[1].normal.y==1);
    assert(geometry.vertices[1].color.x==1 && geometry.vertices[2].tangent.x==1 && geometry.vertices[1].uv2.x==0);
    assert(geometry.attribute_version==4 && engine.meshes[0].transform_version==4);
    changed::update_mesh_colors(engine,mesh,{0,0,0,0},0,1,0);
    assert(geometry.attribute_version==4);
    original::update_mesh_normals(engine,mesh,{},999,0,0);
    original::update_mesh_colors(engine,mesh,{},999,0,0);
    original::update_mesh_tangents(engine,mesh,{},999,0,0);
    original::update_mesh_uv2(engine,mesh,{},999,0,0);
    assert(geometry.attribute_version==4);
    rejects([&]{original::update_mesh_normals(engine,mesh,{0,0},0,std::nullopt,0);},"#556");
    rejects([&]{original::update_mesh_colors(engine,mesh,{0,0,0,0},-1,1,0);},"#556");
    rejects([&]{original::update_mesh_tangents(engine,mesh,{0,0,0,0},0,1,0.5);},"#556");
    rejects([&]{original::update_mesh_uv2(engine,mesh,{0,0},0,2,0);},"#556");
    rejects([&]{original::update_mesh_normals(engine,mesh,{0,0,0},3,1,0);},"#557");
    rejects([&]{original::update_mesh_colors(engine,mesh,{0,0,0,0},3,1,0);},"#557");
    rejects([&]{original::update_mesh_tangents(engine,mesh,{0,0,0,0},3,1,0);},"#557");
    rejects([&]{original::update_mesh_uv2(engine,mesh,{0,0},3,1,0);},"#557");
    geometry.owners=2;
    rejects([&]{original::update_mesh_normals(engine,mesh,{0,0,0},0,1,0);},"#555");
    rejects([&]{original::update_mesh_colors(engine,mesh,{0,0,0,0},0,1,0);},"#555");
    rejects([&]{original::update_mesh_tangents(engine,mesh,{0,0,0,0},0,1,0);},"#555");
    rejects([&]{original::update_mesh_uv2(engine,mesh,{0,0},0,1,0);},"#555");
    geometry.attribute_capacities=original::uploaded_mesh_attribute_capacities(9,9,0,0,0,0);
    // Absent optional buffers return before shared ownership and malformed ranges.
    original::update_mesh_colors(engine,mesh,{0},-1,std::nullopt,-1);
    original::update_mesh_tangents(engine,mesh,{0},-1,std::nullopt,-1);
    original::update_mesh_uv2(engine,mesh,{0},-1,std::nullopt,-1);
    assert(geometry.attribute_version==4);
    geometry.owners=1;
    const auto omitted=original::uploaded_mesh_attribute_capacities(9,9,std::nullopt,std::nullopt,std::nullopt,std::nullopt);
    assert(omitted.uv==24 && omitted.uv2==0 && omitted.tangent==0 && omitted.color==0);
    geometry.attribute_capacities=original::uploaded_mesh_attribute_capacities(9,0,2,2,4,4);
    assert(geometry.attribute_capacities.normal==4);
    rejects([&]{original::update_mesh_normals(engine,mesh,{0,0,0},0,1,0);},"#557");
    rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},1,1,0);},"#557");
    rejects([&]{original::update_mesh_uv2(engine,mesh,{0,0},1,1,0);},"#557");
    rejects([&]{original::update_mesh_colors(engine,mesh,{0,0,0,0},1,1,0);},"#557");
    rejects([&]{original::update_mesh_tangents(engine,mesh,{0,0,0,0},1,1,0);},"#557");
    geometry.attribute_capacities=original::uploaded_mesh_attribute_capacities(9,15,10,10,20,20);
    original::update_mesh_normals(engine,mesh,{7,8,9},4,1,0);
    original::update_mesh_uvs(engine,mesh,{7,8},4,1,0);
    original::update_mesh_uv2(engine,mesh,{7,8},4,1,0);
    original::update_mesh_colors(engine,mesh,{7,8,9,10},4,1,0);
    original::update_mesh_tangents(engine,mesh,{7,8,9,10},4,1,0);
    assert(rendered.size()==3 && rendered[2].normal.z==33 && geometry.attribute_version==9);
    geometry.indices={0,1,4};
    rejects([&]{original::update_mesh_normals(engine,mesh,{7,8,9},4,1,0);},
        "Mesh attribute uploads to indexed vertices outside the position stream are not represented.");
    assert(geometry.attribute_version==9 && rendered[2].normal.z==33);
    geometry.indices.clear();
    const auto recovered=original::recovered_mesh_attribute_capacities(9,0,0,0,0,0);
    assert(recovered.position==36 && recovered.normal==4 && recovered.uv==24);
    assert(recovered.uv2==4 && recovered.color==4 && recovered.tangent==0);
    const auto recoveredAbsent=original::recovered_mesh_attribute_capacities(9,0,std::nullopt,std::nullopt,std::nullopt,std::nullopt);
    assert(recoveredAbsent.uv==24 && recoveredAbsent.uv2==0 && recoveredAbsent.color==0 && recoveredAbsent.tangent==0);
    assert(original::recovered_mesh_attribute_capacities(9,0,0,0,12,0).tangent==48);
    const auto changedSizes=changed_capacity::uploaded_mesh_attribute_capacities(9,0,0,1,1,1);
    assert(changedSizes.normal==16 && changedSizes.uv2==16 && changedSizes.color==16);
    assert(changed_allocation::uploaded_mesh_attribute_capacities(9,9,6,2,4,4).uv2==0);
    geometry.owned_packed_geometry=false;
    rejects([&]{original::update_mesh_normals(engine,mesh,{0,0,0},0,1,0);},"#555");
    rejects([&]{original::update_mesh_colors(engine,mesh,{0,0,0,0},0,1,0);},"#555");
    rejects([&]{original::update_mesh_tangents(engine,mesh,{0,0,0,0},0,1,0);},"#555");
    rejects([&]{original::update_mesh_uv2(engine,mesh,{0,0},0,1,0);},"#555");
    geometry.owned_packed_geometry=true;
    const js::F32Array backing{99,99,99,1,2,3,4,5,6,99,99,99};
    const js::F32Array view(backing.buffer(),12,6);
    original::update_mesh_normals(engine,mesh,view,0,1,1);
    assert(rendered[0].normal.x==4 && rendered[0].normal.z==6);
}
`,
        { flags: ["/Gy"], timeoutMs: 10000 },
    );
});

test("generated attribute calls preserve subarray views and argument effects", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const compiled = compileSource(`
        import {createEngine,createMeshFromData,updateMeshNormals,updateMeshColors,updateMeshTangents,updateMeshUv2,type Mesh} from "babylon-lite";
        const engine=await createEngine({});
        const positions=new Float32Array(9), normals=new Float32Array(9), uvs=new Float32Array(6), tangents=new Float32Array(12), colors=new Float32Array(12);
        const mesh=createMeshFromData(engine,"ranges",positions,normals,new Uint32Array([0,1,2]),uvs,uvs,tangents,colors);
        const order:number[]=[];
        let values=new Float32Array([99,99,99,1,2,3,4,5,6,99,99,99]);
        const view=values.subarray(3,9);
        function selected():Mesh {order.push(1);return mesh;}
        function offset():number {order.push(2);view[0]=7;values=new Float32Array(30);return 1;}
        function count():number {order.push(3);return 1;}
        function sourceOffset():number {order.push(4);return 0;}
        updateMeshNormals(engine,selected(),view,offset(),count(),sourceOffset());
        if(order.join(",")!=="1,2,3,4")throw new Error("argument order");
        updateMeshNormals(engine,mesh,view,1,undefined,0);
        updateMeshColors(engine,mesh,new Float32Array([99,99,99,99,1,2,3,4,99,99,99,99]).subarray(4,8),2);
        updateMeshTangents(engine,mesh,new Float32Array([99,99,99,99,1,2,3,4,99,99,99,99]).subarray(4,8),2);
        updateMeshUv2(engine,mesh,new Float32Array([99,99,1,2,99,99]).subarray(2,4),2);
        if(normals[0]!==0||colors[0]!==0||tangents[0]!==0||uvs[0]!==0)throw new Error("CPU streams changed");
    `);
    const factories = new FactoryLowerer(
        new LoweringContext(),
    ).lowerMeshFactories(["mesh:from-data", "mesh:update-attributes"]).source;
    runGeneratedProgram(
        native,
        "mesh-attribute-arguments-check",
        `${factories}
namespace bbl {Engine create_engine(EngineOptions options) {Engine engine;engine.options=options;return engine;}}
${compiled.cpp}`,
        { flags: ["/Gy"], timeoutMs: 10000 },
    );
});
