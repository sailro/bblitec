import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

/** The native shadow hook is fixed; retain the pin's wrapper state beside it. */
export function lowerShadowEnabled(context: LoweringContext): string {
    const module = "src/shadow/shadow-enabled.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "setShadowGeneratorEnabled",
    );
    const statements = declaration.body!.statements;
    const install = statements[1];
    context.assertExpressionShape(
        context.variableInitializer(declaration, "state"),
        "generator._runtimeEnabledState",
        "Shadow enable state",
    );
    if (
        !install ||
        !ts.isIfStatement(install) ||
        !ts.isBlock(install.thenStatement)
    )
        return context.contractError(
            declaration,
            "Expected shadow enable wrapper installation.",
        );
    context.assertExpressionShape(
        install.expression,
        "!state",
        "Shadow enable installation guard",
    );
    const state = context.unwrapExpression(
        context.variableInitializer(install.thenStatement, "installedState"),
    );
    if (!ts.isObjectLiteralExpression(state))
        return context.contractError(
            state,
            "Expected shadow enable state record.",
        );
    const property = (name: string) => {
        const field = state.properties.find(
            (entry): entry is ts.PropertyAssignment =>
                ts.isPropertyAssignment(entry) &&
                entry.name.getText(file) === name,
        );
        if (!field)
            return context.contractError(
                state,
                `Missing shadow enable state ${name}.`,
            );
        return field.initializer;
    };
    context.assertExpressionShape(
        property("uploadData"),
        "new F32(1)",
        "Shadow enable upload extent",
    );
    context.assertExpressionShape(
        context.variableInitializer(install.thenStatement, "renderShadowMap"),
        "generator._renderShadowMap",
        "Original shadow render hook",
    );
    const render = context.unwrapExpression(
        context.variableInitializer(install.thenStatement, "renderWhenEnabled"),
    );
    if (!ts.isArrowFunction(render) || ts.isBlock(render.body))
        return context.contractError(
            render,
            "Expected shadow enable render wrapper.",
        );
    context.assertExpressionShape(
        render.body,
        "syncShadowGeneratorEnabled(engine, generator, taskState, installedState) ? installedState.renderShadowMap(engine, taskState) : 0",
        "Shadow enable render gate",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["state.enabled", { cpp: "*generator.runtime_enabled", type: "bool" }],
        ["enabled", { cpp: "enabled", type: "bool" }],
        [
            "generator._version",
            { cpp: "generator.runtime_enabled_version", type: "scalar" },
        ],
    ]);
    const initial = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map(),
    }).expression(property("enabled"));
    const setter = lowerPinnedBody(file, statements.slice(2), {
        bindings,
        calls: new Map(),
    });
    const sync = context.functionDeclaration(
        module,
        "syncShadowGeneratorEnabled",
    );
    const syncBindings = new Map<string, PinnedBinding>([
        ...bindings,
        [
            "state.uploadedEnabled",
            { cpp: "state.uploaded_enabled", type: "opaque" },
        ],
        ["state.uploadedUbo", { cpp: "state.uploaded_ubo", type: "opaque" }],
        ["generator._shadowUBO", { cpp: "receiver_identity", type: "opaque" }],
        [
            "state.uploadData",
            { cpp: "state.upload_data", type: "f32", mutable: true },
        ],
        [
            "csmData",
            {
                cpp: "(*receiver_data)",
                type: "f32",
                mutable: true,
                absentCpp: "!receiver_data",
            },
        ],
        [
            "callbacks",
            {
                cpp: "receiver_callbacks",
                type: "opaque",
                absentCpp: "!receiver_callbacks",
            },
        ],
    ]);
    context.assertExpressionShape(
        context.variableInitializer(sync.declaration, "csmData"),
        "(taskState as ShadowTaskInternalState & { _uboData?: Float32Array })._uboData",
        "CSM receiver data transport",
    );
    context.assertExpressionShape(
        context.variableInitializer(sync.declaration, "callbacks"),
        "generator._onReceiverData",
        "CSM receiver callback transport",
    );
    const sourceExpression = (node: ts.Expression): string | undefined => {
        if (context.expressionMatchesShape(node, "generator._shadowsInfo[0]!"))
            return "generator.darkness";
        if (
            context.expressionMatchesShape(
                node,
                'generator._shadowType === "csm"',
            )
        )
            return "(generator.filter == ShadowFilter::csm_directional)";
        return undefined;
    };
    const synchronization = lowerPinnedBody(
        sync.file,
        sync.declaration.body!.statements,
        {
            bindings: syncBindings,
            calls: new Map([
                [
                    "engine._device.queue.writeBuffer",
                    (args: readonly string[]) => `upload(${args.join(", ")})`,
                ],
            ]),

            foldConditions: false,
            returnValue: (expression, lowerer) =>
                expression
                    ? lowerer.expression(expression)
                    : context.contractError(
                          sync.declaration,
                          "Shadow synchronization must return its enabled state.",
                      ),
            expression(node, lowerer) {
                if (
                    ts.isCallExpression(node) &&
                    context.expressionMatchesShape(
                        node.expression,
                        "callbacks[index]!",
                    )
                )
                    return `callback(${node.arguments.map((argument) => lowerer.expression(argument)).join(", ")})`;
                return sourceExpression(node);
            },
            statement(node, lowerer, indent) {
                if (
                    ts.isVariableStatement(node) &&
                    node.declarationList.declarations.length === 1
                ) {
                    const name =
                        node.declarationList.declarations[0]!.name.getText(
                            sync.file,
                        );
                    if (name === "csmData")
                        return [
                            `${indent}auto receiver_data = read_receiver_data();`,
                        ];
                    if (name === "callbacks")
                        return [
                            `${indent}const auto receiver_callbacks = read_receiver_callbacks();`,
                        ];
                }
                if (!ts.isForStatement(node)) return undefined;
                context.assertStatementShapes(
                    node,
                    [node],
                    "for (let index = 0; index < callbacks.length; index++) { callbacks[index]!(csmData); }",
                    "CSM receiver callback traversal",
                );
                // The existing retained subscription transport owns iteration; lower the
                // source callback body at its original point in the synchronization body.
                return [
                    `${indent}receiver_callbacks->dispatch_with([&](auto& callback, const js::F32Array&) {`,
                    ...lowerer.statements(
                        ts.isBlock(node.statement)
                            ? node.statement.statements
                            : [node.statement],
                        indent + "    ",
                    ),
                    `${indent}}, (*receiver_data));`,
                ];
            },
        },
    );
    const returns = context.findNodes(
        sync.declaration,
        (node): node is ts.ReturnStatement => ts.isReturnStatement(node),
    );
    for (const returned of returns) {
        if (!returned.expression)
            return context.contractError(
                returned,
                "Expected shadow enable gate result.",
            );
        context.assertExpressionShape(
            returned.expression,
            "state.enabled",
            "Shadow enabled gate return",
        );
    }
    return `// ${context.provenance(module, "setShadowGeneratorEnabled,syncShadowGeneratorEnabled")}
inline void set_shadow_generator_enabled(Engine& engine, ShadowGeneratorHandle handle, bool enabled) {
    auto& generator = ${recordAt("engine.shadow_generators", "handle")};
    if (!generator.runtime_enabled) generator.runtime_enabled = ${initial};
${setter}
}

struct ShadowEnabledUploadState {
    std::optional<bool> uploaded_enabled;
    std::optional<std::uint64_t> uploaded_ubo;
    std::array<float, 1> upload_data{};
};

/** Source synchronization protocol; the PAL supplies allocation and callback transport. */
template<class ReceiverData, class ReceiverCallbacks, class Upload>
inline bool synchronize_shadow_enabled(ShadowGeneratorRecord& generator, ShadowEnabledUploadState& state,
                                      std::uint64_t receiver_identity, ReceiverData&& read_receiver_data,
                                      ReceiverCallbacks&& read_receiver_callbacks, Upload&& upload) {
    if (!generator.runtime_enabled) return true;
${synchronization}
}
`;
}
