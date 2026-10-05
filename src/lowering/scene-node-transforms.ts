/** Adapt the public SceneNode union to the existing concrete TRS writers. */
import {
    SCENE_NODE_TRANSFORMS,
    type SceneNodeTransformDescriptor,
} from "../scene-node-transform-descriptor.js";
import { recordAt } from "../compiler/record-access.js";
import type { LoweringContext } from "./context.js";

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

/**
 * The pin's `getContainerMeshes`, over retained scene nodes. A node is visited
 * once (the pin's `seen` set, one slot bitmap per record table here), a mesh
 * is the node carrying `_gpu`, and the descent follows the live `children`
 * list in order.
 */
function containerMeshesSource(context: LoweringContext): string {
    context.assertFunctionBodyShape(
        context.functionDeclaration(
            "src/asset-container.ts",
            "getContainerMeshes",
        ).declaration,
        `{
    const meshes: Mesh[] = [];
    const seen = new Set<unknown>();
    const visit = (node: SceneNode): void => {
        if (seen.has(node)) {
            return;
        }
        seen.add(node);
        if ((node as unknown as { _gpu?: unknown })._gpu) {
            meshes.push(node as unknown as Mesh);
        }
        const children = (node as unknown as { children?: SceneNode[] }).children;
        if (children) {
            for (const child of children) {
                visit(child);
            }
        }
    };
    for (const entity of container.entities) {
        visit(entity as SceneNode);
    }
    return meshes;
}`,
        "Container mesh flatten",
    );
    return `
js::Array<MeshHandle> container_meshes(Engine& engine, const js::Array<SceneNodeHandle>& entities) {
    js::Array<MeshHandle> meshes;
    std::array<std::vector<bool>, std::variant_size_v<SceneNodeHandle>> seen{};
    const auto visit = [&](const auto& self, const SceneNodeHandle& node) -> void {
        const std::uint32_t slot = std::visit([](const auto& concrete) { return concrete.value; }, node);
        auto& visited = seen.at(node.index());
        if (slot >= visited.size()) visited.resize(static_cast<std::size_t>(slot) + 1u);
        if (visited[slot]) return;
        visited[slot] = true;
        if (const auto* mesh = std::get_if<MeshHandle>(&node)) meshes.push_back(*mesh);
        for (const SceneNodeHandle child : scene_node_children(engine, node)) self(self, child);
    };
    for (const SceneNodeHandle& entity : entities) visit(visit, entity);
    return meshes;
}
`;
}

/** Concrete handle transport for a retained SceneNode hierarchy. */
export function sceneNodeTraversalSource(context: LoweringContext): string {
    return `${containerMeshesSource(context)}
MeshVisibility& scene_node_visibility(Engine& engine, const SceneNodeHandle& node) {
    return std::visit([&](const auto& concrete) -> MeshVisibility& {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, MeshHandle>) return engine.meshes.at(concrete.value).visible;
        else if constexpr (std::is_same_v<Handle, TransformNodeHandle>) return engine.transform_nodes.at(concrete.value).visible;
        else return engine.transform_nodes.at(engine.assets.at(concrete.value).root_node.value).visible;
    }, node);
}

js::Nullable<MeshHandle> scene_node_thin_instance_pool(Engine& engine, const SceneNodeHandle& node) {
    const auto* mesh = std::get_if<MeshHandle>(&node);
    return mesh && engine.meshes.at(mesh->value).thin_instanced ? js::Nullable<MeshHandle>{*mesh} : js::Nullable<MeshHandle>{};
}

bool scene_node_has_thin_instance_property(Engine& engine, const SceneNodeHandle& node) {
    return scene_node_thin_instance_pool(engine, node).has_value();
}

SceneNodeHandle clone_scene_node(Engine& engine, const SceneNodeHandle& node) {
    return std::visit([&engine](const auto& concrete) -> SceneNodeHandle {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, MeshHandle>) {
            return clone_mesh_node(engine, concrete);
        } else if constexpr (std::is_same_v<Handle, AssetHandle>) {
            return clone_asset_root(engine, concrete);
        } else {
            throw std::runtime_error("Cloning a standalone TransformNode hierarchy is not supported.");
        }
    }, node);
}

std::size_t SceneNodeChildrenView::size() const {
    return std::visit([&](const auto& concrete) -> std::size_t {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, MeshHandle>) {
            return ${recordAt("engine_->meshes", "concrete")}.children.size();
        } else if constexpr (std::is_same_v<Handle, TransformNodeHandle>) {
            return ${recordAt("engine_->transform_nodes", "concrete")}.children.size();
        } else {
            const auto root = engine_->assets.at(concrete.value).root_node;
            if (root.value == invalid_handle)
                throw std::runtime_error("SceneNode.children requires a retained imported node hierarchy.");
            return ${recordAt("engine_->transform_nodes", "root")}.children.size();
        }
    }, node_);
}

SceneNodeHandle SceneNodeChildrenView::operator[](std::size_t index) const {
    return std::visit([&](const auto& concrete) -> SceneNodeHandle {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, MeshHandle>) {
            return ${recordAt("engine_->meshes", "concrete")}.children.at(index);
        } else {
            const auto root = [&]() {
                if constexpr (std::is_same_v<Handle, TransformNodeHandle>) return concrete;
                else return engine_->assets.at(concrete.value).root_node;
            }();
            const auto& child = ${recordAt("engine_->transform_nodes", "root")}.children.at(index);
            return std::visit([](const auto& entry) -> SceneNodeHandle { return entry; }, child);
        }
    }, node_);
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
