import assert from "node:assert/strict";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { GizmoLowerer } from "../src/lowering/gizmo-lowerer.js";
import { PickingLowerer } from "../src/lowering/picking-lowerer.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("editor proxy registers identity-preserving listeners and live drag predicates", () => {
    const cpp = compileSource(`
        import { createEngine, createSceneContext, createUtilityLayer, createPositionGizmo, registerPointerDrag, isGizmoDragging } from "babylon-lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const layer = createUtilityLayer(engine, scene);
        const gizmo = createPositionGizmo(engine, layer);
        const handlers = new Map<string, EventListener[]>();
        const proxy = {
            addEventListener(type: string, handler: EventListener): void {
                const list = handlers.get(type);
                if (list) list.push(handler); else handlers.set(type, [handler]);
            },
            removeEventListener(type: string, handler: EventListener): void {
                const list = handlers.get(type);
                const index = list?.indexOf(handler) ?? -1;
                if (index >= 0) list!.splice(index, 1);
            }
        } as unknown as HTMLCanvasElement;
        const axis = gizmo.xGizmo;
        axis._disposePointer();
        axis._disposePointer = registerPointerDrag(layer, proxy, axis.drag);
        console.log(isGizmoDragging(proxy));
        axis._disposePointer();
    `).cpp;
    assert.match(cpp, /create_pointer_drag_dispatcher\([^\n]+false\)/);
    assert.equal((cpp.match(/pointer_drag_listener\(/g) ?? []).length, 5);
    assert.match(cpp, /set_pointer_drag_cleanup\(/);
    assert.match(cpp, /array_index_of\(/);
    assert.match(cpp, /array_splice_one\(/);
    assert.match(cpp, /pointer_drag_state\([^\n]+0u\)/);
    assert.match(cpp, /dispose_pointer = bbl::register_pointer_drag/);
});

test("pointer drag lowers pinned math, enlarged colliders and unregister cleanup", () => {
    const source = new GizmoLowerer(new LoweringContext(), ["gizmo:axis-drag", "gizmo:plane-drag", "gizmo:position", "gizmo:pointer-drag"]).lower().source;
    assert.match(source, /Vec3d delta = Vec3d/);
    assert.match(source, /drag_axis_plane\(/);
    assert.match(source, /drag_local_delta\(/);
    assert.match(source, /collider_start/);
    assert.match(source, /state->drags\.push_back/);
    assert.match(source, /dispose_picker\(\*state->engine, state->picker\)/);
    assert.match(source, /weak\.lock\(\)/);
    assert.match(source, /event\.as<PlatformMouseEvent>\(\)/);
});

test("returned canvas proxy keeps its dispatcher in orbit-control closures", () => {
    const cpp = compileSource(`
        import { createEngine, createSceneContext, createUtilityLayer, createPositionGizmo,
            createArcRotateCamera, attachControl, registerPointerDrag, isGizmoDragging, isGizmoPickPending } from "babylon-lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const layer = createUtilityLayer(engine, scene);
        const gizmo = createPositionGizmo(engine, layer);
        function attachPointer() {
            const handlers = new Map<string, EventListener[]>();
            const canvas = {
                addEventListener(type: string, handler: EventListener): void {
                    const list = handlers.get(type);
                    if (list) list.push(handler); else handlers.set(type, [handler]);
                },
                removeEventListener(type: string, handler: EventListener): void {
                    const list = handlers.get(type);
                    const index = list?.indexOf(handler) ?? -1;
                    if (index >= 0) list!.splice(index, 1);
                }
            } as unknown as HTMLCanvasElement;
            const dispose = registerPointerDrag(layer, canvas, gizmo.xGizmo.drag);
            return { canvas, dispose };
        }
        const pointer = attachPointer();
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        attachControl(camera, engine.canvas, scene, {
            isExternalDragActive: () => isGizmoDragging(pointer.canvas),
            isExternalPickPending: () => isGizmoPickPending(pointer.canvas),
        });
    `).cpp;
    assert.doesNotMatch(cpp, /pointer_drag_state\(nullptr/);
    const dispatcher = cpp.match(/auto (\w+) = bbl::create_pointer_drag_dispatcher/)!;
    assert.ok(dispatcher);
    assert.ok(cpp.includes(`pointer_drag_state(${dispatcher[1]}, 0u)`));
    assert.ok(cpp.includes(`pointer_drag_state(${dispatcher[1]}, 1u)`));
});

test("rebuild subscribers registered after construction remain a live loop", () => {
    const cpp = compileSource(`
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        interface Source {
            rebuild(): void;
            subscribe(callback: (value: number) => void): () => void;
        }
        function createSource(): Source {
            const subscribers: ((value: number) => void)[] = [];
            const result: Source = {
                rebuild() { for (const callback of subscribers) callback(42); },
                subscribe(callback: (value: number) => void) {
                    subscribers.push(callback);
                    return () => {
                        const index = subscribers.indexOf(callback);
                        if (index >= 0) subscribers.splice(index, 1);
                    };
                }
            };
            return result;
        }
        const source = createSource();
        const unsubscribe = source.subscribe((value) => console.log(value));
        source.rebuild();
        unsubscribe();
        source.rebuild();
    `).cpp;
    assert.match(cpp, /for \(auto&& [^\n]+subscribers/);
    assert.match(cpp, /\w+\(42\.0\)/);
});

test("overlay GPU picking uses the picker scene in both backends", () => {
    const source = new PickingLowerer(new LoweringContext()).lower(false, false, true).source;
    assert.match(source, /gpu_pickers\.back\(\)\.scene = scene.state/);
    assert.match(source, /void populate_pick_ray\(/);
    for (const file of ["native/src/pal_sdl_gpu.cpp", "native/src/pal_dawn.cpp"]) {
        const backend = readFileSync(file, "utf8");
        assert.match(backend, /picker_scene_index\(engine, picker, active_registered_scenes\)/);
        assert.match(backend, /state\.overlay_meshes\[\*layer - 1\]/);
    }
});

const nativeTools = optionalNativeFixtureTools();
test("borrowed pointer identity and camera deferral survive drag and release", {
    skip: !nativeTools || !existsSync("generated/antigravity-racer/upstream/include/bblite/upstream/camera_controls.hpp"),
}, () => {
    const output = resolve("artifacts/editor-pointer-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "editor-pointer-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        "/I", "generated/antigravity-racer/upstream/include", "/I", join(nativeFixtureVcpkgRoot, "include"),
        "test/fixtures/js-callback/editor-pointer-check.cpp",
    ]);
    assert.match(execFileSync(executable, [], { encoding: "utf8" }), /editor-pointer-check: ok/);
});
