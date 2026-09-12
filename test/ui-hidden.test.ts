import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("DOM hidden reads and writes retain boolean attribute presence", () => {
    const prefix = `import {createEngine} from "@babylonjs/lite";
        const engine = await createEngine({});
        const element = document.createElement("span");`;
    const result = compileSource(`${prefix}
        function hide(value: boolean): void { element.hidden = value; }
        hide(true);
        if (!element.hidden) throw new Error("hidden attribute missing");
        hide(false);
        if (element.hidden) throw new Error("hidden attribute retained");
    `);
    assert.match(result.cpp, /ui_set_boolean_attribute\([^;]+"hidden", true\)/);
    assert.match(result.cpp, /ui_set_boolean_attribute\([^;]+"hidden", false\)/);
    assert.equal((result.cpp.match(/ui_has_attribute\(/g) ?? []).length, 2);
    assert.throws(() => compileSource(`${prefix} element.setAttribute("hidden", "UNTIL-FOUND");`), /requires find-in-page/);
    assert.throws(() => compileSource(`${prefix} element.hidden = "until-found";`), /boolean/);
});

test("hidden toggles native layout without replacing author display rules", t => {
    runRmlUiFixture(t, "ui-hidden");
});
