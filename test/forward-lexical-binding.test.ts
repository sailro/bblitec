import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("a later const a callback names keeps its effects where the source runs them", () => {
    const { cpp } = compileSource(`
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        interface Panel {
            show(): void;
        }
        function makePanel(label: string): Panel {
            const panel = document.createElement("div");
            panel.textContent = label;
            document.body.appendChild(panel);
            return { show(): void { panel.style.display = "block"; } };
        }
        window.addEventListener("keydown", () => {
            if (limit > 0) hud.show();
        });
        const first = makePanel("first panel");
        const hud = makePanel("hud panel");
        const limit = 3;
        first.show();
    `);
    // The callback reads the binding through temporal-dead-zone storage
    // declared before it; the call still runs after the panel before it.
    assert.match(cpp, /LexicalBinding<[^>]+>>\(\)/);
    const listener = cpp.indexOf("on_dom_keyboard");
    const first = cpp.indexOf('"first panel"');
    const hud = cpp.indexOf('"hud panel"');
    const initialized = cpp.indexOf("->initialize(");
    assert.ok(listener >= 0 && first >= 0 && hud >= 0 && initialized >= 0);
    assert.ok(listener < first && first < hud && hud < initialized);
    // A pure initializer is still materialized ahead of the callback.
    assert.doesNotMatch(cpp, /LexicalBinding<double>/);
});

test("a listener reaching later bindings through a stored callback reads them in the declaring scope", () => {
    const { cpp } = compileSource(`
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        interface CoinOptions {
            onClose: () => void;
        }
        function createCoin(options: CoinOptions): HTMLButtonElement {
            const button = document.createElement("button");
            button.addEventListener("click", () => {
                options.onClose();
            });
            document.body.appendChild(button);
            return button;
        }
        function createOverlay(): () => void {
            const coin = createCoin({ onClose: () => close() });
            let opened = true;
            const closeButton = coin;
            const close = (): void => {
                if (!opened) return;
                opened = false;
                closeButton.textContent = "closed";
            };
            return () => close();
        }
        createOverlay()();
    `);
    const listener = cpp.indexOf("on_dom_pointer");
    // The later let is materialized in the overlay's scope before the
    // listener, and the later const is temporal-dead-zone storage the
    // declaration fills after it.
    const opened = cpp.search(
        /auto v_\w*opened = bbl::js::make_gc_shared<bool>\(true\)/,
    );
    const storage = cpp.search(
        /auto v_\w*closeButton = bbl::js::make_gc_shared<bbl::js::LexicalBinding</,
    );
    const initialized = cpp.search(/v_\w*closeButton->initialize\(/);
    assert.ok(opened >= 0 && storage >= 0 && listener >= 0 && initialized >= 0);
    assert.ok(
        opened < listener && storage < listener && listener < initialized,
    );
    // The close the listener reaches keeps its write through that storage.
    assert.match(
        cpp,
        /ui_set_text\(v_engine, v_\w*closeButton->get\(\), "closed"\)/,
    );
});

test("timer callbacks read later bindings through the functions and callbacks they reach", (t) => {
    const directory = resolve("artifacts/forward-lexical-binding-realm");
    mkdirSync(directory, { recursive: true });
    // The worker places the program in the application realm, whose timers
    // run without an engine.
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
        worker.terminate();
        const order: string[] = [];
        function makeLabel(prefix: string): string { order.push("label"); return prefix; }
        interface Ring { fire(): void; }
        function createRing(options: { onCommit: (source: string) => void }): Ring {
            order.push("ring");
            setTimeout(() => options.onCommit("timer"), 1);
            return { fire: () => options.onCommit("direct") };
        }
        void (async () => {
            const ring = createRing({ onCommit: (source) => markEdited(source) });
            let edits = 0;
            const log: string[] = [];
            const label = makeLabel("edit");
            const markEdited = (source: string): void => { edits += 1; log.push(label + ":" + source); };
            ring.fire();
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
            if (edits !== 2) throw new Error("later let");
            if (log.join() !== "edit:direct,edit:timer") throw new Error("later const");
            if (order.join() !== "ring,label") throw new Error("effect order");
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.match(result.cpp, /LexicalBinding<std::string>/);
    runRealmProgram(result.cpp, directory, t);
});

test("an imported constant stays in its module when a timer reads it", (t) => {
    const directory = resolve("artifacts/forward-lexical-binding-import");
    mkdirSync(directory, { recursive: true });
    // Offsets in another source file do not order the callback's scope.
    writeFileSync(
        join(directory, "constants.ts"),
        "\n".repeat(512) +
            `
        export enum Choice { First = 3, Second = 7, Third = 11 }
        export const choices: number[] = [Choice.First, Choice.Second, Choice.Third];
    `,
    );
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        import { choices } from "./constants.js";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
        worker.terminate();
        const index = new Float32Array([1]);
        setTimeout(() => {
            if (choices.length !== 3 || choices[index[0]!] !== 7)
                throw new Error("imported table");
            globalThis.close();
        }, 0);
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.doesNotMatch(result.cpp, /bbl::js::Array<double> v_\w*choices/);
    runRealmProgram(result.cpp, directory, t);
});

function runRealmProgram(
    cpp: string,
    directory: string,
    t: test.TestContext,
): void {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const source = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/I",
        "native/include",
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        source,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
}
