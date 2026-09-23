import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerWorldAabbHelpers } from "../src/lowering/world-bounds-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

interface PointerInput {
    button?: number;
    pointerId?: number;
    pointerType?: string;
    clientX?: number;
    clientY?: number;
    deltaY?: number;
    code?: string;
    preventDefault?: () => void;
}

type Listener = (event: PointerInput) => void;

interface Canvas {
    addEventListener(name: string, handler: Listener): void;
    removeEventListener(name: string, handler: Listener): void;
    setPointerCapture(): void;
    releasePointerCapture(): void;
    hasAttribute(): boolean;
    tabIndex: number;
}

function canvasStub(events: Map<string, Listener>): Canvas {
    return {
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
}

/** Writes the lowered camera sources a fixture links against. */
function cameraSources(directory: string): string[] {
    const lowerer = new CameraLowerer(new LoweringContext());
    const headers = join(directory, "include/bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const controls = lowerer.lowerControls();
    writeFileSync(join(headers, "camera_controls.hpp"), controls.header);
    writeFileSync(join(directory, "controls.cpp"), controls.source);
    writeFileSync(
        join(directory, "free.cpp"),
        lowerer.lowerFreeFactory().source,
    );
    return [join(directory, "controls.cpp"), join(directory, "free.cpp")];
}

function compileAndRun(
    directory: string,
    main: string,
    sources: readonly string[],
): number[] | undefined {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return undefined;
    const check = join(directory, "check.cpp");
    writeFileSync(check, main);
    const exe = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        `/I${join(directory, "include")}`,
        `/Fo${directory}/`,
        `/Fe${exe}`,
        check,
        ...sources,
    ]);
    return execFileSync(exe, { encoding: "utf8", timeout: 10000 })
        .trim()
        .split(/\s+/)
        .map(Number);
}

function assertClose(actual: number[], expected: number[]): void {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) =>
        assert.ok(
            Math.abs(value - expected[index]!) < 1e-10,
            `${index}: ${value} != ${expected[index]}`,
        ),
    );
}

test("free camera controls match the pinned buttons, keys and frame delta", async (t) => {
    const { createFreeCamera } = await importPinnedModule<{
        createFreeCamera(
            this: void,
            position: object,
            target: object,
        ): {
            _yaw: number;
            _pitch: number;
            worldMatrixVersion: number;
            position: { x: number; y: number; z: number };
            target: { x: number; y: number; z: number };
        };
    }>("camera/free-camera.js");
    const { attachFreeControl } = await importPinnedModule<{
        attachFreeControl(
            this: void,
            camera: ReturnType<typeof createFreeCamera>,
            canvas: Canvas,
            scene: { _beforeRender: Array<(delta: number) => void> },
        ): () => void;
    }>("camera/free-camera-controls.js");
    // Every DOM button the pin distinguishes, keys from each arm, and
    // deltas under, at and over the pinned 1 ms floor.
    const frames = [
        { delta: 0, button: 0, keys: ["KeyW", "ShiftLeft"], dx: 120, dy: -30 },
        { delta: 16.7, button: 1, keys: ["KeyA", "Space"], dx: -40, dy: 15 },
        { delta: 33, button: 2, keys: ["KeyD", "PageUp"], dx: 9, dy: 4000 },
        {
            delta: 8,
            button: 3,
            keys: ["ArrowDown", "PageDown"],
            dx: 70,
            dy: 70,
        },
        {
            delta: 0.4,
            button: 4,
            keys: ["ArrowUp", "ShiftRight"],
            dx: 5,
            dy: 5,
        },
        ...Array.from({ length: 60 }, (_, index) => ({
            delta: index % 2 ? 16.7 : 6.9,
            button: 0,
            keys: [] as string[],
            dx: 0,
            dy: 0,
        })),
    ];
    const camera = createFreeCamera({ x: 2, y: 3, z: 4 }, { x: 0, y: 0, z: 1 });
    const expected: number[] = [camera._yaw, camera._pitch];
    const scene = { _beforeRender: [] as Array<(delta: number) => void> };
    const events = new Map<string, Listener>();
    attachFreeControl(camera, canvasStub(events), scene);
    for (const frame of frames) {
        for (const code of frame.keys) events.get("keydown")!({ code });
        events.get("pointerdown")!({
            button: frame.button,
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
    const directory = resolve("artifacts/free-camera-controls-check");
    mkdirSync(directory, { recursive: true });
    const actual = compileAndRun(
        directory,
        `#include <bblite/runtime.hpp>
#include <bblite/upstream/camera_controls.hpp>
#include <algorithm>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>
int main() {
    std::cout << std::setprecision(17);
    bbl::Engine engine;
    const auto handle = bbl::create_free_camera(engine, {2, 3, 4}, {0, 0, 1});
    auto& camera = engine.cameras[handle.value];
    std::cout << camera.free_yaw << '\\n' << camera.free_pitch << '\\n';
    bool dragging = false;
    ${frames
        .map(
            (frame) => `{
        const std::vector<std::string> keys{${frame.keys.map((key) => JSON.stringify(key)).join(",")}};
        bbl::upstream::free_camera_pointer_down(dragging, ${frame.button});
        bbl::upstream::free_camera_pointer_move(camera, dragging, ${frame.dx}, ${frame.dy});
        bbl::upstream::free_camera_pointer_up(dragging);
        bbl::upstream::free_camera_update(camera, ${frame.delta}, [&keys](std::string_view key) {
            return std::find(keys.begin(), keys.end(), key) != keys.end();
        });
        for (double value : {camera.position.x, camera.position.y, camera.position.z,
                camera.target.x, camera.target.y, camera.target.z, camera.free_yaw, camera.free_pitch,
                camera.world_matrix_version})
            std::cout << value << '\\n';
    }`,
        )
        .join("\n    ")}
}
`,
        cameraSources(directory),
    );
    if (!actual) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    assertClose(actual, expected);
});

test("arc-rotate pointer handlers match the pinned buttons, deferral and wheel", async (t) => {
    interface ArcCamera {
        alpha: number;
        beta: number;
        radius: number;
        target: { x: number; y: number; z: number };
        inertialAlphaOffset: number;
        inertialBetaOffset: number;
        inertialRadiusOffset: number;
        inertialPanningX: number;
        inertialPanningY: number;
    }
    const { createArcRotateCamera } = await importPinnedModule<{
        createArcRotateCamera(
            this: void,
            alpha: number,
            beta: number,
            radius: number,
            target: object,
        ): ArcCamera;
    }>("camera/arc-rotate.js");
    const { attachControl } = await importPinnedModule<{
        attachControl(
            this: void,
            camera: ArcCamera,
            canvas: Canvas,
            scene: { _beforeRender: Array<() => void> },
            options: object,
        ): () => void;
    }>("camera/arc-rotate-controls.js");
    const flags = { allow: true, dragActive: false, pickPending: false };
    // One step: the three deferral answers, then a DOM event or a frame.
    type Step = typeof flags &
        (
            | { kind: "down"; button: number; x: number; y: number }
            | { kind: "move"; x: number; y: number }
            | { kind: "up" }
            | { kind: "wheel"; deltaY: number }
            | { kind: "frame" }
        );
    const at = (step: Partial<typeof flags>) => ({ ...flags, ...step });
    const steps: Step[] = [
        { ...at({}), kind: "down", button: 0, x: 10, y: 20 },
        { ...at({}), kind: "move", x: 40, y: 5 },
        { ...at({}), kind: "move", x: 25, y: 60 },
        { ...at({}), kind: "up" },
        { ...at({}), kind: "frame" },
        // The auxiliary button starts no gesture.
        { ...at({}), kind: "down", button: 1, x: 0, y: 0 },
        { ...at({}), kind: "move", x: 90, y: -40 },
        { ...at({}), kind: "up" },
        { ...at({}), kind: "down", button: 2, x: 5, y: 5 },
        { ...at({}), kind: "move", x: -30, y: 45 },
        { ...at({}), kind: "up" },
        { ...at({}), kind: "wheel", deltaY: 100 },
        { ...at({}), kind: "wheel", deltaY: -300 },
        { ...at({}), kind: "frame" },
        // A refused press, a pending pick and an external drag.
        { ...at({ allow: false }), kind: "down", button: 0, x: 0, y: 0 },
        { ...at({}), kind: "move", x: 50, y: 50 },
        { ...at({}), kind: "up" },
        { ...at({}), kind: "down", button: 0, x: 0, y: 0 },
        { ...at({ pickPending: true }), kind: "move", x: 30, y: 30 },
        { ...at({}), kind: "move", x: 60, y: 10 },
        { ...at({ dragActive: true }), kind: "move", x: 80, y: 0 },
        { ...at({}), kind: "move", x: 120, y: 0 },
        { ...at({}), kind: "up" },
        ...Array.from({ length: 40 }, (): Step => ({
            ...at({}),
            kind: "frame",
        })),
    ];
    const camera = createArcRotateCamera(0.3, 1.1, 7, { x: 1, y: 2, z: 3 });
    const scene = { _beforeRender: [] as Array<() => void> };
    const events = new Map<string, Listener>();
    const live = { ...flags };
    attachControl(camera, canvasStub(events), scene, {
        shouldHandlePointerDown: () => live.allow,
        isExternalDragActive: () => live.dragActive,
        isExternalPickPending: () => live.pickPending,
    });
    const observe = (): number[] => [
        camera.alpha,
        camera.beta,
        camera.radius,
        camera.target.x,
        camera.target.y,
        camera.target.z,
        camera.inertialAlphaOffset,
        camera.inertialBetaOffset,
        camera.inertialRadiusOffset,
        camera.inertialPanningX,
        camera.inertialPanningY,
    ];
    const expected: number[] = [];
    for (const step of steps) {
        Object.assign(live, {
            allow: step.allow,
            dragActive: step.dragActive,
            pickPending: step.pickPending,
        });
        if (step.kind === "down")
            events.get("pointerdown")!({
                button: step.button,
                pointerId: 1,
                pointerType: "mouse",
                clientX: step.x,
                clientY: step.y,
            });
        else if (step.kind === "move")
            events.get("pointermove")!({ clientX: step.x, clientY: step.y });
        else if (step.kind === "up") events.get("pointerup")!({ pointerId: 1 });
        else if (step.kind === "wheel")
            events.get("wheel")!({
                deltaY: step.deltaY,
                preventDefault() {},
            });
        else scene._beforeRender[0]!();
        expected.push(...observe());
    }
    let lastX = 0;
    let lastY = 0;
    const native = steps
        .map((step) => {
            const deferral =
                `allow = ${step.allow}; drag_active = ${step.dragActive}; ` +
                `pick_pending = ${step.pickPending};`;
            let event: string;
            if (step.kind === "down") {
                [lastX, lastY] = [step.x, step.y];
                event = `bbl::upstream::arc_rotate_pointer_down(camera, dragging, panning, ${step.button}, false);`;
            } else if (step.kind === "move") {
                event = `bbl::upstream::arc_rotate_pointer_move(camera, dragging, panning, 0, ${step.x - lastX}, ${step.y - lastY});`;
                [lastX, lastY] = [step.x, step.y];
            } else if (step.kind === "up")
                event =
                    "bbl::upstream::arc_rotate_pointer_up(dragging, panning);";
            else if (step.kind === "wheel")
                event = `bbl::upstream::apply_arc_rotate_wheel(camera, ${step.deltaY});`;
            else event = "bbl::upstream::apply_arc_rotate_inertia(camera);";
            return `${deferral} ${event} observe();`;
        })
        .join("\n    ");
    const directory = resolve("artifacts/arc-rotate-controls-check");
    mkdirSync(directory, { recursive: true });
    const actual = compileAndRun(
        directory,
        `#include <bblite/runtime.hpp>
#include <bblite/upstream/camera_controls.hpp>
#include <iomanip>
#include <iostream>
int main() {
    std::cout << std::setprecision(17);
    bbl::Engine engine;
    bbl::CameraRecord record;
    record.alpha = 0.3; record.beta = 1.1; record.radius = 7; record.target = {1, 2, 3};
    record.inertia = 0.9; record.panning_inertia = 0.9; record.angular_sensibility = 1000;
    record.panning_sensibility = 50; record.wheel_precision = 3;
    engine.cameras.push_back(record);
    auto& camera = engine.cameras[0];
    bool allow = true, drag_active = false, pick_pending = false;
    camera.should_handle_pointer_down = [&] { return allow; };
    camera.external_drag_active = [&] { return drag_active; };
    camera.external_pick_pending = [&] { return pick_pending; };
    bool dragging = false, panning = false;
    const auto observe = [&] {
        for (double value : {camera.alpha, camera.beta, camera.radius, camera.target.x, camera.target.y,
                camera.target.z, camera.inertial_alpha_offset, camera.inertial_beta_offset,
                camera.inertial_radius_offset, camera.inertial_panning_x, camera.inertial_panning_y})
            std::cout << value << '\\n';
    };
    ${native}
}
`,
        cameraSources(directory),
    );
    if (!actual) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    assertClose(actual, expected);
});

test("the lowered world-bounds expansion matches the pinned one", async (t) => {
    interface Box {
        boundMin?: Float32Array;
        boundMax?: Float32Array;
        worldMatrix: Float32Array;
    }
    const { emptyWorldAabb, expandWorldAabbForMesh } =
        await importPinnedModule<{
            emptyWorldAabb(this: void): Record<string, number>;
            expandWorldAabbForMesh(
                this: void,
                acc: Record<string, number>,
                mesh: Box,
            ): void;
        }>("mesh/mesh-world-bounds.js");
    const f32 = (values: number[]) => new Float32Array(values);
    const meshes: Box[] = [
        {
            boundMin: f32([-0.5, -1.25, -0.3]),
            boundMax: f32([0.5, 1.25, 0.7]),
            worldMatrix: f32([
                0.8, 0.1, -0.2, 0, -0.3, 0.9, 0.4, 0, 0.25, -0.4, 1.1, 0, 3.3,
                -2.7, 12.9, 1,
            ]),
        },
        // A mesh without bounds contributes nothing.
        { worldMatrix: f32([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 9, 9, 1]) },
        {
            boundMin: f32([10.1, 0, -4]),
            boundMax: f32([11.7, 0.1, 5.5]),
            worldMatrix: f32([
                -1, 0, 0, 0, 0, 2.5, 0, 0, 0, 0, 0.333, 0, -7.1, 0.2, 0.3, 1,
            ]),
        },
    ];
    const acc = emptyWorldAabb();
    const expected: number[] = [];
    for (const mesh of meshes) {
        expandWorldAabbForMesh(acc, mesh);
        expected.push(...Object.values(acc));
    }
    const directory = resolve("artifacts/world-bounds-check");
    mkdirSync(join(directory, "include"), { recursive: true });
    const floats = (values: Float32Array | undefined) =>
        values
            ? `std::array<float, ${values.length}>{${Array.from(values, (value) => `static_cast<float>(${value})`).join(", ")}}`
            : "std::nullopt";
    const actual = compileAndRun(
        directory,
        `#include <bblite/runtime.hpp>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <limits>
#include <optional>
namespace {
${lowerWorldAabbHelpers(new LoweringContext())}
}
int main() {
    std::cout << std::setprecision(17);
    auto acc = empty_world_aabb();
    ${meshes
        .map(
            (mesh) => `{
        WorldAabbMesh mesh;
        mesh.bound_min = ${floats(mesh.boundMin)};
        mesh.bound_max = ${floats(mesh.boundMax)};
        mesh.world_matrix = ${floats(mesh.worldMatrix)};
        expand_world_aabb_for_mesh(acc, mesh);
        for (double value : acc) std::cout << value << '\\n';
    }`,
        )
        .join("\n    ")}
}
`,
        [],
    );
    if (!actual) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    assert.deepEqual(actual, expected);
});

const FREE_CONTROLS = "src/camera/free-camera-controls.ts";
const ARC_CONTROLS = "src/camera/arc-rotate-controls.ts";

function controlsSource(context: LoweringContext): string {
    return new CameraLowerer(context).lowerControls().source;
}

test("a changed free-camera key, button arm or frame floor flows into the controls", () => {
    assert.match(
        controlsSource(doctoredContext(FREE_CONTROLS, '"KeyW"', '"KeyZ"')),
        /pressed\("KeyZ"\)/,
    );
    assert.match(
        controlsSource(
            doctoredContext(FREE_CONTROLS, "e.button === 1", "e.button === 4"),
        ),
        /\(button == 4\.0\)/,
    );
    assert.match(
        controlsSource(
            doctoredContext(
                FREE_CONTROLS,
                "Math.max(deltaMs, 1)",
                "Math.max(deltaMs, 2)",
            ),
        ),
        /\(delta_ms, 2\.0\)/,
    );
});

test("a changed arc-rotate gesture default flows and an unlowered handler statement refuses", () => {
    assert.match(
        controlsSource(
            doctoredContext(
                ARC_CONTROLS,
                'secondaryButton ?? "pan"',
                'secondaryButton ?? "rotate"',
            ),
        ),
        /\(button == 2\.0\) \? std::string_view\{"rotate"\}/,
    );
    assert.throws(
        () =>
            controlsSource(
                doctoredContext(
                    ARC_CONTROLS,
                    "e.preventDefault();\n        // Read wheelPrecision",
                    "e.preventDefault();\n        canvas.focus();\n        // Read wheelPrecision",
                ),
            ),
        /canvas\.focus/,
    );
});

test("a changed framing scale or free-camera orientation flows into its factory", () => {
    assert.match(
        new CameraLowerer(
            doctoredContext(
                "src/scene/scene-camera.ts",
                "diag * 1.5",
                "diag * 2.5",
            ),
        ).lowerDefaultFactory().source,
        /double radius = \(diag \* 2\.5\);/,
    );
    assert.match(
        new CameraLowerer(
            doctoredContext(
                "src/camera/free-camera.ts",
                "Math.atan2(dx, dz)",
                "Math.atan2(dz, dx)",
            ),
        ).lowerFreeFactory().source,
        /camera\.free_yaw = std::atan2\(dz, dx\);/,
    );
    assert.match(
        lowerWorldAabbHelpers(
            doctoredContext(
                "src/mesh/mesh-world-bounds.ts",
                "transformedRadius += Math.abs(coefficient) * extent[column]!;",
                "transformedRadius += coefficient * extent[column]!;",
            ),
        ),
        /transformedRadius \+= \(coefficient \* static_cast<double>/,
    );
});
