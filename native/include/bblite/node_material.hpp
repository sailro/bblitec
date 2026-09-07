#pragma once

#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>

namespace bbl {

/** One pinned input handle; texture slots retain the original producer arm. */
struct NodeInputState {
    std::string type;
    js::Nullable<StoredTexture> texture;
};

struct NodeMaterialInputsState {
    js::Map<std::string, NodeInputHandle> inputs;
    // The pin's private slots survive independently of its public input map.
    std::vector<std::pair<std::string, NodeInputHandle>> texture_slots;
};

/** Scene-core keys a group by each material's distinct _buildGroup function. */
struct NodeMaterialGroupState {
    MaterialHandle initial_material;
    std::vector<MeshHandle> meshes;
};

inline js::Map<std::string, NodeInputHandle> node_material_inputs(
    Engine& engine, MaterialHandle material) {
    const auto& owner = engine.materials.at(material.value).node_inputs;
    if (!owner) throw std::runtime_error("Material has no node inputs.");
    return owner->inputs;
}

inline js::Nullable<StoredTexture> node_input_texture(
    const NodeInputHandle& input) {
    if (!input || input->type != "texture2d") {
        throw std::runtime_error("Node input is not a texture2d handle.");
    }
    return input->texture;
}

inline js::Nullable<StoredTexture> set_node_input_texture(
    const NodeInputHandle& input, js::Nullable<StoredTexture> texture) {
    if (!input || input->type != "texture2d") {
        throw std::runtime_error("Node input is not a texture2d handle.");
    }
    input->texture = std::move(texture);
    return input->texture;
}

inline std::string node_input_type(const NodeInputHandle& input) {
    if (!input) throw std::runtime_error("Node input handle is absent.");
    return input->type;
}

} // namespace bbl
