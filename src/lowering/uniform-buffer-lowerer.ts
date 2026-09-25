import type { PinnedCallSpelling } from "./pinned-numeric-lowerer.js";
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import { unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import {
    bufferAlignmentCpp,
    assertMappedBufferAdapter,
} from "./gpu-buffer-adapters.js";

const path = "src/compute/compute-uniform-buffer.ts";

function factory(context: LoweringContext): string {
    assertMappedBufferAdapter(context);
    const { file, declaration } = context.functionDeclaration(
        path,
        "createUniformBuffer",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["source", { cpp: "source.byte_length", type: "scalar" }],
        ["source.byteLength", { cpp: "source.byte_length", type: "scalar" }],
        [
            "engine._device.limits.maxBufferSize",
            {
                cpp: "engine->offscreen_run->device().maximum_storage_buffer_size()",
                type: "scalar",
            },
        ],
        ["bytes", { cpp: "bytes", type: "opaque" }],
        ["buffer", { cpp: "buffer", type: "opaque" }],
        ["engine", { cpp: "engine", type: "opaque" }],
    ]);
    const calls = new Map<string, PinnedCallSpelling>();
    calls.set("align", (args) => `uniform_buffer_align(${args.join(", ")})`);
    calls.set(
        "Number.isSafeInteger",
        (args) => `js::number_is_safe_integer(${args.join(", ")})`,
    );
    calls.set(
        "hooked.has",
        () => "static_cast<bool>(engine->dispose_uniform_buffers)",
    );
    calls.set("hooked.add", () => "void()");
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls,

        foldConditions: false,
        callShapes: new Map([
            ["Number.isSafeInteger", "bool"],
            ["hooked.has", "bool"],
        ]),
        expression(node) {
            if (
                context.expressionMatchesShape(
                    node,
                    'typeof source === "number"',
                )
            )
                return "source.numeric";
            if (
                context.expressionMatchesShape(
                    node,
                    'typeof source !== "number"',
                )
            )
                return "!source.numeric";
            if (!ts.isCallExpression(node)) return undefined;
            if (
                context.expressionMatchesShape(
                    node,
                    "buffersFor(engine).add(buffer)",
                )
            )
                return "register_uniform_buffer(engine, buffer)";
            if (
                context.expressionMatchesShape(
                    node,
                    "registerManagedResourceDisposer(engine, () => _disposeUniformBuffers(engine))",
                )
            )
                return "(engine->dispose_uniform_buffers = [weak = std::weak_ptr<Engine>(engine)] { if (auto owner = weak.lock()) if (auto buffers = owner->uniform_buffers.lock()) dispose_uniform_buffers(buffers); }, register_managed_resource_disposer(*engine, engine->dispose_uniform_buffers))";
            return undefined;
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
                if (name === "bytes") {
                    context.assertExpressionShape(
                        value,
                        "new Uint8Array(byteLength)",
                        "Uniform CPU staging",
                    );
                    return [
                        `${indent}js::U8Array bytes(static_cast<std::size_t>(byteLength));`,
                    ];
                }
                if (name === "buffer") {
                    context.assertExpressionShape(
                        value,
                        "{byteLength}",
                        "Uniform wrapper identity",
                    );
                    return [
                        `${indent}auto buffer = std::make_shared<UniformBuffer>();`,
                        `${indent}buffer->byte_length = byteLength;`,
                        `${indent}buffer->run = engine->offscreen_run;`,
                    ];
                }
                if (name === "hooked") {
                    context.assertExpressionShape(
                        value,
                        "_hookedEngines ??= new WeakSet()",
                        "Uniform disposer registration identity",
                    );
                    return [];
                }
            }
            if (
                !ts.isExpressionStatement(node) ||
                !ts.isCallExpression(node.expression)
            )
                return undefined;
            const call = node.expression;
            if (
                context.expressionMatchesShape(
                    call,
                    "bytes.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength))",
                )
            )
                return [
                    `${indent}std::copy(source.bytes.begin(), source.bytes.end(), bytes.begin());`,
                ];
            if (call.expression.getText(file) !== "Object.defineProperties")
                return undefined;
            context.assertExpressionShape(
                call.arguments[0]!,
                "buffer",
                "Uniform descriptor owner",
            );
            const properties = call.arguments[1];
            if (!properties || !ts.isObjectLiteralExpression(properties))
                return context.contractError(
                    call,
                    "Expected uniform buffer descriptors.",
                );
            const expected = new Set([
                    "_buffer",
                    "_destroyed",
                    "_data",
                    "_engine",
                ]),
                lines: string[] = [];
            for (const property of properties.properties) {
                if (
                    !ts.isPropertyAssignment(property) ||
                    !ts.isObjectLiteralExpression(property.initializer)
                )
                    return context.contractError(
                        property,
                        "Expected uniform descriptor value.",
                    );
                const name = context.propertyName(property.name);
                if (!name || !expected.delete(name))
                    return context.contractError(
                        property,
                        "Unexpected uniform descriptor.",
                    );
                const value = context.propertyInitializer(
                    property.initializer,
                    "value",
                );
                if (name === "_buffer") {
                    context.assertExpressionShape(
                        value,
                        "createMappedBuffer(engine, bytes, BU.UNIFORM, options?.label)",
                        "Uniform mapped allocation",
                    );
                    lines.push(
                        `${indent}buffer->allocation = engine->offscreen_run->device().create_storage_buffer({static_cast<std::size_t>(byteLength), static_cast<std::uint32_t>(pal::StorageBufferRole::uniform), label.value_or(std::string{})}, std::span<const std::uint8_t>(bytes.data(), bytes.size()));`,
                    );
                } else {
                    const member = {
                        _destroyed: "destroyed",
                        _data: "data",
                        _engine: "engine",
                    }[name];
                    lines.push(
                        `${indent}buffer->${member} = ${lowerer.expression(value)};`,
                    );
                }
            }
            if (expected.size)
                return context.contractError(
                    properties,
                    "Missing uniform descriptor.",
                );
            return lines;
        },
        returnValue: (node, lowerer) => (node ? lowerer.expression(node) : ""),
    });
    return `// ${context.provenance(path, "createUniformBuffer")}
std::shared_ptr<UniformBuffer> create_uniform_buffer(std::shared_ptr<Engine> engine, StorageBufferSource source,std::optional<std::string> label) {
    if (!engine || !engine->offscreen_run) throw std::runtime_error("Uniform buffer has no engine device.");
${body}
}
`;
}

function operation(
    context: LoweringContext,
    name:
        | "_getUniformBufferHandle"
        | "updateUniformBuffer"
        | "disposeUniformBuffer",
): string {
    const { file, declaration } = context.functionDeclaration(path, name);
    const disposal = name === "disposeUniformBuffer";
    const bindings = new Map<string, PinnedBinding>([
        ["buffer._destroyed", { cpp: "buffer->destroyed", type: "bool" }],
        [
            "buffer._buffer",
            {
                cpp: "buffer->allocation",
                type: "opaque",
                absentCpp: "!buffer->allocation",
            },
        ],
        [
            "buffer._data",
            { cpp: "buffer->data", type: "opaque", absentCpp: "!buffer->data" },
        ],
        ["buffer._engine", { cpp: "buffer->engine.lock()", type: "opaque" }],
        [
            "buffer._engine._resourceEpoch",
            { cpp: "engine->resource_epoch", type: "scalar" },
        ],
        ["buffer.byteLength", { cpp: "buffer->byte_length", type: "scalar" }],
        ["engine", { cpp: "engine", type: "opaque" }],
        ["buffer", { cpp: "buffer", type: "opaque" }],
        ["byteOffset", { cpp: "offset", type: "scalar" }],
        [
            "data.byteLength",
            { cpp: "static_cast<double>(data.size())", type: "scalar" },
        ],
        [
            "buffers.size",
            {
                cpp: "static_cast<double>(buffers->buffers.size())",
                type: "scalar",
            },
        ],
    ]);
    const calls = new Map<string, PinnedCallSpelling>();
    calls.set(
        "Number.isInteger",
        (args) => `js::number_is_integer(${args.join(", ")})`,
    );
    calls.set(
        "_getUniformBufferHandle",
        (args) => `get_uniform_buffer_handle(${args.join(", ")})`,
    );
    calls.set(
        "buffers.delete",
        (args) => `buffers->buffers.erase(${args.join(", ")})`,
    );
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls,

        callShapes: new Map([["Number.isInteger", "bool"]]),
        expression(node) {
            if (
                context.expressionMatchesShape(
                    node,
                    "_buffers?.get(engine)?.has(buffer)",
                ) ||
                context.expressionMatchesShape(node, "buffers?.has(buffer)")
            )
                return "(buffers && buffers->buffers.contains(buffer))";
            if (
                context.expressionMatchesShape(
                    node,
                    "buffer._engine._resourceEpoch ?? 0",
                )
            )
                return "engine->resource_epoch";
            if (
                context.expressionMatchesShape(
                    node,
                    "_buffers?.delete(buffer._engine)",
                )
            )
                return "remove_uniform_registry(buffers)";
            return undefined;
        },
        statement(node, _lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const entries = node.declarationList.declarations;
                if (
                    entries.length !== 1 ||
                    !ts.isIdentifier(entries[0]!.name) ||
                    entries[0]!.name.text !== "buffers" ||
                    !entries[0]!.initializer
                )
                    return undefined;
                context.assertExpressionShape(
                    entries[0]!.initializer,
                    '"_engine" in buffer ? _buffers?.get(buffer._engine) : undefined',
                    "Uniform registry lookup",
                );
                return [];
            }
            if (!ts.isExpressionStatement(node)) return undefined;
            const expression = unwrapExpression(node.expression);
            for (const [shape, cpp] of [
                [
                    "engine._device.queue.writeBuffer(buffer._buffer!, byteOffset, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)",
                    "buffer->run->device().write_buffer(buffer->allocation, offset, data);",
                ],
                [
                    "buffer._data!.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), byteOffset)",
                    "std::copy(data.begin(), data.end(), buffer->data->begin() + static_cast<std::ptrdiff_t>(offset));",
                ],
                [
                    "buffer._buffer?.destroy()",
                    "if (buffer->allocation) buffer->allocation->destroy();",
                ],
                ["buffer._buffer = null", "buffer->allocation.reset();"],
                ["buffer._data = null", "buffer->data.reset();"],
            ])
                if (context.expressionMatchesShape(expression, shape!))
                    return [`${indent}${cpp}`];
            return undefined;
        },
        returnValue: (node, lowerer) => (node ? lowerer.expression(node) : ""),
    });
    const signature =
        name === "_getUniformBufferHandle"
            ? "std::shared_ptr<pal::StorageBufferAllocation> get_uniform_buffer_handle(const std::shared_ptr<Engine>& engine, const std::shared_ptr<UniformBuffer>& buffer)"
            : name === "updateUniformBuffer"
              ? "void update_uniform_buffer(const std::shared_ptr<Engine>& engine,const std::shared_ptr<UniformBuffer>& buffer,std::span<const std::uint8_t> data,double offset)"
              : "void dispose_uniform_buffer(const std::shared_ptr<UniformBuffer>& buffer)";
    return `// ${context.provenance(path, name)}
${signature} {
    ${disposal ? "const auto engine = buffer->engine.lock();" : ""}
    ${name !== "updateUniformBuffer" ? "const auto buffers = buffer->registry.lock();" : ""}
${body}
}
`;
}

export function lowerUniformBuffer(context: LoweringContext): LoweredSource {
    const dispose = context.functionDeclaration(path, "_disposeUniformBuffers");
    const disposal = lowerPinnedBody(
        dispose.file,
        dispose.declaration.body!.statements,
        {
            bindings: new Map(),
            calls: new Map([
                [
                    "disposeUniformBuffer",
                    (args) => `dispose_uniform_buffer(${args.join(", ")})`,
                ],
            ]),
            forOf(iterated, element) {
                if (iterated !== "[...(_buffers?.get(engine) ?? [])]")
                    return undefined;
                return {
                    range: "snapshot",
                    bindings: new Map([
                        [element, { cpp: element, type: "opaque" }],
                    ]),
                };
            },
        },
    );
    return {
        modulePath: path,
        symbolName: "createUniformBuffer",
        header: "",
        source: `#include <bblite/pal_uniform_buffer.hpp>
namespace bbl {
${bufferAlignmentCpp(context, "uniform_buffer_align")}
static void register_uniform_buffer(const std::shared_ptr<Engine>& engine,const std::shared_ptr<UniformBuffer>& buffer) {
    auto registry=engine->uniform_buffers.lock();
    if(!registry){registry=std::make_shared<UniformBufferRegistry>();registry->engine=engine;engine->uniform_buffers=registry;engine->native_resource_owners.push_back(registry);}
    registry->buffers.insert(buffer);buffer->registry=registry;
}
static void remove_uniform_registry(const std::shared_ptr<UniformBufferRegistry>& registry) {
    if(auto engine=registry->engine.lock()){engine->uniform_buffers.reset();std::erase(engine->native_resource_owners,registry);}
}
${operation(context, "_getUniformBufferHandle")}
${operation(context, "updateUniformBuffer")}
${operation(context, "disposeUniformBuffer")}
// ${context.provenance(path, "_disposeUniformBuffers")}
void dispose_uniform_buffers(const std::shared_ptr<UniformBufferRegistry>& registry) {
    const auto snapshot=registry->buffers;
${disposal}
}
${factory(context)}
}
`,
    };
}
