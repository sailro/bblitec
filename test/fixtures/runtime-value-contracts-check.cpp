#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <cassert>
#include <iostream>
#include <type_traits>

using namespace bbl;

static_assert(std::is_same_v<ts::ArrayBuffer, js::ArrayBuffer>);
static_assert(std::is_same_v<ts::Uint8Array, js::U8Array>);
static_assert(std::is_same_v<ts::DataView, js::DataView>);

struct Point { double x, y, z; };

int main() {
    const Sprite2DLayerRecord layer;
    assert(layer.dirty_sprite_begin == invalid_handle && layer.dirty_sprite_end == 0);
    assert(layer.pipeline_version == 0);
    const BillboardSystemRecord billboard;
    assert(billboard.instance_version == 0);
    const std::vector<double> values{-1.9, 65537.9, 3.5};
    assert(js::array_length(values) == 3.0);
    const auto bytes = js::u8_array_from(values);
    const auto shorts = js::u16_array_from(values);
    const auto words = js::u32_array_from(values);
    const auto floats = js::f32_array_from(values);
    assert(bytes[0] == 255 && bytes[1] == 1 && bytes[2] == 3);
    assert(shorts[0] == 65535 && shorts[1] == 1);
    assert(words[0] == 4294967295u && words[1] == 65537u);
    assert(floats[2] == 3.5f);
    assert(js::array_length(js::u8_array_from(std::vector<double>{})) == 0.0);

    const std::vector<Point> points{{1.25, 2.5, 3.75}, {-4, -5, -6}};
    std::vector<js::Ref<Point>> references;
    for (const auto& point : points) references.push_back(js::make_ref<Point>(point));
    const auto direct = vec3_path(points);
    const auto indirect = vec3_path(references);
    assert(direct.size() == 2 && indirect.size() == 2);
    for (std::size_t i = 0; i < direct.size(); ++i) {
        assert(direct[i].x == indirect[i].x && direct[i].y == indirect[i].y && direct[i].z == indirect[i].z);
    }
    references[0]->x = 9;
    assert(vec3_path(references)[0].x == 9 && vec3_path(points)[0].x == 1.25);

    {
        Scene scene;
        Scene copied = scene;
        Scene assigned;
        assert(!assigned.shares_identity(scene));
        assigned = scene;
        copied.fixed_delta_ms = 12.5;
        assert(assigned.shares_identity(scene) && assigned.fixed_delta_ms == 12.5);
        int called = 0;
        copied.disposables.push_back([&] { ++called; });
        assigned.disposables.front()();
        assert(called == 1 && scene.disposables.size() == 1);
        assigned.disposed = true;
        assert(scene.disposed && copied.disposed);
    }
    const auto nodes = js::managed_node_count();
    {
        Scene scene;
        scene.disposables.push_back(js::make_closure(std::tuple{scene}, [](auto& captures) {
            std::get<0>(captures).disposed = true;
        }));
        assert(js::collect_cycles() == 0);
        scene.disposables.front()();
        assert(scene.disposed);
    }
    assert(js::collect_cycles() > 0);
    assert(js::managed_node_count() == nodes);

    SharedTextureBytes original{std::vector<std::uint8_t>{1, 2, 3}};
    auto copied = original;
    assert(std::as_const(original).data() == std::as_const(copied).data());
    copied[0] = 9;
    assert(std::as_const(original)[0] == 1 && std::as_const(copied)[0] == 9);
    assert(std::as_const(original).data() != std::as_const(copied).data());
    TextureData texture;
    texture.bytes = original;
    assert(std::as_const(texture.bytes).data() == std::as_const(original).data());

    js::Tuple<3> tuple{1, 2, 3};
    auto alias = tuple;
    auto clone = js::clone_tuple(tuple);
    alias[1] = 7;
    assert(tuple[1] == 7 && clone[1] == 2);

    js::Array<double> range{1, 2, 3, 4, 5};
    js::array_fill_range(range, 9.0, -3.8, -1.2);
    assert(range[1] == 2 && range[2] == 9 && range[3] == 9 && range[4] == 5);
    js::array_copy_within(range, 1.9, 0.0, 4.0);
    assert(range[0] == 1 && range[1] == 1 && range[2] == 2 && range[3] == 9 && range[4] == 9);
    const auto tail = js::array_slice(range, -2.9, std::numeric_limits<double>::infinity());
    assert(tail.size() == 2 && tail[0] == 9 && tail[1] == 9);
    js::array_fill_range(range, 8.0, std::numeric_limits<double>::quiet_NaN(), -4.0);
    assert(range[0] == 8 && range[1] == 1);
    std::cout << "runtime-value-contracts: ok\n";
}
