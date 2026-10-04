#include <bblite/source_profile.hpp>

#include <cassert>
#include <new>
#include <thread>

namespace {
void allocate(std::size_t bytes) {
    void* memory = ::operator new(bytes);
    static_cast<volatile unsigned char*>(memory)[0] = 7;
    ::operator delete(memory);
}

void assert_empty() {
    for (const auto& totals : bbl::profile::source_thread_records().functions) {
        assert(totals.calls == 0 && totals.total_ticks == 0 && totals.self_ticks == 0);
    }
    const auto& allocations = bbl::profile::allocation_totals;
    assert(allocations.allocations == 0 && allocations.bytes == 0 && allocations.frees == 0);
    assert(allocations.allocation_ticks == 0 && allocations.collection_ticks == 0);
}
} // namespace

int main() {
    using namespace bbl::profile;
    const auto startup = register_source_function("startup");
    const auto nested = register_source_function("nested");
    const auto frame = register_source_function("frame");
    const auto worker = register_source_function("worker-startup");
    {
        SourceScope outer(startup);
        const auto after_scope_start = ticks();
        assert(tick_origin().ticks <= after_scope_start);
        {
            SourceScope inner(nested);
            allocate(4096);
        }
    }
    const auto& totals = source_thread_records().functions;
    assert(totals[startup].calls == 1 && totals[nested].calls == 1);
    assert(totals[startup].total_ticks >= totals[nested].total_ticks);
    assert(totals[startup].self_ticks + totals[nested].total_ticks == totals[startup].total_ticks);
    assert(allocation_totals.allocations >= 1 && allocation_totals.bytes >= 4096);
    assert(allocation_totals.frees >= 1);
    begin_frame();
    assert_empty();
    {
        SourceScope current(frame);
        allocate(128);
    }
    report_frame(0);
    begin_frame();
    assert_empty();
    std::thread other([&] {
        assert(!source_thread_records().frame_started);
        {
            SourceScope current(worker);
            allocate(256);
        }
        begin_frame();
        assert_empty();
        begin_frame();
        assert_empty();
    });
    other.join();
    assert(source_thread_records().frame_started);
    std::puts("source-profile-check: ok");
}
