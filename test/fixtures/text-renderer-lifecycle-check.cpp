#include "text-resource-ops.hpp"
#include <bblite/upstream_text_renderer.hpp>
#include <numbers>

Lease named(int id) { return std::make_shared<Resource>(Resource{id, "named"}); }
struct RendererOps : Ops {
    TextPipelineBinding pipelines{named(1001), named(1002), named(1003), named(1004)};
    TextPipelineBinding resolve_text_renderer_pipeline() { return pipelines; }
    std::shared_ptr<void> text_renderer_quad() { return pipelines.quad; }
    std::shared_ptr<void> retain_instance_buffer(const TextGpuState& gpu) {
        return render(gpu).instances;
    }
    void set_instance_buffer(const std::shared_ptr<void>& buffer) {
        event("vertex", 1, id(buffer));
    }
    void begin_text_renderer_pass(const TextRendererState& renderer) {
        event("pass", renderer.clear, renderer.clear_value.r, renderer.clear_value.g,
              renderer.clear_value.b, renderer.clear_value.a);
    }
    void end_text_renderer_pass() { event("end"); }
};
int main() {
    RendererOps ops;
    int device = 0;
    auto atlas = text_atlas();
    auto data = std::make_shared<TextDataState>();
    data->instances = pattern_floats(192, 1);
    data->styles = pattern_floats(128, 2);
    data->groups = {text_group(atlas, "atlas", 0, 3), text_group(atlas, "variant", 3, 2),
                    text_group(atlas, "atlas", 0, 0)};
    data->instance_count = 5;
    data->style_count = 1;
    data->version = 1;
    data->style_version = 1;
    auto a = create_text_layer(data), b = create_text_layer(data);
    a->position_px = {10, 20};
    a->order = 2;
    b->position_px = {250, 50};
    b->scale = .75;
    b->order = 1;
    TextRendererState rr;
    rr.layers = {a, b};
    rr.clear_value = {.1f, .2f, .3f, 1};
    double width = 1280, height = 720;
    const auto update = [&] { update_text_renderer(rr, width, height, &device, ops); };
    const auto draw = [&] { ops.event("draws", record_text_renderer(rr, ops)); };
    const auto record = [&] {
        for (const auto& layer : rr.layers) {
            const auto lg = rr.layer_gpu.at(layer);
            ops.event("state", layer == a ? "a" : "b", lg->instance_capacity,
                      lg->uploaded_data_version, lg->uploaded_style_version,
                      lg->uploaded_viewport_w, lg->uploaded_viewport_h, lg->bundle_layout_version,
                      lg->bundle_draw_calls, lg->bind_group_cache.size());
        }
    };
#include "actions.hpp"
}
