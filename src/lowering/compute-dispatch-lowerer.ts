import ts from "typescript";
import {
    type LoweredSource,
    type LoweringContext,
    unwrapExpression,
} from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { pinnedRecordLiteral } from "./pinned-record-literal.js";
import { computeDispatchDescriptorCpp } from "./compute-dispatch-descriptor.js";

const path = "src/compute/compute-dispatch.ts";
const methods = {
    _createComputeDispatch: [
        "create_compute_dispatch_state",
        "std::shared_ptr<ComputeDispatch>",
        "const std::shared_ptr<ComputeShader>& shader,const std::shared_ptr<ComputeBindingSet>& bindings,std::optional<bool> enabled_input",
    ],
    createComputeDispatch: [
        "create_compute_dispatch",
        "std::shared_ptr<ComputeDispatch>",
        "const std::shared_ptr<ComputeShader>& shader,const std::shared_ptr<ComputeBindingSet>& bindings,const ComputeDispatchOptions& options",
    ],
    setComputeDispatchSize: [
        "set_compute_dispatch_size",
        "void",
        "const std::shared_ptr<ComputeDispatch>& dispatch,const ComputeDispatchSize& size",
    ],
    setComputeDispatchDynamicOffset: [
        "set_compute_dispatch_dynamic_offset",
        "void",
        "const std::shared_ptr<ComputeDispatch>& dispatch,const std::string& bindingName,double byteOffset",
    ],
} as const;
function scope(
    context: LoweringContext,
    file: ts.SourceFile,
): PinnedNumericScope {
    const bindings = new Map<string, PinnedBinding>();
    for (const name of [
        "shader",
        "bindings",
        "dispatch",
        "options",
        "size",
        "bindingName",
    ])
        bindings.set(name, { cpp: name, type: "opaque" });
    bindings.set("enabled", { cpp: "enabled", type: "bool" });
    bindings.set("byteOffset", { cpp: "byteOffset", type: "scalar" });
    bindings.set("bindings.shader", {
        cpp: "bindings->shader",
        type: "opaque",
    });
    bindings.set("dispatch.shader", {
        cpp: "dispatch->shader",
        type: "opaque",
    });
    bindings.set("dispatch._record", {
        cpp: "dispatch->record",
        type: "opaque",
    });
    bindings.set("options.enabled", { cpp: "options.enabled", type: "opaque" });
    bindings.set("options.size", { cpp: "options.size", type: "opaque" });
    bindings.set("slot", {
        cpp: "slot",
        type: "opaque",
        absentCpp: "!slot.has_value()",
    });
    for (const [source, field] of Object.entries({
        _group: "group",
        _index: "index",
        _alignment: "alignment",
        _maxOffset: "max_offset",
    }))
        bindings.set(`slot.${source}`, {
            cpp: `slot->${field}`,
            type: "scalar",
        });
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "_assertComputeShaderLive",
            (args) => `assert_compute_shader_live(${args.join(", ")})`,
        ],
        [
            "Number.isInteger",
            (args) => `js::number_is_integer(${args.join(", ")})`,
        ],
        [
            "setDirect",
            (args) =>
                `${args[0]}->dimensions = compute_dispatch_dimensions(${args[1]}.x, ${args[1]}.y, ${args[1]}.z, ${args[0]}->shader->device->compute_shader_limits().max_compute_workgroups_per_dimension.value_or(std::numeric_limits<double>::quiet_NaN()))`,
        ],
    ]);
    for (const [name, [cpp]] of Object.entries(methods))
        calls.set(name, (args) => `${cpp}(${args.join(", ")})`);
    return {
        bindings,
        calls,

        foldConditions: false,
        callShapes: new Map([["Number.isInteger", "bool"]]),
        expression(node, lowerer) {
            if (ts.isObjectLiteralExpression(node))
                return `js::make_gc_shared<ComputeDispatch>(${pinnedRecordLiteral(context, lowerer, node, { cpp: "ComputeDispatch", fields: { shader: { cpp: "shader" }, bindings: { cpp: "bindings" }, enabled: { cpp: "enabled" }, _x: { cpp: "dimensions[0]" }, _y: { cpp: "dimensions[1]" }, _z: { cpp: "dimensions[2]" } } })})`;
            if (
                node.kind === ts.SyntaxKind.UndefinedKeyword ||
                (ts.isIdentifier(node) && node.text === "undefined")
            )
                return "{}";
            return undefined;
        },
        statement(node, lowerer, indent) {
            if (
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1
            ) {
                const declaration = node.declarationList.declarations[0]!;
                if (
                    !ts.isIdentifier(declaration.name) ||
                    !declaration.initializer
                )
                    return undefined;
                const name = declaration.name.text,
                    initializer = unwrapExpression(declaration.initializer);
                if (name === "dispatch")
                    return [
                        `${indent}const auto dispatch = ${lowerer.expression(initializer)};`,
                    ];
                if (name === "slot") {
                    context.assertExpressionShape(
                        initializer,
                        "dispatch.bindings._dynamicSlots?.get(bindingName)",
                        "Compute dynamic slot lookup",
                    );
                    return [
                        `${indent}std::optional<ComputeDynamicBindingSlot> slot;`,
                        `${indent}if (dispatch->bindings->dynamic_slots) { const auto found = dispatch->bindings->dynamic_slots->find(bindingName); if(found != dispatch->bindings->dynamic_slots->end()) slot = found->second; }`,
                    ];
                }
                if (name === "offsets") {
                    if (
                        !ts.isBinaryExpression(initializer) ||
                        initializer.operatorToken.kind !==
                            ts.SyntaxKind.QuestionQuestionEqualsToken
                    )
                        return context.contractError(
                            initializer,
                            "Expected retained compute dynamic offset allocation.",
                        );
                    context.assertExpressionShape(
                        initializer.left,
                        "dispatch._dynamicOffsets",
                        "Retained dynamic offset arrays",
                    );
                    const map = initializer.right;
                    if (
                        !ts.isCallExpression(map) ||
                        !ts.isPropertyAccessExpression(map.expression) ||
                        map.expression.name.text !== "map" ||
                        map.arguments.length !== 1 ||
                        !ts.isArrowFunction(map.arguments[0]!)
                    )
                        return context.contractError(
                            map,
                            "Expected dynamic count map.",
                        );
                    context.assertExpressionShape(
                        map.expression.expression,
                        "dispatch.shader._dynamicCounts",
                        "Compute dynamic counts",
                    );
                    const callback = map.arguments[0];
                    if (
                        callback.parameters.length !== 1 ||
                        callback.parameters[0]!.name.getText(file) !==
                            "count" ||
                        ts.isBlock(callback.body)
                    )
                        return context.contractError(
                            callback,
                            "Expected dynamic count parameter.",
                        );
                    context.assertExpressionShape(
                        callback.body,
                        "new Array<number>(count).fill(0)",
                        "Initialized compute dynamic offsets",
                    );
                    return [
                        `${indent}if(!dispatch->dynamic_offsets) { dispatch->dynamic_offsets.emplace(); for(const auto count:dispatch->shader->dynamic_counts) { ComputeOffsets values(static_cast<std::size_t>(count),0.0); dispatch->dynamic_offsets->push_back(values); } }`,
                        `${indent}auto& offsets = *dispatch->dynamic_offsets;`,
                    ];
                }
            }
            if (
                ts.isExpressionStatement(node) &&
                ts.isBinaryExpression(node.expression) &&
                node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ) {
                const assignment = node.expression;
                if (
                    context.expressionMatchesShape(
                        assignment.left,
                        "offsets[slot._group]![slot._index]",
                    )
                )
                    return [
                        `${indent}(*offsets[static_cast<std::size_t>(slot->group)])[static_cast<std::size_t>(slot->index)] = ${lowerer.expression(assignment.right)};`,
                    ];
            }
            return undefined;
        },
    };
}
export function lowerComputeDispatch(context: LoweringContext): LoweredSource {
    const output = [computeDispatchDescriptorCpp(context)];
    for (const [name, [cpp, result, parameters]] of Object.entries(methods)) {
        const module =
            name === "setComputeDispatchDynamicOffset"
                ? "src/compute/compute-dynamic-offset.ts"
                : path;
        const { file, declaration } = context.functionDeclaration(module, name);
        let prefix = "";
        if (name === "_createComputeDispatch") {
            const fallback = declaration.parameters[2]?.initializer;
            if (
                !fallback ||
                ![
                    ts.SyntaxKind.TrueKeyword,
                    ts.SyntaxKind.FalseKeyword,
                ].includes(fallback.kind)
            )
                return context.contractError(
                    declaration,
                    "Expected compute enabled default.",
                );
            prefix = `const bool enabled = enabled_input.value_or(${fallback.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false"});\n`;
        }
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            ...scope(context, file),
            returnValue: (node, lowerer) =>
                node ? lowerer.expression(node) : "",
        });
        output.push(
            `// ${context.provenance(module, name)}\n${name.startsWith("_") ? "static " : ""}${result} ${cpp}(${parameters}){\n${prefix}${body}\n}`,
        );
    }
    return {
        modulePath: path,
        symbolName: "createComputeDispatch",
        header: "",
        source: `#include <bblite/pal_compute_dispatch.hpp>\nnamespace bbl {\n${output.join("\n")}\n}\n`,
    };
}
