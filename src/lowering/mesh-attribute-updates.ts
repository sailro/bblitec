import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

/** Pinned range validation and wrappers; PAL only scatters attribute bytes. */
export function lowerMeshAttributeUpdates(context: LoweringContext): string {
    const module = "src/mesh/mesh-factories.ts";
    const updates = [
        ["updateMeshPositions", "positions", "positions"],
        ["updateMeshUvs", "uvs", "uvs"],
        ["updateMeshNormals", "normals", "normals"],
        ["updateMeshColors", "colors", "colors"],
        ["updateMeshTangents", "tangents", "tangents"],
        ["updateMeshUv2", "uv2", "uvs2"],
    ] as const;
    const signatures = [
        [
            "writeVertexAttributeRange",
            "static void write_vertex_attribute_range(Engine& engine, MeshHandle mesh, pal::MeshAttributeBuffer buffer, const js::F32Array& values, double components, double vertexOffset, std::optional<double> vertexCount, double sourceVertexOffset)",
        ],
        ...updates.map(
            ([name, suffix, values]) =>
                [
                    name,
                    `void update_mesh_${suffix}(Engine& engine, MeshHandle mesh, const js::F32Array& ${values}, double vertexOffset, std::optional<double> vertexCount, double sourceVertexOffset)`,
                ] as const,
        ),
    ] as const;
    return signatures
        .map(([name, signature]) => {
            const { file, declaration } = context.functionDeclaration(
                module,
                name,
            );
            if (name !== "writeVertexAttributeRange") {
                for (const index of [3, 5])
                    context.assertExpressionShape(
                        declaration.parameters[index]!.initializer!,
                        "0",
                        "Attribute range default",
                    );
                if (declaration.parameters[4]!.initializer)
                    context.contractError(
                        declaration.parameters[4]!,
                        "Expected an absent vertexCount default.",
                    );
            }
            const bindings = new Map<string, PinnedBinding>();
            const bind = (
                name: string,
                cpp: string,
                type: PinnedBinding["type"] = "opaque",
                absentCpp?: string,
            ) => {
                bindings.set(name, {
                    cpp,
                    type,
                    ...(absentCpp ? { absentCpp } : {}),
                });
            };
            for (const value of [
                "engine",
                "mesh",
                "buffer",
                "values",
                "positions",
                "uvs",
                "normals",
                "colors",
                "tangents",
                "uvs2",
            ])
                bind(value, value);
            for (const value of [
                "components",
                "vertexOffset",
                "sourceVertexOffset",
            ])
                bind(value, value, "scalar");
            if (name === "writeVertexAttributeRange")
                bindings.set("vertexCount", {
                    cpp: "vertexCount.value()",
                    type: "scalar",
                    nullish: "!vertexCount.has_value()",
                });
            else
                bind(
                    "vertexCount",
                    "vertexCount",
                    "opaque",
                    "!vertexCount.has_value()",
                );
            const geometry = `engine.geometries.at(${recordAt("engine.meshes", "mesh")}.geometry)`;
            bind("mesh._gpu", geometry);
            bind(
                "mesh._gpu._vbLayout",
                `!${geometry}.owned_packed_geometry`,
                "bool",
            );
            bind(
                "mesh._gpu._ownsVertexBuffers",
                `${geometry}.owned_packed_geometry`,
                "bool",
            );
            bind(
                "mesh._gpu._refCount",
                `static_cast<double>(${geometry}.owners)`,
                "scalar",
                "false",
            );
            bind("mesh.name", `${recordAt("engine.meshes", "mesh")}.name`);
            for (const owner of ["mesh._gpu", "gpu"]) {
                for (const [buffer, attribute] of [
                    ["positionBuffer", "Position"],
                    ["normalBuffer", "Normal"],
                    ["uvBuffer", "Uv"],
                    ["uv2Buffer", "Uv2"],
                    ["tangentBuffer", "Tangent"],
                    ["colorBuffer", "Color"],
                ])
                    bind(
                        `${owner}.${buffer}`,
                        `pal::MeshAttributeBuffer{&${geometry}, pal::MeshAttribute::${attribute}}`,
                    );
            }
            bind(
                "values.length",
                "static_cast<double>(values.size())",
                "scalar",
            );
            bind("values.buffer", "values");
            bind("values.byteOffset", "0.0", "scalar");
            bind("buffer.size", "buffer.size()", "scalar");
            const calls = new Map<string, (args: readonly string[]) => string>([
                [
                    "Number.isInteger",
                    (args) => `bbl::js::number_is_integer(${args[0]})`,
                ],
                [
                    "writeVertexAttributeRange",
                    (args) =>
                        `write_vertex_attribute_range(${args.join(", ")})`,
                ],
                [
                    "engine._device.queue.writeBuffer",
                    (args) =>
                        `pal::write_mesh_attribute_bytes(${args.join(", ")})`,
                ],
                [
                    "_markWorldMatrixDirty",
                    (args) =>
                        `++${recordAt("engine.meshes", args[0]!)}.transform_version`,
                ],
            ]);
            const body = lowerPinnedBody(file, declaration.body!.statements, {
                bindings,
                calls,
                foldConditions: false,
                statement(node, lowerer, indent) {
                    if (!ts.isVariableStatement(node)) return undefined;
                    const variable = node.declarationList.declarations[0];
                    if (
                        node.declarationList.declarations.length !== 1 ||
                        !variable?.initializer ||
                        !ts.isIdentifier(variable.name)
                    )
                        return undefined;
                    if (variable.name.text === "gpu") {
                        context.assertExpressionShape(
                            variable.initializer,
                            "mesh._gpu",
                            "GPU geometry owner",
                        );
                        return [
                            `${indent}[[maybe_unused]] const auto& gpu = ${lowerer.expression(variable.initializer)};`,
                        ];
                    }
                    return undefined;
                },
            });
            return `// ${context.provenance(module, name)}\n${signature} {\n${body}\n}`;
        })
        .join("\n");
}
