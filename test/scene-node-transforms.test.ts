import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { sceneNodeTransformsSource } from "../src/lowering/scene-node-transforms.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("retained SceneNode transforms and narrowed optional handles use concrete dispatch", () => {
    const { cpp, manifest } = compileSource(`
        import { createEngine, createTransformNode, createBox, type SceneNode } from "@babylonjs/lite";
        const engine = await createEngine({});
        interface Holder { root: SceneNode; wheel: SceneNode | null; }
        const holders: Holder[] = [];
        holders.push({ root: createTransformNode("root"), wheel: createBox(engine, 1) });
        function overwrite(holder: Holder): number {
            holder.root.position.y = 20;
            return 3;
        }
        function rotate(node: SceneNode): void {
            node.rotationQuaternion.x = 0;
            node.rotationQuaternion.y = 1;
        }
        function move(holder: Holder): void {
            holder.root.position.set(1e10, 2, 3);
            holder.root.position.y += overwrite(holder);
            holder.root.rotation.set(0, 1, 0);
            const { wheel } = holder;
            if (wheel) {
                const rotation: [number, number, number, number] = [0, 0, 0, 1];
                wheel.rotationQuaternion.set(...rotation);
                rotate(wheel);
            }
        }
        for (const holder of holders) move(holder);
    `);
    assert.match(cpp, /set_scene_node_position\(/);
    assert.match(cpp, /scene_node_position\(/);
    assert.match(cpp, /set_scene_node_rotation\(/);
    assert.match(cpp, /set_scene_node_rotation_quaternion\(/);
    assert.match(cpp, /const double [^;\n]+ = bbl::scene_node_position\(/);
    assert.match(cpp, /set_scene_node_position_component\(/);
    assert.match(cpp, /static_cast<float>/);
    assert.match(cpp, /set_scene_node_rotation_quaternion_component\(/);
    assert.doesNotMatch(cpp, /scene_node_rotation_quaternion\([^;\n]+\)\.[xyzw] =/);
    assert.match(cpp, /bbl::SceneNodeHandle/);
    assert.ok(manifest.features.includes("scene:node-transforms"));
    assert.doesNotMatch(new SceneLowerer(new LoweringContext()).lowerCore().source,
        /Vec3d scene_node_position\(/);
    assert.match(new SceneLowerer(new LoweringContext()).lowerCore({ sceneNodeTransforms: true }).source,
        /Vec3d scene_node_position\(/);
});

const nativeTools = optionalNativeFixtureTools();
test("SceneNode dispatch retains concrete dirty writers and imported root bounds", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/scene-node-transform-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "scene-node-transforms.hpp"),
        `namespace bbl { ${sceneNodeTransformsSource(true)} }`);
    const executable = join(output, "scene-node-transform-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/permissive-",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", output,
        "test/fixtures/js-callback/scene-node-transform-check.cpp",
    ]);
    assert.match(execFileSync(executable, [], { encoding: "utf8" }), /scene-node-transform-check: ok/);
});
