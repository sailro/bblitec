#include "text-resource-ops.hpp"
#include "upstream_text_renderer.hpp"
#include <numbers>

/** The JavaScript recorder's frame encoder: one event per render pass. */
struct RecorderCommands final : GpuCommandEncoder {
    Ops& ops;
    explicit RecorderCommands(Ops& target) : ops(target) {}
    GpuEncoderHandle begin_render_pass(const GpuRenderPassDescriptor& descriptor) override {
        const auto& color = descriptor.color_attachments[0];
        if (color.store_op != "store" || !color.clear_value)
            throw std::runtime_error("render pass descriptor");
        const auto& clear = *color.clear_value;
        ops.event("pass", color.load_op == "clear" ? 1 : 0, clear.r, clear.g, clear.b, clear.a);
        return std::make_shared<RecorderEncoder>(ops);
    }
};

int main() {
    Ops ops;
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
    auto cache = std::make_shared<TextPipelineDeviceCache>();
    cache->bind_group_layout = named(1003);
    cache->quad_vertex_buffer = named(1004);
    auto device =
        std::make_shared<RecorderDevice>(ops, TextPipelineSet{named(1001), named(1002), cache});
    auto surface = std::make_shared<TextSurface>();
    surface->device = device;
    surface->current_encoder = std::make_shared<RecorderCommands>(ops);
    surface->canvas = {1280, 720};
    surface->format = "bgra8unorm";
    surface->sc_rt.color_view = named(0);
    auto rr =
        create_text_renderer(surface, TextRendererOptions{.layers = {a, b},
                                                          .clear = std::nullopt,
                                                          .clear_value = Color4d{.1, .2, .3, 1}});
    const auto update = [&] { text_renderer_detail::text_renderer_update(rr); };
    const auto draw = [&] { ops.event("draws", text_renderer_detail::text_renderer_record(rr)); };
    const auto record = [&] {
        for (const auto& layer : rr->layers_) {
            const auto lg = rr->layer_gpu.get_owned(layer).value();
            ops.event("state", layer == a ? "a" : "b", lg->instance_cap, lg->uploaded_data_version,
                      lg->uploaded_style_version, lg->uploaded_viewport_w, lg->uploaded_viewport_h,
                      lg->bundle_layout_version, lg->bundle_draw_calls,
                      lg->bind_group_cache.size());
        }
    };
#include "actions.hpp"
}
