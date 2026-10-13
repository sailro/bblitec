import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/** A Window realm whose application errors report to the captured stream. */
const windowRealm = `
#undef main
#include <bblite/pal_application_errors.hpp>
#include <iostream>
#include <sstream>
namespace bbl {
UiElementHandle ui_create_element(Engine& engine, std::string_view tag) {
    engine.ui_elements.emplace_back();
    engine.ui_elements.back().tag = std::string(tag);
    return {static_cast<std::uint32_t>(engine.ui_elements.size() - 1)};
}
UiElementHandle ui_append_to_root(Engine& engine, UiElementHandle element) {
    engine.ui_elements[element.value].attached_to_root = true;
    return element;
}
}
namespace bbl::pal {
ApplicationErrors* errors = nullptr;
Engine& window_document_engine() { static Engine engine; return engine; }
bool window_on_application_error(bool rejection, std::uint64_t identity, ApplicationErrors::Callback callback, bool once, ListenerLeasePtr lease) {
    return errors->add(rejection, identity, std::move(callback), once, std::move(lease));
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    ApplicationErrors handlers(loop);
    errors = &handlers;
    loop.set_timeout([&] { std::cerr << "application did not finish"; loop.close(); }, 2000);
    loop.run([&] { initialize(realm); });
    errors = nullptr;
    return 0;
}
}
int main() {
    std::ostringstream reports;
    auto* original = std::cerr.rdbuf(reports.rdbuf());
    const int result = generated_main();
    std::cerr.rdbuf(original);
    if (result != 0 || reports.str() != "Uncaught application error: unobserved\\n") {
        std::cerr << reports.str();
        return 1;
    }
}
`;

test("listener signals remove Window, Document and AbortSignal listeners with DOM semantics", () => {
    const result = compileSource(`
        // The error channel: a signal listener handles one error, then abort removes it.
        setTimeout(() => { throw new Error("handled"); }, 0);
        const errors = new AbortController();
        let handled = 0;
        window.addEventListener("error", (event: ErrorEvent) => { ++handled; event.preventDefault(); }, { signal: errors.signal });
        setTimeout(() => {
            if (handled !== 1) throw new Error("signal error listener");
            errors.abort();
            setTimeout(() => { throw new Error("unobserved"); }, 0);
            setTimeout(() => {
                if (handled !== 1) throw new Error("aborted error listener");
                globalThis.close();
            }, 0);
        }, 0);
        let order = "";
        // An aborted signal adds nothing.
        const aborted = new AbortController();
        aborted.abort();
        window.addEventListener("focus", () => { order += "!"; }, { signal: aborted.signal });
        const scene = new AbortController();
        const signal = scene.signal;
        // Capture listeners are distinct: abort removes only the signal's own one.
        const focusCapture = () => { order += "c"; };
        window.addEventListener("focus", focusCapture, { capture: true, signal });
        window.addEventListener("focus", focusCapture);
        // A duplicate added with a signal is not added, so abort keeps the plain one.
        const blurPlain = () => { order += "p"; };
        window.addEventListener("blur", blurPlain);
        window.addEventListener("blur", blurPlain, { signal });
        // Re-added under another signal, the listener no longer belongs to the first one.
        const other = new AbortController();
        const moved = () => { order += "m"; };
        window.addEventListener("blur", moved, { signal });
        window.removeEventListener("blur", moved);
        window.addEventListener("blur", moved, { signal: other.signal });
        // Removed then re-added without a signal: abort keeps the new listener.
        const readded = () => { order += "r"; };
        document.addEventListener("pointerdown", readded, { signal });
        document.removeEventListener("pointerdown", readded);
        document.addEventListener("pointerdown", readded);
        // once and signal combine; a plain add after the once dispatch survives abort.
        const onceThenPlain = () => { order += "o"; };
        window.addEventListener("resize", onceThenPlain, { once: true, signal });
        // One signal removes listeners on two targets.
        const shared = () => { order += "s"; };
        window.addEventListener("notify", shared, { signal });
        document.addEventListener("notify", shared, { signal });
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("blur"));
        document.dispatchEvent(new PointerEvent("pointerdown"));
        window.dispatchEvent(new Event("resize"));
        window.addEventListener("resize", onceThenPlain);
        window.dispatchEvent(new CustomEvent("notify"));
        document.dispatchEvent(new CustomEvent("notify"));
        if (order !== "ccpmross") throw new Error("before abort " + order);
        scene.abort();
        order = "";
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("blur"));
        document.dispatchEvent(new PointerEvent("pointerdown"));
        window.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new CustomEvent("notify"));
        document.dispatchEvent(new CustomEvent("notify"));
        if (order !== "cpmro") throw new Error("after abort " + order);
        other.abort();
        order = "";
        window.dispatchEvent(new Event("blur"));
        if (order !== "p") throw new Error("second signal " + order);
        // Abort inside a dispatch removes a later listener of that dispatch.
        const during = new AbortController();
        window.addEventListener("tick", () => { order += "A"; during.abort(); });
        window.addEventListener("tick", () => { order += "B"; }, { signal: during.signal });
        order = "";
        window.dispatchEvent(new CustomEvent("tick"));
        window.dispatchEvent(new CustomEvent("tick"));
        if (order !== "AA") throw new Error("abort during dispatch " + order);
        // Removal precedes the signal's own abort listeners.
        const early = new AbortController();
        early.signal.addEventListener("abort", () => { order += "E"; window.dispatchEvent(new CustomEvent("late")); });
        window.addEventListener("late", () => { order += "L"; }, { signal: early.signal });
        order = "";
        early.abort();
        if (order !== "E") throw new Error("removal before abort listeners " + order);
        // AbortSignal targets: their own signal, then another one, own the listener.
        const self = new AbortController();
        self.signal.addEventListener("abort", () => { order += "S"; }, { signal: self.signal });
        const owner = new AbortController();
        const watched = new AbortController();
        watched.signal.addEventListener("abort", () => { order += "W"; }, { signal: owner.signal });
        const kept = new AbortController();
        kept.signal.addEventListener("abort", () => { order += "K"; }, { once: true, signal: owner.signal });
        order = "";
        self.abort();
        kept.abort();
        owner.abort();
        watched.abort();
        if (order !== "K") throw new Error("abort listener signals " + order);
        // Application option shapes over stored targets.
        let shaped = 0;
        const LISTENER_OPTIONS: AddEventListenerOptions = { capture: true };
        const focusTypes = ["focus", "blur"] as const;
        interface InstallOptions { target: EventTarget; signal?: AbortSignal; keyTarget?: EventTarget | null }
        function install(options: InstallOptions): void {
            const count = (): void => { ++shaped; };
            const windowListenerOptions: AddEventListenerOptions = { capture: true, ...(options.signal ? { signal: options.signal } : {}) };
            const captureListenerOptions: AddEventListenerOptions | undefined = options.signal ? { signal: options.signal } : undefined;
            const listenerOptions = options.signal ? { capture: true, signal: options.signal } : { capture: true };
            options.target.addEventListener("resize", count, windowListenerOptions);
            options.target.addEventListener("tock", count, captureListenerOptions);
            options.target.addEventListener("pointerup", count, listenerOptions);
            options.keyTarget?.addEventListener("pointercancel", count, listenerOptions);
            options.target.addEventListener("pointermove", count, { signal: options.signal });
            for (const type of focusTypes) options.target.addEventListener(type, count, { capture: true, passive: true, signal: options.signal });
            options.target.addEventListener("pointerover", count, LISTENER_OPTIONS);
        }
        const lifetime = new AbortController();
        install({ target: window, signal: lifetime.signal, keyTarget: window });
        install({ target: document, keyTarget: null });
        function fireWindow(): void {
            window.dispatchEvent(new Event("resize"));
            window.dispatchEvent(new CustomEvent("tock"));
            window.dispatchEvent(new PointerEvent("pointerup"));
            window.dispatchEvent(new PointerEvent("pointercancel"));
            window.dispatchEvent(new PointerEvent("pointermove"));
            window.dispatchEvent(new Event("focus"));
            window.dispatchEvent(new Event("blur"));
            window.dispatchEvent(new PointerEvent("pointerover"));
        }
        fireWindow();
        document.dispatchEvent(new PointerEvent("pointermove"));
        if (shaped !== 9) throw new Error("shaped listeners " + shaped);
        lifetime.abort();
        fireWindow();
        document.dispatchEvent(new PointerEvent("pointermove"));
        if (shaped !== 11) throw new Error("shaped listeners after abort " + shaped);
        // Element targets.
        const panel = document.createElement("div");
        document.body.appendChild(panel);
        const elementLifetime = new AbortController();
        const press = () => { order += "e"; };
        panel.addEventListener("click", press, { signal: elementLifetime.signal });
        panel.addEventListener("pointerdown", press, { capture: true, once: true, signal: elementLifetime.signal });
        order = "";
        panel.dispatchEvent(new MouseEvent("click"));
        panel.dispatchEvent(new PointerEvent("pointerdown"));
        panel.dispatchEvent(new PointerEvent("pointerdown"));
        elementLifetime.abort();
        panel.dispatchEvent(new MouseEvent("click"));
        if (order !== "ee") throw new Error("element listeners " + order);
    `);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.ok(result.manifest.features.includes("input:dom"));
    assert.match(result.cpp, /bbl::js::add_event_listener\(/);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(
        tools,
        "listener-signals/window",
        `#define main generated_main\n${result.cpp}\n${windowRealm}`,
        {
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_HAS_UI=1"],
            expectedOutput: "",
            timeoutMs: 20000,
        },
    );
});

test("listener signals end canvas, Window, Document and visibility listeners under native input", () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "@babylonjs/lite";
        let hits = 0;
        function installCaptureTarget(target: EventTarget, signal: AbortSignal): void {
            target.addEventListener("pointerdown", () => { ++hits; }, { capture: true, signal });
        }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const scene = new AbortController();
            const sceneSignal = scene.signal;
            const count = (): void => { ++hits; };
            canvas.addEventListener("pointerdown", count, { signal: sceneSignal });
            canvas.addEventListener("wheel", () => { ++hits; }, { passive: true, signal: sceneSignal });
            canvas.addEventListener("pointerleave", () => { ++hits; }, { signal: sceneSignal });
            window.addEventListener("pointerup", count, { capture: true, signal: sceneSignal });
            window.addEventListener("wheel", () => { ++hits; }, { capture: true, passive: false, signal: sceneSignal });
            window.addEventListener("keydown", () => { ++hits; }, { signal: sceneSignal });
            window.addEventListener("blur", count, { signal: sceneSignal });
            document.addEventListener("keydown", count, { signal: sceneSignal });
            document.addEventListener("visibilitychange", () => { ++hits; }, { signal: sceneSignal });
            installCaptureTarget(canvas, sceneSignal);
            const kept = (): void => { ++hits; };
            canvas.addEventListener("pointerdown", kept);
            requestAnimationFrame(() => {
                if (hits !== 11) throw new Error("listeners before abort " + hits);
                scene.abort();
                requestAnimationFrame(() => {
                    if (hits !== 12) throw new Error("listeners after abort " + hits);
                });
            });
            startEngine(engine);
        }
        void main();
    `);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(result.cpp, /visibility_change_callbacks\.add\(/);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(
        tools,
        "listener-signals/engine",
        `#define main generated_main
${result.cpp}
#undef main
#include <bblite/pal_dom_events.hpp>
#include <cassert>
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
void start_engine(Engine& engine) {
    auto& input = dom_input(engine);
    unsigned calls = 0;
    const auto invoke = [&](auto& callback, const auto& event) {
        ++calls;
        callback(event);
    };
    const auto dispatch = [&] {
        calls = 0;
        input.pointer.dispatch(dom_event(PlatformMouseEvent{}, "pointerdown", dom_canvas_path()), invoke);
        input.pointer.dispatch(dom_event(PlatformMouseEvent{}, "wheel", dom_canvas_path()), invoke);
        input.pointer.dispatch(dom_event(PlatformMouseEvent{}, "pointerleave", {DomEventTarget::canvas()}, false, false), invoke);
        input.pointer.dispatch(dom_event(PlatformMouseEvent{}, "pointerup", dom_canvas_path()), invoke);
        input.pointer.dispatch(dom_event(PlatformMouseEvent{}, "blur", {DomEventTarget::window()}, false, false), invoke);
        input.keyboard.dispatch(dom_event(PlatformKeyboardEvent{}, "keydown", {DomEventTarget::document(), DomEventTarget::window()}), invoke);
        engine.visibility_change_callbacks.dispatch_with(invoke, true);
        return calls;
    };
    const auto frame = [&] {
        assert(engine.animation_frame_once_callbacks.size() == 1);
        const auto callbacks = std::move(engine.animation_frame_once_callbacks);
        engine.animation_frame_once_callbacks.clear();
        callbacks.front()(16.0);
    };
    assert(dispatch() == 11);
    frame();
    assert(dispatch() == 1);
    frame();
    assert(engine.animation_frame_once_callbacks.empty());
}
} // namespace bbl
int main() { return generated_main(); }
`,
        { expectedOutput: "", timeoutMs: 20000 },
    );
});

test("listener signals lower in deferred mode and refuse unrepresented operands", () => {
    const realm = `setTimeout(() => globalThis.close(), 0);`;
    const deferred = compileSource(
        `${realm} const c = new AbortController(); window.addEventListener("blur", () => {}, { signal: c.signal });`,
        { deferredCapabilities: "runtime-throw" },
    );
    assert.equal(deferred.manifest.deferredCapabilities, undefined);
    assert.match(deferred.cpp, /bbl::js::add_event_listener\(/);
    for (const [source, message] of [
        [
            `window.addEventListener("blur", () => {}, { signal: null });`,
            /accepts undefined or a DOM AbortSignal, not null/,
        ],
        [
            `window.addEventListener("blur", () => {}, { signal: 5 });`,
            /requires the DOM AbortSignal identity/,
        ],
        [
            `const signal = new AbortController().signal; const source = new AudioContext().createBufferSource(); source.addEventListener("ended", () => {}, { signal });`,
            /Audio ended listeners with an AbortSignal are not lowered/,
        ],
    ] as const)
        assert.throws(() => compileSource(realm + source), message);
});
