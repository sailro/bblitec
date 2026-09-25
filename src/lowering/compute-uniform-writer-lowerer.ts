import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import {
    type LoweringContext,
    type LoweredSource,
    unwrapExpression,
} from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import type {
    PinnedBinding,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";

const path = "src/compute/compute-uniform-writer.ts";
const fields: Record<string, string> = {
    type: "type",
    offset: "offset",
    byteLength: "byte_length",
    elementCount: "element_count",
    rowCount: "row_count",
    columnStride: "column_stride",
    scalar: "scalar",
    kind: "kind",
};
const writerFields: Record<string, string> = {
    arena: "arena",
    slot: "slot",
    layout: "layout",
    _baseOffset: "base_offset",
    _f32: "f32",
    _u32: "u32",
    _i32: "i32",
    _dataView: "data_view",
    _f16Scratch: "f16_scratch",
};
const functions: Record<
    string,
    { cpp: string; result: string; parameters: string }
> = {
    alignUp: {
        cpp: "uniform_writer_align",
        result: "double",
        parameters: "double value,double alignment",
    },
    scalarByteLength: {
        cpp: "uniform_scalar_byte_length",
        result: "double",
        parameters: "double scalar",
    },
    _createComputeUniformWriter: {
        cpp: "make_uniform_writer",
        result: "std::shared_ptr<ComputeUniformWriter>",
        parameters:
            "const std::shared_ptr<ComputeUniformArena>& arena,double slot,const std::shared_ptr<const ComputeUniformLayout>& layout,std::optional<js::DataView> f16Scratch = {}",
    },
    createComputeUniformWriter: {
        cpp: "create_compute_uniform_writer",
        result: "std::shared_ptr<ComputeUniformWriter>",
        parameters:
            "const std::shared_ptr<ComputeUniformArena>& arena,double slot,const std::shared_ptr<const ComputeUniformLayout>& layout",
    },
    getField: {
        cpp: "uniform_writer_field",
        result: "const ComputeUniformFieldSlot*",
        parameters:
            "const std::shared_ptr<ComputeUniformWriter>& writer,const std::string& name",
    },
    expectFieldKind: {
        cpp: "uniform_expect_field_kind",
        result: "void",
        parameters:
            "const ComputeUniformFieldSlot* field,double kind,const std::string& setter",
    },
    expectScalar: {
        cpp: "uniform_expect_scalar",
        result: "void",
        parameters:
            "const ComputeUniformFieldSlot* field,double scalar,const std::string& setter",
    },
    markDirty: {
        cpp: "uniform_mark_dirty",
        result: "void",
        parameters:
            "const std::shared_ptr<ComputeUniformWriter>& writer,const ComputeUniformFieldSlot* field",
    },
    writeElement: {
        cpp: "uniform_write_element",
        result: "void",
        parameters:
            "const std::shared_ptr<ComputeUniformWriter>& writer,double scalar,double byteOffset,double value",
    },
    writeScalar: {
        cpp: "uniform_write_scalar",
        result: "void",
        parameters:
            "const std::shared_ptr<ComputeUniformWriter>& writer,const ComputeUniformFieldSlot* field,double value",
    },
    expectElementCount: {
        cpp: "uniform_expect_element_count",
        result: "void",
        parameters:
            "const ComputeUniformFieldSlot* field,UniformNumericView value,const std::string& setter",
    },
    writeVector: {
        cpp: "uniform_write_vector",
        result: "void",
        parameters:
            "const std::shared_ptr<ComputeUniformWriter>& writer,const ComputeUniformFieldSlot* field,UniformNumericView value",
    },
    writeMatrix: {
        cpp: "uniform_write_matrix",
        result: "void",
        parameters:
            "const std::shared_ptr<ComputeUniformWriter>& writer,const ComputeUniformFieldSlot* field,UniformNumericView value",
    },
};
for (const type of ["F32", "U32", "I32", "Vector", "Matrix"]) {
    functions[`setComputeUniform${type}`] = {
        cpp: `set_compute_uniform_${type.toLowerCase()}`,
        result: "void",
        parameters: `const std::shared_ptr<ComputeUniformWriter>& writer,const std::string& name,${type === "Vector" || type === "Matrix" ? "UniformNumericView" : "double"} value`,
    };
}

function scope(
    context: LoweringContext,
    file: ts.SourceFile,
    name: string,
): PinnedNumericScope {
    const bindings = new Map<string, PinnedBinding>();
    for (const param of ["slot", "value", "alignment", "scalar", "kind"])
        bindings.set(param, { cpp: param, type: "scalar" });
    if (name === "writeElement")
        bindings.set("byteOffset", { cpp: "byteOffset", type: "scalar" });
    for (const param of ["arena", "layout", "writer", "name", "setter"])
        bindings.set(param, { cpp: param, type: "opaque" });
    bindings.set("field", {
        cpp: "field",
        type: "opaque",
        absentCpp: "field == nullptr",
    });
    bindings.set("f16Scratch", {
        cpp: "f16Scratch",
        type: "opaque",
        absentCpp: "!f16Scratch.has_value()",
    });
    bindings.set("_writeF16", {
        cpp: "uniform_write_f16",
        type: "opaque",
        absentCpp: "!uniform_write_f16",
    });
    bindings.set("writer._f16Scratch", {
        cpp: "writer->f16_scratch",
        type: "opaque",
        absentCpp: "!writer->f16_scratch.has_value()",
    });
    bindings.set("writer.arena._destroyed", {
        cpp: "writer->arena->destroyed",
        type: "bool",
    });
    bindings.set("writer.arena.buffer._destroyed", {
        cpp: "writer->arena->buffer->destroyed",
        type: "bool",
    });
    bindings.set("writer.arena.buffer._data", {
        cpp: "writer->arena->buffer->data",
        type: "opaque",
        absentCpp: "!writer->arena->buffer->data.has_value()",
    });
    for (const [key, cpp] of Object.entries(fields))
        bindings.set(`field.${key}`, {
            cpp: `field->${cpp}`,
            type: key === "type" ? "opaque" : "scalar",
        });
    for (const [key, cpp] of [
        ["layout.byteLength", "layout->byte_length"],
        ["arena.slotByteLength", "arena->slot_byte_length"],
        ["writer._baseOffset", "writer->base_offset"],
        ["writer.arena._dirtyStart", "writer->arena->dirty_start"],
        ["writer.arena._dirtyEnd", "writer->arena->dirty_end"],
    ])
        bindings.set(key!, { cpp: cpp!, type: "scalar" });
    if (
        [
            "expectElementCount",
            "writeVector",
            "writeMatrix",
            "setComputeUniformVector",
            "setComputeUniformMatrix",
        ].includes(name)
    )
        bindings.set("value", { cpp: "value", type: "f64-list" });
    const calls = pinnedNumericMathCalls();
    for (const [symbol, fn] of Object.entries(functions))
        calls.set(symbol, (args) => `${fn.cpp}(${args.join(", ")})`);
    calls.set(
        "getComputeUniformSlotOffset",
        (args) => `compute_uniform_slot_offset(${args.join(", ")})`,
    );
    calls.set("Object.freeze", (args) => args[0]!);
    calls.set("_writeF16", (args) => `uniform_write_f16(${args.join(", ")})`);
    return {
        bindings,
        calls,

        expression(node, lowerer) {
            if (ts.isStringLiteralLike(node)) return stringLiteral(node.text);
            if (
                ts.isPropertyAccessExpression(node) &&
                node.getText(file) === "value.length"
            )
                return "static_cast<double>(value.size())";
            if (
                ts.isElementAccessExpression(node) &&
                node.expression.getText(file) === "value"
            )
                return `value[static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)})]`;
            if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
                const cpp: Record<string, string> = {
                    F32: "js::TypedArray<float>",
                    U32: "js::TypedArray<std::uint32_t>",
                    I32: "js::TypedArray<std::int32_t>",
                    DV: "js::DataView",
                };
                const type = cpp[node.expression.text];
                if (!type) return undefined;
                const args = node.arguments;
                if (!args || args.length !== 3)
                    return context.contractError(
                        node,
                        "Expected a uniform staging view.",
                    );
                context.assertExpressionShape(
                    args[0]!,
                    "data.buffer",
                    "Uniform staging view buffer",
                );
                context.assertExpressionShape(
                    args[1]!,
                    "data.byteOffset",
                    "Uniform staging view offset",
                );
                context.assertExpressionShape(
                    args[2]!,
                    node.expression.text === "DV"
                        ? "data.byteLength"
                        : "data.byteLength / 4",
                    "Uniform staging view length",
                );
                return `${type}(data.buffer(), ${node.expression.text === "DV" ? "data.byte_offset()" : "static_cast<double>(data.byte_offset())"}, ${node.expression.text === "DV" ? "data.byte_length()" : "static_cast<double>(data.byte_length()) / 4.0"})`;
            }
            return undefined;
        },
        forOf(iterated, element) {
            if (iterated !== "layout._fields.values()") return undefined;
            return {
                range: "layout->fields",
                bindings: new Map(
                    Object.entries(fields).map(([key, cpp]) => [
                        `${element}.${key}`,
                        {
                            cpp: `${element}.second.${cpp}`,
                            type: key === "type" ? "opaque" : "scalar",
                        } as const,
                    ]),
                ),
            };
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
                const id = declaration.name.text,
                    value = unwrapExpression(declaration.initializer);
                if (id === "writer") {
                    context.assertExpressionShape(
                        value,
                        "{}",
                        "Uniform writer record",
                    );
                    return [
                        `${indent}auto writer = js::make_gc_shared<ComputeUniformWriter>();`,
                    ];
                }
                if (id === "data") {
                    context.assertExpressionShape(
                        value,
                        "arena.buffer._data!",
                        "Uniform staging storage",
                    );
                    return [
                        `${indent}auto data = arena->buffer->data.value();`,
                    ];
                }
                if (id === "field") {
                    if (
                        ts.isCallExpression(value) &&
                        value.expression.getText(file) === "getField"
                    )
                        return [
                            `${indent}const auto* field = ${lowerer.expression(value)};`,
                        ];
                    context.assertExpressionShape(
                        value,
                        "writer.layout._fields.get(name)",
                        "Uniform field lookup",
                    );
                    return [
                        `${indent}const ComputeUniformFieldSlot* field = nullptr;`,
                        `${indent}for (const auto& [key, entry] : writer->layout->fields) { if (key == name) { field = &entry; break; } }`,
                    ];
                }
            }
            if (!ts.isExpressionStatement(node)) return undefined;
            const expression = unwrapExpression(node.expression);
            if (
                ts.isCallExpression(expression) &&
                expression.expression.getText(file) ===
                    "Object.defineProperties"
            ) {
                if (
                    expression.arguments.length !== 2 ||
                    expression.arguments[0]!.getText(file) !== "writer" ||
                    !ts.isObjectLiteralExpression(expression.arguments[1]!)
                )
                    return context.contractError(
                        expression,
                        "Expected uniform writer descriptors.",
                    );
                const expected = new Set(Object.keys(writerFields)),
                    lines: string[] = [];
                for (const property of expression.arguments[1].properties) {
                    if (
                        !ts.isPropertyAssignment(property) ||
                        !ts.isObjectLiteralExpression(property.initializer)
                    )
                        return context.contractError(
                            property,
                            "Expected uniform writer property descriptor.",
                        );
                    const key = context.propertyName(property.name);
                    if (!key || !expected.delete(key))
                        return context.contractError(
                            property,
                            "Unexpected uniform writer property.",
                        );
                    let initializer: ts.Expression | undefined;
                    for (const item of property.initializer.properties) {
                        if (!ts.isPropertyAssignment(item))
                            return context.contractError(
                                item,
                                "Expected uniform descriptor field.",
                            );
                        const attribute = context.propertyName(item.name);
                        if (attribute === "value")
                            initializer = item.initializer;
                        else if (
                            attribute !== "enumerable" ||
                            item.initializer.kind !== ts.SyntaxKind.TrueKeyword
                        )
                            return context.contractError(
                                item,
                                "Unsupported uniform descriptor attribute.",
                            );
                    }
                    if (!initializer)
                        return context.contractError(
                            property,
                            "Missing uniform descriptor value.",
                        );
                    lines.push(
                        `${indent}writer->${writerFields[key]} = ${lowerer.expression(initializer)};`,
                    );
                }
                if (expected.size)
                    return context.contractError(
                        expression,
                        "Missing uniform writer descriptors.",
                    );
                return lines;
            }
            if (
                ts.isBinaryExpression(expression) &&
                expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isElementAccessExpression(expression.left)
            ) {
                const target = expression.left.expression.getText(file),
                    cpp: Record<string, string> = {
                        "writer._f32": "f32",
                        "writer._u32": "u32",
                        "writer._i32": "i32",
                    };
                const member = cpp[target];
                if (!member) return undefined;
                const index = lowerer.expression(
                        expression.left.argumentExpression,
                    ),
                    value = lowerer.expression(expression.right);
                const converted =
                    member === "f32"
                        ? `static_cast<float>(${value})`
                        : `js::to_${member === "u32" ? "uint32" : "int32"}(${value})`;
                return [
                    `${indent}writer->${member}.store(static_cast<std::size_t>(${index}), ${converted});`,
                ];
            }
            return undefined;
        },
    };
}

export function lowerComputeUniformWriter(
    context: LoweringContext,
): LoweredSource {
    const output: string[] = [];
    for (const [name, fn] of Object.entries(functions)) {
        const { file, declaration } = context.functionDeclaration(path, name);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            ...scope(context, file, name),
            returnValue: (node, lowerer) =>
                node ? lowerer.expression(node) : "",
        });
        output.push(
            `// ${context.provenance(path, name)}\n${fn.cpp.startsWith("uniform_") || name === "_createComputeUniformWriter" ? "static " : ""}${fn.result} ${fn.cpp}(${fn.parameters}) {\n${body}\n}`,
        );
    }
    return {
        modulePath: path,
        symbolName: "createComputeUniformWriter",
        header: "",
        source: `#include <bblite/pal_compute_uniform_writer.hpp>\nnamespace bbl {\nstatic std::function<void(const std::shared_ptr<ComputeUniformWriter>&,double,double)> uniform_write_f16;\n${output.join("\n")}\n}\n`,
    };
}
