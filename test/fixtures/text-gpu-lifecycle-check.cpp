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
    auto named = [](int id) { return std::make_shared<Resource>(Resource{id, "fixed"}); };
    TextPipelineBinding pipelines{named(1001), named(1002), named(1003), named(1004)};
    TextTargetSignature target{std::string("rgba8unorm"), 4u, std::string("depth24plus")};
    int device_a = 0, device_b = 0;
    const void* device = &device_a;
    std::shared_ptr<TextGpuState> gpu;
    auto ensure = [&] { gpu = ensure_text_gpu(*r, device, target, pipelines, ops); };
    auto update = [&] { update_text_resources(*r, *gpu, pipelines.layout, ops); };
    auto draw = [&] { ops.event("draws", draw_text_renderable(*gpu, *data, pipelines.quad, ops)); };
    auto record = [&] {
        const auto& a = *atlas->gpu;
        ops.event("state", gpu->instance_capacity, gpu->style_buffer_bytes,
                  gpu->uploaded_data_version, gpu->uploaded_style_version, data->dirty_start,
                  data->dirty_end, a.curve_rows, a.band_rows, a.metadata_capacity,
                  a.uploaded_version, Ops::id(data->groups[0]->bind_group),
                  data->groups[0]->bind_group_version);
    };
#include "actions.hpp"
    return 0;
}
