import { GLTF_MESH_WALKS } from "../../gltf-document.js";

/**
 * The generated `.babylon` loader.
 *
 * `lightMeshLists` mirrors what the asset declares: a light carries
 * `includedOnlyMeshesIds` or `excludedMeshesIds` naming the meshes it lights,
 * which the pinned engine keeps as a per-mesh light set. A file whose lights
 * name neither emits this loader without the resolution.
 */
export interface BabylonLoaderLoweredSegments {
    /**
     * `bake_local_matrix`, lowered whole from
     * `src/loader-babylon/bake-local-matrix.ts#bakeLocalMatrix`.
     */
    bakeLocalMatrix: string;
    materialProperties: string;
    textureSlots: string;
    cubeTexture: string;
    fileTextureLoad: string;
    submeshDefaults: string;
    hierarchy: string;
    meshConstruction: string;
    sceneData: string;
    materialMaps: string;
}

export function babylonLoaderCpp(
    provenance: string,
    cameraParser: string,
    lowered: BabylonLoaderLoweredSegments,
    lightMeshLists = false,
    meshClones = false,
): string {
    return `// ${provenance}
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <nlohmann/json.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace bbl {
namespace {

using Json = nlohmann::json;

// The camera derivation's reads: the pinned parseBabylonCamera consumes the
// JSON values as JavaScript numbers, so these stay double up to the record's
// own stores instead of round-tripping through a float lane.
double double_at(
    const Json& object,
    const char* name,
    std::size_t index,
    double fallback) {
    const auto values = object.find(name);
    return values != object.end() &&
            values->is_array() &&
            index < values->size() &&
            (*values)[index].is_number()
        ? (*values)[index].get<double>()
        : fallback;
}

// A .babylon export commonly writes an unused optional field as JSON null
// rather than omitting it -- Sponza writes every unset id, texture slot and
// parent that way -- so reading one has to treat null as absent instead of
// asking nlohmann to convert it.
std::string string_or(
    const Json& object,
    const char* name,
    std::string fallback = std::string{}) {
    const auto found = object.find(name);
    return found != object.end() && found->is_string()
        ? found->get<std::string>()
        : fallback;
}

${cameraParser}

${lowered.bakeLocalMatrix}

${lowered.materialProperties}

${lowered.textureSlots}

${lowered.cubeTexture}

// The pinned loader hands bakeLocalMatrix the node's localMatrix as the
// JSON numbers it parsed -- doubles -- and only when the node carries one
// (\`md.localMatrix && bakeLocalMatrix\`, load-babylon.ts). A matrix that is
// not sixteen numbers reaches arithmetic the pin runs over \`undefined\`,
// which is refused here instead.
std::array<double, 16> babylon_local_matrix(const Json& value) {
    std::array<double, 16> matrix{};
    if (
        !value.is_array() ||
        value.size() != matrix.size() ||
        !std::all_of(value.begin(), value.end(), [](const Json& cell) {
            return cell.is_number();
        })) {
        throw std::runtime_error(
            "A .babylon localMatrix must carry sixteen numbers.");
    }
    for (std::size_t index = 0; index < matrix.size(); ++index) {
        matrix[index] = value[index].get<double>();
    }
    return matrix;
}

MaterialHandle load_material(
    Engine& engine,
    const Json& source,
    const std::string& base_path,
    const std::array<double, 3>& scene_ambient,
    std::unordered_map<std::string, std::uint32_t>& reflection_cubes,
    bool load_textures) {
    MaterialRecord material;
    material.standard_material = true;
    // loadBabylon copies RGB into a fresh array; exports may include an
    // unused fourth channel. Null/absent colors keep the factory default.
    if (const auto diffuse = source.find("diffuse");
        diffuse != source.end() && !diffuse->is_null()) {
        if (!diffuse->is_array() || diffuse->size() < 3 ||
            !(*diffuse)[0].is_number() || !(*diffuse)[1].is_number() || !(*diffuse)[2].is_number()) {
            throw std::runtime_error("Babylon material diffuse requires three numeric channels.");
        }
    }
    apply_babylon_material_properties(material, source, scene_ambient);
    project_material_source_colors(material);
    const float alpha = material.alpha;
    material.base_color_factor = Color4{
        material.diffuse_color.r,
        material.diffuse_color.g,
        material.diffuse_color.b,
        1.0f,
    };
    apply_babylon_texture_slots(material, source, base_path,
        [&](const char*, const std::string& path) { return ${lowered.fileTextureLoad}; }, load_textures);
    apply_babylon_cube_texture(material, source, load_textures, [&](const std::string& cube_name) {
            const auto existing = reflection_cubes.find(cube_name);
            if (existing != reflection_cubes.end()) {
                return existing->second;
            } else {
                constexpr std::array<const char*, 6> suffixes{
                    "_px.jpg",
                    "_nx.jpg",
                    "_py.jpg",
                    "_ny.jpg",
                    "_pz.jpg",
                    "_nz.jpg",
                };
                std::array<TextureData, 6> faces;
                for (std::size_t index = 0;
                     index < faces.size();
                     ++index) {
                    faces[index].bytes = pal::read_binary_file(
                        pal::join_path(
                            base_path,
                            cube_name + suffixes[index]));
                }
                engine.reflection_cubes.push_back(std::move(faces));
                const auto index =
                    static_cast<std::uint32_t>(
                        engine.reflection_cubes.size() - 1);
                reflection_cubes.emplace(
                    cube_name,
                    index);
                return index;
            }
    });
    material.alpha_mode =
        alpha < 1.0f || material.opacity_texture.has_image()
            ? MaterialAlphaMode::blend
            : MaterialAlphaMode::opaque;
    engine.materials.push_back(std::move(material));
    const MaterialHandle handle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
    return handle;
}

MaterialHandle default_material(Engine& engine) {
    MaterialRecord material;
    material.standard_material = true;
    apply_babylon_material_properties(material, Json::object(), {0, 0, 0});
    project_material_source_colors(material);
    engine.materials.push_back(std::move(material));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

${lowered.submeshDefaults}

${lowered.hierarchy}

// Project the linked source hierarchy into native baked geometry and traversal order.
void realize_babylon_hierarchy(Engine& engine, AssetRecord& asset,
    const std::vector<BabylonHierarchyNode>& nodes, const std::vector<std::size_t>& roots) {
    std::vector<std::array<float, 16>> worlds(nodes.size());
    std::vector<std::uint8_t> state(nodes.size());
    const auto world = [&](auto&& self, std::size_t index) -> const std::array<float, 16>& {
        if (state.at(index) == 2) return worlds.at(index);
        if (state.at(index) == 1) throw std::runtime_error("Cyclic .babylon node hierarchy.");
        state[index] = 1;
        const auto& node = nodes.at(index);
        auto local = upstream::trs_matrix(node.transform);
        if (node.parent != invalid_handle) {
            std::array<double, 16> product{};
            upstream::mat4_multiply_into_f64(product, 0, self(self, node.parent), 0, local, 0);
            local = upstream::narrow_mat4(product);
        }
        worlds[index] = local;
        state[index] = 2;
        return worlds[index];
    };
    for (std::size_t index = 0; index < nodes.size(); ++index) {
        const auto& node = nodes[index];
        const auto& matrix = world(world, index);
        if (node.mesh.value == invalid_handle) continue;
        auto& mesh = engine.meshes.at(node.mesh.value);
        mesh.instance_parent_matrix = matrix;
        auto& geometry = engine.geometries.at(mesh.geometry);
        geometry.bounds_min = Vec3{std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max()};
        geometry.bounds_max = Vec3{std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest()};
        for (std::size_t vertex_index = 0; vertex_index < geometry.vertices.size(); ++vertex_index) {
            auto& vertex = geometry.vertices[vertex_index];
            vertex.position = upstream::transform_position(matrix, vertex.local_position);
            vertex.normal = upstream::normalize_baked_direction(upstream::transform_direction(matrix, geometry.local_normals.at(vertex_index)));
            geometry.bounds_min.x = std::min(geometry.bounds_min.x, vertex.position.x);
            geometry.bounds_min.y = std::min(geometry.bounds_min.y, vertex.position.y);
            geometry.bounds_min.z = std::min(geometry.bounds_min.z, vertex.position.z);
            geometry.bounds_max.x = std::max(geometry.bounds_max.x, vertex.position.x);
            geometry.bounds_max.y = std::max(geometry.bounds_max.y, vertex.position.y);
            geometry.bounds_max.z = std::max(geometry.bounds_max.z, vertex.position.z);
        }
    }
    std::vector<std::size_t> pending(roots.rbegin(), roots.rend());
    std::vector<bool> seen(nodes.size());
    while (!pending.empty()) {
        const auto index = pending.back();
        pending.pop_back();
        if (seen.at(index)) continue;
        seen[index] = true;
        const auto& node = nodes.at(index);
        if (node.mesh.value != invalid_handle) asset.meshes.push_back(node.mesh);
        pending.insert(pending.end(), node.children.rbegin(), node.children.rend());
    }
}

bool babylon_json_truthy(const Json& object, const char* key) {
    const auto found = object.find(key);
    if (found == object.end() || found->is_null()) return false;
    if (found->is_boolean()) return found->get<bool>();
    if (found->is_number()) return found->get<double>() != 0.0;
    if (found->is_string()) return !found->get_ref<const std::string&>().empty();
    return true;
}

const Json& babylon_json_field(const Json& object, const char* key) {
    static const Json absent;
    const auto found = object.find(key);
    return found == object.end() ? absent : *found;
}

double babylon_json_length(const Json& object, const char* key) {
    const auto& value = babylon_json_field(object, key);
    return value.is_array() ? static_cast<double>(value.size()) : 0.0;
}

Vec3 babylon_vec3(const std::array<double, 3>& values) {
    return Vec3{static_cast<float>(values[0]), static_cast<float>(values[1]), static_cast<float>(values[2])};
}

Color3 babylon_color3(const std::array<double, 3>& values) {
    return Color3{static_cast<float>(values[0]), static_cast<float>(values[1]), static_cast<float>(values[2])};
}

std::vector<float> babylon_f32(const Json& values) {
    return values.get<std::vector<float>>();
}

std::vector<std::uint32_t> babylon_u32(const Json& values) {
    std::vector<std::uint32_t> result;
    result.reserve(values.size());
    for (const auto& value : values) result.push_back(js::to_uint32(value.get<double>()));
    return result;
}

std::uint32_t upload_babylon_mesh(Engine& engine, const std::vector<float>& positions,
    const std::vector<float>& normals, const std::vector<std::uint32_t>& indices,
    const std::vector<float>& uvs, const std::vector<float>& uvs2) {
    if (positions.size() % 3 != 0 || normals.size() != positions.size())
        throw std::runtime_error("A .babylon mesh requires matching position and normal triples.");
    const auto vertex_count = positions.size() / 3;
    ModelGeometry geometry;
    geometry.vertices.resize(vertex_count);
    geometry.local_normals.resize(vertex_count);
${meshClones ? "    geometry.bind_vertices.resize(vertex_count);" : ""}
    for (std::size_t index = 0; index < vertex_count; ++index) {
        ModelVertex vertex;
        vertex.local_position = Vec3{positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]};
        vertex.position = vertex.local_position;
        vertex.normal = Vec3{normals[index * 3], normals[index * 3 + 1], normals[index * 3 + 2]};
        if (!uvs.empty()) vertex.uv = Vec2{uvs.at(index * 2), uvs.at(index * 2 + 1)};
        if (!uvs2.empty()) vertex.uv2 = Vec2{uvs2.at(index * 2), uvs2.at(index * 2 + 1)};
        geometry.local_normals[index] = vertex.normal;
        geometry.vertices[index] = vertex;
${meshClones ? "        geometry.bind_vertices[index] = vertex;" : ""}
    }
    geometry.indices = indices;
    const auto index = static_cast<std::uint32_t>(engine.geometries.size());
    engine.geometries.push_back(std::move(geometry));
    return index;
}

std::size_t create_babylon_mesh(Engine& engine, std::vector<BabylonHierarchyNode>& nodes,
    const std::string& name, const std::string& id, MaterialHandle material, bool receives_shadows,
    std::uint32_t geometry, const upstream::TrsLanes& transform) {
    MeshRecord mesh;
    mesh.name = name;
    mesh.primitive = PrimitiveKind::babylon;
    mesh.geometry = geometry;
    mesh.material = material;
    mesh.receives_shadows = receives_shadows;
${meshClones ? `    mesh.imported_clone_trs = ImportedMeshTrs{
        Vec3{static_cast<float>(transform.position.x), static_cast<float>(transform.position.y), static_cast<float>(transform.position.z)},
        transform.rotation, transform.scaling};` : ""}
    const auto mesh_index = static_cast<std::uint32_t>(engine.meshes.size());
    engine.meshes.push_back(std::move(mesh));
    BabylonHierarchyNode node;
    node.id = id;
    node.transform = transform;
    node.mesh = MeshHandle{mesh_index};
    const auto index = nodes.size();
    nodes.push_back(std::move(node));
    return index;
}

std::size_t create_babylon_container(std::vector<BabylonHierarchyNode>& nodes, const upstream::TrsLanes& transform) {
    const auto index = nodes.size();
    BabylonHierarchyNode node;
    node.transform = transform;
    nodes.push_back(std::move(node));
    return index;
}

${lowered.meshConstruction}

${lightMeshLists ? `std::vector<std::uint32_t> resolve_babylon_light_meshes(const Json& ids,
    const std::unordered_map<std::string, std::vector<std::size_t>>& meshes_by_id,
    const std::vector<BabylonHierarchyNode>& nodes) {
    std::unordered_set<std::string> seen;
    std::vector<std::uint32_t> result;
    for (const auto& value : ids) {
        if (!value.is_string()) continue;
        const auto id = value.get<std::string>();
        if (!seen.insert(id).second) continue;
        const auto found = meshes_by_id.find(id);
        if (found == meshes_by_id.end()) continue;
        for (const auto index : found->second) result.push_back(nodes.at(index).mesh.value);
    }
    return result;
}
` : ""}
${lowered.sceneData}

std::vector<std::string> babylon_material_ids(const Json& values) {
    std::vector<std::string> result;
    result.reserve(values.size());
    for (const auto& value : values) result.push_back(value.is_string() ? value.get<std::string>() : std::string{});
    return result;
}

${lowered.materialMaps}

} // namespace

AssetHandle load_babylon(Engine& engine, const std::string& path, bool load_camera, bool load_textures) {
    const std::vector<std::uint8_t> bytes = pal::read_binary_file(path);
    const Json document = Json::parse(std::string(
        reinterpret_cast<const char*>(bytes.data()),
        bytes.size()));
    const std::string base_path = pal::parent_path(path);

    std::unordered_map<std::string, MaterialHandle> materials;
    std::unordered_map<std::string, std::vector<std::string>> multi_materials;
    load_babylon_material_maps(engine, document, base_path, babylon_scene_ambient(document), load_textures, materials, multi_materials);

    AssetRecord asset;
    std::vector<BabylonHierarchyNode> nodes;
    BabylonNodeMap node_map;
    std::unordered_map<std::string, std::vector<std::size_t>> meshes_by_id;
    std::vector<std::size_t> all_meshes;

    if (const auto meshes = document.find("meshes");
        meshes != document.end() && meshes->is_array()) {
        construct_babylon_meshes(engine, *meshes, materials, multi_materials, nodes, node_map, meshes_by_id, all_meshes);
        const auto roots = wire_babylon_hierarchy(*meshes, nodes, node_map, meshes_by_id, all_meshes);
        realize_babylon_hierarchy(engine, asset, nodes, roots);
    }

    load_babylon_lights(engine, asset, document${lightMeshLists ? ", meshes_by_id, nodes" : ""});
    if (const auto color = babylon_clear_color(document)) {
        asset.clear_color = *color;
        asset.has_clear_color = true;
    }
    if (const auto camera = select_babylon_camera(engine, document, load_camera)) {
        asset.camera = *camera;
        asset.has_camera = true;
    }

    if (const auto walks = document.find(${JSON.stringify(GLTF_MESH_WALKS)}); walks != document.end()) {
        install_asset_mesh_walks(asset, walks->get<std::vector<std::vector<double>>>());
    }
    engine.assets.push_back(std::move(asset));
    return AssetHandle{
        static_cast<std::uint32_t>(engine.assets.size() - 1)};
}

} // namespace bbl
`;
}
