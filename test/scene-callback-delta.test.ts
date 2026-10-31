import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cameraSources } from "./camera-fixture.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { lowerSceneBeforeRenderDispatch } from "../src/lowering/camera-control-attachment.js";
import { compileSource } from "../src/compiler.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sharedGpuSource,
} from "./native-fixture.js";
import { createPinnedScene, type PinnedScene } from "./pinned-scene.js";

const tools = optionalNativeFixtureTools(false);
test(
    "authored scene deltas survive the initial zero engine delta and remain per scene",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/scene-callback-delta");
        mkdirSync(output, { recursive: true });
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        const lowered = new SceneLowerer(new LoweringContext()).lowerCore()
            .source;
        writeFileSync(
            file,
            `#include <cassert>
#include <limits>
struct Scene { double fixed_delta_ms; };
${cppFunction(lowered, "double scene_callback_delta(")}
int main() {
    Scene fixed{1000.0 / 60.0}, other{25}, live{0};
    assert(scene_callback_delta(fixed, 0) == 1000.0 / 60.0);
    assert(scene_callback_delta(other, 0) == 25);
    assert(scene_callback_delta(live, 0) == 0);
    assert(scene_callback_delta(live, 7.125) == 7.125);
    fixed.fixed_delta_ms = -1;
    assert(scene_callback_delta(fixed, 9) == 9);
    fixed.fixed_delta_ms = std::numeric_limits<double>::quiet_NaN();
    assert(scene_callback_delta(fixed, 9) == 9);
    fixed.fixed_delta_ms = 40;
    assert(scene_callback_delta(fixed, 9) == 40);
}`,
        );
        runNativeFixtureCompiler(tools!, [
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            file,
        ]);
        execFileSync(executable);
        const shared = sharedGpuSource();
        assert.match(shared, /frame_clock.advance\(frame_delta_ms\)/);
        assert.match(shared, /scene_callback_delta\(\*registered, delta_ms\)/);
        const compiled =
            compileSource(`import {createEngine,createSceneContext} from '@babylonjs/lite';
        const engine=await createEngine({});const scene=createSceneContext(engine);scene.fixedDeltaMs=1000/60;`);
        assert.match(compiled.cpp, /fixed_delta_ms = \(1000\.0 \/ 60\.0\)/);
    },
);

const cameraTools = optionalNativeFixtureTools();
test(
    "camera controls preserve per-scene deltas and canvas attachment order",
    { skip: !cameraTools },
    async () => {
        const output = resolve("artifacts/camera-scene-delta");
        const sources = cameraSources(output, { arcRotate: true });
        const { createArcRotateCamera } = await importPinnedModule<{
            createArcRotateCamera(
                this: void,
                alpha: number,
                beta: number,
                radius: number,
                target: object,
            ): object;
        }>("camera/arc-rotate.js");
        const { attachControl } = await importPinnedModule<{
            attachControl(
                this: void,
                camera: object,
                canvas: object,
                scene: PinnedScene,
                options: object,
            ): () => void;
        }>("camera/arc-rotate-controls.js");
        const first = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
        const second = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
        const pointerDown: Array<(event: object) => void> = [];
        const canvas = {
            addEventListener(name: string, handler: (event: object) => void) {
                if (name === "pointerdown") pointerDown.push(handler);
            },
        };
        const pinnedOrder: number[] = [];
        const context = await createPinnedScene();
        for (const [camera, id] of [
            [first, 1],
            [second, 2],
            [first, 3],
        ] as const)
            attachControl(camera, canvas, context, {
                shouldHandlePointerDown() {
                    pinnedOrder.push(id);
                    return false;
                },
            });
        for (const listener of pointerDown)
            listener({
                button: 0,
                pointerType: "mouse",
                pointerId: 1,
                clientX: 0,
                clientY: 0,
            });
        const scene = new SceneLowerer(new LoweringContext()).lowerCore()
            .source;
        writeFileSync(
            join(output, "scene-callback-delta.hpp"),
            `namespace bbl {\n${cppFunction(scene, "double scene_callback_delta(")}\n${lowerSceneBeforeRenderDispatch(new LoweringContext())}\n}\nconst std::vector<int> pinned_camera_input_order{${pinnedOrder.join(",")}};\n`,
        );
        const executable = join(output, "camera-scene-delta-check.exe");
        runNativeFixtureCompiler(cameraTools!, [
            "/DSDL_STATIC_LIB",
            "/DBBLITE_HAS_UI=0",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/src",
            "/I",
            join(output, "include"),
            "/I",
            output,
            "test/fixtures/camera-scene-delta-check.cpp",
            ...sources,
        ]);
        assert.match(
            execFileSync(executable, [], { encoding: "utf8" }),
            /camera-scene-delta-check: ok/,
        );
    },
);
