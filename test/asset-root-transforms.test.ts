import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { assetRootTransformSource } from "../src/lowering/asset-root-transform.js";
import { LoweringContext } from "../src/lowering/context.js";
import { LightLowerer } from "../src/lowering/light-lowerer.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);
interface Vector {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): void;
}
interface Quaternion extends Omit<Vector, "set"> {
    w: number;
    set(x: number, y: number, z: number, w: number): void;
}
interface Root {
    position: Vector;
    rotation: Vector;
    scaling: Vector;
    rotationQuaternion: Quaternion;
    worldMatrix: ArrayLike<number>;
}

test(
    "imported root transforms and Euler cache match the pinned SceneNode",
    { skip: !tools },
    async () => {
        const { createSceneNode } = await importPinnedModule<{
            createSceneNode(this: void, name: string, ...trs: number[]): Root;
        }>("scene/scene-node.js");
        const root = createSceneNode("root", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const { createPointLight } = await importPinnedModule<{
            createPointLight(
                this: void,
                position: [number, number, number],
            ): Root & { parent: Root | null };
        }>("light/point-light.js");
        const light = createPointLight([-0.5, 0.25, 1]);
        light.parent = root;
        const output = resolve("artifacts/asset-root-transforms-check");
        mkdirSync(output, { recursive: true });
        const context = new LoweringContext();
        const headers = join(output, "bblite/upstream");
        mkdirSync(headers, { recursive: true });
        writeFileSync(
            join(headers, "pinned_matrix.hpp"),
            pinnedMatrixHeader(context),
        );
        const lightMatrix = new LightLowerer(context).lowerMatrix();
        writeFileSync(join(headers, "light_matrix.hpp"), lightMatrix.header);
        writeFileSync(
            join(headers, "pinned_world_transform.hpp"),
            pinnedWorldTransformHeader(context),
        );
        const steps: string[] = [];
        function snapshot(cpp: string) {
            const rotation = root.rotation;
            const quaternion = root.rotationQuaternion;
            const expected = [
                rotation.x,
                rotation.y,
                rotation.z,
                quaternion.x,
                quaternion.y,
                quaternion.z,
                quaternion.w,
            ];
            steps.push(`${cpp}
        {
            const auto euler = bbl::asset_root_rotation(engine, asset);
            const auto q = engine.assets[0].root_rotation_quaternion;
            const std::array<double, 7> observed{euler.x, euler.y, euler.z, q.x, q.y, q.z, q.w};
            const std::array<double, 7> expected{${expected.join(",")}};
            for (std::size_t i=0; i<7; ++i) assert(std::abs(observed[i]-expected[i]) < 1e-12);
            const auto world = bbl::asset_root_world_matrix(engine, asset);
            const std::array<float, 16> expected_world{${Array.from(
                root.worldMatrix,
            )
                .map((x) => context.floatLiteral(x))
                .join(",")}};
            for (std::size_t i=0; i<16; ++i) assert(std::abs(world[i]-expected_world[i]) < 1e-5f);
            auto corrected = bbl::upstream::outer_transform_matrix(engine.meshes[0]);
            // Replace the loader's initial X reflection, which is its own inverse.
            for (std::size_t row=0; row<4; ++row) corrected[row] = -corrected[row];
            for (std::size_t i=0; i<16; ++i) assert(std::abs(corrected[i]-expected_world[i]) < 1e-5f);
            const auto light_world = bbl::upstream::light_world_matrix(engine.lights[0]);
            const std::array<float, 16> expected_light{${Array.from(
                light.worldMatrix,
            )
                .map((x) => context.floatLiteral(x))
                .join(",")}};
            for (std::size_t i=0; i<16; ++i) assert(std::abs(light_world[i]-expected_light[i]) < 1e-5f);
        }`);
        }
        root.position.set(1, 2, -8);
        root.scaling.set(14, 14, 14);
        root.rotation.set(0, Math.PI / 3, 0);
        snapshot(
            "bbl::set_asset_root_position(engine, asset, {1,2,-8}); bbl::set_asset_root_scaling(engine, asset, {14,14,14}); bbl::set_asset_root_rotation(engine, asset, {0,std::numbers::pi/3,0});",
        );
        root.rotationQuaternion.set(0.2, 0.3, -0.1, 0.9);
        snapshot(
            "bbl::set_asset_root_rotation_quaternion(engine, asset, {.2,.3,-.1,.9});",
        );
        root.rotation.x += 0.05;
        snapshot(
            "bbl::set_asset_root_rotation_component(engine, asset, 0, bbl::asset_root_rotation(engine, asset).x + .05);",
        );
        root.scaling.x = 0;
        root.position.y = 4;
        snapshot(
            "bbl::set_asset_root_scaling_component(engine, asset, 0, 0); bbl::set_asset_root_position_component(engine, asset, 1, 4);",
        );
        root.scaling.set(-2, 3, 4);
        root.rotationQuaternion.w = 0.8;
        snapshot(
            "bbl::set_asset_root_scaling(engine, asset, {-2,3,4}); bbl::set_asset_root_rotation_quaternion_component(engine, asset, 3, .8);",
        );
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            file,
            `#include <bblite/upstream/pinned_world_transform.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <numbers>
namespace bbl {
AssetRecord& asset_record(Engine& engine, std::uint32_t asset) {return engine.assets.at(asset);}
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) {++engine.meshes.at(mesh.value).transform_version;}
${assetRootTransformSource(context)}
}
${lightMatrix.source}
int main() {
    bbl::Engine engine;
    engine.assets.emplace_back(); engine.meshes.emplace_back();
    engine.assets[0].meshes.push_back(bbl::MeshHandle{0});
    const bbl::AssetHandle asset{0};
    engine.lights.emplace_back();
    engine.lights[0].position = {-.5f,.25f,1};
    bbl::set_light_asset_parent(engine, bbl::LightHandle{0}, asset);
    ${steps.join("\n")}
    assert(engine.meshes[0].transform_version > 5);
    bbl::set_light_asset_parent(engine, bbl::LightHandle{0}, {});
    assert(!engine.lights[0].parent_world_matrix);
    assert(bbl::upstream::light_world_matrix(engine.lights[0])[12] == -.5f);
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

test("glTF root TRS reads, compound stores and matrices retain the source owner", () => {
    const url =
        "data:model/gltf+json;base64," +
        Buffer.from(
            JSON.stringify({
                asset: { version: "2.0" },
                scenes: [{ nodes: [] }],
                scene: 0,
            }),
        ).toString("base64");
    const result =
        compileSource(`import {createEngine,loadGltf} from "@babylonjs/lite";
    const engine=await createEngine({});
    const asset=await loadGltf(engine,${JSON.stringify(url)});
    const root=asset.entities[0]!;
    root.scaling.set(14,14,14);
    root.rotation.set(0,Math.PI/3,0);
    root.rotationQuaternion.set(.2,.3,-.1,.9);
    root.position.y += root.worldMatrix[13]!;
    console.log(root.rotationQuaternion.w, root.rotation.x, root.scaling.x);`);
    assert.match(result.cpp, /set_asset_root_scaling/);
    assert.match(result.cpp, /asset_root_world_matrix_array/);
    assert.match(result.cpp, /asset_transform_component/);
});

test("asset records returned through Promise.all retain imported root identity", () => {
    const result = compileSource(`
        import {createEngine, loadGltf, cloneTransformNode, type EngineContext,
            type AssetContainer, type TransformNode} from "@babylonjs/lite";
        interface Placement { readonly container: AssetContainer; readonly root: TransformNode; placed: boolean; }
        async function load(engine: EngineContext, url: string): Promise<Placement> {
            const container = await loadGltf(engine, url);
            return {container, root: container.entities[0] as TransformNode, placed: false};
        }
        const engine = await createEngine({});
        const [first, second] = await Promise.all([load(engine, "first.glb"), load(engine, "second.glb")]);
        const selected = performance.now() > 0 ? first : second;
        selected.placed = true;
        const clone = cloneTransformNode(selected.root);
        clone.position.set(3, 0, 5);
    `);
    assert.match(result.cpp, /clone_asset_root/);
    assert.match(result.cpp, /set_asset_root_position/);
});
