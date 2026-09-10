/** Native palette/weight storage shared by the source initial state and live pose adapter. */
export function gltfDeformationStateCpp(deformPicking: boolean): string {
    return `
void publish_gltf_deformation(MeshRecord& mesh, ModelGeometry& geometry,
    const Matrix& mesh_world, const std::vector<Matrix>& joint_matrices,
    bool skinned, const std::vector<float>& morph_weights) {${deformPicking ? `
    mesh.deform_node_world = native_matrix(mesh_world);` : ""}
    mesh.bone_matrices.clear();
    if (skinned) {
        for (const auto& matrix : joint_matrices) mesh.bone_matrices.push_back(native_matrix(matrix));
    } else mesh.bone_matrices.push_back(native_matrix(mesh_world));
    ++mesh.bone_matrices_version;
    mesh.morph_weights = {};
    for (std::size_t target = 0; target < morph_weights.size() && target < mesh.morph_weights.size(); ++target)
        mesh.morph_weights[target] = morph_weights[target];
#if BBLITE_GPU_MORPH_STORAGE
    if (mesh.morph_storage_weights != morph_weights) {
        mesh.morph_storage_weights = morph_weights;
        ++mesh.morph_weights_version;
    }
#endif
    // The composed fragment owns flat normals. This CPU copy serves native
    // consumers of the deindexed geometry and the legacy vertex transport.
    if (geometry.flat_normals) {
        for (std::size_t index = 0; index < geometry.vertices.size(); ++index) {
            const ModelVertex& bind = geometry.bind_vertices.at(index);
            Vec3 morphed_position = bind.local_position;
            for (std::size_t target = 0; target < morph_weights.size() && target < geometry.morph_positions.size(); ++target) {
                const float weight = morph_weights[target];
                const Vec3 delta = geometry.morph_positions[target][index];
                morphed_position.x += delta.x * weight;
                morphed_position.y += delta.y * weight;
                morphed_position.z += delta.z * weight;
            }
            Vec3 position{};
            if (skinned) {
                const std::array<float, 4> weights{bind.weights.x, bind.weights.y, bind.weights.z, bind.weights.w};
                for (std::size_t influence = 0; influence < weights.size(); ++influence) {
                    const float weight = weights[influence];
                    const std::size_t joint = bind.joints[influence];
                    if (weight <= 0.0f || joint >= joint_matrices.size()) continue;
                    const Vec3 joint_position = upstream::transform_position(joint_matrices[joint], morphed_position);
                    position.x += joint_position.x * weight;
                    position.y += joint_position.y * weight;
                    position.z += joint_position.z * weight;
                }
            } else position = upstream::transform_position(mesh_world, morphed_position);
            geometry.vertices[index].position = Vec3{-position.x, position.y, position.z};
        }
        for (std::size_t index = 0; index < geometry.vertices.size(); index += 3) {
            ModelVertex& a = geometry.vertices[index];
            ModelVertex& b = geometry.vertices[index + 1];
            ModelVertex& c = geometry.vertices[index + 2];
            const Vec3 edge1{b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z};
            const Vec3 edge2{c.position.x - a.position.x, c.position.y - a.position.y, c.position.z - a.position.z};
            const Vec3 face = upstream::normalize_baked_direction(Vec3{
                edge2.y * edge1.z - edge2.z * edge1.y,
                edge2.z * edge1.x - edge2.x * edge1.z,
                edge2.x * edge1.y - edge2.y * edge1.x});
            a.normal = face;
            b.normal = face;
            c.normal = face;
        }
    }
    ++mesh.transform_version;
}
`;
}
