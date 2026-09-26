#include <cassert>
namespace {
int validations = 0, preparations = 0, flushes = 0, recorded = 0, submissions = 0;
bool reject_binding = false;
} // namespace
namespace bbl {
void assert_compute_shader_live(const std::shared_ptr<ComputeShader>& shader) {
    if (shader->destroyed)
        throw std::runtime_error("#823");
}
std::shared_ptr<pal::ComputePipeline>
get_compute_pipeline(const std::shared_ptr<ComputeShader>& shader) {
    assert_compute_shader_live(shader);
    return shader->pipeline;
}
std::shared_ptr<ComputeBindGroups>
ensure_compute_binding_groups(const std::shared_ptr<ComputeBindingSet>& set, bool validate) {
    if (validate)
        ++validations;
    if (reject_binding)
        throw std::runtime_error("invalid binding");
    return set->groups;
}
js::Promise<js::PromiseVoid> prepare_compute_shader(std::shared_ptr<ComputeShader> shader) {
    assert_compute_shader_live(shader);
    ++preparations;
    js::Promise<js::PromiseVoid> result;
    result.resolve(js::PromiseVoid{});
    return result;
}
} // namespace bbl
struct Device final : bbl::pal::OffscreenDevice {
    std::vector<bbl::pal::ComputeDispatch> commands;
    bbl::pal::ComputeShaderLimits compute_shader_limits() const override {
        bbl::pal::ComputeShaderLimits limits;
        limits.max_compute_workgroups_per_dimension = 4;
        return limits;
    }
    void dispatch_compute(const bbl::pal::ComputeDispatch& command) override {
        assert(flushes > 0 && recorded > 0);
        commands.push_back(command);
    }
};
template <class F> void rejects(F callback, const std::string& expected) {
    bool rejected = false;
    try {
        callback();
    } catch (const std::exception& error) {
        rejected = error.what() == expected;
    }
    assert(rejected);
}
bbl::js::Promise<bbl::js::PromiseVoid>
prepare_checks(bbl::pal::EventLoop& loop, std::shared_ptr<bbl::ComputeTask> task, bool& completed) {
    const int before = preparations;
    auto pending = bbl::prepare_compute_task(task);
    assert(preparations == before + 2);
    (void)co_await pending;
    task->disposed = true;
    bool rejected = false;
    try {
        (void)co_await bbl::prepare_compute_task(task);
    } catch (const std::exception& error) {
        rejected = std::string(error.what()) == "#842";
    }
    assert(rejected);
    task->disposed = false;
    completed = true;
    loop.close();
    co_return bbl::js::PromiseVoid{};
}
int main() {
    bbl::js::RealmScope realm;
    auto engine = std::make_shared<bbl::Engine>();
    auto device = std::make_shared<Device>();
    engine->offscreen_run = std::make_shared<bbl::pal::OffscreenRun>(
        std::make_shared<bbl::pal::OffscreenSurface>(1, 1), device);
    auto shader = std::make_shared<bbl::ComputeShader>();
    shader->engine = engine;
    shader->device = device;
    shader->pipeline = std::make_shared<bbl::pal::ComputePipeline>();
    shader->dynamic_counts = {0, 1};
    auto bindings = std::make_shared<bbl::ComputeBindingSet>();
    bindings->shader = shader;
    bindings->groups = std::make_shared<bbl::ComputeBindGroups>(2);
    for (auto& group : *bindings->groups)
        group = std::make_shared<bbl::pal::ComputeBindGroup>();
    bindings->dynamic_slots = bbl::ComputeDynamicBindingSlots{{"params", {1, 0, 256, 512}}};
    bindings->zero_dynamic_offsets = std::vector<std::vector<double>>{{}, {0}};
    auto first = bbl::create_compute_dispatch(shader, bindings, {{2, {}, {}}, {}}),
         second = bbl::create_compute_dispatch(shader, bindings, {{3, 2, 1}, false});
    assert((first->dimensions == std::array<double, 3>{2, 1, 1}) && first->enabled &&
           !second->enabled);
    rejects([&] { bbl::set_compute_dispatch_size(first, {5, {}, {}}); }, "#791");
    rejects([&] { bbl::set_compute_dispatch_size(first, {0.5, {}, {}}); }, "#791");
    auto wrong = std::make_shared<bbl::ComputeBindingSet>();
    wrong->shader = std::make_shared<bbl::ComputeShader>();
    rejects([&] { (void)bbl::create_compute_dispatch(shader, wrong, {{1, {}, {}}, {}}); }, "#792");
    bbl::set_compute_dispatch_dynamic_offset(first, "params", 256);
    bbl::set_compute_dispatch_dynamic_offset(second, "params", 512);
    assert(first->dynamic_offsets->size() == 2 && first->dynamic_offsets->at(0)->empty());
    rejects([&] { bbl::set_compute_dispatch_dynamic_offset(first, "missing", 0); }, "#793");
    rejects([&] { bbl::set_compute_dispatch_dynamic_offset(first, "params", 1); }, "#794");
    rejects([&] { bbl::set_compute_dispatch_dynamic_offset(first, "params", 768); }, "#795");
    auto task = bbl::create_compute_task(engine, "ordered");
    bbl::add_compute_dispatch(task, first);
    bbl::add_compute_dispatch(task, first);
    bbl::add_compute_dispatch(task, second);
    assert(task->dispatches.size() == 2);
    auto foreign = bbl::create_compute_task(std::make_shared<bbl::Engine>());
    rejects([&] { bbl::add_compute_dispatch(foreign, first); }, "#838");
    rejects([&] { bbl::submit_compute_tasks({task}); }, "#840");
    task->flush_owned = [] { ++flushes; };
    task->one_shot_recorded = [](auto encoder) {
        assert(encoder && encoder->commands.size() > 0);
        ++recorded;
    };
    engine->gpu_task_timer_resolve = [](auto encoder, bool) {
        assert(!encoder->commands.size());
        ++submissions;
    };
    task->record();
    auto old = task->pass;
    task->record();
    assert(old != task->pass && task->passes.size() == 1);
    bbl::submit_compute_tasks({task});
    assert(device->commands.size() == 1 && device->commands[0].workgroups[0] == 2 &&
           device->commands[0].groups[1].dynamic_offsets[0] == 256 && validations == 1 &&
           submissions == 1 && !engine->current_compute_encoder);
    second->enabled = true;
    validations = 0;
    bbl::submit_compute_tasks({task});
    assert(device->commands.size() == 3 && validations == 1 &&
           device->commands[2].workgroups[0] == 3 &&
           device->commands[2].groups[1].dynamic_offsets[0] == 512);
    reject_binding = true;
    rejects([&] { bbl::submit_compute_tasks({task}); }, "invalid binding");
    reject_binding = false;
    assert(!engine->current_compute_encoder && device->commands.size() == 3);
    engine->current_compute_encoder = std::make_shared<bbl::pal::ComputeCommandEncoder>(device);
    rejects([&] { bbl::submit_compute_tasks({task}); }, "#841");
    engine->current_compute_encoder.reset();
    foreign->record();
    rejects([&] { bbl::submit_compute_tasks({task, foreign}); }, "#839");
    task->execution_enabled = false;
    bbl::submit_compute_tasks({task});
    assert(device->commands.size() == 3);
    task->execution_enabled = true;
    first->enabled = false;
    second->enabled = false;
    const int before_flush = flushes;
    task->one_shot_recorded = [](auto encoder) {
        assert(encoder && encoder->commands.empty());
        ++recorded;
    };
    bbl::submit_compute_tasks({task});
    assert(flushes == before_flush && submissions == 3 && device->commands.size() == 3);
    bbl::pal::EventLoop loop;
    bool completed = false;
    loop.run([&] { prepare_checks(loop, task, completed); });
    assert(completed);
    bbl::remove_compute_dispatch(task, second);
    bbl::remove_compute_dispatch(task, second);
    assert(task->dispatches.size() == 1);
    task->dispose();
    rejects([&] { task->record(); }, "#836");
    rejects([&] { bbl::add_compute_dispatch(task, first); }, "#837");
    assert(task->passes.empty() && task->dispatches.empty() && !task->pass && !shader->destroyed);
    auto scene = std::make_shared<bbl::Scene>();
    scene->engine = engine.get();
    engine->rendering_contexts.push_back("scene", scene);
    bbl::FrameTaskRecord render;
    engine->frame_tasks.push_back(render);
    scene->tasks.push_back({0});
    auto graph_task = bbl::create_compute_task(engine, "prefix");
    first->enabled = true;
    bbl::add_compute_dispatch(graph_task, first);
    bbl::add_task_at_start(*scene, graph_task);
    assert(scene->tasks.size() == 2 && scene->tasks[0].value == 1 && scene->tasks[1].value == 0);
    int frame_completed = 0;
    engine->gpu_timer_resolve = [&](auto, bool) {
        assert(engine->current_compute_encoder && engine->current_compute_encoder->finished);
        ++frame_completed;
    };
    const auto before_graph = device->commands.size();
    const int before_submissions = submissions;
    bbl::begin_compute_frame_prefix(*engine);
    assert(engine->current_compute_encoder && device->commands.size() == before_graph + 1 &&
           submissions == before_submissions && frame_completed == 0);
    bbl::finish_compute_frame_prefix(*engine);
    assert(!engine->current_compute_encoder && frame_completed == 1);
    bbl::add_task(*scene, graph_task);
    rejects([&] { bbl::begin_compute_frame_prefix(*engine); },
            "Compute tasks after rendering require an interleaved queue adapter.");
    assert(device->commands.size() == before_graph + 1);
    scene->tasks.pop_back();
    bbl::FrameTaskRecord shadow;
    shadow.kind = bbl::FrameTaskKind::render;
    shadow.render.shadow_generator = bbl::ShadowGeneratorHandle{0};
    engine->frame_tasks.push_back(shadow);
    engine->frame_tasks.push_back(shadow);
    scene->tasks = {bbl::TaskHandle{2}, bbl::TaskHandle{3}, bbl::TaskHandle{0}};
    bbl::add_task_at_start(*scene, graph_task);
    assert(scene->tasks[0].value == 2 && scene->tasks[1].value == 3 && scene->tasks[2].value == 1);
    const auto before_deferred = device->commands.size();
    bbl::begin_compute_frame_prefix(*engine);
    assert(!engine->current_compute_encoder && device->commands.size() == before_deferred);
    assert(bbl::compute_frame_prefix_deferred(*engine));
    bbl::begin_compute_frame_prefix(*engine, true);
    assert(engine->current_compute_encoder && device->commands.size() == before_deferred + 1);
    bbl::finish_compute_frame_prefix(*engine);
    assert(!engine->current_compute_encoder && frame_completed == 2);
    graph_task->dispose();
    engine->gpu_timer_resolve = {};
    engine->frame_tasks.clear();
    engine->rendering_contexts.clear();
}
