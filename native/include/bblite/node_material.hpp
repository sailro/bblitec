#pragma once

#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>

namespace bbl {

struct NodeUniformState {
    std::vector<float> values;
    std::uint64_t revision = 0;
    void mark_dirty() { ++revision; }
};

/** Every draw buffer observes the shared material's own upload revision. */
struct NodeUniformUploadState {
    std::shared_ptr<NodeUniformState> owner;
    std::optional<std::uint64_t> revision;
    bool pending(const std::shared_ptr<NodeUniformState>& source) const {
        return owner != source || !revision || *revision != (source ? source->revision : 0);
    }
    void uploaded(const std::shared_ptr<NodeUniformState>& source) {
        owner = source;
        revision = source ? source->revision : 0;
    }
};

/** One pinned input handle; texture slots retain the original producer arm. */
struct NodeInputState {
    std::string type;
    js::Nullable<StoredTexture> texture;
    std::shared_ptr<NodeUniformState> uniforms;
    std::span<float> values;
};

struct NodeMaterialInputsState {
    js::Map<std::string, NodeInputHandle> inputs;
    // The pin's private slots survive independently of its public input map.
    std::vector<std::pair<std::string, NodeInputHandle>> texture_slots;
    std::shared_ptr<NodeUniformState> uniforms;
};

double set_node_input_scalar(const NodeInputHandle& input, double value);

/** Scene-core keys a group by each material's distinct _buildGroup function. */
struct NodeMaterialGroupState {
    MaterialHandle initial_material;
    std::vector<MeshHandle> meshes;
};

inline js::Map<std::string, NodeInputHandle> node_material_inputs(Engine& engine,
                                                                  MaterialHandle material) {
    const auto& owner = handle_at(engine.materials, material).node_inputs;
    if (!owner)
        throw std::runtime_error("Material has no node inputs.");
    return owner->inputs;
}

inline js::Nullable<StoredTexture> node_input_texture(const NodeInputHandle& input) {
    if (!input || input->type != "texture2d") {
        throw std::runtime_error("Node input is not a texture2d handle.");
    }
    return input->texture;
}

inline js::Nullable<StoredTexture> set_node_input_texture(const NodeInputHandle& input,
                                                          js::Nullable<StoredTexture> texture) {
    if (!input || input->type != "texture2d") {
        throw std::runtime_error("Node input is not a texture2d handle.");
    }
    input->texture = std::move(texture);
    return input->texture;
}

inline std::string node_input_type(const NodeInputHandle& input) {
    if (!input)
        throw std::runtime_error("Node input handle is absent.");
    return input->type;
}

} // namespace bbl
