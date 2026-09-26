import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

/** Source ownership and invalidation over native retained geometry slots. */
export function lowerMeshGeometryResize(context: LoweringContext): string {
    const module = "src/mesh/mesh-factories.ts";
    const parameters =
        "const std::vector<float>& positions, const std::vector<float>& normals, const std::vector<std::uint32_t>& indices, const std::vector<float>& uvs, const std::vector<float>& uvs2, const std::vector<float>& tangents, const std::vector<float>& colors";
    const refCount = (name: "retain" | "release") => {
        const { file, declaration } = context.functionDeclaration(
            "src/resource/ref-count.ts",
            name,
        );
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: new Map([
                [
                    "resource._refCount",
                    {
                        cpp: "geometry.owners",
                        type: "scalar",
                        absentCpp: "false",
                    },
                ],
            ]),
            calls: new Map(),

            expression(node, lowerer) {
                if (context.expressionMatchesShape(node, "count === undefined"))
                    return "false";
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken
                ) {
                    context.assertExpressionShape(
                        node,
                        "resource._refCount ?? 1",
                        "Native geometry has an explicit initial owner",
                    );
                    return lowerer.expression(node.left);
                }
                return undefined;
            },
            returnValue: (value, lowerer) =>
                value ? lowerer.expression(value) : "",
            statement(node, lowerer, indent) {
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isBinaryExpression(node.expression) &&
                    node.expression.left.getText(file) === "resource._refCount"
                )
                    return [
                        `${indent}geometry.owners=static_cast<std::uint32_t>(${lowerer.expression(node.expression.right)});`,
                    ];
                return undefined;
            },
        });
    };
    const lower = (name: string) => {
        const { file, declaration } = context.functionDeclaration(module, name);
        const bindings = new Map<string, PinnedBinding>();
        const bind = (
            key: string,
            cpp: string,
            type: PinnedBinding["type"] = "opaque",
            absentCpp?: string,
        ) =>
            bindings.set(key, {
                cpp,
                type,
                ...(absentCpp ? { absentCpp } : {}),
            });
        for (const arg of [
            "engine",
            "mesh",
            "meshes",
            "positions",
            "normals",
            "indices",
            "uvs",
            "uvs2",
            "tangents",
            "colors",
            "old",
            "replacement",
            "first",
            "owners",
        ])
            bind(arg, arg);
        for (const owner of ["mesh", "first"]) {
            bind(owner, owner, "opaque", `${owner}.value == invalid_handle`);
            bind(
                `${owner}._gpu`,
                `${recordAt("engine.meshes", owner)}.geometry`,
            );
            bind(
                `${owner}._disposed`,
                `${recordAt("engine.meshes", owner)}.retired`,
                "bool",
            );
            bind(`${owner}.name`, `${recordAt("engine.meshes", owner)}.name`);
        }
        bind(
            "old._vbLayout",
            "!engine.geometries.at(old).owned_packed_geometry",
            "bool",
        );
        bind(
            "old._ownsVertexBuffers",
            "engine.geometries.at(old).owned_packed_geometry",
            "bool",
        );
        bind("meshes.length", "static_cast<double>(meshes.size())", "scalar");
        bind(
            "sc._renderableVersion",
            "ctx->render_topology_version",
            "scalar",
            "false",
        );
        const calls = new Map<string, (args: readonly string[]) => string>([
            [
                "invalidateRenderBundles",
                () => "invalidate_mesh_geometry_bundles(engine)",
            ],
            ["bumpVisibilityEpoch", () => "(++engine.draw_list_epoch)"],
            [
                "uploadMeshToGPU",
                (args) => `upload_mesh_geometry_data(${args.join(",")})`,
            ],
            [
                "retainMeshGeometry",
                (args) =>
                    `retain_replacement_geometry_bounds(engine,mesh,${args[2]}.size()>=3)`,
            ],
            [
                "_markWorldMatrixDirty",
                (args) => `mark_mesh_dirty(engine,${args[0]})`,
            ],
            [
                "release",
                (args) =>
                    `release_mesh_geometry_owner(engine.geometries.at(${args[0]}))`,
            ],
            [
                "retain",
                (args) =>
                    `retain_mesh_geometry_owner(engine.geometries.at(${args[0]}))`,
            ],
            [
                "retireMeshGeometryBuffers",
                (args) => `release_unowned_geometry(engine,${args[1]})`,
            ],
            [
                "resizeMeshGeometry",
                (args) => `resize_mesh_geometry(${args.join(",")})`,
            ],
            ["owners.has", (args) => `owners.contains(${args[0]}.value)`],
            ["owners.add", (args) => `owners.insert(${args[0]}.value)`],
        ]);
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            calls,

            foldConditions: false,
            callShapes: new Map([
                ["release", "bool"],
                ["owners.has", "bool"],
            ]),
            forOf(iterated, element) {
                const range =
                    iterated === "meshes"
                        ? "meshes"
                        : iterated === "engine._renderingContexts"
                          ? "engine.scenes()"
                          : undefined;
                return range
                    ? {
                          range,
                          bindings: new Map([
                              ...[...bindings].filter(([name]) =>
                                  name.startsWith(`${element}.`),
                              ),
                              [
                                  element,
                                  {
                                      cpp: element,
                                      type: "opaque",
                                      ...(element === "mesh"
                                          ? {
                                                absentCpp:
                                                    "mesh.value == invalid_handle",
                                            }
                                          : {}),
                                  },
                              ],
                          ]),
                      }
                    : undefined;
            },
            expression(node, lowerer) {
                if (
                    ts.isElementAccessExpression(node) &&
                    node.expression.getText(file) === "meshes"
                )
                    return `(static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)}) < meshes.size() ? meshes[static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)})] : MeshHandle{})`;
                return undefined;
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
                    const id = declaration.name.text;
                    if (id === "sc") {
                        context.assertExpressionShape(
                            unwrapExpression(declaration.initializer),
                            "ctx",
                            "Registered rendering context is a native Scene",
                        );
                        return [];
                    }
                    if (id === "owners") {
                        context.assertExpressionShape(
                            declaration.initializer,
                            "new Set<Mesh>()",
                            "Shared geometry owner identity set",
                        );
                        return [`${indent}std::set<std::uint32_t> owners;`];
                    }
                    if (["old", "replacement", "first", "mesh"].includes(id)) {
                        lowerer.bindPorts(
                            [...bindings].filter(
                                ([name]) =>
                                    name === id || name.startsWith(`${id}.`),
                            ),
                            declaration,
                        );
                        return [
                            `${indent}const auto ${id} = ${lowerer.expression(declaration.initializer)};`,
                        ];
                    }
                }
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isBinaryExpression(node.expression) &&
                    node.expression.left.getText(file) === "mesh._gpu"
                )
                    return [
                        `${indent}${recordAt("engine.meshes", "mesh")}.geometry=${lowerer.expression(node.expression.right)};`,
                    ];
                return undefined;
            },
        });
    };
    return `
static void retain_mesh_geometry_owner(ModelGeometry& geometry) {
${refCount("retain")}
}
static bool release_mesh_geometry_owner(ModelGeometry& geometry) {
${refCount("release")}
}
static void invalidate_mesh_geometry_bundles(Engine& engine) {
${lower("invalidateRenderBundles")}
}
// CPU attributes/bounds are retained by upload_mesh_geometry_data. Native GPU
// generations own submitted buffers until topology rematching releases them.
// retainMeshGeometry rewrites boundMin/boundMax from the new positions,
// present when they fold a finite box.
static void retain_replacement_geometry_bounds(Engine& engine, MeshHandle mesh, bool has_bounds) {
    auto& record=${recordAt("engine.meshes", "mesh")};
    record.has_bounds=has_bounds;
    record.has_bounds_min_override=false;
    record.has_bounds_max_override=false;
}
// ${context.provenance(module, "resizeMeshGeometry")}
void resize_mesh_geometry(Engine& engine, MeshHandle mesh, ${parameters}) {
${lower("resizeMeshGeometry")}
}
// ${context.provenance(module, "resizeSharedMeshGeometry")}
void resize_shared_mesh_geometry(Engine& engine, std::span<const MeshHandle> meshes, ${parameters}) {
${lower("resizeSharedMeshGeometry")}
}
`;
}
