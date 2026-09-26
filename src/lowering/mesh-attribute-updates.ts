import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

/** Pinned range validation and wrappers; PAL only scatters attribute bytes. */
export function lowerMeshAttributeUpdates(context: LoweringContext): string {
    const module = "src/mesh/mesh-factories.ts";
    const signatures = [
        [
            "writeVertexAttributeRange",
            "static void write_vertex_attribute_range(Engine& engine, MeshHandle mesh, pal::MeshAttributeBuffer buffer, const std::vector<float>& values, double components, double vertexOffset, std::optional<double> vertexCount, double sourceVertexOffset)",
        ],
        [
            "updateMeshPositions",
            "void update_mesh_positions(Engine& engine, MeshHandle mesh, const std::vector<float>& positions, double vertexOffset, std::optional<double> vertexCount, double sourceVertexOffset)",
        ],
        [
            "updateMeshUvs",
            "void update_mesh_uvs(Engine& engine, MeshHandle mesh, const std::vector<float>& uvs, double vertexOffset, std::optional<double> vertexCount, double sourceVertexOffset)",
        ],
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
            ])
                bind(value, value);
            for (const value of [
                "components",
                "vertexOffset",
                "sourceVertexOffset",
            ])
                bind(value, value, "scalar");
            bind(
                "vertexCount",
                name === "writeVertexAttributeRange"
                    ? "vertexCount.value()"
                    : "vertexCount",
                name === "writeVertexAttributeRange" ? "scalar" : "opaque",
                "!vertexCount.has_value()",
            );
            if (name === "writeVertexAttributeRange")
                bindings.set("vertexCount", {
                    cpp: "vertexCount.value()",
                    type: "scalar",
                    nullish: "!vertexCount.has_value()",
                });
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
                bind(
                    `${owner}.positionBuffer`,
                    `pal::MeshAttributeBuffer{&${geometry}, pal::MeshAttribute::Position}`,
                );
                bind(
                    `${owner}.uvBuffer`,
                    `pal::MeshAttributeBuffer{&${geometry}, pal::MeshAttribute::Uv}`,
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
                    (args) =>
                        `(std::isfinite(${args[0]}) && std::trunc(${args[0]}) == ${args[0]})`,
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
