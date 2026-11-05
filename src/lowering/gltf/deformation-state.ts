import type { GltfLoaderOptions } from "./loader.js";

/**
 * Native palette/weight storage shared by the source initial state and live
 * pose adapter. Under node transforms every record hangs under its node's
 * scene node, whose world the engine composes, so the publish takes no node
 * world.
 */
export function gltfDeformationStateCpp(options: GltfLoaderOptions): string {
    const sceneParent = options.nodeTransforms === true;
    return `
// A skinned record carries the pin's palette, \`invMeshWorld * jointWorld *
// IBM\`, under its node's world; ${
        sceneParent
            ? `an unskinned animated node's record hangs
// under the node's scene node, which the pose moves itself.`
            : `an unskinned animated node carries its
// live world as the record's parent world, as the pin's mesh child of that
// node does.`
    }
void publish_gltf_deformation(MeshRecord& mesh,${sceneParent ? "" : " const Matrix& node_world,"}
    const std::vector<Matrix>& joint_matrices, bool skinned, const std::vector<float>& morph_weights) {
    if (skinned) {
        mesh.bone_matrices = joint_matrices;
        ++mesh.bone_matrices_version;
    }${
        sceneParent
            ? ""
            : ` else {
        mesh.parent_world = node_world;
    }`
    }
    mesh.morph_weights = {};
    for (std::size_t target = 0; target < morph_weights.size() && target < mesh.morph_weights.size(); ++target)
        mesh.morph_weights[target] = morph_weights[target];
#if BBLITE_GPU_MORPH_STORAGE
    if (mesh.morph_storage_weights != morph_weights) {
        mesh.morph_storage_weights = morph_weights;
        ++mesh.morph_weights_version;
    }
#endif
    ++mesh.transform_version;
}
`;
}
