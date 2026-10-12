import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("thin matrix arguments preserve numeric views, precision and evaluation order", (t) => {
    const result = compileSource(`
import {createEngine,createBox,setThinInstances,setThinInstanceMatrix,addThinInstance,type Mesh} from "@babylonjs/lite";
function bind(mesh:Mesh, matrices:Float32Array|Float64Array, count:number):void {
  setThinInstances(mesh,matrices,count);
}
const engine=await createEngine(new OffscreenCanvas(1,1));
const mesh=createBox(engine);
const backing32=new Float32Array(32), backing64=new Float64Array(32);
backing32[20]=7;backing64[20]=1.0000000000000002;
bind(mesh,backing32.subarray(8,24),1);
bind(mesh,backing64.subarray(8,24),1);
const runtime=backing32[0] ? backing32.subarray(8,24) : backing64.subarray(8,24);
bind(mesh,runtime,1);
let selected:Float32Array|Float64Array=backing64.subarray(8,24);
function replace():number { selected=backing32;return 1.0000000000000002; }
setThinInstances(mesh,selected,replace());
setThinInstanceMatrix(mesh,0,backing32.subarray(8,24));
setThinInstanceMatrix(mesh,1,backing64.subarray(8,24));
const added=addThinInstance(mesh,runtime);
if(added!==2)throw new Error("matrix result");
const numbers=new Array<number>(16).fill(1.0000000000000002);
setThinInstanceMatrix(mesh,2,numbers);
addThinInstance(mesh,[1.0000000000000002,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
let index=0;
function matrixWithEffect():Float64Array {index=7;return backing64.subarray(8,24);}
setThinInstanceMatrix(mesh,index,matrixWithEffect());
backing32[20]=11;backing64[20]=1.0000000000000004;
globalThis.close();
`);
    assert.ok(result.manifest.features.includes("mesh:thin-instances"));
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required for argument ownership checks.");
        return;
    }
    // Capture the compiler/native boundary independently of the pool setter bodies.
    runGeneratedProgram(
        native,
        "thin-instance-arguments",
        `#include <bblite/pal_async_engine.hpp>
#include <cassert>
namespace bbl::pal {
std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) { return std::make_shared<Engine>(); }
}
namespace bbl {
using FixtureMatrices = std::variant<js::F32Array,js::F64Array>;
std::vector<std::pair<FixtureMatrices,double>> captured;
std::vector<std::pair<js::NumericArrayView,double>> matrix_inputs;
std::vector<double> matrix_reads;
Engine create_engine(EngineOptions) { return {}; }
MeshHandle create_box(Engine& engine,BoxOptions) { engine.meshes.emplace_back(); return {0}; }
void set_thin_instances(Engine&,MeshHandle,const FixtureMatrices& matrices,double count) { captured.emplace_back(matrices,count); }
void set_thin_instance_matrix(Engine&,MeshHandle,double index,const js::NumericArrayView& matrix) {matrix_inputs.emplace_back(matrix,index);matrix_reads.push_back(matrix.load(12));}
double add_thin_instance(Engine& engine,MeshHandle mesh,const js::NumericArrayView& matrix) {set_thin_instance_matrix(engine,mesh,2,matrix);return 2;}
}
#define main generated_scene_main
${result.cpp}
#undef main
int main() {
assert(generated_scene_main()==0);
assert(bbl::captured.size()==4);
const auto& first=std::get<bbl::js::F32Array>(bbl::captured[0].first);
assert(first.size()==16&&first.load(12)==11&&first.byte_offset()==8*sizeof(float));
for(std::size_t i=1;i<4;++i){const auto& value=std::get<bbl::js::F64Array>(bbl::captured[i].first);assert(value.size()==16&&value.load(12)==1.0000000000000004&&value.byte_offset()==8*sizeof(double));}
assert(std::get<bbl::js::F64Array>(bbl::captured[1].first).buffer()==std::get<bbl::js::F64Array>(bbl::captured[3].first).buffer());
assert(bbl::captured[3].second==1.0000000000000002);
assert(bbl::matrix_inputs.size()==6);
assert(bbl::matrix_reads[0]==7);
assert(bbl::matrix_reads[1]==1.0000000000000002&&bbl::matrix_reads[2]==1.0000000000000002);
assert(bbl::matrix_inputs[3].first.load(0)==1.0000000000000002&&bbl::matrix_inputs[4].first.load(0)==1.0000000000000002);
assert(bbl::matrix_inputs[5].second==0);
assert(bbl::matrix_inputs[0].first.load(12)==11&&bbl::matrix_inputs[1].first.load(12)==1.0000000000000004);
}`,
        { flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1"] },
    );
});

test("thin pool binding requires an F32 or F64 owner", () => {
    for (const invalid of ["new Uint32Array(16)", "[1,2,3]"])
        assert.throws(() =>
            compileSource(`
import {createEngine,createBox,setThinInstances} from "@babylonjs/lite";
const engine=await createEngine(new OffscreenCanvas(1,1)); const mesh=createBox(engine); setThinInstances(mesh,${invalid},1);
`),
        );
});

test("thin matrix readback preserves the returned array arm and retained aliases", (t) => {
    const result = compileSource(`
import {createEngine,createBox,setThinInstances} from "@babylonjs/lite";
const engine=await createEngine(new OffscreenCanvas(1,1));const mesh=createBox(engine);
const wide=new Float64Array(32);const narrow=new Float32Array(32);
setThinInstances(mesh,wide.subarray(8,24),1);
const first=mesh.thinInstances!.matrices;
if(first instanceof Float64Array)first[12]=1.0000000000000002;else throw new Error("wide type");
if(wide[20]!==1.0000000000000002)throw new Error("wide alias");
setThinInstances(mesh,narrow.subarray(8,24),1);
const second=mesh.thinInstances!.matrices;
if(second instanceof Float32Array)second[12]=3;else throw new Error("narrow type");
if(narrow[20]!==3||first[12]!==1.0000000000000002)throw new Error("retained alias");
globalThis.close();
`);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required for readback transport checks.");
        return;
    }
    runGeneratedProgram(
        native,
        "thin-instance-readback-arguments",
        `#include <bblite/pal_async_engine.hpp>
namespace bbl::pal {
std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) { return std::make_shared<Engine>(); }
}
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
MeshHandle create_box(Engine& engine,BoxOptions) { engine.meshes.emplace_back(); return {0}; }
void set_thin_instances(Engine& engine,MeshHandle mesh,const ThinInstanceMatrices& matrices,double) {
    auto& pool=handle_at(engine.meshes,mesh).thin_instances;
    if(!pool)pool=std::make_shared<ThinInstancePoolData>();
    pool->matrices=matrices;
}
ThinInstanceMatrices thin_instance_matrices(const std::shared_ptr<ThinInstancePoolData>& pool) { return pool->matrices; }
}
${result.cpp}`,
        { flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1"] },
    );
});
