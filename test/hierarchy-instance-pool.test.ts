import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { assetRootTransformSource } from "../src/lowering/asset-root-transform.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMat4InvertCpp } from "../src/lowering/pinned-function-lowerer.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

interface Root {
    position: { set(x: number, y: number, z: number): void };
    scaling: { set(x: number, y: number, z: number): void };
    rotationQuaternion: {
        set(x: number, y: number, z: number, w: number): void;
    };
    worldMatrix: ArrayLike<number>;
    children: Root[];
    parent: Root | null;
}
interface Mesh extends Root {
    thinInstances?: { matrices: Float32Array; count: number };
}
interface Pool {
    meshes: Mesh[];
    count: number;
}

const tools = optionalNativeFixtureTools(false);
test(
    "hierarchy instances preserve reset and transformed imported roots",
    { skip: !tools },
    async () => {
        const { createSceneNode } = await importPinnedModule<{
            createSceneNode(this: void, name: string, ...trs: number[]): Root;
        }>("scene/scene-node.js");
        const { createHierarchyInstancePool, addHierarchyInstance } =
            await importPinnedModule<{
                createHierarchyInstancePool(
                    this: void,
                    root: Root,
                    capacity: number,
                ): Pool;
                addHierarchyInstance(
                    this: void,
                    pool: Pool,
                    matrix: Float32Array,
                ): number;
            }>("mesh/hierarchy-instance-pool.js");
        const { multiplyMat4 } = await importPinnedModule<{
            multiplyMat4(
                this: void,
                left: ArrayLike<number>,
                right: ArrayLike<number>,
            ): Float32Array;
        }>("math/multiply-mat4.js");
        const context = new LoweringContext();
        const literal = (matrix: ArrayLike<number>) =>
            `{${Array.from(matrix, (lane) => context.floatLiteral(lane)).join(",")}}`;
        const placements = [
            new Float32Array([
                1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 15, 5, 54, 1,
            ]),
            new Float32Array([
                0, 0, -2, 0, 0, 3, 0, 0, 4, 0, 0, 0, 81, 12, 10, 1,
            ]),
        ];
        const cases: string[] = [];
        for (const transform of ["original", "reset", "transformed"] as const) {
            const root = createSceneNode("root", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
            const meshes: Mesh[] = [
                Object.assign(
                    createSceneNode("first", 2, 3, 4, 0, 0, 0, 1, 2, 3, 4),
                    { _gpu: {}, material: {} },
                ),
                Object.assign(
                    createSceneNode("second", -5, 7, 9, 0, 0, 0, 1, 1, 2, 3),
                    { _gpu: {}, material: {} },
                ),
            ];
            for (const mesh of meshes) {
                root.children.push(mesh);
                mesh.parent = root;
            }
            const importedWorlds = meshes.map((mesh) =>
                Array.from(mesh.worldMatrix),
            );
            let edits = "";
            if (transform === "reset") {
                root.scaling.set(1, 1, 1);
                edits = "bbl::set_asset_root_scaling(engine, asset, {1,1,1});";
            } else if (transform === "transformed") {
                root.position.set(11, -7, 4);
                root.scaling.set(2, 3, 4);
                root.rotationQuaternion.set(0, 0.6, 0, 0.8);
                edits = `bbl::set_asset_root_position(engine, asset, {11,-7,4});
                    bbl::set_asset_root_scaling(engine, asset, {2,3,4});
                    bbl::set_asset_root_rotation_quaternion(engine, asset, {0,.6,0,.8});`;
            }
            const pool = createHierarchyInstancePool(root, placements.length);
            for (const placement of placements)
                addHierarchyInstance(pool, placement);
            assert.equal(pool.count, placements.length);
            cases.push(`{
                bbl::Engine engine;
                engine.assets.emplace_back(); engine.meshes.resize(${meshes.length});
                const bbl::AssetHandle asset{0};
                ${importedWorlds
                    .map(
                        (
                            world,
                            i,
                        ) => `engine.assets[0].meshes.push_back(bbl::MeshHandle{${i}});
                    engine.meshes[${i}].instance_parent_matrix = ${literal(world)};`,
                    )
                    .join("\n")}
                ${edits}
                const auto pool = bbl::create_hierarchy_instance_pool(engine, asset, ${placements.length});
                assert(engine.hierarchy_instance_pools[pool.value].count == 0);
                ${placements.map((placement, i) => `assert(bbl::add_hierarchy_instance(engine, pool, ${literal(placement)}) == ${i});`).join("\n")}
                ${meshes
                    .map((mesh, i) => {
                        assert.ok(mesh.thinInstances);
                        return `{
                        const auto& mesh = engine.meshes[${i}];
                        assert(mesh.thin_instanced && mesh.instance_count == ${placements.length});
                        const auto world = bbl::upstream::matrix_product(
                            bbl::upstream::outer_transform_matrix(mesh), mesh.instance_parent_matrix);
                        ${placements
                            .map((_placement, index) => {
                                const instance =
                                    mesh.thinInstances!.matrices.slice(
                                        index * 16,
                                        (index + 1) * 16,
                                    );
                                return `check(mesh.instance_matrices[${index}], ${literal(instance)});
                                check(bbl::upstream::matrix_product(world, mesh.instance_matrices[${index}]),
                                    ${literal(multiplyMat4(mesh.worldMatrix, instance))});`;
                            })
                            .join("\n")}
                    }`;
                    })
                    .join("\n")}
            }`);
        }
        const directory = resolve("artifacts/hierarchy-instance-pool-check");
        const headers = join(directory, "bblite/upstream");
        mkdirSync(headers, { recursive: true });
        writeFileSync(
            join(headers, "pinned_matrix.hpp"),
            pinnedMatrixHeader(context),
        );
        writeFileSync(
            join(headers, "pinned_world_transform.hpp"),
            pinnedWorldTransformHeader(context),
        );
        const scene = new SceneLowerer(context).lowerCore({
            parenting: true,
        }).source;
        const helpers = [
            "HierarchyInstancePoolRecord& hierarchy_instance_pool(",
            "std::array<float, 16> hierarchy_instance_matrix(",
            "void write_hierarchy_instance_matrix(",
            "HierarchyInstancePoolHandle create_hierarchy_instance_pool(",
            "void set_hierarchy_instance_count(",
            "double add_hierarchy_instance(",
        ]
            .map((signature) => cppFunction(scene, signature))
            .join("\n");
        const file = join(directory, "check.cpp");
        const executable = join(directory, "check.exe");
        writeFileSync(
            file,
            `#include <bblite/upstream/pinned_matrix.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>
#include <cassert>
namespace bbl {
using upstream::mat4_multiply_into;
AssetRecord& asset_record(Engine& engine, std::uint32_t asset) { return engine.assets.at(asset); }
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) { ++engine.meshes.at(mesh.value).transform_version; }
${assetRootTransformSource(context)}
${lowerMat4InvertCpp(context)}
${helpers}
}
void check(const std::array<float,16>& actual, const std::array<float,16>& expected) {
    for (std::size_t i=0; i<actual.size(); ++i) assert(std::abs(actual[i]-expected[i]) < 0.0001f);
}
int main() {
    ${cases.join("\n")}
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
            `/Fo:${directory}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            "/I",
            directory,
            file,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
