import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("color input values and edit events use the retained form control", () => {
    const result = compileSource(`import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        const input = document.createElement("input");
        input.type = "color";
        input.value = "#27AE60";
        const output = document.createElement("output");
        input.addEventListener("input", () => { output.value = input.value; });
        input.addEventListener("change", () => { output.value = input.value; });
        document.body.append(input, output);`);
    assert.match(result.cpp, /ui_set_attribute\([^;]+"type", "color"\)/);
    assert.match(result.cpp, /ui_get_form_value\(/);
    assert.match(result.cpp, /ui_on_event\([^;]+"input"/);
    assert.match(result.cpp, /ui_on_event\([^;]+"change"/);
    assert.doesNotMatch(result.cpp, /ui_on_file_change|ui_set_file_input/);
});

test("native color picker previews edits, commits, cancels and normalizes opaque sRGB", (t) => {
    runRmlUiFixture(t, "ui-color-input");
});
