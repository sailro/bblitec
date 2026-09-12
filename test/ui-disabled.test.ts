import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("form-control disabled properties retain attribute presence", () => {
    const source = `import {createEngine} from "@babylonjs/lite";
        const engine = await createEngine({});
        const button = document.createElement("button");
        button.disabled = true;
        if (!button.disabled) throw new Error("disabled");
        button.disabled = false;
        if (button.disabled) throw new Error("enabled");`;
    const result = compileSource(source);
    assert.match(result.cpp, /ui_set_boolean_attribute\([^;]+"disabled", true\)/);
    assert.match(result.cpp, /ui_set_boolean_attribute\([^;]+"disabled", false\)/);
    assert.equal((result.cpp.match(/ui_has_attribute\(/g) ?? []).length, 2);
    assert.throws(() => compileSource(source.replace('createElement("button")', 'createElement("div")')), /supported form control/);
});

test("disabled controls suppress activation and recover after re-enabling", t => {
    runRmlUiFixture(t, "ui-disabled");
});
