import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import { soleBindingName } from "../compiler/syntax.js";

const module = "src/effect/effect-renderer.ts";

/**
 * `disposeEffectWrapper` and the bind-group build that observes it.
 *
 * Generation settled the module, its layout and the pipeline state
 * (`upstream::effect_variants`), and each backend pass owns the GPU objects
 * a draw binds, so a wrapper record's state is its slots: the uniform slots
 * (`uniform_slots_released`) and the texture slots (`textures`). Disposal
 * empties both. The pin rebuilds its dirty bind group before the next draw,
 * where a released slot throws; every native effect draw runs that build
 * first (`require_effect_bind_group`), so a backend pass never binds the
 * storage the pin destroyed. Without `disposal`, only the bind-group build
 * is emitted, for a live task record (`buildFrameGraphTask`).
 */
export function lowerEffectWrapperDisposal(
    context: LoweringContext,
    disposal = true,
): string {
    const dispose = context.functionDeclaration(
        module,
        "disposeEffectWrapper",
    ).declaration;
    context.assertStatementShapes(
        dispose.body!,
        dispose.body!.statements,
        `
        const internal = wrapper as EffectWrapperInternal;
        for (const slot of internal._uniforms) {
            slot.buffer.destroy();
        }
        internal._uniforms.length = 0;
        internal._textures.length = 0;
        internal._pipelines?.clear();
        internal._pipelines = null;
        internal._shader = null;
        internal._bindGroupLayout = null;
        internal._pipelineLayout = null;
        internal._bindGroup = null;
        internal._bindGroupDirty = true;
    `,
        "Effect wrapper disposal",
    );
    // The single-payload arm's slot test, which the native setter shares.
    const uniforms = context.functionDeclaration(
        module,
        "setEffectUniforms",
    ).declaration;
    context.assertExpressionShape(
        context.variableInitializer(uniforms, "slot"),
        "internal._uniforms[0]",
        "First uniform slot",
    );
    const { file, declaration: group } = context.functionDeclaration(
        module,
        "getEffectBindGroup",
    );
    const [declared, empty, cached] = group.body!.statements;
    context.assertStatementShapes(
        group.body!,
        [declared!, empty!, cached!],
        `
        const bindings = wrapper.options.bindings ?? [];
        if (bindings.length === 0) {
            return null;
        }
        if (!wrapper._bindGroupDirty && wrapper._bindGroup) {
            return wrapper._bindGroup;
        }
    `,
        "Effect bind-group reuse",
    );
    context.assertExpressionShape(
        context.variableInitializer(group, "entries"),
        "bindings.slice().sort((a, b) => a.binding - b.binding).map((layout) => bindGroupEntry(wrapper, layout))",
        "Effect bind-group entries in binding order",
    );
    const prepare = context.functionDeclaration(
        module,
        "prepareEffectRenderer",
    ).declaration;
    context.assertStatementShapes(
        prepare.body!,
        prepare.body!.statements,
        `
        er._pipeline ??= getEffectPipeline(er._effect, er._targetSignature);
        er._bindGroup = getEffectBindGroup(er._effect);
    `,
        "Effect renderer preparation",
    );
    const entry = context.functionDeclaration(
        module,
        "bindGroupEntry",
    ).declaration;
    const bindings = new Map<string, PinnedBinding>([
        [
            "bindings.length",
            {
                cpp: "static_cast<double>(entry.binding_count)",
                type: "scalar",
            },
        ],
        ["wrapper.name", { cpp: "entry.name", type: "opaque" }],
        ["layout.binding", { cpp: "layout.binding", type: "scalar" }],
    ]);
    const kinds = new Map([
        ['layout.kind === "uniform"', "uniform"],
        ['layout.kind === "texture"', "texture"],
    ]);
    const guard = lowerPinnedBody(file, [empty!], {
        bindings,
        calls: new Map(),
        // No group to build: the pass binds none.
        statement: (node, _lowerer, indent) =>
            ts.isReturnStatement(node) ? [`${indent}return;`] : undefined,
    });
    const entries = lowerPinnedBody(
        file,
        entry.body!.statements,
        {
            bindings,
            calls: new Map(),
            expression(node) {
                for (const [shape, kind] of kinds)
                    if (context.expressionMatchesShape(node, shape))
                        return `(layout.kind == upstream::EffectBindingKind::${kind})`;
                return undefined;
            },
            statement(node, lowerer, indent) {
                // The entry itself is the backend pass's; the build only
                // goes on to the next declared binding.
                if (ts.isReturnStatement(node))
                    return node === entry.body!.statements.at(-1)
                        ? []
                        : [`${indent}continue;`];
                if (!ts.isVariableStatement(node)) return undefined;
                const [local] = node.declarationList.declarations;
                if (
                    node.declarationList.declarations.length !== 1 ||
                    !local?.initializer ||
                    !ts.isIdentifier(local.name)
                )
                    return context.contractError(
                        node,
                        "Expected one effect slot lookup.",
                    );
                const initializer = local.initializer;
                // The slot's texture is set (`setEffectTexture`).
                const textureSet = (cpp: string): void => {
                    for (const read of context.findNodes(
                        node.parent,
                        (candidate): candidate is ts.PropertyAccessExpression =>
                            ts.isPropertyAccessExpression(candidate) &&
                            context.expressionMatchesShape(
                                candidate,
                                `${soleBindingName(local.name)}?.texture`,
                            ),
                    ))
                        lowerer.bindLocal(read, {
                            cpp: `(${cpp} && ${cpp}->set)`,
                            type: "bool",
                        });
                };
                if (
                    context.expressionMatchesShape(
                        initializer,
                        "findUniformSlot(wrapper, layout.binding)",
                    )
                ) {
                    lowerer.bindLocal(local.name, {
                        cpp: "uniform_slot",
                        type: "bool",
                    });
                    return [
                        `${indent}const bool uniform_slot = !wrapper.uniform_slots_released;`,
                    ];
                }
                if (
                    context.expressionMatchesShape(
                        initializer,
                        "findTextureSlot(wrapper, layout.binding)",
                    )
                ) {
                    textureSet("texture_slot");
                    return [
                        `${indent}const EffectTextureSlot* texture_slot = effect_texture_slot(wrapper, texture_ordinal);`,
                    ];
                }
                context.assertExpressionShape(
                    initializer,
                    "layout.textureBinding != null ? findTextureSlot(wrapper, layout.textureBinding) : wrapper._textures[0]",
                    "Sampler texture slot",
                );
                // Generation resolved the sampler's texture ordinal by the
                // pin's own `textureBinding` lookup (`compileBindings`).
                textureSet("sampled_slot");
                return [
                    `${indent}const EffectTextureSlot* sampled_slot = effect_texture_slot(wrapper, layout.texture);`,
                ];
            },
        },
        "        ",
    );
    const disposeSource = `// ${context.provenance(module, "disposeEffectWrapper")}
void dispose_effect_wrapper(Engine& engine, EffectWrapperHandle effect) {
    EffectWrapperRecord& wrapper = ${recordAt("engine.effect_wrappers", "effect")};
    // \`_uniforms\`: the backend pass owns each slot's storage and binds it
    // only after require_effect_bind_group finds the slot.
    wrapper.uniform_slots_released = true;
    std::vector<float>().swap(wrapper.uniform_values);
    // \`_textures\`.
    wrapper.textures.clear();
    // The shader module, layouts and pipelines were settled at generation;
    // the next draw rebuilds the group (\`_bindGroupDirty\`).
}

`;
    const storageSource = `// ${context.provenance(module, "prepareEffectRenderer")}
// A registered renderer draws the group it built at registration, which
// binds the uniform storage disposal destroyed: the pin submits destroyed
// buffers, which is not represented. Texture slots keep their images.
void require_effect_renderer_storage(const Engine& engine, EffectWrapperHandle effect) {
    const EffectWrapperRecord& wrapper = ${recordAt("engine.effect_wrappers", "effect")};
    if (!wrapper.uniform_slots_released) return;
    const upstream::EffectVariantEntry& entry = upstream::effect_variants.at(wrapper.variant);
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        if (upstream::effect_variant_bindings.at(entry.first_binding + index).kind ==
            upstream::EffectBindingKind::uniform)
            throw std::runtime_error("EffectRenderer '" + std::string(entry.name) +
                                     "' draws a wrapper whose uniform buffer disposeEffectWrapper destroyed.");
    }
}

`;
    return `${disposal ? disposeSource : ""}static const EffectTextureSlot* effect_texture_slot(const EffectWrapperRecord& wrapper, std::size_t ordinal) {
    return ordinal < wrapper.textures.size() ? &wrapper.textures[ordinal] : nullptr;
}

${disposal ? storageSource : ""}// ${context.provenance(module, "getEffectBindGroup", `${module}#bindGroupEntry`)}
void require_effect_bind_group(const Engine& engine, EffectWrapperHandle effect) {
    const EffectWrapperRecord& wrapper = ${recordAt("engine.effect_wrappers", "effect")};
    const upstream::EffectVariantEntry& entry = upstream::effect_variants.at(wrapper.variant);
${guard}
    std::size_t textures_before = 0;
    // The rows are in binding order (\`compileBindings\` sorts them), and
    // creation made one texture slot per texture row, in that order.
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::EffectVariantBinding& layout =
            upstream::effect_variant_bindings.at(entry.first_binding + index);
        [[maybe_unused]] const std::size_t texture_ordinal = textures_before;
        if (layout.kind == upstream::EffectBindingKind::texture) ++textures_before;
${entries}
    }
}
`;
}
