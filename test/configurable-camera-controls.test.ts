import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { CameraMutationLowerer } from "../src/lowering/camera-mutation-lowerer.js";
import { lowerConfigurableCameraControls } from "../src/lowering/configurable-camera-controls.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

interface Input {
    button?: number;
    pointerId?: number;
    clientX?: number;
    clientY?: number;
    code?: string;
}
interface Options {
    upKeys?: string[];
    downKeys?: string[];
    fastKeys?: string[];
    fastMultiplier?: number;
}

test("configurable free controls match the pinned input, inertia and key defaults", async (t) => {
    const { createFreeCamera } = await importPinnedModule<{
        createFreeCamera(
            this: void,
            position: object,
            target: object,
        ): {
            speed: number;
            inertia: number;
            angularSensitivity: number;
            _yaw: number;
            _pitch: number;
            worldMatrixVersion: number;
            position: { x: number; y: number; z: number };
            target: { x: number; y: number; z: number };
        };
    }>("camera/free-camera.js");
    const makeCamera = () => {
        const camera = createFreeCamera(
            { x: 2, y: 3, z: 4 },
            { x: 0, y: 0, z: 1 },
        );
        camera._yaw = 0.5;
        camera._pitch = 0.2;
        return camera;
    };
    interface Canvas {
        addEventListener(name: string, handler: (event: Input) => void): void;
        removeEventListener(
            name: string,
            handler: (event: Input) => void,
        ): void;
        setPointerCapture(): void;
        releasePointerCapture(): void;
        hasAttribute(): boolean;
        tabIndex: number;
    }
    const pin = await importPinnedModule<{
        attachConfigurableFreeControl(
            camera: ReturnType<typeof makeCamera>,
            canvas: Canvas,
            scene: { _beforeRender: Array<(delta: number) => void> },
            options: Options,
        ): () => void;
    }>("camera/configurable-free-camera-controls.js");
    const frames = [
        { delta: 0, keys: ["KeyW", "ShiftLeft"], dx: 120, dy: -30 },
        { delta: 16.7, keys: ["KeyA", "Space"], dx: 0, dy: 0 },
        { delta: 33, keys: ["KeyC", "ShiftRight"], dx: -24, dy: 4000 },
        { delta: 8, keys: ["ArrowDown", "PageDown"], dx: 0, dy: 0 },
        ...Array.from({ length: 65 }, () => ({
            delta: 16.7,
            keys: [] as string[],
            dx: 0,
            dy: 0,
        })),
    ];
    const options: Options[] = [
        {},
        {
            upKeys: ["Space"],
            downKeys: ["KeyC", "PageDown"],
            fastKeys: ["ShiftLeft", "ShiftRight"],
            fastMultiplier: 5,
        },
    ];
    const expected: number[] = [];
    for (const option of options) {
        const camera = makeCamera(),
            scene = { _beforeRender: [] as Array<(delta: number) => void> };
        const events = new Map<string, (event: Input) => void>();
        const canvas: Canvas = {
            addEventListener: (name, handler) => {
                events.set(name, handler);
            },
            removeEventListener: (name) => {
                events.delete(name);
            },
            setPointerCapture() {},
            releasePointerCapture() {},
            hasAttribute: () => false,
            tabIndex: -1,
        };
        const dispose = pin.attachConfigurableFreeControl(
            camera,
            canvas,
            scene,
            option,
        );
        assert.equal(canvas.tabIndex, 0);
        for (const frame of frames) {
            for (const code of frame.keys) events.get("keydown")!({ code });
            events.get("pointerdown")!({
                button: 2,
                pointerId: 1,
                clientX: 100,
                clientY: 200,
            });
            events.get("pointermove")!({
                clientX: 100 + frame.dx,
                clientY: 200 + frame.dy,
            });
            events.get("pointerup")!({ pointerId: 1 });
            scene._beforeRender[0]!(frame.delta);
            expected.push(
                camera.position.x,
                camera.position.y,
                camera.position.z,
                camera.target.x,
                camera.target.y,
                camera.target.z,
                camera._yaw,
                camera._pitch,
                camera.worldMatrixVersion,
            );
            for (const code of frame.keys) events.get("keyup")!({ code });
        }
        dispose();
        assert.equal(scene._beforeRender.length, 0);
        assert.equal(events.size, 0);
    }
    const source = lowerConfigurableCameraControls(
        new LoweringContext(),
    ).source;
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/configurable-camera-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        source +
            `
namespace bbl {
void clamp_camera_to_limits(CameraRecord&) {}
${new CameraMutationLowerer(new LoweringContext()).setters()}
}
` +
            `
#include <iostream>
#include <iomanip>
int main() {
    std::cout << std::setprecision(17);
    for (int variant = 0; variant < 2; ++variant) {
        bbl::Engine engine;
        engine.cameras.emplace_back();
        auto& camera = engine.cameras[0];
        camera.speed = 2; camera.inertia = 0.9; camera.angular_sensibility = 2000;
        camera.free_yaw = 0.5; camera.free_pitch = 0.2; camera.world_matrix_version = 2;
        camera.position = {2, 3, 4}; camera.target = {0, 0, 1};
        bbl::ConfigurableFreeControlOptions options;
        if (variant) {
            options.upKeys = {"Space"}; options.downKeys = {"KeyC", "PageDown"};
            options.fastKeys = {"ShiftLeft", "ShiftRight"}; options.fastMultiplier = 5;
        }
        bbl::attach_configurable_free_control(engine, bbl::CameraHandle{0}, options);
        ${frames
            .map(
                (frame) => `{
            const std::vector<std::string> keys{${frame.keys.map((key) => JSON.stringify(key)).join(",")}};
            camera.configurable_free_pointer(camera, ${frame.dx}, ${frame.dy});
            camera.configurable_free_update(camera, ${frame.delta}, [&keys](std::string_view key) {
                return std::find(keys.begin(), keys.end(), key) != keys.end();
            });
            for (double value : {camera.position.x, camera.position.y, camera.position.z,
                    camera.target.x, camera.target.y, camera.target.z, camera.free_yaw, camera.free_pitch, camera.world_matrix_version})
                std::cout << value << '\\n';
        }`,
            )
            .join("\n")}
    }
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    const actual = execFileSync(exe, { encoding: "utf8", timeout: 10000 })
        .trim()
        .split(/\s+/)
        .map(Number);
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) =>
        assert.ok(
            Math.abs(value - expected[index]!) < 1e-10,
            `${index}: ${value} != ${expected[index]}`,
        ),
    );
});
