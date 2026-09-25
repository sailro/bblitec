/** Adapt the public SceneNode union to the existing concrete TRS writers. */
import {
    SCENE_NODE_TRANSFORMS,
    type SceneNodeTransformDescriptor,
} from "../scene-node-transform-descriptor.js";
import { recordAt } from "../compiler/record-access.js";

function assetRead(descriptor: SceneNodeTransformDescriptor): string {
    const root =
        descriptor.nativeField === "rotation"
            ? "asset_root_rotation(engine, concrete)"
            : `asset_record(engine, concrete.value).root_${descriptor.nativeField}`;
    return `const auto root = ${root};
                return ${descriptor.cppType}{${descriptor.components.map((c) => `static_cast<${descriptor.precision}>(root.${c})`).join(", ")}};`;
}

function assetWrite(descriptor: SceneNodeTransformDescriptor): string {
    return `${descriptor.assetSetter}(engine, concrete, ${descriptor.components.length === 4 ? "Vec4d" : "Vec3d"}{${descriptor.components.map((c) => `value.${c}`).join(", ")}});`;
}

function meshWrite(descriptor: SceneNodeTransformDescriptor): string {
    if (descriptor.meshSetter) {
        return `${descriptor.meshSetter}(engine, concrete, value);`;
    }
    return `${recordAt("engine.meshes", "concrete")}.${descriptor.nativeField} = value;
            mark_mesh_dirty(engine, concrete);`;
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
                ${recordAt("engine.meshes", "concrete")}.${descriptor.nativeField};
            assign_component(vector);
            ${descriptor.meshSetter}(engine, concrete, vector);`
        : `auto& vector =
                ${recordAt("engine.meshes", "concrete")}.${descriptor.nativeField};
            assign_component(vector);
            mark_mesh_dirty(engine, concrete);`;
    const transformNode = transformNodes
        ? `${descriptor.cppType} vector =
                ${recordAt("engine.transform_nodes", "concrete")}.${descriptor.nativeField};
            assign_component(vector);
            ${descriptor.transformNodeSetter}(engine, concrete, vector);`
        : 'throw std::runtime_error("No transform-node factory is reached by this scene.");';
    const asset = `${descriptor.assetComponentSetter}(engine, concrete, component, value);`;
    return `
void ${descriptor.sceneNodeComponentSetter}(
    Engine& engine, const SceneNodeHandle& node, std::size_t component,
    ${descriptor.precision} value) {
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
            ? `${descriptor.transformNodeSetter}(engine, concrete, value);`
            : 'throw std::runtime_error("No transform-node factory is reached by this scene.");';
        return `
${descriptor.cppType} scene_node_${descriptor.nativeField}(
    Engine& engine, const SceneNodeHandle& node) {
    return std::visit([&engine](const auto& concrete) -> ${descriptor.cppType} {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, MeshHandle>) {
            return ${recordAt("engine.meshes", "concrete")}.${descriptor.nativeField};
        } else if constexpr (std::is_same_v<Handle, TransformNodeHandle>) {
            return ${recordAt("engine.transform_nodes", "concrete")}.${descriptor.nativeField};
        } else {
            ${assetRead(descriptor)}
        }
    }, node);
}

void ${descriptor.sceneNodeSetter}(
    Engine& engine, const SceneNodeHandle& node, ${descriptor.cppType} value) {
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
