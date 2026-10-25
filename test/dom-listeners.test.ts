import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

// One pad announced at 50 ms and removed at 100 ms (the native fixture's
// display); the queued microtask takes the application realm.
const source = `
    import { createEngine } from "@babylonjs/lite";
    queueMicrotask(() => {});
    const events: string[] = [];
    const connected = (event: GamepadEvent): void => {
        const reported = navigator.getGamepads()[event.gamepad.index];
        if (!reported || reported.index !== event.gamepad.index)
            throw new Error("connected pad is not the reported pad");
        events.push("+" + String(event.gamepad.index));
    };
    const disconnected = (event: GamepadEvent): void => {
        events.push("-" + String(event.gamepad.index));
    };
    async function main(): Promise<void> {
        const engine = await createEngine(new OffscreenCanvas(1, 1));
        void engine;
        window.addEventListener("gamepadconnected", connected);
        window.addEventListener("gamepaddisconnected", disconnected);
        setTimeout(() => {
            window.removeEventListener("gamepadconnected", connected);
            window.removeEventListener("gamepaddisconnected", disconnected);
            if (events.join(",") !== "+0,-0") throw new Error(events.join(","));
            globalThis.close();
        }, 250);
    }
    void main();
`;

/** The browser's gamepad task source announcing the same pad. */
async function runInBrowserModel(): Promise<void> {
    const pad = { index: 0 };
    let connected = false;
    const getGamepads = (): ({ index: number } | null)[] =>
        connected ? [pad] : [];
    const listeners = new Map<string, Set<(event: object) => void>>();
    let closed = false;
    const failures: string[] = [];
    const window = {
        addEventListener: (type: string, listener: (event: object) => void) =>
            listeners.set(
                type,
                (listeners.get(type) ?? new Set()).add(listener),
            ),
        removeEventListener: (
            type: string,
            listener: (event: object) => void,
        ) => listeners.get(type)?.delete(listener),
    };
    const announce = (now: boolean) => {
        connected = now;
        const type = now ? "gamepadconnected" : "gamepaddisconnected";
        for (const listener of listeners.get(type) ?? [])
            try {
                listener({ gamepad: pad });
            } catch (error) {
                failures.push(String(error));
            }
    };
    const timers = [
        setTimeout(() => announce(true), 50),
        setTimeout(() => announce(false), 100),
    ];
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText,
        {
            exports: {},
            require: () => ({ createEngine: () => Promise.resolve({}) }),
            window,
            navigator: { getGamepads },
            OffscreenCanvas: class {},
            queueMicrotask,
            setTimeout: (callback: () => void, delay: number) =>
                setTimeout(() => {
                    try {
                        callback();
                    } catch (error) {
                        failures.push(String(error));
                    }
                }, delay),
            close: () => (closed = true),
        },
    );
    for (let turn = 0; turn < 100 && !closed && failures.length === 0; turn++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    for (const timer of timers) clearTimeout(timer);
    assert.deepEqual(failures, []);
    assert.equal(closed, true);
}

test("gamepad connections fire at the Window with the slots getGamepads reports", async (t) => {
    await runInBrowserModel();
    const result = compileSource(source, { fileName: "gamepad-events.ts" });
    assert.match(
        result.cpp,
        /bbl::on_dom_gamepad\(bbl::pal::window_document_engine\(\), bbl::DomEventTarget::window\(\), "gamepadconnected"/,
    );
    assert.match(result.cpp, /bbl::off_dom_gamepad\(/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "dom-listeners/gamepad-events",
        readFileSync("test/fixtures/dom-gamepads/gamepad-realm.cpp", "utf8") +
            result.cpp,
        {
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_HAS_GAMEPAD=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});

test("a gamepad listener stays on the immediate path", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine(document.querySelector("canvas")!);
            void engine;
            window.addEventListener("gamepadconnected", () => {});
        }
        void main();
    `);
    assert.doesNotMatch(result.cpp, /bbl::pal::run_window_application/);
    assert.match(
        result.cpp,
        /bbl::on_dom_gamepad\([^\n]*bbl::DomEventTarget::window\(\), "gamepadconnected"/,
    );
    assert.ok(result.manifest.features.includes("input:gamepad"));
});
