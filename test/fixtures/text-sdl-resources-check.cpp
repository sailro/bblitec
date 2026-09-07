#include "pal_sdl_gpu_text_resources.hpp"
#include <cassert>

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    auto owner = std::make_shared<SdlTextDevice>();
    SdlTextResourceOps ops{owner};
    TextGpuState first, second;
    // Uniform creation is the SDL CPU/push transport; no native device is needed.
    ops.create_renderable_buffer(first, TextBufferKind::uniform, 96);
    ops.create_renderable_buffer(second, TextBufferKind::uniform, 96);
    TextAtlasGpuState atlas;
    atlas.backend = std::make_shared<SdlTextAtlasResources>();
    auto group = std::static_pointer_cast<SdlTextGroup>(ops.create_bind_group(first, atlas, {}));
    const std::array<std::uint8_t, 4> front{11, 12, 13, 14}, rear{21, 22, 23, 24};
    ops.write_renderable_buffer(first, TextBufferKind::uniform, 80, front);
    ops.write_renderable_buffer(second, TextBufferKind::uniform, 80, rear);
    assert(group->uniform->bytes[80] == 11 && group->uniform->bytes[84] == 0);
    const auto old = group->uniform;
    first.destroy_uniform();
    ops.create_renderable_buffer(first, TextBufferKind::uniform, 96);
    ops.write_renderable_buffer(first, TextBufferKind::uniform, 80, rear);
    assert(group->uniform == old && group->uniform->bytes[80] == 11);
    bool destroyed = false;
    try { group->uniform->check(); } catch (const std::runtime_error&) { destroyed = true; }
    assert(destroyed);
    auto replacement = std::static_pointer_cast<SdlTextGroup>(ops.create_bind_group(first, atlas, {}));
    assert(replacement->uniform != old && replacement->uniform->bytes[80] == 21);
    bool range = false;
    try { ops.write_renderable_buffer(first, TextBufferKind::uniform, 94, front); }
    catch (const std::runtime_error&) { range = true; }
    assert(range && replacement->uniform->bytes[94] == 0);
    owner->retire();
    assert(replacement->uniform->destroyed && group->uniform->destroyed);
    assert(owner->resources.tracked_resource_count() == 0);

    auto captured_owner = std::make_shared<SdlTextDevice>();
    captured_owner->capture = TextGpuCapture(true);
    SdlTextResourceOps captured_ops{captured_owner};
    TextGpuState captured_gpu;
    captured_ops.create_renderable_buffer(captured_gpu, TextBufferKind::uniform, 96);
    captured_ops.write_renderable_buffer(captured_gpu, TextBufferKind::uniform, 80, front);
    const auto& receipt = captured_owner->capture.resources().at(0);
    assert(receipt.role == "uniform-shadow");
    assert(receipt.written_ranges.at(0).offset == 80 && receipt.written_ranges.at(0).bytes == 4);
    assert(receipt.uploaded_bytes.at(80) == 11);
    captured_owner->retire();
}
