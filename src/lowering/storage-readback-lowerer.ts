import ts from "typescript";
import {
    type LoweredSource,
    type LoweringContext,
    unwrapExpression,
} from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { pinnedRecordLiteral } from "./pinned-record-literal.js";
import { stringLiteral } from "../cpp-literals.js";
import { recordAt } from "../compiler/record-access.js";

/** Pinned validation, staging reuse and promise coalescing; PAL owns copy/map transport. */
export function lowerStorageReadback(context: LoweringContext): LoweredSource {
    const path = "src/resource/storage-buffer.ts",
        { file, declaration } = context.functionDeclaration(
            path,
            "readStorageBuffer",
        );
    const scope = (): PinnedNumericScope => {
        const bindings = new Map<string, PinnedBinding>([
            ["buffer", { cpp: "buffer", type: "opaque" }],
            [
                "buffer._destroyed",
                { cpp: "buffer_record.disposed", type: "bool" },
            ],
            [
                "buffer._buffer",
                {
                    cpp: "owner->allocation",
                    type: "opaque",
                    absentCpp: "!owner->allocation",
                },
            ],
            [
                "buffer._writable",
                { cpp: "buffer_record.writable", type: "bool" },
            ],
            [
                "buffer._engine._currentEncoder",
                {
                    cpp: "engine->current_compute_encoder",
                    type: "opaque",
                    absentCpp: "!engine->current_compute_encoder",
                },
            ],
            [
                "buffer._engine._device",
                {
                    cpp: "std::shared_ptr<pal::OffscreenDevice>(engine->offscreen_run,&engine->offscreen_run->device())",
                    type: "opaque",
                },
            ],
            [
                "buffer.byteLength",
                { cpp: "buffer_record.byte_length", type: "scalar" },
            ],
            [
                "buffer._label",
                {
                    cpp: "buffer_record.label",
                    type: "opaque",
                    absentCpp: "buffer_record.label.empty()",
                },
            ],
            ["byteOffset", { cpp: "byteOffset", type: "scalar" }],
            ["byteLength", { cpp: "byteLength", type: "scalar" }],
            ["device", { cpp: "device", type: "opaque" }],
            ["staging", { cpp: "staging", type: "opaque" }],
            [
                "staging.size",
                {
                    cpp: "static_cast<double>(staging->byte_length())",
                    type: "scalar",
                },
            ],
            [
                "buffer._readback.size",
                {
                    cpp: "static_cast<double>(state->staging->byte_length())",
                    type: "scalar",
                },
            ],
            ["BU.COPY_DST", { cpp: "8.0", type: "scalar" }],
            ["BU.MAP_READ", { cpp: "1.0", type: "scalar" }],
            ["GPUMapMode.READ", { cpp: "1.0", type: "scalar" }],
        ]);
        for (const [source, cpp] of Object.entries({
            _readback: "staging",
            _readbackDevice: "device",
            _readPending: "pending",
            _readPendingOffset: "offset",
            _readPendingLength: "length",
        }))
            bindings.set(`buffer.${source}`, {
                cpp: `state->${cpp}`,
                type: "opaque",
                absentCpp: `!state->${cpp}`,
            });
        const calls = new Map<string, (args: readonly string[]) => string>([
            [
                "Number.isSafeInteger",
                (args) => `js::number_is_safe_integer(${args.join(", ")})`,
            ],
            [
                "buffer._engine._storageBuffers?.has",
                () => "buffer_record.registered",
            ],
            ["buffer._readback.destroy", () => "state->staging->destroy()"],
            ["staging.unmap", () => "staging->unmap()"],
            [
                "staging.mapAsync",
                (args) =>
                    `pal::map_storage_readback(staging, ${args.join(", ")})`,
            ],
            [
                "readStorageBuffer",
                (args) => `read_gpu_storage_buffer(${args.join(", ")})`,
            ],
            [
                "encoder.copyBufferToBuffer",
                (args) => `encoder.copy(${args.join(", ")})`,
            ],
        ]);
        return {
            bindings,
            calls,
            booleanAnd: true,
            booleanOr: true,
            callShapes: new Map([
                ["Number.isSafeInteger", "bool"],
                ["buffer._engine._storageBuffers?.has", "bool"],
            ]),
            expression(input, lowerer) {
                const node = unwrapExpression(input);
                if (ts.isIdentifier(node) && node.text === "undefined")
                    return "{}";
                if (ts.isStringLiteral(node)) return stringLiteral(node.text);
                if (ts.isTemplateExpression(node)) {
                    const pieces = [stringLiteral(node.head.text)];
                    for (const span of node.templateSpans) {
                        const value = lowerer.expression(span.expression);
                        pieces.push(
                            span.expression.getText(file) === "buffer._label"
                                ? value
                                : `js::number_to_string(${value})`,
                        );
                        pieces.push(stringLiteral(span.literal.text));
                    }
                    return `(std::string(${pieces[0]}) + ${pieces.slice(1).join(" + ")})`;
                }
                if (
                    ts.isNewExpression(node) &&
                    ts.isIdentifier(node.expression)
                ) {
                    if (node.expression.text === "Error")
                        return `std::make_exception_ptr(std::runtime_error(${lowerer.expression(node.arguments![0]!)}))`;
                    if (node.expression.text === "ArrayBuffer")
                        return `js::ArrayBuffer(std::vector<std::uint8_t>(static_cast<std::size_t>(${lowerer.expression(node.arguments![0]!)})))`;
                }
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionEqualsToken
                ) {
                    const target = lowerer.expression(node.left),
                        value = lowerer.expression(node.right);
                    return `([&]() { if(!${target}) ${target} = ${value}; return ${target}; })()`;
                }
                if (ts.isArrowFunction(node)) {
                    const parent = node.parent;
                    if (
                        !ts.isCallExpression(parent) ||
                        !ts.isPropertyAccessExpression(parent.expression)
                    )
                        return context.contractError(
                            node,
                            "Expected a storage readback promise callback.",
                        );
                    const method = parent.expression.name.text;
                    if (method === "finally") {
                        if (!ts.isBlock(node.body))
                            return context.contractError(
                                node,
                                "Expected readback finally body.",
                            );
                        const body = lowerPinnedBody(
                            file,
                            node.body.statements,
                            scope(),
                        );
                        return `js::make_closure(std::tuple{state}, [](auto& captures) { const auto& state=std::get<0>(captures);\n${body}\n})`;
                    }
                    if (method !== "then")
                        return context.contractError(
                            node,
                            "Unsupported storage readback callback.",
                        );
                    if (ts.isBlock(node.body)) {
                        const body = lowerPinnedBody(
                            file,
                            node.body.statements,
                            {
                                ...scope(),
                                returnValue: (value, inner) =>
                                    value ? inner.expression(value) : "",
                            },
                        );
                        return `js::make_closure(std::tuple{staging,byteLength}, [](auto& captures,const js::PromiseVoid&) -> js::ArrayBuffer { const auto& staging=std::get<0>(captures); const auto byteLength=std::get<1>(captures);\n${body}\n})`;
                    }
                    const rejected = parent.arguments[1] === node;
                    const inner = new PinnedNumericLowerer(file, scope());
                    return `js::make_closure(std::tuple{buffer,byteOffset,byteLength}, [](auto& captures,${rejected ? "std::exception_ptr" : "const js::ArrayBuffer&"}) { const auto& [buffer,byteOffset,byteLength]=captures; return ${inner.expression(node.body)}; })`;
                }
                if (!ts.isCallExpression(node)) return undefined;
                const callee = node.expression.getText(file);
                if (callee === "buffer._engine._storageBuffers?.has")
                    return "buffer_record.registered";
                if (callee === "Promise.reject")
                    return `js::Promise<js::ArrayBuffer>::rejected(${lowerer.expression(node.arguments[0]!)})`;
                if (callee === "Promise.resolve")
                    return `js::Promise<js::ArrayBuffer>::resolved(${lowerer.expression(node.arguments[0]!)})`;
                if (callee === "device.createBuffer")
                    return `device->create_storage_readback(${pinnedRecordLiteral(context, lowerer, node.arguments[0]!, { cpp: "pal::StorageReadbackDescriptor", fields: { label: { cpp: "label" }, size: { cpp: "size", convert: (value) => `static_cast<std::size_t>(${value})` }, usage: { cpp: "usage", convert: (value) => `static_cast<std::uint32_t>(${value})` } } })})`;
                if (callee === "device.createCommandEncoder")
                    return pinnedRecordLiteral(
                        context,
                        lowerer,
                        node.arguments[0]!,
                        {
                            cpp: "pal::StorageReadbackCopy",
                            fields: { label: { cpp: "label" } },
                        },
                    );
                if (callee === "staging.mapAsync")
                    return `pal::map_storage_readback(staging,${node.arguments.map((argument) => lowerer.expression(argument)).join(", ")})`;
                if (
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "slice"
                ) {
                    const source = node.expression.expression;
                    if (
                        ts.isCallExpression(source) &&
                        source.expression.getText(file) ===
                            "staging.getMappedRange"
                    ) {
                        context.assertExpressionShape(
                            node.arguments[0]!,
                            "0",
                            "Storage readback snapshot starts at zero",
                        );
                        return `pal::copy_mapped_storage_readback(staging,${source.arguments.map((argument) => lowerer.expression(argument)).join(", ")})`;
                    }
                }
                if (
                    ts.isPropertyAccessExpression(node.expression) &&
                    ["then", "finally"].includes(node.expression.name.text)
                ) {
                    const parent = node.expression.expression;
                    const receiver =
                        parent.getText(file) === "buffer._readPending"
                            ? "state->pending->"
                            : `${lowerer.expression(parent)}.`;
                    return `${receiver}${node.expression.name.text}(${node.arguments.map((argument) => lowerer.expression(argument)).join(", ")})`;
                }
                return undefined;
            },
            statement(node, lowerer, indent) {
                if (
                    ts.isTryStatement(node) &&
                    !node.catchClause &&
                    node.finallyBlock
                ) {
                    const cleanup = lowerer.statements(
                        node.finallyBlock.statements,
                        indent + "    ",
                    );
                    return [
                        `${indent}auto unmap = js::finally([&] {`,
                        ...cleanup,
                        `${indent}});`,
                        ...lowerer.statements(node.tryBlock.statements, indent),
                    ];
                }
                if (
                    ts.isVariableStatement(node) &&
                    node.declarationList.declarations.length === 1
                ) {
                    const entry = node.declarationList.declarations[0]!;
                    if (
                        ts.isIdentifier(entry.name) &&
                        entry.initializer &&
                        ["device", "staging", "encoder"].includes(
                            entry.name.text,
                        )
                    )
                        return [
                            `${indent}auto ${entry.name.text} = ${lowerer.expression(entry.initializer)};`,
                        ];
                }
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isCallExpression(node.expression) &&
                    node.expression.expression.getText(file) ===
                        "device.queue.submit"
                ) {
                    context.assertExpressionShape(
                        node.expression.arguments[0]!,
                        "[encoder.finish()]",
                        "Storage readback submission",
                    );
                    return [
                        `${indent}encoder.finish();`,
                        `${indent}encoder.submit();`,
                    ];
                }
                return undefined;
            },
        };
    };
    const initialScope = scope(),
        initialLowerer = new PinnedNumericLowerer(file, initialScope);
    const offsetDefault = declaration.parameters[1]?.initializer,
        lengthDefault = declaration.parameters[2]?.initializer;
    if (!offsetDefault || !lengthDefault)
        return context.contractError(
            declaration,
            "Expected readback range defaults.",
        );
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        ...scope(),
        returnValue: (value, lowerer) => {
            if (!value)
                return context.contractError(
                    declaration,
                    "Expected a storage readback promise.",
                );
            return value.getText(file) === "buffer._readPending"
                ? "*state->pending"
                : lowerer.expression(value);
        },
    });
    return {
        modulePath: path,
        symbolName: "readStorageBuffer",
        header: "",
        source: `#include <bblite/pal_gpu_storage_readback.hpp>\nnamespace bbl {\n// ${context.provenance(path, "readStorageBuffer")}\njs::Promise<js::ArrayBuffer> read_gpu_storage_buffer(StorageBufferHandle buffer,std::optional<double> offset_input,std::optional<double> length_input) {\n    auto engine=buffer.engine.lock();\n    if(!engine || buffer.value>=engine->storage_buffers.size() || !${recordAt("engine->storage_buffers", "buffer")}.gpu) return js::Promise<js::ArrayBuffer>::rejected(std::make_exception_ptr(std::runtime_error("StorageBuffer is not a live registered allocation.")));\n    auto& buffer_record=${recordAt("engine->storage_buffers", "buffer")};\n    const auto owner=buffer_record.gpu;\n    if(!owner->readback_state) owner->readback_state=js::make_gc_shared<pal::StorageReadbackState>();\n    const auto state=owner->readback_state;\n    const double byteOffset=offset_input.value_or(${initialLowerer.expression(offsetDefault)});\n    const double byteLength=length_input.value_or(${initialLowerer.expression(lengthDefault)});\n${body}\n}\n}\n`,
    };
}
