import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runRmlUiFixture,
} from "./native-fixture.js";

/** Pointer capture shapes on the engine canvas, a retained canvas and stored elements. */
const windowShapes = `
setTimeout(() => {}, 0);
function capturePointerEvent(target: Element, event: PointerEvent): void {
    target.setPointerCapture(event.pointerId);
}
function installSecondaryPress(target: HTMLElement): void {
    target.addEventListener("pointerdown", (event) => {
        if (event.isTrusted) {
            try { target.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
        }
    }, { capture: true });
}
interface ControllerOptions { canvas: HTMLCanvasElement; label: string }
function createController(options: ControllerOptions): () => void {
    const { canvas } = options;
    let held: { pointerId: number } | null = null;
    canvas.addEventListener("pointerdown", (event) => {
        held = { pointerId: event.pointerId };
        if (event.isTrusted) canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointerup", (event) => {
        if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    });
    return () => {
        if (held && canvas.hasPointerCapture?.(held.pointerId)) canvas.releasePointerCapture(held.pointerId);
        held = null;
    };
}
async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    window.addEventListener("blur", createController({ canvas, label: "controller" }));
    const active = new Map<number, number>();
    let drag: { pointerId: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => {
        active.set(e.pointerId, 1);
        drag = { pointerId: e.pointerId };
        if (e.isTrusted) canvas.setPointerCapture(e.pointerId);
        capturePointerEvent(canvas, e);
    });
    canvas.addEventListener("pointerup", (e) => {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointercancel", () => {
        for (const pointerId of active.keys()) {
            if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
        }
        if (drag && canvas.hasPointerCapture?.(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    });
    installSecondaryPress(canvas);
    const cvs = document.createElement("canvas");
    document.body.append(cvs);
    cvs.onpointerdown = (e) => { cvs.setPointerCapture(e.pointerId); };
}
void main();
`;

test("pointer capture lowers natively on every element receiver in strict and deferred mode", () => {
    for (const options of [
        {},
        { deferredCapabilities: "runtime-throw" as const },
    ]) {
        const result = compileSource(windowShapes, options);
        assert.equal(result.manifest.deferredCapabilities, undefined);
        assert.ok(result.manifest.features.includes("input:dom"));
        // Strict mode refuses an unlowered receiver; identical listener bodies are shared.
        for (const operation of ["set", "has", "release"])
            assert.ok(
                result.cpp.includes(`bbl::dom_${operation}_pointer_capture(`),
                operation,
            );
        assert.doesNotMatch(result.cpp, /deferred_capability/);
    }
    // An authored method of the same name stays the program's own.
    const authored = compileSource(`
        const local = { setPointerCapture: (value: number) => value + 1 };
        if (local.setPointerCapture(2) !== 3) throw new Error("authored method");
    `);
    assert.doesNotMatch(authored.cpp, /dom_set_pointer_capture/);
});

test("pointer capture retargets engine-canvas input until release, pointerup or pointercancel", () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "@babylonjs/lite";
        let log = "";
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const scene = new AbortController();
            const active = new Map<number, number>();
            let drag: { pointerId: number } | null = null;
            canvas.addEventListener("pointerdown", (e) => {
                active.set(e.pointerId, e.clientX);
                drag = { pointerId: e.pointerId };
                if (e.isTrusted) canvas.setPointerCapture(e.pointerId);
                log += canvas.hasPointerCapture(e.pointerId) ? "D" : "d";
            });
            canvas.addEventListener("gotpointercapture", () => { log += "G"; }, { signal: scene.signal });
            canvas.addEventListener("lostpointercapture", () => { log += "L"; }, { signal: scene.signal });
            canvas.addEventListener("pointermove", (e) => { log += e.clientX < 0 ? "o" : "m"; });
            canvas.addEventListener("mousemove", (e) => { if (e.clientX < 0) log += "c"; });
            canvas.addEventListener("pointerup", (e) => {
                log += "U";
                if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
                active.delete(e.pointerId);
            });
            canvas.addEventListener("pointercancel", () => {
                log += "C";
                for (const pointerId of active.keys()) {
                    if (canvas.hasPointerCapture?.(pointerId)) log += "A";
                }
                if (drag && canvas.hasPointerCapture?.(drag.pointerId)) log += "R";
            });
            let capture = "";
            canvas.addEventListener("gotpointercapture", (e) => { capture += e.pointerType === "touch" ? "g" : "G"; });
            canvas.addEventListener("lostpointercapture", (e) => { capture += e.pointerType === "touch" ? "l" : "L"; });
            const expect = (phase: string, logged: string, captured: string): void => {
                if (log !== logged || capture !== captured) throw new Error(phase + " " + log + " " + capture);
                log = "";
                capture = "";
            };
            requestAnimationFrame(() => {
                // Captured motion and release outside the canvas still reach it.
                expect("first gesture", "mDGocUL", "GL");
                let errors = "";
                try { canvas.setPointerCapture(42); }
                catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") errors += "N"; }
                try { canvas.releasePointerCapture(42); }
                catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") errors += "n"; }
                // The mouse is active but no button is pressed: no capture.
                canvas.setPointerCapture(1);
                canvas.releasePointerCapture(1);
                if (errors !== "Nn" || canvas.hasPointerCapture(1) || canvas.hasPointerCapture(42))
                    throw new Error("capture errors " + errors);
                scene.abort();
                requestAnimationFrame(() => {
                    // A cancel ends the capture; aborted listeners no longer run.
                    expect("cancelled gesture", "DocCAR", "GL");
                    if (canvas.hasPointerCapture(1)) throw new Error("cancelled capture");
                    requestAnimationFrame(() => {
                        // A touch press captures implicitly until its release.
                        expect("touch", "DocU", "gl");
                        requestAnimationFrame(() => {
                            expect("captured drag", "Doc", "G");
                            // Disabling controls mid-drag releases every pointer they hold.
                            for (const pointerId of active.keys()) {
                                if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
                            }
                            requestAnimationFrame(() => {
                                // The next motion reports the loss and reaches what is under it.
                                expect("released drag", "", "L");
                                if (canvas.hasPointerCapture(1)) throw new Error("released capture");
                            });
                        });
                    });
                });
            });
            startEngine(engine);
        }
        void main();
    `);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(
        tools,
        "pointer-capture/engine",
        `#define main generated_main
${result.cpp}
#undef main
#include <bblite/pal_dom_events.hpp>
#include <cassert>
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
void start_engine(Engine& engine) {
    const auto inside = dom_canvas_path();
    const std::vector<DomEventTarget> outside{DomEventTarget::document(), DomEventTarget::window()};
    const auto send = [&](DomPointerAction action, double x, double button, double buttons,
                          const std::vector<DomEventTarget>& path) {
        dispatch_dom_batch(engine, dom_pointer_input(engine, action,
                                                      PlatformMouseEvent{.button = button,
                                                                         .buttons = buttons,
                                                                         .client_x = x,
                                                                         .client_y = 10},
                                                      path));
    };
    const auto frame = [&] {
        assert(engine.animation_frame_once_callbacks.size() == 1);
        const auto callbacks = std::move(engine.animation_frame_once_callbacks);
        engine.animation_frame_once_callbacks.clear();
        callbacks.front()(16.0);
    };
    auto& input = dom_input(engine);
    send(DomPointerAction::Move, 10, -1, 0, inside);
    send(DomPointerAction::Down, 10, 0, 1, inside);
    send(DomPointerAction::Move, -20, -1, 1, outside);
    assert(input.capture_overrides.contains(dom_mouse_pointer_id));
    assert(input.hover_path == inside);
    send(DomPointerAction::Up, -20, 0, 0, outside);
    // The release reaches the pointer's position.
    assert(!input.capture_overrides.contains(dom_mouse_pointer_id) && input.hover_path == outside);
    send(DomPointerAction::Move, -30, -1, 0, outside);
    frame();
    send(DomPointerAction::Down, 10, 0, 1, inside);
    send(DomPointerAction::Move, -20, -1, 1, outside);
    send(DomPointerAction::Cancel, -20, -1, 0, input.hover_path);
    assert(input.capture_overrides.empty() && input.pointer_captures->pending.empty());
    frame();
    DomTouchContact contact;
    contact.pointer.pointer_type = "touch";
    contact.pointer.pointer_id = 2;
    contact.pointer.buttons = 1;
    contact.pointer.client_x = 10;
    contact.path = inside;
    dispatch_dom_batch(engine, dom_touch_input(engine, DomPointerAction::Down, contact));
    assert(input.pointer_captures->active.contains(2));
    contact.pointer.button = -1;
    contact.pointer.client_x = -20;
    dispatch_dom_batch(engine, dom_touch_input(engine, DomPointerAction::Move, contact));
    contact.pointer.button = 0;
    contact.pointer.buttons = 0;
    dispatch_dom_batch(engine, dom_touch_input(engine, DomPointerAction::Up, contact));
    assert(!input.pointer_captures->active.contains(2) && input.capture_overrides.empty());
    frame();
    send(DomPointerAction::Down, 10, 0, 1, inside);
    send(DomPointerAction::Move, -20, -1, 1, outside);
    frame();
    send(DomPointerAction::Move, -30, -1, 1, outside);
    assert(input.capture_overrides.empty() && input.hover_path == outside);
    send(DomPointerAction::Up, -30, 0, 0, outside);
    frame();
    assert(engine.animation_frame_once_callbacks.empty());
}
} // namespace bbl
int main() { return generated_main(); }
`,
        { expectedOutput: "", timeoutMs: 20000 },
    );
});

test("pointer capture retargets Window input across the display and realm, beyond the window", (t) => {
    // test/fixtures/pointer-capture-window-check.cpp drives SDL input through the
    // Window display: its hit tests and the realm's listeners run on two threads.
    const result = compileSource(`
        let trace = "";
        const log = document.createElement("div");
        log.id = "log";
        document.body.append(log);
        function note(text: string): void { trace += text; log.textContent = trace; }
        function place(element: HTMLElement, style: string): void {
            element.style.cssText = "position:absolute;margin:0;" + style;
            document.body.append(element);
        }
        const panel = document.createElement("div");
        place(panel, "left:0px;top:0px;width:200px;height:150px;");
        const other = document.createElement("div");
        place(other, "left:300px;top:0px;width:2000px;height:150px;");
        const cvs = document.createElement("canvas");
        place(cvs, "left:0px;top:200px;width:200px;height:2000px;");
        const detached = document.createElement("div");
        // The receiver evaluates before the pointer id; an idle mouse is not captured.
        let order = "";
        function receiver(): HTMLElement { order += "t"; return panel; }
        function pointer(): number { order += "p"; return 1; }
        receiver().setPointerCapture(pointer());
        if (order !== "tp" || panel.hasPointerCapture(1)) note("!");
        function capturePointerEvent(target: Element, event: PointerEvent): void {
            if (event.isTrusted) target.setPointerCapture(event.pointerId);
        }
        function installSecondaryPress(target: HTMLElement): void {
            target.addEventListener("pointerdown", (event) => {
                try { detached.setPointerCapture(event.pointerId); }
                catch (error) { if (error instanceof DOMException && error.name === "InvalidStateError") note("I"); }
                if (event.isTrusted) {
                    try { target.setPointerCapture(event.pointerId); } catch { note("!"); }
                }
                try { target.setPointerCapture(99); }
                catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") note("N"); }
            }, { capture: true });
        }
        const lifetime = new AbortController();
        const windowListenerOptions: AddEventListenerOptions = { capture: true, signal: lifetime.signal };
        let releases = 0;
        window.addEventListener("pointerup", () => {
            note("W");
            if (++releases === 3) setTimeout(() => globalThis.close(), 0);
        }, windowListenerOptions);
        panel.addEventListener("pointerdown", (e) => {
            note("D");
            capturePointerEvent(panel, e);
            note(panel.hasPointerCapture(e.pointerId) ? "h" : "!");
        });
        panel.addEventListener("gotpointercapture", () => { note("G"); });
        panel.addEventListener("pointermove", () => { note("m"); });
        panel.addEventListener("pointerup", () => { note("U"); });
        panel.addEventListener("lostpointercapture", () => { note("L"); }, { signal: lifetime.signal });
        other.addEventListener("pointerover", () => { note("O"); });
        other.addEventListener("pointermove", () => { note("x"); });
        installSecondaryPress(other);
        cvs.onpointerdown = (e) => { cvs.setPointerCapture(e.pointerId); note("c"); };
        cvs.onpointermove = (e) => { if (cvs.hasPointerCapture(e.pointerId)) note("v"); };
        cvs.onpointerup = () => { note("u"); };
    `);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(result.cpp, /run_window_application/);
    const output = resolve("artifacts/pointer-capture-window");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), result.cpp);
    emitUpstreamGenerated(output, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "pointer-capture-window", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
            BBLITE_HAS_SDL_GPU: 1,
            BBLITE_HAS_DAWN: 0,
        },
        includeDirectories: [join(output, "upstream/include")],
    });
});
