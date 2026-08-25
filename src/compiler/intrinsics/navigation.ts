// The navigation family: `createNavigationPluginAsync`, `createNavMesh`,
// `createDebugNavMeshGeometry`, `raycast`.
//
// The pinned module's own logic is generated (upstream/navigation.cpp,
// src/lowering/navigation-lowerer.ts); the toolset behind it is the
// PAL's, linked from the exact recastnavigation commit the pinned
// wrapper's wasm compiles — so unlike physics, nothing is substituted
// and the answers are expected to match the browser reference.
import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    validateObjectProperties,
    type ObjectValidationContext,
} from "../option-helpers.js";

export interface NavigationIntrinsicContext
    extends IntrinsicCallContext,
        ObjectValidationContext {
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    allocateTemporaryCppName(label: string): string;
    emit(line: string): void;
    requireEngine(value: Value, node: ts.Node): string;
    unwrap(expression: ts.Expression): ts.Expression;
}

/**
 * The build parameters a reached `createNavMesh` may name, each mapping
 * to the PAL field the generated build copies into the wrapper's own
 * config spread. `keepIntermediates` is accepted and discarded — it
 * only decides whether the wrapper frees Recast intermediates, which
 * the native build frees unconditionally; nothing reached reads them.
 */
const NAV_MESH_NUMBER_PARAMS: readonly (readonly [string, string])[] = [
    ["cs", "cs"],
    ["ch", "ch"],
    ["walkableSlopeAngle", "walkable_slope_angle"],
    ["walkableHeight", "walkable_height"],
    ["walkableClimb", "walkable_climb"],
    ["walkableRadius", "walkable_radius"],
    ["maxEdgeLen", "max_edge_len"],
    ["maxSimplificationError", "max_simplification_error"],
    ["minRegionArea", "min_region_area"],
    ["mergeRegionArea", "merge_region_area"],
    ["maxVertsPerPoly", "max_verts_per_poly"],
    ["detailSampleDist", "detail_sample_dist"],
    ["detailSampleMaxError", "detail_sample_max_error"],
];

const NAV_MESH_PARAM_NAMES = [
    ...NAV_MESH_NUMBER_PARAMS.map(([name]) => name),
    "keepIntermediates",
    "maxObstacles",
    "tileSize",
    "doNotReverseIndices",
    "expectedLayersPerTile",
    "offMeshConnections",
];

export function compileNavigationIntrinsic(
    context: NavigationIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createNavigationPluginAsync": {
            // The pinned factory loads the wasm; the native toolset is
            // linked, so the options (`locateFile`) name a browser
            // concern and carry nothing.
            context.expectArgumentCount(call, 0, 1);
            if (call.arguments[0]) {
                context.expectObjectLiteral(call.arguments[0]);
            }
            context.reachFeature("navigation:recast", call);
            return {
                kind: "navigation",
                cpp: "bbl::upstream::create_navigation_plugin()",
            };
        }

        case "createNavMesh": {
            context.expectArgumentCount(call, 3, 3);
            const plugin = context.compileValue(call.arguments[0]!);
            context.expectKind(
                plugin,
                "navigation",
                call.arguments[0]!,
            );
            const meshList = context.expectStaticArrayLiteral(
                call.arguments[1]!,
            );
            const meshes = meshList.elements.map((element) => {
                const mesh = context.compileValue(element);
                context.expectKind(mesh, "mesh", element);
                return mesh;
            });
            if (meshes.length === 0) {
                context.fail(
                    call.arguments[1]!,
                    "createNavMesh requires at least one mesh.",
                );
            }
            const engine = context.requireEngine(
                meshes[0]!,
                call,
            );
            const options = context.expectObjectLiteral(
                call.arguments[2]!,
            );
            validateNavMeshParams(context, options);
            const parameters =
                context.allocateTemporaryCppName("nav_params");
            context.emit(
                `bbl::pal::NavMeshBuildParams ${parameters}{};`,
            );
            for (const [name, field] of NAV_MESH_NUMBER_PARAMS) {
                const value = context.objectProperty(options, name);
                if (value) {
                    context.emit(
                        `${parameters}.${field} = ${context.compileNumber(value, "double")};`,
                    );
                }
            }
            return {
                kind: "void",
                cpp:
                    `bbl::upstream::create_nav_mesh(${engine}, ` +
                    `${plugin.cpp}, ` +
                    `std::vector<bbl::MeshHandle>{${meshes
                        .map((mesh) => mesh.cpp)
                        .join(", ")}}, ` +
                    `${parameters})`,
            };
        }

        case "createDebugNavMeshGeometry": {
            context.expectArgumentCount(call, 1, 1);
            const plugin = context.compileValue(call.arguments[0]!);
            context.expectKind(
                plugin,
                "navigation",
                call.arguments[0]!,
            );
            const temporary =
                context.allocateTemporaryCppName("nav_debug");
            context.emit(
                `const bbl::pal::NavDebugGeometry ${temporary} = ` +
                    `bbl::upstream::create_debug_nav_mesh_geometry(` +
                    `${plugin.cpp});`,
            );
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    positions: {
                        kind: "data",
                        cpp: `${temporary}.positions`,
                        dataType: { kind: "f32array" },
                    },
                    normals: {
                        kind: "data",
                        cpp: `${temporary}.normals`,
                        dataType: { kind: "f32array" },
                    },
                    indices: {
                        kind: "data",
                        cpp: `${temporary}.indices`,
                        dataType: { kind: "u32array" },
                    },
                },
            };
        }

        case "raycast": {
            context.expectArgumentCount(call, 3, 3);
            const plugin = context.compileValue(call.arguments[0]!);
            context.expectKind(
                plugin,
                "navigation",
                call.arguments[0]!,
            );
            const start = context.compileVec3(
                call.arguments[1]!,
                "double",
            );
            const end = context.compileVec3(
                call.arguments[2]!,
                "double",
            );
            const temporary =
                context.allocateTemporaryCppName("nav_ray");
            context.emit(
                `const bbl::upstream::NavRaycastResult ${temporary} = ` +
                    `bbl::upstream::nav_raycast(${plugin.cpp}, ` +
                    `${start}, ${end});`,
            );
            // `hitPoint` is present exactly when `hit` is true upstream;
            // the record models it as always-readable coordinates whose
            // meaning the scene's own `hit` guard decides — the same
            // truth `result.hit && result.hitPoint` tests.
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    hit: {
                        kind: "data",
                        cpp: `${temporary}.hit`,
                        dataType: { kind: "boolean" },
                    },
                    hitPoint: {
                        kind: "record",
                        cpp: "",
                        optionalFoundCpp: `${temporary}.hit`,
                        recordProperties: {
                            x: {
                                kind: "number",
                                cpp: `${temporary}.hit_point.x`,
                            },
                            y: {
                                kind: "number",
                                cpp: `${temporary}.hit_point.y`,
                            },
                            z: {
                                kind: "number",
                                cpp: `${temporary}.hit_point.z`,
                            },
                        },
                    },
                },
            };
        }

        default:
            return undefined;
    }
}

function validateNavMeshParams(
    context: NavigationIntrinsicContext,
    options: ts.ObjectLiteralExpression,
): void {
    validateObjectProperties(
        context,
        options,
        NAV_MESH_PARAM_NAMES,
        "Reached navmesh builds support the solo Recast config keys.",
    );
    // The tile-cache and tiled arms have no record plumbing yet; a
    // zero literal is the solo arm by the pin's own dispatch and is
    // dropped, anything else refuses by name.
    for (const gate of ["maxObstacles", "tileSize"] as const) {
        const value = context.objectProperty(options, gate);
        if (!value) continue;
        const literal = context.unwrap(value);
        if (
            !ts.isNumericLiteral(literal) ||
            Number(literal.text) !== 0
        ) {
            context.fail(
                value,
                `createNavMesh with ${gate} > 0 builds a ` +
                    `${gate === "maxObstacles" ? "tile-cache" : "tiled"} ` +
                    "navmesh, which is not lowered yet; the solo arm is.",
            );
        }
    }
    for (const unsupported of [
        "doNotReverseIndices",
        "expectedLayersPerTile",
        "offMeshConnections",
    ] as const) {
        if (context.objectProperty(options, unsupported)) {
            context.fail(
                options,
                `createNavMesh's ${unsupported} is not lowered; the ` +
                    "reached merge carries the pin's reversed winding " +
                    "and no off-mesh connections.",
            );
        }
    }
}
