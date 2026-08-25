/**
 * The navigation family, lowered from `src/navigation/navigation.ts`.
 *
 * The pin draws the same line physics does: everything in the pinned
 * module is Babylon behaviour written against the `@recast-navigation`
 * wrapper surface, and that surface is the PAL's
 * (`bblite/pal_navigation.hpp`), implemented against the very
 * recastnavigation commit the wrapper's wasm compiles. Unlike physics,
 * nothing is substituted: the two sides run the same library, so the
 * navmesh and its queries are expected to agree with the browser up to
 * float rounding.
 *
 * What this lowerer emits is the pinned module's own logic:
 *
 * - `_mergeMeshes`: each mesh's CPU positions through its worldMatrix,
 *   merged with a running vertex base, and index winding reversed
 *   (i, i+2, i+1). The native loader bakes the pin's own mirrored
 *   world into its vertices (measured: the baked stream equals the
 *   pin's merged stream on the nav asset), so the emitted merge passes
 *   the baked positions through, asserted against the pin's own
 *   multiply rows.
 * - `_createNavMeshFromMerged`'s dispatch: the tile-cache and tiled
 *   arms refuse by name (their record plumbing does not exist yet); the
 *   solo arm hands the merged geometry and the present-key config to
 *   the PAL, whose build replays `generateSoloNavMesh` — and the
 *   config defaults the PAL bakes are read from the installed
 *   `@recast-navigation/core` at its exact pinned version, not retyped.
 * - `createDebugNavMeshGeometry` and `raycast` pass through to the PAL
 *   arms that carry their pinned arithmetic; the shapes here assert the
 *   pin still spells them the way those arms do.
 * - `getClosestPoint`, `createNavCrowd`, `addAgent` and
 *   `getAgentPosition` are the same shape one level up: the wrapper
 *   surface is the PAL's, and what the pinned module adds on top — the
 *   fixed ±1 half-extents, the three `?? N` agent-parameter defaults,
 *   the `{0,0,0}` an absent agent reads as — is emitted here.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { LoweredSource, LoweringContext } from "./context.js";
import { pinnedTrsComposition } from "./pinned-trs.js";

/**
 * `recastConfigDefaults` from the installed `@recast-navigation/core`,
 * pinned exact in package.json. The PAL bakes these numbers; reading
 * them from the package keeps them flowing from the pin rather than
 * living twice.
 */
export function pinnedRecastConfigDefaults(): ReadonlyMap<string, number> {
    return wrapperNumericDefaults("recastConfigDefaults");
}

/**
 * The `AgentParameters` fields the pinned `addAgent` resolves with a
 * `?? <default>` before the wrapper's spread ever sees them: the pinned
 * name, the PAL field it lands in, and the number.
 *
 * One copy for both ends, the shape `pinned-material-defaults.ts`
 * already holds for the UBO writers' discarded fallbacks.
 * `intrinsics/navigation.ts` emits these numbers, and `lowerNavigation`
 * builds its pinned-expression assertion out of the same entries — so a
 * moved number fails generation instead of splitting the two sides.
 */
export const PINNED_AGENT_PARAM_DEFAULTS: readonly (readonly [
    string,
    string,
    number,
])[] = [
    ["updateFlags", "update_flags", 7],
    ["obstacleAvoidanceType", "obstacle_avoidance_type", 0],
    ["queryFilterType", "query_filter_type", 0],
];

function wrapperNumericDefaults(
    variableName: string,
): ReadonlyMap<string, number> {
    const require = createRequire(import.meta.url);
    const modulePath = require.resolve(
        "@recast-navigation/core/dist/index.mjs",
    );
    const file = ts.createSourceFile(
        modulePath,
        readFileSync(modulePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    let literal: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
        if (literal) {
            return;
        }
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === variableName &&
            node.initializer &&
            ts.isObjectLiteralExpression(node.initializer)
        ) {
            literal = node.initializer;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (!literal) {
        throw new Error(
            `@recast-navigation/core no longer declares ${variableName} as an object literal.`,
        );
    }
    const defaults = new Map<string, number>();
    for (const property of literal.properties) {
        if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name) ||
            !ts.isNumericLiteral(property.initializer)
        ) {
            throw new Error(
                `${variableName} no longer holds plain numeric defaults.`,
            );
        }
        defaults.set(
            property.name.text,
            Number(property.initializer.text),
        );
    }
    return defaults;
}

export class NavigationLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerNavigation(): LoweredSource {
        const modulePath = "src/navigation/navigation.ts";
        const symbolName = "createNavMesh";

        // The PAL bakes `recastConfigDefaults`; this is the drift gate.
        // A bumped @recast-navigation that moves a default fails
        // generation here, naming the constant to move in
        // pal_navigation_recast.cpp.
        const bakedDefaults: readonly (readonly [string, number])[] = [
            ["borderSize", 0],
            ["tileSize", 0],
            ["cs", 0.2],
            ["ch", 0.2],
            ["walkableSlopeAngle", 60],
            ["walkableHeight", 2],
            ["walkableClimb", 2],
            ["walkableRadius", 0.5],
            ["maxEdgeLen", 12],
            ["maxSimplificationError", 1.3],
            ["minRegionArea", 8],
            ["mergeRegionArea", 20],
            ["maxVertsPerPoly", 6],
            ["detailSampleDist", 6],
            ["detailSampleMaxError", 1],
        ];
        const packageDefaults = pinnedRecastConfigDefaults();
        for (const [key, baked] of bakedDefaults) {
            if (packageDefaults.get(key) !== baked) {
                throw new Error(
                    `@recast-navigation/core's recastConfigDefaults.${key} ` +
                        `is ${packageDefaults.get(key)}, but ` +
                        `pal_navigation_recast.cpp bakes ${baked}. Move ` +
                        `the PAL constant with the package.`,
                );
            }
        }
        if (packageDefaults.size !== bakedDefaults.length) {
            throw new Error(
                "recastConfigDefaults grew a key the PAL does not bake.",
            );
        }

        // _mergeMeshes: the world multiply rows and the winding reversal
        // the emitted merge folds. The pin's worldMatrix is applied as
        // three dot-product rows; the emitted pass-through stands on
        // those rows being exactly the mirrored product the native bake
        // already performed, so the rows are the anchor.
        const { declaration: merge } =
            this.context.functionDeclaration(modulePath, "_mergeMeshes");
        for (const [lane, row] of [
            ["x", "x * wm[0] + y * wm[4] + z * wm[8] + wm[12]"],
            ["y", "x * wm[1] + y * wm[5] + z * wm[9] + wm[13]"],
            ["z", "x * wm[2] + y * wm[6] + z * wm[10] + wm[14]"],
        ] as const) {
            this.context.expectShapeCount(
                merge,
                row,
                `the merge world-matrix ${lane} row`,
            );
        }
        // The reversed triple: indices (i, i+2, i+1) plus the vertex
        // base. The lead shape counts twice because the pin's
        // `doNotReverseIndices` arm is a straight per-index copy of the
        // same expression; the intrinsic refuses that option, which is
        // what makes the reversed triple the arm this emission mirrors.
        for (const [shape, count] of [
            ["meshIdx[i] + vertBase", 2],
            ["meshIdx[i + 2] + vertBase", 1],
            ["meshIdx[i + 1] + vertBase", 1],
        ] as const) {
            this.context.expectShapeCount(
                merge,
                shape,
                "the merge winding arms over a running vertex base",
                count,
            );
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(merge, "vertBase"),
            "0",
            "Merge vertex base start",
        );

        // The other arm of `mesh.worldMatrix`: a scene-code mesh carries
        // no parent, so `getWorldMatrix` returns its local TRS
        // unmultiplied and the merge's rows read that matrix directly.
        // The identity short-circuit is bit-equal to composing an
        // identity transform, so the emitted composition covers both.
        const { declaration: composeLocal } =
            this.context.functionDeclaration(
                "src/scene/world-matrix-state.ts",
                "composeTrsLocalMatrix",
            );
        this.context.expectShapeCount(
            composeLocal,
            "isIdentity ? mat4Identity() : mat4Compose(position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, scaling.x, scaling.y, scaling.z)",
            "the unparented local world matrix",
        );
        const trs = pinnedTrsComposition(this.context);

        // _createNavMeshFromMerged: the dispatch this emission mirrors.
        const { declaration: fromMerged } =
            this.context.functionDeclaration(
                modulePath,
                "_createNavMeshFromMerged",
            );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                fromMerged,
                "needsTileCache",
            ),
            "(params.maxObstacles ?? 0) > 0",
            "Tile-cache dispatch",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(fromMerged, "needsTiled"),
            "(params.tileSize ?? 0) > 0",
            "Tiled dispatch",
        );
        if (
            !this.context.hasCall(fromMerged, "generateSoloNavMesh") &&
            !this.context.hasNode(
                fromMerged,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "generateSoloNavMesh",
            )
        ) {
            this.context.contractError(
                fromMerged,
                "Expected the solo arm to build through generateSoloNavMesh.",
            );
        }

        // raycast: nearest poly then 0 < t < 1, the PAL arm's contract.
        const { declaration: raycast } =
            this.context.functionDeclaration(modulePath, "raycast");
        if (
            !this.context.hasNode(
                raycast,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "findNearestPoly",
            )
        ) {
            this.context.contractError(
                raycast,
                "Expected raycast to resolve the start polygon first.",
            );
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(raycast, "t"),
            "r?.t ?? 0",
            "Raycast parameter read",
        );
        if (
            !this.context.hasNode(
                raycast,
                (node) =>
                    this.context.expressionMatchesShape(
                        node as ts.Expression,
                        "!(t > 0 && t < 1)",
                    ),
            )
        ) {
            this.context.contractError(
                raycast,
                "Expected the hit window to stay 0 < t < 1.",
            );
        }
        for (const lane of ["x", "y", "z"] as const) {
            if (
                !this.context.hasNode(
                    raycast,
                    (node) =>
                        this.context.expressionMatchesShape(
                            node as ts.Expression,
                            `start.${lane} + (end.${lane} - start.${lane}) * t`,
                        ),
                )
            ) {
                this.context.contractError(
                    raycast,
                    `Expected the hit point to lerp ${lane}.`,
                );
            }
        }

        // getClosestPoint: the fixed ±1 half-extents and the point read
        // straight off the result. The pin inspects no status here —
        // `findClosestPointWithin` is the arm that does — so the
        // emitted wrapper passes the PAL's point through the same way.
        const { declaration: closestPoint } =
            this.context.functionDeclaration(
                modulePath,
                "getClosestPoint",
            );
        this.context.assertExpressionShape(
            this.context.variableInitializer(closestPoint, "res"),
            "plugin._navMeshQuery.findClosestPoint(position, { halfExtents: _tmpHalfExtents })",
            "Closest-point query",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                this.context.sourceFile(modulePath),
                "_tmpHalfExtents",
            ),
            "{ x: 1, y: 1, z: 1 }",
            "Closest-point half extents",
        );
        for (const lane of ["x", "y", "z"] as const) {
            this.context.expectShapeCount(
                closestPoint,
                `res.point.${lane}`,
                `the closest-point ${lane} read`,
            );
        }

        // createNavCrowd: the wrapper's constructor over the plugin's
        // own navmesh, with the two numbers the scene named.
        const { declaration: createCrowd } =
            this.context.functionDeclaration(
                modulePath,
                "createNavCrowd",
            );
        this.context.assertExpressionShape(
            this.context.variableInitializer(createCrowd, "crowd"),
            "new Crowd(plugin._navMesh, { maxAgents, maxAgentRadius })",
            "Crowd construction",
        );

        // addAgent: the three `?? N` defaults the pinned module resolves
        // before the wrapper sees them, and the index it hands back.
        const { declaration: addAgent } =
            this.context.functionDeclaration(modulePath, "addAgent");
        const agentParams = this.context.objectInitializer(
            addAgent,
            "agentParams",
        );
        // The shapes are built FROM the shared table rather than typed
        // beside it, so the numbers the intrinsic emits and the numbers
        // the pin resolves are one copy: moving a table entry changes
        // the expression asserted here and fails against the pin.
        for (const [name, , value] of PINNED_AGENT_PARAM_DEFAULTS) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(agentParams, name),
                `params.${name} ?? ${value}`,
                `Agent parameter '${name}'`,
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(agentParams, "userData"),
            "0",
            "Agent parameter 'userData'",
        );
        // Every key the wrapper defaults is supplied above, so its own
        // `{...crowdAgentParamsDefaults, ...params}` spread is fully
        // overridden and the PAL owes those numbers nothing. A wrapper
        // that grows a twelfth default would start reaching the agent,
        // which is what this check refuses.
        const suppliedAgentKeys = new Set(
            agentParams.properties.flatMap((property) =>
                ts.isPropertyAssignment(property) &&
                    ts.isIdentifier(property.name)
                    ? [property.name.text]
                    : [],
            ),
        );
        for (const key of wrapperNumericDefaults(
            "crowdAgentParamsDefaults",
        ).keys()) {
            if (!suppliedAgentKeys.has(key)) {
                throw new Error(
                    `@recast-navigation/core defaults crowd agent ` +
                        `parameter '${key}', which the pinned addAgent ` +
                        `does not supply — so the wrapper's default now ` +
                        `reaches the agent and pal_navigation_recast.cpp ` +
                        `has to carry it.`,
                );
            }
        }
        this.context.expectShapeCount(
            addAgent,
            "agent.agentIndex",
            "the agent index addAgent returns",
        );

        // getAgentPosition: the optional read and its zero fallback.
        const { declaration: agentPosition } =
            this.context.functionDeclaration(
                modulePath,
                "getAgentPosition",
            );
        this.context.assertExpressionShape(
            this.context.variableInitializer(agentPosition, "p"),
            "crowd._crowd.getAgent(index)?.position()",
            "Agent position read",
        );
        this.context.expectShapeCount(
            agentPosition,
            "{ x: 0, y: 0, z: 0 }",
            "the absent-agent position fallback",
        );

        // createDebugNavMeshGeometry: the PAL arm carries the detached
        // rebuild; the pinned reversed storage (a, c, b) is the shape a
        // drift would silently break, so it is pinned here through the
        // store order.
        const { declaration: debugGeometry } =
            this.context.functionDeclaration(
                modulePath,
                "createDebugNavMeshGeometry",
            );
        if (
            !this.context.hasNode(
                debugGeometry,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "getNavMeshPositionsAndIndices",
            )
        ) {
            this.context.contractError(
                debugGeometry,
                "Expected the debug walk to read getNavMeshPositionsAndIndices.",
            );
        }

        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <bblite/pal_navigation.hpp>
#include <bblite/runtime.hpp>

#include <vector>

namespace bbl::upstream {

bbl::pal::NavigationHandle create_navigation_plugin();
void create_nav_mesh(
    Engine& engine,
    bbl::pal::NavigationHandle plugin,
    const std::vector<MeshHandle>& meshes,
    const bbl::pal::NavMeshBuildParams& params);
bbl::pal::NavDebugGeometry create_debug_nav_mesh_geometry(
    bbl::pal::NavigationHandle plugin);
struct NavRaycastResult {
    bool hit = false;
    Vec3d hit_point{};
};
NavRaycastResult nav_raycast(
    bbl::pal::NavigationHandle plugin,
    Vec3d start,
    Vec3d end);
Vec3d nav_closest_point(
    bbl::pal::NavigationHandle plugin,
    Vec3d position);
bbl::pal::NavCrowdHandle create_nav_crowd(
    bbl::pal::NavigationHandle plugin,
    double max_agents,
    double max_agent_radius);
double add_agent(
    bbl::pal::NavCrowdHandle crowd,
    Vec3d position,
    const bbl::pal::NavAgentParams& params);
Vec3d get_agent_position(
    bbl::pal::NavCrowdHandle crowd,
    double index);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName, "createNavigationPluginAsync, createDebugNavMeshGeometry, raycast")}
#include <bblite/upstream/navigation.hpp>

#include <array>
#include <cmath>
#include <cstddef>
#include <optional>
#include <stdexcept>

namespace bbl::upstream {

bbl::pal::NavigationHandle create_navigation_plugin() {
    return bbl::pal::navigation_create_plugin();
}

// src/scene/world-matrix-state.ts composeTrsLocalMatrix +
// src/math/mat4-compose-into.ts mat4ComposeInto: a scene-code mesh has
// no parent, so its worldMatrix IS its local TRS -- composed in
// JavaScript double precision and stored to f32 exactly like the pinned
// Float32Array world matrix. src/math/quat-euler.ts eulerToQuat
// converts Euler records the way the pinned Euler proxy writes the
// quaternion source of truth (non-zero Euler angles inherit the
// recorded std::sin/cos-versus-V8 ULP caveat).
std::array<float, 16> nav_mesh_world(const MeshRecord& mesh) {
${trs.composeLocalBody}\
    std::array<float, 16> result{};
    for (std::size_t cell = 0; cell < 16; ++cell) {
        result[cell] = static_cast<float>(local[cell]);
    }
    return result;
}

// _mergeMeshes: the pin multiplies each mesh's CPU positions through
// its worldMatrix and reverses the winding (i, i+2, i+1) over a running
// vertex base. What differs here is only where that world already is,
// which the geometry records as its vertex space.
//
// VertexSpace::world is the glTF loader's static arm: it baked the
// mirrored node world into every position — measured on nav_test.glb,
// each baked position equals the pin's stream value — so the rows are
// the identity and the positions pass through, and a scene-code TRS on
// top would need composing that world again, so it refuses.
// VertexSpace::local keeps the transform on the record, exactly as the
// pin keeps _cpuPositions local, so the rows are the composed TRS
// above. VertexSpace::mirrored_local carries half a world and the node
// matrix arrives per draw, so it refuses by name.
void create_nav_mesh(
    Engine& engine,
    bbl::pal::NavigationHandle plugin,
    const std::vector<MeshHandle>& meshes,
    const bbl::pal::NavMeshBuildParams& params) {
    bbl::pal::NavMeshGeometry merged;
    std::size_t vertex_base = 0;
    for (const MeshHandle handle : meshes) {
        if (handle.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle for navmesh");
        }
        const MeshRecord& mesh = engine.meshes[handle.value];
        if (mesh.geometry >= engine.geometries.size()) {
            throw std::runtime_error(
                "Mesh '" + mesh.name +
                "' missing CPU geometry for navmesh");
        }
        const ModelGeometry& geometry =
            engine.geometries[mesh.geometry];
        if (geometry.vertex_space == VertexSpace::mirrored_local) {
            throw std::runtime_error(
                "createNavMesh is lowered for meshes whose vertices are "
                "local or fully world-baked; mesh '" + mesh.name +
                "' is animated or instanced, so its node matrix reaches "
                "the draw rather than its geometry.");
        }
        const bool baked_world =
            geometry.vertex_space == VertexSpace::world;
        if (baked_world &&
            (mesh.position.x != 0.0f || mesh.position.y != 0.0f ||
             mesh.position.z != 0.0f ||
             mesh.rotation.x != 0.0f || mesh.rotation.y != 0.0f ||
             mesh.rotation.z != 0.0f ||
             mesh.has_rotation_quaternion ||
             mesh.scaling.x != 1.0f || mesh.scaling.y != 1.0f ||
             mesh.scaling.z != 1.0f)) {
            throw std::runtime_error(
                "createNavMesh is lowered for imported meshes at their "
                "loaded transform; mesh '" + mesh.name +
                "' carries scene-code TRS on top of a baked world, "
                "which the merge does not compose.");
        }
        merged.positions.reserve(
            merged.positions.size() +
            geometry.vertices.size() * 3);
        if (baked_world) {
            for (const ModelVertex& vertex : geometry.vertices) {
                merged.positions.push_back(vertex.position.x);
                merged.positions.push_back(vertex.position.y);
                merged.positions.push_back(vertex.position.z);
            }
        } else {
            const std::array<float, 16> wm = nav_mesh_world(mesh);
            for (const ModelVertex& vertex : geometry.vertices) {
                const double x = vertex.position.x;
                const double y = vertex.position.y;
                const double z = vertex.position.z;
                merged.positions.push_back(static_cast<float>(
                    x * wm[0] + y * wm[4] + z * wm[8] + wm[12]));
                merged.positions.push_back(static_cast<float>(
                    x * wm[1] + y * wm[5] + z * wm[9] + wm[13]));
                merged.positions.push_back(static_cast<float>(
                    x * wm[2] + y * wm[6] + z * wm[10] + wm[14]));
            }
        }
        merged.indices.reserve(
            merged.indices.size() + geometry.indices.size());
        for (std::size_t index = 0;
             index + 2 < geometry.indices.size();
             index += 3) {
            merged.indices.push_back(static_cast<std::uint32_t>(
                geometry.indices[index] + vertex_base));
            merged.indices.push_back(static_cast<std::uint32_t>(
                geometry.indices[index + 2] + vertex_base));
            merged.indices.push_back(static_cast<std::uint32_t>(
                geometry.indices[index + 1] + vertex_base));
        }
        vertex_base += geometry.vertices.size();
    }
    bbl::pal::navigation_create_solo_nav_mesh(
        plugin, merged, params);
}

bbl::pal::NavDebugGeometry create_debug_nav_mesh_geometry(
    bbl::pal::NavigationHandle plugin) {
    return bbl::pal::navigation_debug_geometry(plugin);
}

// raycast: the PAL answers the pinned hit window; the hit point is
// the pinned lerp, in doubles as JavaScript computes it from the f32
// parameter.
NavRaycastResult nav_raycast(
    bbl::pal::NavigationHandle plugin,
    Vec3d start,
    Vec3d end) {
    const bbl::pal::NavRaycastHit raw = bbl::pal::navigation_raycast(
        plugin,
        static_cast<float>(start.x),
        static_cast<float>(start.y),
        static_cast<float>(start.z),
        static_cast<float>(end.x),
        static_cast<float>(end.y),
        static_cast<float>(end.z));
    if (!raw.hit) {
        return NavRaycastResult{};
    }
    const double t = raw.t;
    return NavRaycastResult{
        true,
        Vec3d{
            start.x + (end.x - start.x) * t,
            start.y + (end.y - start.y) * t,
            start.z + (end.z - start.z) * t,
        },
    };
}

// getClosestPoint: the PAL runs the wrapper's two-call query at the
// pinned ±1 half-extents and the point is read straight off it. The pin
// inspects no status — its own comment says a position with nothing
// nearby returns an unspecified point — so the failure arm passes the
// PAL's zeroed buffer through rather than inventing a signal the scene
// has no way to read.
Vec3d nav_closest_point(
    bbl::pal::NavigationHandle plugin,
    Vec3d position) {
    const bbl::pal::NavVec3 point = bbl::pal::navigation_closest_point(
        plugin,
        static_cast<float>(position.x),
        static_cast<float>(position.y),
        static_cast<float>(position.z));
    return Vec3d{point.x, point.y, point.z};
}

bbl::pal::NavCrowdHandle create_nav_crowd(
    bbl::pal::NavigationHandle plugin,
    double max_agents,
    double max_agent_radius) {
    return bbl::pal::navigation_create_crowd(
        plugin,
        static_cast<int>(max_agents),
        static_cast<float>(max_agent_radius));
}

double add_agent(
    bbl::pal::NavCrowdHandle crowd,
    Vec3d position,
    const bbl::pal::NavAgentParams& params) {
    return static_cast<double>(bbl::pal::navigation_add_agent(
        crowd,
        static_cast<float>(position.x),
        static_cast<float>(position.y),
        static_cast<float>(position.z),
        params));
}

// getAgentPosition: the pin reads through an optional chain and answers
// {0, 0, 0} when the crowd holds no agent at that index.
Vec3d get_agent_position(
    bbl::pal::NavCrowdHandle crowd,
    double index) {
    const std::optional<bbl::pal::NavVec3> position =
        bbl::pal::navigation_agent_position(
            crowd, static_cast<int>(index));
    if (!position) {
        return Vec3d{0.0, 0.0, 0.0};
    }
    return Vec3d{position->x, position->y, position->z};
}

} // namespace bbl::upstream
`,
        };
    }
}
