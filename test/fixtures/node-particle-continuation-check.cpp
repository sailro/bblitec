#include <bblite/upstream/node_particles.hpp>
#include <bblite/pal_image.hpp>
#include <algorithm>
#include <cassert>
#include <iostream>
#include "expected.hpp"

namespace bbl {
std::string asset_path(const std::string& path) { return path; }
namespace pal {
std::vector<std::uint8_t> read_binary_file(const std::string&) { return {}; }
DecodedImage decode_image(std::span<const std::uint8_t>) { return {128, 64, {}}; }
} // namespace pal
} // namespace bbl

int main(int argc, char** argv) {
    using namespace bbl;
    using namespace bbl::upstream;
    assert(argc == 2);
    const bool small = argv[1][0] == '1';
    const double width = small ? 800 : 1280;
    const double height = small ? 600 : 720;
    Engine engine;
    const auto renderer = create_sprite_renderer(engine, {});
    for (int set : {0, 1}) {
        write_node_particle_column(set, 0, "posX", 0, ((set + 1) * 100 - width * 0.5) / 220);
        write_node_particle_column(set, 0, "posY", 0, (height * 0.72 - 96) / 220);
        write_node_particle_column(set, 0, "size", 0, 64.0 / 220);
        write_node_particle_column(set, 0, "scaleX", 0, 1);
        write_node_particle_column(set, 0, "scaleY", 0, 1);
        write_node_particle_column(set, 0, "age", 599, 0.123456789012345);
        write_node_particle_column(set, 0, "id", 599, -1);
        write_node_particle_column(set, 0, "posX", 600, 9);
        assert(!node_particle_frozen_column(set, 0, "posX", 600).has_value());
        assert(node_particle_frozen_column(set, 0, "age", 599).value() == 0.123456789012345);
        assert(node_particle_frozen_column(set, 0, "id", 599).value() == 4294967295.0);
    }
    register_node_particle_set_2d(engine, renderer, 0,
                                  std::array<double, 2>{width * 0.5, height * 0.72});
    auto& record = engine.sprite_renderers[renderer.value];
    assert(record.layers.size() == 3 && record.before_update.size() == 1);
    const auto check = [&](const std::vector<float>& first, const std::vector<float>& second,
                           int count) {
        for (std::size_t i = 0; i < 3; ++i) {
            const auto& expected = i == 0 ? first : second;
            const auto& layer = engine.sprite_layers[record.layers[i].value];
            assert(layer.count == static_cast<std::uint32_t>(count));
            assert(std::equal(expected.begin(), expected.end(), layer.instance_data.begin()));
        }
    };
    check(small ? expected_1_0_0 : expected_0_0_0, small ? expected_1_1_0 : expected_0_1_0, 90);
    record.before_update[0](1000.0 / 60.0);
    check(small ? expected_1_0_0 : expected_0_0_0, small ? expected_1_1_0 : expected_0_1_0, 90);
    for (int set : {0, 1})
        write_node_particle_column(set, 0, "lifeTime", 0, 0);
    record.before_update[0](1000.0 / 60.0);
    check(small ? expected_1_0_1 : expected_0_0_1, small ? expected_1_1_1 : expected_0_1_1, 89);
    assert(node_particle_frozen_alive(0, 0) == 89 && node_particle_frozen_alive(1, 0) == 89);
    std::cout << "continuation-check: ok\n";
}
