#include "../../native/src/pal_offscreen_gpu.hpp"
#include <atomic>
#include <cassert>
#include <iostream>
#include <thread>

using namespace bbl::pal;
struct Device final : OffscreenDevice {};
struct Image final : OffscreenImage {};

template <typename Action>
void refuses(Action action) {
    bool refused = false;
    try { action(); } catch (const std::runtime_error&) { refused = true; }
    assert(refused);
}

int main() {
    Device device;
    refuses([] { OffscreenSurface invalid(0, 1); });
    OffscreenSurface surface(16, 8);
    {
        OffscreenRun run(surface, device);
        assert(OffscreenRun::current() == nullptr);
        const OffscreenRun::Binding binding(run);
        assert(OffscreenRun::current() == &run);
        refuses([&] { OffscreenRun nested(surface, device); });
        std::jthread contender([&] {
            assert(OffscreenRun::current() == nullptr);
            refuses([&] { OffscreenRun duplicate(surface, device); });
        });
        contender.join();
        OffscreenImagePool<Image> pool;
        int allocations = 0;
        const auto create = [&](auto, auto) { ++allocations; return std::make_shared<Image>(); };
        std::vector<OffscreenFrame> leases;
        for (int index = 0; index < 3; ++index) {
            assert(pool.acquire(16, 8, run, create));
            pool.publish(run);
            leases.push_back(*surface.take_frame());
        }
        assert(allocations == 3);
        assert(!pool.acquire(16, 8, run, create)); // All three are consumer-owned.
        const auto released = leases.back().image.get();
        leases.pop_back();
        assert(pool.acquire(16, 8, run, create) == released);
        pool.publish(run);
        assert(surface.take_frame()->sequence == 4);
        // A stalled presenter retains two images, but the newest mailbox frame
        // may be replaced indefinitely without allocating or overwriting them.
        for (int index = 0; index < 8; ++index) {
            assert(pool.acquire(16, 8, run, create) == released);
            pool.publish(run);
        }
        assert(allocations == 3);
        assert(surface.take_frame()->sequence == 12);
        surface.resize(20, 10);
        assert(run.extent().width == 20);
        assert(pool.acquire(20, 10, run, create));
        pool.publish(run);
        const auto resized = surface.take_frame();
        assert(resized->width == 20 && resized->height == 10);
        assert(leases[0].width == 16); // Old GPU leases survive a resize.
        surface.close();
        assert(run.closed());
        run.publish(20, 10, std::make_shared<Image>());
        assert(!surface.take_frame());
    }
    assert(OffscreenRun::current() == nullptr);
    refuses([&] { OffscreenRun closed(surface, device); });
    // Closing from the host stops a producer and joins.
    OffscreenSurface live(1, 1);
    std::atomic<bool> started = false;
    std::jthread producer([&] {
        OffscreenRun run(live, device);
        started.store(true);
        while (!run.closed()) run.publish(1, 1, std::make_shared<Image>());
    });
    while (!started.load()) std::this_thread::yield();
    live.close();
    producer.join();
    std::cout << "offscreen ownership, bounded leases, resize and close passed\n";
}
