#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/splat_geometry.hpp>
#include <bblite/upstream/splat_bake.hpp>
#include <fstream>
#include <iostream>
#include <iterator>

static void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

static std::vector<std::uint8_t> read(const std::string& path) {
    std::ifstream stream(path, std::ios::binary);
    require(stream.is_open(), "fixture input missing");
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    return read(path);
}
}

static void expect_geometry(const bbl::SplatMeshRecord& mesh, const std::string& path) {
    const auto expected = read(path);
    std::size_t offset = 0;
    const auto compare = [&](const void* data, std::size_t length) {
        require(offset + length <= expected.size(), "geometry size");
        require(std::memcmp(expected.data() + offset, data, length) == 0, "geometry differs from pin");
        offset += length;
    };
    const std::array<std::uint32_t, 3> shape{mesh.vertex_count, mesh.texture_width, mesh.texture_height};
    compare(shape.data(), sizeof(shape));
    compare(mesh.bound_min.data(), sizeof(mesh.bound_min));
    compare(mesh.bound_max.data(), sizeof(mesh.bound_max));
    compare(mesh.positions.data(), mesh.positions.size() * sizeof(float));
    for (const auto* payload : bbl::upstream::splat_texture_payloads(mesh)) {
        compare(payload->data(), payload->size() * sizeof(float));
    }
    require(offset == expected.size(), "geometry trailing bytes");
}

int main(int argc, char** argv) {
    require(argc == 2, "fixture directory argument");
    const std::string directory = argv[1];
    const auto path = [&](const char* name) { return directory + "/" + name + ".bin"; };
    bbl::Engine engine;
    const auto handle = bbl::create_gaussian_splatting_mesh(engine, "cloud", read(path("initial")));
    auto& mesh = engine.splat_meshes[handle.value];
    auto original = bbl::splat_data(engine, handle);
    require(original.data() == mesh.splats_data->data(), "getter copied bytes");
    expect_geometry(mesh, path("stage0"));
    const auto mutated = read(path("mutated"));
    std::memcpy(original.data(), mutated.data(), mutated.size());
    expect_geometry(mesh, path("stage0"));
    require(mesh.data_version == 0, "buffer write published data");
    bbl::update_splat_data(engine, handle, original);
    require(mesh.data_version == 1 && mesh.splats_data->data() == original.data(), "same-buffer update identity/version");
    expect_geometry(mesh, path("stage1"));
    const bbl::js::ArrayBuffer replacement(read(path("replacement")));
    bbl::update_splat_data(engine, handle, replacement);
    require(mesh.data_version == 2 && mesh.splats_data->data() == replacement.data(), "replacement identity/version");
    require(original.byte_length() == mutated.size() && std::memcmp(original.data(), mutated.data(), mutated.size()) == 0, "old alias changed");
    expect_geometry(mesh, path("stage2"));
    for (const auto length : {96u, 0u, 65u}) {
        bool caught = false;
        try {
            bbl::update_splat_data(engine, handle, bbl::js::ArrayBuffer(std::vector<std::uint8_t>(length)));
        } catch (const std::runtime_error& error) {
            caught = true;
            if (length == 96u) require(std::string(error.what()) == "GS vertex count mismatch", "count diagnostic");
            if (length == 0u) require(std::string(error.what()) == "splat buffer is empty", "empty diagnostic");
        }
        require(caught, "invalid update accepted");
        require(mesh.data_version == 2 && mesh.splats_data->data() == replacement.data(), "rejection published state");
        expect_geometry(mesh, path("stage2"));
    }
    {
        // ArrayBuffer can also retain typed storage. No owning-byte-vector
        // access or caller lifetime may be assumed by updateData's byte span.
        bbl::js::F32Array trailing(17);
        const auto bytes = read(path("replacement"));
        std::memcpy(trailing.data(), bytes.data(), bytes.size());
        bbl::update_splat_data(engine, handle, bbl::js::ArrayBuffer(trailing));
    }
    require(mesh.data_version == 3 && mesh.splats_data->byte_length() == 68, "aligned trailing bytes rejected");
    expect_geometry(mesh, path("stage3"));
    const auto before_bake = bbl::splat_data(engine, handle);
    const auto before_bytes = std::vector<std::uint8_t>(before_bake.data(), before_bake.data() + before_bake.byte_length());
    mesh.position = bbl::Vec3{3, 4, 5};
    mesh.scaling = bbl::Vec3{2, 2, 2};
    bbl::bake_current_transform_into_vertices(engine, handle);
    require(mesh.data_version == 4 && mesh.splats_data->data() != before_bake.data(), "bake did not replace buffer");
    require(std::memcmp(before_bake.data(), before_bytes.data(), before_bytes.size()) == 0, "bake changed retained alias");
    const auto baked = read(path("baked"));
    require(mesh.splats_data->byte_length() == baked.size() && std::memcmp(mesh.splats_data->data(), baked.data(), baked.size()) == 0, "bake bytes differ from pin");
    require(mesh.position.x == 0 && mesh.position.y == 0 && mesh.position.z == 0 && mesh.scaling.x == 1 && mesh.scaling.y == 1 && mesh.scaling.z == 1, "bake TRS reset");
    expect_geometry(mesh, path("stage4"));
    bbl::update_splat_data(engine, handle, *mesh.splats_data);
    require(mesh.data_version == 5, "self-carrier update did not commit");
    expect_geometry(mesh, path("stage4"));
    engine.splat_meshes.clear();
    require(std::memcmp(original.data(), mutated.data(), mutated.size()) == 0, "alias lost its owner");
    std::cout << "splat-data-check: ok\n";
}
