import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { soleBindingName, propertyPath } from "../compiler/syntax.js";

/**
 * An expression hook lowering shader-renderable.ts's inactive-packet test,
 * `isPacketInactive(<packet>, material, isOverride)`, over the caller's
 * bindings of its three parameters: every caller passes its own material and
 * override, which are the parameters' names, and one of `packets`, the names
 * the caller binds to the packet the native invocation transports.
 */
export function shaderPacketInactiveHook(
    context: LoweringContext,
    bindings: Map<string, PinnedBinding>,
    packets: readonly string[] = ["packet"],
): (node: ts.Expression) => string | undefined {
    const inactive = context.functionDeclaration(
        "src/material/shader/shader-renderable.ts",
        "isPacketInactive",
    );
    const parameters = inactive.declaration.parameters.map((parameter) =>
        soleBindingName(parameter.name),
    );
    if (parameters.join(",") !== "packet,material,isOverride")
        return context.contractError(
            inactive.declaration,
            "Expected the inactive-packet test over a packet, its material and the override.",
        );
    const test = inactive.declaration.body!.statements[0];
    if (
        inactive.declaration.body!.statements.length !== 1 ||
        !test ||
        !ts.isReturnStatement(test) ||
        !test.expression
    )
        return context.contractError(
            inactive.declaration,
            "Expected the inactive-packet test's one return.",
        );
    // Lowered at the first call site: a caller whose source never tests the
    // packet need not bind the test's operands.
    const tested = test.expression;
    let inactiveCpp: string | undefined;
    return (node) => {
        if (
            !packets.some((packet) =>
                context.expressionMatchesShape(
                    node,
                    `isPacketInactive(${packet}, material, isOverride)`,
                ),
            )
        )
            return undefined;
        inactiveCpp ??= new PinnedNumericLowerer(inactive.file, {
            bindings,
            calls: new Map(),
        }).expression(tested);
        return inactiveCpp;
    };
}

/** One native candidate transports one packet of the pin's bound shader update. */
export function lowerShaderBindingUpdate(context: LoweringContext): string {
    const module = "src/material/shader/shader-renderable.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "createShaderRenderable",
    );
    // A transparent renderable wraps exactly one packet (the pin builds it
    // over `[packet]`), so `first` is the packet a native invocation carries
    // whenever the sort center that selects its test exists.
    context.assertExpressionShape(
        context.variableInitializer(declaration, "first"),
        "packets[0]!",
        "Shader renderable leading packet",
    );
    context.assertExpressionShape(
        context.variableInitializer(declaration, "sortCenter"),
        "transparent ? [0, 0, 0] : undefined",
        "Transparent shader sort center",
    );
    const update = context.variableInitializer(declaration, "update");
    if (!ts.isArrowFunction(update) || !ts.isBlock(update.body))
        return context.contractError(
            update,
            "Expected a shader binding update closure.",
        );
    const statements = update.body.statements;
    context.assertStatementShapes(
        update,
        statements,
        `
        if (sortCenter && isPacketInactive(first, material, isOverride)) { return; }
        updateCustomUbo(scene.surface.engine, material, uniformBatch);
        for (const packet of packets) {
            if (isPacketInactive(packet, material, isOverride)) { continue; }
            updatePacket(scene, material, packet, context, uniformBatch);
        }
        syncSortCenter();`,
        "Shader binding update order",
    );
    const loop = statements[2]!;
    if (!ts.isForOfStatement(loop) || !ts.isBlock(loop.statement))
        return context.contractError(
            loop,
            "Expected the shader binding's packet iteration.",
        );
    const bindings = new Map<string, PinnedBinding>([
        ["sortCenter", { cpp: "transparent", type: "bool" }],
        ["packet._disposed", { cpp: "disposed", type: "bool" }],
        // The native draw guard already includes the override arm.
        ["isOverride", { cpp: "false", type: "bool" }],
        ["packet.mesh.material", { cpp: "material_matches", type: "bool" }],
        ["material", { cpp: "true", type: "bool" }],
    ]);
    // The trailing sort-center sync is not lowered: the native transparent
    // sort reads the mesh world matrix itself.
    const body = lowerPinnedBody(
        file,
        [statements[0]!, statements[1]!, ...loop.statement.statements],
        {
            bindings,
            calls: new Map(),
            expression: shaderPacketInactiveHook(context, bindings, [
                "packet",
                "first",
            ]),
            statement(node, _lowerer, indent) {
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isCallExpression(node.expression)
                ) {
                    const target = propertyPath(
                        node.expression.expression,
                    )?.join(".");
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
        "    ",
    );
    return `// ${context.provenance(module, "createShaderRenderable")}
template<class Custom, class System>
void update_shader_binding(bool transparent, bool disposed, bool material_matches,
    Custom&& update_custom, System&& update_system) {
${body}
}
`;
}
