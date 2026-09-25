import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import { unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { storageBufferDescriptorCpp } from "./storage-buffer-descriptor.js";
import { assertMappedBufferAdapter } from "./gpu-buffer-adapters.js";

const path = "src/resource/storage-buffer.ts";

function ownerMethod(
    context: LoweringContext,
    name: "updateStorageBuffer" | "disposeStorageBuffer",
    readback: boolean,
): string {
    const { file, declaration } = context.functionDeclaration(path, name);
    const update = name === "updateStorageBuffer";
    const bindings = new Map<string, PinnedBinding>([
        ["buffer._destroyed", { cpp: "record.disposed", type: "bool" }],
        [
            "buffer._engine",
            { cpp: "this->engine.lock().get()", type: "opaque" },
        ],
        ["engine", { cpp: "&owner", type: "opaque" }],
        ["buffer.byteLength", { cpp: "record.byte_length", type: "scalar" }],
        [
            "data.byteLength",
            { cpp: "static_cast<double>(data.size())", type: "scalar" },
        ],
        ["byteOffset", { cpp: "offset", type: "scalar" }],
        [
            "buffer._engine._resourceEpoch",
            { cpp: "owner.resource_epoch", type: "scalar" },
        ],
        [
            "buffer._engine._storageBuffers.size",
            { cpp: "storage_buffer_registry_size(owner)", type: "scalar" },
        ],
        ["shadow", { cpp: "record.has_shadow", type: "bool" }],
    ]);
    const calls = pinnedNumericMathCalls();
    calls.set(
        "Number.isInteger",
        (args) => `js::number_is_integer(${args.join(", ")})`,
    );
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls,

        callShapes: new Map([
            ["Number.isInteger", "bool"],
            ["engine._storageBuffers?.has", "bool"],
            ["buffer._engine._storageBuffers?.has", "bool"],
        ]),
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
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken &&
                node.left.getText(file) === "buffer._engine._resourceEpoch"
            )
                return "owner.resource_epoch";
            if (!ts.isCallExpression(node)) return undefined;
            const callee = node.expression.getText(file);
            if (
                callee === "engine._storageBuffers?.has" ||
                callee === "buffer._engine._storageBuffers?.has"
            ) {
                context.assertExpressionShape(
                    node.arguments[0]!,
                    "buffer",
                    "Storage registry member",
                );
                return "record.registered";
            }
            return undefined;
        },
        statement(node, _lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const entry = node.declarationList.declarations[0];
                if (
                    node.declarationList.declarations.length !== 1 ||
                    !entry ||
                    !ts.isIdentifier(entry.name) ||
                    !entry.initializer
                )
                    return undefined;
                if (entry.name.text === "shadow") {
                    context.assertExpressionShape(
                        entry.initializer,
                        "buffer._data",
                        "Storage CPU mirror",
                    );
                    return [];
                }
                if (entry.name.text === "bytes") {
                    context.assertExpressionShape(
                        entry.initializer,
                        "data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)",
                        "Storage byte view",
                    );
                    return [];
                }
            }
            if (!ts.isExpressionStatement(node)) return undefined;
            const expression = unwrapExpression(node.expression);
            if (ts.isCallExpression(expression)) {
                const callee = expression.expression.getText(file);
                if (callee === "engine._device.queue.writeBuffer") {
                    context.assertExpressionShape(
                        expression,
                        "engine._device.queue.writeBuffer(buffer._buffer!, byteOffset, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)",
                        "Storage queue upload",
                    );
                    return [
                        `${indent}allocation->write(static_cast<std::size_t>(offset), data);`,
                        `${indent}++record.version;`,
                    ];
                }
                if (callee === "shadow.set") {
                    context.assertExpressionShape(
                        expression,
                        "shadow.set(bytes, byteOffset)",
                        "Storage mirror update",
                    );
                    return [
                        `${indent}std::copy(data.begin(), data.end(), record.bytes.begin() + static_cast<std::ptrdiff_t>(offset));`,
                    ];
                }
                if (callee === "buffer._readback?.destroy") {
                    context.assertExpressionShape(
                        expression,
                        "buffer._readback?.destroy()",
                        "Storage readback release",
                    );
                    return readback
                        ? [
                              `${indent}if(readback_state && readback_state->staging) readback_state->staging->destroy();`,
                          ]
                        : [];
                }
                if (callee === "buffer._buffer?.destroy") {
                    context.assertExpressionShape(
                        expression,
                        "buffer._buffer?.destroy()",
                        "Storage allocation release",
                    );
                    return [`${indent}if (allocation) allocation->destroy();`];
                }
                if (callee === "buffer._engine._storageBuffers.delete") {
                    context.assertExpressionShape(
                        expression,
                        "buffer._engine._storageBuffers.delete(buffer)",
                        "Storage registry deletion",
                    );
                    return [`${indent}record.registered = false;`];
                }
            }
            if (
                !ts.isBinaryExpression(expression) ||
                expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
            )
                return undefined;
            const target = expression.left.getText(file);
            if (
                [
                    "buffer._readback",
                    "buffer._readbackDevice",
                    "buffer._engine._storageBuffers",
                ].includes(target)
            ) {
                context.assertExpressionShape(
                    expression.right,
                    "undefined",
                    "Absent storage registry or readback state",
                );
                if (readback && target !== "buffer._engine._storageBuffers")
                    return [
                        `${indent}if(readback_state) readback_state->${target === "buffer._readback" ? "staging" : "device"}.reset();`,
                    ];
                return [];
            }
            if (target === "buffer._buffer") {
                context.assertExpressionShape(
                    expression.right,
                    "null",
                    "Released storage allocation",
                );
                return [`${indent}allocation.reset();`];
            }
            if (target === "buffer._data") {
                context.assertExpressionShape(
                    expression.right,
                    "null",
                    "Released CPU mirror",
                );
                return [
                    `${indent}record.has_shadow = false;`,
                    `${indent}record.bytes.clear();`,
                ];
            }
            if (target === "buffer._engine._disposeStorageBuffers") {
                context.assertExpressionShape(
                    expression.right,
                    "undefined",
                    "Empty storage disposal hook",
                );
                return [`${indent}owner.dispose_storage_buffers = {};`];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(path, name)}
void ${update ? "update(Engine& owner, std::uint32_t slot, std::span<const std::uint8_t> data, double offset)" : "dispose(Engine& owner, std::uint32_t slot)"} override {
    auto& record = owner.storage_buffers.at(slot);
${body}
}
`;
}

function factory(context: LoweringContext): string {
    assertMappedBufferAdapter(context);
    const { file, declaration } = context.functionDeclaration(
        path,
        "createStorageBuffer",
    );
    const entries = declaration.body!.statements;
    const defaults = entries
        .flatMap((node) =>
            ts.isVariableStatement(node)
                ? [...node.declarationList.declarations]
                : [],
        )
        .find((node) => ts.isObjectBindingPattern(node.name));
    if (!defaults || !ts.isObjectBindingPattern(defaults.name))
        return context.contractError(
            declaration,
            "Storage option defaults are missing.",
        );
    const flags = defaults.name.elements
        .filter((node) => node.initializer)
        .map((node) => {
            if (
                !ts.isIdentifier(node.name) ||
                !["writable", "vertex", "index", "indirect"].includes(
                    node.name.text,
                ) ||
                !node.initializer ||
                ![
                    ts.SyntaxKind.TrueKeyword,
                    ts.SyntaxKind.FalseKeyword,
                ].includes(node.initializer.kind)
            )
                return context.contractError(
                    node,
                    "Unrepresented storage option default.",
                );
            return `    const bool ${node.name.text} = options.${node.name.text}.value_or(${node.initializer.getText(file)});`;
        });
    const start = entries.findIndex(
        (node) =>
            ts.isVariableStatement(node) &&
            node.declarationList.declarations.some(
                (entry) =>
                    ts.isIdentifier(entry.name) && entry.name.text === "bytes",
            ),
    );
    if (start < 0)
        return context.contractError(
            declaration,
            "Storage creation body is missing.",
        );
    const bindings = new Map<string, PinnedBinding>([
        ["usage", { cpp: "shape[1]", type: "scalar" }],
        ["byteLength", { cpp: "shape[0]", type: "scalar" }],
        [
            "BU.STORAGE",
            {
                cpp: "static_cast<double>(pal::StorageBufferRole::storage)",
                type: "scalar",
            },
        ],
        ["bytes", { cpp: "bytes.has_value()", type: "bool" }],
        ["isByteLength", { cpp: "source.numeric", type: "bool" }],
        ["initialData", { cpp: "initial_data.has_value()", type: "bool" }],
        ["buffer", { cpp: "buffer", type: "opaque" }],
        ["engine", { cpp: "engine", type: "opaque" }],
        [
            "label",
            { cpp: "options.label.value_or(std::string{})", type: "opaque" },
        ],
        ["writable", { cpp: "writable", type: "bool" }],
    ]);
    const body = lowerPinnedBody(file, entries.slice(start), {
        bindings,
        calls: new Map(),

        statement(node, lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const entry = node.declarationList.declarations[0];
                if (
                    node.declarationList.declarations.length !== 1 ||
                    !entry ||
                    !ts.isIdentifier(entry.name) ||
                    !entry.initializer
                )
                    return undefined;
                const value = unwrapExpression(entry.initializer);
                switch (entry.name.text) {
                    case "bytes": {
                        if (
                            !ts.isConditionalExpression(value) ||
                            !ts.isNewExpression(value.whenTrue) ||
                            value.whenTrue.expression.getText(file) !==
                                "Uint8Array" ||
                            value.whenTrue.arguments?.length !== 1 ||
                            value.whenFalse.kind !== ts.SyntaxKind.NullKeyword
                        )
                            return context.contractError(
                                entry,
                                "Storage CPU mirror allocation changed.",
                            );
                        return [
                            `${indent}std::optional<std::vector<std::uint8_t>> bytes;`,
                            `${indent}if (${lowerer.expression(value.condition)}) bytes.emplace(static_cast<std::size_t>(${lowerer.expression(value.whenTrue.arguments[0]!)}));`,
                        ];
                    }
                    case "initialData": {
                        const view = (node: ts.Expression): string => {
                            node = unwrapExpression(node);
                            if (node.kind === ts.SyntaxKind.NullKeyword)
                                return "std::nullopt";
                            if (ts.isIdentifier(node)) {
                                if (node.text === "bytes")
                                    return "std::optional<std::span<const std::uint8_t>>{std::span<const std::uint8_t>(*bytes)}";
                                if (node.text === "source")
                                    return "std::optional<std::span<const std::uint8_t>>{source.bytes}";
                            }
                            if (ts.isConditionalExpression(node))
                                return `(${lowerer.expression(node.condition)} ? ${view(node.whenTrue)} : ${view(node.whenFalse)})`;
                            if (
                                ts.isBinaryExpression(node) &&
                                node.operatorToken.kind ===
                                    ts.SyntaxKind.QuestionQuestionToken
                            )
                                return `(${lowerer.expression(node.left)} ? ${view(node.left)} : ${view(node.right)})`;
                            return context.contractError(
                                node,
                                "Unrepresented storage upload view.",
                            );
                        };
                        return [
                            `${indent}const std::optional<std::span<const std::uint8_t>> initial_data = ${view(value)};`,
                        ];
                    }
                    case "buffer": {
                        context.assertExpressionShape(
                            value,
                            "initialData ? createMappedBuffer(engine, initialData, usage, label) : engine._device.createBuffer({ label, size: byteLength, usage: usage | BU.COPY_DST })",
                            "Storage backend allocation",
                        );
                        return [
                            `${indent}const pal::StorageBufferDescriptor descriptor{static_cast<std::size_t>(shape[0]), static_cast<std::uint32_t>(shape[1]), options.label.value_or(std::string{})};`,
                            `${indent}const auto buffer = engine->offscreen_run->device().create_storage_buffer(descriptor, initial_data);`,
                        ];
                    }
                    case "storage": {
                        context.assertExpressionShape(
                            value,
                            "{ byteLength }",
                            "Storage resource projection",
                        );
                        return [
                            `${indent}Engine::StorageBufferRecord storage;`,
                            `${indent}storage.byte_length = shape[0];`,
                        ];
                    }
                }
            }
            if (ts.isReturnStatement(node)) {
                context.assertExpressionShape(
                    node.expression!,
                    "storage",
                    "Storage resource result",
                );
                return [`${indent}return handle;`];
            }
            if (!ts.isExpressionStatement(node)) return undefined;
            const value = unwrapExpression(node.expression);
            if (ts.isCallExpression(value)) {
                const callee = value.expression.getText(file);
                if (callee === "bytes.set") {
                    context.assertExpressionShape(
                        value,
                        "bytes.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength))",
                        "Initial storage byte copy",
                    );
                    return [
                        `${indent}std::copy(source.bytes.begin(), source.bytes.end(), bytes->begin());`,
                    ];
                }
                if (callee === "Object.defineProperties") {
                    const fields = value.arguments[1];
                    if (!fields || !ts.isObjectLiteralExpression(fields))
                        return context.contractError(
                            value,
                            "Storage descriptors require named fields.",
                        );
                    const targets: Record<string, string> = {
                        _buffer: "storage.gpu->allocation",
                        _destroyed: "storage.disposed",
                        _engine: "storage.gpu->engine",
                        _label: "storage.label",
                        _writable: "storage.writable",
                        _usage: "storage.usage",
                    };
                    const lines = [
                        `${indent}storage.gpu = std::make_shared<SourceStorageBuffer>();`,
                        `${indent}storage.gpu->device = engine->offscreen_run;`,
                    ];
                    const expected = new Set([
                        ...Object.keys(targets),
                        "_data",
                    ]);
                    for (const field of fields.properties) {
                        if (
                            !ts.isPropertyAssignment(field) ||
                            !ts.isObjectLiteralExpression(field.initializer)
                        )
                            return context.contractError(
                                field,
                                "Storage descriptors require value records.",
                            );
                        const name = context.propertyName(field.name);
                        if (!name || !expected.delete(name))
                            return context.contractError(
                                field,
                                "Unexpected storage descriptor field.",
                            );
                        const property = field.initializer.properties.find(
                            (entry): entry is ts.PropertyAssignment =>
                                ts.isPropertyAssignment(entry) &&
                                context.propertyName(entry.name) === "value",
                        );
                        if (!property)
                            return context.contractError(
                                field,
                                "Storage descriptor value is missing.",
                            );
                        const initializer = property.initializer;
                        if (name === "_data") {
                            context.assertExpressionShape(
                                initializer,
                                "bytes",
                                "Storage shadow ownership",
                            );
                            lines.push(
                                `${indent}storage.has_shadow = bytes.has_value();`,
                                `${indent}if (bytes) storage.bytes = std::move(*bytes);`,
                            );
                        } else {
                            if (!name || !targets[name])
                                return context.contractError(
                                    field,
                                    "Unrepresented storage resource field.",
                                );
                            lines.push(
                                `${indent}${targets[name]} = ${lowerer.expression(initializer)};`,
                            );
                        }
                    }
                    if (expected.size)
                        return context.contractError(
                            fields,
                            "Storage descriptor fields are missing.",
                        );
                    return lines;
                }
                if (
                    ts.isPropertyAccessExpression(value.expression) &&
                    value.expression.name.text === "add"
                ) {
                    context.assertExpressionShape(
                        value,
                        "(engine._storageBuffers ??= new Set()).add(storage)",
                        "Storage registration",
                    );
                    return [
                        `${indent}const StorageBufferHandle handle{static_cast<std::uint32_t>(engine->storage_buffers.size()),engine};`,
                        `${indent}engine->storage_buffers.push_back(std::move(storage));`,
                    ];
                }
            }
            if (
                ts.isBinaryExpression(value) &&
                value.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionEqualsToken
            ) {
                context.assertExpressionShape(
                    value,
                    "engine._disposeStorageBuffers ??= () => _disposeStorageBuffers(engine)",
                    "Storage disposal hook",
                );
                return [
                    `${indent}if (!engine->dispose_storage_buffers) engine->dispose_storage_buffers = dispose_gpu_storage_buffers;`,
                ];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(path, "createStorageBuffer")}
StorageBufferHandle create_gpu_storage_buffer(std::shared_ptr<Engine> engine, StorageBufferSource source, StorageBufferOptions options) {
    if (!engine || !engine->offscreen_run) throw std::runtime_error("Storage buffer has no engine device.");
${flags.join("\n")}
    const auto shape = upstream::storage_buffer_shape(source.byte_length,source.numeric,engine->offscreen_run->device().maximum_storage_buffer_size(),writable,vertex,index,indirect);
${body}
}
`;
}

function disposal(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        path,
        "_disposeStorageBuffers",
    );
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map(),
        calls: new Map([
            [
                "disposeStorageBuffer",
                (args) => `dispose_storage_buffer(engine, ${args.join(", ")})`,
            ],
        ]),
        forOf(iterated, element) {
            if (iterated !== "[...(engine._storageBuffers ?? [])]")
                return undefined;
            return {
                range: "storage_buffer_registry_snapshot(engine)",
                bindings: new Map([
                    [element, { cpp: element, type: "opaque" }],
                ]),
            };
        },
    });
    return `// ${context.provenance(path, "_disposeStorageBuffers")}
static void dispose_gpu_storage_buffers(Engine& engine) {
${body}
}
`;
}

export function lowerStorageBuffer(
    context: LoweringContext,
    readback = false,
): LoweredSource {
    return {
        modulePath: path,
        symbolName: "createStorageBuffer",
        header: "",
        source: `#include <bblite/pal_gpu_storage_buffer.hpp>
${readback ? "#include <bblite/pal_gpu_storage_readback.hpp>" : ""}
namespace bbl {
namespace upstream {${storageBufferDescriptorCpp(context)}}
static double storage_buffer_registry_size(const Engine& engine) {
    return static_cast<double>(std::count_if(engine.storage_buffers.begin(),engine.storage_buffers.end(),[](const auto& record){return record.registered;}));
}
static std::vector<StorageBufferHandle> storage_buffer_registry_snapshot(const Engine& engine) {
    std::vector<StorageBufferHandle> result;
    for (std::uint32_t slot=0;slot<engine.storage_buffers.size();++slot)
        if (engine.storage_buffers[slot].registered) result.push_back(StorageBufferHandle{slot});
    return result;
}
struct SourceStorageBuffer final : pal::StorageBufferOwner {
${ownerMethod(context, "updateStorageBuffer", readback)}
${ownerMethod(context, "disposeStorageBuffer", readback)}
};
${disposal(context)}
${factory(context)}
}
`,
    };
}
