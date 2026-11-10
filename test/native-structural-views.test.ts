import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

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

test("a listener shared by keyboard and pointer events settles its event's type by its family", (t) => {
    // One function listens to both families. Its pointer lowering never
    // sees a key event, so the keyboard members it reads under a `keydown`
    // or `keyup` test are not lowered there; its keyboard lowering reads
    // them, the key's location included.
    const result = compileSource(`
        ${preamble}
        const BLOCKED = ["pointerdown", "wheel", "keydown", "keyup"] as const;
        interface HeldKey { key: string; code: string; location: number }
        const heldKeyId = (event: Event): string => {
            const { code, key } = event as KeyboardEvent;
            return code || key || "";
        };
        const heldKeys = new Map<string, HeldKey>();
        let pointers = 0;
        const intercept = (event: Event): void => {
            if (event.type === "keyup") heldKeys.delete(heldKeyId(event));
            if (event.type === "keydown" && heldKeyId(event)) {
                const { key, code, location } = event as KeyboardEvent;
                heldKeys.set(heldKeyId(event), { key: key ?? "", code: code ?? "", location: location ?? 0 });
                const held = heldKeys.get("ShiftLeft");
                if (!held || held.key !== "Shift" || held.location !== 1) throw new Error("held key");
            }
            if (event.type !== "keydown" && event.type !== "keyup") pointers++;
            const expected = event.type === "keydown" ? 1 : event.type === "keyup" ? 0 : 1;
            if (heldKeys.size === expected && pointers === (event.type === "keydown" ? 0 : 1)) event.preventDefault();
        };
        for (const type of BLOCKED) window.addEventListener(type, intercept, { capture: true });
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
    await runInNewContext(
        ts.transpileModule(
            `${source}
main();`,
            {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.CommonJS,
                },
            },
        ).outputText,
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
    );

    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    const output = resolve("artifacts/native-structural-pads");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), result.cpp);
    runGeneratedProgram(
        tools,
        "native-structural-pads",
        `
        #define main generated_main
        #include "program.hpp"
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
