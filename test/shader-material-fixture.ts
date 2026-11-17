import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import {
    lowerShaderUniformApi,
    lowerShaderUniformSnapshot,
} from "../src/lowering/shader-uniforms.js";
import { cppFunction } from "./native-fixture.js";

/** Actual emitted material construction, metadata and uniform bodies without a GPU window. */
export function compileShaderMaterialFixture(source: string) {
    const compiled = compileSource(source);
    const context = new LoweringContext();
    // Gated as generation gates it: on the scene's own reach.
    const declarationLists = compiled.manifest.features.includes(
        "material:shader-declaration-lists",
    );
    const factory = new FactoryLowerer(context).lowerShaderMaterialFactory({
        declarationLists,
    }).source;
    const plan = new RendererLowerer(context).lowerRenderPlan({
        shaderPrograms: compiled.manifest.customShaderPrograms,
        shaderDeclarationLists: declarationLists,
    });
    return {
        compiled,
        cpp: `
#include <bblite/shader_uniforms.hpp>
#include <cassert>
namespace bbl::upstream {
${plan.header.slice(plan.header.indexOf("enum class ShaderSystemMatrix"), plan.header.indexOf("constexpr std::uint32_t shader_variant_count()"))}
${cppFunction(plan.source, "const ShaderVariantInfo& shader_variant_info(")}
}
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
void initialize_shader_packet_camera_cache(const Scene&, const MaterialRecord&) {}
${lowerShaderUniformApi(context)}
${cppFunction(factory, "void apply_shader_material_variant(")}
${cppFunction(factory, "MaterialHandle create_shader_material(")}
${cppFunction(factory, "MaterialRecord& shader_material(")}
${declarationLists ? cppFunction(factory, "std::vector<std::string> shader_declaration_names(") : ""}
${lowerShaderUniformSnapshot(context)}
${cppFunction(factory, "void initialize_shader_uniform_values(")}
${cppFunction(factory, "void set_shader_uniform_values(")}
${factory.slice(factory.indexOf("void set_shader_uniform_value("), factory.indexOf("// setShaderTexture:"))}
}
`,
    };
}
