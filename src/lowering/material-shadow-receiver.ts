import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

/** Project the pin's shadow-light collection to its observed length. */
export function materialShadowReceiverCpp(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        "src/material/pbr/pbr-renderable.ts",
        "buildPbrRenderables",
    );
    const statements = declaration.body!.statements;
    const index = statements.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (entry) =>
                    ts.isIdentifier(entry.name) &&
                    entry.name.text === "shadowLights",
            ),
    );
    const collection = statements[index];
    const loop = statements[index + 1];
    if (
        !collection ||
        !ts.isVariableStatement(collection) ||
        !loop ||
        !ts.isForStatement(loop)
    )
        return context.contractError(
            declaration,
            "Expected the shadow-light collection and traversal.",
        );
    context.assertExpressionShape(
        collection.declarationList.declarations[0]!.initializer!,
        "[]",
        "Shadow-light collection",
    );
    const bindings = new Map<string, PinnedBinding>([
        [
            "scene.lights.length",
            { cpp: "static_cast<double>(scene.lights.size())", type: "scalar" },
        ],
        [
            "scene.lights[i]!.shadowGenerator",
            {
                cpp: `(${recordAt("engine.lights", "scene.lights[static_cast<std::size_t>(i)]")}.shadow_generator.value != invalid_handle)`,
                type: "bool",
            },
        ],
        ["shadowLights.length", { cpp: "shadow_count", type: "scalar" }],
    ]);
    const body = lowerPinnedBody(file, [loop], {
        bindings,
        calls: new Map(),
        statement(node) {
            if (
                !ts.isExpressionStatement(node) ||
                !ts.isCallExpression(node.expression)
            )
                return undefined;
            const call = node.expression;
            if (
                !ts.isPropertyAccessExpression(call.expression) ||
                call.expression.expression.getText(file) !== "shadowLights" ||
                call.expression.name.text !== "push"
            )
                return undefined;
            if (call.arguments.length !== 1)
                return context.contractError(
                    call,
                    "Expected one shadow-light record.",
                );
            context.assertExpressionShape(
                call.arguments[0]!,
                "{lightIndex: i, shadowType: sg._shadowType, gen: sg}",
                "Shadow-light record",
            );
            return ["++shadow_count;"];
        },
    });
    const hasSome = context.variableInitializer(file, "hasSomeShadows");
    const receive = context.variableInitializer(file, "receiveShadows");
    context.assertExpressionShape(
        context.variableInitializer(
            context.sourceFile("src/material/standard/standard-renderable.ts"),
            "receiveShadows",
        ),
        "!shadowOutput && mesh.receiveShadows && rc._hasSomeShadows",
        "Standard shadow receiver predicate",
    );
    const lowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map(),
    });
    const hasSomeCpp = lowerer.expression(hasSome);
    bindings.set("shadowOutput", { cpp: "shadow_output", type: "bool" });
    bindings.set("mesh.receiveShadows", { cpp: "mesh_receives", type: "bool" });
    bindings.set("hasSomeShadows", { cpp: "has_shadows", type: "bool" });
    return `// ${context.provenance("src/material/pbr/pbr-renderable.ts", "buildPbrRenderables")}
inline bool pinned_scene_has_shadows(const Engine& engine, const Scene& scene) {
    [[maybe_unused]] double shadow_count = 0.0;
${body}
    return ${hasSomeCpp};
}
inline bool pinned_material_receives_shadows(bool shadow_output, bool mesh_receives, bool has_shadows) {
    return ${lowerer.expression(receive)};
}
`;
}
