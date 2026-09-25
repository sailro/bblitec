import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { assetRootTransformSource } from "../src/lowering/asset-root-transform.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

interface Vector {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): void;
}
interface Quaternion {
    set(x: number, y: number, z: number, w: number): void;
}
interface Node {
    position: Vector;
    rotation: Vector;
    rotationQuaternion: Quaternion;
    worldMatrix: ArrayLike<number>;
    parent: Node | null;
    children: Node[];
}
type Quat = [number, number, number, number];

const tools = optionalNativeFixtureTools(false);

// The racer's vehicle writes, applied to a flat glTF scene of primitive
// nodes under the loader's RH-to-LH root: the root moves and turns, the
// body pitches and rises, the wheels steer and roll. Each native record
// carries its node's TRS under the root world its load recorded, and the
// imported root's edit composes on the left.
test(
    "imported node-local transforms compose under the loaded root as the pin's nodes do",
    { skip: !tools },
    async () => {
        const { createSceneNode } = await importPinnedModule<{
            createSceneNode(this: void, name: string, ...trs: number[]): Node;
        }>("scene/scene-node.js");
        const root = createSceneNode("root", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const loadedRoot = Array.from(root.worldMatrix);
        const nodes = [
            { name: "body", translation: [0, 0.4, 0] },
            { name: "wheel-front-left", translation: [0.55, 0.3, 0.857] },
            { name: "wheel-back-right", translation: [-0.55, 0.3, -0.657] },
        ].map(({ name, translation }) => {
            const node = createSceneNode(
                name,
                translation[0]!,
                translation[1]!,
                translation[2]!,
                0,
                0,
                0,
                1,
                1,
                1,
                1,
            );
            node.parent = root;
            root.children.push(node);
            return { node, translation };
        });
        const axis = (index: 0 | 1 | 2, angle: number): Quat => {
            const q: Quat = [0, 0, 0, Math.cos(angle / 2)];
            q[index] = Math.sin(angle / 2);
            return q;
        };
        const multiply = (a: Quat, b: Quat): Quat => [
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
        ];
        const body = multiply(
            multiply(axis(0, -0.2), axis(1, 0)),
            axis(2, 0.1),
        );
        const front = multiply(axis(1, 0.4), axis(0, 2.5));
        const rear = axis(0, 2.5);
        root.position.set(3, 0.15, -7);
        root.rotation.set(0.05, 1.2, -0.03);
        nodes[0]!.node.rotationQuaternion.set(...body);
        nodes[0]!.node.position.y = 0.45;
        nodes[1]!.node.rotationQuaternion.set(...front);
        nodes[2]!.node.rotationQuaternion.set(...rear);
        const context = new LoweringContext();
        const float = (value: number): string => context.floatLiteral(value);
        const quaternion = (q: Quat): string =>
            `bbl::Vec4{${q.map(float).join(", ")}}`;
        const output = resolve("artifacts/imported-node-transforms-check");
        const headers = join(output, "bblite/upstream");
        mkdirSync(headers, { recursive: true });
        writeFileSync(
            join(headers, "pinned_matrix.hpp"),
            pinnedMatrixHeader(context),
        );
        writeFileSync(
            join(headers, "pinned_world_transform.hpp"),
            pinnedWorldTransformHeader(context),
        );
        const render = new RendererLowerer(context).lowerRenderPlan({}).source;
        const worlds = [
            "std::array<float, 16> mesh_local_matrix(const MeshRecord&",
            "std::array<float, 16> transform_node_local_matrix(",
            "std::array<float, 16> transform_node_world(",
            "std::optional<std::array<float, 16>> mesh_root_world(",
            "std::array<float, 16> mesh_world_matrix(",
        ]
            .map((signature) => cppFunction(render, signature))
            .join("\n");
        const scene = new SceneLowerer(context).lowerCore().source;
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            file,
            `#include <bblite/upstream/pinned_matrix.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>
#include <bblite/js_data.hpp>
#include <algorithm>
#include <cassert>
#include <cmath>
namespace bbl::upstream {
${worlds}
}
namespace bbl {
AssetRecord& asset_record(Engine& engine, std::uint32_t asset) { return engine.assets.at(asset); }
${cppFunction(scene, "void mark_mesh_dirty(")}
${cppFunction(scene, "void set_mesh_rotation_quaternion(")}
${assetRootTransformSource(context)}
}
int main() {
    using namespace bbl;
    Engine engine;
    engine.assets.emplace_back();
    const AssetHandle asset{0};
    const std::array<float, 16> loaded_root{${loadedRoot.map(float).join(", ")}};
    ${nodes
        .map(
            ({ translation }, index) => `engine.meshes.emplace_back();
    engine.meshes[${index}].position = Vec3d{${translation.join(", ")}};
    engine.meshes[${index}].parent_world = loaded_root;
    engine.assets[0].meshes.push_back(MeshHandle{${index}});`,
        )
        .join("\n    ")}
    set_asset_root_position(engine, asset, Vec3d{3, 0.15, -7});
    set_asset_root_rotation(engine, asset, Vec3d{0.05, 1.2, -0.03});
    set_mesh_rotation_quaternion(engine, MeshHandle{0}, ${quaternion(body)});
    engine.meshes[0].position.y = 0.45;
    mark_mesh_dirty(engine, MeshHandle{0});
    set_mesh_rotation_quaternion(engine, MeshHandle{1}, ${quaternion(front)});
    set_mesh_rotation_quaternion(engine, MeshHandle{2}, ${quaternion(rear)});
    ${nodes
        .map(
            ({ node }, index) => `{
        const auto world = upstream::mesh_world_matrix(engine, engine.meshes[${index}]);
        const std::array<float, 16> expected{${Array.from(node.worldMatrix).map(float).join(", ")}};
        for (std::size_t cell = 0; cell < 16; ++cell)
            assert(std::abs(world[cell] - expected[cell]) <= 1e-5f * std::max(1.0f, std::abs(expected[cell])));
    }`,
        )
        .join("\n    ")}
}
`,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/O2",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            "/I",
            output,
            file,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);

// A node-carrying load: the synthetic root over a transform-only node over
// a glTF `matrix` node over the primitive's node, the primitive an
// identity-TRS child. Scene code moves the root and the transform-only
// node, writes the locked matrix node's TRS (which the pin ignores) and
// scales the leaf; the primitive's world composes through every node as the
// pin's scene nodes compose it.
test(
    "an imported node hierarchy composes transform-only and matrix nodes as the pin's scene nodes do",
    { skip: !tools },
    async () => {
        const { createSceneNode, createSceneNodeFromMatrix } =
            await importPinnedModule<{
                createSceneNode(
                    this: void,
                    name: string,
                    ...trs: number[]
                ): Node;
                createSceneNodeFromMatrix(
                    this: void,
                    name: string,
                    matrix: number[],
                ): Node;
            }>("scene/scene-node.js");
        const matrix = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1];
        const root = createSceneNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const pivot = createSceneNode(
            "pivot",
            10,
            20,
            30,
            0,
            0,
            0,
            1,
            -2,
            3,
            1,
        );
        const locked = createSceneNodeFromMatrix("node_1", matrix);
        const leaf = createSceneNode("leaf", 0, 0, 0, 0, 0.6, 0, 0.8, 1, 1, 1);
        const mesh = createSceneNode("mesh");
        pivot.parent = root;
        locked.parent = pivot;
        leaf.parent = locked;
        mesh.parent = leaf;
        root.position.set(3, 0.15, -7);
        pivot.position.set(1, 2, 3);
        pivot.rotationQuaternion.set(0, 0, 0.6, 0.8);
        locked.position.set(9, 9, 9);
        leaf.position.set(0, 0.5, 0);
        const context = new LoweringContext();
        const float = (value: number): string => context.floatLiteral(value);
        const output = resolve("artifacts/imported-node-hierarchy-check");
        const headers = join(output, "bblite/upstream");
        mkdirSync(headers, { recursive: true });
        writeFileSync(
            join(headers, "pinned_matrix.hpp"),
            pinnedMatrixHeader(context),
        );
        writeFileSync(
            join(headers, "pinned_world_transform.hpp"),
            pinnedWorldTransformHeader(context),
        );
        const render = new RendererLowerer(context).lowerRenderPlan({}).source;
        const worlds = [
            "std::array<float, 16> mesh_local_matrix(const MeshRecord&",
            "std::array<float, 16> transform_node_local_matrix(",
            "std::array<float, 16> transform_node_world(",
            "std::optional<std::array<float, 16>> mesh_root_world(",
            "std::array<float, 16> mesh_world_matrix(",
        ]
            .map((signature) => cppFunction(render, signature))
            .join("\n");
        const scene = new SceneLowerer(context).lowerCore({
            transformNodes: true,
        }).source;
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            file,
            `#include <bblite/upstream/pinned_matrix.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>
#include <bblite/js_data.hpp>
#include <algorithm>
#include <cassert>
#include <cmath>
namespace bbl::upstream {
${worlds}
}
namespace bbl {
${[
    "void mark_mesh_dirty(",
    "void mark_transform_node_dirty(",
    "void transform_node_trs_written(",
    "void set_transform_node_position(",
    "void set_transform_node_scaling(",
    "void set_transform_node_rotation_quaternion(",
]
    .map((signature) => cppFunction(scene, signature))
    .join("\n")}
}
int main() {
    using namespace bbl;
    Engine engine;
    const auto node = [&](Vec3d position, Vec4 rotation, Vec3 scaling, std::uint32_t parent) {
        TransformNodeRecord record;
        record.position = position;
        record.rotation_quaternion = rotation;
        record.has_rotation_quaternion = true;
        record.scaling = scaling;
        if (parent != invalid_handle) record.parent = TransformNodeHandle{parent, 0, nullptr};
        engine.transform_nodes.push_back(record);
        const TransformNodeHandle handle{static_cast<std::uint32_t>(engine.transform_nodes.size() - 1), 0, nullptr};
        if (parent != invalid_handle) engine.transform_nodes[parent].parented_nodes.push_back(handle);
        return handle;
    };
    const auto root = node(Vec3d{0, 0, 0}, Vec4{0, 0, 0, 1}, Vec3{-1, 1, 1}, invalid_handle);
    const auto pivot = node(Vec3d{10, 20, 30}, Vec4{0, 0, 0, 1}, Vec3{-2, 3, 1}, root.value);
    const auto locked = node(Vec3d{0, 0, 0}, Vec4{0, 0, 0, 1}, Vec3{1, 1, 1}, pivot.value);
    engine.transform_nodes[locked.value].local_matrix =
        std::array<float, 16>{${matrix.map(float).join(", ")}};
    engine.transform_nodes[locked.value].local_matrix_locked = true;
    const auto leaf = node(Vec3d{0, 0, 0}, Vec4{0, 0.6f, 0, 0.8f}, Vec3{1, 1, 1}, locked.value);
    engine.meshes.emplace_back();
    engine.meshes[0].transform_parent = leaf;
    engine.transform_nodes[leaf.value].parented_meshes.push_back(MeshHandle{0});
    set_transform_node_position(engine, root, Vec3d{3, 0.15, -7});
    set_transform_node_position(engine, pivot, Vec3d{1, 2, 3});
    set_transform_node_rotation_quaternion(engine, pivot, Vec4{0, 0, 0.6f, 0.8f});
    set_transform_node_position(engine, locked, Vec3d{9, 9, 9});
    assert(engine.transform_nodes[locked.value].local_matrix.has_value());
    set_transform_node_position(engine, leaf, Vec3d{0, 0.5, 0});
    const auto world = upstream::mesh_world_matrix(engine, engine.meshes[0]);
    const std::array<float, 16> expected{${Array.from(mesh.worldMatrix).map(float).join(", ")}};
    for (std::size_t cell = 0; cell < 16; ++cell)
        assert(std::abs(world[cell] - expected[cell]) <= 1e-5f * std::max(1.0f, std::abs(expected[cell])));
    // Once unlocked, a TRS write hands the local back to the TRS lanes.
    engine.transform_nodes[locked.value].local_matrix_locked = false;
    set_transform_node_scaling(engine, locked, Vec3{1, 1, 1});
    assert(!engine.transform_nodes[locked.value].local_matrix.has_value());
}
`,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/O2",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            "/I",
            output,
            file,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
