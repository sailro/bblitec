#define BBLITE_HAS_PBR_RENDERER 1
#define BBLITE_GPU_INSTANCING 1
#define BBLITE_FLOATING_ORIGIN 0
#define BBLITE_GPU_DEFORMATION 0
#include "matrix.hpp"
#include "world.hpp"
#include <cassert>
#include <cstring>
#include "geometry.hpp"
namespace bbl::upstream { enum class RenderMaterialKind { standard, shader }; }
namespace bbl::pal {
#include "shader-consumers.hpp"
unsigned writes = 0;
struct Buffer { std::vector<GpuVertex> vertices; };
void write(Buffer* buffer, const void* data, std::size_t size) {
    assert(size % sizeof(GpuVertex) == 0); ++writes;
    buffer->vertices.resize(size / sizeof(GpuVertex)); std::memcpy(buffer->vertices.data(), data, size);
}
void wgpuQueueWriteBuffer(int, Buffer* buffer, std::size_t offset, const void* data, std::size_t size) { assert(offset == 0); write(buffer, data, size); }
struct Uploads { void update(Buffer* buffer, const void* data, std::size_t size) { write(buffer, data, size); } };
struct Uploaded { Buffer* vertices; std::uint64_t transform_version = 0; bool gpu_world_transform = false; };
struct Driver {
    Engine engine;
    std::vector<Uploaded> uploaded;
    struct Item { std::size_t geometry = 0; upstream::RenderMaterialKind material_kind = upstream::RenderMaterialKind::standard; };
    std::vector<Item> items;
    struct { int queue = 0; } state;
    Uploads frame_buffer_uploads;
    unsigned profile_transformed_meshes = 0; std::size_t profile_transformed_vertices = 0;
};
struct Sdl : Driver {
#include "SdlTransforms.hpp"
};
struct Dawn : Driver {
#include "DawnTransforms.hpp"
};
void check_position(const GpuVertex& vertex, float x, float y, float z) {
    assert(std::abs(vertex.position[0] - x) < 1e-5f && std::abs(vertex.position[1] - y) < 1e-5f && std::abs(vertex.position[2] - z) < 1e-5f);
}
void check_shared_geometry() {
    struct Shared {
        SharedGeometryIdentity identity;
        std::vector<GpuVertex> vertices;
        std::vector<std::uint32_t> indices;
        MaterialHandle material{3};
    };
    std::vector<GpuVertex> vertices(3); vertices[0].position[0] = 2;
    const std::vector<std::uint32_t> indices{0,1,2};
    const auto identity = shared_geometry_identity(vertices, indices);
    std::vector<std::unique_ptr<Shared>> cache;
    cache.push_back(std::make_unique<Shared>(Shared{identity, vertices, indices}));
    assert(shared_geometry_keeps_bytes(vertices));
    assert(find_shared_shader_geometry(cache, identity, vertices, indices) == cache[0].get());
    vertices[0].position[0] = 3;
    assert(!find_shared_shader_geometry(cache, identity, vertices, indices)); // Retained bytes reject a hash collision.
    assert(shared_geometry_identity(vertices, indices).hash != identity.hash);
    assert(find_shared_shader_material_textures(cache, MaterialHandle{3}) == cache[0].get());
    assert(!find_shared_shader_material_textures(cache, MaterialHandle{4}));
    vertices.resize(shared_geometry_bytes_kept_below);
    assert(!shared_geometry_keeps_bytes(vertices));
    cache[0]->identity = shared_geometry_identity(vertices, indices); cache[0]->vertices.clear(); cache[0]->indices.clear();
    assert(find_shared_shader_geometry(cache, cache[0]->identity, vertices, indices) == cache[0].get());
}
void check_shader_blocks() {
    Engine engine; engine.meshes.resize(1); engine.meshes[0].position = {10,20,30};
    const std::array<float, 16> view{2,0,0,0, 0,3,0,0, 0,0,4,0, -1,-2,-3,1};
    const std::array<float, 16> projection{5,0,0,0, 0,6,0,0, 0,0,7,0, 8,9,10,1};
    const auto vp = upstream::matrix_product(projection, view);
    const std::array<float, 4> camera{1,2,3,0};
    ShaderPassMatrices pass{vp.data(), &view, &projection}; pass.camera_position = &camera;
    using Matrix = upstream::ShaderSystemMatrix;
    upstream::ShaderVariantStageBlock block{true, {Matrix::world, Matrix::world_view, Matrix::world_view_projection, Matrix::camera_position}, 56, {{52,2,2}}};
    MaterialRecord material; material.shader_uniform_values = {6,7,8,9};
    std::vector<float> reference;
    for (const auto pack : packers) {
        const auto values = pack(engine, pass, block, material);
        assert(values.size() == 56 && values[12] == 10 && values[13] == 20 && values[14] == 30);
        assert(values[28] == 19 && values[29] == 58 && values[30] == 117);
        assert(values[44] == 103 && values[45] == 357 && values[46] == 829);
        assert(values[48] == 1 && values[49] == 2 && values[50] == 3 && values[51] == 0);
        assert(values[52] == 8 && values[53] == 9 && values[54] == 0 && values[55] == 0);
        if (!reference.empty()) assert(values == reference); reference = values;
        auto missing_view = pass; missing_view.view = nullptr; bool refused = false;
        try { pack(engine, missing_view, block, material); }
        catch (const std::runtime_error&) { refused = true; }
        assert(refused);
    }
    for (const auto matrix : {Matrix::world, Matrix::world_view, Matrix::world_view_projection, Matrix::view, Matrix::projection, Matrix::view_projection, Matrix::camera_position}) {
        block.system_matrices = {matrix}; block.gather.clear();
        assert(block_is_shared_scene_matrix(block) == (matrix == Matrix::view_projection));
    }
    block.gather = {{16,0,1}}; assert(!block_is_shared_scene_matrix(block));
}
template<class Backend> void check_uploads() {
    Backend driver; writes = 0;
    ModelGeometry geometry; ModelVertex vertex; vertex.position = {1,2,3}; vertex.normal = {0,1,0}; geometry.vertices.push_back(vertex);
    driver.engine.geometries.push_back(geometry); driver.engine.meshes.resize(3);
    std::array<Buffer, 3> buffers;
    for (std::size_t index = 0; index < 3; ++index) {
        driver.uploaded.push_back({&buffers[index]}); driver.items.emplace_back();
        driver.engine.meshes[index].position = {10,20,30}; driver.engine.meshes[index].transform_version = 1;
    }
    driver.items[0].material_kind = upstream::RenderMaterialKind::shader;
    driver.engine.meshes[1].gpu_world_transform = true;
    driver.synchronize();
    assert(writes == 2); // Shader has immutable local upload; physics switches its old baked upload once.
    check_position(buffers[1].vertices[0], 1,2,3); check_position(buffers[2].vertices[0], 11,22,33);
    for (auto& mesh : driver.engine.meshes) { mesh.position.x += 5; ++mesh.transform_version; }
    driver.synchronize(); assert(writes == 3);
    check_position(buffers[1].vertices[0], 1,2,3); check_position(buffers[2].vertices[0], 16,22,33);
    for (std::size_t index = 0; index < 3; ++index) assert(driver.uploaded[index].transform_version == 2);
    driver.synchronize(); assert(writes == 3);
}
}
int main() {
    using namespace bbl; using namespace bbl::pal;
    Engine engine; ModelGeometry geometry; ModelVertex local;
    local.position = {1,2,3}; local.normal = {0,1,0}; local.tangent = {1,0,0,-1}; local.local_position = {-1,2,3};
    local.uv = {.2f,.3f}; local.uv2 = {.4f,.5f}; local.color = {.6f,.7f,.8f,.9f};
    geometry.bind_vertices = {local}; geometry.vertices = {local}; geometry.vertices[0].position = {101,202,303};
    geometry.vertex_space = VertexSpace::world;
    MeshRecord mesh; mesh.position = {10,20,30};
    check_position(transformed_vertices(engine, geometry, mesh)[0],111,222,333);
    mesh.thin_instanced = true;
    const auto pooled = transformed_vertices(engine, geometry, mesh);
    check_position(pooled[0],1,2,3);
    assert(pooled[0].uv[0] == .2f && pooled[0].uv2[1] == .5f && pooled[0].color[3] == .9f && pooled[0].tangent[3] == -1);
    geometry.bind_vertices.clear(); check_position(transformed_vertices(engine, geometry, mesh)[0],101,202,303);
    geometry.bind_vertices = {local}; mesh.thin_instanced = false; mesh.live_imported_transform = true; mesh.gpu_world_transform = true;
    check_position(transformed_vertices(engine, geometry, mesh)[0],1,2,3);
    geometry.vertex_space = VertexSpace::local; geometry.vertices = {local};
    check_position(local_vertices(engine, geometry, &mesh)[0],1,2,3);
    const auto world = shader_draw_world(engine, mesh); assert(world[12] == 10 && world[13] == 20 && world[14] == 30);
    mesh.outer_position = {5,6,7}; const auto moved = shader_draw_world(engine, mesh); assert(moved[12] == 15 && moved[13] == 26 && moved[14] == 37);
    geometry.vertex_space = VertexSpace::world; engine.geometries.push_back(geometry); engine.meshes.resize(2);
    auto& wheel = engine.meshes[0]; wheel.geometry = 0; wheel.name = "wheel_front";
    wheel.instance_parent_matrix = {2,0,0,0, 0,3,0,0, 0,0,4,0, 10,20,30,1};
    wheel.parented_meshes.push_back(MeshHandle{1});
    set_mesh_rotation_quaternion(engine, MeshHandle{0}, {.1f,.2f,.3f,.9f}, true);
    assert(wheel.live_imported_transform && wheel.gpu_world_transform && engine.meshes[1].gpu_world_transform);
    assert(wheel.position.x == 10 && wheel.position.y == 20 && wheel.position.z == 30);
    assert(wheel.scaling.x == 2 && wheel.scaling.y == 3 && wheel.scaling.z == 4);
    assert(wheel.rotation_quaternion.x == .1f && wheel.rotation_quaternion.y == -.2f && wheel.rotation_quaternion.z == -.3f && wheel.rotation_quaternion.w == .9f);
    const auto version = wheel.transform_version; wheel.position.x = 50;
    set_mesh_rotation_quaternion(engine, MeshHandle{0}, {0,0,0,1}, false);
    assert(wheel.position.x == 50 && wheel.transform_version == version + 1);
    check_position(transformed_vertices(engine, engine.geometries[0], wheel)[0],1,2,3);
    check_uploads<Sdl>(); check_uploads<Dawn>(); check_shared_geometry(); check_shader_blocks();
}
