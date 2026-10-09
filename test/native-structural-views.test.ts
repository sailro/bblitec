import assert from "node:assert/strict";
import test from "node:test";
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
                function location(event: Pick<KeyboardEvent, "location">): number { return event.location; }
                const readers: Array<typeof location> = [location];
                window.addEventListener("keydown", event => readers[0]!(event));
            `),
        /Platform keyboard events do not expose 'location'/,
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
