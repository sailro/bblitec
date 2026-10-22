import ts from "typescript";
import { jsToUint32Call } from "./pinned-operators.js";
import type { LoweringContext } from "./context.js";
import { recordAt } from "../compiler/record-access.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedCallSpelling,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";

const modulePath = "src/navigation/navigation.ts";

function mergedStorageStatement(
    context: LoweringContext,
    node: ts.Statement,
    lowerer: PinnedNumericLowerer,
    indent: string,
): string[] | undefined {
    if (
        !ts.isVariableStatement(node) ||
        node.declarationList.declarations.length !== 1
    )
        return undefined;
    const variable = node.declarationList.declarations[0]!;
    if (!ts.isIdentifier(variable.name) || !variable.initializer)
        return undefined;
    const name = variable.name.text;
    if (name !== "positions" && name !== "indices") return undefined;
    const positions = name === "positions";
    context.assertExpressionShape(
        variable.initializer,
        positions ? "new F32(totalVerts)" : "new U32(totalIdx)",
        "Merged typed storage",
    );
    lowerer.bindLocal(variable.name, {
        cpp: name,
        type: positions ? "f32" : "u32",
        indexedStore: (owner, index, value) =>
            `bbl::js::array_store_checked(${owner}, ${index}, "navigation source merge") = ${positions ? `static_cast<float>(${value})` : jsToUint32Call(value)}`,
    });
    const size = lowerer.portBinding(
        positions ? "totalVerts" : "totalIdx",
        node,
    )!.cpp;
    return [
        `${indent}std::vector<${positions ? "float" : "std::uint32_t"}> ${name}(static_cast<std::size_t>(${size}));`,
    ];
}

function mergedGeometryReturn(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
    node: ts.Expression | undefined,
    lowerer: PinnedNumericLowerer,
): string {
    if (!node)
        return context.contractError(
            declaration,
            "Expected merged source geometry.",
        );
    context.assertExpressionShape(
        node,
        "{ positions, indices }",
        "Merged source geometry",
    );
    return `bbl::pal::NavMeshGeometry{std::move(${lowerer.portBinding("positions", node)!.cpp}), std::move(${lowerer.portBinding("indices", node)!.cpp})}`;
}

/** Bind the pinned merge to retained source streams and the existing world composer. */
export function navigationMeshMergeDefinition(
    context: LoweringContext,
): string {
    const merge = context.functionDeclaration(modulePath, "_mergeMeshes");
    const body = lowerPinnedBody(
        merge.file,
        merge.declaration.body!.statements,
        {
            bindings: new Map([
                ["meshes", { cpp: "meshes", type: "opaque" }],
                [
                    "doNotReverseIndices",
                    { cpp: "false", type: "bool", staticBoolean: false },
                ],
            ]),
            calls: new Map(),
            forOf(iterated, element) {
                if (iterated !== "meshes") return undefined;
                const record = recordAt("engine.meshes", element);
                const streams = `navigation_mesh_cpu_streams(engine, ${element})`;
                return {
                    range: "meshes",
                    bindings: new Map<string, PinnedBinding>([
                        [element, { cpp: element, type: "opaque" }],
                        [
                            `${element}.name`,
                            { cpp: `${record}.name`, type: "string" },
                        ],
                        [
                            `${element}._cpuPositions`,
                            {
                                cpp: `${streams}.positions`,
                                type: "f32",
                                materializeAlias: true,
                                absentCpp: `!${streams}.positions`,
                                indexedRead: (owner, index) =>
                                    `${owner}[static_cast<std::size_t>(${index})]`,
                            },
                        ],
                        [
                            `${element}._cpuIndices`,
                            {
                                cpp: `${streams}.indices`,
                                type: "u32",
                                materializeAlias: true,
                                absentCpp: `!${streams}.indices`,
                                indexedRead: (owner, index) =>
                                    `${owner}.source_at(static_cast<std::size_t>(${index}))`,
                            },
                        ],
                        [
                            `${element}.worldMatrix`,
                            {
                                cpp: `upstream::mesh_world_matrix(engine, ${record})`,
                                type: "f32",
                                materializeAlias: true,
                                indexedRead: (owner, index) =>
                                    `${owner}[static_cast<std::size_t>(${index})]`,
                            },
                        ],
                    ]),
                };
            },
            statement: (node, lowerer, indent) =>
                mergedStorageStatement(context, node, lowerer, indent),
            returnValue: (node, lowerer) =>
                mergedGeometryReturn(context, merge.declaration, node, lowerer),
        },
    );
    return `
static MeshCpuStreamsView navigation_mesh_cpu_streams(const Engine& engine, MeshHandle handle) {
    const auto& mesh = ${recordAt("engine.meshes", "handle")};
    const auto* geometry = mesh.geometry < engine.geometries.size() ? &engine.geometries[mesh.geometry] : nullptr;
    return MeshCpuStreamsView(mesh, geometry);
}
// ${context.provenance(modulePath, "_mergeMeshes")}
static bbl::pal::NavMeshGeometry merge_nav_meshes(Engine& engine, const std::vector<MeshHandle>& meshes) {
${body}
}
`;
}

export const navigationSourceQueryDeclarations = `
struct NavMeshSource {
    bbl::js::NumericArrayView positions;
    bbl::js::NumericArrayView indices;
};
bbl::pal::NavMeshGeometry merge_nav_mesh_sources(const std::vector<NavMeshSource>& sources, bool doNotReverseIndices);
void create_nav_mesh_from_sources(bbl::pal::NavigationHandle plugin, const std::vector<NavMeshSource>& sources, const bbl::pal::NavMeshBuildParams& params, bool doNotReverseIndices);
bool nav_closest_point_within_into(bbl::pal::NavigationHandle plugin, Vec3d position, Vec3d halfExtents, Vec3d& out);
bool nav_ray_blocked_fast(bbl::pal::NavigationHandle plugin, Vec3d start, Vec3d end);
void dispose_navigation_plugin(bbl::pal::NavigationHandle plugin);
`;

/** CPU source merging is the pinned two-pass copy, with its typed-array stores. */
export function navigationSourceQueryDefinitions(
    context: LoweringContext,
): string {
    const factory = context.functionDeclaration(
        modulePath,
        "createNavMeshFromSources",
    ).declaration;
    context.assertStatementShapes(
        factory,
        factory.body!.statements,
        `
        const { positions, indices } = _mergeSources(sources, params.doNotReverseIndices === true);
        _createNavMeshFromMerged(plugin, positions, indices, params);
    `,
        "Source navmesh build",
    );
    const merge = context.functionDeclaration(modulePath, "_mergeSources");
    const mergeBody = lowerPinnedBody(
        merge.file,
        merge.declaration.body!.statements,
        {
            bindings: new Map([
                ["sources", { cpp: "sources", type: "opaque" }],
                [
                    "doNotReverseIndices",
                    { cpp: "doNotReverseIndices", type: "bool" },
                ],
            ]),
            calls: new Map(),
            statement: (node, lowerer, indent) =>
                mergedStorageStatement(context, node, lowerer, indent),
            forOf(iterated, element) {
                if (iterated !== "sources") return undefined;
                return {
                    range: "sources",
                    bindings: new Map<string, PinnedBinding>([
                        [element, { cpp: element, type: "opaque" }],
                        [
                            `${element}.positions`,
                            {
                                cpp: `${element}.positions`,
                                type: "f64-list",
                                indexedRead: (owner, index) =>
                                    `${owner}.load(static_cast<std::size_t>(${index}))`,
                            },
                        ],
                        [
                            `${element}.indices`,
                            {
                                cpp: `${element}.indices`,
                                type: "f64-list",
                                indexedRead: (owner, index) =>
                                    `${owner}.load(static_cast<std::size_t>(${index}))`,
                            },
                        ],
                    ]),
                };
            },
            returnValue: (node, lowerer) =>
                mergedGeometryReturn(context, merge.declaration, node, lowerer),
        },
    );
    const definitions = [
        `// ${context.provenance(modulePath, "_mergeSources")}
bbl::pal::NavMeshGeometry merge_nav_mesh_sources(const std::vector<NavMeshSource>& sources, bool doNotReverseIndices) {
${mergeBody}
}`,
    ];
    const ready = context.functionDeclaration(modulePath, "_assertReady");
    const status = context.functionDeclaration(
        modulePath,
        "_statusSucceed",
    ).declaration;
    context.assertStatementShapes(
        status,
        status.body!.statements,
        "return (plugin._recast as { Raw: any }).Raw.Detour.statusSucceed(status);",
        "Detour query status adapter",
    );
    definitions.push(`// ${context.provenance(modulePath, "_assertReady")}
static void assert_navigation_ready(bbl::pal::NavigationHandle plugin) {
${lowerPinnedBody(ready.file, ready.declaration.body!.statements, {
    bindings: new Map([
        [
            "plugin._navMesh",
            { cpp: "bbl::pal::navigation_has_nav_mesh(plugin)", type: "bool" },
        ],
        [
            "plugin._navMeshQuery",
            { cpp: "bbl::pal::navigation_has_query(plugin)", type: "bool" },
        ],
    ]),
    calls: new Map(),
})}
}`);
    for (const [api, name, parameters] of [
        [
            "findClosestPointWithinInto",
            "nav_closest_point_within_into",
            "Vec3d position, Vec3d halfExtents, Vec3d& out",
        ],
        ["navRayBlockedFast", "nav_ray_blocked_fast", "Vec3d start, Vec3d end"],
    ] as const) {
        const { file, declaration } = context.functionDeclaration(
            modulePath,
            api,
        );
        for (const shape of api === "findClosestPointWithinInto"
            ? [
                  "q.raw.findClosestPoint(s.pos, s.ext, q.defaultFilter.raw, s.polyRef, s.point, s.boolRef)",
              ]
            : [
                  "q.raw.findNearestPoly(s.pos, s.ext, q.defaultFilter.raw, s.polyRef, s.point, s.boolRef)",
                  "q.raw.raycast(s.polyRef.value, s.pos, s.end, q.defaultFilter.raw, 0, s.hit, 0)",
              ])
            context.expectShapeCount(
                declaration,
                shape,
                "Raw navigation query transport",
            );
        const bindings = new Map<string, PinnedBinding>([
            ["plugin", { cpp: "plugin", type: "opaque" }],
            ["q", { cpp: "plugin", type: "opaque" }],
            ["s", { cpp: "scratch", type: "opaque" }],
            ["s.polyRef", { cpp: "scratch.poly_ref", type: "opaque" }],
            ["s.polyRef.value", { cpp: "scratch.poly_ref", type: "scalar" }],
            ["s.point", { cpp: "scratch.point", type: "opaque" }],
            ["s.boolRef", { cpp: "scratch.over_poly", type: "opaque" }],
            ["s.hit", { cpp: "scratch.t", type: "opaque" }],
            ["s.hit.t", { cpp: "scratch.t", type: "scalar" }],
            ["q.defaultFilter.raw", { cpp: "plugin", type: "opaque" }],
        ]);
        for (const owner of ["position", "halfExtents", "out", "start", "end"])
            bindings.set(owner, { cpp: owner, type: "vec3" });
        for (const [source, field] of [
            ["s.pos", "position"],
            ["s.end", "end"],
            ["s.ext", "extents"],
        ] as const)
            bindings.set(source, {
                cpp: `scratch.${field}`,
                type: "f64-buffer",
                indexedRead: (owner, index) =>
                    `${owner}[static_cast<std::size_t>(${index})]`,
                indexedStore: (owner, index, value) =>
                    `${owner}[static_cast<std::size_t>(${index})] = ${value}`,
            });
        for (const [index, axis] of ["x", "y", "z"].entries()) {
            bindings.set(`s.point.${axis}`, {
                cpp: `scratch.point.${axis}`,
                type: "scalar",
            });
            bindings.set(`_tmpHalfExtents.${axis}`, {
                cpp: `navigation_query_defaults.half_extents[${index}]`,
                type: "scalar",
            });
        }
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            calls: new Map<string, PinnedCallSpelling>([
                ["_assertReady", () => "assert_navigation_ready(plugin)"],
                [
                    "_statusSucceed",
                    (args) => `bbl::pal::navigation_status_succeed(${args[1]})`,
                ],
                [
                    "q.raw.findClosestPoint",
                    () =>
                        "bbl::pal::navigation_raw_closest_point(plugin, scratch)",
                ],
                [
                    "q.raw.findNearestPoly",
                    () =>
                        "bbl::pal::navigation_raw_nearest_poly(plugin, scratch)",
                ],
                [
                    "q.raw.raycast",
                    () => "bbl::pal::navigation_raw_raycast(plugin, scratch)",
                ],
            ]),
            statement(node) {
                if (
                    !ts.isVariableStatement(node) ||
                    node.declarationList.declarations.length !== 1
                )
                    return undefined;
                const variable = node.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer)
                    return undefined;
                if (variable.name.text === "s") {
                    context.assertExpressionShape(
                        variable.initializer,
                        "_fastScratch(plugin)",
                        "Navigation scratch owner",
                    );
                    return ["    bbl::pal::NavQueryScratch scratch;"];
                }
                if (variable.name.text === "q") {
                    context.assertExpressionShape(
                        variable.initializer,
                        "plugin._navMeshQuery",
                        "Navigation query owner",
                    );
                    return [];
                }
                return undefined;
            },
            returnValue(node, lowerer) {
                if (!node)
                    return context.contractError(
                        declaration,
                        "Expected query result.",
                    );
                return lowerer.expression(node);
            },
        });
        definitions.push(`// ${context.provenance(modulePath, api)}
bool ${name}(bbl::pal::NavigationHandle plugin, ${parameters}) {
${body}
}`);
    }
    const disposal = context.functionDeclaration(
        modulePath,
        "disposeNavigationPlugin",
    );
    const resourceNames = new Map([
        ["_navMeshQuery", "query"],
        ["_tileCache", "tile_cache"],
        ["_navMesh", "nav_mesh"],
    ]);
    const disposeBody = lowerPinnedBody(
        disposal.file,
        disposal.declaration.body!.statements,
        {
            bindings: new Map(),
            calls: new Map(),
            statement(node, _lowerer, indent) {
                if (ts.isVariableStatement(node)) {
                    context.assertStatementShapes(
                        disposal.declaration,
                        [node],
                        "const internal = plugin as { _navMesh?: any; _navMeshQuery?: any; _tileCache?: any };",
                        "Navigation disposal owner",
                    );
                    return [];
                }
                if (!ts.isExpressionStatement(node)) return undefined;
                for (const [field, resource] of resourceNames) {
                    if (
                        context.expressionMatchesShape(
                            node.expression,
                            `internal.${field}?.destroy?.()`,
                        )
                    )
                        return [
                            `${indent}bbl::pal::navigation_destroy_${resource}(plugin);`,
                        ];
                    if (
                        context.expressionMatchesShape(
                            node.expression,
                            `internal.${field} = undefined`,
                        )
                    )
                        return [];
                }
                return undefined;
            },
        },
    );
    definitions.push(`// ${context.provenance(modulePath, "disposeNavigationPlugin")}
void dispose_navigation_plugin(bbl::pal::NavigationHandle plugin) {
${disposeBody}
}`);
    return definitions.join("\n");
}
