import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { runTranspiled } from "./self-checking-program.js";

const preamble = `
    import { createEngine } from "@babylonjs/lite";
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    await createEngine(canvas);
`;

test("structural event views retain the dispatch owner across helpers, methods and stored callbacks", (t) => {
    const result = compileSource(`
        ${preamble}
        type Code = Pick<KeyboardEvent, "code">;
        function position(event: Readonly<Code>): string {
            if (event.code === "KeyA") return "a";
            return event.code;
        }
        function selected(event: Code): boolean { return position(event) === "a"; }
        function view(event: Readonly<Code>): Readonly<Code> { return event; }
        const views: Array<typeof view> = [view];
        class Reader {
            read(event: Code): string { return position(event); }
        }
        const reader = new Reader();
        function code(event: Code): string { return event.code; }
        const readers: Array<typeof code> = [code];
        type Cancellation = Readonly<Pick<KeyboardEvent, "preventDefault" | "defaultPrevented">>;
        function cancel(event: Cancellation): void {
            const alias = event;
            alias.preventDefault();
            if (!event.defaultPrevented) throw new Error("view alias");
        }
        const callbacks: Array<typeof cancel> = [cancel];
        function chord(event: Readonly<Pick<KeyboardEvent, "key" | "ctrlKey">> & Partial<Code>): string {
            return event.ctrlKey ? event.key : event.code ?? "";
        }
        const chords: Array<typeof chord> = [chord];
        window.addEventListener("keydown", event => {
            const payload: {event: Readonly<Code>} = {event};
            if (!selected(event) || reader.read(event) !== "a" || view(event).code !== "KeyA")
                throw new Error("synchronous projection");
            if (readers[0]!(event) !== "KeyA" || chords[0]!(event) !== "a" ||
                views[0]!(event).code !== "KeyA" || payload.event.code !== "KeyA")
                throw new Error("stored projection");
            callbacks[0]!(event);
            if (!event.defaultPrevented) throw new Error("dispatch owner");
        });
        function coordinate(event: Readonly<Pick<MouseEvent, "clientX" | "altKey">>): number {
            return event.altKey ? event.clientX : 0;
        }
        const coordinates: Array<typeof coordinate> = [coordinate];
        window.addEventListener("mousedown", event => {
            if (coordinates[0]!(event) !== 23) throw new Error("mouse projection");
            event.preventDefault();
        });
    `);
    assert.match(
        result.cpp,
        /Callback<std::string\(bbl::js::Borrowed<const bbl::PlatformKeyboardEvent>\)>/,
    );
    assert.match(
        result.cpp,
        /Callback<double\(bbl::js::Borrowed<const bbl::PlatformMouseEvent>\)>/,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "native-structural-views",
        `#define main generated_main
${result.cpp}
#undef main
#include <cassert>
namespace {
    const auto structural_view_input = std::make_shared<bbl::DomInput>();
    std::shared_ptr<bbl::DomEventState> event_state(const std::string& type) {
        auto state = std::make_shared<bbl::DomEventState>();
        state->type = type;
        state->target = bbl::DomEventTarget::window();
        state->path = {state->target};
        state->cancelable = true;
        return state;
    }
}
namespace bbl {
    Engine create_engine(EngineOptions) {
        Engine engine;
        engine.dom_input = structural_view_input;
        return engine;
    }
}
int main() {
    assert(generated_main() == 0);
    bbl::PlatformKeyboardEvent key;
    key.code = "KeyA";
    key.key = "a";
    key.ctrl_key = true;
    key.dom = event_state("keydown");
    structural_view_input->keyboard.dispatch(key);
    assert(key.default_prevented);
    bbl::PlatformMouseEvent mouse;
    mouse.client_x = 23;
    mouse.alt_key = true;
    mouse.dom = event_state("mousedown");
    structural_view_input->pointer.dispatch(mouse);
    assert(mouse.default_prevented);
}
`,
    );
});

/** The name a key event's listener keeps its key under, read off the event as a KeyboardEvent. */
const keyIdentity = `
    const idOf = (event: Event): string => {
        const { code, key } = event as KeyboardEvent;
        return code || key || "";
    };
`;

test("a listener shared by keyboard and pointer events settles its event's type by its family", (t) => {
    // One function listens to both families. Its pointer lowering never
    // sees a key event, so the keyboard members it reads under a `keydown`
    // or `keyup` test are not lowered there; its keyboard lowering reads
    // them, the key's location included.
    const result = compileSource(`
        ${preamble}
        const TYPES = ["pointerdown", "wheel", "keydown", "keyup"] as const;
        interface Pressed { key: string; code: string; location: number }
        ${keyIdentity}
        const pressed = new Map<string, Pressed>();
        let others = 0;
        const listen = (event: Event): void => {
            if (event.type === "keyup") pressed.delete(idOf(event));
            if (event.type === "keydown" && idOf(event)) {
                const { key, code, location } = event as KeyboardEvent;
                pressed.set(idOf(event), { key: key ?? "", code: code ?? "", location: location ?? 0 });
                const entry = pressed.get("ShiftLeft");
                if (!entry || entry.key !== "Shift" || entry.location !== 1) throw new Error("pressed key");
            }
            if (event.type !== "keydown" && event.type !== "keyup") others++;
            const expected = event.type === "keydown" ? 1 : event.type === "keyup" ? 0 : 1;
            if (pressed.size === expected && others === (event.type === "keydown" ? 0 : 1)) event.preventDefault();
        };
        for (const type of TYPES) window.addEventListener(type, listen, { capture: true });
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "native-shared-family-listener",
        `#define main generated_main
${result.cpp}
#undef main
#include <cassert>
namespace {
    const auto shared_listener_input = std::make_shared<bbl::DomInput>();
    std::shared_ptr<bbl::DomEventState> event_state(const std::string& type) {
        auto state = std::make_shared<bbl::DomEventState>();
        state->type = type;
        state->target = bbl::DomEventTarget::window();
        state->path = {state->target};
        state->cancelable = true;
        return state;
    }
}
namespace bbl {
    Engine create_engine(EngineOptions) {
        Engine engine;
        engine.dom_input = shared_listener_input;
        return engine;
    }
}
int main() {
    assert(generated_main() == 0);
    bbl::PlatformKeyboardEvent down;
    down.code = "ShiftLeft";
    down.key = "Shift";
    down.location = 1;
    down.dom = event_state("keydown");
    shared_listener_input->keyboard.dispatch(down);
    assert(down.default_prevented);
    bbl::PlatformMouseEvent pointer;
    pointer.dom = event_state("pointerdown");
    shared_listener_input->pointer.dispatch(pointer);
    assert(pointer.default_prevented);
    bbl::PlatformKeyboardEvent up;
    up.code = "ShiftLeft";
    up.key = "Shift";
    up.location = 1;
    up.dom = event_state("keyup");
    shared_listener_input->keyboard.dispatch(up);
    assert(up.default_prevented);
}
`,
    );
});

test("a constructed KeyboardEvent reaches the key listeners as the event its maker owns", (t) => {
    // A gate lets go of the keys it saw go down with keyup events it
    // constructs in a helper, keeps in a WeakSet and dispatches where each
    // key was pressed; the listeners tell them from a pressed key's by
    // identity.
    const result = compileSource(`
        ${preamble}
        const TYPES = ["pointerdown", "keydown", "keyup"] as const;
        interface Pressed { target: EventTarget; key: string; code: string; location: number }
        ${keyIdentity}
        const made = new WeakSet<Event>();
        function isMade(event: Event): boolean { return made.has(event); }
        function releaseOf(entry: Pressed): Event {
            const init = { key: entry.key, code: entry.code, location: entry.location, bubbles: true, cancelable: true };
            let event: Event;
            if (typeof KeyboardEvent !== "undefined") {
                event = new KeyboardEvent("keyup", init);
            } else {
                event = new Event("keyup", init);
                Object.defineProperties(event, { key: { value: entry.key }, code: { value: entry.code }, location: { value: entry.location } });
            }
            made.add(event);
            return event;
        }
        let seen = "";
        function createGate(target: EventTarget): { setClosed(next: boolean): void; count(): number } {
            let closed = false;
            const pressed = new Map<string, Pressed>();
            const listen = (event: Event): void => {
                if (event.type === "keyup") pressed.delete(idOf(event));
                if (made.has(event)) return;
                if (!closed) {
                    if (event.type === "keydown" && idOf(event)) {
                        const { key, code, location } = event as KeyboardEvent;
                        pressed.set(idOf(event), { target, key: key ?? "", code: code ?? "", location: location ?? 0 });
                    }
                    return;
                }
                if (event.cancelable) event.preventDefault();
                event.stopImmediatePropagation();
            };
            for (const type of TYPES) target.addEventListener(type, listen, { capture: true });
            return {
                setClosed(next: boolean): void {
                    const closing = next && !closed;
                    closed = next;
                    if (!closing) return;
                    for (const entry of [...pressed.values()]) {
                        entry.target.dispatchEvent(releaseOf(entry));
                    }
                },
                count: () => pressed.size,
            };
        }
        const gate = createGate(window);
        window.addEventListener("keyup", (event) => {
            if (isMade(event)) seen += event.code + event.location;
        });
        // The program presses a key itself: a constructed keydown reaches the
        // gate as a pressed key's would.
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", location: 1, bubbles: true, cancelable: true }));
        if (gate.count() !== 1) throw new Error("pressed key");
        gate.setClosed(true);
        if (seen !== "ShiftLeft1" || gate.count() !== 0) throw new Error("seen " + seen);
        // A key pressed while closed is cancelled and stopped.
        if (window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }))) throw new Error("closed key");
        if (gate.count() !== 0) throw new Error("closed key counted");
    `);
    assert.match(result.cpp, /bbl::synthetic_keyboard_event_from_options\(/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "native-constructed-key-event",
        `#define main generated_main
${result.cpp}
#undef main
#include <cassert>
namespace {
    const auto gate_input = std::make_shared<bbl::DomInput>();
}
namespace bbl {
    Engine create_engine(EngineOptions) {
        Engine engine;
        engine.dom_input = gate_input;
        return engine;
    }
}
int main() { assert(generated_main() == 0); }
`,
    );
});

test("a structural interface over a host list's elements is a view of each native owner", async (t) => {
    // The reader a test can feed plain objects: its interface is the part
    // of a browser Gamepad it uses, and the browser's own list sinks into
    // it element by element.
    const source = `
        import { createEngine } from "@babylonjs/lite";
        interface PadSnapshot {
            readonly index: number;
            readonly mapping: string;
            readonly connected?: boolean;
            readonly axes: ArrayLike<number>;
            readonly buttons: ArrayLike<{ readonly pressed: boolean; readonly value: number }>;
        }
        interface PadSource { getGamepads(): ArrayLike<PadSnapshot | null> | null | undefined }
        interface PadFrame { connected: boolean; first: number; index: number; leftX: number; trigger: number; held: Uint8Array }
        function createPadReader(source: PadSource): { poll(): PadFrame } {
            const frame: PadFrame = { connected: false, first: -1, index: -1, leftX: 0, trigger: 0, held: new Uint8Array(3) };
            const readList = (): ArrayLike<PadSnapshot | null> | null => {
                try {
                    return source.getGamepads() ?? null;
                } catch {
                    return null;
                }
            };
            const isReadable = (pad: PadSnapshot | null | undefined): pad is PadSnapshot =>
                !!pad && pad.connected !== false && pad.mapping === "standard";
            const poll = (): PadFrame => {
                const list = readList();
                let first: PadSnapshot | null = null;
                let pressing: PadSnapshot | null = null;
                for (let slot = 0; list && slot < list.length; slot++) {
                    const pad = list[slot];
                    if (!isReadable(pad)) continue;
                    first ??= pad;
                    if (!pressing && pad.buttons[0]!.pressed) pressing = pad;
                }
                const next = pressing ?? first;
                frame.connected = next !== null;
                frame.first = first ? first.index : -1;
                if (next) {
                    frame.index = next.index;
                    frame.leftX = next.axes[0] ?? 0;
                    frame.trigger = next.buttons[2]!.value;
                    for (let index = 0; index < 3; index++) {
                        const button = index < next.buttons.length ? next.buttons[index] : undefined;
                        frame.held[index] = button && button.pressed ? 1 : 0;
                    }
                }
                return frame;
            };
            return { poll };
        }
        async function main() {
            const engine = await createEngine({});
            const reader = createPadReader({ getGamepads: () => navigator.getGamepads() });
            const frame = reader.poll();
            if (!frame.connected || frame.first !== 1 || frame.index !== 2) throw new Error("the pressing pad");
            if (frame.leftX !== 0.25 || frame.trigger !== 0.5) throw new Error("axes and trigger travel");
            if (frame.held[0] !== 1 || frame.held[1] !== 0 || frame.held[2] !== 1) throw new Error("held buttons");
        }
    `;
    const pad = (index: number, connected: boolean, pressing: boolean) => ({
        index,
        mapping: "standard",
        connected,
        axes: [0.25, 0, 0, 0],
        buttons: [
            { pressed: pressing, value: pressing ? 1 : 0 },
            { pressed: false, value: 0 },
            { pressed: pressing, value: pressing ? 0.5 : 0 },
        ],
    });
    await runTranspiled(
        `${source}
main();`,
        {
            exports: {},
            require: () => ({ createEngine: () => ({}) }),
            navigator: {
                getGamepads: () => [
                    null,
                    pad(0, false, true),
                    pad(1, true, false),
                    pad(2, true, true),
                ],
            },
            Uint8Array,
        },
        ts.ModuleKind.CommonJS,
    );

    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(
        tools,
        "native-structural-pads",
        `
        #define main generated_main
${result.cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine&) {
                return {std::nullopt, GamepadHandle{7u, 0u}, GamepadHandle{8u, 1u}, GamepadHandle{9u, 2u}};
            }
            bool gamepad_connected(Engine&, GamepadHandle pad) { return pad.instance_id != 7u; }
            std::string gamepad_mapping(Engine&, GamepadHandle) { return "standard"; }
            double gamepad_index(Engine&, GamepadHandle pad) { return pad.index; }
            js::Array<double> gamepad_axes(Engine&, GamepadHandle) { return {0.25, 0.0, 0.0, 0.0}; }
            js::Array<GamepadButtonHandle> gamepad_buttons(Engine&, GamepadHandle pad) {
                return {GamepadButtonHandle{pad, 0u}, GamepadButtonHandle{pad, 1u}, GamepadButtonHandle{pad, 2u}};
            }
            bool gamepad_button_pressed(Engine&, GamepadButtonHandle button) {
                return button.gamepad.instance_id != 8u && button.index != 1u;
            }
            double gamepad_button_value(Engine& engine, GamepadButtonHandle button) {
                return !gamepad_button_pressed(engine, button) ? 0.0 : button.index == 2u ? 0.5 : 1.0;
            }
        }
        int main() { assert(generated_main() == 0); }
        `,
        { timeoutMs: 10000 },
    );
});

test("borrowed structural views cannot escape dispatch through stored callbacks or containers", () => {
    for (const body of [
        `function save(event: Readonly<Pick<KeyboardEvent, "code">>): void {
            setTimeout(() => console.log(event.code), 0);
        }
        const callbacks: Array<typeof save> = [save];
        window.addEventListener("keydown", event => callbacks[0]!(event));`,
        `const saved: Pick<KeyboardEvent, "code">[] = [];
        window.addEventListener("keydown", event => saved.push(event));`,
        `class Keeper {
            saved: Pick<KeyboardEvent, "code"> | null = null;
            save(event: Pick<KeyboardEvent, "code">): void { this.saved = event; }
        }
        const keeper = new Keeper();
        window.addEventListener("keydown", event => keeper.save(event));`,
    ])
        assert.throws(
            () => compileSource(preamble + body),
            /escaping callback cannot capture platform event|borrowed platform event cannot escape/,
        );
});

test("structural event storage refuses invented owners and unsupported members", () => {
    assert.throws(
        () =>
            compileSource(`
                ${preamble}
                function code(event: Pick<KeyboardEvent, "code">): string { return event.code; }
                const readers: Array<typeof code> = [code];
                window.addEventListener("keydown", event => {
                    readers[0]!(event);
                    readers[0]!({code: "KeyA"});
                });
            `),
        /borrowed DOM keyboard event must come from the active synchronous platform callback/,
    );
    assert.throws(
        () =>
            compileSource(`
                ${preamble}
                function legacy(event: Pick<KeyboardEvent, "keyCode">): number { return event.keyCode; }
                const readers: Array<typeof legacy> = [legacy];
                window.addEventListener("keydown", event => readers[0]!(event));
            `),
        /Platform keyboard events do not expose 'keyCode'/,
    );
    assert.throws(
        () =>
            compileSource(`
                ${preamble}
                type Mutable<T> = {-readonly [P in keyof T]: T[P]};
                function change(event: Mutable<Pick<KeyboardEvent, "code">>): void { event.code = "KeyB"; }
                const callbacks: Array<typeof change> = [change];
                window.addEventListener("keydown", event => callbacks[0]!(event));
            `),
        /Unsupported property assignment 'event.code'/,
    );
});

test("a structural DOM annotation also accepts ordinary records without a dispatch owner", (t) => {
    const result = compileSource(`
        function code(event: Readonly<Pick<KeyboardEvent, "code">>): string { return event.code; }
        const readers: Array<typeof code> = [code];
        if (readers[0]!({code: "KeyA"}) !== "KeyA") throw new Error("plain record");
    `);
    assert.doesNotMatch(
        result.cpp,
        /Borrowed<const bbl::PlatformKeyboardEvent>/,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "native-structural-plain-view", result.cpp);
});
