import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { lowerSceneBeforeRenderDispatch } from "../src/lowering/camera-control-attachment.js";
import { lowerCameraMatrixCaches } from "../src/lowering/camera-matrix-cache.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

interface Input {
    button?: number;
    pointerId?: number;
    pointerType?: string;
    clientX?: number;
    clientY?: number;
    code?: string;
}
type Listener = (input: Input) => void;

class Canvas {
    readonly listeners = new Map<string, Set<Listener>>();
    tabIndex = -1;
    addEventListener(name: string, listener: Listener): void {
        let listeners = this.listeners.get(name);
        if (!listeners) this.listeners.set(name, (listeners = new Set()));
        listeners.add(listener);
    }
    removeEventListener(name: string, listener: Listener): void {
        this.listeners.get(name)?.delete(listener);
    }
    setPointerCapture(): void {}
    releasePointerCapture(): void {}
    hasAttribute(): boolean {
        return this.tabIndex !== -1;
    }
    dispatch(name: string, input: Input): void {
        for (const listener of this.listeners.get(name) ?? []) listener(input);
    }
}

interface Camera {
    target: { x: number; y: number; z: number };
    worldMatrixVersion: number;
    alpha?: number;
    beta?: number;
    radius?: number;
    _yaw?: number;
    _pitch?: number;
    inertialAlphaOffset?: number;
    inertialBetaOffset?: number;
    inertialRadiusOffset?: number;
    inertialPanningX?: number;
    inertialPanningY?: number;
}
interface Scene {
    _beforeRender: Array<(delta: number) => void>;
    _update(): void;
}

for (const kind of ["arc", "free"] as const) {
    test(`${kind} controls match pinned attachment ownership, live callback order and camera cache invalidation`, async (t) => {
        const [arc, free, arcControls, freeControls, scenes, matrices] =
            await Promise.all([
                importPinnedModule<{
                    createArcRotateCamera(
                        alpha: number,
                        beta: number,
                        radius: number,
                        target: object,
                    ): Camera;
                }>("camera/arc-rotate.js"),
                importPinnedModule<{
                    createFreeCamera(position: object, target: object): Camera;
                }>("camera/free-camera.js"),
                importPinnedModule<{
                    attachControl(
                        this: void,
                        camera: Camera,
                        canvas: Canvas,
                        scene: Scene,
                    ): () => void;
                }>("camera/arc-rotate-controls.js"),
                importPinnedModule<{
                    attachFreeControl(
                        this: void,
                        camera: Camera,
                        canvas: Canvas,
                        scene: Scene,
                    ): () => void;
                }>("camera/free-camera-controls.js"),
                importPinnedModule<{
                    createSceneContext(surface: object, options: object): Scene;
                    onBeforeRender(
                        scene: Scene,
                        callback: (delta: number) => void,
                    ): void;
                }>("scene/scene-core.js"),
                importPinnedModule<{
                    getCameraPosition(camera: Camera): {
                        x: number;
                        y: number;
                        z: number;
                    };
                    getViewMatrix(camera: Camera): Float32Array;
                    getProjectionMatrix(
                        camera: Camera,
                        aspect: number,
                    ): Float32Array;
                    getViewProjectionMatrix(
                        camera: Camera,
                        aspect: number,
                    ): Float32Array;
                }>("camera/camera.js"),
            ]);
        const camera =
            kind === "arc"
                ? arc.createArcRotateCamera(0.5, 1, 5, { x: 1, y: 2, z: 3 })
                : free.createFreeCamera(
                      { x: 2, y: 3, z: 4 },
                      { x: 0, y: 0, z: 1 },
                  );
        const scene = scenes.createSceneContext(
            { engine: { _currentDelta: 16.7, useFloatingOrigin: false } },
            { defaultRenderTask: false },
        );
        const canvas = new Canvas();
        const attach = () =>
            (kind === "arc"
                ? arcControls.attachControl
                : freeControls.attachFreeControl)(camera, canvas, scene);
        const initialView = matrices.getViewMatrix(camera);
        const initialProjection = matrices.getProjectionMatrix(camera, 1.6);
        const initialVp = matrices.getViewProjectionMatrix(camera, 1.6);
        const expected: number[] = [];
        const labels: string[] = [];
        const cpp: string[] = [];
        const values = (label: string, numbers: readonly number[]) => {
            expected.push(...numbers);
            labels.push(...numbers.map((_, index) => `${label}[${index}]`));
        };
        const snapshot = (label: string) => {
            const eye = matrices.getCameraPosition(camera);
            const view = matrices.getViewMatrix(camera);
            const projection = matrices.getProjectionMatrix(camera, 1.6);
            const vp = matrices.getViewProjectionMatrix(camera, 1.6);
            values(label, [
                camera.worldMatrixVersion,
                eye.x,
                eye.y,
                eye.z,
                camera.target.x,
                camera.target.y,
                camera.target.z,
                camera.alpha ?? 0,
                camera.beta ?? 0,
                camera.radius ?? 0,
                camera._yaw ?? 0,
                camera._pitch ?? 0,
                camera.inertialAlphaOffset ?? 0,
                camera.inertialBetaOffset ?? 0,
                camera.inertialRadiusOffset ?? 0,
                camera.inertialPanningX ?? 0,
                camera.inertialPanningY ?? 0,
                scene._beforeRender.length,
                canvas.listeners.get("pointermove")?.size ?? 0,
                Number(view === initialView),
                Number(projection === initialProjection),
                Number(vp === initialVp),
                ...view,
                ...projection,
                ...vp,
            ]);
            cpp.push("snapshot();");
        };
        const observe = (delta: number) => {
            values("before-render observer", [
                delta,
                camera.worldMatrixVersion,
                camera.target.x,
                matrices.getViewMatrix(camera)[3]!,
            ]);
        };
        const frame = () => {
            scene._update();
            cpp.push("run_scene_before_render(scene, 16.7);");
        };
        let x = 0,
            y = 0;
        const down = () => {
            canvas.dispatch("pointerdown", {
                button: 0,
                pointerId: 1,
                pointerType: "mouse",
                clientX: x,
                clientY: y,
            });
            cpp.push(
                "dispatch([](auto& control) { control.pointer_down(0.0, false); });",
            );
        };
        const move = (dx: number, dy: number) => {
            x += dx;
            y += dy;
            canvas.dispatch("pointermove", { clientX: x, clientY: y });
            cpp.push(
                `dispatch([](auto& control) { control.pointer_move(0.0, ${dx}, ${dy}); });`,
            );
        };
        const keyDown = (code: string) => {
            if (kind !== "free") return;
            canvas.dispatch("keydown", { code });
            cpp.push(
                `dispatch([](auto& control) { control.key_down(${JSON.stringify(code)}); });`,
            );
        };
        snapshot("created");
        const disposeA = attach();
        const staleUpdate = scene._beforeRender[0]!;
        cpp.push(
            "auto dispose_a = attach(); auto stale_update = engine.camera_control_bindings->entries.back()->update;",
        );
        scenes.onBeforeRender(scene, observe);
        cpp.push(
            "on_before_render(scene, [&](double delta) { observe(delta); });",
        );
        snapshot("attached A");
        down();
        move(120, -30);
        keyDown("KeyW");
        snapshot("input before scene update");
        frame();
        snapshot("A frame");
        disposeA();
        initialView[3] = 71;
        cpp.push("dispose_a(); initial_view[3] = 71;");
        move(15, 10);
        frame();
        snapshot("disposed A");
        const disposeB = attach();
        cpp.push("auto dispose_b = attach();");
        move(11, 13);
        frame();
        snapshot("fresh B without pointer down");
        disposeA();
        cpp.push("dispose_a();");
        staleUpdate(16.7);
        cpp.push("stale_update(16.7);");
        snapshot("retained A update after dispose");
        down();
        move(35, 20);
        keyDown("KeyD");
        frame();
        snapshot("B survives stale A disposer");
        const disposeC = attach();
        cpp.push("auto dispose_c = attach();");
        down();
        move(-20, 10);
        keyDown("Space");
        frame();
        snapshot("B and C independent attachments");
        disposeB();
        disposeB();
        cpp.push("dispose_b(); dispose_b();");
        move(9, -7);
        frame();
        snapshot("C survives B disposer");
        let disposeD: (() => void) | undefined;
        let switched = false;
        scenes.onBeforeRender(scene, () => {
            values("switcher invocation", [1]);
            if (switched) return;
            switched = true;
            disposeC();
            disposeD = attach();
        });
        cpp.push(`js::Callback<void()> dispose_d; bool switched = false;
on_before_render(scene, [&](double) { output(1); if (switched) return; switched = true; dispose_c(); dispose_d = attach(); });`);
        frame();
        snapshot("remove C before turn and append D");
        const selfRemove = () => {
            const index = scene._beforeRender.indexOf(selfRemove);
            scene._beforeRender.splice(index, 1);
        };
        scenes.onBeforeRender(scene, selfRemove);
        cpp.push(`js::Callback<void(double)> self_remove;
self_remove = [&](double) { const auto found = std::find(scene.before_render.begin(), scene.before_render.end(), self_remove); assert(found != scene.before_render.end()); scene.before_render.erase(found, found + 1); };
on_before_render(scene, self_remove);`);
        frame();
        snapshot("self removal keeps live source iteration");
        disposeC();
        disposeD!();
        cpp.push("dispose_c(); dispose_d();");
        frame();
        snapshot("all controls detached");

        const native = optionalNativeFixtureTools(false);
        if (!native) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        const context = new LoweringContext();
        const lowerer = new CameraLowerer(context);
        const arcSource = lowerer.lowerArcRotateFactory();
        const controls = lowerer.lowerControls();
        const directory = resolve(`artifacts/camera-control-lifecycle-${kind}`);
        const headers = join(directory, "bblite/upstream");
        mkdirSync(headers, { recursive: true });
        writeFileSync(join(headers, "camera_math.hpp"), arcSource.header);
        writeFileSync(join(headers, "camera_controls.hpp"), controls.header);
        writeFileSync(
            join(headers, "pinned_matrix.hpp"),
            pinnedMatrixHeader(context),
        );
        const result = runGeneratedProgram(
            native,
            `camera-control-lifecycle-${kind}`,
            `
#include <bblite/runtime.hpp>
#include <algorithm>
#include <cassert>
#include <iomanip>
#include <iostream>
${arcSource.source}
${lowerer.lowerFreeFactory().source}
${controls.source}
${lowerCameraMatrixCaches(context, false)}
namespace bbl {
${cppFunction(new SceneLowerer(context).lowerCore().source, "void on_before_render(")}
${lowerSceneBeforeRenderDispatch(context)}
}
int main() {
    using namespace bbl;
    using namespace bbl::upstream;
    std::cout << std::setprecision(17);
    Engine engine; Scene scene; scene.engine = &engine;
    const auto handle = ${kind === "arc" ? "create_arc_rotate_camera(engine, 0.5, 1, 5, {1,2,3})" : "create_free_camera(engine, {2,3,4}, {0,0,1})"};
    auto& camera = handle_at(engine.cameras, handle);
    const auto attach = [&] { return ${kind === "arc" ? "attach_control" : "attach_free_control"}(engine, handle, scene); };
    auto initial_view = get_camera_view_matrix(camera);
    auto initial_projection = get_camera_projection_matrix(camera, 1.6);
    auto initial_vp = get_camera_view_projection_matrix(camera, 1.6);
    const auto output = [](double value) { std::cout << value << '\\n'; };
    const auto observe = [&](double delta) { output(delta); output(camera.world_matrix_version); output(camera.target.x); output(get_camera_view_matrix(camera)[3]); };
    const auto snapshot = [&] {
        const auto eye = camera_position(camera);
        const auto view = get_camera_view_matrix(camera);
        const auto projection = get_camera_projection_matrix(camera, 1.6);
        const auto vp = get_camera_view_projection_matrix(camera, 1.6);
        for (const double value : {camera.world_matrix_version, eye.x, eye.y, eye.z,
            camera.target.x, camera.target.y, camera.target.z,
            ${kind === "arc" ? "camera.alpha, camera.beta, camera.radius, 0.0, 0.0" : "0.0, 0.0, 0.0, camera.free_yaw, camera.free_pitch"},
            camera.inertial_alpha_offset, camera.inertial_beta_offset, camera.inertial_radius_offset,
            camera.inertial_panning_x, camera.inertial_panning_y,
            static_cast<double>(scene.before_render.size()),
            engine.camera_control_bindings ? static_cast<double>(engine.camera_control_bindings->entries.size()) : 0.0,
            static_cast<double>(view == initial_view), static_cast<double>(projection == initial_projection), static_cast<double>(vp == initial_vp)}) output(value);
        for (std::size_t i = 0; i < 16; ++i) output(view.load(i));
        for (std::size_t i = 0; i < 16; ++i) output(projection.load(i));
        for (std::size_t i = 0; i < 16; ++i) output(vp.load(i));
    };
    const auto dispatch = [&](auto send) { if (engine.camera_control_bindings) for (const auto& control : engine.camera_control_bindings->entries) send(*control); };
    ${cpp.join("\n")}
}
`,
            { flags: [`/I${directory}`] },
        );
        const actual = result.trim().split(/\s+/).map(Number);
        assert.equal(actual.length, expected.length);
        actual.forEach((value, index) => {
            assert.ok(
                Math.abs(value - expected[index]!) < 1e-10,
                `${kind} ${labels[index]}: ${value} != ${expected[index]}`,
            );
        });
    });
}
