import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMaterialPredicate } from "../src/lowering/material-predicate.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { lowerShaderUniformApi } from "../src/lowering/shader-uniforms.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";
import { shaderUniformValueLayout } from "../src/shader-material-programs.js";
import { lowerWgslShaderProgram } from "../src/shader-ir.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    cppFunction,
    runGeneratedProgram,
} from "./native-fixture.js";

const matrix = "[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]";
function program(defaultValue: string, operation: string): string {
    return `import {createEngine,createShaderMaterial,setShaderMatrix,getShaderUniform,isShaderMaterial,isStandardMaterial} from "babylon-lite";
async function main(){
const engine=await createEngine({});
const material=createShaderMaterial({
vertexSource:"struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderUniforms.uTransform*vec4f(input.position,1.0);return out;}",
fragmentSource:"@fragment fn mainFragment()->@location(0) vec4f{return vec4f(1.0);}",
attributes:["position"],uniforms:[{name:"uTransform",type:"mat4x4<f32>",defaultValue:${defaultValue}}]});
${operation}
}main();`;
}

test("matrix uniforms admit literal and owned array defaults, typed subviews and material predicates without deferred calls", () => {
    for (const defaultValue of [
        matrix,
        "new Array<number>(16).fill(0)",
        "new Array(16).fill(0)",
        "new Float32Array(16)",
    ]) {
        const compiled = compileSource(
            program(
                defaultValue,
                `
const values=new Float32Array(32);values.set(${matrix},16);
setShaderMatrix(material,"uTransform",values.subarray(16,32));
if(!isShaderMaterial(material)||isStandardMaterial(material))throw new Error("family");`,
            ),
        );
        assert.deepEqual(compiled.manifest.deferredCapabilities ?? [], []);
        assert.match(compiled.cpp, /std::array<float, 16>/);
        assert.match(compiled.cpp, /size\(\) != 16u/);
        assert.match(compiled.cpp, /source_group_builder/);
        assert.doesNotMatch(compiled.cpp, /deferred_capability/);
    }
    assert.throws(
        () =>
            compileSource(
                program(
                    matrix,
                    'setShaderMatrix(material,"missing",new Float32Array(16));',
                ),
            ),
        /declares no custom uniform/,
    );
    assert.throws(
        () =>
            compileSource(
                program(
                    matrix,
                    'setShaderMatrix(material,"uTransform",new Float32Array(16));',
                )
                    .replace('type:"mat4x4<f32>"', 'type:"vec4<f32>"')
                    .replace(
                        `defaultValue:${matrix}`,
                        "defaultValue:[0,0,0,0]",
                    ),
            ),
        /expects 16/,
    );
});

test("matrix updates preserve the pin's rounded comparison and signed-zero bytes", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    interface Material {
        _uniformValues: Map<
            string,
            {
                value: Float32Array;
                decl: { name: string; type: string };
                _v: number;
            }
        >;
        _uniformVersion: number;
        _uboVersion: number;
    }
    const { setShaderMatrix } = await importPinnedModule<{
        setShaderMatrix(
            this: void,
            material: Material,
            name: string,
            value: Float32Array,
        ): void;
    }>("material/shader/shader-material.js");
    const initial = Float32Array.from({ length: 16 }, (_, index) =>
        index % 2 ? -0 : 0,
    );
    const stored = initial.slice();
    const material: Material = {
        _uniformValues: new Map([
            [
                "uTransform",
                {
                    value: stored,
                    decl: { name: "uTransform", type: "mat4x4<f32>" },
                    _v: 0,
                },
            ],
        ]),
        _uniformVersion: 0,
        _uboVersion: 0,
    };
    const values = Float32Array.from({ length: 16 }, (_, index) =>
        index < 4 ? (index % 2 ? 0 : -0) : index / 7,
    );
    setShaderMatrix(material, "uTransform", values);
    const expected = Array.from(new Uint32Array(stored.buffer));
    runGeneratedProgram(
        native,
        "material-api/matrix",
        `
#include <bblite/shader_uniforms.hpp>
#include <cassert>
#include <bit>
namespace bbl { MaterialRecord& shader_material(Engine& engine, MaterialHandle handle) { return handle_at(engine.materials,handle); }
${lowerShaderUniformApi(new LoweringContext())}
${cppFunction(new FactoryLowerer(new LoweringContext()).lowerShaderMaterialFactory().source, "void set_shader_uniform_values(")}
}
int main(){bbl::Engine engine;engine.materials.emplace_back();auto state=std::make_shared<bbl::ShaderUniformState>();engine.materials[0].shader_uniforms=state;
state->slots.push_back({"before","vec2<f32>",0,bbl::js::F32Array(std::vector<float>{99,99}),0});
state->slots.push_back({"matrix","mat4x4<f32>",2,bbl::js::F32Array(16),0});
state->slots.push_back({"after","vec2<f32>",18,bbl::js::F32Array(std::vector<float>{99,99}),0});
auto values=state->slots[1].value;
for(std::size_t i=0;i<16;++i)values.store(i,i%2?-0.0f:0.0f);
const std::array<float,16> input{${Array.from(values, (value) => (Object.is(value, -0) ? "-0.0f" : `static_cast<float>(${value})`)).join(",")}};
bbl::set_shader_uniform_values(engine,{0},2,16u,input.data());bbl::set_shader_uniform_values(engine,{0},2,16u,input.data());
const std::array<std::uint32_t,16> expected{${expected.map((value) => `${value}u`).join(",")}};
for(std::size_t i=0;i<16;++i)assert(std::bit_cast<std::uint32_t>(values.load(i))==expected[i]);
assert(state->slots[0].value.load(0)==99&&state->slots[2].value.load(1)==99);
bool rejected=false;try{bbl::set_shader_uniform_values(engine,{0},5,16u,input.data());}catch(const std::runtime_error&){rejected=true;}assert(rejected);
}`,
        { expectedOutput: "" },
    );
});

test("compiled matrix defaults and subview writes preserve slots and reject invalid lengths", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const source = program(
        "new Array(16).fill(0)",
        `
const initial=getShaderUniform(material,"uTransform");if(typeof initial==="number"||initial[0]!==0||initial[15]!==0)throw new Error("matrix default");
const values=new Float32Array(32);for(let i=0;i<16;i++)values[i+16]=i+0.25;
setShaderMatrix(material,"uTransform",values.subarray(16,32));
let rejected=false;try{setShaderMatrix(material,"uTransform",values.subarray(16,31));}catch(error){rejected=error.message.includes("expects 16 value(s), got 15");}
if(!rejected)throw new Error("matrix length");
setShaderMatrix(material,"uTransform",values.subarray(16,32));
if(initial[0]!==0.25||initial[15]!==15.25||getShaderUniform(material,"before")!==7||getShaderUniform(material,"after")!==9)throw new Error("matrix writes and neighbours");`,
    )
        .replace(
            "uniforms:[{name:",
            'uniforms:[{name:"before",type:"f32",defaultValue:7},{name:',
        )
        .replace(
            "defaultValue:new Array(16).fill(0)}]",
            'defaultValue:new Array(16).fill(0)},{name:"after",type:"f32",defaultValue:9}]',
        );
    const { compiled, cpp } = compileShaderMaterialFixture(source);
    runGeneratedProgram(
        native,
        "material-api/compiled",
        `
${cpp}
#define main generated_main
${compiled.cpp}
#undef main
int main(){const auto& info=bbl::upstream::shader_variant_info(0);assert(info.value_count==18&&info.defaults.size()==18);assert(info.vertex.gather.empty());assert(generated_main()==0);}
`,
        { expectedOutput: "" },
    );
});

test("matrix value layout and reflected blocks keep following scalars after all sixteen lanes", () => {
    for (const uniforms of [
        ["matrix:mat4x4<f32>", "scalar:f32"],
        ["scalar:f32", "matrix:mat4x4<f32>"],
    ]) {
        const layout = shaderUniformValueLayout(uniforms);
        assert.equal(layout.get("matrix")?.count, 16);
        assert.equal(
            layout.get("scalar")?.offset,
            uniforms[0]!.startsWith("matrix") ? 16 : 0,
        );
        assert.equal(
            layout.get("matrix")?.offset,
            uniforms[0]!.startsWith("scalar") ? 1 : 0,
        );
        const reflected = lowerWgslShaderProgram({
            name: "matrix-layout",
            vertexSource:
                "struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderUniforms.matrix*vec4f(input.position*shaderUniforms.scalar,1.0);return out;}",
            fragmentSource:
                "@fragment fn mainFragment()->@location(0) vec4f{return vec4f(1.0);}",
            attributes: ["position"],
            uniforms,
            needAlphaBlending: false,
            needAlphaTesting: false,
            backFaceCulling: true,
            depthWrite: true,
        }).reflection;
        const block = reflected.uniformBlocks.find(
            (block) => block.stage === "vertex",
        )!;
        assert.equal(block.size, 80);
        assert.equal(
            block.members.find((member) => member.name === "matrix")?.size,
            64,
        );
        assert.equal(
            block.members.find((member) => member.name === "matrix")?.offset,
            uniforms[0]!.startsWith("scalar") ? 16 : 0,
        );
        assert.equal(
            block.members.find((member) => member.name === "scalar")?.offset,
            uniforms[0]!.startsWith("matrix") ? 64 : 0,
        );
    }
});

test("material predicates read runtime family identity and material-view sources from the pinned guards", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const context = new LoweringContext();
    const shader = lowerMaterialPredicate(
        context,
        "isShaderMaterial",
        "is_shader",
    );
    const standard = lowerMaterialPredicate(
        context,
        "isStandardMaterial",
        "is_standard",
    );
    const changed = lowerMaterialPredicate(
        doctoredContext(
            "src/material/material-guards.ts",
            'return getMaterialFamily(material) === "shader";',
            'return getMaterialFamily(material) === "standard";',
        ),
        "isShaderMaterial",
        "changed_guard",
    );
    runGeneratedProgram(
        native,
        "material-api/predicates",
        `
#include <bblite/runtime.hpp>
#include <cassert>
${[shader, standard, changed].flatMap((value) => value.lines).join("\n")}
int main(){bbl::Engine engine;engine.materials.resize(6);
engine.materials[1].source_group_builder=2;engine.materials[2].source_group_builder=3;
engine.materials[3].source_pbr_group_builder=true;engine.materials[4].source_group_builder=4;
engine.materials[5].source_material={2};
for(unsigned i=0;i<6;++i){assert(is_shader(engine,{i})==(i==2||i==5));assert(is_standard(engine,{i})==(i==1));assert(changed_guard(engine,{i})==(i==1));}
}`,
        { expectedOutput: "" },
    );
});
