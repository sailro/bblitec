import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("checkbox properties and change listeners use retained input state", () => {
    const source = `import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        const label = document.createElement("span");
        input.addEventListener("change", () => {
            label.textContent = input.checked ? "on" : "off";
        });
        document.body.append(input, label);`;
    const result = compileSource(source);
    assert.match(result.cpp, /ui_set_checked\([^;]+true\)/);
    assert.match(result.cpp, /ui_get_checked\(/);
    assert.match(result.cpp, /ui_on_event\([^;]+"change"/);
    assert.doesNotMatch(result.cpp, /ui_on_file_change|ui_set_file_input/);
    assert.throws(
        () =>
            compileSource(
                source.replace(
                    'createElement("input")',
                    'createElement("div")',
                ),
            ),
        /checked requires an input/,
    );
});

test("native checkbox edits retain current checked state before input and change", (t) => {
    runRmlUiFixture(t, "ui-checkbox");
});
