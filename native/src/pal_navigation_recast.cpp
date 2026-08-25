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
    const int index_count = static_cast<int>(geometry.indices.size());
    const int triangle_count = index_count / 3;
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
    ResolvedBuildConfig resolved;
    if (params.cs) resolved.cs = static_cast<float>(*params.cs);
    if (params.ch) resolved.ch = static_cast<float>(*params.ch);
    if (params.walkable_slope_angle) {
        resolved.walkable_slope_angle =
            static_cast<float>(*params.walkable_slope_angle);
    }
    if (params.walkable_height) {
        resolved.walkable_height =
            static_cast<int>(*params.walkable_height);
    }
    if (params.walkable_climb) {
        resolved.walkable_climb =
            static_cast<int>(*params.walkable_climb);
    }
    if (params.walkable_radius) {
        resolved.walkable_radius =
            static_cast<int>(*params.walkable_radius);
    } else {
        // The wrapper's default walkableRadius is 0.5, truncated to 0
        // by rcConfig's int field.
        resolved.walkable_radius = 0;
    }
    if (params.max_edge_len) {
        resolved.max_edge_len = static_cast<int>(*params.max_edge_len);
    }
    if (params.max_simplification_error) {
        resolved.max_simplification_error =
            static_cast<float>(*params.max_simplification_error);
    }
    if (params.min_region_area) {
        resolved.min_region_area =
            static_cast<int>(*params.min_region_area);
    }
    if (params.merge_region_area) {
        resolved.merge_region_area =
            static_cast<int>(*params.merge_region_area);
    }
    if (params.max_verts_per_poly) {
        resolved.max_verts_per_poly =
            static_cast<int>(*params.max_verts_per_poly);
    }
    if (params.detail_sample_dist) {
        resolved.detail_sample_dist =
            static_cast<float>(*params.detail_sample_dist);
    }
    if (params.detail_sample_max_error) {
        resolved.detail_sample_max_error =
            static_cast<float>(*params.detail_sample_max_error);
    }

    rcConfig config;
    std::memset(&config, 0, sizeof(config));
    config.cs = resolved.cs;
    config.ch = resolved.ch;
    config.walkableSlopeAngle = resolved.walkable_slope_angle;
    config.walkableHeight = resolved.walkable_height;
    config.walkableClimb = resolved.walkable_climb;
    config.walkableRadius = resolved.walkable_radius;
    config.maxEdgeLen = resolved.max_edge_len;
    config.maxSimplificationError = resolved.max_simplification_error;
    config.minRegionArea = resolved.min_region_area;
    config.mergeRegionArea = resolved.merge_region_area;
    config.maxVertsPerPoly = resolved.max_verts_per_poly;
    config.detailSampleDist = resolved.detail_sample_dist;
    config.detailSampleMaxError = resolved.detail_sample_max_error;
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
    state.filter.setIncludeFlags(0xffff);
    state.filter.setExcludeFlags(0);
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
        const dtMeshTile* tile =
            const_cast<const dtNavMesh&>(mesh).getTile(tile_index);
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
    const float half_extents[3] = {1.0f, 1.0f, 1.0f};

    dtPolyRef nearest_ref = 0;
    float nearest_point[3] = {0.0f, 0.0f, 0.0f};
    const dtStatus nearest_status = state.query->findNearestPoly(
        start, half_extents, &state.filter, &nearest_ref,
        nearest_point);
    if (dtStatusFailed(nearest_status) || nearest_ref == 0) {
        return NavRaycastHit{};
    }

    dtRaycastHit ray_hit;
    std::memset(&ray_hit, 0, sizeof(ray_hit));
    ray_hit.path = nullptr;
    ray_hit.maxPath = 0;
    state.query->raycast(nearest_ref, start, end, &state.filter, 0,
                         &ray_hit, 0);
    const float t = ray_hit.t;
    if (!(t > 0.0f && t < 1.0f)) {
        return NavRaycastHit{};
    }
    return NavRaycastHit{true, t};
}

} // namespace bbl::pal
