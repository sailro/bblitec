import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerThinInstanceBindingCreation } from "../src/lowering/thin-instance-binding-update.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { meshFeaturesNamespace } from "../src/lowering/mesh-attribute-features.js";

test("shader thin color captures preserve absent and explicit source options independently of compiled lanes", (t) => {
    const fixture = compileShaderMaterialFixture(`
import {createEngine,createShaderMaterial,createLineMaterial} from "@babylonjs/lite";
const engine=await createEngine({});
const custom=createShaderMaterial({name:"custom",
 vertexSource:"struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=vec4f(input.position,1.0);return out;}",
 fragmentSource:"@fragment fn mainFragment()->@location(0) vec4f{return vec4f(1.0);}",
 attributes:["position"],uniforms:[]});
const disabled=createLineMaterial({useThinInstances:true,useThinInstanceColors:false});
const enabled=createLineMaterial({useThinInstances:true,useThinInstanceColors:true});
`);
    const programs = fixture.compiled.manifest.customShaderPrograms;
    assert.deepEqual(
        programs.map((program) => program.thinInstanceColorOption),
        [undefined, false, true],
    );
    assert.equal(programs[0]?.useThinInstanceColors, undefined);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "thin-instance-material-colors",
        `${fixture.cpp}
${meshFeaturesNamespace(new LoweringContext())}
namespace bbl {
${lowerThinInstanceBindingCreation(new LoweringContext())}
}
int main() {
    bbl::Engine engine;
    engine.meshes.resize(1);
    auto pool=std::make_shared<bbl::ThinInstancePoolData>();
    pool->colors=bbl::js::F32Array(0);
    engine.meshes[0].thin_instances=pool;
    const auto custom=bbl::create_shader_material(engine,0);
    const auto disabled=bbl::create_shader_material(engine,1);
    const auto enabled=bbl::create_shader_material(engine,2);
    assert(!bbl::handle_at(engine.materials,custom).shader_thin_instance_colors.has_value());
    assert(bbl::handle_at(engine.materials,disabled).shader_thin_instance_colors.value()==0);
    assert(bbl::handle_at(engine.materials,enabled).shader_thin_instance_colors.value()==1);
    assert(!bbl::upstream::shader_variant_info(0).instance_colors);
    const auto captured=bbl::create_thin_material_binding(engine,{0},custom);
    assert(captured->shader_has_color);
    assert(!bbl::create_thin_material_binding(engine,{0},disabled)->shader_has_color);
    assert(bbl::create_thin_material_binding(engine,{0},enabled)->shader_has_color);
    pool->colors=std::nullopt;
    assert(captured->shader_has_color);
    assert(!bbl::create_thin_material_binding(engine,{0},custom)->shader_has_color);
}
`,
        { flags: ["/DBBLITE_NODE_VARIANTS=0"] },
    );
});
