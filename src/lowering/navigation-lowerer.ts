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
 *   (i, i+2, i+1). The native geometry already carries the node world
 *   baked into its vertices WITHOUT the RH→LH mirror, and the pin's
 *   worldMatrix is the mirror times that node world — a sign flip is
 *   exact in float, so the emitted merge negates the baked X instead of
 *   re-multiplying, asserted against the pin's own multiply rows.
 * - `_createNavMeshFromMerged`'s dispatch: the tile-cache and tiled
 *   arms refuse by name (their record plumbing does not exist yet); the
 *   solo arm hands the merged geometry and the present-key config to
 *   the PAL, whose build replays `generateSoloNavMesh` — and the
 *   config defaults the PAL bakes are read from the installed
 *   `@recast-navigation/core` at its exact pinned version, not retyped.
 * - `createDebugNavMeshGeometry` and `raycast` pass through to the PAL
 *   arms that carry their pinned arithmetic; the shapes here assert the
 *   pin still spells them the way those arms do.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { LoweredSource, LoweringContext } from "./context.js";

/**
 * `recastConfigDefaults` from the installed `@recast-navigation/core`,
 * pinned exact in package.json. The PAL bakes these numbers; reading
 * them from the package keeps them flowing from the pin rather than
 * living twice.
 */
export function pinnedRecastConfigDefaults(): ReadonlyMap<string, number> {
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
        if (
            !literal &&
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "recastConfigDefaults" &&
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
            "@recast-navigation/core no longer declares recastConfigDefaults as an object literal.",
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
                "recastConfigDefaults no longer holds plain numeric defaults.",
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
        const file = this.context.sourceFile(modulePath);

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
        // three dot-product rows; the emitted negate-X stands on those
        // rows being exactly the matrix product the native bake already
        // performed (mirror excluded), so the rows are the anchor.
        const { declaration: merge } =
            this.context.functionDeclaration(modulePath, "_mergeMeshes");
        for (const [lane, row] of [
            ["x", "x * wm[0] + y * wm[4] + z * wm[8] + wm[12]"],
            ["y", "x * wm[1] + y * wm[5] + z * wm[9] + wm[13]"],
            ["z", "x * wm[2] + y * wm[6] + z * wm[10] + wm[14]"],
        ] as const) {
            const carried = this.context
                .findNodes(
                    merge,
                    (node): node is ts.Expression =>
                        this.context.expressionMatchesShape(
                            node as ts.Expression,
                            row,
                        ),
                ).length;
            if (carried !== 1) {
                this.context.contractError(
                    merge,
                    `Expected the merge to apply the world matrix ${lane} row once.`,
                );
            }
        }
        // The reversed triple: indices (i, i+2, i+1) plus the vertex base.
        for (const shape of [
            "meshIdx[i]! + vertBase",
            "meshIdx[i + 2]! + vertBase",
            "meshIdx[i + 1]! + vertBase",
        ]) {
            const carried = this.context
                .findNodes(
                    merge,
                    (node): node is ts.Expression =>
                        this.context.expressionMatchesShape(
                            node as ts.Expression,
                            shape.replace(/!/g, ""),
                        ),
                ).length;
            if (carried < 1) {
                this.context.contractError(
                    merge,
                    "Expected the merge to reverse index winding over a running vertex base.",
                );
            }
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(merge, "vertBase"),
            "0",
            "Merge vertex base start",
        );

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

        void file;
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

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName, "createNavigationPluginAsync, createDebugNavMeshGeometry, raycast")}
#include <bblite/upstream/navigation.hpp>

#include <stdexcept>

namespace bbl::upstream {

bbl::pal::NavigationHandle create_navigation_plugin() {
    return bbl::pal::navigation_create_plugin();
}

// _mergeMeshes, folded onto the native bake: the pin applies each
// mesh's worldMatrix (the RH→LH mirror times the node world) to raw
// CPU positions; the native geometry carries the node world baked into
// its vertices without the mirror, so the pin's stream is the baked
// position with X negated — a sign flip, exact in float. Winding is
// reversed (i, i+2, i+1) over a running vertex base exactly as the pin
// writes it.
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
        // The negate-X fold stands on the vertices carrying the node
        // world baked without the mirror — true for glTF-imported
        // meshes at rest. A factory mesh's world lives in its TRS
        // record instead, which this merge does not compose yet.
        if (
            mesh.primitive != PrimitiveKind::gltf ||
            mesh.position.x != 0.0f || mesh.position.y != 0.0f ||
            mesh.position.z != 0.0f ||
            mesh.rotation.x != 0.0f || mesh.rotation.y != 0.0f ||
            mesh.rotation.z != 0.0f ||
            mesh.scaling.x != 1.0f || mesh.scaling.y != 1.0f ||
            mesh.scaling.z != 1.0f) {
            throw std::runtime_error(
                "createNavMesh is lowered for glTF-imported meshes at "
                "their loaded transform; mesh \"" + mesh.name +
                "\" carries scene-code TRS the merge does not compose "
                "yet.");
        }
        if (mesh.geometry >= engine.geometries.size()) {
            throw std::runtime_error(
                "Mesh \\"" + mesh.name +
                "\\" missing CPU geometry for navmesh");
        }
        const ModelGeometry& geometry =
            engine.geometries[mesh.geometry];
        merged.positions.reserve(
            merged.positions.size() +
            geometry.vertices.size() * 3);
        for (const ModelVertex& vertex : geometry.vertices) {
            merged.positions.push_back(-vertex.position.x);
            merged.positions.push_back(vertex.position.y);
            merged.positions.push_back(vertex.position.z);
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

} // namespace bbl::upstream
`,
        };
    }
}
