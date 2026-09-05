/**
 * One public SceneNode transform lane and all native spellings derived from it.
 *
 * Reads, component writes, `.set(...)`, and the generated variant bridge all
 * consume this table. Keeping the source/native name pair beside the vector
 * width and entry points prevents `rotationQuaternion` from becoming four
 * subtly different special cases across those paths.
 */
export interface SceneNodeTransformDescriptor {
    sourceProperty:
        | "position"
        | "rotation"
        | "rotationQuaternion"
        | "scaling";
    nativeField:
        | "position"
        | "rotation"
        | "rotation_quaternion"
        | "scaling";
    components: readonly ("x" | "y" | "z" | "w")[];
    cppType: "bbl::Vec3d" | "bbl::Vec3" | "bbl::Vec4";
    precision: "double" | "float";
    transformNodeSetter:
        | "set_transform_node_position"
        | "set_transform_node_rotation"
        | "set_transform_node_rotation_quaternion"
        | "set_transform_node_scaling";
    sceneNodeSetter:
        | "set_scene_node_position"
        | "set_scene_node_rotation"
        | "set_scene_node_rotation_quaternion"
        | "set_scene_node_scaling";
    sceneNodeComponentSetter:
        | "set_scene_node_position_component"
        | "set_scene_node_rotation_component"
        | "set_scene_node_rotation_quaternion_component"
        | "set_scene_node_scaling_component";
    meshSetter?: "set_mesh_rotation_quaternion";
    assetSetter?:
        | "set_asset_root_position"
        | "set_asset_root_rotation";
    assetComponentSetter?:
        | "set_asset_root_position_component"
        | "set_asset_root_rotation_component";
}

export const SCENE_NODE_TRANSFORMS = [
    {
        sourceProperty: "position",
        nativeField: "position",
        components: ["x", "y", "z"],
        cppType: "bbl::Vec3d",
        precision: "double",
        transformNodeSetter: "set_transform_node_position",
        sceneNodeSetter: "set_scene_node_position",
        sceneNodeComponentSetter: "set_scene_node_position_component",
        assetSetter: "set_asset_root_position",
        assetComponentSetter: "set_asset_root_position_component",
    },
    {
        sourceProperty: "rotation",
        nativeField: "rotation",
        components: ["x", "y", "z"],
        cppType: "bbl::Vec3",
        precision: "float",
        transformNodeSetter: "set_transform_node_rotation",
        sceneNodeSetter: "set_scene_node_rotation",
        sceneNodeComponentSetter: "set_scene_node_rotation_component",
        assetSetter: "set_asset_root_rotation",
        assetComponentSetter: "set_asset_root_rotation_component",
    },
    {
        sourceProperty: "rotationQuaternion",
        nativeField: "rotation_quaternion",
        components: ["x", "y", "z", "w"],
        cppType: "bbl::Vec4",
        precision: "float",
        transformNodeSetter: "set_transform_node_rotation_quaternion",
        sceneNodeSetter: "set_scene_node_rotation_quaternion",
        sceneNodeComponentSetter:
            "set_scene_node_rotation_quaternion_component",
        meshSetter: "set_mesh_rotation_quaternion",
    },
    {
        sourceProperty: "scaling",
        nativeField: "scaling",
        components: ["x", "y", "z"],
        cppType: "bbl::Vec3",
        precision: "float",
        transformNodeSetter: "set_transform_node_scaling",
        sceneNodeSetter: "set_scene_node_scaling",
        sceneNodeComponentSetter: "set_scene_node_scaling_component",
    },
] as const satisfies readonly SceneNodeTransformDescriptor[];

export function sceneNodeTransformDescriptor(
    sourceProperty: string,
): SceneNodeTransformDescriptor | undefined {
    return SCENE_NODE_TRANSFORMS.find(
        (descriptor) => descriptor.sourceProperty === sourceProperty,
    );
}

export function isTrsVectorName(
    name: string,
): name is SceneNodeTransformDescriptor["sourceProperty"] {
    return sceneNodeTransformDescriptor(name) !== undefined;
}
