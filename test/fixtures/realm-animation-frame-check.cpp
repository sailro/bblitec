#define main generated_main
#include "../../artifacts/realm-animation-frame/program.hpp"
#undef main
#include <cassert>

namespace bbl::pal {
struct RepaintHost final : HostServices {
    std::shared_ptr<AnimationFrameSource> frames = std::make_shared<AnimationFrameSource>();
    std::shared_ptr<AnimationFrameSource> animation_frame_source() const override { return frames; }
};
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    const auto origin = EventLoop::Clock::now();
    auto host = std::make_shared<RepaintHost>();
    EventLoop loop(std::make_shared<EventLoop::Inbox>(), origin);
    WorkerRealm realm(loop, "", host);
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) { failure = error; loop.close(); });
    loop.post([&] { initialize(realm); });
    assert(loop.poll());
    assert(!loop.poll());
    host->frames->tick(origin + std::chrono::milliseconds(10));
    assert(loop.poll());
    assert(!loop.poll());
    host->frames->tick(origin + std::chrono::milliseconds(20));
    assert(loop.poll());
    assert(!loop.inbox()->post(std::make_unique<ExternalEvent>()));
    if (failure) std::rethrow_exception(failure);
    return 0;
}
}

int main() {
    assert(generated_main() == 0);
}
