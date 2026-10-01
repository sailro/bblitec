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
    for (const event of ["input", "change"])
        assert.match(
            result.cpp,
            new RegExp(
                `on_dom_pointer\\([^;]+DomEventTarget::node\\(v_input\\.value\\), "${event}", \\d+u, bbl::js::make_closure\\(`,
            ),
        );
    assert.doesNotMatch(result.cpp, /ui_set_file_input/);
});

test("native color picker previews edits, commits, cancels and normalizes opaque sRGB", (t) => {
    runRmlUiFixture(t, "ui-color-input");
});
