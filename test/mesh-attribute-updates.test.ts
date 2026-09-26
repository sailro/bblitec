import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMeshAttributeUpdates } from "../src/lowering/mesh-attribute-updates.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
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
original::update_mesh_positions(engine,mesh,{1,2,3,4,5,6},1,std::nullopt,0);
const auto& uploaded=*geometry.render_vertices_override;
assert(uploaded[0].position.x==0&&uploaded[1].position.x==1&&uploaded[2].position.z==6);
assert(geometry.vertices[1].position.x==0&&geometry.vertices[2].position.z==0);assert(geometry.attribute_version==1&&engine.meshes[0].transform_version==1&&geometry.bounds_max.x==9);
geometry.has_uvs=false;
original::update_mesh_uvs(engine,mesh,{1,2,3,4,5,6},1,1,1);
assert(uploaded[1].uv.x==3&&uploaded[1].uv.y==4&&uploaded[2].uv.x==0&&!geometry.has_uvs&&geometry.attribute_version==2);
assert(geometry.vertices[1].uv.x==0&&geometry.vertices[1].uv.y==0);
original::update_mesh_uvs(engine,mesh,{0,0},999,0,0);assert(geometry.attribute_version==2);
rejects([&]{changed::update_mesh_uvs(engine,mesh,{0,0},0,0,0);},"#466");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0},0,std::nullopt,0);},"#466");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},-1,1,0);},"#466");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},0,1,0.5);},"#466");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},0,std::numeric_limits<double>::quiet_NaN(),0);},"#466");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},0,2,0);},"#466");
rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},3,1,0);},"#467");
geometry.owners=2;rejects([&]{original::update_mesh_uvs(engine,mesh,{0,0},0,1,0);},"#465");geometry.owners=1;
geometry.owned_packed_geometry=false;rejects([&]{original::update_mesh_positions(engine,mesh,{0,0,0},0,1,0);},"#465");
assert(geometry.attribute_version==2&&engine.meshes[0].transform_version==2);
}`,
    );
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/Gy",
        `/I${resolve("native/include")}`,
        file,
        `/Fo${directory}/`,
        `/Fe${exe}`,
        "/link",
        "/OPT:REF",
    ]);
    execFileSync(exe, { stdio: "pipe", timeout: 10000 });
});
