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
import { PINNED_AGENT_PARAM_DEFAULTS } from "../../lowering/navigation-lowerer.js";

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
                        ...vec3LanesOf(`${temporary}.hit_point`),
                        optionalFoundCpp: `${temporary}.hit`,
                    },
                },
            };
        }

        case "getClosestPoint": {
            context.expectArgumentCount(call, 2, 2);
            const plugin = context.compileValue(call.arguments[0]!);
            context.expectKind(
                plugin,
                "navigation",
                call.arguments[0]!,
            );
            const position = context.compileVec3(
                call.arguments[1]!,
                "double",
            );
            return navVec3Record(
                context,
                "nav_closest",
                `bbl::upstream::nav_closest_point(${plugin.cpp}, ${position})`,
            );
        }

        case "createNavCrowd": {
            context.expectArgumentCount(call, 3, 3);
            const plugin = context.compileValue(call.arguments[0]!);
            context.expectKind(
                plugin,
                "navigation",
                call.arguments[0]!,
            );
            const maxAgents = context.compileNumber(
                call.arguments[1]!,
                "double",
            );
            const maxAgentRadius = context.compileNumber(
                call.arguments[2]!,
                "double",
            );
            const crowd = context.allocateTemporaryCppName("nav_crowd");
            context.emit(
                `const bbl::pal::NavCrowdHandle ${crowd} = ` +
                    `bbl::upstream::create_nav_crowd(${plugin.cpp}, ` +
                    `${maxAgents}, ${maxAgentRadius});`,
            );
            return { kind: "navigation-crowd", cpp: crowd };
        }

        case "addAgent": {
            context.expectArgumentCount(call, 3, 3);
            const crowd = context.compileValue(call.arguments[0]!);
            context.expectKind(
                crowd,
                "navigation-crowd",
                call.arguments[0]!,
            );
            const position = context.compileVec3(
                call.arguments[1]!,
                "double",
            );
            const options = context.expectObjectLiteral(
                call.arguments[2]!,
            );
            validateObjectProperties(
                context,
                options,
                AGENT_PARAM_NAMES,
                "Reached crowd agents name the pinned dtCrowdAgentParams fields.",
            );
            // `reachRadius` is the one `AgentParameters` field the pinned
            // `addAgent` never forwards, so upstream drops it silently.
            // Refusing by name says so rather than compiling a scene
            // whose author expects it to reach the agent.
            if (context.objectProperty(options, "reachRadius")) {
                context.fail(
                    call.arguments[2]!,
                    "addAgent's reachRadius is declared but never " +
                        "forwarded to the crowd by the pinned module.",
                );
            }
            const parameters =
                context.allocateTemporaryCppName("agent_params");
            context.emit(
                `bbl::pal::NavAgentParams ${parameters}{};`,
            );
            for (const [name, field] of AGENT_FLOAT_PARAMS) {
                const value = context.objectProperty(options, name);
                if (!value) {
                    context.fail(
                        call.arguments[2]!,
                        `addAgent requires '${name}'; the pinned ` +
                            "parameters carry no default for it.",
                    );
                }
                context.emit(
                    `${parameters}.${field} = static_cast<float>(` +
                        `${context.compileNumber(value, "double")});`,
                );
            }
            // The pin's own `?? N` defaults, resolved here so the
            // wrapper's spread never decides them. The numbers come from
            // the table the lowerer gates against the pinned expression,
            // so neither side can move alone.
            for (const [
                name,
                field,
                fallback,
            ] of PINNED_AGENT_PARAM_DEFAULTS) {
                const value = context.objectProperty(options, name);
                const resolved = value
                    ? context.compileNumber(value, "double")
                    : String(fallback);
                context.emit(
                    `${parameters}.${field} = ` +
                        `static_cast<unsigned char>(${resolved});`,
                );
            }
            return {
                kind: "number",
                cpp:
                    `bbl::upstream::add_agent(${crowd.cpp}, ` +
                    `${position}, ${parameters})`,
            };
        }

        case "getAgentPosition": {
            context.expectArgumentCount(call, 2, 2);
            const crowd = context.compileValue(call.arguments[0]!);
            context.expectKind(
                crowd,
                "navigation-crowd",
                call.arguments[0]!,
            );
            const index = context.compileNumber(
                call.arguments[1]!,
                "double",
            );
            return navVec3Record(
                context,
                "agent_pos",
                `bbl::upstream::get_agent_position(${crowd.cpp}, ${index})`,
            );
        }

        default:
            return undefined;
    }
}

/**
 * The `AgentParameters` fields the pinned `addAgent` forwards and the
 * caller must supply. The three it defaults with `?? N` live in
 * `PINNED_AGENT_PARAM_DEFAULTS`, beside the assertion that gates them
 * against the pin; `reachRadius` is declared upstream and forwarded
 * nowhere, so it is refused at the call site instead.
 */
const AGENT_FLOAT_PARAMS: readonly (readonly [string, string])[] = [
    ["radius", "radius"],
    ["height", "height"],
    ["maxAcceleration", "max_acceleration"],
    ["maxSpeed", "max_speed"],
    ["collisionQueryRange", "collision_query_range"],
    ["pathOptimizationRange", "path_optimization_range"],
    ["separationWeight", "separation_weight"],
];

const AGENT_PARAM_NAMES = [
    ...AGENT_FLOAT_PARAMS.map(([name]) => name),
    ...PINNED_AGENT_PARAM_DEFAULTS.map(([name]) => name),
    "reachRadius",
];

/**
 * The three lanes of a native vector, as a record the scene reads at run
 * time. Every navigation query answers in one, whether the vector is the
 * whole result or a member of it.
 */
function vec3LanesOf(base: string): Value {
    return {
        kind: "record",
        cpp: "",
        recordProperties: {
            x: { kind: "number", cpp: `${base}.x` },
            y: { kind: "number", cpp: `${base}.y` },
            z: { kind: "number", cpp: `${base}.z` },
        },
    };
}

/**
 * A query whose whole result is that vector: the call is emitted into a
 * temporary first, so a scene reading two lanes calls the PAL once.
 */
function navVec3Record(
    context: NavigationIntrinsicContext,
    label: string,
    expression: string,
): Value {
    const temporary = context.allocateTemporaryCppName(label);
    context.emit(
        `const bbl::Vec3d ${temporary} = ${expression};`,
    );
    return vec3LanesOf(temporary);
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
