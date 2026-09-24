#define BBLITE_GPU_INSTANCING 1
#define BBLITE_GPU_MORPH_STORAGE 0
#define BBLITE_PBR_VARIANTS 0
#define BBLITE_NODE_GEOMETRY_VARIANTS 0
#define BBLITE_FLOATING_ORIGIN 0
#define BBLITE_GPU_DEFORMATION 0
#include "matrix.hpp"
#include "world.hpp"
#include <cassert>
#include <cstring>
#include "geometry.hpp"
namespace bbl::upstream {
enum class RenderMaterialKind { standard, shader };
}
namespace bbl::pal {
#include "shader-consumers.hpp"
unsigned writes = 0;
struct Buffer {
    std::vector<GpuVertex> vertices;
};
void write(Buffer* buffer, const void* data, std::size_t size) {
    assert(size % sizeof(GpuVertex) == 0);
    ++writes;
    buffer->vertices.resize(size / sizeof(GpuVertex));
    std::memcpy(buffer->vertices.data(), data, size);
}
void wgpuQueueWriteBuffer(int, Buffer* buffer, std::size_t offset, const void* data,
                          std::size_t size) {
    assert(offset == 0);
    write(buffer, data, size);
}
struct Uploads {
    void update(Buffer* buffer, const void* data, std::size_t size) { write(buffer, data, size); }
};
struct Uploaded {
    Buffer* vertices;
    std::uint64_t position_version = 0;
};
struct Driver {
    Engine engine;
    std::vector<Uploaded> uploaded;
    struct Item {
        std::size_t geometry = 0;
    };
    std::vector<Item> items;
    struct {
        int queue = 0;
    } state;
    Uploads frame_buffer_uploads;
};
struct Sdl : Driver {
#include "SdlTransforms.hpp"
};
struct Dawn : Driver {
#include "DawnTransforms.hpp"
};
void check_position(const GpuVertex& vertex, float x, float y, float z) {
    assert(vertex.position[0] == x && vertex.position[1] == y && vertex.position[2] == z);
}
void check_shared_geometry() {
    struct Shared {
        SharedGeometryIdentity identity;
        std::vector<GpuVertex> vertices;
        std::vector<std::uint32_t> indices;
        MaterialHandle material{3};
    };
    std::vector<GpuVertex> vertices(3);
    vertices[0].position[0] = 2;
    const std::vector<std::uint32_t> indices{0, 1, 2};
    const auto identity = shared_geometry_identity(vertices, indices);
    std::vector<std::unique_ptr<Shared>> cache;
    cache.push_back(std::make_unique<Shared>(Shared{identity, vertices, indices}));
    assert(shared_geometry_keeps_bytes(vertices));
    assert(find_shared_shader_geometry(cache, identity, vertices, indices) == cache[0].get());
    vertices[0].position[0] = 3;
    assert(!find_shared_shader_geometry(cache, identity, vertices,
                                        indices)); // Retained bytes reject a hash collision.
    assert(shared_geometry_identity(vertices, indices).hash != identity.hash);
    assert(find_shared_shader_material_textures(cache, MaterialHandle{3}) == cache[0].get());
    assert(!find_shared_shader_material_textures(cache, MaterialHandle{4}));
    vertices.resize(shared_geometry_bytes_kept_below);
    assert(!shared_geometry_keeps_bytes(vertices));
    cache[0]->identity = shared_geometry_identity(vertices, indices);
    cache[0]->vertices.clear();
    cache[0]->indices.clear();
    assert(find_shared_shader_geometry(cache, cache[0]->identity, vertices, indices) ==
           cache[0].get());
}
void check_shader_blocks() {
    Engine engine;
    engine.meshes.resize(1);
    engine.meshes[0].position = {10, 20, 30};
    const std::array<float, 16> view{2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, -1, -2, -3, 1};
    const std::array<float, 16> projection{5, 0, 0, 0, 0, 6, 0, 0, 0, 0, 7, 0, 8, 9, 10, 1};
    const auto vp = upstream::matrix_product(projection, view);
    const std::array<float, 4> camera{1, 2, 3, 0};
    ShaderPassMatrices pass{vp.data(), &view, &projection};
    pass.camera_position = &camera;
    using Matrix = upstream::ShaderSystemMatrix;
    upstream::ShaderVariantStageBlock block{
        true,
        {Matrix::world, Matrix::world_view, Matrix::world_view_projection, Matrix::camera_position},
        56,
        {{52, 2, 2}}};
    MaterialRecord material;
    material.shader_uniform_values = {6, 7, 8, 9};
    std::vector<float> reference;
    for (const auto pack : packers) {
        const auto values = pack(engine, pass, block, material);
        assert(values.size() == 56 && values[12] == 10 && values[13] == 20 && values[14] == 30);
        assert(values[28] == 19 && values[29] == 58 && values[30] == 117);
        assert(values[44] == 103 && values[45] == 357 && values[46] == 829);
        assert(values[48] == 1 && values[49] == 2 && values[50] == 3 && values[51] == 0);
        assert(values[52] == 8 && values[53] == 9 && values[54] == 0 && values[55] == 0);
        if (!reference.empty())
            assert(values == reference);
        reference = values;
        auto missing_view = pass;
        missing_view.view = nullptr;
        bool refused = false;
        try {
            pack(engine, missing_view, block, material);
        } catch (const std::runtime_error&) {
            refused = true;
        }
        assert(refused);
    }
    for (const auto matrix :
         {Matrix::world, Matrix::world_view, Matrix::world_view_projection, Matrix::view,
          Matrix::projection, Matrix::view_projection, Matrix::camera_position}) {
        block.system_matrices = {matrix};
        block.gather.clear();
        assert(block_is_shared_scene_matrix(block) == (matrix == Matrix::view_projection));
    }
    block.gather = {{16, 0, 1}};
    assert(!block_is_shared_scene_matrix(block));
}
template <class Backend> void check_uploads() {
    Backend driver;
    writes = 0;
    ModelGeometry geometry;
    ModelVertex vertex;
    vertex.position = {1, 2, 3};
    vertex.normal = {0, 1, 0};
    geometry.vertices.push_back(vertex);
    driver.engine.geometries.push_back(geometry);
    driver.engine.meshes.resize(2);
    std::array<Buffer, 2> buffers;
    for (std::size_t index = 0; index < 2; ++index) {
        driver.uploaded.push_back({&buffers[index]});
        driver.items.emplace_back();
        driver.engine.meshes[index].position = {10, 20, 30};
    }
    driver.synchronize();
    assert(writes == 0);
    // A transform reaches the draw through the mesh block alone.
    for (std::size_t index = 0; index < 2; ++index) {
        driver.engine.meshes[index].position.x += 5;
        set_mesh_rotation_quaternion(driver.engine, MeshHandle{static_cast<std::uint32_t>(index)},
                                     {0, 0.6f, 0, 0.8f});
    }
    driver.synchronize();
    assert(writes == 0);
    // A position update re-uploads the geometry's lanes, untransformed.
    driver.engine.geometries[0].vertices[0].position = {4, 5, 6};
    ++driver.engine.geometries[0].position_version;
    driver.synchronize();
    assert(writes == 2);
    check_position(buffers[0].vertices[0], 4, 5, 6);
    check_position(buffers[1].vertices[0], 4, 5, 6);
    driver.synchronize();
    assert(writes == 2);
}
} // namespace bbl::pal
int main() {
    using namespace bbl;
    using namespace bbl::pal;
    Engine engine;
    ModelGeometry geometry;
    ModelVertex local;
    local.position = {1, 2, 3};
    local.normal = {-0.0f, 1, 0};
    local.tangent = {1, 0, 0, -1};
    local.uv = {.2f, .3f};
    local.uv2 = {.4f, .5f};
    local.color = {.6f, .7f, .8f, .9f};
    geometry.vertices = {local};
    MeshRecord mesh;
    mesh.position = {10, 20, 30};
    // The pin uploads the source lanes whatever the mesh's transform.
    const auto packed = mesh_gpu_vertices(geometry, mesh);
    check_position(packed[0], 1, 2, 3);
    assert(std::memcmp(packed[0].normal, &local.normal, sizeof(packed[0].normal)) == 0);
    assert(packed[0].uv[0] == .2f && packed[0].uv2[1] == .5f && packed[0].color[3] == .9f &&
           packed[0].tangent[3] == -1);
    const Scene scene{};
    const auto world = mesh_block_world(scene, engine, mesh);
    assert(world[12] == 10 && world[13] == 20 && world[14] == 30);
    mesh.outer_position = {5, 6, 7};
    const auto moved = mesh_block_world(scene, engine, mesh);
    assert(moved[12] == 15 && moved[13] == 26 && moved[14] == 37);
    // No mesh name selects a quaternion convention: the write is the pin's
    // `rotationQuaternion` store and the dirty mark, for every mesh.
    engine.meshes.resize(2);
    auto& named = engine.meshes[0];
    named.name = "wheel_front";
    named.position = {10, 20, 30};
    named.scaling = {2, 3, 4};
    named.parented_meshes.push_back(MeshHandle{1});
    const auto version = named.transform_version;
    const auto child_version = engine.meshes[1].transform_version;
    set_mesh_rotation_quaternion(engine, MeshHandle{0}, {.1f, .2f, .3f, .9f});
    assert(named.has_rotation_quaternion && named.rotation_quaternion.x == .1f &&
           named.rotation_quaternion.y == .2f && named.rotation_quaternion.z == .3f &&
           named.rotation_quaternion.w == .9f);
    assert(named.position.x == 10 && named.position.y == 20 && named.position.z == 30);
    assert(named.scaling.x == 2 && named.scaling.y == 3 && named.scaling.z == 4);
    assert(named.transform_version == version + 1 &&
           engine.meshes[1].transform_version == child_version + 1);
    check_uploads<Sdl>();
    check_uploads<Dawn>();
    check_shared_geometry();
    check_shader_blocks();
}
