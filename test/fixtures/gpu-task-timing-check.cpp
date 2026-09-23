#include <bblite/js_realm_state.hpp>
#include <cassert>
#include <iostream>

namespace {
struct QuerySet final : bbl::pal::GpuTimestampQuerySet {};
struct Readback final : bbl::pal::GpuTimestampReadback {
    bool ready = false;
    bool fail = false;
    std::vector<std::uint64_t> values;
    std::optional<std::vector<std::uint64_t>> poll() override {
        if (fail)
            throw std::runtime_error("");
        if (!ready)
            return {};
        return values;
    }
};
struct Device final : bbl::pal::OffscreenDevice {
    unsigned created = 0;
    std::vector<std::shared_ptr<Readback>> submitted;
    bool supports_gpu_timestamps() const override { return true; }
    std::shared_ptr<bbl::pal::GpuTimestampQuerySet>
    create_gpu_timestamp_query_set(std::uint32_t count) override {
        assert(count == 128);
        ++created;
        return std::make_shared<QuerySet>();
    }
    std::shared_ptr<bbl::pal::GpuTimestampReadback>
    resolve_gpu_timestamps(const std::shared_ptr<bbl::pal::GpuTimestampQuerySet>&,
                           std::uint32_t count) override {
        auto result = std::make_shared<Readback>();
        result->values.resize(count);
        submitted.push_back(result);
        return result;
    }
};

bbl::js::Promise<bbl::js::PromiseVoid> check(bbl::pal::EventLoop& loop) {
    using namespace bbl;
    auto unsupported = std::make_shared<pal::GpuTaskTimingState>();
    assert(get_render_task_gpu_timings(unsupported)->status == "unsupported");
    assert((co_await set_render_task_gpu_timing_enabled(unsupported, true))->status ==
           "unsupported");
    auto device = std::make_shared<Device>();
    auto state = std::make_shared<pal::GpuTaskTimingState>();
    state->device = device;
    state->supported = true;
    assert(get_render_task_gpu_timings(state)->status == "disabled");
    auto enabling = set_render_task_gpu_timing_enabled(state, true);
    assert(get_render_task_gpu_timings(state)->status == "pending");
    auto disabling = set_render_task_gpu_timing_enabled(state, false);
    assert((co_await enabling)->status == "disabled");
    assert((co_await disabling)->status == "disabled");
    assert(device->created == 0);
    assert((co_await set_render_task_gpu_timing_enabled(state, true))->status == "pending");
    assert(device->created == 1);
    auto timer = state->timer;
    timer->begin_frame();
    const auto first = timer->begin_task("compute");
    const auto second = timer->begin_task("mipmaps");
    assert(first && second && first->begin.index == 0 && second->end.index == 3);
    timer->end_task(first->end, "renamed compute");
    timer->end_task(second->end, "mipmaps");
    timer->finish_frame();
    timer->poll();
    assert(get_render_task_gpu_timings(state)->status == "pending");
    device->submitted.back()->values = {100, 1000100, 1000, 500};
    device->submitted.back()->ready = true;
    timer->poll();
    const auto measured = get_render_task_gpu_timings(state);
    assert(measured->status == "available" && measured->frame_index == 1);
    assert(measured->tasks.size() == 1 && measured->tasks.front().name == "renamed compute");
    assert(measured->tasks.front().duration_ms == 1 && measured->tasks.front().index == 0);
    assert(get_render_task_gpu_timings(state) == measured);
    const auto projection = pal::project_gpu_task_timing_snapshot<std::shared_ptr<int>>(
        measured, [](const auto&) { return std::make_shared<int>(7); });
    assert(pal::project_gpu_task_timing_snapshot<std::shared_ptr<int>>(
               measured, [](const auto&) { return std::make_shared<int>(9); }) == projection);
    timer->task_capacity = 1;
    timer->begin_frame();
    assert(timer->begin_task("first"));
    assert(!timer->begin_task("dropped"));
    timer->finish_frame();
    device->submitted.back()->values = {0, 500000};
    device->submitted.back()->ready = true;
    timer->poll();
    assert(get_render_task_gpu_timings(state)->dropped_task_count == 1);
    assert(get_render_task_gpu_timings(state)->tasks.front().duration_ms == .5);
    for (int frame = 0; frame < 4; ++frame) {
        timer->begin_frame();
        assert(timer->begin_task("backlog"));
        timer->finish_frame();
    }
    assert(timer->in_flight == 4);
    timer->begin_frame();
    assert(!timer->begin_task("skipped"));
    timer->finish_frame();
    assert(timer->in_flight == 4);
    for (const auto& readback : device->submitted)
        readback->fail = true;
    timer->poll();
    assert(timer->in_flight == 0);
    assert(get_render_task_gpu_timings(state)->status == "error");
    assert(get_render_task_gpu_timings(state)->error == "");
    const auto late_publish = timer->publish;
    assert((co_await set_render_task_gpu_timing_enabled(state, false))->status == "disabled");
    late_publish(measured);
    assert(get_render_task_gpu_timings(state)->status == "disabled");
    assert(timer->disposed && !timer->query_set && timer->pending_readbacks.empty());
    timer->dispose();
    assert((co_await set_render_task_gpu_timing_enabled(state, true))->status == "pending");
    late_publish(measured);
    assert(get_render_task_gpu_timings(state)->status == "pending");
    co_await set_render_task_gpu_timing_enabled(state, false);
    loop.close();
    co_return js::PromiseVoid{};
}
} // namespace

int main() {
    const bbl::js::RealmScope realm;
    bbl::pal::EventLoop loop;
    loop.run([&] { check(loop); });
    std::cout << "timing policy passed\n";
}
