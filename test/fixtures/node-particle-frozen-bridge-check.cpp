#include <bblite/upstream/node_particles.hpp>
#include <bblite/pal_image.hpp>
#include <algorithm>
#include <cassert>
#include <iostream>
#include <limits>
#include "expected.hpp"

// Only image I/O is stubbed. Atlas construction, Sprite2D storage, renderer
// callbacks and particle bridge functions are the generated implementations.
namespace bbl {
std::string asset_path(const std::string& path) { return path; }
namespace pal {
std::vector<std::uint8_t> read_binary_file(const std::string&) { return {}; }
DecodedImage decode_image(const js::ArrayBuffer&) { return {128, 64, {}}; }
}
}

int main() {
    using namespace bbl;
    using namespace bbl::upstream;
    Engine engine;
    const auto renderer = create_sprite_renderer(engine, {});
    js::U16Array cells{0, 0, 0};
    const auto alias = cells;
    set_frozen_node_particle_sheet(0, 0, 64, 64, cells);
    cells[0] = 1;
    register_node_particle_set_2d(engine, renderer, 0);
    auto& record = engine.sprite_renderers[renderer.value];
    assert(record.layers.size() == 1);
    assert(record.before_update.size() == 1);
    auto& layer = engine.sprite_layers[record.layers[0].value];
    assert(layer.capacity == 3 && layer.count == 1);
    assert(std::equal(expected_1.begin(), expected_1.end(), layer.instance_data.begin()));
    assert(node_particle_frozen_capacity(0, 0) == 3);
    assert(node_particle_frozen_alive(0, 0) == 1);
    assert(node_particle_frozen_column(0, 0, "age", 0).value() == 0.3673999999999999);
    assert(node_particle_frozen_column(0, 0, "age", 2).value() == 0.123456789012345);
    for (double index : {-1.0, 0.5, 3.0, std::numeric_limits<double>::infinity(),
            std::numeric_limits<double>::quiet_NaN()}) {
        assert(!node_particle_frozen_column(0, 0, "age", index).has_value());
    }
    int samples = 0;
    sprite_renderer_before_update(engine, renderer, [&](double) {
        ++samples;
        assert(layer.count == 1 && node_particle_frozen_alive(0, 0) == 1);
        assert(node_particle_frozen_column(0, 0, "age", 0).value() == 0.3673999999999999);
    });
    for (int frame = 0; frame < 5; ++frame) {
        cells[0] = static_cast<std::uint16_t>(frame % 2);
        assert(alias[0] == cells[0]);
        for (auto& callback : record.before_update) callback(1000.0 / 60.0);
        const auto& expected = frame % 2 == 0 ? expected_0 : expected_1;
        assert(std::equal(expected.begin(), expected.end(), layer.instance_data.begin()));
        assert(layer.saved_size[0] == expected[2] && layer.saved_size[1] == expected[3]);
    }
    assert(samples == 5);
    cells[0] = 2;
    bool refused = false;
    try { record.before_update[0](0); } catch (const std::runtime_error&) { refused = true; }
    assert(refused);
    std::cout << "frozen-bridge-check: ok\n";
}
