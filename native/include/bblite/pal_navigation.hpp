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
 * with its config defaults and unit transforms; the debug geometry is
 * the wrapper's detached-triangle flat-normal build with its reversed
 * stored winding; the raycast is `findNearestPoly` (±1 half-extents,
 * include-all filter) then `dtNavMeshQuery::raycast`, hit exactly when
 * `0 < t < 1`. Nothing generated names Recast — swapping the toolset is
 * dropping in a different translation unit.
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
 * The build parameters a reached `createNavMesh` may carry. Absent
 * fields take the wrapper's `recastConfigDefaults` inside the build,
 * exactly as its `{...defaults, ...cfg}` spread does.
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
     * other two carry `tileCacheGeneratorConfigDefaults` when absent.
     */
    std::optional<double> tile_size;
    std::optional<double> expected_layers_per_tile;
    std::optional<double> max_obstacles;
};

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
 * the indexed positions, the wrapper's defaults and unit transforms,
 * the sample build sequence, area/flag normalization, and the query
 * (2048 nodes, include-all filter). Throws with the wrapper's own
 * failure spelling when a stage fails.
 */
void navigation_create_solo_nav_mesh(
    NavigationHandle plugin,
    const NavMeshGeometry& geometry,
    const NavMeshBuildParams& params);

#ifndef BBLITE_HAS_NAV_TILE_CACHE
#define BBLITE_HAS_NAV_TILE_CACHE 0
#endif

#if BBLITE_HAS_NAV_TILE_CACHE
/**
 * The tile-cache build (`generateTileCache` semantics).
 *
 * A tile-cache navmesh is the same Recast pipeline run per tile, with each
 * tile's heightfield layers compressed into the cache rather than turned
 * into polygons straight away: the cache owns the layers, and rebuilding a
 * tile after an obstacle moves is a decompress-and-remesh of that tile
 * alone. So the build here is the wrapper's own -- its tile-cache params,
 * its `dtIlog2(dtNextPow2(...))` tile/poly bit split, its chunky-triangle
 * partition and its two passes (rasterize every tile into the cache, then
 * build the initial meshes) -- and the obstacle entry points below are what
 * the arm exists for. Throws with the wrapper's own failure spelling when a
 * stage fails.
 */
void navigation_create_tile_cache_nav_mesh(
    NavigationHandle plugin,
    const NavMeshGeometry& geometry,
    const NavMeshBuildParams& params);

/**
 * One obstacle in a plugin's tile cache, as `ObstacleHandle` carries one.
 *
 * Zero is the null: Detour never issues that reference, and the pinned
 * factories return `null` for a refused add. This port throws there
 * instead, as it does for every other failed stage, so the zero handle is
 * only ever what a SCENE cleared a name to.
 */
struct NavObstacleHandle {
    std::uint32_t value = 0;
    std::weak_ptr<NavigationMeshState> owner;
};

/**
 * `addBoxObstacle(position, halfExtents, angle)`: the cache's own oriented
 * box. Throws where the pinned factory returns null -- the cache is full.
 */
NavObstacleHandle navigation_add_box_obstacle(
    NavigationHandle plugin,
    NavVec3 position,
    NavVec3 half_extents,
    float angle);

/** `addCylinderObstacle(position, radius, height)`, likewise. */
NavObstacleHandle navigation_add_cylinder_obstacle(
    NavigationHandle plugin,
    NavVec3 position,
    float radius,
    float height);

/** `removeObstacle`: drop one the cache holds. */
void navigation_remove_obstacle(
    NavigationHandle plugin,
    NavObstacleHandle obstacle);

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
NavRaycastHit navigation_raycast(
    NavigationHandle plugin,
    float start_x, float start_y, float start_z,
    float end_x, float end_y, float end_z);

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
NavVec3 navigation_closest_point(
    NavigationHandle plugin,
    float x, float y, float z);

/** `computePath`: the corridor between two snapped points, straightened. */
std::vector<NavVec3> navigation_compute_path(
    NavigationHandle plugin,
    NavVec3 start,
    NavVec3 end);

/**
 * `new Crowd(navMesh, { maxAgents, maxAgentRadius })`: `dtAllocCrowd`
 * followed by `init`, over the plugin's own navmesh.
 */
NavCrowdHandle navigation_create_crowd(
    NavigationHandle plugin,
    int max_agents,
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
int navigation_add_agent(
    NavCrowdHandle crowd,
    float x, float y, float z,
    const NavAgentParams& params);

/**
 * `CrowdAgent.position()`: the agent's `npos`. Absent when the crowd
 * holds no agent at that index, which is the `?.` the pinned
 * `getAgentPosition` reads through.
 */
std::optional<NavVec3> navigation_agent_position(
    NavCrowdHandle crowd,
    int index);

/** `agentGoto`: snap the destination, then move toward that polygon.
 *  False when the crowd holds no agent at that index -- the `?.` the
 *  pinned `agentGoto` reads through, reported rather than decided here. */
bool navigation_agent_goto(
    NavCrowdHandle crowd,
    int index,
    NavVec3 destination);

/** `updateNavCrowd`: advance the crowd simulation. */
void navigation_update_crowd(
    NavCrowdHandle crowd,
    float delta_seconds);

} // namespace bbl::pal
