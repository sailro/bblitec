#include <Recast.h>
#include <RecastAlloc.h>
#include <DetourCrowd.h>
#include <DetourNavMesh.h>
#include <DetourNavMeshQuery.h>
#include <DetourTileCache.h>

namespace {
unsigned boundary_allocations = 0;
unsigned fail_boundary = 0;
template <auto Allocate> auto boundary_allocate() {
    return ++boundary_allocations == fail_boundary ? nullptr : Allocate();
}
}
// Inject at PAL-owned allocation boundaries. Library-internal allocations
// remain real and are counted below, including all objects those owners free.
#define rcAllocHeightfield() boundary_allocate<&rcAllocHeightfield>()
#define rcAllocCompactHeightfield() boundary_allocate<&rcAllocCompactHeightfield>()
#define rcAllocContourSet() boundary_allocate<&rcAllocContourSet>()
#define rcAllocPolyMesh() boundary_allocate<&rcAllocPolyMesh>()
#define rcAllocPolyMeshDetail() boundary_allocate<&rcAllocPolyMeshDetail>()
#define rcAllocHeightfieldLayerSet() boundary_allocate<&rcAllocHeightfieldLayerSet>()
#define dtAllocNavMesh() boundary_allocate<&dtAllocNavMesh>()
#define dtAllocNavMeshQuery() boundary_allocate<&dtAllocNavMeshQuery>()
#define dtAllocCrowd() boundary_allocate<&dtAllocCrowd>()
#define dtAllocTileCache() boundary_allocate<&dtAllocTileCache>()
#include "pal_navigation_recast.cpp"
#undef rcAllocHeightfield
#undef rcAllocCompactHeightfield
#undef rcAllocContourSet
#undef rcAllocPolyMesh
#undef rcAllocPolyMeshDetail
#undef rcAllocHeightfieldLayerSet
#undef dtAllocNavMesh
#undef dtAllocNavMeshQuery
#undef dtAllocCrowd
#undef dtAllocTileCache
#include <cstdio>
#include <cstdlib>
#include <unordered_set>

namespace {
std::unordered_set<void*> allocations;
void* allocate(std::size_t bytes) {
    void* pointer = std::malloc(bytes);
    if (pointer) allocations.insert(pointer);
    return pointer;
}
void release(void* pointer) {
    if (!pointer) return;
    if (!allocations.erase(pointer)) std::abort();
    std::free(pointer);
}
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
}

int main() try {
    using namespace bbl::pal;
    rcAllocSetCustom([](std::size_t size, rcAllocHint) { return allocate(size); }, release);
    dtAllocSetCustom([](std::size_t size, dtAllocHint) { return allocate(size); }, release);
    const NavMeshGeometry ground{{-10,0,-10, -10,0,10, 10,0,10, 10,0,-10}, {0,1,2, 0,2,3}};
    const NavMeshBuildParams params{};
    {
        auto keep = navigation_create_plugin();
        navigation_create_solo_nav_mesh(keep, ground, params);
        const auto stable_count = allocations.size();
        for (int iteration = 0; iteration < 100; ++iteration) {
            std::weak_ptr<NavigationPluginState> weak;
            {
                auto plugin = navigation_create_plugin();
                weak = plugin.ownership;
                navigation_create_solo_nav_mesh(plugin, ground, params);
                auto crowd = navigation_create_crowd(plugin, 4, 0.5f);
                const NavAgentParams agent_params{0.2f,1.8f,8,3,4,8,1,0,0,0};
                const int agent = navigation_add_agent(crowd, 0,0,0, agent_params);
                require(agent >= 0, "crowd could not place its agent");
                plugin = {};
                require(weak.expired(), "plugin leaked through a registry");
                require(navigation_agent_goto(crowd, agent, {2,0,2}), "crowd lost its retained mesh");
                navigation_update_crowd(crowd, 0.1f);
                require(navigation_agent_position(crowd, agent).has_value(), "crowd query lost its mesh");
            }
            require(allocations.size() == stable_count, "completed navigation session retained library allocations");
        }
        require(!navigation_compute_path(keep, {-2,0,-2}, {2,0,2}).empty(), "releasing another plugin invalidated the survivor");
        auto crowd = navigation_create_crowd(keep, 4, 0.5f);
        std::weak_ptr<NavigationMeshState> old_mesh = keep.ownership->mesh;
        navigation_create_solo_nav_mesh(keep, ground, params);
        require(!old_mesh.expired(), "mesh rebuild invalidated an existing crowd");
        navigation_update_crowd(crowd, 0.1f);
        crowd = {};
        require(old_mesh.expired(), "retired mesh survived its final crowd");

        // Fail each PAL allocation in a solo build. A failed replacement
        // must release intermediates and preserve the previous query/mesh.
        boundary_allocations = 0;
        navigation_create_solo_nav_mesh(keep, ground, params);
        const unsigned build_allocations = boundary_allocations;
        for (unsigned failure = 1; failure <= build_allocations; ++failure) {
            const auto before = allocations.size();
            const auto original = keep.ownership->mesh;
            boundary_allocations = 0;
            fail_boundary = failure;
            bool failed = false;
            try { navigation_create_solo_nav_mesh(keep, ground, params); }
            catch (const std::runtime_error&) { failed = true; }
            fail_boundary = 0;
            require(failed, "solo build accepted a failed required allocation");
            require(original == keep.ownership->mesh, "failed build replaced a valid mesh");
            require(allocations.size() == before, "failed solo build leaked an allocation");
        }
        const auto before_crowd = allocations.size();
        boundary_allocations = 0;
        fail_boundary = 1;
        bool crowd_failed = false;
        try { (void)navigation_create_crowd(keep, 4, 0.5f); }
        catch (const std::runtime_error&) { crowd_failed = true; }
        fail_boundary = 0;
        require(crowd_failed && allocations.size() == before_crowd, "failed crowd creation leaked or succeeded");
    }
    require(allocations.empty(), "last plugin did not release all navigation allocations");
    {
        auto plugin = navigation_create_plugin();
        NavMeshBuildParams tile_params;
        tile_params.max_obstacles = 8;
        tile_params.tile_size = 32;
        navigation_create_tile_cache_nav_mesh(plugin, ground, tile_params);
        const auto obstacle = navigation_add_box_obstacle(plugin, {0,0,0}, {1,2,1}, 0);
        navigation_remove_obstacle(plugin, obstacle);
        navigation_create_tile_cache_nav_mesh(plugin, ground, tile_params);
        bool refused = false;
        try { navigation_remove_obstacle(plugin, obstacle); }
        catch (const std::runtime_error&) { refused = true; }
        require(refused, "obstacle from a retired tile cache was accepted");
        boundary_allocations = 0;
        navigation_create_tile_cache_nav_mesh(plugin, ground, tile_params);
        const unsigned build_allocations = boundary_allocations;
        for (unsigned failure = 1; failure <= build_allocations; ++failure) {
            const auto before = allocations.size();
            const auto original = plugin.ownership->mesh;
            boundary_allocations = 0;
            fail_boundary = failure;
            bool failed = false;
            try { navigation_create_tile_cache_nav_mesh(plugin, ground, tile_params); }
            catch (const std::runtime_error&) { failed = true; }
            fail_boundary = 0;
            if (failed) require(original == plugin.ownership->mesh, "failed tile-cache build replaced a valid mesh");
            // The pinned generator skips failed individual tiles. Dispose a
            // successful partial replacement as well as testing failed builds.
            plugin.ownership->mesh = original;
            require(allocations.size() == before, "failed tile-cache build leaked an allocation");
        }
    }
    require(allocations.empty(), "tile-cache teardown leaked navigation allocations");
    std::puts("navigation-lifetime-check: ok");
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}
