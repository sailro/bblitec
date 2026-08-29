// The Recast/Detour implementation of the navigation seam.
//
// Every decision here is the pinned wrapper's, not this port's: the
// config defaults and unit transforms are @recast-navigation/core's
// `recastConfigDefaults`/`createRcConfig`, the build sequence is
// @recast-navigation/generators' `generateSoloNavMesh` step for step,
// the query construction is `NavMeshQuery`'s (2048 nodes, include-all
// filter), the debug walk is `getNavMeshPositionsAndIndices` plus the
// pinned `createDebugNavMeshGeometry` detached-triangle rebuild, and
// the raycast is the pinned `raycast` wrapper. The library underneath
// is the same recastnavigation commit the wrapper's wasm compiles.

#include <bblite/pal_navigation.hpp>

#include <DetourCrowd.h>
#include <DetourNavMesh.h>
#include <DetourNavMeshBuilder.h>
#include <DetourNavMeshQuery.h>
#include <Recast.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {
namespace {

struct NavigationPluginState {
    std::unique_ptr<dtNavMesh, void (*)(dtNavMesh*)> nav_mesh{
        nullptr, [](dtNavMesh* mesh) { dtFreeNavMesh(mesh); }};
    std::unique_ptr<dtNavMeshQuery, void (*)(dtNavMeshQuery*)> query{
        nullptr,
        [](dtNavMeshQuery* value) { dtFreeNavMeshQuery(value); }};
    dtQueryFilter filter;
};

std::vector<std::unique_ptr<NavigationPluginState>>& plugins() {
    static std::vector<std::unique_ptr<NavigationPluginState>> states;
    return states;
}

NavigationPluginState& plugin_state(NavigationHandle handle) {
    if (handle.value >= plugins().size() || !plugins()[handle.value]) {
        throw std::runtime_error("Invalid navigation plugin handle.");
    }
    return *plugins()[handle.value];
}

/** One `Crowd`: `dtAllocCrowd()` and the navmesh it was init'd over. */
struct NavCrowdState {
    std::unique_ptr<dtCrowd, void (*)(dtCrowd*)> crowd{
        nullptr, [](dtCrowd* value) { dtFreeCrowd(value); }};
};

std::vector<std::unique_ptr<NavCrowdState>>& crowds() {
    static std::vector<std::unique_ptr<NavCrowdState>> states;
    return states;
}

NavCrowdState& crowd_state(NavCrowdHandle handle) {
    if (handle.value >= crowds().size() || !crowds()[handle.value]) {
        throw std::runtime_error("Invalid navigation crowd handle.");
    }
    return *crowds()[handle.value];
}

/** `NavMeshQuery.defaultQueryHalfExtents`. */
constexpr float default_query_half_extents[3] = {1.0f, 1.0f, 1.0f};

/** `new QueryFilter()`: Detour's own include-everything defaults, which
 *  the wrapper never narrows. Stated once so a future exclude reaches
 *  every query rather than the ones someone remembered. */
dtQueryFilter include_all_filter() {
    dtQueryFilter filter;
    filter.setIncludeFlags(0xffff);
    filter.setExcludeFlags(0);
    return filter;
}

/** recastConfigDefaults, verbatim. */
struct ResolvedBuildConfig {
    float cs = 0.2f;
    float ch = 0.2f;
    float walkable_slope_angle = 60.0f;
    int walkable_height = 2;
    int walkable_climb = 2;
    int walkable_radius = 0;  // default 0.5 floors to 0 via rcConfig int
    int max_edge_len = 12;
    float max_simplification_error = 1.3f;
    int min_region_area = 8;
    int merge_region_area = 20;
    int max_verts_per_poly = 6;
    float detail_sample_dist = 6.0f;
    float detail_sample_max_error = 1.0f;
};

} // namespace

NavigationHandle navigation_create_plugin() {
    plugins().push_back(std::make_unique<NavigationPluginState>());
    return NavigationHandle{
        static_cast<std::uint32_t>(plugins().size() - 1)};
}

void navigation_create_solo_nav_mesh(
    NavigationHandle plugin,
    const NavMeshGeometry& geometry,
    const NavMeshBuildParams& params) {
    NavigationPluginState& state = plugin_state(plugin);

    const float* vertices = geometry.positions.data();
    const int vertex_count =
        static_cast<int>(geometry.positions.size() / 3);
    const int triangle_count =
        static_cast<int>(geometry.indices.size()) / 3;
    std::vector<int> triangles(geometry.indices.begin(),
                               geometry.indices.end());

    // Bounds from the INDEXED positions, matching the wrapper's
    // getBoundingBox (which walks indices, not the vertex array).
    float bounds_min[3];
    float bounds_max[3];
    bounds_min[0] = bounds_min[1] = bounds_min[2] =
        std::numeric_limits<float>::infinity();
    bounds_max[0] = bounds_max[1] = bounds_max[2] =
        -std::numeric_limits<float>::infinity();
    for (const std::uint32_t index : geometry.indices) {
        for (int axis = 0; axis < 3; ++axis) {
            const float value = vertices[index * 3 + axis];
            bounds_min[axis] = std::min(bounds_min[axis], value);
            bounds_max[axis] = std::max(bounds_max[axis], value);
        }
    }

    // {...recastConfigDefaults, ...cfg} then createRcConfig's field
    // copy. The wrapper stores JS numbers into rcConfig's int fields,
    // where emscripten truncates — the double-to-int casts here are
    // that same truncation.
    const ResolvedBuildConfig defaults;
    const auto pick_float = [](const std::optional<double>& given,
                               float fallback) -> float {
        return given ? static_cast<float>(*given) : fallback;
    };
    const auto pick_int = [](const std::optional<double>& given,
                             int fallback) -> int {
        return given ? static_cast<int>(*given) : fallback;
    };
    rcConfig config;
    std::memset(&config, 0, sizeof(config));
    config.cs = pick_float(params.cs, defaults.cs);
    config.ch = pick_float(params.ch, defaults.ch);
    config.walkableSlopeAngle = pick_float(
        params.walkable_slope_angle, defaults.walkable_slope_angle);
    config.walkableHeight =
        pick_int(params.walkable_height, defaults.walkable_height);
    config.walkableClimb =
        pick_int(params.walkable_climb, defaults.walkable_climb);
    config.walkableRadius =
        pick_int(params.walkable_radius, defaults.walkable_radius);
    config.maxEdgeLen =
        pick_int(params.max_edge_len, defaults.max_edge_len);
    config.maxSimplificationError = pick_float(
        params.max_simplification_error,
        defaults.max_simplification_error);
    config.minRegionArea =
        pick_int(params.min_region_area, defaults.min_region_area);
    config.mergeRegionArea =
        pick_int(params.merge_region_area, defaults.merge_region_area);
    config.maxVertsPerPoly =
        pick_int(params.max_verts_per_poly, defaults.max_verts_per_poly);
    config.detailSampleDist = pick_float(
        params.detail_sample_dist, defaults.detail_sample_dist);
    config.detailSampleMaxError = pick_float(
        params.detail_sample_max_error,
        defaults.detail_sample_max_error);
    config.borderSize = 0;
    config.tileSize = 0;

    // The generator's post-createRcConfig transforms, verbatim.
    config.minRegionArea = config.minRegionArea * config.minRegionArea;
    config.mergeRegionArea =
        config.mergeRegionArea * config.mergeRegionArea;
    config.detailSampleDist = config.detailSampleDist < 0.9f
        ? 0.0f
        : config.cs * config.detailSampleDist;
    config.detailSampleMaxError = config.ch * config.detailSampleMaxError;
    rcVcopy(config.bmin, bounds_min);
    rcVcopy(config.bmax, bounds_max);
    rcCalcGridSize(config.bmin, config.bmax, config.cs, &config.width,
                   &config.height);

    rcContext context(false);
    const auto fail = [](const std::string& message) -> void {
        throw std::runtime_error("createNavMesh failed: " + message);
    };

    rcHeightfield* heightfield = rcAllocHeightfield();
    if (!heightfield ||
        !rcCreateHeightfield(&context, *heightfield, config.width,
                             config.height, config.bmin, config.bmax,
                             config.cs, config.ch)) {
        fail("Could not create heightfield");
    }

    std::vector<unsigned char> triangle_areas(
        static_cast<std::size_t>(triangle_count), 0);
    rcMarkWalkableTriangles(&context, config.walkableSlopeAngle,
                            vertices, vertex_count, triangles.data(),
                            triangle_count, triangle_areas.data());
    if (!rcRasterizeTriangles(&context, vertices, vertex_count,
                              triangles.data(), triangle_areas.data(),
                              triangle_count, *heightfield,
                              config.walkableClimb)) {
        fail("Could not rasterize triangles");
    }

    rcFilterLowHangingWalkableObstacles(&context, config.walkableClimb,
                                        *heightfield);
    rcFilterLedgeSpans(&context, config.walkableHeight,
                       config.walkableClimb, *heightfield);
    rcFilterWalkableLowHeightSpans(&context, config.walkableHeight,
                                   *heightfield);

    rcCompactHeightfield* compact = rcAllocCompactHeightfield();
    if (!compact ||
        !rcBuildCompactHeightfield(&context, config.walkableHeight,
                                   config.walkableClimb, *heightfield,
                                   *compact)) {
        fail("Failed to build compact data");
    }
    rcFreeHeightField(heightfield);

    if (!rcErodeWalkableArea(&context, config.walkableRadius,
                             *compact)) {
        fail("Failed to erode walkable area");
    }
    if (!rcBuildDistanceField(&context, *compact)) {
        fail("Failed to build distance field");
    }
    if (!rcBuildRegions(&context, *compact, config.borderSize,
                        config.minRegionArea, config.mergeRegionArea)) {
        fail("Failed to build regions");
    }

    rcContourSet* contours = rcAllocContourSet();
    if (!contours ||
        !rcBuildContours(&context, *compact,
                         config.maxSimplificationError,
                         config.maxEdgeLen, *contours,
                         RC_CONTOUR_TESS_WALL_EDGES)) {
        fail("Failed to create contours");
    }

    rcPolyMesh* poly_mesh = rcAllocPolyMesh();
    if (!poly_mesh ||
        !rcBuildPolyMesh(&context, *contours, config.maxVertsPerPoly,
                         *poly_mesh)) {
        fail("Failed to triangulate contours");
    }

    rcPolyMeshDetail* detail_mesh = rcAllocPolyMeshDetail();
    if (!detail_mesh ||
        !rcBuildPolyMeshDetail(&context, *poly_mesh, *compact,
                               config.detailSampleDist,
                               config.detailSampleMaxError,
                               *detail_mesh)) {
        fail("Failed to build detail mesh");
    }
    rcFreeCompactHeightfield(compact);
    rcFreeContourSet(contours);

    // The generator's area/flag normalization, verbatim.
    for (int poly = 0; poly < poly_mesh->npolys; ++poly) {
        if (poly_mesh->areas[poly] == RC_WALKABLE_AREA) {
            poly_mesh->areas[poly] = 0;
        }
        if (poly_mesh->areas[poly] == 0) {
            poly_mesh->flags[poly] = 1;
        }
    }

    dtNavMeshCreateParams create_params;
    std::memset(&create_params, 0, sizeof(create_params));
    create_params.verts = poly_mesh->verts;
    create_params.vertCount = poly_mesh->nverts;
    create_params.polys = poly_mesh->polys;
    create_params.polyAreas = poly_mesh->areas;
    create_params.polyFlags = poly_mesh->flags;
    create_params.polyCount = poly_mesh->npolys;
    create_params.nvp = poly_mesh->nvp;
    create_params.detailMeshes = detail_mesh->meshes;
    create_params.detailVerts = detail_mesh->verts;
    create_params.detailVertsCount = detail_mesh->nverts;
    create_params.detailTris = detail_mesh->tris;
    create_params.detailTriCount = detail_mesh->ntris;
    create_params.walkableHeight =
        static_cast<float>(config.walkableHeight) * config.ch;
    create_params.walkableRadius =
        static_cast<float>(config.walkableRadius) * config.cs;
    create_params.walkableClimb =
        static_cast<float>(config.walkableClimb) * config.ch;
    rcVcopy(create_params.bmin, poly_mesh->bmin);
    rcVcopy(create_params.bmax, poly_mesh->bmax);
    create_params.cs = config.cs;
    create_params.ch = config.ch;
    create_params.buildBvTree = true;

    // `setOffMeshConnections` in the wrapper, packed the same way: start
    // xyz then end xyz per connection, `bidirectional` as the direction
    // bit, and the three optional fields taking the defaults the header
    // states -- the last of which is why they resolve here rather than at
    // the write site, since only this loop knows the index.
    //
    // The vectors outlive `dtCreateNavMeshData` below, which copies them.
    std::vector<float> off_mesh_verts;
    std::vector<float> off_mesh_radii;
    std::vector<unsigned char> off_mesh_dir;
    std::vector<unsigned char> off_mesh_areas;
    std::vector<unsigned short> off_mesh_flags;
    std::vector<unsigned int> off_mesh_user_ids;
    if (!params.off_mesh_connections.empty()) {
        const std::size_t count = params.off_mesh_connections.size();
        off_mesh_verts.reserve(count * 6);
        off_mesh_radii.reserve(count);
        off_mesh_dir.reserve(count);
        off_mesh_areas.reserve(count);
        off_mesh_flags.reserve(count);
        off_mesh_user_ids.reserve(count);
        for (std::size_t index = 0; index < count; ++index) {
            const NavOffMeshConnection& connection =
                params.off_mesh_connections[index];
            off_mesh_verts.push_back(connection.start.x);
            off_mesh_verts.push_back(connection.start.y);
            off_mesh_verts.push_back(connection.start.z);
            off_mesh_verts.push_back(connection.end.x);
            off_mesh_verts.push_back(connection.end.y);
            off_mesh_verts.push_back(connection.end.z);
            off_mesh_radii.push_back(connection.radius);
            off_mesh_dir.push_back(
                connection.bidirectional ? 1u : 0u);
            off_mesh_areas.push_back(static_cast<unsigned char>(
                connection.area.value_or(0.0)));
            off_mesh_flags.push_back(static_cast<unsigned short>(
                connection.flags.value_or(1.0)));
            off_mesh_user_ids.push_back(static_cast<unsigned int>(
                connection.user_id.value_or(
                    1000.0 + static_cast<double>(index))));
        }
        create_params.offMeshConVerts = off_mesh_verts.data();
        create_params.offMeshConRad = off_mesh_radii.data();
        create_params.offMeshConDir = off_mesh_dir.data();
        create_params.offMeshConAreas = off_mesh_areas.data();
        create_params.offMeshConFlags = off_mesh_flags.data();
        create_params.offMeshConUserID = off_mesh_user_ids.data();
        create_params.offMeshConCount = static_cast<int>(count);
    }

    unsigned char* nav_data = nullptr;
    int nav_data_size = 0;
    if (!dtCreateNavMeshData(&create_params, &nav_data,
                             &nav_data_size)) {
        fail("Failed to create Detour navmesh data");
    }
    rcFreePolyMesh(poly_mesh);
    rcFreePolyMeshDetail(detail_mesh);

    dtNavMesh* nav_mesh = dtAllocNavMesh();
    if (!nav_mesh ||
        dtStatusFailed(nav_mesh->init(nav_data, nav_data_size,
                                      DT_TILE_FREE_DATA))) {
        dtFree(nav_data);
        throw std::runtime_error(
            "createNavMesh failed: Failed to initialize solo NavMesh");
    }
    state.nav_mesh.reset(nav_mesh);

    // NavMeshQuery's construction: 2048 nodes, include-all filter.
    dtNavMeshQuery* query = dtAllocNavMeshQuery();
    if (!query ||
        dtStatusFailed(query->init(nav_mesh, 2048))) {
        throw std::runtime_error(
            "createNavMesh failed: Failed to initialize navmesh query");
    }
    state.query.reset(query);
    state.filter = include_all_filter();
}

NavDebugGeometry navigation_debug_geometry(NavigationHandle plugin) {
    NavigationPluginState& state = plugin_state(plugin);
    if (!state.nav_mesh) {
        throw std::runtime_error(
            "No navmesh generated. Call createNavMesh first.");
    }
    const dtNavMesh& mesh = *state.nav_mesh;

    // getNavMeshPositionsAndIndices: every tile's non-off-mesh polys'
    // detail triangles, resolved through the poly/detail vertex split.
    std::vector<float> raw_positions;
    std::vector<std::uint32_t> raw_indices;
    std::uint32_t triangle_vertex = 0;
    for (int tile_index = 0; tile_index < mesh.getMaxTiles();
         ++tile_index) {
        const dtMeshTile* tile = mesh.getTile(tile_index);
        if (!tile || !tile->header) continue;
        for (int poly_index = 0; poly_index < tile->header->polyCount;
             ++poly_index) {
            const dtPoly& poly = tile->polys[poly_index];
            if (poly.getType() == DT_POLYTYPE_OFFMESH_CONNECTION) {
                continue;
            }
            const dtPolyDetail& detail =
                tile->detailMeshes[poly_index];
            for (unsigned int tri = 0; tri < detail.triCount; ++tri) {
                const unsigned char* detail_tri =
                    &tile->detailTris[(detail.triBase + tri) * 4];
                for (int corner = 0; corner < 3; ++corner) {
                    const float* position;
                    if (detail_tri[corner] < poly.vertCount) {
                        position =
                            &tile->verts[poly.verts[detail_tri[corner]] *
                                         3];
                    } else {
                        position = &tile->detailVerts
                                        [(detail.vertBase +
                                          detail_tri[corner] -
                                          poly.vertCount) *
                                         3];
                    }
                    raw_positions.push_back(position[0]);
                    raw_positions.push_back(position[1]);
                    raw_positions.push_back(position[2]);
                    raw_indices.push_back(triangle_vertex++);
                }
            }
        }
    }

    // createDebugNavMeshGeometry: detached triangles, the face normal
    // from the ORIGINAL winding, positions stored REVERSED (i0, i2, i1)
    // for back-face parity. All float arithmetic, as the wrapper's
    // Float32Array reads make it.
    const std::size_t triangle_count = raw_indices.size() / 3;
    NavDebugGeometry result;
    result.positions.resize(triangle_count * 9);
    result.normals.resize(triangle_count * 9);
    result.indices.resize(triangle_count * 3);
    for (std::size_t triangle = 0; triangle < triangle_count;
         ++triangle) {
        const std::uint32_t i0 = raw_indices[triangle * 3] * 3;
        const std::uint32_t i1 = raw_indices[triangle * 3 + 1] * 3;
        const std::uint32_t i2 = raw_indices[triangle * 3 + 2] * 3;
        const float ax = raw_positions[i0];
        const float ay = raw_positions[i0 + 1];
        const float az = raw_positions[i0 + 2];
        const float bx = raw_positions[i1];
        const float by = raw_positions[i1 + 1];
        const float bz = raw_positions[i1 + 2];
        const float cx = raw_positions[i2];
        const float cy = raw_positions[i2 + 1];
        const float cz = raw_positions[i2 + 2];
        const float e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const float e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        float nx = e1y * e2z - e1z * e2y;
        float ny = e1z * e2x - e1x * e2z;
        float nz = e1x * e2y - e1y * e2x;
        const float length = std::hypot(nx, ny, nz);
        if (length > 0.0f) {
            nx /= length;
            ny /= length;
            nz /= length;
        }
        const std::size_t v = triangle * 9;
        result.positions[v] = ax;
        result.positions[v + 1] = ay;
        result.positions[v + 2] = az;
        result.positions[v + 3] = cx;
        result.positions[v + 4] = cy;
        result.positions[v + 5] = cz;
        result.positions[v + 6] = bx;
        result.positions[v + 7] = by;
        result.positions[v + 8] = bz;
        for (int corner = 0; corner < 3; ++corner) {
            result.normals[v + corner * 3] = nx;
            result.normals[v + corner * 3 + 1] = ny;
            result.normals[v + corner * 3 + 2] = nz;
        }
        const std::size_t index = triangle * 3;
        result.indices[index] = static_cast<std::uint32_t>(index);
        result.indices[index + 1] =
            static_cast<std::uint32_t>(index + 1);
        result.indices[index + 2] =
            static_cast<std::uint32_t>(index + 2);
    }
    return result;
}

NavRaycastHit navigation_raycast(
    NavigationHandle plugin,
    float start_x, float start_y, float start_z,
    float end_x, float end_y, float end_z) {
    NavigationPluginState& state = plugin_state(plugin);
    if (!state.nav_mesh || !state.query) {
        throw std::runtime_error(
            "No navmesh generated. Call createNavMesh first.");
    }
    const float start[3] = {start_x, start_y, start_z};
    const float end[3] = {end_x, end_y, end_z};

    dtPolyRef nearest_ref = 0;
    float nearest_point[3] = {0.0f, 0.0f, 0.0f};
    const dtStatus nearest_status = state.query->findNearestPoly(
        start, default_query_half_extents, &state.filter, &nearest_ref,
        nearest_point);
    if (dtStatusFailed(nearest_status) || nearest_ref == 0) {
        return NavRaycastHit{};
    }

    // Zeroed wholesale: a null path buffer with maxPath 0 asks Detour
    // for the t and normal only, the way the wrapper's raycast does.
    dtRaycastHit ray_hit;
    std::memset(&ray_hit, 0, sizeof(ray_hit));
    state.query->raycast(nearest_ref, start, end, &state.filter, 0,
                         &ray_hit, 0);
    const float t = ray_hit.t;
    if (!(t > 0.0f && t < 1.0f)) {
        return NavRaycastHit{};
    }
    return NavRaycastHit{true, t};
}

// NavMeshQuery::findClosestPoint (recast-navigation-js's own glue):
// resolve the nearest polygon asking for no point, then take the point
// from closestPointOnPoly. The two-call shape is the contract — the
// point findNearestPoly would have written is a different value on a
// query whose position sits off the polygon.
NavVec3 navigation_closest_point(
    NavigationHandle plugin,
    float x, float y, float z) {
    NavigationPluginState& state = plugin_state(plugin);
    if (!state.nav_mesh || !state.query) {
        throw std::runtime_error(
            "No navmesh generated. Call createNavMesh first.");
    }
    const float position[3] = {x, y, z};
    dtPolyRef poly_ref = 0;
    const dtStatus nearest_status = state.query->findNearestPoly(
        position, default_query_half_extents, &state.filter, &poly_ref,
        nullptr);
    if (dtStatusFailed(nearest_status)) {
        return NavVec3{};
    }
    NavVec3 point{};
    bool over_poly = false;
    state.query->closestPointOnPoly(
        poly_ref, position, &point.x, &over_poly);
    return point;
}

// NavMeshQuery::computePath, whole: the wrapper resolves a polygon for
// each endpoint, walks the polygon corridor, and only then straightens it.
//
// The step that is easy to drop is the fourth. When `findPath` cannot
// reach the goal it returns a PARTIAL corridor, and the wrapper detects
// that by comparing the corridor's last polygon against the end polygon;
// where they differ the straight path must be run to the closest point ON
// that last polygon, not to the caller's end. Straightening to an
// unreachable goal instead walks the path off the mesh.
std::vector<NavVec3> navigation_compute_path(
    NavigationHandle plugin,
    NavVec3 start,
    NavVec3 end) {
    NavigationPluginState& state = plugin_state(plugin);
    if (!state.nav_mesh || !state.query) {
        throw std::runtime_error(
            "No navmesh generated. Call createNavMesh first.");
    }
    const float start_position[3] = {start.x, start.y, start.z};
    const float end_position[3] = {end.x, end.y, end.z};

    dtPolyRef start_ref = 0;
    dtPolyRef end_ref = 0;
    if (dtStatusFailed(state.query->findNearestPoly(
            start_position, default_query_half_extents, &state.filter,
            &start_ref, nullptr)) ||
        dtStatusFailed(state.query->findNearestPoly(
            end_position, default_query_half_extents, &state.filter,
            &end_ref, nullptr))) {
        return {};
    }

    // `maxPathPolys` and `maxStraightPathPoints` both default to 256 in
    // the wrapper, and nothing reached overrides either.
    constexpr int max_path_polys = 256;
    constexpr int max_straight_path_points = 256;
    std::vector<dtPolyRef> polys(
        static_cast<std::size_t>(max_path_polys));
    int poly_count = 0;
    if (dtStatusFailed(state.query->findPath(
            start_ref, end_ref, start_position, end_position,
            &state.filter, polys.data(), &poly_count,
            max_path_polys)) ||
        poly_count <= 0) {
        return {};
    }

    float straight_end[3] = {end.x, end.y, end.z};
    const dtPolyRef last_poly =
        polys[static_cast<std::size_t>(poly_count - 1)];
    if (last_poly != end_ref) {
        bool over_poly = false;
        if (dtStatusFailed(state.query->closestPointOnPoly(
                last_poly, end_position, straight_end, &over_poly))) {
            return {};
        }
    }

    std::vector<float> straight(
        static_cast<std::size_t>(max_straight_path_points) * 3);
    int straight_count = 0;
    // The flag and polygon-reference outputs are `[opt]` in Detour's own
    // header and nothing here reads them; the wrapper allocates both only
    // because its binding hands back buffers it then destroys.
    if (dtStatusFailed(state.query->findStraightPath(
            start_position, straight_end, polys.data(), poly_count,
            straight.data(), nullptr, nullptr, &straight_count,
            max_straight_path_points))) {
        return {};
    }

    std::vector<NavVec3> path;
    path.reserve(static_cast<std::size_t>(straight_count));
    for (int index = 0; index < straight_count; ++index) {
        const std::size_t base = static_cast<std::size_t>(index) * 3;
        path.push_back(NavVec3{straight[base], straight[base + 1],
                               straight[base + 2]});
    }
    return path;
}

// new Crowd(navMesh, { maxAgents, maxAgentRadius }): allocCrowd then
// init over the plugin's navmesh. dtCrowd builds its own query and
// filters; the wrapper changes neither.
NavCrowdHandle navigation_create_crowd(
    NavigationHandle plugin,
    int max_agents,
    float max_agent_radius) {
    NavigationPluginState& state = plugin_state(plugin);
    if (!state.nav_mesh) {
        throw std::runtime_error(
            "No navmesh generated. Call createNavMesh first.");
    }
    dtCrowd* crowd = dtAllocCrowd();
    if (!crowd ||
        !crowd->init(max_agents, max_agent_radius,
                     state.nav_mesh.get())) {
        dtFreeCrowd(crowd);
        throw std::runtime_error(
            "createNavCrowd failed: Failed to initialize crowd");
    }
    auto owned = std::make_unique<NavCrowdState>();
    owned->crowd.reset(crowd);
    crowds().push_back(std::move(owned));
    return NavCrowdHandle{
        static_cast<std::uint32_t>(crowds().size() - 1)};
}

// Crowd.addAgent: the wrapper fills every dtCrowdAgentParams field it
// declares from the spread of its defaults over the caller's object,
// leaving the rest of the struct at its own zero-initialization.
int navigation_add_agent(
    NavCrowdHandle crowd,
    float x, float y, float z,
    const NavAgentParams& params) {
    NavCrowdState& state = crowd_state(crowd);
    dtCrowdAgentParams agent_params{};
    agent_params.radius = params.radius;
    agent_params.height = params.height;
    agent_params.maxAcceleration = params.max_acceleration;
    agent_params.maxSpeed = params.max_speed;
    agent_params.collisionQueryRange = params.collision_query_range;
    agent_params.pathOptimizationRange = params.path_optimization_range;
    agent_params.separationWeight = params.separation_weight;
    agent_params.updateFlags = params.update_flags;
    agent_params.obstacleAvoidanceType = params.obstacle_avoidance_type;
    agent_params.queryFilterType = params.query_filter_type;
    const float position[3] = {x, y, z};
    return state.crowd->addAgent(position, &agent_params);
}

// CrowdAgent.position(): the agent's npos. `dtCrowdAgent::active` is the
// same set the wrapper keeps in its own `agents` map — `init` clears it
// for every slot in the pool and `addAgent` sets it — so an index the
// scene never added reads as absent here exactly as `getAgent` reports
// null upstream. `dtCrowd::getAgent` bounds-checks the index itself.
std::optional<NavVec3> navigation_agent_position(
    NavCrowdHandle crowd,
    int index) {
    const dtCrowdAgent* agent =
        crowd_state(crowd).crowd->getAgent(index);
    if (!agent || !agent->active) {
        return std::nullopt;
    }
    return NavVec3{agent->npos[0], agent->npos[1], agent->npos[2]};
}

// CrowdAgent.requestMoveTarget: the destination is snapped
// to a polygon FIRST and the crowd is given that polygon's reference
// alongside the snapped point. Handing dtCrowd the raw world position
// with a stale reference is what makes an agent refuse to move.
//
// The query is the CROWD's own (getNavMeshQuery), which is what the
// wrapper builds its navMeshQuery from, at the same +-1 half-extents
// and an include-all filter.
//
// Absence is REPORTED, not decided: the pin's `?.` is Babylon behaviour
// and belongs beside `get_agent_position`'s, in generated code.
bool navigation_agent_goto(
    NavCrowdHandle crowd,
    int index,
    NavVec3 destination) {
    NavCrowdState& state = crowd_state(crowd);
    const dtCrowdAgent* agent = state.crowd->getAgent(index);
    if (!agent || !agent->active) {
        return false;
    }
    const dtNavMeshQuery* query = state.crowd->getNavMeshQuery();
    const dtQueryFilter filter = include_all_filter();
    const float position[3] = {
        destination.x, destination.y, destination.z};
    dtPolyRef nearest_ref = 0;
    float nearest_point[3] = {0.0f, 0.0f, 0.0f};
    if (dtStatusFailed(query->findNearestPoly(
            position, default_query_half_extents, &filter,
            &nearest_ref, nearest_point)) ||
        nearest_ref == 0) {
        return true;
    }
    state.crowd->requestMoveTarget(index, nearest_ref, nearest_point);
    return true;
}

// updateNavCrowd -> Crowd.update: dtCrowd's own step. The pin passes the
// delta straight through and does no sub-stepping, so neither does this.
void navigation_update_crowd(NavCrowdHandle crowd, float delta_seconds) {
    crowd_state(crowd).crowd->update(delta_seconds, nullptr);
}

} // namespace bbl::pal
