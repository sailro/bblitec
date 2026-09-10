/** Native identities and matrix storage for the source-executed binding receipt. */
export function gltfAnimationBindingsCpp(): string {
    return `
struct GltfAnimationSkeletonBinding {
    std::vector<std::size_t> meshes;
    std::vector<std::size_t> joints;
    std::vector<Matrix> inverse_bind_matrices;
    Matrix inv_mesh_world{};
};
struct GltfAnimationMorphBinding {
    std::vector<std::size_t> meshes;
    std::size_t node = 0;
    std::size_t count = 0;
};
struct GltfAnimationBindingPlan {
    std::vector<std::pair<std::size_t, std::vector<std::size_t>>> node_meshes;
    std::vector<GltfAnimationSkeletonBinding> skeletons;
    std::vector<GltfAnimationMorphBinding> morphs;
    std::vector<std::size_t> node_targets;
    std::vector<std::size_t> excluded_nodes;
};
template<class ReadMatrices>
GltfAnimationBindingPlan read_gltf_animation_bindings(const ts::JsonValue& source,
    std::size_t mesh_count, std::size_t node_count, ReadMatrices read_matrices) {
    GltfAnimationBindingPlan result;
    if (source.is_null()) return result;
    const auto& plan = source.as_object();
    const auto indices = [](const ts::JsonValue& array, std::size_t limit) {
        std::vector<std::size_t> slots;
        for (const auto& value : array.as_array()) {
            const auto index = unsigned_value(value);
            if (index >= limit) throw std::runtime_error("Invalid glTF animation binding index.");
            slots.push_back(index);
        }
        return slots;
    };
    for (const auto& value : required(plan, "nodeMeshes").as_array()) {
        const auto& entry = value.as_object();
        const auto node = unsigned_value(required(entry, "node"));
        if (node >= node_count) throw std::runtime_error("Invalid glTF animation replay node.");
        result.node_meshes.emplace_back(node, indices(required(entry, "meshes"), std::numeric_limits<std::size_t>::max()));
    }
    for (const auto& value : required(plan, "skeletons").as_array()) {
        const auto& entry = value.as_object();
        GltfAnimationSkeletonBinding binding;
        binding.meshes = indices(required(entry, "meshes"), mesh_count);
        binding.joints = indices(required(entry, "joints"), node_count);
        binding.inverse_bind_matrices = read_matrices(unsigned_value(required(entry, "inverseBindMatrices")), binding.joints.size());
        binding.inv_mesh_world = read_matrices(unsigned_value(required(entry, "invMeshWorld")), 1).at(0);
        result.skeletons.push_back(std::move(binding));
    }
    for (const auto& value : required(plan, "morphs").as_array()) {
        const auto& entry = value.as_object();
        const auto node = unsigned_value(required(entry, "node"));
        if (node >= node_count) throw std::runtime_error("Invalid glTF animation morph node.");
        result.morphs.push_back({indices(required(entry, "meshes"), mesh_count), node, unsigned_value(required(entry, "count"))});
    }
    for (const auto& value : required(plan, "nodeTargets").as_array()) {
        const auto node = value.is_null() ? std::numeric_limits<std::size_t>::max() : unsigned_value(value);
        if (!value.is_null() && node >= node_count) throw std::runtime_error("Invalid glTF animation node target.");
        result.node_targets.push_back(node);
    }
    result.excluded_nodes = indices(required(plan, "excludedNodes"), node_count);
    return result;
}
`;
}
