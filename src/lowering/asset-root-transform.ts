import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    pinnedEulerProxy,
    pinnedQuaternionMath,
} from "./pinned-euler-proxy.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { SCENE_NODE_TRANSFORMS } from "../scene-node-transform-descriptor.js";

/** Public synthetic-root TRS over the loader's flattened, mirrored mesh worlds. */
export function assetRootTransformSource(context: LoweringContext): string {
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    let observables = "";
    for (const descriptor of SCENE_NODE_TRANSFORMS.filter(
        (d) => d.nativeField !== "rotation",
    )) {
        const quaternion = descriptor.nativeField === "rotation_quaternion";
        const className = quaternion ? "ObservableQuat" : "ObservableVec3";
        const { file, declaration: owner } = context.classDeclaration(
            `src/math/${quaternion ? "observable-quat" : "observable-vec3"}.ts`,
            className,
        );
        const bindings = new Map<string, PinnedBinding>([
            ["v", scalar("value")],
            ["this._version", scalar("root.root_quaternion_version")],
            ...descriptor.components.map((lane): [string, PinnedBinding] => [
                `this._${lane}`,
                scalar(`root.root_${descriptor.nativeField}.${lane}`),
            ]),
            ...descriptor.components.map((lane): [string, PinnedBinding] => [
                lane,
                scalar(lane),
            ]),
        ]);
        const scope = {
            bindings,
            calls: new Map([
                [
                    "this._onDirty",
                    () => "publish_asset_root_transform(engine, root)",
                ],
            ]),
        };
        const set = owner.members.find(
            (node): node is ts.MethodDeclaration =>
                ts.isMethodDeclaration(node) &&
                node.name.getText(file) === "set",
        );
        if (!set?.body)
            context.contractError(owner, "Expected observable bulk setter.");
        observables += `void set_asset_root_${descriptor.nativeField}(Engine& engine, AssetHandle asset, ${quaternion ? "Vec4d" : "Vec3d"} value) {
    auto& root = asset_record(engine, asset.value);
${descriptor.components.map((lane) => `    const double ${lane} = value.${lane};`).join("\n")}
${new PinnedNumericLowerer(file, scope).statements(set.body.statements, "    ").join("\n")}
}
void set_asset_root_${descriptor.nativeField}_component(Engine& engine, AssetHandle asset, std::size_t component, double value) {
    auto& root = asset_record(engine, asset.value);
    switch (component) {
${descriptor.components
    .map((lane, index) => {
        const setter = owner.members.find(
            (node): node is ts.SetAccessorDeclaration =>
                ts.isSetAccessorDeclaration(node) &&
                node.name.getText(file) === lane,
        );
        if (!setter?.body)
            context.contractError(
                owner,
                "Expected observable component setter.",
            );
        return `    case ${index}: {\n${new PinnedNumericLowerer(file, scope).statements(setter.body.statements, "        ").join("\n")}\n        return;\n    }`;
    })
    .join("\n")}
    default: throw std::out_of_range("Imported root transform component");
    }
}
`;
    }
    return `
namespace asset_root_detail {
${pinnedQuaternionMath(context)}
}

void publish_asset_root_transform(Engine& engine, const AssetRecord& root) {
    for (const auto mesh : root.meshes) {
        auto& record = engine.meshes.at(mesh.value);
        record.outer_position = root.root_position;
        record.outer_rotation = root.root_rotation;
        // Native imported worlds already contain the initial root (-1,1,1).
        // The outer transform replaces that root: newRoot * inverse(initialRoot).
        record.outer_scaling = {-root.root_scaling.x, root.root_scaling.y, root.root_scaling.z};
        record.outer_rotation_quaternion = root.root_rotation_quaternion;
        record.outer_has_rotation_quaternion = true;
        mark_mesh_dirty(engine, mesh);
    }
}

${observables}
${pinnedEulerProxy(context, {
    parameters:
        "[[maybe_unused]] Engine& engine, [[maybe_unused]] AssetHandle asset, AssetRecord& root",
    arguments: "engine, asset, root",
    prefix: "asset_root_euler",
    rotation: "root.root_rotation",
    quaternion: "root.root_rotation_quaternion",
    version: "root.root_quaternion_version",
    syncedVersion: "root.root_synced_quaternion_version",
    mathNamespace: "asset_root_detail",
    setQuaternion: (args) =>
        `set_asset_root_rotation_quaternion(engine, asset, Vec4d{${args.join(", ")}})`,
})}
Vec3d asset_root_rotation(Engine& engine, AssetHandle asset) {
    auto& root = asset_record(engine, asset.value);
    asset_root_euler_sync(engine, asset, root);
    return root.root_rotation;
}
void set_asset_root_rotation(Engine& engine, AssetHandle asset, Vec3d value) {
    auto& root = asset_record(engine, asset.value);
    asset_root_euler_set(engine, asset, root, value.x, value.y, value.z);
}
void set_asset_root_rotation_component(Engine& engine, AssetHandle asset, std::size_t component, double value) {
    auto& root = asset_record(engine, asset.value);
    asset_root_euler_write(engine, asset, root, component, value);
}
std::array<float, 16> asset_root_world_matrix(Engine& engine, AssetHandle asset) {
    const auto& root = asset_record(engine, asset.value);
    return upstream::trs_matrix(upstream::TrsLanes64{
        .rotation = root.root_rotation,
        .scaling = root.root_scaling,
        .position = root.root_position,
        .has_rotation_quaternion = true,
        .rotation_quaternion = root.root_rotation_quaternion});
}
void set_light_asset_parent(Engine& engine, LightHandle light, AssetHandle parent) {
    auto& record = engine.lights.at(light.value);
    if (parent.value == invalid_handle) {
        record.parent_world_matrix = {};
    } else {
        (void)engine.assets.at(parent.value);
        record.parent_world_matrix = [&engine, parent] { return asset_root_world_matrix(engine, parent); };
    }
}
`;
}
