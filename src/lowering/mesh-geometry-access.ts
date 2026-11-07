import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import { unwrapExpression } from "./gltf/shared.js";

const streams = [
    ["positions", "_cpuPositions"],
    ["normals", "_cpuNormals"],
    ["uvs", "_cpuUvs"],
    ["uvs2", "_cpuUv2s"],
    ["tangents", "_cpuTangents"],
    ["colors", "_cpuColors"],
] as const;

/** Retained native vertex lanes adapt source CPU streams; source guards and copies own the API. */
export function lowerMeshGeometryAccess(context: LoweringContext): string {
    const module = "src/mesh/get-mesh-geometry.ts";
    const names = [...streams.map(([name]) => name), "indices"];
    const bindings = new Map<string, PinnedBinding>(
        names.map((name) => [
            name,
            {
                cpp: name,
                type: "opaque",
                absentCpp: `!${name}`,
            },
        ]),
    );
    const methods = ["getMeshGeometry", "getMeshTriangles"].map((name) => {
        const { file, declaration } = context.functionDeclaration(module, name);
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            calls: new Map(),
            expression(node) {
                if (context.expressionMatchesShape(node, "tangents?.length"))
                    return "(tangents ? tangents.size() : 0u)";
                return undefined;
            },
            statement(node, numeric, indent) {
                if (ts.isVariableStatement(node)) {
                    const variable = node.declarationList.declarations[0];
                    if (
                        !variable?.initializer ||
                        !ts.isIdentifier(variable.name)
                    )
                        return undefined;
                    const local = variable.name.text;
                    const property =
                        local === "indices"
                            ? "_cpuIndices"
                            : streams.find(([stream]) => stream === local)?.[1];
                    if (!property) return undefined;
                    context.assertExpressionShape(
                        variable.initializer,
                        `mesh.${property}`,
                        "Retained geometry stream read",
                    );
                    return [
                        `${indent}const auto& ${local} = retained.${local};`,
                    ];
                }
                if (!ts.isReturnStatement(node) || !node.expression)
                    return undefined;
                if (node.expression.kind === ts.SyntaxKind.NullKeyword)
                    return [`${indent}return std::nullopt;`];
                if (!ts.isObjectLiteralExpression(node.expression))
                    return undefined;
                const result = [`${indent}MeshCpuGeometry result;`];
                const assignment = (
                    property: ts.ObjectLiteralElementLike,
                    prefix: string,
                ): string => {
                    if (
                        !ts.isPropertyAssignment(property) ||
                        !ts.isIdentifier(property.name) ||
                        !names.includes(property.name.text)
                    )
                        return context.contractError(
                            property,
                            "Expected a retained geometry stream copy.",
                        );
                    const field = property.name.text;
                    context.assertExpressionShape(
                        property.initializer,
                        `${field}.slice()`,
                        "Caller-owned geometry stream copy",
                    );
                    return `${prefix}result.${field} = js::${field === "indices" ? "U32Array" : "F32Array"}(${field}.copy());`;
                };
                for (const property of node.expression.properties) {
                    if (!ts.isSpreadAssignment(property)) {
                        result.push(assignment(property, indent));
                        continue;
                    }
                    const spread = unwrapExpression(property.expression);
                    if (
                        !ts.isConditionalExpression(spread) ||
                        !ts.isObjectLiteralExpression(spread.whenTrue) ||
                        !ts.isObjectLiteralExpression(spread.whenFalse) ||
                        spread.whenFalse.properties.length !== 0
                    )
                        return context.contractError(
                            property,
                            "Expected an optional retained stream spread.",
                        );
                    const condition = ts.factory.createConditionalExpression(
                        spread.condition,
                        undefined,
                        ts.factory.createTrue(),
                        undefined,
                        ts.factory.createFalse(),
                    );
                    result.push(
                        `${indent}if (${numeric.expression(condition)}) {`,
                    );
                    result.push(
                        ...spread.whenTrue.properties.map((field) =>
                            assignment(field, indent + "    "),
                        ),
                    );
                    result.push(`${indent}}`);
                }
                result.push(`${indent}return result;`);
                return result;
            },
        });
        return `// ${context.provenance(module, name)}
std::optional<MeshCpuGeometry> ${name === "getMeshGeometry" ? "get_mesh_geometry" : "get_mesh_triangles"}(const Engine& engine, MeshHandle mesh) {
    const auto& record = ${recordAt("engine.meshes", "mesh")};
    const MeshCpuStreamsView retained(record, &engine.geometries.at(record.geometry));
${body}
}`;
    });
    return methods.join("\n");
}
