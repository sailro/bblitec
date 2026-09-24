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
 * add any: each build is the generator's Recast sequence over a plan of
 * every number it computes, generated from the installed packages and
 * handed in (`NavSoloBuild`, `NavTileCacheBuild`); the debug geometry is the wrapper's
 * detached-triangle flat-normal build with its reversed stored winding;
 * the raycast is `findNearestPoly` (±1 half-extents, include-all filter)
 * then `dtNavMeshQuery::raycast`, hit exactly when `0 < t < 1`. Nothing
 * generated names Recast — swapping the toolset is dropping in a different
 * translation unit.
 */

#include <array>
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
 * The query every build arm ends by constructing (`new
 * NavMeshQuery(navMesh)`), each a JavaScript number as the installed
 * @recast-navigation/core states it.
 */
struct NavQueryDefaults {
    /** The `maxNodes` default the query initializes with. */
    double max_nodes;
    /** `NavMeshQuery.defaultQueryHalfExtents`, x-y-z: the box every
     *  nearest-polygon search spans around its position. */
    double half_extents[3];
    /** `computePath`'s corridor capacity, and `findStraightPath`'s point
     *  capacity and options, when handed no options. */
    double max_path_polys;
    double max_straight_path_points;
    double straight_path_options;
};

/**
 * The build parameters a reached `createNavMesh` may carry, present where
 * the scene named them. The generated build plan reads them where the
 * pinned module's `cfg` does, beneath the wrapper's default spreads.
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
    /** The tile-cache arm's three: `maxObstacles > 0` selects the arm. */
    std::optional<double> tile_size;
    std::optional<double> expected_layers_per_tile;
    std::optional<double> max_obstacles;
};

/**
 * The wrapper's `rcConfig` object, field for field at Recast's own width. A
 * store narrows the way the wrapper's setter does -- an `int` field takes
 * ToInt32 of the JavaScript number, a `float` field its nearest float --
 * and a read widens exactly. The build checks it against `rcConfig`.
 */
struct NavRcConfig {
    int width = 0;
    int height = 0;
    int tileSize = 0;
    int borderSize = 0;
    float cs = 0.0f;
    float ch = 0.0f;
    float bmin[3] = {0.0f, 0.0f, 0.0f};
    float bmax[3] = {0.0f, 0.0f, 0.0f};
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

/** `getBoundingBox`'s `bbMin`/`bbMax`, the JavaScript numbers the plan reads. */
struct NavBounds {
    std::array<double, 3> min{};
    std::array<double, 3> max{};
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
 * The `dtNavMeshCreateParams` scalars the solo generator sets through the
 * wrapper's `NavMeshCreateParams` setters, at Detour's own width. The mesh
 * data itself is the library's, copied in by the build.
 */
struct NavMeshCreateScalars {
    float walkableHeight = 0.0f;
    float walkableRadius = 0.0f;
    float walkableClimb = 0.0f;
    float cs = 0.0f;
    float ch = 0.0f;
    bool buildBvTree = false;
};

/** `dtTileCacheParams`, field for field, as `DetourTileCacheParams.create` fills it. */
struct NavTileCacheParams {
    float orig[3] = {0.0f, 0.0f, 0.0f};
    float cs = 0.0f;
    float ch = 0.0f;
    int width = 0;
    int height = 0;
    float walkableHeight = 0.0f;
    float walkableRadius = 0.0f;
    float walkableClimb = 0.0f;
    float maxSimplificationError = 0.0f;
    int maxTiles = 0;
    int maxObstacles = 0;
};

/** `dtNavMeshParams`, field for field, as `NavMeshParams.create` fills it. */
struct NavTiledMeshParams {
    float orig[3] = {0.0f, 0.0f, 0.0f};
    float tileWidth = 0.0f;
    float tileHeight = 0.0f;
    int maxTiles = 0;
    int maxPolys = 0;
};

/**
 * A solo build's plan: every number `generateSoloNavMeshData` computes
 * before it hands it to Recast or Detour, generated from the installed
 * @recast-navigation packages.
 */
struct NavSoloBuild {
    NavBounds bounds;
    NavRcConfig config;
    NavMeshCreateScalars create;
};

/** One tile's config and bounds, generated from `rasterizeTileLayers`. */
using NavTileConfigStep = NavRcConfig (*)(const NavRcConfig& config, const NavBounds& bounds,
                                          double tile_x, double tile_y);

/** A tile-cache build's plan, generated from `generateTileCache`. */
struct NavTileCacheBuild {
    NavBounds bounds;
    NavRcConfig config;
    NavTileGrid tiles;
    NavTileCacheParams cache;
    NavTiledMeshParams mesh;
    NavTileConfigStep tile_config = nullptr;
    double linear_allocator_capacity = 0.0;
    double tris_per_chunk = 0.0;
    double max_chunk_ids = 0.0;
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

/** `calcGridSize(bbMin, bbMax, cs)`, which each plan reads part-way. */
NavGridSize navigation_grid_size(const NavBounds& bounds, float cs);

/**
 * The solo-navmesh build (`generateSoloNavMeshData` semantics): the Recast
 * sequence over the plan's config and bounds, area/flag normalization,
 * the plan's create params with the off-mesh connections packed beside
 * them, and the wrapper's default query. Throws with the wrapper's own
 * failure spelling when a stage fails.
 */
void navigation_create_solo_nav_mesh(NavigationHandle plugin, const NavMeshGeometry& geometry,
                                     const NavSoloBuild& build,
                                     const std::vector<NavOffMeshConnection>& off_mesh_connections,
                                     const NavQueryDefaults& defaults);

#if BBLITE_HAS_NAV_TILE_CACHE
/**
 * The tile-cache build (`generateTileCache` semantics).
 *
 * A tile-cache navmesh is the same Recast pipeline run per tile, with each
 * tile's heightfield layers compressed into the cache rather than turned
 * into polygons straight away: the cache owns the layers, and rebuilding a
 * tile after an obstacle moves is a decompress-and-remesh of that tile
 * alone. So the build here is the wrapper's own -- the plan's cache and
 * navmesh params, its chunky-triangle partition and its two passes
 * (rasterize every tile into the cache, then build the initial meshes) --
 * and the obstacle entry points below are what the arm exists for. Throws
 * with the wrapper's own failure spelling when a stage fails.
 */
void navigation_create_tile_cache_nav_mesh(NavigationHandle plugin, const NavMeshGeometry& geometry,
                                           const NavTileCacheBuild& build,
                                           const NavQueryDefaults& defaults);

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
