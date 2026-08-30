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
    compileStaticNumber,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";
import { PINNED_AGENT_PARAM_DEFAULTS } from "../../lowering/navigation-lowerer.js";

export interface NavigationIntrinsicContext
    extends IntrinsicCallContext,
        ObjectValidationContext,
        PositiveIntegerContext {
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
    compileBoolean(expression: ts.Expression): string;
    emitDataVectorOfStructs(
        node: ts.Node,
        sourceCpp: string,
        fieldValues: (
            element: string,
        ) => Readonly<Record<string, string>>,
    ): Value;
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
    // The tile-cache arm's three. `maxObstacles > 0` is what selects that
    // arm, and the other two are read only once it has been.
    ["tileSize", "tile_size"],
    ["expectedLayersPerTile", "expected_layers_per_tile"],
    ["maxObstacles", "max_obstacles"],
];

const NAV_MESH_PARAM_NAMES = [
    ...NAV_MESH_NUMBER_PARAMS.map(([name]) => name),
    "keepIntermediates",
    "doNotReverseIndices",
    "offMeshConnections",
];

/**
 * `offMeshConnections`, packed the way the wrapper's own
 * `setOffMeshConnections` packs it.
 *
 * The three optional fields stay EMPTY here. Their defaults are the PAL
 * header's contract, and one of them depends on the position in the array,
 * so resolving any of them at the write site would put a default in two
 * places and only one of them would know the index.
 */
function emitOffMeshConnections(
    context: NavigationIntrinsicContext,
    options: ts.ObjectLiteralExpression,
    parameters: string,
): void {
    const value = context.objectProperty(
        options,
        "offMeshConnections",
    );
    if (!value) {
        return;
    }
    for (const element of context
        .expectStaticArrayLiteral(value)
        .elements) {
        const connection = context.expectObjectLiteral(element);
        const required = (name: string): ts.Expression => {
            const found = context.objectProperty(connection, name);
            if (!found) {
                context.fail(
                    connection,
                    `An off-mesh connection names ${name}.`,
                );
            }
            return found;
        };
        // `compileVec3` answers a whole `bbl::Vec3`, and `NavVec3` is the
        // PAL's own three floats -- it exists so the navigation header
        // depends on no engine type. So each endpoint lands in a temporary
        // and its members are copied across, rather than the expression
        // being spelled three times.
        const endpoint = (name: string): string => {
            const temporary =
                context.allocateTemporaryCppName("nav_offmesh");
            context.emit(
                `const bbl::Vec3 ${temporary} = ` +
                    `${context.compileVec3(required(name))};`,
            );
            return (
                `bbl::pal::NavVec3{${temporary}.x, ` +
                `${temporary}.y, ${temporary}.z}`
            );
        };
        const fields = [
            endpoint("startPosition"),
            endpoint("endPosition"),
            context.compileNumber(required("radius"), "float"),
            context.compileBoolean(required("bidirectional")),
        ];
        for (const optional of ["area", "flags", "userId"]) {
            const found = context.objectProperty(connection, optional);
            fields.push(
                found
                    ? `std::optional<double>{${context.compileNumber(found, "double")}}`
                    : "std::nullopt",
            );
        }
        context.emit(
            `${parameters}.off_mesh_connections.push_back(` +
                `bbl::pal::NavOffMeshConnection{${fields.join(", ")}});`,
        );
    }
}

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
            // Which arm this build takes is decided HERE and nowhere else:
            // the feature is what carries it to the emitted dispatch, to
            // the PAL half that gets compiled, and to the third-party
            // library that gets linked.
            if (buildGate(context, options, "maxObstacles") !== 0) {
                context.reachFeature("navigation:tile-cache", call);
            }
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
            emitOffMeshConnections(context, options, parameters);
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

        case "addBoxObstacle":
        case "addCylinderObstacle": {
            // Both take the plugin and a position; the box then takes half
            // extents and a rotation about Y, the cylinder a radius and a
            // height. The pin's own two shapes, and each ends in the same
            // full cache update the entry point below runs alone.
            const box = importedName === "addBoxObstacle";
            context.expectArgumentCount(call, 4, 4);
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
            const second = box
                ? context.compileVec3(call.arguments[2]!, "double")
                : context.compileNumber(call.arguments[2]!, "double");
            const third = context.compileNumber(
                call.arguments[3]!,
                "double",
            );
            return {
                kind: "navigation-obstacle",
                cpp:
                    `bbl::upstream::add_${box ? "box" : "cylinder"}` +
                    `_obstacle(${plugin.cpp}, ${position}, ` +
                    `${second}, ${third})`,
            };
        }

        case "removeObstacle": {
            context.expectArgumentCount(call, 2, 2);
            const plugin = context.compileValue(call.arguments[0]!);
            context.expectKind(
                plugin,
                "navigation",
                call.arguments[0]!,
            );
            const obstacle = context.compileValue(call.arguments[1]!);
            context.expectKind(
                obstacle,
                "navigation-obstacle",
                call.arguments[1]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::upstream::remove_obstacle(` +
                    `${plugin.cpp}, ${obstacle.cpp})`,
            };
        }

        case "updateNavMeshObstacles": {
            // Every add and remove already ran this, so a scene calling it
            // afterwards settles a cache that is already settled -- one
            // `update` that reports nothing pending. It is emitted rather
            // than folded away because the pin emits it, and because the
            // day an add stops waiting this is what would carry the wait.
            context.expectArgumentCount(call, 1, 1);
            const plugin = context.compileValue(call.arguments[0]!);
            context.expectKind(
                plugin,
                "navigation",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::upstream::update_nav_mesh_obstacles(` +
                    `${plugin.cpp})`,
            };
        }

        case "computePath": {
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
            const path = context.allocateTemporaryCppName("nav_path");
            context.emit(
                `const std::vector<bbl::Vec3d> ${path} = ` +
                    `bbl::upstream::nav_compute_path(` +
                    `${plugin.cpp}, ${start}, ${end});`,
            );
            // The element struct is the scene's own `Vec3`, so its fields
            // are filled by name rather than by position -- the pinned
            // interface declares x, y, z, but the generated order is the
            // registry's to decide.
            return context.emitDataVectorOfStructs(
                call,
                path,
                (point) => ({
                    x: `${point}.x`,
                    y: `${point}.y`,
                    z: `${point}.z`,
                }),
            );
        }

        case "agentGoto": {
            context.expectArgumentCount(call, 3, 3);
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
            const destination = context.compileVec3(
                call.arguments[2]!,
                "double",
            );
            return {
                kind: "void",
                cpp:
                    `bbl::upstream::agent_goto(` +
                    `${crowd.cpp}, ${index}, ${destination})`,
            };
        }

        case "updateNavCrowd": {
            context.expectArgumentCount(call, 2, 2);
            const crowd = context.compileValue(call.arguments[0]!);
            context.expectKind(
                crowd,
                "navigation-crowd",
                call.arguments[0]!,
            );
            const delta = context.compileNumber(
                call.arguments[1]!,
                "double",
            );
            return {
                kind: "void",
                cpp:
                    `bbl::upstream::update_nav_crowd(` +
                    `${crowd.cpp}, ${delta})`,
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
        "Reached navmesh builds support the solo and tile-cache Recast " +
            "config keys.",
    );
    // The pin dispatches on `maxObstacles` first and `tileSize` second, so
    // the four corners of those two gates are the arm, and both refusals
    // are stated together because that is how the table reads:
    //
    //   obstacles  tiles      arm
    //   0          0          solo
    //   0          > 0        tiled -- no reached scene, refused
    //   > 0        > 0        tile cache
    //   > 0        0          a cache with no tile size, refused
    const obstacles = buildGate(context, options, "maxObstacles");
    const tiles = buildGate(context, options, "tileSize");
    if (obstacles === 0 && tiles !== 0) {
        context.fail(
            requiredProperty(context, options, "tileSize"),
            "createNavMesh with tileSize > 0 and no obstacles builds a " +
                "tiled navmesh, which is not lowered; the solo and " +
                "tile-cache arms are.",
        );
    }
    if (obstacles !== 0 && tiles === 0) {
        context.fail(
            requiredProperty(context, options, "maxObstacles"),
            "createNavMesh with maxObstacles > 0 needs a tileSize: the " +
                "cache is sized in tiles, and the pin's own default of 32 " +
                "is a size no reached scene relies on.",
        );
    }
    if (context.objectProperty(options, "doNotReverseIndices")) {
        context.fail(
            options,
            "createNavMesh's doNotReverseIndices is not lowered; the " +
                "reached merge carries the pin's reversed winding.",
        );
    }
}

/** The property behind a gate that read non-zero, so it is present. */
function requiredProperty(
    context: NavigationIntrinsicContext,
    options: ts.ObjectLiteralExpression,
    name: string,
): ts.Expression {
    return context.objectProperty(options, name) ?? options;
}

/**
 * A build gate's value where generation can see it, or 0 where the key is
 * absent.
 *
 * Which build arm runs is a compile-time fact -- it decides which PAL entry
 * point the scene calls and whether the obstacle surface is reachable at all
 * -- so a gate generation cannot fold is refused rather than guessed.
 */
function buildGate(
    context: NavigationIntrinsicContext,
    options: ts.ObjectLiteralExpression,
    name: string,
): number {
    const value = context.objectProperty(options, name);
    return value === undefined
        ? 0
        : compileStaticNumber(context, value, `createNavMesh's ${name}`);
}
