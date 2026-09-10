#define BBLITE_HAS_UI 0
#define BBLITE_DEVICE_RECOVERY 0
#define BBLITE_OFFSCREEN_SURFACES 1
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include "pal_sdl_gpu_commands.hpp"
#include "pal_dawn_resources.hpp"
#include "pal_frame_conductor.hpp"
#include <cassert>
#include <deque>

struct SDL_GPUTexture {};
struct SDL_GPUCommandBuffer { bool consumed = false; };
struct WGPUTextureImpl { unsigned references = 0; };
struct WGPUTextureViewImpl { unsigned references = 0; };
struct WGPUBufferImpl {};

namespace {
std::vector<std::string> events;
SDL_GPUTexture sdl_texture;
SDL_GPUCommandBuffer sdl_command;
WGPUTextureImpl dawn_texture;
WGPUTextureViewImpl dawn_view;
std::deque<WGPUBufferImpl> buffers;
bool acquire_success = true, texture_available = true, command_available = true;
bool submission_success = true, view_available = true;
WGPUSurfaceGetCurrentTextureStatus dawn_status = WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal;
unsigned submissions = 0, cancellations = 0, advances = 0;
std::function<void()> on_advance;
}

extern "C" SDL_GPUCommandBuffer* SDLCALL SDL_AcquireGPUCommandBuffer(SDL_GPUDevice*) {
    if (!command_available) return nullptr;
    assert(sdl_command.consumed);
    sdl_command.consumed = false;
    return &sdl_command;
}
extern "C" bool SDLCALL SDL_WaitAndAcquireGPUSwapchainTexture(
    SDL_GPUCommandBuffer*, SDL_Window*, SDL_GPUTexture** texture, Uint32* width, Uint32* height) {
    events.push_back("acquire");
    *texture = acquire_success && texture_available ? &sdl_texture : nullptr;
    *width = 320; *height = 180;
    return acquire_success;
}
extern "C" bool SDLCALL SDL_SubmitGPUCommandBuffer(SDL_GPUCommandBuffer* command) {
    assert(command && !command->consumed);
    command->consumed = true; ++submissions;
    return submission_success;
}
extern "C" bool SDLCALL SDL_CancelGPUCommandBuffer(SDL_GPUCommandBuffer* command) {
    assert(command && !command->consumed);
    command->consumed = true; ++cancellations; return true;
}
extern "C" void wgpuSurfaceGetCurrentTexture(WGPUSurface, WGPUSurfaceTexture* surface) {
    events.push_back("acquire");
    surface->texture = &dawn_texture; ++dawn_texture.references;
    surface->status = dawn_status;
}
extern "C" void wgpuTextureAddRef(WGPUTexture texture) { ++texture->references; }
extern "C" void wgpuTextureRelease(WGPUTexture texture) {
    assert(texture->references > 0); --texture->references;
}
extern "C" void wgpuTextureViewRelease(WGPUTextureView view) {
    assert(view->references > 0); --view->references;
}
extern "C" WGPUTextureView wgpuTextureCreateView(WGPUTexture, const WGPUTextureViewDescriptor*) {
    if (!view_available) return nullptr;
    ++dawn_view.references; return &dawn_view;
}

namespace bbl::upstream {
struct RenderDrawLists { std::vector<unsigned> items; };
struct RenderPlan { std::vector<unsigned> items; };
// The fixture isolates native task routing from generated draw-list selection.
RenderDrawLists build_render_task_draw_lists(
    const std::vector<unsigned>& items, const Engine&, const FrameTaskRecord& task) {
    return task.kind == FrameTaskKind::render || task.kind == FrameTaskKind::geometry
        ? RenderDrawLists{items} : RenderDrawLists{};
}
}

namespace bbl::pal {
[[noreturn]] void gpu_error(const char* operation) { throw std::runtime_error(operation); }
[[noreturn]] void dawn_error(const char* operation) { throw std::runtime_error(operation); }
double monotonic_milliseconds() { return 123.0; }
struct TestClock {};
double advance_frame(Engine&, Scene&, TestClock&, double delta) {
    events.push_back("advance"); ++advances;
    if (on_advance) on_advance();
    return delta;
}
#include "scene-restart.hpp"

struct DawnRenderTask {
    WGPUBuffer view_projection = nullptr;
    upstream::RenderDrawLists draw_lists;
};
struct DawnState {
    std::vector<DawnRenderTask> render_tasks;
    WGPUSurface surface = nullptr;
};
WGPUBuffer create_buffer(DawnState&, WGPUBufferUsage usage, const void* data, std::size_t bytes) {
    assert(usage == WGPUBufferUsage_Uniform && data == nullptr && bytes == 64);
    buffers.emplace_back(); return &buffers.back();
}
struct Options { double frame_delta_ms = 16.5; };
struct CommonData {
    Engine& engine;
    std::vector<std::shared_ptr<Scene>> active_registered_scenes;
    Scene& scene;
    Options frame_options;
    TestClock frame_clock;
    bool cpu_profile = true;
    upstream::RenderPlan render_plan{{10}};
    std::vector<upstream::RenderPlan> overlay_plans{{{20}}};
    explicit CommonData(Engine& target)
        : engine(target), active_registered_scenes(target.registered_scenes),
          scene(*target.registered_scenes.front()) {}
};
struct SdlData : CommonData {
    struct Resources { struct State { SDL_GPUDevice* device = nullptr; SDL_Window* window = nullptr; } state; } resources;
    std::vector<upstream::RenderDrawLists> task_draw_lists;
    bool offscreen = false;
    using CommonData::CommonData;
};
struct DawnData : CommonData {
    DawnState state;
    unsigned width = 320, height = 180;
    using CommonData::CommonData;
};
struct OffscreenImage { WGPUTexture texture = nullptr; };
struct Frame {
    SdlGpuCommand command{nullptr};
    SDL_GPUTexture* swapchain = nullptr;
    SDL_GPUTexture* offscreen_texture = nullptr;
    Uint32 width = 0, height = 0;
    double acquired = 0, benchmark_start = 0, delta_ms = 0, updated = 0;
    WGPUSurfaceTexture surface_texture = WGPU_SURFACE_TEXTURE_INIT;
    DawnTexture surface;
    DawnTextureView surface_view;
    OffscreenImage* offscreen_image = nullptr;
};
template <typename Data>
struct Context {
    Data data_;
    std::optional<Frame> frame_;
    explicit Context(Engine& engine) : data_(engine) { frame_.emplace(); }
    bool keep_running() const { return true; }
    FramePreparation prepare() { return FramePreparation::ready; }
    void synchronize() { events.push_back("upload"); }
    void encode() { events.push_back("encode"); }
    void present() { events.push_back("present"); }
    void complete() { events.push_back("complete"); }
};
struct SdlScene : Context<SdlData> {
    static constexpr auto acquire_phase = FrameAcquirePhase::before_update;
    using Context::Context;
#include "SdlScene.hpp"
};
struct DawnScene : Context<DawnData> {
    static constexpr auto acquire_phase = FrameAcquirePhase::before_encoding;
    using Context::Context;
#include "DawnScene.hpp"
};
}

namespace {
using namespace bbl;
using namespace bbl::pal;
void reset() {
    assert(dawn_texture.references == 0 && dawn_view.references == 0);
    events.clear(); buffers.clear(); sdl_command.consumed = true;
    submissions = cancellations = advances = 0;
    acquire_success = texture_available = command_available = submission_success = view_available = true;
    dawn_status = WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal;
    on_advance = {};
}
template <typename Operation>
void expect_failure(Operation operation) {
    bool failed = false;
    try { operation(); } catch (const std::runtime_error&) { failed = true; }
    assert(failed);
}

void surface_boundaries() {
    Engine engine;
    engine.registered_scenes.push_back(std::make_shared<Scene>());
    reset();
    {
        SdlScene renderer(engine);
        assert(conduct_frame(renderer) == FrameOutcome::rendered);
        assert((events == std::vector<std::string>{"acquire", "advance", "upload", "encode", "present", "complete"}));
        assert(renderer.frame_->width == 320 && renderer.frame_->height == 180);
        assert(renderer.frame_->delta_ms == 16.5 && renderer.frame_->acquired == 123);
    }
    assert(submissions == 1 && cancellations == 0);
    reset();
    {
        texture_available = false;
        SdlScene renderer(engine);
        assert(conduct_frame(renderer) == FrameOutcome::skipped);
        assert((events == std::vector<std::string>{"acquire"}));
        assert(advances == 0 && cancellations == 1 && submissions == 0);
    }
    for (bool failure_before_command : {false, true}) {
        reset();
        acquire_success = false;
        command_available = !failure_before_command;
        {
            SdlScene renderer(engine);
            expect_failure([&] { conduct_frame(renderer); });
        }
        assert(advances == 0 && submissions == 0 && cancellations == (failure_before_command ? 0u : 1u));
    }
    reset();
    {
        SdlScene renderer(engine);
        renderer.data_.offscreen = true;
        renderer.frame_->offscreen_texture = &sdl_texture;
        engine.options.width = 640; engine.options.height = 360;
        assert(renderer.acquire());
        assert(events.empty() && renderer.frame_->swapchain == &sdl_texture);
        assert(renderer.frame_->width == 640 && renderer.frame_->height == 360);
    }
    assert(cancellations == 1);
    reset();
    {
        DawnScene renderer(engine);
        assert(conduct_frame(renderer) == FrameOutcome::rendered);
        assert((events == std::vector<std::string>{"advance", "upload", "acquire", "encode", "present", "complete"}));
        assert(renderer.frame_->delta_ms == 16.5 && dawn_texture.references == 1 && dawn_view.references == 1);
    }
    for (bool fail_status : {false, true}) {
        reset();
        if (fail_status) dawn_status = WGPUSurfaceGetCurrentTextureStatus_Timeout;
        else view_available = false;
        {
            DawnScene renderer(engine);
            expect_failure([&] { conduct_frame(renderer); });
            assert((events == std::vector<std::string>{"advance", "upload", "acquire"}));
        }
        assert(dawn_texture.references == 0 && dawn_view.references == 0);
    }
    reset();
    {
        DawnScene renderer(engine);
        OffscreenImage image{&dawn_texture};
        renderer.frame_->offscreen_image = &image;
        assert(renderer.acquire());
        assert(events.empty() && dawn_texture.references == 1 && dawn_view.references == 1);
    }
    reset();
    {
        dawn_status = WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal;
        DawnScene renderer(engine);
        assert(renderer.acquire());
    }
}

template <typename Renderer>
void scene_replacement(bool sdl) {
    for (bool remove : {false, true}) {
        reset();
        Engine engine;
        engine.registered_scenes.push_back(std::make_shared<Scene>());
        on_advance = [&] {
            if (remove) engine.registered_scenes.clear();
            else engine.registered_scenes = {std::make_shared<Scene>()};
        };
        {
            Renderer renderer(engine);
            assert(conduct_frame(renderer) == FrameOutcome::restart);
            assert(engine.renderer_restart_requested == !remove);
            assert((events == (sdl ? std::vector<std::string>{"acquire", "advance"} : std::vector<std::string>{"advance"})));
            assert(submissions == (sdl ? 1u : 0u));
        }
        assert(cancellations == 0);
    }
    reset();
    Engine engine;
    engine.registered_scenes.push_back(std::make_shared<Scene>());
    on_advance = [&] { engine.registered_scenes = {std::make_shared<Scene>(*engine.registered_scenes.front())}; };
    {
        Renderer renderer(engine);
        assert(conduct_frame(renderer) == FrameOutcome::rendered);
        assert(!engine.renderer_restart_requested);
    }
}

void task_growth() {
    reset();
    Engine engine;
    engine.registered_scenes = {std::make_shared<Scene>(), std::make_shared<Scene>()};
    engine.frame_tasks.resize(1);
    engine.registered_scenes[0]->tasks = {TaskHandle{0}};
    SdlScene sdl(engine);
    DawnScene dawn(engine);
    sdl.rebuild_task_draw_lists(); dawn.rebuild_task_draw_lists();
    assert(sdl.data_.task_draw_lists.size() == 1 && dawn.data_.state.render_tasks.size() == 1);
    assert(sdl.data_.task_draw_lists[0].items == std::vector<unsigned>{10});
    assert(dawn.data_.state.render_tasks[0].draw_lists.items == std::vector<unsigned>{10});
    assert(buffers.size() == 1);
    const auto first = dawn.data_.state.render_tasks[0].view_projection;
    engine.frame_tasks.resize(3);
    engine.frame_tasks[1].kind = FrameTaskKind::copy;
    engine.frame_tasks[2].kind = FrameTaskKind::geometry;
    engine.registered_scenes[1]->tasks = {TaskHandle{1}, TaskHandle{2}};
    sdl.rebuild_task_draw_lists(); dawn.rebuild_task_draw_lists();
    assert(sdl.data_.task_draw_lists.size() == 3 && dawn.data_.state.render_tasks.size() == 3);
    assert(sdl.data_.task_draw_lists[2].items == std::vector<unsigned>{20});
    assert(dawn.data_.state.render_tasks[2].draw_lists.items == std::vector<unsigned>{20});
    assert(dawn.data_.state.render_tasks[1].view_projection == nullptr && buffers.size() == 2);
    sdl.data_.overlay_plans[0].items = {30}; dawn.data_.overlay_plans[0].items = {30};
    sdl.rebuild_task_draw_lists(); dawn.rebuild_task_draw_lists();
    assert(sdl.data_.task_draw_lists[2].items == std::vector<unsigned>{30});
    assert(dawn.data_.state.render_tasks[2].draw_lists.items == std::vector<unsigned>{30});
    assert(dawn.data_.state.render_tasks[0].view_projection == first && buffers.size() == 2);
    engine.registered_scenes[0]->tasks.clear();
    sdl.rebuild_task_draw_lists();
    assert(sdl.data_.task_draw_lists[0].items.empty());
    engine.registered_scenes[1]->tasks.push_back(TaskHandle{3});
    expect_failure([&] { sdl.rebuild_task_draw_lists(); });
    expect_failure([&] { dawn.rebuild_task_draw_lists(); });
    assert(buffers.size() == 2);
}
}

int main() {
    surface_boundaries();
    scene_replacement<bbl::pal::SdlScene>(true);
    scene_replacement<bbl::pal::DawnScene>(false);
    task_growth();
    reset();
}
