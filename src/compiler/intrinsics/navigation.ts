import type { LoweringServices } from "../lowering-services.js";
// The navigation family: `createNavigationPluginAsync`, `createNavMesh`,
// `createDebugNavMeshGeometry`, `raycast`.
//
// The pinned module's own logic is generated (upstream/navigation.cpp,
// src/lowering/navigation-lowerer.ts); the toolset behind it is the
// PAL's, linked from the exact recastnavigation commit the pinned
// wrapper's wasm compiles — so unlike physics, nothing is substituted
// and the answers are expected to match the browser reference.
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import { handleCppType } from "../data-types.js";
import type { Value } from "../types.js";
import type { NativeCaptureBinding } from "../closure-captures.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    validateObjectProperties,
    compileStaticNumber,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";
import { pinnedAgentParamDefaults } from "../../lowering/navigation-lowerer.js";
import { NAV_MESH_BUILD_PARAM_FIELDS } from "../../lowering/navigation-build-plan.js";

export interface NavigationIntrinsicContext
    extends
        IntrinsicCallContext,
        ObjectValidationContext,
        PositiveIntegerContext,
        Pick<
            LoweringServices,
            | "expectObjectLiteral"
            | "expectStaticArrayLiteral"
            | "objectProperty"
            | "compileNumber"
            | "compileVec3"
            | "compileBoolean"
            | "emitDataVectorOfStructs"
            | "allocateTemporaryCppName"
            | "registerNativeBinding"
            | "registerNativeTemporary"
            | "emit"
            | "requireEngine"
            | "unwrap"
        > {}

/**
 * The build parameters a reached `createNavMesh` may name: the numbers
 * the generated build plan reads (`NAV_MESH_BUILD_PARAM_FIELDS`), then the
 * rest. `keepIntermediates` is accepted and discarded — it only decides
 * whether the wrapper frees Recast intermediates, which the native build
 * frees unconditionally; nothing reached reads them.
 */
const NAV_MESH_PARAM_NAMES = [
    ...NAV_MESH_BUILD_PARAM_FIELDS.keys(),
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
    const value = context.objectProperty(options, "offMeshConnections");
    if (!value) {
        return;
    }
    for (const element of context.expectStaticArrayLiteral(value).elements) {
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
            const temporary = context.allocateTemporaryCppName("nav_offmesh");
            context.emit({
                kind: "declaration",
                type: "const bbl::Vec3",
                name: temporary,
                initializer: context.compileVec3(required(name)),
            });
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
        context.emit({
            kind: "expression",
            code:
                `${parameters}.off_mesh_connections.push_back(` +
                `bbl::pal::NavOffMeshConnection{${fields.join(", ")}});`,
        });
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
            const plugin = context.compileValue(argumentAt(call, 0));
            context.expectKind(plugin, "navigation", argumentAt(call, 0));
            const meshList = context.expectStaticArrayLiteral(
                argumentAt(call, 1),
            );
            const meshes = meshList.elements.map((element) => {
                const mesh = context.compileValue(element);
                context.expectKind(mesh, "mesh", element);
                return mesh;
            });
            if (meshes.length === 0) {
                context.fail(
                    argumentAt(call, 1),
                    "createNavMesh requires at least one mesh.",
                );
            }
            const engine = context.requireEngine(meshes[0]!, call);
            const options = context.expectObjectLiteral(argumentAt(call, 2));
            validateNavMeshParams(context, options);
            // Which arm this build takes is decided HERE and nowhere else:
            // the feature is what carries it to the emitted dispatch, to
            // the PAL half that gets compiled, and to the third-party
            // library that gets linked.
            const tileCache = buildGate(context, options, "maxObstacles") > 0;
            if (tileCache) {
                context.reachFeature("navigation:tile-cache", call);
            }
            const parameters = context.allocateTemporaryCppName("nav_params");
            context.emit({
                kind: "declaration",
                type: "bbl::pal::NavMeshBuildParams",
                name: parameters,
                initializer: "",
                initialization: "default",
            });
            for (const [name, field] of NAV_MESH_BUILD_PARAM_FIELDS) {
                const value = context.objectProperty(options, name);
                if (value) {
                    context.emit({
                        kind: "expression",
                        code: `${parameters}.${field} = ${context.compileNumber(value, "double")};`,
                    });
                }
            }
            emitOffMeshConnections(context, options, parameters);
            return {
                kind: "void",
                cpp:
                    `bbl::upstream::create_nav_mesh(${engine}, ` +
                    `${plugin.cpp}, ` +
                    `std::vector<${handleCppType("mesh")}>{${meshes
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
            const plugin = context.compileValue(argumentAt(call, 0));
            context.expectKind(plugin, "navigation", argumentAt(call, 0));
            const position = context.compileVec3(argumentAt(call, 1), "double");
            const second = box
                ? context.compileVec3(argumentAt(call, 2), "double")
                : context.compileNumber(argumentAt(call, 2), "double");
            const third = context.compileNumber(argumentAt(call, 3), "double");
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
            const plugin = context.compileValue(argumentAt(call, 0));
            context.expectKind(plugin, "navigation", argumentAt(call, 0));
            const obstacle = context.compileValue(argumentAt(call, 1));
            context.expectKind(
                obstacle,
                "navigation-obstacle",
                argumentAt(call, 1),
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
            const plugin = context.compileValue(argumentAt(call, 0));
            context.expectKind(plugin, "navigation", argumentAt(call, 0));
            return {
                kind: "void",
                cpp:
                    `bbl::upstream::update_nav_mesh_obstacles(` +
                    `${plugin.cpp})`,
            };
        }

        case "computePath": {
            context.expectArgumentCount(call, 3, 3);
            const plugin = context.compileValue(argumentAt(call, 0));
            context.expectKind(plugin, "navigation", argumentAt(call, 0));
            const start = context.compileVec3(argumentAt(call, 1), "double");
            const end = context.compileVec3(argumentAt(call, 2), "double");
            const path = context.allocateTemporaryCppName("nav_path");
            context.emit({
                kind: "declaration",
                type: "const std::vector<bbl::Vec3d>",
                name: path,
                initializer: `bbl::upstream::nav_compute_path(${plugin.cpp}, ${start}, ${end})`,
            });
            // The element struct is the scene's own `Vec3`, so its fields
            // are filled by name rather than by position -- the pinned
            // interface declares x, y, z, but the generated order is the
            // registry's to decide.
            return context.emitDataVectorOfStructs(call, path, (point) => ({
                x: `${point}.x`,
                y: `${point}.y`,
                z: `${point}.z`,
            }));
        }

        case "agentGoto": {
            context.expectArgumentCount(call, 3, 3);
            const crowd = context.compileValue(argumentAt(call, 0));
            context.expectKind(crowd, "navigation-crowd", argumentAt(call, 0));
            const index = context.compileNumber(argumentAt(call, 1), "double");
            const destination = context.compileVec3(
                argumentAt(call, 2),
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
            const crowd = context.compileValue(argumentAt(call, 0));
            context.expectKind(crowd, "navigation-crowd", argumentAt(call, 0));
            const delta = context.compileNumber(argumentAt(call, 1), "double");
            return {
                kind: "void",
                cpp:
                    `bbl::upstream::update_nav_crowd(` +
                    `${crowd.cpp}, ${delta})`,
            };
        }

        case "createDebugNavMeshGeometry": {
            context.expectArgumentCount(call, 1, 1);
            const plugin = context.compileValue(argumentAt(call, 0));
            context.expectKind(plugin, "navigation", argumentAt(call, 0));
            const temporary = context.allocateTemporaryCppName("nav_debug");
            context.emit({
                kind: "declaration",
                type: "const bbl::pal::NavDebugGeometry",
                name: temporary,
                initializer: `bbl::upstream::create_debug_nav_mesh_geometry(${plugin.cpp})`,
            });
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
                    positionsHash: {
                        kind: "number",
                        cpp: `${temporary}.positions_hash`,
                    },
                },
            };
        }

        case "raycast": {
            context.expectArgumentCount(call, 3, 3);
            const plugin = context.compileValue(argumentAt(call, 0));
            context.expectKind(plugin, "navigation", argumentAt(call, 0));
            const start = context.compileVec3(argumentAt(call, 1), "double");
            const end = context.compileVec3(argumentAt(call, 2), "double");
            const temporary = context.allocateTemporaryCppName("nav_ray");
            context.emit({
                kind: "declaration",
                type: "const bbl::upstream::NavRaycastResult",
                name: temporary,
                initializer: `bbl::upstream::nav_raycast(${plugin.cpp}, ${start}, ${end})`,
            });
            const owner = context.registerNativeBinding(temporary);
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
                        nativeCaptures: [owner],
                    },
                    hitPoint: {
                        ...vec3LanesOf(`${temporary}.hit_point`, owner),
                        optionalFoundCpp: `${temporary}.hit`,
                        nativeCompanionCaptures: { optionalFoundCpp: [owner] },
                    },
                },
            };
        }

        case "getClosestPoint": {
            context.expectArgumentCount(call, 2, 2);
            const plugin = context.compileValue(argumentAt(call, 0));
            context.expectKind(plugin, "navigation", argumentAt(call, 0));
            const position = context.compileVec3(argumentAt(call, 1), "double");
            return navVec3Record(
                context,
                "nav_closest",
                `bbl::upstream::nav_closest_point(${plugin.cpp}, ${position})`,
            );
        }

        case "createNavCrowd": {
            context.reachFeature("navigation:crowd", call);
            context.expectArgumentCount(call, 3, 3);
            const plugin = context.compileValue(argumentAt(call, 0));
            context.expectKind(plugin, "navigation", argumentAt(call, 0));
            const maxAgents = context.compileNumber(
                argumentAt(call, 1),
                "double",
            );
            const maxAgentRadius = context.compileNumber(
                argumentAt(call, 2),
                "double",
            );
            const crowd = context.allocateTemporaryCppName("nav_crowd");
            context.emit({
                kind: "declaration",
                type: "bbl::pal::NavCrowdHandle",
                name: crowd,
                initializer: `bbl::upstream::create_nav_crowd(${plugin.cpp}, ${maxAgents}, ${maxAgentRadius})`,
            });
            context.registerNativeTemporary(crowd);
            return { kind: "navigation-crowd", cpp: crowd };
        }

        case "addAgent": {
            context.expectArgumentCount(call, 3, 3);
            const crowd = context.compileValue(argumentAt(call, 0));
            context.expectKind(crowd, "navigation-crowd", argumentAt(call, 0));
            const position = context.compileVec3(argumentAt(call, 1), "double");
            const options = context.expectObjectLiteral(argumentAt(call, 2));
            validateObjectProperties(
                context,
                options,
                agentParamNames(),
                "Reached crowd agents name the pinned dtCrowdAgentParams fields.",
            );
            // `reachRadius` is the one `AgentParameters` field the pinned
            // `addAgent` never forwards, so upstream drops it silently.
            // Refusing by name says so rather than compiling a scene
            // whose author expects it to reach the agent.
            if (context.objectProperty(options, "reachRadius")) {
                context.fail(
                    argumentAt(call, 2),
                    "addAgent's reachRadius is declared but never " +
                        "forwarded to the crowd by the pinned module.",
                );
            }
            const parameters = context.allocateTemporaryCppName("agent_params");
            context.emit({
                kind: "declaration",
                type: "bbl::pal::NavAgentParams",
                name: parameters,
                initializer: "",
                initialization: "default",
            });
            for (const [name, field] of AGENT_FLOAT_PARAMS) {
                const value = context.objectProperty(options, name);
                if (!value) {
                    context.fail(
                        argumentAt(call, 2),
                        `addAgent requires '${name}'; the pinned ` +
                            "parameters carry no default for it.",
                    );
                }
                context.emit({
                    kind: "expression",
                    code:
                        `${parameters}.${field} = static_cast<float>(` +
                        `${context.compileNumber(value, "double")});`,
                });
            }
            // The pin's own `?? N` defaults, resolved here so the
            // wrapper's spread never decides them, read off the pinned
            // `addAgent` itself.
            for (const [name, field, fallback] of pinnedAgentParamDefaults()) {
                const value = context.objectProperty(options, name);
                const resolved = value
                    ? context.compileNumber(value, "double")
                    : String(fallback);
                context.emit({
                    kind: "expression",
                    code:
                        `${parameters}.${field} = ` +
                        `static_cast<unsigned char>(${resolved});`,
                });
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
            const crowd = context.compileValue(argumentAt(call, 0));
            context.expectKind(crowd, "navigation-crowd", argumentAt(call, 0));
            const index = context.compileNumber(argumentAt(call, 1), "double");
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
 * caller must supply. The three it defaults with `?? N` are read off it
 * (`pinnedAgentParamDefaults`); `reachRadius` is declared upstream and
 * forwarded nowhere, so it is refused at the call site instead.
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

function agentParamNames(): string[] {
    return [
        ...AGENT_FLOAT_PARAMS.map(([name]) => name),
        ...pinnedAgentParamDefaults().map(([name]) => name),
        "reachRadius",
    ];
}

/**
 * The three lanes of a native vector, as a record the scene reads at run
 * time. Every navigation query answers in one, whether the vector is the
 * whole result or a member of it.
 */
function vec3LanesOf(base: string, owner: NativeCaptureBinding): Value {
    return {
        kind: "record",
        cpp: "",
        recordProperties: {
            x: { kind: "number", cpp: `${base}.x`, nativeCaptures: [owner] },
            y: { kind: "number", cpp: `${base}.y`, nativeCaptures: [owner] },
            z: { kind: "number", cpp: `${base}.z`, nativeCaptures: [owner] },
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
    context.emit({
        kind: "declaration",
        type: "const bbl::Vec3d",
        name: temporary,
        initializer: expression,
    });
    return vec3LanesOf(temporary, context.registerNativeBinding(temporary));
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
    // the corners of those two gates are the arm, and both refusals are
    // stated together because that is how the table reads:
    //
    //   obstacles  tiles      arm
    //   0          0          solo
    //   0          > 0        tiled -- no reached scene, refused
    //   > 0        > 0        tile cache
    //   > 0        absent     tile cache at the pin's own `?? 32`
    //   > 0        0          a cache of zero-cell tiles, refused
    const obstacles = buildGate(context, options, "maxObstacles");
    const tiles = buildGate(context, options, "tileSize");
    if (obstacles <= 0 && tiles > 0) {
        context.fail(
            requiredProperty(context, options, "tileSize"),
            "createNavMesh with tileSize > 0 and no obstacles builds a " +
                "tiled navmesh, which is not lowered; the solo and " +
                "tile-cache arms are.",
        );
    }
    if (
        obstacles > 0 &&
        tiles === 0 &&
        context.objectProperty(options, "tileSize")
    ) {
        context.fail(
            requiredProperty(context, options, "tileSize"),
            "createNavMesh with maxObstacles > 0 and tileSize 0 sizes the " +
                "cache in zero-cell tiles.",
        );
    }
    // The pin's tile-cache arm bakes non-empty off-mesh connections through
    // its own `_createDefaultTileCacheMeshProcess`, which is not lowered;
    // the PAL's tile cache installs the wrapper's default process only.
    const connections = context.objectProperty(options, "offMeshConnections");
    if (
        obstacles > 0 &&
        connections &&
        context.expectStaticArrayLiteral(connections).elements.length > 0
    ) {
        context.fail(
            connections,
            "createNavMesh with maxObstacles > 0 and offMeshConnections " +
                "installs the pinned _createDefaultTileCacheMeshProcess, " +
                "which is not lowered.",
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
