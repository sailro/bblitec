import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

/** One native candidate transports one packet of the pin's bound shader update. */
export function lowerShaderBindingUpdate(context: LoweringContext): string {
    const module = "src/material/shader/shader-renderable.ts";
    const closure = (name: string) => {
        const { file, declaration } = context.functionDeclaration(module, name);
        const update = context.variableInitializer(declaration, "update");
        if (!ts.isArrowFunction(update) || !ts.isBlock(update.body))
            return context.contractError(
                update,
                "Expected a shader binding update closure.",
            );
        return { file, update, statements: update.body.statements };
    };
    const opaque = closure("createOpaqueRenderable");
    context.assertStatementShapes(
        opaque.update,
        opaque.statements,
        `
        updateCustomUbo(scene.surface.engine, material, uniformBatch);
        for (const packet of packets) {
            if (packet._disposed || (!isOverride && packet.mesh.material !== material)) { continue; }
            updatePacket(scene, material, packet, context, uniformBatch);
        }`,
        "Opaque shader binding update order",
    );
    const loop = opaque.statements[1]!;
    if (!ts.isForOfStatement(loop) || !ts.isBlock(loop.statement))
        return context.contractError(
            loop,
            "Expected the opaque binding's packet iteration.",
        );
    const transparent = closure("createTransparentRenderable");
    const transparentUpdates = transparent.statements.slice(0, 3);
    context.assertStatementShapes(
        transparent.update,
        transparentUpdates,
        `
        if (packet._disposed || (!isOverride && packet.mesh.material !== material)) { return; }
        updateCustomUbo(scene.surface.engine, material, uniformBatch);
        updatePacket(scene, material, packet, context, uniformBatch);`,
        "Transparent shader binding update order",
    );
    const lower = (file: ts.SourceFile, statements: readonly ts.Statement[]) =>
        lowerPinnedBody(
            file,
            statements,
            {
                bindings: new Map<string, PinnedBinding>([
                    ["packet._disposed", { cpp: "disposed", type: "bool" }],
                    // The native draw guard already includes the override arm.
                    ["isOverride", { cpp: "false", type: "bool" }],
                    [
                        "packet.mesh.material",
                        { cpp: "material_matches", type: "bool" },
                    ],
                    ["material", { cpp: "true", type: "bool" }],
                ]),
                calls: new Map(),
                statement(node, _lowerer, indent) {
                    if (
                        ts.isExpressionStatement(node) &&
                        ts.isCallExpression(node.expression)
                    ) {
                        const target = node.expression.expression.getText(file);
                        if (target === "updateCustomUbo")
                            return [`${indent}update_custom();`];
                        if (target === "updatePacket")
                            return [`${indent}update_system();`];
                    }
                    // Each invocation represents one packet, so the source loop's continue finishes it.
                    return ts.isContinueStatement(node)
                        ? [`${indent}return;`]
                        : undefined;
                },
            },
            "        ",
        );
    return `// ${context.provenance(module, "createOpaqueRenderable, createTransparentRenderable")}
template<class Custom, class System>
void update_shader_binding(bool transparent, bool disposed, bool material_matches,
    Custom&& update_custom, System&& update_system) {
    if (transparent) {
${lower(transparent.file, transparentUpdates)}
    } else {
${lower(opaque.file, [opaque.statements[0]!, ...loop.statement.statements])}
    }
}
`;
}
