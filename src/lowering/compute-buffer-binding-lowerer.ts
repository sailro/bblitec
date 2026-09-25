import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import {
    type LoweringContext,
    type LoweredSource,
    unwrapExpression,
} from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    type PinnedRecordSchema,
} from "./pinned-record-literal.js";

const path = "src/compute/compute-buffer-binding.ts";
const bufferHelpers: Record<string, string> = {
    isStorageBuffer: "is_compute_storage_buffer",
    isUniformBuffer: "is_compute_uniform_buffer",
    resolveStorageBuffer: "resolve_compute_storage_buffer",
    resolveUniformBuffer: "resolve_compute_uniform_buffer",
    getStorageBuffer: "get_compute_storage_buffer",
    getUniformBuffer: "get_compute_uniform_buffer",
};
const stateSchema: PinnedRecordSchema = {
    cpp: "ComputeBufferBindingState",
    fields: {
        _buffer: { cpp: "buffer" },
        _offset: { cpp: "offset" },
        _size: { cpp: "size" },
    },
};
const resolvedSchema: PinnedRecordSchema = {
    cpp: "ComputeResolvedBufferBinding",
    fields: {
        _state: { cpp: "state", record: stateSchema },
        _dynamic: {
            cpp: "dynamic",
            record: {
                cpp: "ComputeDynamicBindingInfo",
                fields: {
                    _alignment: { cpp: "alignment" },
                    _maxOffset: { cpp: "max_offset" },
                },
            },
        },
    },
};
function bufferScope(
    context: LoweringContext,
    file: ts.SourceFile,
): PinnedNumericScope {
    const bindings = new Map<string, PinnedBinding>();
    for (const name of [
        "engine",
        "decl",
        "input",
        "resource",
        "state",
        "range",
        "binding",
        "buffer",
        "data",
    ])
        bindings.set(name, { cpp: name, type: "opaque" });
    for (const name of ["minBindingSize", "maxBindingSize", "alignment"])
        bindings.set(name, { cpp: name, type: "scalar" });
    for (const name of ["writable", "dynamic"])
        bindings.set(name, { cpp: name, type: "bool" });
    const fields: Record<string, [string, PinnedBinding["type"]]> = {
        "decl.name": ["decl->name", "opaque"],
        "decl._data": ["decl->data", "opaque"],
        "range.buffer": ["range.buffer", "opaque"],
        "buffer._destroyed": ["buffer->destroyed()", "bool"],
        "buffer._buffer": ["buffer->allocation()", "opaque"],
        "buffer._engine": ["buffer->engine", "opaque"],
        "buffer.byteLength": ["buffer->byte_length()", "scalar"],
        "binding._buffer": ["binding.buffer", "opaque"],
        "binding._offset": ["binding.offset", "scalar"],
        "data.access": ["data.access", "opaque"],
        "data.dynamic": ["data.dynamic", "bool"],
        "data.minSize": ["data.min_size", "scalar"],
        "Number.MAX_SAFE_INTEGER": ["9007199254740991.0", "scalar"],
    };
    for (const [name, [cpp, type]] of Object.entries(fields))
        bindings.set(name, { cpp, type });
    for (const name of [
        "range.offset",
        "range.size",
        "binding._size",
        "size",
    ]) {
        const cpp = name === "binding._size" ? "binding.size" : name;
        bindings.set(name, {
            cpp: `${cpp}.value_or(std::numeric_limits<double>::quiet_NaN())`,
            type: "scalar",
            absentCpp: `!${cpp}.has_value()`,
        });
    }
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "Number.isInteger",
            (args) => `js::number_is_integer(${args.join(", ")})`,
        ],
        ["isExpected", (args) => `isExpected(${args.join(", ")})`],
        ["isWritable", (args) => `isWritable(${args.join(", ")})`],
        ["isRegistered", (args) => `isRegistered(${args.join(", ")})`],
        [
            "_resolveComputeBufferBinding",
            (args) => `resolve_compute_buffer_binding(${args.join(", ")})`,
        ],
        [
            "_getComputeBufferBindingResource",
            (args) => `get_compute_buffer_binding_resource(${args.join(", ")})`,
        ],
    ]);
    return {
        bindings,
        calls,
        booleanOr: true,
        foldConditions: false,
        callShapes: new Map(
            [
                "Number.isInteger",
                "isExpected",
                "isWritable",
                "isRegistered",
            ].map((name) => [name, "bool"]),
        ),
        expression(node, l) {
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (
                context.expressionMatchesShape(
                    node,
                    'typeof buffer !== "object"',
                )
            )
                return "false";
            if (context.expressionMatchesShape(node, "!size"))
                return "(!size.has_value() || !js::number_truthy(size.value()))";
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            ) {
                const left = node.left.getText(file);
                if (["range.offset", "range.size", "size"].includes(left))
                    return `${left}.value_or(${l.expression(node.right)})`;
            }
            if (ts.isObjectLiteralExpression(node))
                return pinnedRecordLiteral(context, l, node, resolvedSchema);
            return undefined;
        },
        statement(node, l, indent) {
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
                    initial = unwrapExpression(declaration.initializer);
                if (name === "range") {
                    context.assertExpressionShape(
                        initial,
                        'typeof input === "object" && input !== null && "buffer" in input ? (input as ComputeBufferRange<ComputeBufferResource>) : {buffer:input as ComputeBufferResource}',
                        "Normalized compute buffer range",
                    );
                    return [`${indent}const auto& range = input;`];
                }
                if (name === "size") {
                    context.assertExpressionShape(
                        initial,
                        "range.size",
                        "Optional compute buffer range size",
                    );
                    return [`${indent}auto size = range.size;`];
                }
                if (["buffer", "binding", "data"].includes(name))
                    return [
                        `${indent}const auto& ${name} = ${l.expression(initial)};`,
                    ];
            }
            if (
                ts.isExpressionStatement(node) &&
                context.expressionMatchesShape(
                    node.expression,
                    "size = minBindingSize || undefined",
                )
            )
                return [
                    `${indent}size = js::number_truthy(minBindingSize) ? std::optional<double>{minBindingSize} : std::nullopt;`,
                ];
            return undefined;
        },
    };
}

export function lowerComputeBufferBinding(
    context: LoweringContext,
): LoweredSource {
    const resolve = context.functionDeclaration(
        path,
        "_resolveComputeBufferBinding",
    );
    const get = context.functionDeclaration(
        path,
        "_getComputeBufferBindingResource",
    );
    const resolveBody = lowerPinnedBody(
        resolve.file,
        resolve.declaration.body!.statements,
        {
            ...bufferScope(context, resolve.file),
            returnValue: (node) => {
                const scope = bufferScope(context, resolve.file);
                scope.bindings.set("size", { cpp: "size", type: "opaque" });
                scope.bindings.set("offset", { cpp: "offset", type: "scalar" });
                scope.bindings.set("boundSize", {
                    cpp: "boundSize",
                    type: "scalar",
                });
                return pinnedRecordLiteral(
                    context,
                    new PinnedNumericLowerer(resolve.file, scope),
                    node!,
                    resolvedSchema,
                );
            },
        },
    );
    const getBody = lowerPinnedBody(
        get.file,
        get.declaration.body!.statements,
        {
            ...bufferScope(context, get.file),
            returnValue: (node) => {
                const schema: PinnedRecordSchema = {
                    cpp: "pal::ComputeBufferResource",
                    fields: {
                        buffer: { cpp: "allocation" },
                        offset: { cpp: "offset" },
                        size: { cpp: "size" },
                    },
                };
                // Native GPU byte positions are integral; source checks establish the range.
                const base = bufferScope(context, get.file);
                base.bindings.set("binding._offset", {
                    cpp: "static_cast<std::size_t>(binding.offset)",
                    type: "opaque",
                });
                base.bindings.set("binding._size", {
                    cpp: "static_cast<std::size_t>(binding.size.value())",
                    type: "opaque",
                    absentCpp: "!binding.size.has_value()",
                });
                // Keep conditional spread predicates on the source optional value.
                return pinnedRecordLiteral(
                    context,
                    new PinnedNumericLowerer(get.file, base),
                    node!,
                    schema,
                );
            },
        },
    );
    return {
        modulePath: path,
        symbolName: "_resolveComputeBufferBinding",
        header: "",
        source: `#include <bblite/pal_compute_buffer_binding.hpp>\nnamespace bbl {\n// ${context.provenance(path, "_resolveComputeBufferBinding")}\nComputeResolvedBufferBinding resolve_compute_buffer_binding(const std::shared_ptr<Engine>& engine,const ComputeBindingDeclPtr& decl,const ComputeBufferRange& input,const ComputeBufferPredicate& isExpected,const ComputeBufferPredicate& isWritable,bool writable,bool dynamic,double minBindingSize,double maxBindingSize,double alignment){\n${resolveBody}\n}\n// ${context.provenance(path, "_getComputeBufferBindingResource")}\npal::ComputeBufferResource get_compute_buffer_binding_resource(const std::shared_ptr<Engine>& engine,const ComputeBufferBindingState& state,const ComputeBufferMembership& isRegistered){\n${getBody}\n}\n${lowerBufferHelpers(context)}\n}\n`,
    };
}

function lowerBufferHelpers(context: LoweringContext): string {
    const output: string[] = [];
    for (const [name, cpp] of Object.entries(bufferHelpers)) {
        const filePath = `src/compute/compute-${name.includes("Storage") ? "storage" : "uniform"}-buffer-binding.ts`;
        const { file, declaration } = context.functionDeclaration(
            filePath,
            name,
        );
        const scope = bufferScope(context, file);
        scope.bindings.delete("alignment");
        scope.bindings.delete("maxBindingSize");
        const baseExpression = scope.expression;
        for (const [source, target] of Object.entries(bufferHelpers))
            scope.bindings.set(source, { cpp: target, type: "opaque" });
        scope.bindings.set("value", { cpp: "value", type: "opaque" });
        scope.bindings.set("owner", { cpp: "owner", type: "opaque" });
        scope.expression = (node, l) => {
            if (context.expressionMatchesShape(node, '"_usage" in value'))
                return "value->storage.has_value()";
            if (
                context.expressionMatchesShape(
                    node,
                    "(value as StorageBuffer)._writable",
                )
            )
                return "value->writable()";
            if (
                context.expressionMatchesShape(
                    node,
                    "owner._storageBuffers?.has(buffer as StorageBuffer) === true",
                )
            )
                return "(buffer->engine == owner && buffer->storage.has_value() && buffer->registered())";
            if (
                context.expressionMatchesShape(
                    node,
                    "_hasUniformBuffer(owner, buffer as UniformBuffer)",
                )
            ) {
                const membership = context.functionDeclaration(
                    "src/compute/compute-uniform-buffer.ts",
                    "_hasUniformBuffer",
                );
                context.assertStatementShapes(
                    membership.declaration,
                    membership.declaration.body!.statements,
                    "return _buffers?.get(engine)?.has(buffer) === true;",
                    "Uniform buffer registry membership",
                );
                return "(buffer->engine == owner && !buffer->storage.has_value() && buffer->registered())";
            }
            if (ts.isArrowFunction(node)) {
                if (ts.isBlock(node.body))
                    return context.contractError(
                        node,
                        "Expected compute buffer predicate expression.",
                    );
                const parameters = node.parameters.map((parameter) =>
                    parameter.name.getText(file),
                );
                const types = parameters.map((parameter) =>
                    parameter === "owner"
                        ? `const std::shared_ptr<Engine>& ${parameter}`
                        : `const ComputeBufferReferencePtr& ${parameter}`,
                );
                if (!parameters.length)
                    types.push("const ComputeBufferReferencePtr&");
                return `[](${types.join(", ")}) { return ${l.expression(node.body)}; }`;
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
                ts.isCallExpression(node.left) &&
                node.left.expression.getText(file) === "Number"
            ) {
                const input = node.left.arguments[0];
                if (
                    input &&
                    ts.isPropertyAccessExpression(input) &&
                    input.expression.getText(file) === "engine._device.limits"
                ) {
                    const limit: Record<string, string> = {
                        minStorageBufferOffsetAlignment:
                            "min_storage_buffer_offset_alignment",
                        maxStorageBufferBindingSize:
                            "max_storage_buffer_binding_size",
                        maxUniformBufferBindingSize:
                            "max_uniform_buffer_binding_size",
                    };
                    const key = input.name.text;
                    const native =
                        key === "minUniformBufferOffsetAlignment"
                            ? "engine->offscreen_run->device().minimum_uniform_buffer_offset_alignment()"
                            : limit[key]
                              ? `engine->offscreen_run->device().compute_shader_limits().${limit[key]}.value_or(std::numeric_limits<double>::quiet_NaN())`
                              : undefined;
                    if (!native)
                        return context.contractError(
                            input,
                            "Unrepresented compute buffer limit.",
                        );
                    return `js::or_number(${native},${l.expression(node.right)})`;
                }
            }
            return baseExpression?.(node, l);
        };
        const predicate = name.startsWith("is"),
            resolver = name.startsWith("resolve");
        const parameters = predicate
            ? "const ComputeBufferReferencePtr& value"
            : resolver
              ? "const std::shared_ptr<Engine>& engine,const ComputeBindingDeclPtr& decl,const ComputeBufferRange& resource"
              : "const std::shared_ptr<Engine>& engine,const ComputeBufferBindingState& state";
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            ...scope,
            returnValue: (node, l) => l.expression(node!),
        });
        output.push(
            `// ${context.provenance(filePath, name)}\n${predicate ? "static bool" : resolver ? "ComputeResolvedBufferBinding" : "pal::ComputeBufferResource"} ${cpp}(${parameters}){\n${body}\n}`,
        );
    }
    return output.join("\n");
}
