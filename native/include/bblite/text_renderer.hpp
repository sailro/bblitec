#pragma once
#include <bblite/text.hpp>

namespace bbl {
struct TextLayerOptions {
    Vec2d position_px{};
    double rotation_rad = 0, scale = 1, order = 0, opacity = 1, coverage_gamma = 1;
    bool visible = true;
};
struct TextLayerState : TextLayerOptions {
    TextData data;
    double version = 0;
};
using TextLayer = std::shared_ptr<TextLayerState>;
struct TextLayerBindGroup {
    std::shared_ptr<void> group;
    double atlas_version = 0;
    std::string curve_set_id;
};
struct TextLayerGpuState : TextGpuState {
    TextLayer layer;
    std::vector<std::shared_ptr<TextLayerBindGroup>> bind_group_cache;
    std::array<float,6> last_mvp_inputs{};
    bool mvp_uploaded = false;
    std::shared_ptr<void> render_bundle;
    double bundle_layout_version = -1, bundle_draw_calls = 0;
};
struct TextRendererOptions {
    std::vector<TextLayer> layers;
    bool clear = true;
    Color4 clear_value{0,0,0,1};
};
struct TextRendererState {
    Engine* engine = nullptr;
    std::vector<TextLayer> layers;
    bool clear = true, disposed = false;
    Color4 clear_value{0,0,0,1};
    double target_width = 0, target_height = 0;
    std::unordered_map<TextLayer, std::shared_ptr<TextLayerGpuState>> layer_gpu;
    std::vector<std::shared_ptr<void>> visible_bundles;
};
using TextRenderer = std::shared_ptr<TextRendererState>;
// Retained WebGPU bundle commands. SDL has no native bundle object; both PALs
// replay this immutable command list with the source's invalidation keys.
enum class TextBundleOp { pipeline, quad, instances, group, draw };
struct TextBundleCommand {
    TextBundleOp op;
    std::shared_ptr<void> resource;
    std::array<std::size_t,4> draw{};
};
struct TextCommandBundle { std::vector<TextBundleCommand> commands; };
} // namespace bbl
