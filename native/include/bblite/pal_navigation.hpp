#pragma once

/**
 * The navigation-toolset boundary.
 *
 * Like the rigid-body seam, this is a third-party library behind a fixed
 * entry-point list — and the list is upstream's own: the pinned
 * `src/navigation/navigation.ts` reaches Recast/Detour only through the
 * `@recast-navigation` wrapper this surface mirrors, and the wasm that
 * wrapper loads is compiled from the very recastnavigation sources the
 * native library links (the overlay port pins the wrapper's own fork
 * commit). Unlike physics, the two sides therefore run the *same*
 * algorithms: the navmesh a build produces and the answers queries give
 * are expected to match the browser reference up to float rounding, not
 * merely by trajectory.
 *
 * The functions below carry the wrapper's semantics exactly where they
 * add any: the solo-build pipeline is `generateSoloNavMesh`'s sequence
 * with its config defaults (its build-config step is generated from the
 * package and handed in); the debug geometry is the wrapper's
 * detached-triangle flat-normal build with its reversed stored winding;
 * the raycast is `findNearestPoly` (±1 half-extents, include-all filter)
 * then `dtNavMeshQuery::raycast`, hit exactly when `0 < t < 1`. Nothing
 * generated names Recast — swapping the toolset is dropping in a different
 * translation unit.
 */

#include <cstdint>
#include <memory>
#include <optional>
#include <vector>

namespace bbl::pal {

struct NavigationPluginState;
struct NavigationMeshState;
struct NavCrowdState;

/** One navigation plugin: a navmesh and its query. */
struct NavigationHandle {
    std::uint32_t value = 0;
    std::shared_ptr<NavigationPluginState> ownership;
};

/** One crowd, built over a plugin's navmesh. */
struct NavCrowdHandle {
    std::uint32_t value = 0;
    std::shared_ptr<NavCrowdState> ownership;
};

/** A world position as the wrapper's `Vec3` carries one: three floats. */
struct NavVec3 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
};

/**
 * One off-mesh connection, as `OffMeshConnection` carries it.
 *
 * `area`, `flags` and `userId` are optional upstream with defaults the
 * wrapper's `setOffMeshConnections` applies -- 0, 1, and `1000 + index`
 * respectively. The index-dependent one is why the default is resolved
 * where the array is packed rather than at the write site.
 */
struct NavOffMeshConnection {
    NavVec3 start;
    NavVec3 end;
    float radius = 0.0f;
    bool bidirectional = false;
    std::optional<double> area;
    std::optional<double> flags;
    std::optional<double> user_id;
};

/**
 * The wrapper's build-config defaults: `recastConfigDefaults` and the
 * `NavMeshQuery` every arm ends by constructing, each a JavaScript number
 * as the installed @recast-navigation packages state it. The generated
 * navigation header reads them from the packages at generation and hands
 * them to the build, which narrows each the way the wrapper stores it.
 */
struct NavBuildDefaults {
    double border_size;
    double tile_size;
    double cs;
    double ch;
    double walkable_slope_angle;
    double walkable_height;
    double walkable_climb;
    double walkable_radius;
    double max_edge_len;
    double max_simplification_error;
    double min_region_area;
    double merge_region_area;
    double max_verts_per_poly;
    double detail_sample_dist;
    double detail_sample_max_error;
    /** `new NavMeshQuery(navMesh)`: the `maxNodes` default it initializes with. */
    double query_max_nodes;
    /** `NavMeshQuery.defaultQueryHalfExtents`, x-y-z: the box every
     *  nearest-polygon search spans around its position. */
    double query_half_extents[3];
};

/**
 * The build parameters a reached `createNavMesh` may carry. Absent
 * fields take the wrapper's defaults (`NavBuildDefaults`) inside the
 * build, exactly as its `{...defaults, ...cfg}` spread does.
 */
struct NavMeshBuildParams {
    std::optional<double> cs;
    std::optional<double> ch;
    std::optional<double> walkable_slope_angle;
    std::optional<double> walkable_height;
    std::optional<double> walkable_climb;
    std::optional<double> walkable_radius;
    std::optional<double> max_edge_len;
    std::optional<double> max_simplification_error;
    std::optional<double> min_region_area;
    std::optional<double> merge_region_area;
    std::optional<double> max_verts_per_poly;
    std::optional<double> detail_sample_dist;
    std::optional<double> detail_sample_max_error;
    /** Baked into the navmesh as teleport segments; empty means none. */
    std::vector<NavOffMeshConnection> off_mesh_connections;
    /**
     * The tile-cache arm's three, which the pinned `createNavMesh` reads
     * before any of the above: `maxObstacles > 0` selects the arm, and the
     * pinned module resolves the other two before the wrapper's spread, so
     * a tile-cache build always carries all three.
     */
    std::optional<double> tile_size;
    std::optional<double> expected_layers_per_tile;
    std::optional<double> max_obstacles;
};

/**
 * The wrapper's `rcConfig` object as its generators read and write it:
 * every scalar field, at Recast's own width. A store narrows the way the
 * wrapper's setter does -- an `int` field takes ToInt32 of the JavaScript
 * number, a `float` field its nearest float -- and a read widens exactly.
 * The build checks each field against Recast's `rcConfig` as it copies.
 */
struct NavRcConfig {
    int width = 0;
    int height = 0;
    int tileSize = 0;
    int borderSize = 0;
    float cs = 0.0f;
    float ch = 0.0f;
    float walkableSlopeAngle = 0.0f;
    int walkableHeight = 0;
    int walkableClimb = 0;
    int walkableRadius = 0;
    int maxEdgeLen = 0;
    float maxSimplificationError = 0.0f;
    int minRegionArea = 0;
    int mergeRegionArea = 0;
    int maxVertsPerPoly = 0;
    float detailSampleDist = 0.0f;
    float detailSampleMaxError = 0.0f;
};

/** `calcGridSize`'s answer: the voxel columns the bounds span at `cs`. */
struct NavGridSize {
    int width = 0;
    int height = 0;
};

/** The tile grid `generateTileCache` measures, as the numbers it holds. */
struct NavTileGrid {
    double width = 0.0;
    double height = 0.0;
};

/**
 * A generator's build-config step: everything it does to the `rcConfig`
 * `createRcConfig` returned, once `calcGridSize` has measured the bounds.
 * Generated from the installed @recast-navigation/generators package and
 * handed to the build arm that runs it.
 */
using NavSoloConfigStep = void (*)(NavRcConfig& config, const NavGridSize& grid);
using NavTileCacheConfigStep = NavTileGrid (*)(NavRcConfig& config, const NavGridSize& grid);

/** One merged-geometry source: world-space positions, reversed winding
 *  already applied by the caller (the generated merge mirrors the
 *  wrapper's `_mergeMeshes`). */
struct NavMeshGeometry {
    std::vector<float> positions;
    std::vector<std::uint32_t> indices;
};

/** `createDebugNavMeshGeometry`'s detached-triangle result. */
struct NavDebugGeometry {
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<std::uint32_t> indices;
};

/**
 * `raycast`'s raw outcome: whether the pinned hit window `0 < t < 1`
 * held, and the parameter itself. The hit point is the caller's — the
 * pinned wrapper lerps it in JavaScript doubles, so the generated
 * layer above this seam owns that arithmetic.
 */
struct NavRaycastHit {
    bool hit = false;
    float t = 0.0f;
};

/** `createNavigationPluginAsync`: a fresh plugin slot. */
NavigationHandle navigation_create_plugin();

/**
 * The solo-navmesh build (`generateSoloNavMesh` semantics): bounds from
 * the indexed positions, the wrapper's defaults, the generated
 * build-config step, the sample build sequence, area/flag normalization,
 * and the wrapper's default query. Throws with the wrapper's own failure
 * spelling when a stage fails.
 */
void navigation_create_solo_nav_mesh(NavigationHandle plugin, const NavMeshGeometry& geometry,
                                     const NavMeshBuildParams& params,
                                     const NavBuildDefaults& defaults, NavSoloConfigStep configure);

#if BBLITE_HAS_NAV_TILE_CACHE
/**
 * The tile-cache build (`generateTileCache` semantics).
 *
 * A tile-cache navmesh is the same Recast pipeline run per tile, with each
 * tile's heightfield layers compressed into the cache rather than turned
 * into polygons straight away: the cache owns the layers, and rebuilding a
 * tile after an obstacle moves is a decompress-and-remesh of that tile
 * alone. So the build here is the wrapper's own -- the generated
 * build-config step and the tile grid it measures, its tile-cache params,
 * its `dtIlog2(dtNextPow2(...))` tile/poly bit split, its chunky-triangle
 * partition and its two passes (rasterize every tile into the cache, then
 * build the initial meshes) -- and the obstacle entry points below are what
 * the arm exists for. Throws with the wrapper's own failure spelling when a
 * stage fails.
 */
void navigation_create_tile_cache_nav_mesh(NavigationHandle plugin, const NavMeshGeometry& geometry,
                                           const NavMeshBuildParams& params,
                                           const NavBuildDefaults& defaults,
                                           NavTileCacheConfigStep configure);

/**
 * One obstacle in a plugin's tile cache, as `ObstacleHandle` carries one.
 *
 * Zero is the null: Detour never issues that reference. The pinned
 * factories return `null` for a refused add, which the adds below report
 * as an empty optional for the generated layer to decide on, so the zero
 * handle is only ever what a SCENE cleared a name to.
 */
struct NavObstacleHandle {
    std::uint32_t value = 0;
    std::weak_ptr<NavigationMeshState> owner;
};

/**
 * `addBoxObstacle(position, halfExtents, angle)`: the cache's own oriented
 * box. Empty where the pinned factory returns null -- the cache is full.
 */
std::optional<NavObstacleHandle> navigation_add_box_obstacle(NavigationHandle plugin,
                                                             NavVec3 position, NavVec3 half_extents,
                                                             float angle);

/** `addCylinderObstacle(position, radius, height)`, likewise. */
std::optional<NavObstacleHandle> navigation_add_cylinder_obstacle(NavigationHandle plugin,
                                                                  NavVec3 position, float radius,
                                                                  float height);

/** `removeObstacle`: drop one the cache holds. */
void navigation_remove_obstacle(NavigationHandle plugin, NavObstacleHandle obstacle);

/**
 * `updateNavMeshObstacles`: run `tileCache.update()` until it reports no
 * pending request left.
 *
 * Every obstacle entry point above ends with this, because the pinned ones
 * do -- an add that did not settle would leave the navmesh describing tiles
 * the obstacle no longer occupies, and the pin refuses to hand that back.
 */
void navigation_update_obstacles(NavigationHandle plugin);

#endif

/** The wrapper's detail-mesh walk + detached-triangle rebuild. */
NavDebugGeometry navigation_debug_geometry(NavigationHandle plugin);

/** `raycast(plugin, start, end)`: hit iff `0 < t < 1`, point lerped. */
NavRaycastHit navigation_raycast(NavigationHandle plugin, float start_x, float start_y,
                                 float start_z, float end_x, float end_y, float end_z);

/**
 * `NavMeshQuery.findClosestPoint(position, { halfExtents: ±1 })`: the
 * wrapper resolves the nearest polygon with a null point output and then
 * asks `closestPointOnPoly` for the point, so the two calls are the
 * contract rather than `findNearestPoly`'s own `nearestPt`.
 *
 * Neither status is reported, because the pinned `getClosestPoint`
 * inspects neither — it returns the wrapper's output buffer either way,
 * which is uninitialized memory when the point resolves nothing. There
 * is no signal to mirror, so a query that resolves nothing reads as the
 * origin rather than as an outcome a caller could branch on;
 * `findClosestPointWithin` is the pinned entry point that does report
 * one, and it is unreached.
 */
NavVec3 navigation_closest_point(NavigationHandle plugin, float x, float y, float z);

/** `computePath`: the corridor between two snapped points, straightened. */
std::vector<NavVec3> navigation_compute_path(NavigationHandle plugin, NavVec3 start, NavVec3 end);

/**
 * `new Crowd(navMesh, { maxAgents, maxAgentRadius })`: `dtAllocCrowd`
 * followed by `init`, over the plugin's own navmesh.
 */
NavCrowdHandle navigation_create_crowd(NavigationHandle plugin, int max_agents,
                                       float max_agent_radius);

/**
 * `Crowd.addAgent`'s `dtCrowdAgentParams`, field for field. The three
 * optional ones carry the values `addAgent` resolved through the
 * wrapper's `crowdAgentParamsDefaults`; `userData` is that table's own
 * zero, which no reached call names.
 */
struct NavAgentParams {
    float radius = 0.0f;
    float height = 0.0f;
    float max_acceleration = 0.0f;
    float max_speed = 0.0f;
    float collision_query_range = 0.0f;
    float path_optimization_range = 0.0f;
    float separation_weight = 0.0f;
    unsigned char update_flags = 0;
    unsigned char obstacle_avoidance_type = 0;
    unsigned char query_filter_type = 0;
};

/** `Crowd.addAgent(position, params)` → the agent index it returned. */
int navigation_add_agent(NavCrowdHandle crowd, float x, float y, float z,
                         const NavAgentParams& params);

/**
 * `CrowdAgent.position()`: the agent's `npos`. Absent when the crowd
 * holds no agent at that index, which is the `?.` the pinned
 * `getAgentPosition` reads through.
 */
std::optional<NavVec3> navigation_agent_position(NavCrowdHandle crowd, int index);

/** `agentGoto`: snap the destination, then move toward that polygon.
 *  False when the crowd holds no agent at that index -- the `?.` the
 *  pinned `agentGoto` reads through, reported rather than decided here. */
bool navigation_agent_goto(NavCrowdHandle crowd, int index, NavVec3 destination);

/** `updateNavCrowd`: advance the crowd simulation. */
void navigation_update_crowd(NavCrowdHandle crowd, float delta_seconds);

} // namespace bbl::pal
