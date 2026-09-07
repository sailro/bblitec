#include "pal_text_capture.hpp"
#include "text-capture-serializer.hpp"
#include <array>
#include <fstream>
#include <iostream>
#include <limits>

using namespace bbl::pal;

void require(bool condition, const char* observation) {
    if (!condition) throw std::runtime_error(observation);
}
bool observed(const TextGpuResourceCapture& resource, std::size_t byte) {
    for (const auto& range : resource.written_ranges)
        if (byte >= range.offset && byte - range.offset < range.bytes) return true;
    return false;
}
template<class Action> void refuses(Action action) {
    bool rejected = false;
    try { action(); } catch (const std::runtime_error&) { rejected = true; }
    require(rejected, "invalid receipt must fail before changing observed state");
}
void serialize(const char* path, const TextGpuCapture& capture) {
    std::ofstream output(path);
    JsonWriter json(output);
    write_text_gpu_capture(json, capture);
}

int main() {
    try {
        const std::array<std::uint8_t, 3> tail{41, 42, 43};
        TextGpuCapture disabled;
        require(!disabled.enabled(), "capture must be disabled by default");
        require(disabled.create_resource("unused", 16) == 0, "disabled allocation must have no ID");
        disabled.write(999, std::numeric_limits<std::size_t>::max(), tail);
        disabled.destroy(999); disabled.begin_frame(90); disabled.draw({}); disabled.stop();
        require(disabled.resources().empty() && disabled.draws().empty() && disabled.frame() == 0,
            "disabled observations must stay inert, including invalid resource IDs");

        TextGpuCapture capture(true);
        std::string role = "text-ubo";
        const auto first = capture.create_resource(role, 20);
        role.assign("caller changed role");
        require(first == 1 && capture.resources()[0].role == "text-ubo", "resource role must be copied");
        require(capture.resources()[0].uploaded_bytes.empty() && capture.resources()[0].written_ranges.empty(),
            "allocation alone observes no bytes");
        capture.begin_frame(7);
        {
            std::array<std::uint8_t, 3> input{11, 12, 13};
            capture.write(first, 4, input);
            input.fill(255);
        }
        require(capture.resources()[0].uploaded_bytes[4] == 11 && capture.resources()[0].uploaded_bytes[6] == 13,
            "receipt must retain a copy after the source buffer mutates and expires");
        for (std::size_t byte = 0; byte < 20; ++byte)
            require(observed(capture.resources()[0], byte) == (byte >= 4 && byte < 7),
                "unwritten leading and trailing gaps must remain unobserved");
        capture.write(first, 12, tail);
        const std::array<std::uint8_t, 4> overlap{21, 22, 23, 24};
        capture.write(first, 6, overlap);
        const auto& partial = capture.resources()[0];
        require(partial.written_ranges.size() == 2 && partial.written_ranges[0].offset == 4 &&
            partial.written_ranges[0].bytes == 6 && partial.written_ranges[1].offset == 12 && partial.written_ranges[1].bytes == 3,
            "overlap must merge covered bytes without claiming the gap");
        require(partial.uploaded_bytes[5] == 12 && partial.uploaded_bytes[6] == 21 && partial.uploaded_bytes[9] == 24 &&
            partial.uploaded_bytes[12] == 41 && !observed(partial, 10) && !observed(partial, 11),
            "overlap must overwrite only its actual range");
        serialize("partial.json", capture);
        const std::array<std::uint8_t, 2> bridge{31, 32};
        capture.write(first, 10, bridge);
        capture.write(first, 20, {});
        require(capture.resources()[0].written_ranges.size() == 1 && capture.resources()[0].written_ranges[0].offset == 4 &&
            capture.resources()[0].written_ranges[0].bytes == 11 && capture.resources()[0].uploaded_bytes.size() == 15,
            "adjacent writes merge, while a zero-byte receipt does not fill unknown memory");
        require(capture.resources()[0].writes.size() == 5 && capture.resources()[0].writes[4].sequence == 5 &&
            capture.resources()[0].writes[4].frame == 7 && capture.resources()[0].writes[4].offset == 20 && !capture.resources()[0].writes[4].bytes,
            "receipt history must preserve zero-length writes and source frame/order");
        const auto beforeInvalid = capture.resources()[0].uploaded_bytes;
        refuses([&] { capture.write(first, 19, tail); });
        refuses([&] { capture.write(first, std::numeric_limits<std::size_t>::max(), tail); });
        refuses([&] { capture.write(0, 0, tail); });
        refuses([&] { capture.destroy(999); });
        require(capture.resources()[0].writes.size() == 5 && capture.resources()[0].uploaded_bytes == beforeInvalid,
            "invalid ranges must not publish receipts or mutate bytes");

        const auto second = capture.create_resource("text-ubo", 20);
        const auto instances = capture.create_resource("text-instances", 96);
        const auto otherInstances = capture.create_resource("text-instances", 96);
        const auto atlas = capture.create_resource("text-curves", 65536, 4096, 1);
        capture.write(second, 0, tail);
        require(capture.resources()[1].writes[0].sequence == 6 && capture.resources()[1].writes[0].frame == 7,
            "write ordering must span allocations and exclude failed receipts");
        require(capture.resources()[4].id == atlas && capture.resources()[4].width == 4096 && capture.resources()[4].rows == 1,
            "texture allocation extents and IDs must survive independent buffer creation");

        TextGpuDrawCapture draw;
        draw.pipeline = 0x100000065ULL; draw.group = 201; draw.quad = 301; draw.instances = instances;
        draw.color_format = "rgba8unorm"; draw.depth_format = "depth24plus"; draw.depth_compare = "greater_equal";
        draw.topology = "triangle-list"; draw.cull_mode = "none"; draw.front_face = "ccw";
        draw.samples = 4; draw.depth_write = true; draw.alpha_to_coverage = true;
        draw.vertex_constants = {{3, 1.2345678901234567}, {5, -0.0}};
        draw.fragment_constants = {{0, 1.0000000000000002}};
        draw.bindings = {{0, "text-ubo", first, 0}, {1, "text-curves", atlas, 401}};
        draw.vertices = 6; draw.instance_count = 3; draw.first_instance = 2;
        draw.pushed_uniform_bytes = {1, 2, 3, 4};
        capture.draw(draw);
        // A second renderable has its own instances, but its data-owned group
        // still references the first UBO. Capture receives those actual IDs.
        draw.instances = otherInstances; draw.pushed_uniform_bytes[0] = 8;
        capture.draw(draw);
        draw.bindings[0].resource = second; draw.fragment_constants[0].value = 0;
        draw.color_format.clear(); draw.pushed_uniform_bytes.clear();
        require(capture.draws().size() == 2 && capture.draws()[0].bindings[0].resource == first &&
            capture.draws()[1].bindings[0].resource == first && capture.draws()[1].instances == otherInstances,
            "draw snapshots must retain the actual first group owner, not infer it from the later renderable");
        require(capture.draws()[0].pushed_uniform_bytes[0] == 1 && capture.draws()[1].pushed_uniform_bytes[0] == 8 &&
            capture.draws()[0].fragment_constants[0].value == 1.0000000000000002 && capture.draws()[0].vertex_constants[0].id == 3 &&
            capture.draws()[0].color_format == "rgba8unorm" && capture.draws()[0].depth_write && !capture.draws()[0].blend_enabled &&
            capture.draws()[0].alpha_to_coverage && capture.draws()[0].samples == 4 && capture.draws()[0].first_instance == 2,
            "pipeline, range and uniform observations must be independent immutable snapshots");
        serialize("frame7.json", capture);
        require(capture.enabled() && capture.frame() == 7 && capture.draws().size() == 2,
            "JSON serialization must observe receipts without rerunning or mutating collection");
        const auto savedFrame = capture.draws();
        capture.destroy(first); capture.destroy(first);
        const auto replacement = capture.create_resource("text-ubo", 20);
        require(replacement == 6 && capture.resources()[0].id == first && capture.resources()[0].destroyed &&
            capture.resources()[0].uploaded_bytes == beforeInvalid && !capture.resources().back().destroyed &&
            capture.resources().back().written_ranges.empty(), "destruction/replacement must preserve old IDs and observed state");
        capture.begin_frame(8);
        require(capture.draws().empty() && savedFrame.size() == 2 && savedFrame[1].bindings[0].resource == first &&
            capture.resources()[0].writes.size() == 5, "begin_frame replaces only draw receipts, not allocation/write history");
        draw.bindings[0].resource = replacement;
        draw.pipeline = 102; draw.color_format = "bgra8unorm";
        draw.samples = 1; draw.alpha_to_coverage = false; draw.blend_enabled = true;
        draw.color_src_factor = draw.alpha_src_factor = "one";
        draw.color_dst_factor = draw.alpha_dst_factor = "one-minus-src-alpha";
        draw.color_operation = draw.alpha_operation = "add";
        capture.draw(draw); capture.write(replacement, 0, bridge);
        require(capture.resources().back().writes[0].sequence == 7 && capture.resources().back().writes[0].frame == 8,
            "later-frame writes must keep global receipt order");
        capture.stop(); capture.stop();
        require(!capture.enabled() && capture.create_resource("ignored", 100) == 0, "stop prevents later allocations");
        capture.begin_frame(9); capture.write(999, 999, tail); capture.destroy(replacement); capture.draw({});
        require(capture.frame() == 8 && capture.draws().size() == 1 && capture.resources().size() == 6 &&
            !capture.resources().back().destroyed && capture.resources().back().writes.size() == 1,
            "stopped recorder must preserve its serialized frame and ignore all later operations");
        serialize("stopped.json", capture);
        std::cout << "text GPU capture receipt contract passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
