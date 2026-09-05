/** Adapt the public SceneNode union to the existing concrete TRS writers. */
import {
    SCENE_NODE_TRANSFORMS,
    type SceneNodeTransformDescriptor,
} from "../scene-node-transform-descriptor.js";

function assetRead(descriptor: SceneNodeTransformDescriptor): string {
    const { cppType, nativeField } = descriptor;
    if (descriptor.assetSetter) {
        return `const auto& root = asset_record(engine, concrete.value).root_${nativeField};
                return ${cppType}{root.x, root.y, root.z};`;
    }
    if (nativeField === "scaling") {
        return (
            "return bbl::Vec3{" +
            "asset_record(engine, concrete.value).root_scaling_reset " +
            "? 1.0f : -1.0f, 1, 1};"
        );
    }
    return 'throw std::runtime_error("Reading an imported root quaternion is not supported.");';
}

function assetWrite(descriptor: SceneNodeTransformDescriptor): string {
    const { nativeField } = descriptor;
    if (descriptor.assetSetter) {
        return `${descriptor.assetSetter}(engine, concrete, bbl::Vec3{
                    static_cast<float>(value.x),
                    static_cast<float>(value.y),
                    static_cast<float>(value.z)});`;
    }
    if (nativeField === "scaling") {
        return `if (value.x != 1 || value.y != 1 || value.z != 1)
                    throw std::runtime_error("An imported root only supports resetting scaling to identity.");
                reset_asset_root_scaling(engine, concrete);`;
    }
    return `if (value.x != 0 || value.y != 0 || value.z != 0 || value.w != 1)
                    throw std::runtime_error("An imported root only supports resetting its quaternion to identity.");`;
}

function meshWrite(descriptor: SceneNodeTransformDescriptor): string {
    if (descriptor.meshSetter) {
        return `${descriptor.meshSetter}(
                engine, concrete, value, runtime_transform);`;
    }
    return `engine.meshes.at(concrete.value).${descriptor.nativeField} = value;
            if (runtime_transform) mark_mesh_runtime_transform(engine, concrete);
            else mark_mesh_dirty(engine, concrete);`;
}

function componentWrite(
    descriptor: SceneNodeTransformDescriptor,
    transformNodes: boolean,
): string {
    const assignCases = descriptor.components
        .map(
            (component, index) =>
                `case ${index}u: vector.${component} = value; break;`,
        )
        .join("\n            ");
    const mesh = descriptor.meshSetter
        ? `${descriptor.cppType} vector =
                engine.meshes.at(concrete.value).${descriptor.nativeField};
            assign_component(vector);
            ${descriptor.meshSetter}(
                engine, concrete, vector, runtime_transform);`
        : `auto& vector =
                engine.meshes.at(concrete.value).${descriptor.nativeField};
            assign_component(vector);
            if (runtime_transform) mark_mesh_runtime_transform(engine, concrete);
            else mark_mesh_dirty(engine, concrete);`;
    const transformNode = transformNodes
        ? `${descriptor.cppType} vector =
                engine.transform_nodes.at(concrete.value).${descriptor.nativeField};
            assign_component(vector);
            ${descriptor.transformNodeSetter}(
                engine, concrete, vector, runtime_transform);`
        : 'throw std::runtime_error("No transform-node factory is reached by this scene.");';
    let asset: string;
    if (descriptor.assetComponentSetter) {
        asset = `${descriptor.assetComponentSetter}(
                engine, concrete, component, static_cast<float>(value));`;
    } else if (descriptor.nativeField === "scaling") {
        asset = `bbl::Vec3 vector{
                asset_record(engine, concrete.value).root_scaling_reset
                    ? 1.0f : -1.0f,
                1,
                1};
            assign_component(vector);
            if (vector.x != 1 || vector.y != 1 || vector.z != 1)
                throw std::runtime_error("An imported root only supports resetting scaling to identity.");
            reset_asset_root_scaling(engine, concrete);`;
    } else {
        asset = 'throw std::runtime_error("Reading an imported root quaternion is not supported.");';
    }
    return `
void ${descriptor.sceneNodeComponentSetter}(
    Engine& engine, const SceneNodeHandle& node, std::size_t component,
    ${descriptor.precision} value, bool runtime_transform) {
    const auto assign_component = [component, value](auto& vector) {
        switch (component) {
            ${assignCases}
            default:
                throw std::runtime_error("Invalid SceneNode transform component.");
        }
    };
    std::visit([&](const auto& concrete) {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, MeshHandle>) {
            ${mesh}
        } else if constexpr (std::is_same_v<Handle, TransformNodeHandle>) {
            ${transformNode}
        } else {
            ${asset}
        }
    }, node);
}
`;
}

/** The complete generated adapter for every public SceneNode TRS lane. */
export function sceneNodeTransformsSource(transformNodes: boolean): string {
    return SCENE_NODE_TRANSFORMS.map((descriptor) => {
        const transformNodeWrite = transformNodes
            ? `${descriptor.transformNodeSetter}(
                engine, concrete, value, runtime_transform);`
            : 'throw std::runtime_error("No transform-node factory is reached by this scene.");';
        return `
${descriptor.cppType} scene_node_${descriptor.nativeField}(
    Engine& engine, const SceneNodeHandle& node) {
    return std::visit([&engine](const auto& concrete) -> ${descriptor.cppType} {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, MeshHandle>) {
            return engine.meshes.at(concrete.value).${descriptor.nativeField};
        } else if constexpr (std::is_same_v<Handle, TransformNodeHandle>) {
            return engine.transform_nodes.at(concrete.value).${descriptor.nativeField};
        } else {
            ${assetRead(descriptor)}
        }
    }, node);
}

void ${descriptor.sceneNodeSetter}(
    Engine& engine, const SceneNodeHandle& node, ${descriptor.cppType} value,
    bool runtime_transform) {
    std::visit([&](const auto& concrete) {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, MeshHandle>) {
            ${meshWrite(descriptor)}
        } else if constexpr (std::is_same_v<Handle, TransformNodeHandle>) {
            ${transformNodeWrite}
        } else {
            ${assetWrite(descriptor)}
        }
    }, node);
}
${componentWrite(descriptor, transformNodes)}`;
    }).join("\n");
}
