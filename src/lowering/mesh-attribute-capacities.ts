import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { bufferAlignmentCpp } from "./gpu-buffer-adapters.js";
import { meshCpuStreamFields } from "./mesh-cpu-streams.js";

/** The source's separate GPU allocations, retained beside native interleaved lanes. */
export function lowerMeshAttributeCapacities(
    context: LoweringContext,
    recovery = false,
): string {
    const prefix = recovery ? "recovered_mesh" : "uploaded_mesh";
    const mappedModule = "src/resource/mapped-buffer.ts";
    const mapped = context.functionDeclaration(
        mappedModule,
        "createMappedBuffer",
    );
    const size = context.findNodes(
        mapped.declaration,
        (node): node is ts.PropertyAssignment =>
            ts.isPropertyAssignment(node) &&
            node.name.getText(mapped.file) === "size",
    )[0];
    if (!size)
        return context.contractError(
            mapped.declaration,
            "Expected mapped buffer size.",
        );
    const mappedSize = new PinnedNumericLowerer(mapped.file, {
        bindings: new Map([
            ["data.byteLength", { cpp: "bytes", type: "scalar" }],
        ]),
        calls: new Map([
            ["align", (args) => `${prefix}_align(${args.join(", ")})`],
        ]),
    }).expression(size.initializer);
    const module = recovery
        ? "src/engine/recovery-rebuild.ts"
        : "src/mesh/mesh.ts";
    const name = recovery ? "uploadRetainedMesh" : "uploadMeshToGPU";
    const { file, declaration } = context.functionDeclaration(module, name);
    const attributes = [
        ["positionBuffer", "position"],
        ["normalBuffer", "normal"],
        ["uvBuffer", "uv"],
        ["uv2Buffer", "uv2"],
        ["tangentBuffer", "tangent"],
        ["colorBuffer", "color"],
    ] as const;
    const streams = [...meshCpuStreamFields]
        .filter(([, stream]) => stream !== "indices")
        .map(([field, stream]) => ({
            field,
            stream,
            optional: stream !== "positions" && stream !== "normals",
        }));
    const bindings = new Map<string, PinnedBinding>();
    for (const { stream, field, optional } of streams)
        for (const alias of [stream, `mesh.${field}`]) {
            const length = optional ? `${stream}.value()` : stream;
            bindings.set(alias, {
                cpp: length,
                type: "opaque",
                absentCpp: optional ? `!${stream}.has_value()` : "false",
            });
            bindings.set(`${alias}.length`, {
                cpp: length,
                type: "scalar",
            });
            bindings.set(`${alias}?.length`, {
                cpp: optional ? `(${stream}.value_or(0.0))` : stream,
                type: "scalar",
                ...(optional
                    ? {
                          absentCpp: `!${stream}.has_value() || !bbl::js::number_truthy(${stream}.value())`,
                      }
                    : {}),
            });
        }
    for (const [buffer, field] of attributes)
        bindings.set(buffer, { cpp: `buffers.${field}`, type: "scalar" });
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map(),
        foldConditions: false,
        expression(node, lowerer) {
            if (node.kind === ts.SyntaxKind.NullKeyword) return "0.0";
            if (!ts.isCallExpression(node)) return undefined;
            const call = node.expression.getText(file);
            if (call === "createMappedBuffer") {
                if (node.arguments.length !== 3)
                    return context.contractError(
                        node,
                        "Expected mesh mapped buffer allocation.",
                    );
                return `${prefix}_mapped_size(${lowerer.expression(node.arguments[1]!)} * sizeof(float))`;
            }
            if (call === "device.createBuffer") {
                const descriptor = node.arguments[0];
                if (!descriptor || !ts.isObjectLiteralExpression(descriptor))
                    return context.contractError(
                        node,
                        "Expected mesh buffer descriptor.",
                    );
                return lowerer.expression(
                    context.propertyInitializer(descriptor, "size"),
                );
            }
            return undefined;
        },
        statement(node, lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                if (node.declarationList.declarations.length !== 1)
                    return context.contractError(
                        node,
                        "Expected one mesh buffer declaration.",
                    );
                const variable = node.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name))
                    return context.contractError(
                        variable,
                        "Expected a named mesh buffer.",
                    );
                const variableName = variable.name.text;
                const aliases = new Map<string, string>([
                    ["device", "engine._device"],
                ]);
                if (recovery) {
                    aliases.set("positions", "mesh._cpuPositions!");
                    aliases.set("normals", "mesh._cpuNormals!");
                    aliases.set("uvs", "mesh._cpuUvs");
                    aliases.set(
                        "indices",
                        "mesh._cpuGpuIndices ?? mesh._cpuIndices!",
                    );
                }
                const alias = aliases.get(variableName);
                if (alias !== undefined) {
                    if (!variable.initializer)
                        return context.contractError(
                            variable,
                            "Expected mesh allocation owner.",
                        );
                    context.assertExpressionShape(
                        variable.initializer,
                        alias,
                        "Mesh allocation owner",
                    );
                    return [];
                }
                if (variableName === "indexBuffer") return [];
                const attribute = attributes.find(
                    ([buffer]) => buffer === variableName,
                );
                if (!attribute)
                    return context.contractError(
                        variable,
                        "Unrepresented mesh allocation variable.",
                    );
                return variable.initializer
                    ? [
                          `${indent}buffers.${attribute[1]} = ${lowerer.expression(variable.initializer)};`,
                      ]
                    : [];
            }
            if (
                ts.isExpressionStatement(node) &&
                ts.isCallExpression(node.expression) &&
                ts.isPropertyAccessExpression(node.expression.expression) &&
                node.expression.expression.name.text === "unmap"
            ) {
                context.assertExpressionShape(
                    node.expression,
                    "uvBuffer.unmap()",
                    "Mesh UV buffer publication",
                );
                return [];
            }
            return undefined;
        },
        returnValue(expression, lowerer) {
            if (!expression || !ts.isObjectLiteralExpression(expression))
                return context.contractError(
                    declaration,
                    "Expected mesh GPU allocations.",
                );
            const values = attributes.map(([buffer]) =>
                lowerer.expression(
                    context.propertyInitializer(expression, buffer),
                ),
            );
            return `MeshAttributeCapacities{${values.join(", ")}}`;
        },
    });
    return `${bufferAlignmentCpp(context, `${prefix}_align`)}
// ${context.provenance(mappedModule, "createMappedBuffer", "allocation size")}
static double ${prefix}_mapped_size(double bytes) { return ${mappedSize}; }
// ${context.provenance(module, name, "attribute allocations")}
static MeshAttributeCapacities ${prefix}_attribute_capacities(${streams.map(({ stream, optional }) => `${optional ? "std::optional<double>" : "double"} ${stream}`).join(", ")}) {
    [[maybe_unused]] MeshAttributeCapacities buffers;
${body}
}
`;
}
