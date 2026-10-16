import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/** Stored shader services select the storage slot from the runtime material. */
export function lowerShaderStorageNameBinding(
    context: LoweringContext,
): string {
    const module = "src/material/shader/shader-material.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "setShaderStorageBuffer",
    );
    const statements = declaration.body!.statements;
    context.assertStatementShapes(
        declaration,
        statements.slice(0, 1),
        "const slot = material._storageBufferSlots.get(name);",
        "Shader storage slot lookup",
    );
    context.assertStatementShapes(
        declaration,
        statements.slice(-1),
        "if (slot.current !== buffer) { slot.current = buffer; material._resourceVersion++; bumpVisibilityEpoch(); }",
        "Shader storage handle publication",
    );
    const checks = lowerPinnedBody(file, statements.slice(1, -1), {
        bindings: new Map<string, PinnedBinding>([
            ["name", { cpp: "name", type: "string" }],
            [
                "slot",
                {
                    cpp: "found",
                    type: "opaque",
                    absentCpp: "found == slots.end()",
                },
            ],
            ["buffer", { cpp: "buffer", type: "opaque", absentCpp: "false" }],
            [
                "buffer._destroyed",
                {
                    cpp: "(storage != nullptr && storage->disposed)",
                    type: "bool",
                },
            ],
        ]),
        calls: new Map(),
        callShapes: new Map([["buffer._engine._storageBuffers?.has", "bool"]]),
        expression(node) {
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.InKeyword
            ) {
                context.assertExpressionShape(
                    node,
                    '"_engine" in buffer',
                    "Storage owner presence",
                );
                return "true";
            }
            if (
                context.expressionMatchesShape(
                    node,
                    "buffer._engine._storageBuffers?.has(buffer)",
                )
            )
                return "(storage != nullptr && storage->registered)";
            return undefined;
        },
    });
    return `// ${context.provenance(module, "setShaderStorageBuffer")}
void set_shader_storage_buffer_by_name(
    Engine& engine, MaterialHandle material, const std::string& name, StorageBufferHandle buffer) {
    auto& record = shader_material(engine, material);
    const auto& slots = upstream::shader_variant_info(record.shader_variant).storage_buffers;
    const auto found = std::find_if(slots.begin(), slots.end(), [&](const auto& slot) { return name == slot.name; });
    const auto* storage = handle_find(engine.storage_buffers, buffer);
${checks}
    const auto slot = static_cast<std::uint32_t>(found - slots.begin());
    if (record.shader_storage_buffers.size() <= slot || record.shader_storage_buffers[slot] != buffer)
        set_shader_storage_buffer(engine, material, slot, buffer);
}
`;
}
