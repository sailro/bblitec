// A28: inject failures inside the real pinned Recast/Detour implementation.
#include "pal_navigation_recast.cpp"
#include <RecastAlloc.h>
#include <DetourNode.h>
#include <cstdio>
#include <cstdlib>
#include <unordered_set>

#ifdef BBLITE_NAV_OOM_TRACE
#include <Windows.h>
#include <DbgHelp.h>
#endif

namespace {
std::unordered_set<void*> allocations;
unsigned allocation_count = 0;
unsigned fail_at = 0;
bool injected = false;

void* allocate(std::size_t bytes) {
    if (++allocation_count == fail_at) {
        injected = true;
#ifdef BBLITE_NAV_OOM_TRACE
        std::fprintf(stderr, "failed allocation: %zu bytes\n", bytes);
        void* frames[32];
        const auto count = CaptureStackBackTrace(0, 32, frames, nullptr);
        const auto process = GetCurrentProcess();
        SymInitialize(process, nullptr, TRUE);
        for (unsigned i = 0; i < count; ++i) {
            alignas(SYMBOL_INFO) char storage[sizeof(SYMBOL_INFO) + MAX_SYM_NAME]{};
            auto* symbol = reinterpret_cast<SYMBOL_INFO*>(storage);
            symbol->SizeOfStruct = sizeof(SYMBOL_INFO);
            symbol->MaxNameLen = MAX_SYM_NAME;
            DWORD64 displacement = 0;
            if (SymFromAddr(process, reinterpret_cast<DWORD64>(frames[i]), &displacement, symbol)) {
                std::fprintf(stderr, "%s + %llu\n", symbol->Name, displacement);
            }
        }
        SymCleanup(process);
#endif
        return nullptr;
    }
    void* pointer = std::malloc(bytes);
    if (pointer) {
        std::memset(pointer, 0xa5, bytes);
        allocations.insert(pointer);
    }
    return pointer;
}

void release(void* pointer) {
    if (!pointer) return;
    if (allocations.erase(pointer) != 1) std::abort();
    std::free(pointer);
}

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

template <typename Operation>
void expect_bad_alloc(unsigned failure, const Operation& operation) {
    allocation_count = 0;
    fail_at = failure;
    injected = false;
    bool refused = false;
    try { operation(); }
    catch (const std::bad_alloc&) { refused = true; }
    fail_at = 0;
    require(injected && refused, "unchecked vector operation accepted allocation failure");
}

void check_vector_growth() {
    rcTempVector<int> values;
    values.push_back(7);
    const auto retained = allocations;
    const auto check = [&](auto operation) {
        expect_bad_alloc(1, operation);
        require(values.size() == 1 && values[0] == 7, "failed growth corrupted the existing vector");
        require(allocations == retained, "failed vector growth leaked storage");
    };
    check([&] { values.push_back(values[0]); });
    check([&] { values.resize(64, values[0]); });
    check([&] { values.resize(64); });
    allocation_count = 0;
    fail_at = 1;
    require(!values.reserve(64), "reserve did not report allocation failure");
    fail_at = 0;
    require(values.size() == 1 && values[0] == 7, "failed reserve changed the vector");
    require(allocations == retained, "failed reserve leaked storage");
    values.push_back(values[0]);
    require(values.size() == 2 && values[1] == 7, "vector could not grow after failure");
}

struct AllocatingValue {
    rcTempVector<int> payload{2, 7};
};

void check_vector_contents(const rcTempVector<AllocatingValue>& values, rcSizeType size) {
    require(values.size() == size, "failed element construction changed vector size");
    for (const auto& value : values) {
        require(value.payload.size() == 2 && value.payload[0] == 7 && value.payload[1] == 7,
            "failed element construction corrupted a retained value");
    }
}

void check_vector_copy_failures() {
    const AllocatingValue seed;
    const auto check = [&](bool spare_capacity, unsigned failures, rcSizeType final_size, const auto& operation) {
        for (unsigned failure = 1; failure <= failures; ++failure) {
            rcTempVector<AllocatingValue> values(2, seed);
            if (spare_capacity) require(values.reserve(8), "could not reserve fixture storage");
            const auto* original = values.data();
            const auto capacity = values.capacity();
            const auto before = allocations;
            expect_bad_alloc(failure, [&] { operation(values); });
            check_vector_contents(values, 2);
            require(values.data() == original && values.capacity() == capacity, "failed growth replaced vector storage");
            require(allocations == before, "failed nested vector growth leaked storage");
            operation(values);
            check_vector_contents(values, final_size);
        }
    };
    check(false, 4, 3, [](auto& values) { values.push_back(values[0]); });
    check(true, 1, 3, [](auto& values) { values.push_back(values[0]); });
    check(false, 6, 5, [](auto& values) { values.resize(5, values[0]); });
    check(true, 3, 5, [](auto& values) { values.resize(5, values[0]); });
    check(false, 6, 5, [](auto& values) { values.resize(5); });
    check(true, 3, 5, [](auto& values) { values.resize(5); });

    for (unsigned failure = 1; failure <= 3; ++failure) {
        rcTempVector<AllocatingValue> values(2, seed);
        const auto before = allocations;
        allocation_count = 0;
        fail_at = failure;
        injected = false;
        const bool reserved = values.reserve(8);
        fail_at = 0;
        require(injected && !reserved, "reserve did not report nested allocation failure");
        check_vector_contents(values, 2);
        require(allocations == before, "failed nested reserve leaked storage");
        require(values.reserve(8), "reserve could not recover after failure");
        check_vector_contents(values, 2);
    }

    const rcTempVector<AllocatingValue> source(3, seed);
    check(false, 4, 3, [&](auto& values) { values.assign(source.begin(), source.end()); });
    const auto check_constructor = [&](unsigned failures, const auto& construct) {
        for (unsigned failure = 1; failure <= failures; ++failure) {
            const auto before = allocations;
            expect_bad_alloc(failure, construct);
            require(allocations == before, "failed vector constructor leaked storage");
            construct();
        }
    };
    check_constructor(4, [&] { const rcTempVector<AllocatingValue> copy(source); check_vector_contents(copy, 3); });
    check_constructor(4, [&] { const rcTempVector<AllocatingValue> copy(source.begin(), source.end()); check_vector_contents(copy, 3); });
    check_constructor(4, [&] { const rcTempVector<AllocatingValue> values(3, seed); check_vector_contents(values, 3); });
    check_constructor(4, [] { const rcTempVector<AllocatingValue> values(3); check_vector_contents(values, 3); });

    // Reusing assignment storage has a basic guarantee: failure leaves it
    // empty and destructible, rather than retaining the replaced elements.
    for (unsigned failure = 1; failure <= 3; ++failure) {
        rcTempVector<AllocatingValue> values;
        require(values.reserve(3), "could not reserve assignment storage");
        const auto before = allocations;
        values.resize(2, seed);
        expect_bad_alloc(failure, [&] { values.assign(source.begin(), source.end()); });
        require(values.empty() && allocations == before, "failed in-place assignment retained partial elements");
        values.assign(source.begin(), source.end());
        check_vector_contents(values, 3);
    }
}

void check_query(dtNavMeshQuery& query) {
    const dtQueryFilter filter;
    const float start[3] = {-8, 0, -8}, end[3] = {8, 0, 8}, extents[3] = {1, 1, 1};
    float nearest_start[3]{}, nearest_end[3]{};
    dtPolyRef start_ref = 0, end_ref = 0;
    require(dtStatusSucceed(query.findNearestPoly(start, extents, &filter, &start_ref, nearest_start)) && start_ref,
        "reinitialized query lost the start polygon");
    require(dtStatusSucceed(query.findNearestPoly(end, extents, &filter, &end_ref, nearest_end)) && end_ref,
        "reinitialized query lost the end polygon");
    dtPolyRef path[32]{};
    int count = 0;
    require(dtStatusSucceed(query.findPath(start_ref, end_ref, nearest_start, nearest_end, &filter, path, &count, 32))
        && count > 0 && path[count - 1] == end_ref, "reinitialized query could not find a complete path");
    float reached[3]{};
    require(dtStatusSucceed(query.moveAlongSurface(start_ref, nearest_start, nearest_end, &filter, reached, path, &count, 32))
        && count > 0, "reinitialized query lost its tiny node pool");
}

void check_invalid_query_init(dtNavMeshQuery& query, const dtNavMesh* mesh) {
    const auto before = allocations;
    const auto attempts = allocation_count;
    const auto* attached = query.getAttachedNavMesh();
    const auto* pool = query.getNodePool();
    const int nodes_before = pool ? pool->getNodeCount() : 0;
    const auto check = [&](const dtNavMesh* candidate, int nodes) {
        require(query.init(candidate, nodes) == (DT_FAILURE | DT_INVALID_PARAM), "query accepted invalid reinitialization");
        require(query.getAttachedNavMesh() == attached && query.getNodePool() == pool && allocations == before
            && allocation_count == attempts && (!pool || pool->getNodeCount() == nodes_before),
            "invalid query reinitialization changed existing ownership");
    };
    check(nullptr, 32);
    for (const int nodes : {0, -1, static_cast<int>(DT_NULL_IDX) + 1, 1 << DT_NODE_PARENT_BITS}) check(mesh, nodes);
}

void check_query_reinitialization(const dtNavMesh* mesh) {
    const auto before = allocations;
    {
        dtNavMeshQuery query;
        check_invalid_query_init(query, mesh);
        require(dtStatusSucceed(query.init(mesh, 32)), "could not initialize the query fixture");
        check_query(query);
        check_invalid_query_init(query, mesh);
        check_query(query);
    }
    require(allocations == before, "invalid query initialization leaked storage");
    for (const bool growing : {false, true}) {
        const unsigned sites = growing ? 6 : 10;
        for (unsigned failure = 1; failure <= sites; ++failure) {
            {
                dtNavMeshQuery query;
                if (growing) require(dtStatusSucceed(query.init(mesh, 32)), "could not initialize the smaller query");
                allocation_count = 0;
                fail_at = failure;
                injected = false;
                const int nodes = growing ? 128 : 32;
                const auto status = query.init(mesh, nodes);
                fail_at = 0;
                require(injected && status == (DT_FAILURE | DT_OUT_OF_MEMORY), "query did not report allocation failure");
                check_invalid_query_init(query, mesh);
                require(dtStatusSucceed(query.init(mesh, nodes)), "query could not retry after allocation failure");
                check_query(query);
            }
            require(allocations == before, "failed query reinitialization leaked storage");
        }
    }
    for (const int nodes : {1, 2, 3}) {
        {
            dtNavMeshQuery query;
            require(dtStatusSucceed(query.init(mesh, nodes)), "query rejected a valid small node limit");
            auto* pool = query.getNodePool();
            require(pool && pool->getHashSize() > 0 && pool->getNode(1), "small query has no usable hash bucket");
        }
        require(allocations == before, "small query initialization leaked storage");
    }
    std::puts("query-reinitialization-check: ok (10 initial, 6 growing allocation sites)");
}
}

int main(int argc, char** argv) try {
    using namespace bbl::pal;
    rcAllocSetCustom([](std::size_t size, rcAllocHint) { return allocate(size); }, release);
    dtAllocSetCustom([](std::size_t size, dtAllocHint) { return allocate(size); }, release);
    const std::string selection = argc > 1 ? argv[1] : "";
    if (selection.empty() || selection == "vectors") {
        check_vector_growth();
        check_vector_copy_failures();
    }
    require(allocations.empty(), "vector teardown leaked storage");
    if (selection.empty() || selection == "vectors") std::puts("vector-allocation-check: ok");
    if (selection == "vectors") return 0;
    const NavMeshGeometry ground{{-10,0,-10, -10,0,10, 10,0,10, 10,0,-10}, {0,1,2, 0,2,3}};
    const NavMeshBuildParams params{};
    unsigned build_allocations = 0;
    {
        auto plugin = navigation_create_plugin();
        navigation_create_solo_nav_mesh(plugin, ground, params);
        allocation_count = 0;
        navigation_create_solo_nav_mesh(plugin, ground, params);
        build_allocations = allocation_count;
        require(build_allocations == 498, "pinned solo-floor allocation sequence changed");
        if (selection.empty() || selection == "queries") check_query_reinitialization(plugin.ownership->mesh->nav_mesh.get());
        const auto expected = navigation_debug_geometry(plugin);
        std::fprintf(stderr, "solo build: %u allocations\n", build_allocations);
        const unsigned first = selection.empty() || selection == "queries" ? 1 : static_cast<unsigned>(std::stoul(selection));
        const unsigned last = selection == "queries" ? 0 : selection.empty() ? build_allocations : first;
        require(first > 0 && last <= build_allocations, "failure index out of range");
        unsigned refused = 0, recovered = 0;
        for (unsigned failure = first; failure <= last; ++failure) {
            const auto before = allocations;
            const auto original = plugin.ownership->mesh;
            allocation_count = 0;
            fail_at = failure;
            injected = false;
            std::fprintf(stderr, "failure %u\n", failure);
            bool failed = false;
            try { navigation_create_solo_nav_mesh(plugin, ground, params); }
            catch (const std::bad_alloc&) { failed = true; }
            catch (const std::runtime_error& error) {
                require(std::string(error.what()).starts_with("createNavMesh failed:"), "unexpected build exception");
                failed = true;
            }
            fail_at = 0;
            require(injected, "requested failure was not reached");
            if (failure == 25) require(failed, "allocation 25 did not reject the failed DirtyEntry growth");
            // The eight level-stack reserves and the work-stack reserve
            // are the only optional allocation hints in this pinned trace.
            require(failed || (failure >= 16 && failure <= 24), "required allocation failure was not rejected");
            if (failed) require(original == plugin.ownership->mesh, "failed build replaced a valid mesh");
            const auto actual = navigation_debug_geometry(plugin);
            require(actual.positions == expected.positions && actual.normals == expected.normals && actual.indices == expected.indices,
                "allocation failure produced incomplete navigation geometry");
            // A failed reserve is only a capacity hint; a later growth can
            // recover. Release a successful replacement before counting.
            plugin.ownership->mesh = original;
            if (allocations != before) {
                std::fprintf(stderr, "allocation delta: %lld\n", static_cast<long long>(allocations.size()) - static_cast<long long>(before.size()));
                throw std::runtime_error("failed build leaked library allocations");
            }
            require(!navigation_compute_path(plugin, {-2,0,-2}, {2,0,2}).empty(), "failed build invalidated the surviving query");
            if (failed) ++refused;
            else ++recovered;
            std::fprintf(stderr, "result %u: %s\n", failure, failed ? "checked failure" : "capacity hint recovered");
        }
        if (last) std::printf("solo allocation outcomes: %u checked failures, %u recovered capacity hints\n", refused, recovered);
    }
    require(allocations.empty(), "navigation teardown leaked allocations");
    if (selection != "queries") std::printf("navigation-allocation-check: ok (%u allocation sites)\n", build_allocations);
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}
