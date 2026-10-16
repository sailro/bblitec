import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/** A stored shader material resolves its sampler against its runtime variant. */
export function lowerShaderTextureNameBinding(
    context: LoweringContext,
): string {
    const module = "src/material/shader/shader-material.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "setShaderTexture",
    );
    const statements = declaration.body!.statements;
    context.assertStatementShapes(
        declaration,
        statements.slice(0, 1),
        "const slot = material._textureSlots.get(name);",
        "Shader texture slot lookup",
    );
    context.assertStatementShapes(
        declaration,
        statements.slice(3),
        `const view = texture?.view ?? null;
         const sampler = texture?.sampler ?? null;
         if (slot.current !== texture || (texture && (slot._view !== view || slot._sampler !== sampler))) {
             slot.current = texture;
             slot._view = view;
             slot._sampler = sampler;
             material._resourceVersion++;
             bumpVisibilityEpoch();
         }`,
        "Shader texture resource publication",
    );
    const checks = lowerPinnedBody(file, statements.slice(1, 3), {
        bindings: new Map<string, PinnedBinding>([
            ["name", { cpp: "name", type: "string" }],
            [
                "slot",
                { cpp: "found", type: "opaque", absentCpp: "found == end" },
            ],
            [
                "texture",
                { cpp: "is_depth_texture", type: "opaque", absentCpp: "false" },
            ],
            [
                "slot.decl.comparison",
                { cpp: "info.sampler_shapes[slot].comparison", type: "bool" },
            ],
        ]),
        calls: new Map(),
        expression(node) {
            if (
                context.expressionMatchesShape(
                    node,
                    'slot.decl.sampleType === "depth"',
                )
            )
                return "(info.sampler_shapes[slot].sample_type == upstream::ShaderSamplerSampleType::depth)";
            if (
                context.expressionMatchesShape(
                    node,
                    'texture._sampleType === "depth"',
                )
            )
                return "is_depth_texture";
            return undefined;
        },
    });
    return `// ${context.provenance(module, "setShaderTexture")}
std::uint32_t shader_texture_slot_by_name(
    Engine& engine, MaterialHandle material, const std::string& name, bool is_depth_texture) {
    const auto& record = shader_material(engine, material);
    const auto& info = upstream::shader_variant_info(record.shader_variant);
    const auto end = info.samplers.end() - info.external_textures;
    const auto found = std::find(info.samplers.begin(), end, name);
    const auto slot = static_cast<std::uint32_t>(found - info.samplers.begin());
${checks}
    return slot;
}
`;
}
