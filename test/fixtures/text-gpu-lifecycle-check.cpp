#include "text-resource-ops.hpp"
#include "statement-probe.hpp"
int main() {
    Ops ops;
    auto atlas = text_atlas();
    auto data = std::make_shared<TextDataState>();
    data->instances = pattern_floats(192, 1);
    data->styles = pattern_floats(128, 2);
    data->instance_count = 3;
    data->style_count = 1;
    data->version = 1;
    data->style_version = 1;
    data->groups = {text_group(atlas, "atlas", 0, 3), text_group(atlas, "variant", 3, 2),
                    text_group(atlas, "atlas", 0, 0)};
    auto r = create_text_renderable(data);
    auto second = create_text_renderable(data);
    auto cache = std::make_shared<TextPipelineDeviceCache>();
    cache->bind_group_layout = named(1003);
    cache->quad_vertex_buffer = named(1004);
    TextPipelineSet pipelines{named(1001), named(1002), cache};
    auto device_a = std::make_shared<RecorderDevice>(ops, pipelines);
    auto device_b = std::make_shared<RecorderDevice>(ops, pipelines);
    auto surface = std::make_shared<TextSurface>();
    surface->device = device_a;
    const TextTargetSignature target{.color_format = "rgba8unorm",
                                     .depth_format = "depth24plus",
                                     .depth_compare = std::nullopt,
                                     .sample_count = 4};
    const auto pass = std::make_shared<RecorderEncoder>(ops);
    std::shared_ptr<TextRenderableGpu> gpu;
    auto ensure_renderable = [&](const TextRenderable& renderable) {
        return text_renderable_detail::ensure_gpu(renderable, surface, target, "rgba8unorm", 4,
                                                  std::string("depth24plus"), true,
                                                  "greater-equal");
    };
    auto update_renderable = [&](const TextRenderable& renderable,
                                 const std::shared_ptr<TextRenderableGpu>& state) {
        text_renderable_detail::update_text_renderable(renderable, surface, state,
                                                       cache->bind_group_layout,
                                                       TextDrawUpdateContext{nullptr, 1280, 720});
    };
    auto ensure = [&] { gpu = ensure_renderable(r); };
    auto update = [&] { update_renderable(r, gpu); };
    auto draw = [&] {
        ops.event("draws", text_renderable_detail::draw_text_renderable(
                               gpu, data, cache->quad_vertex_buffer, pass));
    };
    auto record = [&] {
        const auto& a = *atlas->gpu;
        ops.event("state", gpu->instance_cap, gpu->style_buf->size, gpu->uploaded_data_version,
                  gpu->uploaded_style_version, data->dirty_start, data->dirty_end, a.curve_tex_rows,
                  a.band_tex_rows, a.meta_cap, a.uploaded_version,
                  id_of(data->groups[0]->bind_group), data->groups[0]->bind_group_version);
    };
#include "actions.hpp"
    return 0;
}
