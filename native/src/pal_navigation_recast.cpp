// The Recast/Detour implementation of the navigation seam.
//
// Every decision here is the pinned wrapper's, not this port's: the
// config defaults and unit transforms are @recast-navigation/core's
// `recastConfigDefaults`/`createRcConfig`, the build sequence is
// @recast-navigation/generators' `generateSoloNavMesh` step for step,
// the query construction is `NavMeshQuery`'s (2048 nodes, include-all
// filter), the debug walk is `getNavMeshPositionsAndIndices` plus the
// pinned `createDebugNavMeshGeometry` detached-triangle rebuild, and
// the raycast is the pinned `raycast` wrapper, and the tile-cache build
// is `generateTileCache` with its obstacle entry points. The library
// underneath is the same recastnavigation commit the wrapper's wasm
// compiles -- including the two RecastDemo files the tile-cache arm
// reaches for, which the overlay port installs from that same commit
// rather than leaving to a transcription here.

#include <bblite/pal_navigation.hpp>
#include "pal_handle_identity.hpp"

#ifndef BBLITE_HAS_NAV_TILE_CACHE
#define BBLITE_HAS_NAV_TILE_CACHE 0
#endif

#if BBLITE_HAS_NAV_TILE_CACHE
#include <ChunkyTriMesh.h>
#endif
#include <DetourCommon.h>
#if BBLITE_HAS_NAV_CROWD
#include <DetourCrowd.h>
#endif
#include <DetourNavMesh.h>
#include <DetourNavMeshBuilder.h>
#include <DetourNavMeshQuery.h>
#if BBLITE_HAS_NAV_TILE_CACHE
#include <DetourTileCache.h>
#include <DetourTileCacheBuilder.h>
#endif
#include <Recast.h>

#if BBLITE_HAS_NAV_TILE_CACHE
extern "C" {
#include <fastlz.h>
}
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {
namespace {

#if BBLITE_HAS_NAV_TILE_CACHE
/**
 * `dtTileCacheAlloc` as the sample allocator: a bump pointer over one
 * fixed buffer, resetting to the top between uses and never freeing.
 *
 * The cache asks for scratch while it decompresses and re-meshes a tile
 * and gives all of it back at once, so an allocator that cannot free
 * individually is the right shape rather than a shortcut. `alloc`
 * returning null past capacity is the sample's own behaviour and is what
 * makes an overrun a failed tile rather than a corrupted one.
 */
class TileCacheLinearAllocator final : public dtTileCacheAlloc {
public:
    explicit TileCacheLinearAllocator(std::size_t capacity)
        : buffer_(capacity) {}

    void reset() override { top_ = 0; }

    void* alloc(const std::size_t size) override {
        if (top_ + size > buffer_.size()) return nullptr;
        void* memory = buffer_.data() + top_;
        top_ += size;
        return memory;
    }

    void free(void* /*pointer*/) override {}

private:
    std::vector<unsigned char> buffer_;
    std::size_t top_ = 0;
};

/**
 * `dtTileCacheCompressor` over FastLZ, as the sample and the wrapper's
 * `RecastFastLZCompressor` both wrap it.
 *
 * The codec is lossless, so what it decides is only how big a cached tile
 * is -- never what the navmesh built from it looks like. It is the pinned
 * commit's own fastlz all the same, because a tile the reference wrote and
 * this read has to agree byte for byte on the header that precedes the
 * compressed run.
 */
class TileCacheFastLzCompressor final : public dtTileCacheCompressor {
public:
    int maxCompressedSize(const int bufferSize) override {
        return static_cast<int>(static_cast<float>(bufferSize) * 1.05f);
    }

    dtStatus compress(
        const unsigned char* buffer,
        const int bufferSize,
        unsigned char* compressed,
        const int /*maxCompressedSize*/,
        int* compressedSize) override {
        *compressedSize =
            fastlz_compress(buffer, bufferSize, compressed);
        return DT_SUCCESS;
    }

    dtStatus decompress(
        const unsigned char* compressed,
        const int compressedSize,
        unsigned char* buffer,
        const int maxBufferSize,
        int* bufferSize) override {
        *bufferSize = fastlz_decompress(compressed, compressedSize,
                                        buffer, maxBufferSize);
        return *bufferSize < 0 ? DT_FAILURE : DT_SUCCESS;
    }
};

/**
 * `createDefaultTileCacheMeshProcess`: area 0 and flag 1 on every polygon.
 *
 * This is the wrapper's default, not the RecastDemo sample's area table --
 * and it is the same normalization the solo arm applies to its own poly
 * mesh, so both arms hand Detour the one walkable class this port has.
 * The pinned `createNavMesh` installs a different process only when the
 * build carries off-mesh connections, which the tile-cache arm has none
 * of here.
 */
class TileCacheDefaultMeshProcess final : public dtTileCacheMeshProcess {
public:
    void process(
        struct dtNavMeshCreateParams* params,
        unsigned char* polyAreas,
        unsigned short* polyFlags) override {
        for (int poly = 0; poly < params->polyCount; ++poly) {
            polyAreas[poly] = 0;
            polyFlags[poly] = 1;
        }
    }
};

/** One compressed tile layer, as `dtBuildTileCacheLayer` returns one. */
struct TileCacheLayer {
    std::unique_ptr<unsigned char, decltype(&dtFree)> data{nullptr, dtFree};
    int size = 0;
};

#endif

/**
 * The Recast intermediates a tile build allocates, freed on every path out
 * of it.
 *
 * Recast hands back raw pointers with matching `rcFree*` calls, and the tile
 * pipeline has ten early returns; one owner per kind is what keeps a failed
 * tile from leaking the ones before it. The spelling is the one this file's
 * navmesh, query and crowd already use.
 */
template <typename T>
using RecastOwner = std::unique_ptr<T, void (*)(T*)>;

using HeightfieldOwner = RecastOwner<rcHeightfield>;
using CompactHeightfieldOwner = RecastOwner<rcCompactHeightfield>;
using HeightfieldLayerSetOwner = RecastOwner<rcHeightfieldLayerSet>;
#if BBLITE_HAS_NAV_TILE_CACHE
using TileCacheOwner = RecastOwner<dtTileCache>;
#endif

} // namespace

struct NavigationMeshState {
    std::unique_ptr<dtNavMesh, void (*)(dtNavMesh*)> nav_mesh{
        nullptr, [](dtNavMesh* mesh) { dtFreeNavMesh(mesh); }};
    std::unique_ptr<dtNavMeshQuery, void (*)(dtNavMeshQuery*)> query{
        nullptr,
        [](dtNavMeshQuery* value) { dtFreeNavMeshQuery(value); }};
    dtQueryFilter filter;
#if BBLITE_HAS_NAV_TILE_CACHE
    // The cache borrows these three objects; reverse destruction releases it first.
    std::unique_ptr<TileCacheLinearAllocator> allocator;
    std::unique_ptr<TileCacheFastLzCompressor> compressor;
    std::unique_ptr<TileCacheDefaultMeshProcess> mesh_process;
    TileCacheOwner tile_cache{nullptr, dtFreeTileCache};
#endif
};

struct NavigationPluginState {
    const std::uint32_t identity = next_handle_identity<NavigationPluginState>();
    std::shared_ptr<NavigationMeshState> mesh = std::make_shared<NavigationMeshState>();
};

#if BBLITE_HAS_NAV_CROWD
struct NavCrowdState {
    const std::uint32_t identity = next_handle_identity<NavCrowdState>();
    // Detour borrows the exact mesh this crowd was initialized against.
    std::shared_ptr<NavigationMeshState> mesh;
    RecastOwner<dtCrowd> crowd{nullptr, dtFreeCrowd};
};
#endif

namespace {
NavigationMeshState& plugin_state(const NavigationHandle& handle) {
    if (!handle.ownership || handle.value != handle.ownership->identity) {
        throw std::runtime_error("Invalid navigation plugin handle.");
    }
    return *handle.ownership->mesh;
}

#if BBLITE_HAS_NAV_TILE_CACHE
/** `_assertTileCache`: the obstacle surface needs a cache to act on. */
NavigationMeshState& tile_cache_state(NavigationHandle handle) {
    NavigationMeshState& state = plugin_state(handle);
    if (!state.tile_cache) {
        throw std::runtime_error(
            "Navmesh has no tile cache. Build with `maxObstacles > 0` to "
            "enable obstacles.");
    }
    return state;
}
#endif

#if BBLITE_HAS_NAV_CROWD

NavCrowdState& crowd_state(const NavCrowdHandle& handle) {
    if (!handle.ownership || handle.value != handle.ownership->identity) {
        throw std::runtime_error("Invalid navigation crowd handle.");
    }
    return *handle.ownership;
}
#endif

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

/** `getBoundingBox`: the bounds of the INDEXED positions, which is not
 *  the vertex array's own where a vertex went unreferenced. */
void indexed_bounds(
    const NavMeshGeometry& geometry,
    float (&bounds_min)[3],
    float (&bounds_max)[3]) {
    bounds_min[0] = bounds_min[1] = bounds_min[2] =
        std::numeric_limits<float>::infinity();
    bounds_max[0] = bounds_max[1] = bounds_max[2] =
        -std::numeric_limits<float>::infinity();
    for (const std::uint32_t index : geometry.indices) {
        for (int axis = 0; axis < 3; ++axis) {
            const float value = geometry.positions[index * 3 + axis];
            bounds_min[axis] = std::min(bounds_min[axis], value);
            bounds_max[axis] = std::max(bounds_max[axis], value);
        }
    }
}

float pick_float(const std::optional<double>& given, float fallback) {
    return given ? static_cast<float>(*given) : fallback;
}

int pick_int(const std::optional<double>& given, int fallback) {
    return given ? static_cast<int>(*given) : fallback;
}

/**
 * `{...recastConfigDefaults, ...cfg}` then `createRcConfig`'s field copy.
 *
 * The wrapper stores JS numbers into rcConfig's int fields, where
 * emscripten truncates -- the double-to-int casts in `pick_int` are that
 * same truncation. Both build arms share this because both take the same
 * spread; what differs is only what each does with `tileSize` afterwards.
 */
rcConfig resolved_rc_config(const NavMeshBuildParams& params) {
    const ResolvedBuildConfig defaults;
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
    return config;
}

/**
 * The indexed geometry both build arms rasterize, in Recast's own spelling.
 *
 * Recast takes vertices as a bare float triple array and triangles as ints,
 * neither of which the seam's own vectors are, so the conversion is one
 * place rather than the first line of each arm.
 */
struct RecastInputMesh {
    const float* vertices;
    int vertex_count;
    int triangle_count;
    std::vector<int> triangles;
    float bounds_min[3];
    float bounds_max[3];
};

RecastInputMesh prepare_input(const NavMeshGeometry& geometry) {
    RecastInputMesh input{
        geometry.positions.data(),
        static_cast<int>(geometry.positions.size() / 3),
        static_cast<int>(geometry.indices.size()) / 3,
        std::vector<int>(geometry.indices.begin(), geometry.indices.end()),
        {},
        {}};
    indexed_bounds(geometry, input.bounds_min, input.bounds_max);
    return input;
}

/**
 * `new NavMeshQuery(navMesh)`: 2048 nodes and the include-all filter, which
 * every arm ends with because the wrapper's constructor is what every arm
 * calls. The prefix is the arm's own failure spelling.
 */
void install_query(
    NavigationMeshState& state,
    dtNavMesh* nav_mesh,
    const std::string& failure_prefix) {
    RecastOwner<dtNavMeshQuery> query{dtAllocNavMeshQuery(), dtFreeNavMeshQuery};
    if (!query || dtStatusFailed(query->init(nav_mesh, 2048))) {
        throw std::runtime_error(
            failure_prefix + "Failed to initialize navmesh query");
    }
    state.query = std::move(query);
    state.filter = include_all_filter();
}

/** The generator's post-`createRcConfig` transforms, which both arms
 *  apply once the grid size is known. */
void apply_generator_config_transforms(rcConfig& config) {
    config.minRegionArea = config.minRegionArea * config.minRegionArea;
    config.mergeRegionArea =
        config.mergeRegionArea * config.mergeRegionArea;
    config.detailSampleDist = config.detailSampleDist < 0.9f
        ? 0.0f
        : config.cs * config.detailSampleDist;
    config.detailSampleMaxError = config.ch * config.detailSampleMaxError;
}

} // namespace

NavigationHandle navigation_create_plugin() {
    auto state = std::make_shared<NavigationPluginState>();
    return NavigationHandle{state->identity, std::move(state)};
}

void navigation_create_solo_nav_mesh(
    NavigationHandle plugin,
    const NavMeshGeometry& geometry,
    const NavMeshBuildParams& params) {
    (void)plugin_state(plugin);
    auto built = std::make_shared<NavigationMeshState>();
    NavigationMeshState& state = *built;

    const RecastInputMesh input = prepare_input(geometry);
    const float* vertices = input.vertices;
    const int vertex_count = input.vertex_count;
    const int triangle_count = input.triangle_count;
    const std::vector<int>& triangles = input.triangles;

    rcConfig config = resolved_rc_config(params);
    apply_generator_config_transforms(config);
    rcVcopy(config.bmin, input.bounds_min);
    rcVcopy(config.bmax, input.bounds_max);
    rcCalcGridSize(config.bmin, config.bmax, config.cs, &config.width,
                   &config.height);

    rcContext context(false);
    const auto fail = [](const std::string& message) -> void {
        throw std::runtime_error("createNavMesh failed: " + message);
    };

    RecastOwner<rcHeightfield> heightfield{rcAllocHeightfield(), rcFreeHeightField};
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

    RecastOwner<rcCompactHeightfield> compact{rcAllocCompactHeightfield(), rcFreeCompactHeightfield};
    if (!compact ||
        !rcBuildCompactHeightfield(&context, config.walkableHeight,
                                   config.walkableClimb, *heightfield,
                                   *compact)) {
        fail("Failed to build compact data");
    }
    heightfield.reset();

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

    RecastOwner<rcContourSet> contours{rcAllocContourSet(), rcFreeContourSet};
    if (!contours ||
        !rcBuildContours(&context, *compact,
                         config.maxSimplificationError,
                         config.maxEdgeLen, *contours,
                         RC_CONTOUR_TESS_WALL_EDGES)) {
        fail("Failed to create contours");
    }

    RecastOwner<rcPolyMesh> poly_mesh{rcAllocPolyMesh(), rcFreePolyMesh};
    if (!poly_mesh ||
        !rcBuildPolyMesh(&context, *contours, config.maxVertsPerPoly,
                         *poly_mesh)) {
        fail("Failed to triangulate contours");
    }

    RecastOwner<rcPolyMeshDetail> detail_mesh{rcAllocPolyMeshDetail(), rcFreePolyMeshDetail};
    if (!detail_mesh ||
        !rcBuildPolyMeshDetail(&context, *poly_mesh, *compact,
                               config.detailSampleDist,
                               config.detailSampleMaxError,
                               *detail_mesh)) {
        fail("Failed to build detail mesh");
    }
    compact.reset();
    contours.reset();

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
    poly_mesh.reset();
    detail_mesh.reset();

    state.nav_mesh.reset(dtAllocNavMesh());
    dtNavMesh* nav_mesh = state.nav_mesh.get();
    if (!nav_mesh ||
        dtStatusFailed(nav_mesh->init(nav_data, nav_data_size,
                                      DT_TILE_FREE_DATA))) {
        dtFree(nav_data);
        throw std::runtime_error(
            "createNavMesh failed: Failed to initialize solo NavMesh");
    }
    install_query(state, nav_mesh, "createNavMesh failed: ");
    plugin.ownership->mesh = std::move(built);
}

#if BBLITE_HAS_NAV_TILE_CACHE
/**
 * One tile's compressed layers, or none where the tile is empty.
 *
 * The whole per-tile Recast pipeline, which is where a tile-cache build
 * differs from a solo one: it stops at the heightfield LAYER set and
 * compresses each layer into a cache tile instead of building polygons.
 * Every early return here is a tile the wrapper also gives up on, and the
 * build carries on with the tiles that did work.
 */
std::vector<TileCacheLayer> rasterize_tile_layers(
    rcContext* context,
    const rcConfig& config,
    const float* bounds_min,
    const float* bounds_max,
    const float* vertices,
    int vertex_count,
    const rcChunkyTriMesh& chunky,
    dtTileCacheCompressor* compressor,
    int tile_x,
    int tile_y) {
const float tcs = static_cast<float>(config.tileSize) * config.cs;
    rcConfig tile_config = config;
    float tile_min[3] = {
        bounds_min[0] + static_cast<float>(tile_x) * tcs,
        bounds_min[1],
        bounds_min[2] + static_cast<float>(tile_y) * tcs};
    float tile_max[3] = {
        bounds_min[0] + static_cast<float>(tile_x + 1) * tcs,
        bounds_max[1],
        bounds_min[2] + static_cast<float>(tile_y + 1) * tcs};
    const float border =
        static_cast<float>(tile_config.borderSize) * tile_config.cs;
    tile_min[0] -= border;
    tile_min[2] -= border;
    tile_max[0] += border;
    tile_max[2] += border;
    rcVcopy(tile_config.bmin, tile_min);
    rcVcopy(tile_config.bmax, tile_max);

    HeightfieldOwner heightfield{
        rcAllocHeightfield(),
        [](rcHeightfield* v) { rcFreeHeightField(v); }};
    if (!heightfield ||
        !rcCreateHeightfield(context, *heightfield,
                             tile_config.width, tile_config.height,
                             tile_min, tile_max, tile_config.cs,
                             tile_config.ch)) {
        return {};
    }

    // The chunky mesh partitions the triangle list, so the chunks a
    // rect overlaps carry each triangle at most once -- which is why
    // rasterizing them in turn gives the heightfield one pass over the
    // whole list would, at a fraction of the work.
    float rect_min[2] = {tile_min[0], tile_min[2]};
    float rect_max[2] = {tile_max[0], tile_max[2]};
    constexpr int max_chunk_ids = 512;
    std::array<int, max_chunk_ids> chunk_ids{};
    const int overlapping = rcGetChunksOverlappingRect(
        &chunky, rect_min, rect_max, chunk_ids.data(),
        max_chunk_ids);
    if (overlapping == 0) return {};
    for (int chunk = 0; chunk < overlapping; ++chunk) {
        const rcChunkyTriMeshNode& node =
            chunky.nodes[chunk_ids[static_cast<std::size_t>(
                chunk)]];
        const int* node_triangles = &chunky.tris[node.i * 3];
        std::vector<unsigned char> areas(
            static_cast<std::size_t>(node.n), 0);
        rcMarkWalkableTriangles(
            context, tile_config.walkableSlopeAngle, vertices,
            vertex_count, node_triangles, node.n, areas.data());
        if (!rcRasterizeTriangles(
                context, vertices, vertex_count, node_triangles,
                areas.data(), node.n, *heightfield,
                tile_config.walkableClimb)) {
            return {};
        }
    }

    rcFilterLowHangingWalkableObstacles(context, config.walkableClimb,
                                        *heightfield);
    rcFilterLedgeSpans(context, config.walkableHeight,
                       config.walkableClimb, *heightfield);
    rcFilterWalkableLowHeightSpans(context, config.walkableHeight,
                                   *heightfield);

    CompactHeightfieldOwner compact{
        rcAllocCompactHeightfield(),
        [](rcCompactHeightfield* v) { rcFreeCompactHeightfield(v); }};
    if (!compact ||
        !rcBuildCompactHeightfield(context, config.walkableHeight,
                                   config.walkableClimb, *heightfield,
                                   *compact)) {
        return {};
    }
    heightfield.reset();
    if (!rcErodeWalkableArea(context, config.walkableRadius,
                             *compact)) {
        return {};
    }

    HeightfieldLayerSetOwner layers{
        rcAllocHeightfieldLayerSet(),
        [](rcHeightfieldLayerSet* v) { rcFreeHeightfieldLayerSet(v); }};
    if (!layers ||
        !rcBuildHeightfieldLayers(context, *compact,
                                  config.borderSize,
                                  config.walkableHeight, *layers)) {
        return {};
    }

    std::vector<TileCacheLayer> tiles;
    for (int index = 0; index < layers->nlayers; ++index) {
        const rcHeightfieldLayer& layer = layers->layers[index];
        dtTileCacheLayerHeader header;
        std::memset(&header, 0, sizeof(header));
        header.magic = DT_TILECACHE_MAGIC;
        header.version = DT_TILECACHE_VERSION;
        header.tx = tile_x;
        header.ty = tile_y;
        header.tlayer = index;
        dtVcopy(header.bmin, layer.bmin);
        dtVcopy(header.bmax, layer.bmax);
        header.width = static_cast<unsigned char>(layer.width);
        header.height = static_cast<unsigned char>(layer.height);
        header.minx = static_cast<unsigned char>(layer.minx);
        header.maxx = static_cast<unsigned char>(layer.maxx);
        header.miny = static_cast<unsigned char>(layer.miny);
        header.maxy = static_cast<unsigned char>(layer.maxy);
        header.hmin = static_cast<unsigned short>(layer.hmin);
        header.hmax = static_cast<unsigned short>(layer.hmax);

        TileCacheLayer built;
        unsigned char* data = nullptr;
        const dtStatus status = dtBuildTileCacheLayer(compressor, &header, layer.heights,
            layer.areas, layer.cons, &data, &built.size);
        built.data.reset(data);
        if (dtStatusFailed(status)) return {};
        tiles.push_back(std::move(built));
    }
    return tiles;
}

/**
 * The tile-cache build, `generateTileCache` step for step.
 *
 * What differs from the solo arm above is where the pipeline stops: each
 * tile's heightfield LAYERS are compressed into the cache instead of being
 * turned into polygons, and the cache turns them into navmesh tiles
 * afterwards. That indirection is the whole point -- an obstacle added
 * later re-meshes only the tiles it touches, out of layers the cache still
 * holds.
 */
void navigation_create_tile_cache_nav_mesh(
    NavigationHandle plugin,
    const NavMeshGeometry& geometry,
    const NavMeshBuildParams& params) {
    (void)plugin_state(plugin);
    auto built = std::make_shared<NavigationMeshState>();
    NavigationMeshState& state = *built;

    const RecastInputMesh input = prepare_input(geometry);
    const float* vertices = input.vertices;
    const int vertex_count = input.vertex_count;
    const float* bounds_min = input.bounds_min;
    const float* bounds_max = input.bounds_max;

    // `{...tileCacheGeneratorConfigDefaults, ...cfg}`: the solo defaults
    // plus this arm's three, of which only `tileSize` is an rcConfig field
    // -- the other two are destructured out of the spread before
    // `createRcConfig` ever sees it.
    rcConfig config = resolved_rc_config(params);
    // This arm is SELECTED by `maxObstacles`, and the generation that
    // selects it refuses the arm without a `tileSize`, so both are present
    // by the time this runs -- the pin's own 32 and 128 would be answers to
    // a question already asked. `expectedLayersPerTile` is the one a
    // reached scene may leave out, so it is the one that carries a default.
    if (!params.max_obstacles || !params.tile_size) {
        throw std::runtime_error(
            "createNavMesh (tile cache) failed: a tile-cache build takes "
            "both maxObstacles and tileSize.");
    }
    config.tileSize = static_cast<int>(*params.tile_size);
    const int max_obstacles = static_cast<int>(*params.max_obstacles);
    const int expected_layers_per_tile =
        pick_int(params.expected_layers_per_tile, 4);

    rcVcopy(config.bmin, bounds_min);
    rcVcopy(config.bmax, bounds_max);
    rcCalcGridSize(config.bmin, config.bmax, config.cs, &config.width,
                   &config.height);
    apply_generator_config_transforms(config);

    // The tile grid is measured against the FULL grid size, and only then
    // is width/height overwritten with one padded tile's extent -- so
    // every tile rasterizes at the same size whatever the world's is.
    const int tile_size = config.tileSize;
    const int tile_width = (config.width + tile_size - 1) / tile_size;
    const int tile_height = (config.height + tile_size - 1) / tile_size;
    config.borderSize = config.walkableRadius + 3;
    config.width = config.tileSize + config.borderSize * 2;
    config.height = config.tileSize + config.borderSize * 2;

    const auto fail = [](const std::string& message) -> void {
        throw std::runtime_error(
            "createNavMesh (tile cache) failed: " + message);
    };

    dtTileCacheParams cache_params;
    std::memset(&cache_params, 0, sizeof(cache_params));
    dtVcopy(cache_params.orig, bounds_min);
    cache_params.cs = config.cs;
    cache_params.ch = config.ch;
    cache_params.width = config.tileSize;
    cache_params.height = config.tileSize;
    cache_params.walkableHeight =
        static_cast<float>(config.walkableHeight) * config.ch;
    cache_params.walkableRadius =
        static_cast<float>(config.walkableRadius) * config.cs;
    cache_params.walkableClimb =
        static_cast<float>(config.walkableClimb) * config.ch;
    cache_params.maxSimplificationError = config.maxSimplificationError;
    cache_params.maxTiles =
        tile_width * tile_height * expected_layers_per_tile;
    cache_params.maxObstacles = max_obstacles;

    // The three the cache borrows for the life of the plugin: a bump
    // allocator over 32000 bytes, the FastLZ codec, and the mesh process
    // `createDefaultTileCacheMeshProcess` installs -- area 0 and flag 1 on
    // every polygon, which is the same normalization the solo arm applies
    // to its poly mesh.
    state.allocator = std::make_unique<TileCacheLinearAllocator>(32000);
    state.compressor = std::make_unique<TileCacheFastLzCompressor>();
    state.mesh_process = std::make_unique<TileCacheDefaultMeshProcess>();

    TileCacheOwner tile_cache{
        dtAllocTileCache(), [](dtTileCache* v) { dtFreeTileCache(v); }};
    if (!tile_cache ||
        dtStatusFailed(tile_cache->init(
            &cache_params, state.allocator.get(), state.compressor.get(),
            state.mesh_process.get()))) {
        fail("Failed to initialize tile cache");
    }

    // 22 bits identify a tile and a polygon between them, so the tile
    // count decides how many are left for polygons.
    const int tile_bits = std::min(
        static_cast<int>(dtIlog2(dtNextPow2(static_cast<unsigned int>(
            tile_width * tile_height * expected_layers_per_tile)))),
        14);
    const int poly_bits = 22 - tile_bits;

    dtNavMeshParams nav_params;
    std::memset(&nav_params, 0, sizeof(nav_params));
    dtVcopy(nav_params.orig, bounds_min);
    nav_params.tileWidth = static_cast<float>(config.tileSize) * config.cs;
    nav_params.tileHeight = nav_params.tileWidth;
    nav_params.maxTiles = 1 << tile_bits;
    nav_params.maxPolys = 1 << poly_bits;

    state.nav_mesh.reset(dtAllocNavMesh());
    dtNavMesh* nav_mesh = state.nav_mesh.get();
    if (!nav_mesh || dtStatusFailed(nav_mesh->init(&nav_params))) {
        fail("Failed to initialize tiled navmesh");
    }

    rcChunkyTriMesh chunky_mesh;
    if (!rcCreateChunkyTriMesh(vertices, input.triangles.data(),
                               input.triangle_count, 256, &chunky_mesh)) {
        fail("Failed to build chunky triangle mesh");
    }

    rcContext context(false);


    // Two passes, the wrapper's own: every tile's layers into the cache
    // first, then every tile's initial mesh out of it. They cannot merge,
    // because a tile's mesh is built against neighbours the first pass may
    // not have added yet.
    for (int y = 0; y < tile_height; ++y) {
        for (int x = 0; x < tile_width; ++x) {
            for (TileCacheLayer& layer : rasterize_tile_layers(
                     &context, config, bounds_min, bounds_max, vertices,
                     vertex_count, chunky_mesh, state.compressor.get(),
                     x, y)) {
                // A refused add is a warning upstream, not a failure: the
                // cache is full and the tiles it already holds still make
                // a navmesh. The data is the cache's on success and ours
                // on failure, which is what the reference frees.
                if (dtStatusSucceed(tile_cache->addTile(
                        layer.data.get(), layer.size,
                        DT_COMPRESSEDTILE_FREE_DATA, nullptr))) {
                    (void)layer.data.release();
                }
            }
        }
    }
    for (int y = 0; y < tile_height; ++y) {
        for (int x = 0; x < tile_width; ++x) {
            if (dtStatusFailed(tile_cache->buildNavMeshTilesAt(
                    x, y, nav_mesh))) {
                fail("Failed to build nav mesh tiles at " +
                     std::to_string(x) + ", " + std::to_string(y));
            }
        }
    }
    state.tile_cache = std::move(tile_cache);
    install_query(state, nav_mesh, "createNavMesh (tile cache) failed: ");
    plugin.ownership->mesh = std::move(built);
}

/** The cache's own drain, on a state the caller already resolved. */
void drain_obstacle_requests(NavigationMeshState& state) {
    bool up_to_date = false;
    while (!up_to_date) {
        state.tile_cache->update(0.0f, state.nav_mesh.get(), &up_to_date);
    }
}

NavObstacleHandle navigation_add_box_obstacle(
    NavigationHandle plugin,
    NavVec3 position,
    NavVec3 half_extents,
    float angle) {
    NavigationMeshState& state = tile_cache_state(plugin);
    const float centre[3] = {position.x, position.y, position.z};
    const float half[3] = {half_extents.x, half_extents.y, half_extents.z};
    dtObstacleRef reference = 0;
    if (dtStatusFailed(state.tile_cache->addBoxObstacle(
            centre, half, angle, &reference))) {
        throw std::runtime_error(
            "addBoxObstacle failed: the tile cache holds no room for "
            "another obstacle.");
    }
    drain_obstacle_requests(state);
    return NavObstacleHandle{static_cast<std::uint32_t>(reference), plugin.ownership->mesh};
}

NavObstacleHandle navigation_add_cylinder_obstacle(
    NavigationHandle plugin,
    NavVec3 position,
    float radius,
    float height) {
    NavigationMeshState& state = tile_cache_state(plugin);
    const float centre[3] = {position.x, position.y, position.z};
    dtObstacleRef reference = 0;
    if (dtStatusFailed(state.tile_cache->addObstacle(
            centre, radius, height, &reference))) {
        throw std::runtime_error(
            "addCylinderObstacle failed: the tile cache holds no room for "
            "another obstacle.");
    }
    drain_obstacle_requests(state);
    return NavObstacleHandle{static_cast<std::uint32_t>(reference), plugin.ownership->mesh};
}

void navigation_remove_obstacle(
    NavigationHandle plugin,
    NavObstacleHandle obstacle) {
    NavigationMeshState& state = tile_cache_state(plugin);
    if (obstacle.value && obstacle.owner.lock().get() != &state) {
        throw std::runtime_error("Navigation obstacle belongs to a different or replaced navmesh.");
    }
    state.tile_cache->removeObstacle(static_cast<dtObstacleRef>(obstacle.value));
    drain_obstacle_requests(state);
}

void navigation_update_obstacles(NavigationHandle plugin) {
    NavigationMeshState& state = tile_cache_state(plugin);
    bool up_to_date = false;
    while (!up_to_date) {
        state.tile_cache->update(0.0f, state.nav_mesh.get(),
                                       &up_to_date);
    }
}

#endif

NavDebugGeometry navigation_debug_geometry(NavigationHandle plugin) {
    NavigationMeshState& state = plugin_state(plugin);
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
    NavigationMeshState& state = plugin_state(plugin);
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
    NavigationMeshState& state = plugin_state(plugin);
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
    NavigationMeshState& state = plugin_state(plugin);
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
#if BBLITE_HAS_NAV_CROWD
NavCrowdHandle navigation_create_crowd(
    NavigationHandle plugin,
    int max_agents,
    float max_agent_radius) {
    NavigationMeshState& state = plugin_state(plugin);
    if (!state.nav_mesh) {
        throw std::runtime_error(
            "No navmesh generated. Call createNavMesh first.");
    }
    auto owned = std::make_shared<NavCrowdState>();
    owned->mesh = plugin.ownership->mesh;
    owned->crowd.reset(dtAllocCrowd());
    if (!owned->crowd || !owned->crowd->init(max_agents, max_agent_radius, state.nav_mesh.get())) {
        throw std::runtime_error("createNavCrowd failed: Failed to initialize crowd");
    }
    return NavCrowdHandle{owned->identity, std::move(owned)};
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
#endif

} // namespace bbl::pal
