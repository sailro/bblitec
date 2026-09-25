import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import { unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import type {
    PinnedBinding,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { bufferAlignmentCpp } from "./gpu-buffer-adapters.js";
import { pinnedRecordLiteral } from "./pinned-record-literal.js";

const path = "src/compute/compute-uniform-arena.ts";
const members: Record<string, string> = {
    buffer: "buffer",
    slotByteLength: "slot_byte_length",
    slotStride: "slot_stride",
    slotCount: "slot_count",
    _task: "task",
    _dirtyStart: "dirty_start",
    _dirtyEnd: "dirty_end",
    _destroyed: "destroyed",
};
const arenaSchema = {
    cpp: "ComputeUniformArena",
    fields: Object.fromEntries(
        Object.entries(members).map(([name, cpp]) => [name, { cpp }]),
    ),
};
const methods: Record<
    string,
    { cpp: string; result: string; parameters: string; internal?: boolean }
> = {
    validateSlot: {
        cpp: "validate_uniform_slot",
        result: "void",
        parameters:
            "const std::shared_ptr<ComputeUniformArena>& arena,double slot",
        internal: true,
    },
    getComputeUniformSlotOffset: {
        cpp: "compute_uniform_slot_offset",
        result: "double",
        parameters:
            "const std::shared_ptr<ComputeUniformArena>& arena,double slot",
    },
    updateComputeUniformSlot: {
        cpp: "update_compute_uniform_slot",
        result: "void",
        parameters:
            "const std::shared_ptr<ComputeUniformArena>& arena,double slot,std::span<const std::uint8_t> data,double offset",
    },
    _flushComputeUniformArena: {
        cpp: "flush_compute_uniform_arena",
        result: "void",
        parameters: "const std::shared_ptr<ComputeUniformArena>& arena",
    },
    _disposeComputeUniformArena: {
        cpp: "dispose_compute_uniform_arena",
        result: "void",
        parameters: "const std::shared_ptr<ComputeUniformArena>& arena",
    },
    createComputeUniformArena: {
        cpp: "create_compute_uniform_arena",
        result: "std::shared_ptr<ComputeUniformArena>",
        parameters:
            "std::shared_ptr<ComputeTask> task,double slotByteLength,double slotCount,std::optional<std::string> label",
    },
};

function scope(
    context: LoweringContext,
    file: ts.SourceFile,
): PinnedNumericScope {
    const bindings = new Map<string, PinnedBinding>([
        ...["slotByteLength", "slotCount", "slot", "byteOffset"].map(
            (name) =>
                [
                    name,
                    {
                        cpp: name === "byteOffset" ? "offset" : name,
                        type: "scalar",
                    },
                ] as const,
        ),
        ["arena", { cpp: "arena", type: "opaque" }],
        ["task", { cpp: "task", type: "opaque" }],
        ["task._disposed", { cpp: "task->disposed", type: "bool" }],
        ["task.name", { cpp: "task->name", type: "opaque" }],
        ["task.engine", { cpp: "task->engine", type: "opaque" }],
        [
            "task.engine._device.limits.minUniformBufferOffsetAlignment",
            {
                cpp: "task->engine->offscreen_run->device().minimum_uniform_buffer_offset_alignment()",
                type: "scalar",
            },
        ],
        ["options", { cpp: "label", type: "opaque" }],
        [
            "data.byteLength",
            { cpp: "static_cast<double>(data.size())", type: "scalar" },
        ],
        [
            "Number.POSITIVE_INFINITY",
            { cpp: "std::numeric_limits<double>::infinity()", type: "scalar" },
        ],
        [
            "arenas.length",
            { cpp: "static_cast<double>(arenas.size())", type: "scalar" },
        ],
        ...Object.entries(members).map(
            ([name, cpp]) =>
                [
                    `arena.${name}`,
                    {
                        cpp: `arena->${cpp}`,
                        type:
                            name === "_destroyed"
                                ? "bool"
                                : name === "buffer" || name === "_task"
                                  ? "opaque"
                                  : "scalar",
                    },
                ] as const,
        ),
    ]);
    const calls = pinnedNumericMathCalls();
    for (const name of ["Number.isInteger", "Number.isSafeInteger"])
        calls.set(
            name,
            (args) =>
                `js::${name.endsWith("SafeInteger") ? "number_is_safe_integer" : "number_is_integer"}(${args.join(", ")})`,
        );
    calls.set("align", (args) => `uniform_arena_align(${args.join(", ")})`);
    calls.set("Number", (args) => args[0]!);
    calls.set(
        "createUniformBuffer",
        (args) =>
            `create_uniform_buffer(${args[0]}, storage_buffer_source(${args[1]}), ${args[2]})`,
    );
    calls.set(
        "disposeUniformBuffer",
        (args) => `dispose_uniform_buffer(${args.join(", ")})`,
    );
    calls.set("arenas.push", (args) => `arenas.push_back(${args.join(", ")})`);
    for (const [name, method] of Object.entries(methods))
        if (name !== "createComputeUniformArena")
            calls.set(name, (args) => `${method.cpp}(${args.join(", ")})`);
    return {
        bindings,
        calls,

        callShapes: new Map([
            ["Number.isInteger", "bool"],
            ["Number.isSafeInteger", "bool"],
        ]),
        expression(node, lowerer) {
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
                context.expressionMatchesShape(
                    node,
                    "Number(task.engine._device.limits.minUniformBufferOffsetAlignment) || 1",
                )
            )
                return `js::or_number(${lowerer.expression(node.left)}, ${lowerer.expression(node.right)})`;
            if (
                ts.isElementAccessExpression(node) &&
                node.expression.getText(file) === "arenas"
            )
                return `arenas[static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)})]`;
            return undefined;
        },
        forOf(iterated, element) {
            if (iterated !== "arenas") return undefined;
            return {
                range: "arenas",
                bindings: new Map([
                    [element, { cpp: element, type: "opaque" }],
                ]),
            };
        },
        statement(node, lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const entries = node.declarationList.declarations;
                if (
                    entries.length !== 1 ||
                    !ts.isIdentifier(entries[0]!.name) ||
                    !entries[0]!.initializer
                )
                    return undefined;
                const name = entries[0]!.name.text,
                    value = entries[0]!.initializer;
                if (name === "arena") {
                    if (!ts.isObjectLiteralExpression(value))
                        return context.contractError(
                            value,
                            "Expected uniform arena record.",
                        );
                    const expected = new Set(Object.keys(members));
                    for (const property of value.properties) {
                        const name = property.name
                            ? context.propertyName(property.name)
                            : undefined;
                        if (!name || !expected.delete(name))
                            return context.contractError(
                                property,
                                "Unexpected uniform arena member.",
                            );
                    }
                    if (expected.size)
                        return context.contractError(
                            value,
                            "Missing uniform arena fields.",
                        );
                    return [
                        `${indent}auto arena = js::make_gc_shared<ComputeUniformArena>(${pinnedRecordLiteral(context, lowerer, value, arenaSchema)});`,
                    ];
                }
                if (name === "arenas") {
                    context.assertExpressionShape(
                        value,
                        "task._uniformArenas ??= []",
                        "Task arena ownership",
                    );
                    return [`${indent}auto arenas = task->uniform_arenas;`];
                }
                if (name === "engine") {
                    context.assertExpressionShape(
                        value,
                        "arena._task.engine",
                        "Uniform arena engine",
                    );
                    return [
                        `${indent}const auto engine = arena->task->engine;`,
                    ];
                }
                if (name === "handle") {
                    context.assertExpressionShape(
                        value,
                        "_getUniformBufferHandle(engine, arena.buffer)",
                        "Uniform arena live allocation",
                    );
                    return [
                        `${indent}const auto handle = get_uniform_buffer_handle(engine, arena->buffer);`,
                    ];
                }
            }
            if (!ts.isExpressionStatement(node)) return undefined;
            const expression = unwrapExpression(node.expression);
            if (
                ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isArrowFunction(expression.right)
            ) {
                const target = expression.left.getText(file),
                    member =
                        target === "task._flushOwned"
                            ? "flush_owned"
                            : target === "task._disposeOwned"
                              ? "dispose_owned"
                              : undefined;
                if (!member) return undefined;
                const callback = expression.right;
                if (callback.parameters.length || !ts.isBlock(callback.body))
                    return context.contractError(
                        callback,
                        "Expected arena owner callback.",
                    );
                const body = lowerPinnedBody(
                    file,
                    callback.body.statements,
                    scope(context, file),
                    indent + "    ",
                );
                return [
                    `${indent}task->${member} = js::make_closure(std::tuple{arenas}, [](auto& captures) {`,
                    `${indent}    auto& arenas = std::get<0>(captures);`,
                    body,
                    `${indent}});`,
                ];
            }
            if (context.expressionMatchesShape(expression, "arenas.length = 0"))
                return [`${indent}arenas.clear();`];
            if (
                context.expressionMatchesShape(
                    expression,
                    "arena.buffer._data!.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), start)",
                )
            )
                return [
                    `${indent}std::copy(data.begin(), data.end(), arena->buffer->data->begin() + static_cast<std::ptrdiff_t>(start));`,
                ];
            if (
                context.expressionMatchesShape(
                    expression,
                    "engine._device.queue.writeBuffer(handle, start, arena.buffer._data!.buffer, start, size)",
                )
            )
                return [
                    `${indent}handle->write(static_cast<std::size_t>(start), {arena->buffer->data->data() + static_cast<std::size_t>(start), static_cast<std::size_t>(size)});`,
                ];
            return undefined;
        },
    };
}

export function lowerComputeUniformArena(
    context: LoweringContext,
): LoweredSource {
    const output = [bufferAlignmentCpp(context, "uniform_arena_align")];
    for (const [name, method] of Object.entries(methods)) {
        const { file, declaration } = context.functionDeclaration(path, name);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            ...scope(context, file),
            returnValue: (node, lowerer) =>
                node ? lowerer.expression(node) : "",
        });
        output.push(
            `// ${context.provenance(path, name)}\n${method.internal ? "static " : ""}${method.result} ${method.cpp}(${method.parameters}) {\n${body}\n}`,
        );
    }
    return {
        modulePath: path,
        symbolName: "createComputeUniformArena",
        header: "",
        source: `#include <bblite/pal_compute_uniform_arena.hpp>\nnamespace bbl {\n${output.join("\n")}\n}\n`,
    };
}
