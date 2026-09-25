// The Recast/Detour implementation of the navigation seam.
//
// Every decision here is the pinned wrapper's, not this port's: every
// number the @recast-navigation generators compute before calling the
// library -- bounds, config, Detour parameter records, each tile's config
// -- arrives as a plan generated from the installed packages; the wrapper
// JavaScript that runs over library objects (the detail-mesh walk, the poly
// normalization, the tile mesh process) is generated as templates this unit
// instantiates; the build sequence is @recast-navigation/generators'
// `generateSoloNavMesh` step for step, the query construction is
// `NavMeshQuery`'s (its node pool and search box from the generated query
// defaults, include-all filter), the raycast is the pinned `raycast`
// wrapper, and the tile-cache build
// is `generateTileCache` with its obstacle entry points. The library
// underneath is the same recastnavigation commit the wrapper's wasm
// compiles -- including the two RecastDemo files the tile-cache arm
// reaches for, which the overlay port installs from that same commit
// rather than leaving to a transcription here.

#include <bblite/features/has_nav_crowd.hpp>
#include <bblite/features/has_nav_tile_cache.hpp>

#include <bblite/pal_navigation.hpp>
#include <bblite/upstream/navigation_library.hpp>
#include "pal_handle_identity.hpp"

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
#include <cmath>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string>
#include <type_traits>
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
    explicit TileCacheLinearAllocator(std::size_t capacity) : buffer_(capacity) {}

    void reset() override { top_ = 0; }

    void* alloc(const std::size_t size) override {
        if (top_ + size > buffer_.size())
            return nullptr;
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

    dtStatus compress(const unsigned char* buffer, const int bufferSize, unsigned char* compressed,
                      const int /*maxCompressedSize*/, int* compressedSize) override {
        *compressedSize = fastlz_compress(buffer, bufferSize, compressed);
        return DT_SUCCESS;
    }

    dtStatus decompress(const unsigned char* compressed, const int compressedSize,
                        unsigned char* buffer, const int maxBufferSize, int* bufferSize) override {
        *bufferSize = fastlz_decompress(compressed, compressedSize, buffer, maxBufferSize);
        return *bufferSize < 0 ? DT_FAILURE : DT_SUCCESS;
    }
};

/**
 * The wrapper's `createDefaultTileCacheMeshProcess`, generated from the
 * package: the process the cache calls on each tile's create params and
 * poly area/flag arrays. The pinned `createNavMesh` installs a different
 * process only beside off-mesh connections, which the compiler refuses on
 * a tile cache.
 */
class TileCacheDefaultMeshProcess final : public dtTileCacheMeshProcess {
public:
    void process(struct dtNavMeshCreateParams* params, unsigned char* polyAreas,
                 unsigned short* polyFlags) override {
        bbl::upstream::default_tile_cache_mesh_process(params, polyAreas, polyFlags);
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
template <typename T> using RecastOwner = std::unique_ptr<T, void (*)(T*)>;

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
        nullptr, [](dtNavMeshQuery* value) { dtFreeNavMeshQuery(value); }};
    dtQueryFilter filter;
    /** `NavMeshQuery.defaultQueryHalfExtents`, at the width Detour takes. */
    float query_half_extents[3] = {0.0f, 0.0f, 0.0f};
    /** `computePath`'s corridor and straight-path capacities and options. */
    int path_max_polys = 0;
    int straight_path_max_points = 0;
    int straight_path_options = 0;
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
        throw std::runtime_error("Navmesh has no tile cache. Build with `maxObstacles > 0` to "
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

/** `new QueryFilter()`: Detour's own include-everything defaults, which
 *  the wrapper never narrows. Stated once so a future exclude reaches
 *  every query rather than the ones someone remembered. */
dtQueryFilter include_all_filter() {
    dtQueryFilter filter;
    filter.setIncludeFlags(0xffff);
    filter.setExcludeFlags(0);
    return filter;
}

/**
 * One plan field as the library struct field it mirrors. The types are
 * asserted equal, so the copy moves a value the generated plan already
 * narrowed and converts none; an array copies element for element.
 */
template <typename Target, typename Source> void mirror(Target& target, const Source& source) {
    static_assert(std::is_same_v<Target, Source>,
                  "a navigation plan record no longer mirrors its library struct");
    if constexpr (std::is_array_v<Target>) {
        std::copy(std::begin(source), std::end(source), std::begin(target));
    } else {
        target = source;
    }
}

/**
 * A list of JavaScript numbers as the typed array an emscripten binding
 * copies it into: each element stored at the element type's own width.
 */
template <typename T> std::vector<T> typed_array(const std::vector<double>& values) {
    std::vector<T> typed;
    typed.reserve(values.size());
    for (const double value : values) {
        typed.push_back(bbl::js::numeric_store_value<T>(value));
    }
    return typed;
}

/** The plan's config as Recast's own `rcConfig`, which the wrapper's object IS. */
rcConfig recast_config(const NavRcConfig& from) {
    static_assert(sizeof(rcConfig) == sizeof(NavRcConfig),
                  "rcConfig holds a field NavRcConfig does not mirror");
    rcConfig config{};
    mirror(config.width, from.width);
    mirror(config.height, from.height);
    mirror(config.tileSize, from.tileSize);
    mirror(config.borderSize, from.borderSize);
    mirror(config.cs, from.cs);
    mirror(config.ch, from.ch);
    mirror(config.bmin, from.bmin);
    mirror(config.bmax, from.bmax);
    mirror(config.walkableSlopeAngle, from.walkableSlopeAngle);
    mirror(config.walkableHeight, from.walkableHeight);
    mirror(config.walkableClimb, from.walkableClimb);
    mirror(config.walkableRadius, from.walkableRadius);
    mirror(config.maxEdgeLen, from.maxEdgeLen);
    mirror(config.maxSimplificationError, from.maxSimplificationError);
    mirror(config.minRegionArea, from.minRegionArea);
    mirror(config.mergeRegionArea, from.mergeRegionArea);
    mirror(config.maxVertsPerPoly, from.maxVertsPerPoly);
    mirror(config.detailSampleDist, from.detailSampleDist);
    mirror(config.detailSampleMaxError, from.detailSampleMaxError);
    return config;
}

/**
 * The plan's bounds as the float arrays a wrapper call hands Recast: the
 * binding copies each JavaScript number into float storage, which rounds
 * it to nearest.
 */
struct RecastBounds {
    float min[3];
    float max[3];
};

RecastBounds recast_bounds(const NavBounds& bounds) {
    RecastBounds recast{};
    for (std::size_t axis = 0; axis < 3; ++axis) {
        recast.min[axis] = static_cast<float>(bounds.min[axis]);
        recast.max[axis] = static_cast<float>(bounds.max[axis]);
    }
    return recast;
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
};

RecastInputMesh prepare_input(const NavMeshGeometry& geometry) {
    return RecastInputMesh{geometry.positions.data(),
                           static_cast<int>(geometry.positions.size() / 3),
                           static_cast<int>(geometry.indices.size()) / 3,
                           std::vector<int>(geometry.indices.begin(), geometry.indices.end())};
}

/**
 * `new NavMeshQuery(navMesh)`: its default node pool and search box and the
 * include-all filter, which every arm ends with because the wrapper's
 * constructor is what every arm calls. The prefix is the arm's own failure
 * spelling.
 */
void install_query(NavigationMeshState& state, dtNavMesh* nav_mesh,
                   const NavQueryDefaults& defaults, const std::string& failure_prefix) {
    RecastOwner<dtNavMeshQuery> query{dtAllocNavMeshQuery(), dtFreeNavMeshQuery};
    if (!query || dtStatusFailed(query->init(nav_mesh, static_cast<int>(defaults.max_nodes)))) {
        throw std::runtime_error(failure_prefix + "Failed to initialize navmesh query");
    }
    state.query = std::move(query);
    state.filter = include_all_filter();
    for (std::size_t axis = 0; axis < 3; ++axis) {
        state.query_half_extents[axis] = static_cast<float>(defaults.half_extents[axis]);
    }
    state.path_max_polys = static_cast<int>(defaults.max_path_polys);
    state.straight_path_max_points = static_cast<int>(defaults.max_straight_path_points);
    state.straight_path_options = static_cast<int>(defaults.straight_path_options);
}

#if BBLITE_HAS_NAV_TILE_CACHE
/** The plan's `dtTileCacheParams`, as `DetourTileCacheParams.create` filled it. */
dtTileCacheParams tile_cache_params(const NavTileCacheParams& from) {
    static_assert(sizeof(dtTileCacheParams) == sizeof(NavTileCacheParams),
                  "dtTileCacheParams holds a field NavTileCacheParams does not mirror");
    dtTileCacheParams params{};
    mirror(params.orig, from.orig);
    mirror(params.cs, from.cs);
    mirror(params.ch, from.ch);
    mirror(params.width, from.width);
    mirror(params.height, from.height);
    mirror(params.walkableHeight, from.walkableHeight);
    mirror(params.walkableRadius, from.walkableRadius);
    mirror(params.walkableClimb, from.walkableClimb);
    mirror(params.maxSimplificationError, from.maxSimplificationError);
    mirror(params.maxTiles, from.maxTiles);
    mirror(params.maxObstacles, from.maxObstacles);
    return params;
}

/** The plan's `dtNavMeshParams`, as `NavMeshParams.create` filled it. */
dtNavMeshParams nav_mesh_params(const NavTiledMeshParams& from) {
    static_assert(sizeof(dtNavMeshParams) == sizeof(NavTiledMeshParams),
                  "dtNavMeshParams holds a field NavTiledMeshParams does not mirror");
    dtNavMeshParams params{};
    mirror(params.orig, from.orig);
    mirror(params.tileWidth, from.tileWidth);
    mirror(params.tileHeight, from.tileHeight);
    mirror(params.maxTiles, from.maxTiles);
    mirror(params.maxPolys, from.maxPolys);
    return params;
}
#endif

} // namespace

NavigationHandle navigation_create_plugin() {
    auto state = std::make_shared<NavigationPluginState>();
    return NavigationHandle{state->identity, std::move(state)};
}

NavGridSize navigation_grid_size(const NavBounds& bounds, float cs) {
    const RecastBounds recast = recast_bounds(bounds);
    NavGridSize grid;
    rcCalcGridSize(recast.min, recast.max, cs, &grid.width, &grid.height);
    return grid;
}

void navigation_create_solo_nav_mesh(NavigationHandle plugin, const NavMeshGeometry& geometry,
                                     const NavSoloBuild& build, const NavQueryDefaults& defaults) {
    (void)plugin_state(plugin);
    auto built = std::make_shared<NavigationMeshState>();
    NavigationMeshState& state = *built;

    const RecastInputMesh input = prepare_input(geometry);
    const float* vertices = input.vertices;
    const int vertex_count = input.vertex_count;
    const int triangle_count = input.triangle_count;
    const std::vector<int>& triangles = input.triangles;
    const rcConfig config = recast_config(build.config);
    const RecastBounds bounds = recast_bounds(build.bounds);

    rcContext context(false);
    const auto fail = [](const std::string& message) -> void {
        throw std::runtime_error("createNavMesh failed: " + message);
    };

    RecastOwner<rcHeightfield> heightfield{rcAllocHeightfield(), rcFreeHeightField};
    if (!heightfield || !rcCreateHeightfield(&context, *heightfield, config.width, config.height,
                                             bounds.min, bounds.max, config.cs, config.ch)) {
        fail("Could not create heightfield");
    }

    std::vector<unsigned char> triangle_areas(static_cast<std::size_t>(triangle_count), 0);
    rcMarkWalkableTriangles(&context, config.walkableSlopeAngle, vertices, vertex_count,
                            triangles.data(), triangle_count, triangle_areas.data());
    if (!rcRasterizeTriangles(&context, vertices, vertex_count, triangles.data(),
                              triangle_areas.data(), triangle_count, *heightfield,
                              config.walkableClimb)) {
        fail("Could not rasterize triangles");
    }

    rcFilterLowHangingWalkableObstacles(&context, config.walkableClimb, *heightfield);
    rcFilterLedgeSpans(&context, config.walkableHeight, config.walkableClimb, *heightfield);
    rcFilterWalkableLowHeightSpans(&context, config.walkableHeight, *heightfield);

    RecastOwner<rcCompactHeightfield> compact{rcAllocCompactHeightfield(),
                                              rcFreeCompactHeightfield};
    if (!compact || !rcBuildCompactHeightfield(&context, config.walkableHeight,
                                               config.walkableClimb, *heightfield, *compact)) {
        fail("Failed to build compact data");
    }
    heightfield.reset();

    if (!rcErodeWalkableArea(&context, config.walkableRadius, *compact)) {
        fail("Failed to erode walkable area");
    }
    if (!rcBuildDistanceField(&context, *compact)) {
        fail("Failed to build distance field");
    }
    if (!rcBuildRegions(&context, *compact, config.borderSize, config.minRegionArea,
                        config.mergeRegionArea)) {
        fail("Failed to build regions");
    }

    RecastOwner<rcContourSet> contours{rcAllocContourSet(), rcFreeContourSet};
    if (!contours || !rcBuildContours(&context, *compact, config.maxSimplificationError,
                                      config.maxEdgeLen, *contours, RC_CONTOUR_TESS_WALL_EDGES)) {
        fail("Failed to create contours");
    }

    RecastOwner<rcPolyMesh> poly_mesh{rcAllocPolyMesh(), rcFreePolyMesh};
    if (!poly_mesh || !rcBuildPolyMesh(&context, *contours, config.maxVertsPerPoly, *poly_mesh)) {
        fail("Failed to triangulate contours");
    }

    RecastOwner<rcPolyMeshDetail> detail_mesh{rcAllocPolyMeshDetail(), rcFreePolyMeshDetail};
    if (!detail_mesh ||
        !rcBuildPolyMeshDetail(&context, *poly_mesh, *compact, config.detailSampleDist,
                               config.detailSampleMaxError, *detail_mesh)) {
        fail("Failed to build detail mesh");
    }
    compact.reset();
    contours.reset();

    // The generator's area/flag normalization, generated from the package;
    // its `Recast.RC_WALKABLE_AREA` is the glue's name for the library's own.
    bbl::upstream::solo_nav_mesh_poly_areas_and_flags(poly_mesh.get(), RC_WALKABLE_AREA);

    dtNavMeshCreateParams create_params{};
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
    rcVcopy(create_params.bmin, poly_mesh->bmin);
    rcVcopy(create_params.bmax, poly_mesh->bmax);
    // The scalars the generator sets through the wrapper's setters.
    mirror(create_params.walkableHeight, build.create.walkableHeight);
    mirror(create_params.walkableRadius, build.create.walkableRadius);
    mirror(create_params.walkableClimb, build.create.walkableClimb);
    mirror(create_params.cs, build.create.cs);
    mirror(create_params.ch, build.create.ch);
    mirror(create_params.buildBvTree, build.create.buildBvTree);

    // The generated `setOffMeshConnections` packing, copied into the typed
    // arrays the glue's `DetourNavMeshBuilder.setOffMeshConnections` takes.
    // The vectors outlive `dtCreateNavMeshData` below, which copies them.
    const NavOffMeshPacking& packing = build.create.offMeshConnections;
    const auto off_mesh_verts = typed_array<float>(packing.verts);
    const auto off_mesh_radii = typed_array<float>(packing.rads);
    const auto off_mesh_dir = typed_array<unsigned char>(packing.dirs);
    const auto off_mesh_areas = typed_array<unsigned char>(packing.areas);
    const auto off_mesh_flags = typed_array<unsigned short>(packing.flags);
    const auto off_mesh_user_ids = typed_array<unsigned int>(packing.userIds);
    if (packing.count > 0.0) {
        create_params.offMeshConVerts = off_mesh_verts.data();
        create_params.offMeshConRad = off_mesh_radii.data();
        create_params.offMeshConDir = off_mesh_dir.data();
        create_params.offMeshConAreas = off_mesh_areas.data();
        create_params.offMeshConFlags = off_mesh_flags.data();
        create_params.offMeshConUserID = off_mesh_user_ids.data();
        create_params.offMeshConCount = bbl::js::NumberArgument{packing.count};
    }

    unsigned char* nav_data = nullptr;
    int nav_data_size = 0;
    if (!dtCreateNavMeshData(&create_params, &nav_data, &nav_data_size)) {
        fail("Failed to create Detour navmesh data");
    }
    poly_mesh.reset();
    detail_mesh.reset();

    state.nav_mesh.reset(dtAllocNavMesh());
    dtNavMesh* nav_mesh = state.nav_mesh.get();
    if (!nav_mesh || dtStatusFailed(nav_mesh->init(nav_data, nav_data_size, DT_TILE_FREE_DATA))) {
        dtFree(nav_data);
        throw std::runtime_error("createNavMesh failed: Failed to initialize solo NavMesh");
    }
    install_query(state, nav_mesh, defaults, "createNavMesh failed: ");
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
 *
 * `tile_config` is the plan's clone for this tile. The wrapper hands Recast
 * the tile's bounds three times -- as the clone's `bmin`/`bmax`, as the
 * heightfield's bounds and as the chunk-query rect -- and each is the same
 * JavaScript numbers rounded into float storage, so all three read the
 * clone's.
 */
std::vector<TileCacheLayer>
rasterize_tile_layers(rcContext* context, const rcConfig& config, const rcConfig& tile_config,
                      const float* vertices, int vertex_count, const rcChunkyTriMesh& chunky,
                      std::vector<int>& chunk_ids, dtTileCacheCompressor* compressor, int tile_x,
                      int tile_y) {
    HeightfieldOwner heightfield{rcAllocHeightfield(),
                                 [](rcHeightfield* v) { rcFreeHeightField(v); }};
    if (!heightfield ||
        !rcCreateHeightfield(context, *heightfield, tile_config.width, tile_config.height,
                             tile_config.bmin, tile_config.bmax, tile_config.cs, tile_config.ch)) {
        return {};
    }

    // The chunky mesh partitions the triangle list, so the chunks a
    // rect overlaps carry each triangle at most once -- which is why
    // rasterizing them in turn gives the heightfield one pass over the
    // whole list would, at a fraction of the work.
    // The RecastDemo sample takes the rect as mutable arrays it only reads.
    float rect_min[2] = {tile_config.bmin[0], tile_config.bmin[2]};
    float rect_max[2] = {tile_config.bmax[0], tile_config.bmax[2]};
    const int overlapping = rcGetChunksOverlappingRect(
        &chunky, rect_min, rect_max, chunk_ids.data(), static_cast<int>(chunk_ids.size()));
    if (overlapping == 0)
        return {};
    for (int chunk = 0; chunk < overlapping; ++chunk) {
        const rcChunkyTriMeshNode& node = chunky.nodes[chunk_ids[static_cast<std::size_t>(chunk)]];
        const int* node_triangles = &chunky.tris[node.i * 3];
        std::vector<unsigned char> areas(static_cast<std::size_t>(node.n), 0);
        rcMarkWalkableTriangles(context, tile_config.walkableSlopeAngle, vertices, vertex_count,
                                node_triangles, node.n, areas.data());
        if (!rcRasterizeTriangles(context, vertices, vertex_count, node_triangles, areas.data(),
                                  node.n, *heightfield, tile_config.walkableClimb)) {
            return {};
        }
    }

    rcFilterLowHangingWalkableObstacles(context, config.walkableClimb, *heightfield);
    rcFilterLedgeSpans(context, config.walkableHeight, config.walkableClimb, *heightfield);
    rcFilterWalkableLowHeightSpans(context, config.walkableHeight, *heightfield);

    CompactHeightfieldOwner compact{rcAllocCompactHeightfield(),
                                    [](rcCompactHeightfield* v) { rcFreeCompactHeightfield(v); }};
    if (!compact || !rcBuildCompactHeightfield(context, config.walkableHeight, config.walkableClimb,
                                               *heightfield, *compact)) {
        return {};
    }
    heightfield.reset();
    if (!rcErodeWalkableArea(context, config.walkableRadius, *compact)) {
        return {};
    }

    HeightfieldLayerSetOwner layers{rcAllocHeightfieldLayerSet(),
                                    [](rcHeightfieldLayerSet* v) { rcFreeHeightfieldLayerSet(v); }};
    if (!layers || !rcBuildHeightfieldLayers(context, *compact, config.borderSize,
                                             config.walkableHeight, *layers)) {
        return {};
    }

    std::vector<TileCacheLayer> tiles;
    for (int index = 0; index < layers->nlayers; ++index) {
        const rcHeightfieldLayer& layer = layers->layers[index];
        dtTileCacheLayerHeader header{};
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
        if (dtStatusFailed(status))
            return {};
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
void navigation_create_tile_cache_nav_mesh(NavigationHandle plugin, const NavMeshGeometry& geometry,
                                           const NavTileCacheBuild& build,
                                           const NavQueryDefaults& defaults) {
    (void)plugin_state(plugin);
    auto built = std::make_shared<NavigationMeshState>();
    NavigationMeshState& state = *built;

    const RecastInputMesh input = prepare_input(geometry);
    const rcConfig config = recast_config(build.config);
    const dtTileCacheParams cache_params = tile_cache_params(build.cache);
    const dtNavMeshParams nav_params = nav_mesh_params(build.mesh);
    // The tile grid is the plan's JavaScript numbers, which count whole tiles.
    const int tile_width = static_cast<int>(build.tiles.width);
    const int tile_height = static_cast<int>(build.tiles.height);

    const auto fail = [](const std::string& message) -> void {
        throw std::runtime_error("createNavMesh (tile cache) failed: " + message);
    };

    // The three the cache borrows for the life of the plugin: the plan's
    // bump allocator, the FastLZ codec, and the mesh process
    // `createDefaultTileCacheMeshProcess` installs -- area 0 and flag 1 on
    // every polygon, which is the same normalization the solo arm applies
    // to its poly mesh.
    state.allocator = std::make_unique<TileCacheLinearAllocator>(
        static_cast<std::size_t>(build.linear_allocator_capacity));
    state.compressor = std::make_unique<TileCacheFastLzCompressor>();
    state.mesh_process = std::make_unique<TileCacheDefaultMeshProcess>();

    TileCacheOwner tile_cache{dtAllocTileCache(), [](dtTileCache* v) { dtFreeTileCache(v); }};
    if (!tile_cache ||
        dtStatusFailed(tile_cache->init(&cache_params, state.allocator.get(),
                                        state.compressor.get(), state.mesh_process.get()))) {
        fail("Failed to initialize tile cache");
    }

    state.nav_mesh.reset(dtAllocNavMesh());
    dtNavMesh* nav_mesh = state.nav_mesh.get();
    if (!nav_mesh || dtStatusFailed(nav_mesh->init(&nav_params))) {
        fail("Failed to initialize tiled navmesh");
    }

    rcChunkyTriMesh chunky_mesh;
    if (!rcCreateChunkyTriMesh(input.vertices, input.triangles.data(), input.triangle_count,
                               static_cast<int>(build.tris_per_chunk), &chunky_mesh)) {
        fail("Failed to build chunky triangle mesh");
    }

    rcContext context(false);
    std::vector<int> chunk_ids(static_cast<std::size_t>(build.max_chunk_ids), 0);

    // Two passes, the wrapper's own: every tile's layers into the cache
    // first, then every tile's initial mesh out of it. They cannot merge,
    // because a tile's mesh is built against neighbours the first pass may
    // not have added yet.
    for (int y = 0; y < tile_height; ++y) {
        for (int x = 0; x < tile_width; ++x) {
            const rcConfig tile_config = recast_config(build.tile_config(
                build.config, build.bounds, static_cast<double>(x), static_cast<double>(y)));
            for (TileCacheLayer& layer : rasterize_tile_layers(
                     &context, config, tile_config, input.vertices, input.vertex_count, chunky_mesh,
                     chunk_ids, state.compressor.get(), x, y)) {
                // A refused add is a warning upstream, not a failure: the
                // cache is full and the tiles it already holds still make
                // a navmesh. The data is the cache's on success and ours
                // on failure, which is what the reference frees.
                if (dtStatusSucceed(tile_cache->addTile(layer.data.get(), layer.size,
                                                        DT_COMPRESSEDTILE_FREE_DATA, nullptr))) {
                    (void)layer.data.release();
                }
            }
        }
    }
    for (int y = 0; y < tile_height; ++y) {
        for (int x = 0; x < tile_width; ++x) {
            if (dtStatusFailed(tile_cache->buildNavMeshTilesAt(x, y, nav_mesh))) {
                fail("Failed to build nav mesh tiles at " + std::to_string(x) + ", " +
                     std::to_string(y));
            }
        }
    }
    state.tile_cache = std::move(tile_cache);
    install_query(state, nav_mesh, defaults, "createNavMesh (tile cache) failed: ");
    plugin.ownership->mesh = std::move(built);
}

/** The cache's own drain, on a state the caller already resolved. */
void drain_obstacle_requests(NavigationMeshState& state) {
    bool up_to_date = false;
    while (!up_to_date) {
        state.tile_cache->update(0.0f, state.nav_mesh.get(), &up_to_date);
    }
}

std::optional<NavObstacleHandle> navigation_add_box_obstacle(NavigationHandle plugin,
                                                             NavVec3 position, NavVec3 half_extents,
                                                             float angle) {
    NavigationMeshState& state = tile_cache_state(plugin);
    const float centre[3] = {position.x, position.y, position.z};
    const float half[3] = {half_extents.x, half_extents.y, half_extents.z};
    dtObstacleRef reference = 0;
    if (dtStatusFailed(state.tile_cache->addBoxObstacle(centre, half, angle, &reference))) {
        return std::nullopt;
    }
    drain_obstacle_requests(state);
    return NavObstacleHandle{static_cast<std::uint32_t>(reference), plugin.ownership->mesh};
}

std::optional<NavObstacleHandle> navigation_add_cylinder_obstacle(NavigationHandle plugin,
                                                                  NavVec3 position, float radius,
                                                                  float height) {
    NavigationMeshState& state = tile_cache_state(plugin);
    const float centre[3] = {position.x, position.y, position.z};
    dtObstacleRef reference = 0;
    if (dtStatusFailed(state.tile_cache->addObstacle(centre, radius, height, &reference))) {
        return std::nullopt;
    }
    drain_obstacle_requests(state);
    return NavObstacleHandle{static_cast<std::uint32_t>(reference), plugin.ownership->mesh};
}

void navigation_remove_obstacle(NavigationHandle plugin, NavObstacleHandle obstacle) {
    NavigationMeshState& state = tile_cache_state(plugin);
    if (obstacle.value && obstacle.owner.lock().get() != &state) {
        throw std::runtime_error("Navigation obstacle belongs to a different or replaced navmesh.");
    }
    state.tile_cache->removeObstacle(static_cast<dtObstacleRef>(obstacle.value));
    drain_obstacle_requests(state);
}

void navigation_update_obstacles(NavigationHandle plugin) {
    drain_obstacle_requests(tile_cache_state(plugin));
}

#endif

bool navigation_has_nav_mesh(NavigationHandle plugin) {
    return plugin_state(plugin).nav_mesh != nullptr;
}

NavMeshPositionsAndIndices navigation_positions_and_indices(NavigationHandle plugin) {
    NavigationMeshState& state = plugin_state(plugin);
    if (!state.nav_mesh) {
        throw std::runtime_error("No navmesh generated. Call createNavMesh first.");
    }
    return bbl::upstream::get_nav_mesh_positions_and_indices(state.nav_mesh.get());
}

NavRaycastHit navigation_raycast(NavigationHandle plugin, float start_x, float start_y,
                                 float start_z, float end_x, float end_y, float end_z) {
    NavigationMeshState& state = plugin_state(plugin);
    if (!state.nav_mesh || !state.query) {
        throw std::runtime_error("No navmesh generated. Call createNavMesh first.");
    }
    const float start[3] = {start_x, start_y, start_z};
    const float end[3] = {end_x, end_y, end_z};

    dtPolyRef nearest_ref = 0;
    float nearest_point[3] = {0.0f, 0.0f, 0.0f};
    const dtStatus nearest_status = state.query->findNearestPoly(
        start, state.query_half_extents, &state.filter, &nearest_ref, nearest_point);
    if (dtStatusFailed(nearest_status) || nearest_ref == 0) {
        return NavRaycastHit{};
    }

    // Zeroed wholesale: a null path buffer with maxPath 0 asks Detour
    // for the t and normal only, the way the wrapper's raycast does.
    dtRaycastHit ray_hit{};
    state.query->raycast(nearest_ref, start, end, &state.filter, 0, &ray_hit, 0);
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
NavVec3 navigation_closest_point(NavigationHandle plugin, float x, float y, float z) {
    NavigationMeshState& state = plugin_state(plugin);
    if (!state.nav_mesh || !state.query) {
        throw std::runtime_error("No navmesh generated. Call createNavMesh first.");
    }
    const float position[3] = {x, y, z};
    dtPolyRef poly_ref = 0;
    const dtStatus nearest_status = state.query->findNearestPoly(position, state.query_half_extents,
                                                                 &state.filter, &poly_ref, nullptr);
    if (dtStatusFailed(nearest_status)) {
        return NavVec3{};
    }
    NavVec3 point{};
    bool over_poly = false;
    state.query->closestPointOnPoly(poly_ref, position, &point.x, &over_poly);
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
std::vector<NavVec3> navigation_compute_path(NavigationHandle plugin, NavVec3 start, NavVec3 end) {
    NavigationMeshState& state = plugin_state(plugin);
    if (!state.nav_mesh || !state.query) {
        throw std::runtime_error("No navmesh generated. Call createNavMesh first.");
    }
    const float start_position[3] = {start.x, start.y, start.z};
    const float end_position[3] = {end.x, end.y, end.z};

    dtPolyRef start_ref = 0;
    dtPolyRef end_ref = 0;
    if (dtStatusFailed(state.query->findNearestPoly(start_position, state.query_half_extents,
                                                    &state.filter, &start_ref, nullptr)) ||
        dtStatusFailed(state.query->findNearestPoly(end_position, state.query_half_extents,
                                                    &state.filter, &end_ref, nullptr))) {
        return {};
    }

    // The capacities `computePath` runs with when handed no options, which
    // the pinned module's call is.
    std::vector<dtPolyRef> polys(static_cast<std::size_t>(state.path_max_polys));
    int poly_count = 0;
    if (dtStatusFailed(state.query->findPath(start_ref, end_ref, start_position, end_position,
                                             &state.filter, polys.data(), &poly_count,
                                             state.path_max_polys)) ||
        poly_count <= 0) {
        return {};
    }

    float straight_end[3] = {end.x, end.y, end.z};
    const dtPolyRef last_poly = polys[static_cast<std::size_t>(poly_count - 1)];
    if (last_poly != end_ref) {
        bool over_poly = false;
        if (dtStatusFailed(state.query->closestPointOnPoly(last_poly, end_position, straight_end,
                                                           &over_poly))) {
            return {};
        }
    }

    std::vector<float> straight(static_cast<std::size_t>(state.straight_path_max_points) * 3);
    int straight_count = 0;
    // The flag and polygon-reference outputs are `[opt]` in Detour's own
    // header and nothing here reads them; the wrapper allocates both only
    // because its binding hands back buffers it then destroys.
    if (dtStatusFailed(state.query->findStraightPath(
            start_position, straight_end, polys.data(), poly_count, straight.data(), nullptr,
            nullptr, &straight_count, state.straight_path_max_points,
            state.straight_path_options))) {
        return {};
    }

    std::vector<NavVec3> path;
    path.reserve(static_cast<std::size_t>(straight_count));
    for (int index = 0; index < straight_count; ++index) {
        const std::size_t base = static_cast<std::size_t>(index) * 3;
        path.push_back(NavVec3{straight[base], straight[base + 1], straight[base + 2]});
    }
    return path;
}

// new Crowd(navMesh, { maxAgents, maxAgentRadius }): allocCrowd then
// init over the plugin's navmesh. dtCrowd builds its own query and
// filters; the wrapper changes neither.
#if BBLITE_HAS_NAV_CROWD
NavCrowdHandle navigation_create_crowd(NavigationHandle plugin, int max_agents,
                                       float max_agent_radius) {
    NavigationMeshState& state = plugin_state(plugin);
    if (!state.nav_mesh) {
        throw std::runtime_error("No navmesh generated. Call createNavMesh first.");
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
int navigation_add_agent(NavCrowdHandle crowd, float x, float y, float z,
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
std::optional<NavVec3> navigation_agent_position(NavCrowdHandle crowd, int index) {
    const dtCrowdAgent* agent = crowd_state(crowd).crowd->getAgent(index);
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
// wrapper builds its navMeshQuery from, at the same default half-extents
// and an include-all filter.
//
// Absence is REPORTED, not decided: the pin's `?.` is Babylon behaviour
// and belongs beside `get_agent_position`'s, in generated code.
bool navigation_agent_goto(NavCrowdHandle crowd, int index, NavVec3 destination) {
    NavCrowdState& state = crowd_state(crowd);
    const dtCrowdAgent* agent = state.crowd->getAgent(index);
    if (!agent || !agent->active) {
        return false;
    }
    const dtNavMeshQuery* query = state.crowd->getNavMeshQuery();
    const dtQueryFilter filter = include_all_filter();
    const float position[3] = {destination.x, destination.y, destination.z};
    dtPolyRef nearest_ref = 0;
    float nearest_point[3] = {0.0f, 0.0f, 0.0f};
    if (dtStatusFailed(query->findNearestPoly(position, state.mesh->query_half_extents, &filter,
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
