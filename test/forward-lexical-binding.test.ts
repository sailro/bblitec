import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

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
